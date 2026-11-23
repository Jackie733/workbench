import packageInfo from "../../package.json";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ServerWebSocket } from "bun";
import { stageUpload } from "../core/attachments.ts";
import { getProjectStatus, initProject } from "../core/engine.ts";
import { WorkbenchError } from "../core/errors.ts";
import { canonicalRoot } from "../core/fs.ts";
import type { GiteeApiDeps } from "../core/gitee.ts";
import type { GitHubCommandDeps } from "../core/github.ts";
import { DEFAULT_OUTPUT_LANGUAGE } from "../core/language.ts";
import { isGitRevision, readSourceRevision } from "../core/revision.ts";
import { WORKBENCH_DIR, type AgentAction, type AgentRunRecord, type OutputLanguage, type PrivacyMode } from "../core/types.ts";
import { isRecord } from "../core/validate.ts";
import {
  buildLocalProjectSnapshot,
  createProjectApiHandler,
  httpStatusForError,
  jsonResponse,
  type LocalProjectSnapshot,
} from "../server/project_api.ts";
import type { PainPointReportInput } from "./evolution.ts";
import { HubExecutor, type CustomCommandBuilder, type TelemetryOutcomeInput } from "./executor.ts";
import type { RunLedgerEntry } from "./ledger.ts";
import { enrichAgentRunRecord } from "./pricing.ts";
import { browseDirectory, readHubConfig } from "./registry.ts";
import { buildPresetRouting } from "./routing.ts";
import type { NodeUpdateReport } from "../cli/node_update.ts";
import type { HarnessInfo, HubObservabilityConfig, RemoteNodeInfo, RoutingConfig } from "./types.ts";

export interface NodeRpcRequest {
  type: "node.rpc.request";
  reqId: string;
  kind: "browse" | "register_probe" | "projects_snapshot" | "refresh_harnesses" | "upload_stage" | "project_http" | "update_start" | "update_status";
  updateId?: string;
  revision?: string;
  path?: string;
  root?: string;
  name?: string;
  initPrivacy?: PrivacyMode;
  roots?: string[];
  files?: Array<{ name: string; bytesBase64: string }>;
  method?: string;
  pathname?: string;
  search?: string;
  bodyText?: string;
  projectRoot?: string;
  routing?: RoutingConfig;
  outputLanguage?: OutputLanguage;
  giteeAccessToken?: string | null;
  observability?: HubObservabilityConfig;
}

export interface NodeRpcResponse {
  type: "node.rpc.response";
  reqId: string;
  status: number;
  headers?: Record<string, string>;
  bodyJson?: unknown;
  bodyBase64?: string;
}

interface PendingRpc {
  resolve: (res: NodeRpcResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ConnectedNode {
  ws: ServerWebSocket<any>;
  info: RemoteNodeInfo;
  pendingRpcs: Map<string, PendingRpc>;
}

export interface RemoteNodeCallbacks {
  onPainPoint: (nodeId: string, input: PainPointReportInput) => void;
  onTelemetry: (nodeId: string, outcome: TelemetryOutcomeInput) => void;
  onLedgerEntry?: (nodeId: string, nodeName: string, entry: RunLedgerEntry) => void;
  onEvent: (nodeId: string, event: Record<string, unknown>) => void;
  onStatusChanged: () => void;
}

/**
 * Hub-side registry of outbound-connected remote Workbench nodes (e.g. Windows WSL2).
 * Routes project API calls, filesystem browsing, and attachment staging over the active WebSocket.
 */
export class RemoteNodeRegistry {
  private readonly nodes = new Map<string, ConnectedNode>();
  private readonly pingTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.pingTimer = setInterval(() => {
      const now = Date.now();
      for (const entry of this.nodes.values()) {
        try {
          entry.ws.send(JSON.stringify({ type: "node.ping", ts: now }));
        } catch {
          // Close handler will clean up unreachable sockets.
        }
      }
    }, 15_000);
    this.pingTimer.unref?.();
  }

  registerSocket(
    ws: ServerWebSocket<any>,
    meta: {
      nodeId: string;
      name: string;
      hostname: string;
      platform: string;
      workbenchVersion?: string;
      routing: RoutingConfig;
      outputLanguage: OutputLanguage;
      giteeAccessToken?: string | null;
      observability?: HubObservabilityConfig;
    },
  ): void {
    const prev = this.nodes.get(meta.nodeId);
    if (prev && prev.ws !== ws) {
      this.rejectPending(prev, `远程节点 ${meta.name} 已建立新连接`);
      try {
        prev.ws.close(1000, "replaced_by_newer_node");
      } catch {
        // Ignore close errors.
      }
    }
    const now = Date.now();
    this.nodes.set(meta.nodeId, {
      ws,
      info: {
        nodeId: meta.nodeId,
        name: meta.name || meta.nodeId,
        isLocal: false,
        hostname: meta.hostname || meta.nodeId,
        platform: meta.platform || "linux",
        connected: true,
        connectedAt: now,
        lastSeenAt: now,
        harnesses: prev?.info.harnesses ?? [],
        activeRuns: [],
        workbenchVersion: meta.workbenchVersion,
      },
      pendingRpcs: new Map(),
    });
    try {
      ws.send(
        JSON.stringify({
          type: "node.welcome",
          nodeId: meta.nodeId,
          routing: meta.routing,
          outputLanguage: meta.outputLanguage,
          giteeAccessToken: meta.giteeAccessToken ?? null,
          ...(meta.observability ? { observability: meta.observability } : {}),
        }),
      );
    } catch {
      // Ignore send failure on closing socket.
    }
  }

  handleMessage(ws: ServerWebSocket<any>, nodeId: string, message: string | Buffer, cb: RemoteNodeCallbacks): void {
    const entry = this.nodes.get(nodeId);
    if (!entry || entry.ws !== ws) return;

    let parsed: Record<string, unknown>;
    try {
      const text = typeof message === "string" ? message : Buffer.from(message).toString("utf8");
      const raw = JSON.parse(text) as unknown;
      if (!isRecord(raw)) return;
      parsed = raw;
    } catch {
      return;
    }

    entry.info.lastSeenAt = Date.now();

    if (parsed.type === "node.pong") {
      return;
    }

    if (parsed.type === "node.hello") {
      if (typeof parsed.name === "string" && parsed.name.trim()) entry.info.name = parsed.name.trim();
      if (typeof parsed.hostname === "string" && parsed.hostname.trim()) entry.info.hostname = parsed.hostname.trim();
      if (typeof parsed.platform === "string" && parsed.platform.trim()) entry.info.platform = parsed.platform.trim();
      if (typeof parsed.workbenchVersion === "string") entry.info.workbenchVersion = parsed.workbenchVersion;
      if (isGitRevision(parsed.revision)) entry.info.revision = parsed.revision.toLowerCase();
      else delete entry.info.revision;
      entry.info.updateEnabled = parsed.updateEnabled === true;
      if (Array.isArray(parsed.harnesses)) entry.info.harnesses = parsed.harnesses as HarnessInfo[];
      if (Array.isArray(parsed.activeRuns)) {
        const obs = readHubConfig().observability;
        entry.info.activeRuns = (parsed.activeRuns as RemoteNodeInfo["activeRuns"]).map((r) =>
          enrichAgentRunRecord(r, undefined, { harnesses: entry.info.harnesses, observability: obs }),
        );
      }
      cb.onStatusChanged();
      return;
    }

    if (parsed.type === "node.harnesses" && Array.isArray(parsed.harnesses)) {
      entry.info.harnesses = parsed.harnesses as HarnessInfo[];
      cb.onStatusChanged();
      return;
    }

    if (parsed.type === "node.rpc.response" && typeof parsed.reqId === "string") {
      const pending = entry.pendingRpcs.get(parsed.reqId);
      if (!pending) return;
      clearTimeout(pending.timer);
      entry.pendingRpcs.delete(parsed.reqId);
      pending.resolve({
        type: "node.rpc.response",
        reqId: parsed.reqId,
        status: typeof parsed.status === "number" ? parsed.status : 500,
        headers: isRecord(parsed.headers) ? (parsed.headers as Record<string, string>) : undefined,
        bodyJson: parsed.bodyJson,
        bodyBase64: typeof parsed.bodyBase64 === "string" ? parsed.bodyBase64 : undefined,
      });
      return;
    }

    if (parsed.type === "node.event" && isRecord(parsed.event)) {
      const evt = parsed.event;
      this.syncActiveRunsFromEvent(entry, evt);
      cb.onEvent(nodeId, evt);
      return;
    }

    if (parsed.type === "node.pain_point" && isRecord(parsed.input)) {
      cb.onPainPoint(nodeId, parsed.input as unknown as PainPointReportInput);
      return;
    }

    if (parsed.type === "node.telemetry" && isRecord(parsed.outcome)) {
      cb.onTelemetry(nodeId, parsed.outcome as unknown as TelemetryOutcomeInput);
    }

    if (parsed.type === "node.run_ledger" && isRecord(parsed.entry)) {
      cb.onLedgerEntry?.(nodeId, entry.info.name, parsed.entry as unknown as RunLedgerEntry);
    }
  }

  handleClose(ws: ServerWebSocket<any>, nodeId: string, cb: Pick<RemoteNodeCallbacks, "onStatusChanged">): void {
    const entry = this.nodes.get(nodeId);
    if (!entry || entry.ws !== ws) return;
    this.rejectPending(entry, `远程节点 ${entry.info.name} 已断开连接`);
    this.nodes.delete(nodeId);
    cb.onStatusChanged();
  }

  broadcastConfigSync(
    routing: RoutingConfig,
    outputLanguage: OutputLanguage,
    giteeAccessToken?: string | null,
    observability?: HubObservabilityConfig,
  ): void {
    const payload = JSON.stringify({
      type: "node.config.sync",
      routing,
      outputLanguage,
      ...(giteeAccessToken !== undefined ? { giteeAccessToken } : {}),
      ...(observability !== undefined ? { observability } : {}),
    });
    for (const entry of this.nodes.values()) {
      try {
        entry.ws.send(payload);
      } catch {
        // Ignore send errors on closing sockets.
      }
    }
  }

  listConnectedNodes(): RemoteNodeInfo[] {
    return Array.from(this.nodes.values()).map((e) => ({
      ...e.info,
      harnesses: [...e.info.harnesses],
      activeRuns: [...e.info.activeRuns],
    }));
  }

  getNode(nodeId: string): RemoteNodeInfo | null {
    const entry = this.nodes.get(nodeId);
    if (!entry) return null;
    return {
      ...entry.info,
      harnesses: [...entry.info.harnesses],
      activeRuns: [...entry.info.activeRuns],
    };
  }

  isConnected(nodeId: string): boolean {
    return this.nodes.has(nodeId);
  }

  async rpc(
    nodeId: string,
    payload: Omit<NodeRpcRequest, "type" | "reqId">,
    timeoutMs = 35_000,
  ): Promise<NodeRpcResponse> {
    const entry = this.nodes.get(nodeId);
    if (!entry) {
      throw new WorkbenchError(
        "execution_failed",
        `远程节点 ${nodeId} 当前不在线，请确认该机器已运行 wb node start 或 wb node install`,
      );
    }
    const reqId = randomUUID();
    const request: NodeRpcRequest = { type: "node.rpc.request", reqId, ...payload };

    return new Promise<NodeRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.pendingRpcs.delete(reqId);
        reject(new WorkbenchError("execution_failed", `远程节点 ${entry.info.name} 响应超时 (${Math.round(timeoutMs / 1000)}s)`));
      }, timeoutMs);
      entry.pendingRpcs.set(reqId, { resolve, reject, timer });
      try {
        entry.ws.send(JSON.stringify(request));
      } catch (err) {
        clearTimeout(timer);
        entry.pendingRpcs.delete(reqId);
        reject(
          new WorkbenchError(
            "execution_failed",
            `向远程节点 ${entry.info.name} 发送请求失败: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    });
  }

  async forwardProjectHttp(
    nodeId: string,
    projectRoot: string,
    req: Request,
    url: URL,
    routing: RoutingConfig,
    outputLanguage: OutputLanguage,
    giteeAccessToken?: string | null,
    observability?: HubObservabilityConfig,
  ): Promise<Response> {
    const method = req.method.toUpperCase();
    const pathname = url.pathname;
    const bodyText = method !== "GET" && method !== "HEAD" ? await req.text() : undefined;
    const timeoutMs =
      pathname.endsWith("/verify") || pathname.endsWith("/screenshots/capture")
        ? 320_000
        : pathname.endsWith("/deliver") || pathname.includes("/github/") || pathname.includes("/gitee/")
          ? 90_000
          : 35_000;

    const rpcRes = await this.rpc(
      nodeId,
      {
        kind: "project_http",
        method,
        pathname,
        search: url.search,
        ...(bodyText ? { bodyText } : {}),
        projectRoot,
        routing,
        outputLanguage,
        ...(giteeAccessToken !== undefined ? { giteeAccessToken } : {}),
        ...(observability !== undefined ? { observability } : {}),
      },
      timeoutMs,
    );

    const headers = new Headers(rpcRes.headers ?? {});
    if (rpcRes.bodyBase64 !== undefined) {
      const bytes = Buffer.from(rpcRes.bodyBase64, "base64");
      return new Response(new Uint8Array(bytes), { status: rpcRes.status, headers });
    }
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json; charset=utf-8");
    }
    if (!headers.has("Cache-Control")) {
      headers.set("Cache-Control", "no-store");
    }
    return new Response(JSON.stringify(rpcRes.bodyJson ?? {}), { status: rpcRes.status, headers });
  }

  stopAll(): void {
    clearInterval(this.pingTimer);
    for (const entry of this.nodes.values()) {
      this.rejectPending(entry, "Hub 服务已停止");
      try {
        entry.ws.close(1001, "hub_stopped");
      } catch {
        // Ignore close errors.
      }
    }
    this.nodes.clear();
  }

  private rejectPending(entry: ConnectedNode, reason: string): void {
    for (const [reqId, pending] of entry.pendingRpcs.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new WorkbenchError("execution_failed", reason));
      entry.pendingRpcs.delete(reqId);
    }
  }

  private syncActiveRunsFromEvent(entry: ConnectedNode, evt: Record<string, unknown>): void {
    const type = evt.type;
    const runId = typeof evt.runId === "string" ? evt.runId : "";
    if (!runId) return;
    if (type === "agent.run.started") {
      const obs = readHubConfig().observability;
      const metricsPatch = isRecord(evt.metrics) ? (evt.metrics as Partial<AgentRunRecord>) : {};
      const rec = enrichAgentRunRecord(
        {
          id: runId,
          requirementId: typeof evt.requirementId === "string" ? evt.requirementId : "",
          ...(typeof evt.root === "string" ? { root: evt.root } : {}),
          action: (evt.action as AgentAction) ?? "design",
          harness: String(evt.harness ?? ""),
          model: String(evt.model ?? ""),
          ...(typeof evt.reasoningEffort === "string" ? { reasoningEffort: evt.reasoningEffort } : {}),
          ...(typeof evt.quotaPool === "string" ? { quotaPool: evt.quotaPool } : {}),
          ...(typeof evt.billingMode === "string" ? { billingMode: evt.billingMode as AgentRunRecord["billingMode"] } : {}),
          ...(typeof evt.dispatchReason === "string"
            ? { dispatchReason: evt.dispatchReason as AgentRunRecord["dispatchReason"] }
            : {}),
          ...(typeof evt.handoffMode === "string"
            ? { handoffMode: evt.handoffMode as AgentRunRecord["handoffMode"] }
            : {}),
          ...(typeof evt.parentRunId === "string" ? { parentRunId: evt.parentRunId } : {}),
          ...(typeof evt.contextWindow === "number" ? { contextWindow: evt.contextWindow } : {}),
          ...(typeof evt.tracePath === "string" ? { tracePath: evt.tracePath } : {}),
          ...(typeof evt.contextPath === "string" ? { contextPath: evt.contextPath } : {}),
          ...metricsPatch,
          status: "running",
          startedAt: typeof evt.at === "number" ? evt.at : Date.now(),
          endedAt: null,
          exitCode: null,
          durationMs: typeof metricsPatch.durationMs === "number" ? metricsPatch.durationMs : 0,
          logPath: `runs/run-${runId}.log`,
        },
        undefined,
        { harnesses: entry.info.harnesses, observability: obs },
      );
      entry.info.activeRuns = [...entry.info.activeRuns.filter((r) => r.id !== runId), rec];
    } else if (type === "agent.run.metrics") {
      const metricsPatch = isRecord(evt.metrics) ? (evt.metrics as Partial<AgentRunRecord>) : null;
      if (!metricsPatch) return;
      entry.info.activeRuns = entry.info.activeRuns.map((r) =>
        r.id === runId ? { ...r, ...metricsPatch, durationMs: Math.max(r.durationMs, Date.now() - r.startedAt) } : r,
      );
    } else if (type === "agent.run.finished") {
      entry.info.activeRuns = entry.info.activeRuns.filter((r) => r.id !== runId);
    }
  }
}

export interface NodeClientOptions {
  hubUrl: string;
  token?: string;
  nodeId: string;
  nodeName: string;
  executor?: HubExecutor;
  initialHarnesses?: HarnessInfo[];
  commandBuilder?: CustomCommandBuilder;
  githubDeps?: GitHubCommandDeps;
  giteeDeps?: GiteeApiDeps;
  reconnectBaseMs?: number;
  onConnected?: () => void;
  onDisconnected?: (reason?: string) => void;
  updates?: {
    read(): NodeUpdateReport | undefined;
    blocksWork(revision: string | undefined): boolean;
    start(id: string, target: string, running: string): Promise<void>;
  };
}

export interface NodeClientHandle {
  nodeId: string;
  nodeName: string;
  isConnected(): boolean;
  waitUntilConnected(timeoutMs?: number): Promise<void>;
  stop(): void;
}

/** Normalizes an HTTP(S) or WS(S) Hub URL into the `/ws?role=node...` WebSocket URL. */
export function buildNodeWebSocketUrl(
  hubUrl: string,
  meta: { nodeId: string; nodeName: string; hostname: string; platform: string; version: string },
): string {
  const trimmed = hubUrl.trim();
  const parsed = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  else if (parsed.protocol === "https:") parsed.protocol = "wss:";
  else if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new WorkbenchError("invalid_input", `不支持的 Hub 地址协议: ${parsed.protocol}`);
  }
  parsed.pathname = "/ws";
  parsed.search = "";
  parsed.searchParams.set("role", "node");
  parsed.searchParams.set("nodeId", meta.nodeId);
  parsed.searchParams.set("name", meta.nodeName);
  parsed.searchParams.set("hostname", meta.hostname);
  parsed.searchParams.set("platform", meta.platform);
  parsed.searchParams.set("version", meta.version);
  return parsed.toString();
}

/**
 * Starts the lightweight outbound Workbench Node client (designed for Windows WSL2).
 * Serves no HTTP port, compiles no Web bundle, and runs no RSI sandboxes.
 */
export function startWorkbenchNodeClient(options: NodeClientOptions): NodeClientHandle {
  const nodeId = options.nodeId.trim();
  const nodeName = options.nodeName.trim() || nodeId;
  const hostname = os.hostname();
  const platform = process.platform;
  const version = packageInfo.version;
  const revision = readSourceRevision();
  const wsUrl = buildNodeWebSocketUrl(options.hubUrl, { nodeId, nodeName, hostname, platform, version });

  let syncedPrefs: {
    routing: RoutingConfig;
    outputLanguage: OutputLanguage;
    giteeAccessToken: string | null;
    observability?: HubObservabilityConfig;
  } = {
    routing: buildPresetRouting("balanced"),
    outputLanguage: DEFAULT_OUTPUT_LANGUAGE,
    giteeAccessToken: null,
    observability: undefined,
  };

  let ws: WebSocket | null = null;
  let connected = false;
  let stopped = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const connectedWaiters: Array<{ resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

  const sendEnvelope = (payload: Record<string, unknown>): void => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // Ignore send errors on closing socket.
    }
  };

  const executor =
    options.executor ??
    new HubExecutor({
      nodeId,
      initialHarnesses: options.initialHarnesses,
      commandBuilder: options.commandBuilder,
      getHubPreferences: () => syncedPrefs,
      onTelemetryOutcome: (outcome) => {
        sendEnvelope({ type: "node.telemetry", outcome });
      },
      onPainPoint: (input) => {
        sendEnvelope({ type: "node.pain_point", input });
        return null;
      },
      onLedgerEntry: (entry) => {
        sendEnvelope({ type: "node.run_ledger", entry });
      },
    });

  const watchers = new Map<string, fs.FSWatcher>();
  const watchDebounces = new Map<string, ReturnType<typeof setTimeout>>();

  const ensureWatcherFor = (projectRoot: string) => {
    if (watchers.has(projectRoot)) return;
    const wbDir = path.join(projectRoot, WORKBENCH_DIR);
    if (!fs.existsSync(wbDir)) return;
    try {
      const watcher = fs.watch(wbDir, { recursive: true }, (_eventType, filename) => {
        if (typeof filename === "string" && (filename === ".lock" || filename.endsWith("/.lock"))) return;
        const prev = watchDebounces.get(projectRoot);
        if (prev) clearTimeout(prev);
        watchDebounces.set(
          projectRoot,
          setTimeout(() => {
            sendEnvelope({
              type: "node.event",
              event: { type: "workbench.updated", reason: "fs", root: projectRoot, at: Date.now() },
            });
          }, 60),
        );
      });
      watchers.set(projectRoot, watcher);
    } catch {
      // Ignore unsupported watch filesystems.
    }
  };

  const unsubExecutor = executor.subscribe((ev) => {
    sendEnvelope({
      type: "node.event",
      event: ev as unknown as Record<string, unknown>,
    });
  });

  const handleProjectApi = createProjectApiHandler({
    executor,
    getBridgeStatus: () => ({
      connected: false,
      agent: null,
      sessionId: null,
      state: "offline",
      model: null,
      updatedAt: Date.now(),
    }),
    dispatchToBridge: async (_reqId, _action, _mode, prompt) => ({
      delivered: false,
      status: "offline",
      reason: "no_live_bridge",
      prompt,
    }),
    broadcastUi: (event) => {
      sendEnvelope({ type: "node.event", event });
    },
    ensureWatcherFor,
    reloadWebBundle: async () => ({ reloaded: false }),
    getHubOutputLanguage: () => syncedPrefs.outputLanguage,
    getGiteeAccessToken: () => syncedPrefs.giteeAccessToken ?? process.env.GITEE_ACCESS_TOKEN ?? null,
    githubDeps: options.githubDeps,
    giteeDeps: options.giteeDeps,
  });

  let inFlight = 0;
  let queued: { id: string; until: number } | undefined;

  const handleRpc = async (req: NodeRpcRequest, work: boolean): Promise<NodeRpcResponse> => {
    try {
      if (req.kind === "update_status" && options.updates) {
        return { type: "node.rpc.response", reqId: req.reqId, status: 200, bodyJson: options.updates.read() ?? null };
      }
      if (req.kind === "update_start" && options.updates) {
        if (!revision || !isGitRevision(req.revision) || !req.updateId || req.revision === revision) {
          throw new WorkbenchError("invalid_input", "Invalid or already running node revision");
        }
        const report = options.updates.read();
        const launching = queued && queued.until > Date.now() && queued.id !== report?.id;
        const preparing = report?.phase === "preparing" && options.updates.blocksWork(revision);
        if (launching || preparing || inFlight || executor.getActiveRuns().length) {
          throw new WorkbenchError("revision_conflict", "The node is busy; wait for current requests, tasks or updates to finish");
        }
        queued = { id: req.updateId, until: Date.now() + 20_000 };
        try {
          await options.updates.start(req.updateId, req.revision, revision);
        } catch (error) {
          queued = undefined;
          throw error;
        }
        return { type: "node.rpc.response", reqId: req.reqId, status: 202 };
      }
      if (work && options.updates) {
        if (queued && (queued.until <= Date.now() || options.updates.read()?.id === queued.id)) queued = undefined;
        if (queued || options.updates.blocksWork(revision)) {
          throw new WorkbenchError("revision_conflict", "Node update in progress or requires repair; work is paused");
        }
      }
      if (req.kind === "browse") {
        const result = browseDirectory(req.path);
        return { type: "node.rpc.response", reqId: req.reqId, status: 200, bodyJson: result };
      }

      if (req.kind === "register_probe") {
        const base = canonicalRoot(req.root ?? "");
        if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
          throw new WorkbenchError("invalid_path", `目录不存在或不可访问: ${req.root ?? ""}`);
        }
        const statusBefore = getProjectStatus(base);
        let projectName = req.name?.trim() || statusBefore.project?.name;
        if ((req.initPrivacy === "local" || req.initPrivacy === "tracked") && !statusBefore.initialized) {
          const meta = await initProject(base, {
            name: projectName,
            privacyMode: req.initPrivacy,
          });
          projectName = meta.name;
        }
        ensureWatcherFor(base);
        const statusAfter = getProjectStatus(base);
        return {
          type: "node.rpc.response",
          reqId: req.reqId,
          status: 200,
          bodyJson: {
            root: base,
            name: projectName || path.basename(base) || "project",
            initialized: statusAfter.initialized,
            isGitRepo: fs.existsSync(path.join(base, ".git")),
          },
        };
      }

      if (req.kind === "projects_snapshot") {
        const roots = Array.isArray(req.roots) ? req.roots : [];
        const snapshots: Record<string, LocalProjectSnapshot> = {};
        await Promise.all(
          roots.map(async (r) => {
            try {
              const base = canonicalRoot(r);
              ensureWatcherFor(base);
              snapshots[r] = await buildLocalProjectSnapshot(base, executor);
            } catch {
              snapshots[r] = {
                initialized: false,
                isGitRepo: false,
                activeCount: 0,
                decisionCount: 0,
                runningCount: 0,
              };
            }
          }),
        );
        return { type: "node.rpc.response", reqId: req.reqId, status: 200, bodyJson: { snapshots } };
      }

      if (req.kind === "refresh_harnesses") {
        const harnesses = await executor.getHarnesses(true);
        sendEnvelope({ type: "node.harnesses", harnesses });
        return { type: "node.rpc.response", reqId: req.reqId, status: 200, bodyJson: { harnesses } };
      }

      if (req.kind === "upload_stage") {
        const files = (req.files ?? []).map((f) => ({
          name: f.name,
          bytes: Buffer.from(f.bytesBase64, "base64"),
        }));
        const attachments = stageUpload(files);
        return { type: "node.rpc.response", reqId: req.reqId, status: 201, bodyJson: { attachments } };
      }

      if (req.kind === "project_http") {
        if (req.routing || req.outputLanguage || req.giteeAccessToken !== undefined) {
          syncedPrefs = {
            routing: req.routing ?? syncedPrefs.routing,
            outputLanguage: req.outputLanguage ?? syncedPrefs.outputLanguage,
            giteeAccessToken:
              req.giteeAccessToken !== undefined ? req.giteeAccessToken : syncedPrefs.giteeAccessToken,
            observability: req.observability !== undefined ? req.observability : syncedPrefs.observability,
          };
        }
        const base = canonicalRoot(req.projectRoot ?? "");
        ensureWatcherFor(base);
        const method = (req.method ?? "GET").toUpperCase();
        const url = new URL(`${req.pathname ?? "/"}${req.search ?? ""}`, "http://workbench.node");
        const webReq = new Request(url.toString(), {
          method,
          headers: { "Content-Type": "application/json" },
          ...(method !== "GET" && method !== "HEAD" && req.bodyText !== undefined ? { body: req.bodyText } : {}),
        });
        const resp = (await handleProjectApi(webReq, url, base)) ??
          jsonResponse({ error: { code: "not_found", message: `未知接口: ${method} ${url.pathname}` } }, 404);
        const headers: Record<string, string> = {};
        resp.headers.forEach((v, k) => {
          headers[k] = v;
        });
        const contentType = (resp.headers.get("content-type") ?? "").toLowerCase();
        if (contentType.includes("application/json")) {
          const text = await resp.text();
          let bodyJson: unknown = {};
          try {
            bodyJson = text ? JSON.parse(text) : {};
          } catch {
            bodyJson = { raw: text };
          }
          return {
            type: "node.rpc.response",
            reqId: req.reqId,
            status: resp.status,
            headers,
            bodyJson,
          };
        }
        const bytes = Buffer.from(await resp.arrayBuffer());
        return {
          type: "node.rpc.response",
          reqId: req.reqId,
          status: resp.status,
          headers,
          bodyBase64: bytes.toString("base64"),
        };
      }

      throw new WorkbenchError("invalid_input", `未知远程节点请求类型: ${String((req as { kind?: unknown }).kind)}`);
    } catch (error) {
      if (error instanceof WorkbenchError) {
        return {
          type: "node.rpc.response",
          reqId: req.reqId,
          status: httpStatusForError(error.code),
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
          bodyJson: { error: error.toJSON() },
        };
      }
      return {
        type: "node.rpc.response",
        reqId: req.reqId,
        status: 500,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
        bodyJson: {
          error: {
            code: "execution_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        },
      };
    }
  };

  const connect = () => {
    if (stopped) return;
    const headers: Record<string, string> = {};
    if (options.token?.trim()) {
      headers.Authorization = `Bearer ${options.token.trim()}`;
    }
    // Bun's WebSocket constructor accepts `{ headers }` at runtime even though DOM typings only list protocols.
    const socket =
      Object.keys(headers).length > 0
        ? new WebSocket(wsUrl, { headers } as unknown as string[])
        : new WebSocket(wsUrl);
    ws = socket;

    socket.addEventListener("open", () => {
      if (stopped || ws !== socket) return;
      void (async () => {
        const quick = await executor.getHarnesses(false, true);
        if (ws !== socket || stopped || socket.readyState !== WebSocket.OPEN) return;
        sendEnvelope({
          type: "node.hello",
          nodeId,
          name: nodeName,
          hostname,
          platform,
          workbenchVersion: version,
          revision,
          updateEnabled: Boolean(options.updates && revision),
          harnesses: quick,
          activeRuns: executor.getActiveRuns(),
        });
        connected = true;
        reconnectAttempt = 0;
        options.onConnected?.();
        while (connectedWaiters.length > 0) {
          const w = connectedWaiters.shift()!;
          clearTimeout(w.timer);
          w.resolve();
        }
        // Refresh full CLI models in the background and push updated catalog.
        const full = await executor.getHarnesses(true);
        if (ws === socket && !stopped && socket.readyState === WebSocket.OPEN) {
          sendEnvelope({ type: "node.harnesses", harnesses: full });
        }
      })().catch(() => {});
    });

    socket.addEventListener("message", (ev) => {
      if (stopped || ws !== socket) return;
      let parsed: Record<string, unknown>;
      try {
        const text = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString("utf8");
        const raw = JSON.parse(text) as unknown;
        if (!isRecord(raw)) return;
        parsed = raw;
      } catch {
        return;
      }

      if (parsed.type === "node.ping") {
        sendEnvelope({ type: "node.pong", ts: parsed.ts ?? Date.now() });
        return;
      }

      if (parsed.type === "node.welcome" || parsed.type === "node.config.sync") {
        if (
          (parsed.routing && isRecord(parsed.routing)) ||
          parsed.giteeAccessToken !== undefined ||
          (parsed.observability && isRecord(parsed.observability))
        ) {
          syncedPrefs = {
            routing:
              parsed.routing && isRecord(parsed.routing)
                ? (parsed.routing as unknown as RoutingConfig)
                : syncedPrefs.routing,
            outputLanguage: (typeof parsed.outputLanguage === "string"
              ? parsed.outputLanguage
              : syncedPrefs.outputLanguage) as OutputLanguage,
            giteeAccessToken:
              parsed.giteeAccessToken !== undefined
                ? typeof parsed.giteeAccessToken === "string" && parsed.giteeAccessToken.trim()
                  ? parsed.giteeAccessToken.trim()
                  : null
                : syncedPrefs.giteeAccessToken,
            observability:
              parsed.observability && isRecord(parsed.observability)
                ? (parsed.observability as unknown as HubObservabilityConfig)
                : syncedPrefs.observability,
          };
        }
        return;
      }

      if (parsed.type === "node.rpc.request" && typeof parsed.reqId === "string") {
        const request = parsed as unknown as NodeRpcRequest;
        const work = request.kind === "project_http" || request.kind === "register_probe" || request.kind === "upload_stage";
        if (work) inFlight++;
        void handleRpc(request, work).then((resp) => {
          if (ws === socket && !stopped) sendEnvelope(resp as unknown as Record<string, unknown>);
        }).finally(() => { if (work) inFlight--; });
      }
    });

    socket.addEventListener("close", (ev) => {
      if (ws !== socket) return;
      const wasConnected = connected;
      connected = false;
      ws = null;
      if (wasConnected) {
        options.onDisconnected?.(ev.reason || `code ${ev.code}`);
      }
      if (!stopped) {
        const base = options.reconnectBaseMs ?? 1000;
        const delayMs = Math.min(15_000, base * Math.pow(2, Math.min(reconnectAttempt, 4)));
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(connect, delayMs);
        reconnectTimer.unref?.();
      }
    });

    socket.addEventListener("error", () => {
      // Close event handles cleanup & reconnect scheduling.
    });
  };

  connect();

  return {
    nodeId,
    nodeName,
    isConnected: () => connected,
    waitUntilConnected(timeoutMs = 10_000): Promise<void> {
      if (connected) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const entry = {
          resolve,
          reject,
          timer: setTimeout(() => {
            const idx = connectedWaiters.indexOf(entry);
            if (idx >= 0) connectedWaiters.splice(idx, 1);
            reject(new WorkbenchError("execution_failed", `连接 Hub 超时: ${options.hubUrl}`));
          }, timeoutMs),
        };
        connectedWaiters.push(entry);
      });
    },
    stop() {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      while (connectedWaiters.length > 0) {
        const w = connectedWaiters.shift()!;
        clearTimeout(w.timer);
        w.reject(new WorkbenchError("execution_failed", "远程节点已停止"));
      }
      unsubExecutor();
      executor.stopAllRuns();
      for (const t of watchDebounces.values()) clearTimeout(t);
      watchDebounces.clear();
      for (const w of watchers.values()) w.close();
      watchers.clear();
      try {
        ws?.close(1000, "node_stopped");
      } catch {
        // Ignore close errors.
      }
      ws = null;
      connected = false;
    },
  };
}
