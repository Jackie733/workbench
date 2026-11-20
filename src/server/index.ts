import packageInfo from "../../package.json";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ServerWebSocket } from "bun";
import {
  discardStagedAttachments,
  normalizeAttachments,
  painPointAttachmentsDir,
  readAttachmentForServe,
  stageUpload,
} from "../core/attachments.ts";
import { getProjectStatus, getRequirement, initProject } from "../core/engine.ts";
import { WorkbenchError } from "../core/errors.ts";
import { canonicalRoot } from "../core/fs.ts";
import type { GiteeApiDeps } from "../core/gitee.ts";
import type { GitHubCommandDeps } from "../core/github.ts";
import { DEFAULT_OUTPUT_LANGUAGE, normalizeOutputLanguage } from "../core/language.ts";
import { hubBindUrl } from "../core/net.ts";
import { readPlaybook } from "../core/playbook.ts";
import { readSandboxes } from "../core/sandbox.ts";
import {
  MAX_ATTACHMENT_TOTAL_BYTES,
  WORKBENCH_DIR,
  type AgentRunRecord,
  type PrivacyMode,
  type RequirementDetail,
  type Stage,
} from "../core/types.ts";
import { isRecord } from "../core/validate.ts";
import {
  applySandboxToMain,
  dismissPainPoint,
  inspectRsiSandboxDrift,
  PAIN_POINT_CATEGORIES,
  PAIN_POINT_SOURCES,
  promotePainPoint,
  readPainPoints,
  reportPainPoint,
  resolveWorkbenchRepoRoot,
  syncRsiSandboxBase,
  syncRsiSandboxPrAndCleanup,
  type PainPointCategory,
  type PainPointContext,
  type PainPointSource,
  type SandboxDriftInfo,
} from "../hub/evolution.ts";
import { HubExecutor } from "../hub/executor.ts";
import { RemoteNodeRegistry } from "../hub/node_bridge.ts";
import { NodeUpdates } from "../hub/node_updates.ts";
import {
  applyHubRoutingPreset,
  browseDirectory,
  isAutoRegistrableProjectRoot,
  isLocalNodeId,
  isRemoteNodeId,
  LOCAL_NODE_ID,
  maskAccessToken,
  readHubConfig,
  registerHubProject,
  removeDaemonInfo,
  removeHubProject,
  resolveEffectiveGiteeToken,
  resolveHubDir,
  setActiveHubProject,
  updateHubPreferences,
  updateHubProjectMeta,
  updateHubRouting,
  writeDaemonInfo,
} from "../hub/registry.ts";
import { readSourceRevision } from "../core/revision.ts";
import { clearModelCooldown, recordModelRunOutcome, summarizeTelemetry } from "../hub/telemetry.ts";
import {
  ROUTING_PRESETS,
  type HarnessInfo,
  type HubConfig,
  type RemoteNodeInfo,
  type RoutingConfig,
  type RoutingPreset,
} from "../hub/types.ts";
import {
  clearLoginFailures,
  createSessionVerifier,
  ensureAuthCredentials,
  expiredSessionCookieHeader,
  isLocalRequest,
  isLoopbackBind,
  issueSessionToken,
  loginLockRemainingMs,
  recordLoginFailure,
  sessionCookieHeader,
  verifyLoginPassword,
} from "./auth.ts";
import {
  buildLocalProjectSnapshot,
  createProjectApiHandler,
  httpStatusForError,
  jsonResponse,
  readBody,
  readStringArray,
  type BridgeStatus,
  type DispatchOutcome,
  type LocalProjectSnapshot,
} from "./project_api.ts";
import { type DispatchAction } from "./prompts.ts";
import { removeServerDiscovery, writeServerDiscovery, type ServerRuntimeInfo } from "./runtime.ts";

export type { BridgeStatus, DispatchOutcome } from "./project_api.ts";

interface WsClientData {
  role: "ui" | "bridge" | "node";
  id: string;
  nodeId?: string;
  nodeMeta?: {
    name: string;
    hostname: string;
    platform: string;
    workbenchVersion?: string;
  };
}

export interface WorkbenchServerHandle {
  port: number;
  url: string;
  root: string;
  stop(): void;
  getBridgeStatus(): BridgeStatus;
}

// 只公开界面与浏览器图标实际使用的四个文件；精确路径映射到 brand 下的固定文件名。
const BRAND_ASSETS: Record<string, { file: string; contentType: string }> = {
  "/favicon.svg": { file: "favicon.svg", contentType: "image/svg+xml" },
  "/favicon.ico": { file: "favicon.ico", contentType: "image/x-icon" },
  "/apple-touch-icon.png": { file: "apple-touch-icon.png", contentType: "image/png" },
  "/brand/symbol-compact.svg": { file: "symbol-compact.svg", contentType: "image/svg+xml" },
};

// Bun 1.3.14 在同进程重复 Bun.build 且相关模块已被运行时加载时会抛出 EBADF/EISDIR，
// 因此非开发模式下同一 webDir 的初始构建结果在进程内共享；开发模式与显式 reload 仍每次重新构建。
const initialWebBundles = new Map<string, Promise<{ html: string; css: string; js: string } | null>>();

async function buildWebBundle(webDir: string): Promise<{ html: string; css: string; js: string } | null> {
  const htmlPath = path.join(webDir, "index.html");
  const cssPath = path.join(webDir, "styles.css");
  const entryTsx = path.join(webDir, "app.tsx");
  const entryTs = fs.existsSync(entryTsx) ? entryTsx : path.join(webDir, "app.ts");
  if (!fs.existsSync(htmlPath) || !fs.existsSync(entryTs)) return null;

  const html = fs.readFileSync(htmlPath, "utf8");
  let css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, "utf8") : "";
  if (css.includes('@import "tailwindcss"') || css.includes("@import 'tailwindcss'")) {
    const { compile } = await import("@tailwindcss/node");
    const { Scanner } = await import("@tailwindcss/oxide");
    const scanner = new Scanner({ sources: [{ base: webDir, pattern: "**/*", negated: false }] });
    const candidates = scanner.scan();
    const compiler = await compile(css, { base: webDir, onDependency() {} });
    css = compiler.build(candidates);
  }
  const build = await Bun.build({
    entrypoints: [entryTs],
    target: "browser",
    format: "esm",
    minify: false,
  });
  if (!build.success || build.outputs.length === 0) {
    const msgs = build.logs.map((l) => l.message).join("; ");
    throw new Error(`构建前端 Web UI 失败: ${msgs}`);
  }
  const js = await build.outputs[0]!.text();
  return { html, css, js };
}

export async function startWorkbenchServer(options: {
  root: string;
  port?: number;
  hostname?: string;
  writeDiscovery?: boolean;
  hubMode?: boolean;
  webDir?: string;
  executor?: HubExecutor;
  githubDeps?: GitHubCommandDeps;
  giteeDeps?: GiteeApiDeps;
}): Promise<WorkbenchServerHandle> {
  const defaultRoot = canonicalRoot(options.root);
  const hubMode = options.hubMode === true;
  const hostname = options.hostname ?? "127.0.0.1";
  const hubDir = resolveHubDir();
  if (!isLoopbackBind(hostname)) ensureAuthCredentials(hubDir);
  const isAuthenticated = createSessionVerifier(hubDir);
  const webDir = options.webDir ?? path.resolve(import.meta.dir, "../web");
  const isDevWeb = process.env.WORKBENCH_DEV_WEB === "1";
  let cachedWeb: { html: string; css: string; js: string } | null;
  if (isDevWeb) {
    cachedWeb = await buildWebBundle(webDir);
  } else {
    let initial = initialWebBundles.get(webDir);
    if (!initial) {
      initial = buildWebBundle(webDir).catch((err) => {
        initialWebBundles.delete(webDir);
        throw err;
      });
      initialWebBundles.set(webDir, initial);
    }
    cachedWeb = await initial;
  }
  const executor = options.executor ?? new HubExecutor();
  const nodeRegistry = new RemoteNodeRegistry();
  const serverStartedAt = Date.now();
  const revision = readSourceRevision();

  if (hubMode && isAutoRegistrableProjectRoot(defaultRoot)) {
    registerHubProject(defaultRoot, { activate: false });
  }

  const uiSockets = new Set<ServerWebSocket<WsClientData>>();
  let bridgeSocket: ServerWebSocket<WsClientData> | null = null;
  let bridgeStatus: BridgeStatus = {
    connected: false,
    agent: null,
    sessionId: null,
    state: "offline",
    model: null,
    updatedAt: Date.now(),
  };

  const pendingDispatches = new Map<
    string,
    {
      resolve: (outcome: Omit<DispatchOutcome, "prompt">) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  const watchers = new Map<string, fs.FSWatcher>();
  const watchDebounces = new Map<string, ReturnType<typeof setTimeout>>();

  const broadcastUi = (event: Record<string, unknown>) => {
    const payload = JSON.stringify(event);
    for (const ws of uiSockets) {
      try {
        ws.send(payload);
      } catch {
        uiSockets.delete(ws);
      }
    }
  };

  const nodeUpdates = new NodeUpdates(nodeRegistry, () => {
    broadcastUi({ type: "hub.updated", reason: "node.update", at: Date.now() });
  });

  const reloadWebBundle = async (opts?: { manual?: boolean }): Promise<{ reloaded: boolean }> => {
    const rebuilt = await buildWebBundle(webDir);
    if (!rebuilt) return { reloaded: false };
    cachedWeb = rebuilt;
    if (!isDevWeb) initialWebBundles.set(webDir, Promise.resolve(rebuilt));
    broadcastUi({ type: "workbench.reload_ui", manual: opts?.manual === true, at: Date.now() });
    return { reloaded: true };
  };

  const findProjectId = (cfg: HubConfig, nodeId: string, root: string): string | undefined => {
    const targetNode = isLocalNodeId(nodeId) ? LOCAL_NODE_ID : nodeId;
    return cfg.projects.find((p) => (p.nodeId ?? LOCAL_NODE_ID) === targetNode && p.root === root)?.id;
  };

  const unsubExecutor = executor.subscribe((ev) => {
    const cfg = hubMode ? readHubConfig() : null;
    const projectId = cfg ? findProjectId(cfg, LOCAL_NODE_ID, ev.root) : undefined;
    broadcastUi({
      ...(ev as unknown as Record<string, unknown>),
      nodeId: LOCAL_NODE_ID,
      ...(projectId ? { projectId } : {}),
    });
  });

  const ensureWatcherFor = (projectRoot: string) => {
    if (watchers.has(projectRoot)) return;
    const wbDir = path.join(projectRoot, WORKBENCH_DIR);
    if (!fs.existsSync(wbDir)) return;
    try {
      const w = fs.watch(wbDir, { recursive: true }, (_eventType, filename) => {
        if (typeof filename === "string" && (filename === ".lock" || filename.endsWith("/.lock"))) return;
        const prevTimer = watchDebounces.get(projectRoot);
        if (prevTimer) clearTimeout(prevTimer);
        watchDebounces.set(
          projectRoot,
          setTimeout(() => {
            broadcastUi({ type: "workbench.updated", reason: "fs", root: projectRoot, nodeId: LOCAL_NODE_ID, at: Date.now() });
          }, 60),
        );
      });
      watchers.set(projectRoot, w);
    } catch {
      // Ignore watch errors on unsupported filesystems; API broadcasts still run.
    }
  };

  const syncAllWatchers = () => {
    if (hubMode) {
      const cfg = readHubConfig();
      for (const p of cfg.projects) {
        if (isLocalNodeId(p.nodeId)) {
          ensureWatcherFor(p.root);
        }
      }
      return;
    }
    ensureWatcherFor(defaultRoot);
  };

  syncAllWatchers();

  const resolveRequestTarget = (
    req: Request,
    url: URL,
    allowEmpty = false,
  ): { root: string; nodeId: string; projectId: string | null } | null => {
    const param = url.searchParams.get("project") ?? req.headers.get("x-workbench-project");
    if (param) {
      const cfg = readHubConfig();
      const byId = cfg.projects.find((p) => p.id === param);
      if (byId) {
        return { root: byId.root, nodeId: byId.nodeId ?? LOCAL_NODE_ID, projectId: byId.id };
      }
      if (!hubMode && param === "default") {
        return { root: defaultRoot, nodeId: LOCAL_NODE_ID, projectId: null };
      }
      if (allowEmpty) return null;
      throw new WorkbenchError("not_found", `未找到目标项目: ${param}`);
    }
    if (hubMode) {
      const cfg = readHubConfig();
      const active = cfg.projects.find((p) => p.id === cfg.activeProjectId) ?? cfg.projects[0];
      if (active) {
        return { root: active.root, nodeId: active.nodeId ?? LOCAL_NODE_ID, projectId: active.id };
      }
      if (allowEmpty) return null;
      throw new WorkbenchError("not_found", "当前 Hub 尚未纳管任何项目，请先添加本地项目");
    }
    return { root: defaultRoot, nodeId: LOCAL_NODE_ID, projectId: null };
  };

  const buildHubProjectsSnapshot = async () => {
    const cfg = readHubConfig();
    if (!hubMode) {
      return { cfg, projects: [] };
    }

    const remoteGroups = new Map<string, string[]>();
    for (const p of cfg.projects) {
      if (!isLocalNodeId(p.nodeId)) {
        const nid = p.nodeId!;
        const list = remoteGroups.get(nid) ?? [];
        list.push(p.root);
        remoteGroups.set(nid, list);
      }
    }

    const remoteSnapshots = new Map<string, Record<string, LocalProjectSnapshot>>();
    await Promise.all(
      Array.from(remoteGroups.entries()).map(async ([nid, roots]) => {
        if (!nodeRegistry.isConnected(nid)) return;
        try {
          const res = await nodeRegistry.rpc(nid, { kind: "projects_snapshot", roots }, 8_000);
          const body = res.bodyJson as { snapshots?: Record<string, LocalProjectSnapshot> } | undefined;
          if (body?.snapshots) {
            remoteSnapshots.set(nid, body.snapshots);
          }
        } catch {
          // Remote node timed out or disconnected mid-snapshot; fall back to offline state.
        }
      }),
    );

    const projects = await Promise.all(
      cfg.projects.map(async (entry) => {
        if (isLocalNodeId(entry.nodeId)) {
          const snap = await buildLocalProjectSnapshot(entry.root, executor);
          return {
            ...entry,
            nodeId: LOCAL_NODE_ID,
            nodeOnline: true,
            ...snap,
          };
        }
        const nid = entry.nodeId!;
        const online = nodeRegistry.isConnected(nid);
        const snap = remoteSnapshots.get(nid)?.[entry.root];
        return {
          ...entry,
          nodeId: nid,
          nodeName: nodeRegistry.getNode(nid)?.name ?? entry.nodeName ?? nid,
          nodeOnline: online,
          initialized: snap?.initialized ?? false,
          isGitRepo: snap?.isGitRepo ?? false,
          activeCount: snap?.activeCount ?? 0,
          decisionCount: snap?.decisionCount ?? 0,
          runningCount: snap?.runningCount ?? 0,
        };
      }),
    );
    return { cfg, projects };
  };

  const buildAllNodesList = (cfg: HubConfig, localHarnesses: HarnessInfo[]): RemoteNodeInfo[] => {
    const enrichRuns = (
      runs: Array<AgentRunRecord & { requirementId: string; root?: string; projectId?: string }>,
      nid: string,
    ) =>
      runs.map((r) => ({
        ...r,
        projectId: r.projectId ?? (r.root ? findProjectId(cfg, nid, r.root) : undefined),
      }));

    const localNode: RemoteNodeInfo = {
      nodeId: LOCAL_NODE_ID,
      name: "本机",
      isLocal: true,
      hostname: os.hostname(),
      platform: process.platform,
      connected: true,
      connectedAt: serverStartedAt,
      lastSeenAt: Date.now(),
      harnesses: localHarnesses,
      activeRuns: enrichRuns(executor.getActiveRuns(), LOCAL_NODE_ID),
      workbenchVersion: packageInfo.version,
      revision,
    };

    const connected = nodeRegistry.listConnectedNodes().map((n) => ({
      ...n,
      activeRuns: enrichRuns(n.activeRuns, n.nodeId),
      update: nodeUpdates.get(n.nodeId),
    }));
    const seenIds = new Set<string>([LOCAL_NODE_ID, ...connected.map((n) => n.nodeId)]);

    const offlineNodes: RemoteNodeInfo[] = [];
    for (const node of nodeUpdates.offlineNodes()) {
      if (seenIds.has(node.nodeId)) continue;
      seenIds.add(node.nodeId);
      offlineNodes.push({ ...node, update: nodeUpdates.get(node.nodeId) });
    }
    for (const proj of cfg.projects) {
      if (isLocalNodeId(proj.nodeId) || seenIds.has(proj.nodeId!)) continue;
      seenIds.add(proj.nodeId!);
      offlineNodes.push({
        nodeId: proj.nodeId!,
        name: proj.nodeName ?? proj.nodeId!,
        isLocal: false,
        hostname: proj.nodeName ?? proj.nodeId!,
        platform: "linux",
        connected: false,
        connectedAt: null,
        lastSeenAt: null,
        harnesses: [],
        activeRuns: [],
      });
    }

    return [localNode, ...connected, ...offlineNodes];
  };

  const dispatchToBridge = async (
    requirementId: string,
    action: DispatchAction,
    mode: "send" | "prefill",
    prompt: string,
  ): Promise<DispatchOutcome> => {
    if (!bridgeSocket || !bridgeStatus.connected) {
      return { delivered: false, status: "offline", reason: "no_live_bridge", prompt };
    }
    const dispatchId = randomUUID();
    const ack = await new Promise<Omit<DispatchOutcome, "prompt">>((resolve) => {
      const timer = setTimeout(() => {
        pendingDispatches.delete(dispatchId);
        resolve({ delivered: false, status: "rejected", reason: "bridge_timeout" });
      }, 5_000);
      pendingDispatches.set(dispatchId, { resolve, timer });
      try {
        bridgeSocket!.send(
          JSON.stringify({
            type: "bridge.dispatch",
            dispatchId,
            mode,
            requirementId,
            action,
            prompt,
          }),
        );
      } catch {
        clearTimeout(timer);
        pendingDispatches.delete(dispatchId);
        resolve({ delivered: false, status: "offline", reason: "bridge_send_failed" });
      }
    });
    return { ...ack, prompt };
  };

  const handleProjectApi = createProjectApiHandler({
    executor,
    getBridgeStatus: () => bridgeStatus,
    dispatchToBridge,
    broadcastUi,
    ensureWatcherFor,
    reloadWebBundle,
    getHubOutputLanguage: () => readHubConfig().outputLanguage,
    getGiteeAccessToken: () => resolveEffectiveGiteeToken(readHubConfig()),
    githubDeps: options.githubDeps,
    giteeDeps: options.giteeDeps,
  });

  const handleApi = async (req: Request, url: URL): Promise<Response> => {
    const pathname = url.pathname;
    const method = req.method.toUpperCase();

    if (method === "GET" && pathname === "/api/health") {
      return jsonResponse({ ok: true, root: defaultRoot, serverPid: process.pid, hubMode });
    }

    if (method === "POST" && pathname === "/api/uploads") {
      const contentLength = Number(req.headers.get("content-length") ?? "0");
      if (Number.isFinite(contentLength) && contentLength > MAX_ATTACHMENT_TOTAL_BYTES) {
        throw new WorkbenchError(
          "payload_too_large",
          `附件上传内容超过 ${Math.round(MAX_ATTACHMENT_TOTAL_BYTES / (1024 * 1024))} MB 上限`,
        );
      }
      const contentType = req.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().includes("multipart/form-data")) {
        throw new WorkbenchError("invalid_input", "附件上传必须使用 multipart/form-data");
      }
      let form: FormData;
      try {
        form = await req.formData();
      } catch {
        throw new WorkbenchError("invalid_input", "无法解析上传内容");
      }
      const rawFiles = form.getAll("files");
      const files = rawFiles.filter((v): v is File => typeof v !== "string");
      if (files.length === 0) {
        throw new WorkbenchError("invalid_input", "请选择至少一个附件文件");
      }

      if (url.searchParams.get("scope") !== "hub") {
        const target = resolveRequestTarget(req, url, true);
        if (target && !isLocalNodeId(target.nodeId)) {
          const encoded = await Promise.all(
            files.map(async (file) => ({
              name: file.name,
              bytesBase64: Buffer.from(await file.arrayBuffer()).toString("base64"),
            })),
          );
          const res = await nodeRegistry.rpc(target.nodeId, { kind: "upload_stage", files: encoded }, 45_000);
          return jsonResponse(res.bodyJson, res.status);
        }
      }

      const inputs = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          bytes: Buffer.from(await file.arrayBuffer()),
        })),
      );
      const attachments = stageUpload(inputs);
      return jsonResponse({ attachments }, 201);
    }

    // --- Hub & Global Discovery/Routing Routes ---
    const updateNode = pathname.match(/^\/api\/hub\/nodes\/([A-Za-z0-9._-]{1,64})\/update$/);
    if (method === "POST" && updateNode) {
      if (!hubMode || !revision || !isRemoteNodeId(updateNode[1])) {
        throw new WorkbenchError("invalid_input", "Node update requires a Hub running a Git commit and a remote node");
      }
      const body = await readBody(req);
      if (body.revision !== revision) throw new WorkbenchError("revision_conflict", "Hub revision changed; reload before updating the node");
      return jsonResponse(await nodeUpdates.start(updateNode[1], revision), 202);
    }
    if (method === "GET" && pathname === "/api/hub/state") {
      const [{ cfg, projects }, localHarnesses] = await Promise.all([
        buildHubProjectsSnapshot(),
        executor.getHarnesses(false, !hubMode),
      ]);
      const evolutionOpenCount = readPainPoints().filter((p) => p.status === "open").length;
      const telemetry = summarizeTelemetry();
      const nodes = buildAllNodesList(cfg, localHarnesses);
      const activeId = hubMode ? (cfg.activeProjectId ?? projects[0]?.id ?? null) : null;
      const activeProj = activeId ? projects.find((p) => p.id === activeId) : undefined;
      const activeNodeId = activeProj?.nodeId ?? LOCAL_NODE_ID;
      const activeNode = nodes.find((n) => n.nodeId === activeNodeId);
      const effectiveHarnesses =
        !isLocalNodeId(activeNodeId) && activeNode
          ? activeNode.harnesses
          : localHarnesses;
      const activeRuns = nodes.flatMap((n) => n.activeRuns);

      const effectiveGiteeToken = resolveEffectiveGiteeToken(cfg);
      return jsonResponse({
        hubMode,
        activeProjectId: activeId,
        activeNodeId,
        projects: hubMode ? projects : [],
        nodes,
        harnesses: effectiveHarnesses,
        routing: cfg.routing,
        outputLanguage: cfg.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE,
        giteeTokenConfigured: Boolean(effectiveGiteeToken),
        giteeTokenMasked: maskAccessToken(effectiveGiteeToken),
        activeRuns,
        evolutionOpenCount,
        cooldownCount: telemetry.activeCooldowns.length,
      });
    }

    if (method === "PUT" && pathname === "/api/hub/preferences") {
      const body = await readBody(req);
      const outputLanguage = body.outputLanguage !== undefined ? normalizeOutputLanguage(body.outputLanguage) : undefined;
      if (body.outputLanguage !== undefined && !outputLanguage) {
        throw new WorkbenchError("invalid_input", `不支持的输出语言: ${String(body.outputLanguage)}`);
      }
      const giteeAccessToken =
        body.giteeAccessToken === null
          ? null
          : typeof body.giteeAccessToken === "string"
            ? body.giteeAccessToken
            : undefined;
      const cfg = updateHubPreferences({ outputLanguage, giteeAccessToken });
      const effectiveToken = resolveEffectiveGiteeToken(cfg);
      nodeRegistry.broadcastConfigSync(cfg.routing, cfg.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE, effectiveToken);
      broadcastUi({ type: "hub.updated", reason: "preferences.updated", at: Date.now() });
      return jsonResponse({
        outputLanguage: cfg.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE,
        giteeTokenConfigured: Boolean(effectiveToken),
        giteeTokenMasked: maskAccessToken(effectiveToken),
      });
    }

    if (method === "POST" && pathname === "/api/hub/projects") {
      const body = await readBody(req);
      const rawRoot = typeof body.root === "string" ? body.root : "";
      const rawNodeId = typeof body.nodeId === "string" ? body.nodeId.trim() : "";
      const initPrivacy = body.initPrivacy === "local" || body.initPrivacy === "tracked" ? (body.initPrivacy as PrivacyMode) : undefined;

      if (rawNodeId && !isLocalNodeId(rawNodeId)) {
        const node = nodeRegistry.getNode(rawNodeId);
        if (!node) {
          throw new WorkbenchError("execution_failed", `远程节点 ${rawNodeId} 当前不在线，无法添加项目`);
        }
        const probeRes = await nodeRegistry.rpc(rawNodeId, {
          kind: "register_probe",
          root: rawRoot,
          name: typeof body.name === "string" ? body.name : undefined,
          initPrivacy,
        });
        if (probeRes.status >= 400) {
          return jsonResponse(probeRes.bodyJson, probeRes.status);
        }
        const probe = probeRes.bodyJson as { root: string; name?: string };
        const { project } = registerHubProject(probe.root, {
          name: typeof body.name === "string" && body.name.trim() ? body.name : probe.name,
          activate: body.activate !== false,
          nodeId: rawNodeId,
          nodeName: node.name,
        });
        broadcastUi({ type: "hub.updated", reason: "project.added", projectId: project.id, at: Date.now() });
        const { cfg, projects } = await buildHubProjectsSnapshot();
        return jsonResponse({ project, activeProjectId: cfg.activeProjectId, projects }, 201);
      }

      const { project } = registerHubProject(rawRoot, {
        name: typeof body.name === "string" ? body.name : undefined,
        activate: body.activate !== false,
      });
      if (initPrivacy && !getProjectStatus(project.root).initialized) {
        await initProject(project.root, { name: project.name, privacyMode: initPrivacy });
      }
      ensureWatcherFor(project.root);
      broadcastUi({ type: "hub.updated", reason: "project.added", projectId: project.id, at: Date.now() });
      const { cfg, projects } = await buildHubProjectsSnapshot();
      return jsonResponse({ project, activeProjectId: cfg.activeProjectId, projects }, 201);
    }

    const hubActivateMatch = /^\/api\/hub\/projects\/([^/]+)\/activate$/.exec(pathname);
    if (method === "POST" && hubActivateMatch) {
      const projectId = decodeURIComponent(hubActivateMatch[1]!);
      const { project } = setActiveHubProject(projectId);
      if (isLocalNodeId(project.nodeId)) {
        ensureWatcherFor(project.root);
      }
      broadcastUi({ type: "hub.updated", reason: "project.activated", projectId: project.id, at: Date.now() });
      const { cfg, projects } = await buildHubProjectsSnapshot();
      return jsonResponse({ project, activeProjectId: cfg.activeProjectId, projects });
    }

    if (method === "POST" && pathname === "/api/hub/projects/meta") {
      const body = await readBody(req);
      const id = typeof body.projectId === "string" ? body.projectId.trim() : "";
      if (!id) throw new WorkbenchError("invalid_input", "projectId 不能为空");
      if (body.pinned !== undefined && typeof body.pinned !== "boolean") {
        throw new WorkbenchError("invalid_input", "pinned 必须是布尔值");
      }
      if (body.category !== undefined && body.category !== null && typeof body.category !== "string") {
        throw new WorkbenchError("invalid_input", "category 必须是字符串或 null");
      }
      if (body.pinned === undefined && body.category === undefined) {
        throw new WorkbenchError("invalid_input", "请提供 pinned 或 category 字段");
      }
      const pinned = body.pinned as boolean | undefined;
      const category = body.category as string | null | undefined;
      updateHubProjectMeta(id, { pinned, category });
      broadcastUi({ type: "hub.updated", reason: "project.meta", projectId: id, at: Date.now() });
      return jsonResponse({ ok: true });
    }

    const hubDeleteMatch = /^\/api\/hub\/projects\/([^/]+)$/.exec(pathname);
    if (method === "DELETE" && hubDeleteMatch) {
      const projectId = decodeURIComponent(hubDeleteMatch[1]!);
      const cfg = removeHubProject(projectId);
      broadcastUi({ type: "hub.updated", reason: "project.removed", projectId, at: Date.now() });
      return jsonResponse({ activeProjectId: cfg.activeProjectId, projects: (await buildHubProjectsSnapshot()).projects });
    }

    if (method === "GET" && pathname === "/api/fs/browse") {
      const nodeParam = url.searchParams.get("node");
      const target = url.searchParams.get("path") ?? undefined;
      if (nodeParam && !isLocalNodeId(nodeParam)) {
        const rpcRes = await nodeRegistry.rpc(nodeParam, { kind: "browse", path: target });
        return jsonResponse(rpcRes.bodyJson, rpcRes.status);
      }
      return jsonResponse(browseDirectory(target));
    }

    if (method === "GET" && pathname === "/api/hub/harnesses") {
      const nodeParam = url.searchParams.get("node");
      if (nodeParam && !isLocalNodeId(nodeParam)) {
        const node = nodeRegistry.getNode(nodeParam);
        return jsonResponse({ harnesses: node?.harnesses ?? [] });
      }
      const harnesses = await executor.getHarnesses(false);
      return jsonResponse({ harnesses });
    }

    if (method === "POST" && pathname === "/api/hub/harnesses/refresh") {
      const nodeParam = url.searchParams.get("node");
      if (nodeParam && !isLocalNodeId(nodeParam)) {
        const rpcRes = await nodeRegistry.rpc(nodeParam, { kind: "refresh_harnesses" }, 45_000);
        return jsonResponse(rpcRes.bodyJson, rpcRes.status);
      }
      const harnesses = await executor.getHarnesses(true);
      return jsonResponse({ harnesses });
    }

    if (method === "GET" && pathname === "/api/hub/routing") {
      const cfg = readHubConfig();
      return jsonResponse({ routing: cfg.routing });
    }

    if (method === "PUT" && pathname === "/api/hub/routing") {
      const body = await readBody(req);
      const cfg = updateHubRouting(body as unknown as RoutingConfig);
      nodeRegistry.broadcastConfigSync(cfg.routing, cfg.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE);
      broadcastUi({ type: "hub.updated", reason: "routing.updated", at: Date.now() });
      return jsonResponse({ routing: cfg.routing });
    }

    if (method === "POST" && pathname === "/api/hub/routing/preset") {
      const body = await readBody(req);
      const preset = typeof body.preset === "string" ? body.preset : "";
      if (!(ROUTING_PRESETS as readonly string[]).includes(preset)) {
        throw new WorkbenchError("invalid_input", `无效的路由预设: ${preset}`);
      }
      const harnesses = await executor.getHarnesses(false);
      const cfg = applyHubRoutingPreset(preset as RoutingPreset, harnesses);
      nodeRegistry.broadcastConfigSync(cfg.routing, cfg.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE);
      broadcastUi({ type: "hub.updated", reason: "routing.preset", preset, at: Date.now() });
      return jsonResponse({ routing: cfg.routing });
    }

    if (method === "GET" && pathname === "/api/hub/evolution") {
      const wbRoot = resolveWorkbenchRepoRoot(defaultRoot);
      const cfg = readHubConfig();
      const paramPid = url.searchParams.get("project");
      const activeProj =
        (paramPid ? cfg.projects.find((p) => p.id === paramPid) : undefined) ??
        cfg.projects.find((p) => p.id === cfg.activeProjectId) ??
        cfg.projects[0];
      const currentPlaybookRoot = activeProj && isLocalNodeId(activeProj.nodeId) ? activeProj.root : hubMode ? null : defaultRoot;
      const wbProjectId = cfg.projects.find((p) => isLocalNodeId(p.nodeId) && p.root === wbRoot)?.id ?? null;
      const sandboxes = await Promise.all(
        Object.values(readSandboxes()).map(async (sb) => {
          let stage: Stage | null = null;
          let canApply = false;
          let github: RequirementDetail["state"]["github"] = null;
          let drift: SandboxDriftInfo | null = null;
          try {
            if (fs.existsSync(sb.worktreePath)) {
              const detail = getRequirement(sb.projectRoot, sb.requirementId);
              stage = detail.state.stage;
              canApply = detail.state.stage === "done" && detail.state.acceptance !== null;
              github = detail.state.github ?? null;
              drift = await inspectRsiSandboxDrift(sb.projectRoot, sb.requirementId).catch(() => null);
            }
          } catch {
            // Ignore stale or inaccessible requirement state.
          }
          return { ...sb, stage, canApply, github, ...(drift ? { drift } : {}) };
        }),
      );
      return jsonResponse({
        painPoints: readPainPoints(),
        telemetry: summarizeTelemetry(),
        sandboxes,
        workbenchRoot: wbRoot,
        workbenchProjectId: wbProjectId,
        playbook: currentPlaybookRoot
          ? readPlaybook(currentPlaybookRoot)
          : { exists: false, markdown: "", rules: [], updatedAt: null },
      });
    }

    if (method === "POST" && pathname === "/api/hub/evolution/report") {
      const body = await readBody(req);
      const title = typeof body.title === "string" ? body.title : "";
      const detail = typeof body.detail === "string" ? body.detail : undefined;
      const source: PainPointSource =
        typeof body.source === "string" && (PAIN_POINT_SOURCES as readonly string[]).includes(body.source)
          ? (body.source as PainPointSource)
          : "ui_quick_report";
      const category: PainPointCategory =
        typeof body.category === "string" && (PAIN_POINT_CATEGORIES as readonly string[]).includes(body.category)
          ? (body.category as PainPointCategory)
          : "ui_anomaly";
      const context = isRecord(body.context) ? (body.context as PainPointContext) : {};
      const attachmentIds = readStringArray(body.attachmentIds);
      const painPoint = reportPainPoint({ source, category, title, detail, context, attachmentIds });
      if (!painPoint && attachmentIds && attachmentIds.length > 0) {
        discardStagedAttachments(attachmentIds);
      }
      broadcastUi({ type: "hub.updated", reason: "evolution.reported", at: Date.now() });
      return jsonResponse({ painPoint }, 201);
    }

    const evoAttachmentMatch = /^\/api\/hub\/evolution\/([^/]+)\/attachments\/([^/]+)$/.exec(pathname);
    if (method === "GET" && evoAttachmentMatch) {
      const painId = decodeURIComponent(evoAttachmentMatch[1]!);
      const attId = decodeURIComponent(evoAttachmentMatch[2]!);
      const pain = readPainPoints().find((p) => p.id === painId);
      if (!pain) throw new WorkbenchError("not_found", "痛点记录不存在");
      const metas = normalizeAttachments(pain.attachments) ?? [];
      const served = readAttachmentForServe(painPointAttachmentsDir(painId), attId, metas);
      return new Response(Uint8Array.from(served.bytes), { headers: served.headers });
    }

    const evoPromoteMatch = /^\/api\/hub\/evolution\/([^/]+)\/promote$/.exec(pathname);
    if (method === "POST" && evoPromoteMatch) {
      const painId = decodeURIComponent(evoPromoteMatch[1]!);
      const body = await readBody(req);
      const result = await promotePainPoint(
        painId,
        {
          workbenchRoot: defaultRoot,
          createSandbox: body.createSandbox !== false,
          createGitHubIssue:
            body.createGitHubIssue === true ? true : body.createGitHubIssue === false ? false : undefined,
        },
        options.githubDeps,
      );
      ensureWatcherFor(result.workbenchRoot);
      broadcastUi({ type: "hub.updated", reason: "evolution.promoted", painId, at: Date.now() });
      broadcastUi({
        type: "workbench.updated",
        reason: "requirement.created",
        root: result.workbenchRoot,
        id: result.requirement.state.id,
        at: Date.now(),
      });
      return jsonResponse(result, 201);
    }

    const evoDismissMatch = /^\/api\/hub\/evolution\/([^/]+)\/dismiss$/.exec(pathname);
    if (method === "POST" && evoDismissMatch) {
      const painId = decodeURIComponent(evoDismissMatch[1]!);
      const painPoint = dismissPainPoint(painId);
      broadcastUi({ type: "hub.updated", reason: "evolution.dismissed", painId, at: Date.now() });
      return jsonResponse({ painPoint });
    }

    const evoApplyMatch = /^\/api\/hub\/evolution\/apply\/(REQ-\d{3,})$/.exec(pathname);
    if (method === "POST" && evoApplyMatch) {
      const reqId = evoApplyMatch[1]!;
      const wbRoot = resolveWorkbenchRepoRoot(defaultRoot);
      const applied = await applySandboxToMain(wbRoot, reqId);
      const reloadRes = applied.touchesWeb ? await reloadWebBundle() : { reloaded: false };
      broadcastUi({ type: "hub.updated", reason: "evolution.applied", reqId, at: Date.now() });
      broadcastUi({ type: "workbench.updated", reason: "sandbox.applied", root: wbRoot, id: reqId, at: Date.now() });
      return jsonResponse({
        ...applied,
        webReloaded: reloadRes.reloaded,
        restartRecommended: applied.touchesBackend,
      });
    }

    const evoSyncBaseMatch = /^\/api\/hub\/evolution\/sync-base\/(REQ-\d{3,})$/.exec(pathname);
    if (method === "POST" && evoSyncBaseMatch) {
      const reqId = evoSyncBaseMatch[1]!;
      const wbRoot = resolveWorkbenchRepoRoot(defaultRoot);
      const res = await syncRsiSandboxBase(wbRoot, reqId);
      broadcastUi({ type: "hub.updated", reason: "evolution.base_synced", reqId, at: Date.now() });
      broadcastUi({ type: "workbench.updated", reason: "sandbox.base_synced", root: wbRoot, id: reqId, at: Date.now() });
      return jsonResponse(res);
    }

    const evoSyncPrMatch = /^\/api\/hub\/evolution\/sync-pr\/(REQ-\d{3,})$/.exec(pathname);
    if (method === "POST" && evoSyncPrMatch) {
      const reqId = evoSyncPrMatch[1]!;
      const body = await readBody(req);
      const wbRoot = resolveWorkbenchRepoRoot(defaultRoot);
      const synced = await syncRsiSandboxPrAndCleanup(
        wbRoot,
        reqId,
        { forceCleanup: body.forceCleanup === true },
        options.githubDeps,
      );
      const reloadRes = synced.cleanedSandbox && synced.touchesWeb ? await reloadWebBundle() : { reloaded: false };
      broadcastUi({ type: "hub.updated", reason: "evolution.pr_synced", reqId, at: Date.now() });
      broadcastUi({ type: "workbench.updated", reason: "github.pr_synced", root: wbRoot, id: reqId, at: Date.now() });
      return jsonResponse({
        ...synced,
        webReloaded: reloadRes.reloaded,
        restartRecommended: synced.cleanedSandbox && synced.touchesBackend,
      });
    }

    if (method === "POST" && pathname === "/api/hub/telemetry/clear-cooldown") {
      const body = await readBody(req);
      const harness = typeof body.harness === "string" ? body.harness : undefined;
      const model = typeof body.model === "string" ? body.model : undefined;
      clearModelCooldown(harness, model);
      broadcastUi({ type: "hub.updated", reason: "telemetry.cleared", at: Date.now() });
      return jsonResponse({ telemetry: summarizeTelemetry() });
    }

    if (method === "POST" && pathname === "/api/hub/reload-web") {
      const res = await reloadWebBundle({ manual: true });
      return jsonResponse({ ok: true, ...res });
    }

    // --- Project-Scoped Routes (?project=<id> or default) ---
    const target = resolveRequestTarget(req, url)!;
    if (!isLocalNodeId(target.nodeId)) {
      const cfg = readHubConfig();
      return nodeRegistry.forwardProjectHttp(
        target.nodeId,
        target.root,
        req,
        url,
        cfg.routing,
        cfg.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE,
        resolveEffectiveGiteeToken(cfg),
      );
    }

    const handled = await handleProjectApi(req, url, target.root);
    if (handled) return handled;

    return jsonResponse({ error: { code: "not_found", message: `未知接口: ${method} ${pathname}` } }, 404);
  };

  const server = Bun.serve<WsClientData>({
    hostname,
    port: options.port ?? 0,
    async fetch(req, bunServer) {
      const url = new URL(req.url);
      const remoteAddress = bunServer.requestIP(req)?.address ?? null;
      const local = isLocalRequest(remoteAddress, req.headers.get("host"), hostname);
      const authed = local || isAuthenticated(req);

      if (url.pathname === "/api/auth/status" && req.method === "GET") {
        return jsonResponse({ required: !local, authenticated: authed });
      }
      if (url.pathname === "/api/auth/login" && req.method === "POST") {
        const lockedMs = loginLockRemainingMs(remoteAddress);
        if (lockedMs > 0) {
          return jsonResponse(
            { error: { code: "rate_limited", message: `登录尝试过于频繁，请 ${Math.ceil(lockedMs / 1000)} 秒后再试` } },
            429,
          );
        }
        let body: Record<string, unknown>;
        try {
          body = await readBody(req);
        } catch (error) {
          return jsonResponse(
            { error: { code: "invalid_input", message: error instanceof Error ? error.message : String(error) } },
            400,
          );
        }
        const password = typeof body.password === "string" ? body.password : "";
        if (!verifyLoginPassword(password, hubDir)) {
          recordLoginFailure(remoteAddress);
          return jsonResponse({ error: { code: "unauthorized", message: "密码错误" } }, 401);
        }
        clearLoginFailures(remoteAddress);
        return new Response(JSON.stringify({ authenticated: true }), {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "Set-Cookie": sessionCookieHeader(issueSessionToken(hubDir)),
          },
        });
      }
      if (url.pathname === "/api/auth/logout" && req.method === "POST") {
        return new Response(JSON.stringify({ authenticated: false }), {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "Set-Cookie": expiredSessionCookieHeader(),
          },
        });
      }

      if (!authed) {
        if (url.pathname.startsWith("/api/")) {
          return jsonResponse({ error: { code: "unauthorized", message: "需要登录；请在登录页输入访问密码" } }, 401);
        }
        if (url.pathname === "/ws") {
          return new Response("Unauthorized", { status: 401 });
        }
        // Static assets stay public so the login view itself can load.
      }
      if (req.method === "POST" && /^\/api\/hub\/nodes\/[^/]+\/update$/.test(url.pathname)) {
        const cookie = req.headers.get("cookie");
        // A node bearer credential is not a browser session, and cross-origin forms cannot trigger updates.
        if (req.headers.get("origin") !== url.origin ||
            (!local && (!cookie || !isAuthenticated(new Request(url, { headers: { cookie } }))))) {
          return jsonResponse({ error: { code: "unauthorized", message: "Node updates require a same-origin Hub browser session" } }, 403);
        }
      }

      if (url.pathname === "/ws") {
        const roleParam = url.searchParams.get("role");
        const role = roleParam === "bridge" ? "bridge" : roleParam === "node" ? "node" : "ui";
        let nodeId: string | undefined;
        let nodeMeta: WsClientData["nodeMeta"];
        if (role === "node") {
          const rawNodeId = (url.searchParams.get("nodeId") ?? "").trim();
          if (!isRemoteNodeId(rawNodeId)) {
            return new Response("Invalid nodeId", { status: 400 });
          }
          nodeId = rawNodeId;
          const cleanParam = (key: string, max: number) =>
            (url.searchParams.get(key) ?? "").replace(/[\0\r\n]/g, "").trim().slice(0, max);
          const version = cleanParam("version", 32);
          nodeMeta = {
            name: cleanParam("name", 120) || rawNodeId,
            hostname: cleanParam("hostname", 120) || rawNodeId,
            platform: cleanParam("platform", 32) || "linux",
            ...(version ? { workbenchVersion: version } : {}),
          };
        }
        const upgraded = bunServer.upgrade(req, {
          data: { role, id: randomUUID(), ...(nodeId ? { nodeId, nodeMeta } : {}) },
        });
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      if (url.pathname.startsWith("/api/")) {
        try {
          return await handleApi(req, url);
        } catch (error) {
          if (error instanceof WorkbenchError) {
            return jsonResponse({ error: error.toJSON() }, httpStatusForError(error.code));
          }
          return jsonResponse(
            {
              error: {
                code: "execution_failed",
                message: error instanceof Error ? error.message : String(error),
              },
            },
            500,
          );
        }
      }

      const brandAsset = BRAND_ASSETS[url.pathname];
      if (brandAsset) {
        const method = req.method.toUpperCase();
        if (method !== "GET" && method !== "HEAD") {
          return new Response("Method Not Allowed", {
            status: 405,
            headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" },
          });
        }
        let body: ArrayBuffer;
        try {
          const file = fs.readFileSync(path.join(webDir, "brand", brandAsset.file));
          body = new ArrayBuffer(file.byteLength);
          new Uint8Array(body).set(file);
        } catch {
          return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
        }
        return new Response(method === "HEAD" ? null : body, {
          headers: {
            "Content-Type": brandAsset.contentType,
            "Content-Length": String(body.byteLength),
            "Cache-Control": "no-store",
          },
        });
      }

      if (isDevWeb) {
        cachedWeb = await buildWebBundle(webDir);
      }

      if (!cachedWeb) {
        return new Response(
          "<!doctype html><html><meta charset='utf-8'><title>Workbench</title><body><h1>Workbench Core Running</h1><p>Web UI assets not built yet.</p></body></html>",
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      }

      if (url.pathname === "/styles.css") {
        return new Response(cachedWeb.css, {
          headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      if (url.pathname === "/app.js") {
        return new Response(cachedWeb.js, {
          headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      return new Response(cachedWeb.html, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    },
    websocket: {
      open(ws) {
        if (ws.data.role === "ui") {
          uiSockets.add(ws);
          ws.send(JSON.stringify({ type: "bridge.status", bridge: bridgeStatus }));
        } else if (ws.data.role === "node" && ws.data.nodeId) {
          const cfg = readHubConfig();
          nodeRegistry.registerSocket(ws, {
            nodeId: ws.data.nodeId,
            name: ws.data.nodeMeta?.name ?? ws.data.nodeId,
            hostname: ws.data.nodeMeta?.hostname ?? ws.data.nodeId,
            platform: ws.data.nodeMeta?.platform ?? "linux",
            workbenchVersion: ws.data.nodeMeta?.workbenchVersion,
            routing: cfg.routing,
            outputLanguage: cfg.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE,
            giteeAccessToken: resolveEffectiveGiteeToken(cfg),
          });
          broadcastUi({ type: "hub.updated", reason: "node.connected", nodeId: ws.data.nodeId, at: Date.now() });
        } else {
          if (bridgeSocket && bridgeSocket !== ws) {
            try {
              bridgeSocket.close(1000, "replaced_by_newer_bridge");
            } catch {
              // Ignore close errors.
            }
          }
          bridgeSocket = ws;
        }
      },
      message(ws, message) {
        if (ws.data.role === "node" && ws.data.nodeId) {
          nodeRegistry.handleMessage(ws, ws.data.nodeId, Buffer.isBuffer(message) ? message : String(message), {
            onPainPoint: (nid, input) => {
              reportPainPoint({
                ...input,
                context: { ...(input.context ?? {}), nodeId: nid },
              });
              broadcastUi({ type: "hub.updated", reason: "evolution.reported", nodeId: nid, at: Date.now() });
            },
            onTelemetry: (_nid, outcome) => {
              recordModelRunOutcome(outcome);
              broadcastUi({ type: "hub.updated", reason: "telemetry.updated", at: Date.now() });
            },
            onEvent: (nid, evt) => {
              const cfg = readHubConfig();
              const rootStr = typeof evt.root === "string" ? evt.root : "";
              const projectId = rootStr ? findProjectId(cfg, nid, rootStr) : undefined;
              broadcastUi({
                ...evt,
                nodeId: nid,
                ...(projectId ? { projectId } : {}),
              });
            },
            onStatusChanged: () => {
              broadcastUi({ type: "hub.updated", reason: "node.updated", nodeId: ws.data.nodeId, at: Date.now() });
            },
          });
          return;
        }

        if (ws.data.role !== "bridge") return;
        let parsed: Record<string, unknown>;
        try {
          const text = typeof message === "string" ? message : Buffer.from(message).toString("utf8");
          const raw = JSON.parse(text) as unknown;
          if (!isRecord(raw)) return;
          parsed = raw;
        } catch {
          return;
        }

        if (parsed.type === "bridge.hello" || parsed.type === "bridge.status") {
          const nextState = parsed.state;
          const validState =
            nextState === "idle" || nextState === "working" || nextState === "waiting_user" ? nextState : "idle";
          bridgeStatus = {
            connected: true,
            agent: typeof parsed.agent === "string" ? parsed.agent : "omp",
            sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
            state: validState,
            model: typeof parsed.model === "string" ? parsed.model : null,
            updatedAt: Date.now(),
          };
          broadcastUi({ type: "bridge.status", bridge: bridgeStatus });
        } else if (parsed.type === "bridge.ack" && typeof parsed.dispatchId === "string") {
          const pending = pendingDispatches.get(parsed.dispatchId);
          if (pending) {
            clearTimeout(pending.timer);
            pendingDispatches.delete(parsed.dispatchId);
            const status =
              parsed.status === "submitted" || parsed.status === "prefilled" || parsed.status === "rejected"
                ? parsed.status
                : "rejected";
            pending.resolve({
              delivered: parsed.ok === true,
              status,
              reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
            });
          }
        }
      },
      close(ws) {
        if (ws.data.role === "ui") {
          uiSockets.delete(ws);
        } else if (ws.data.role === "node" && ws.data.nodeId) {
          nodeRegistry.handleClose(ws, ws.data.nodeId, {
            onStatusChanged: () => {
              broadcastUi({ type: "hub.updated", reason: "node.disconnected", nodeId: ws.data.nodeId, at: Date.now() });
            },
          });
        } else if (bridgeSocket === ws) {
          bridgeSocket = null;
          bridgeStatus = {
            connected: false,
            agent: null,
            sessionId: null,
            state: "offline",
            model: null,
            updatedAt: Date.now(),
          };
          for (const [dispatchId, pending] of pendingDispatches.entries()) {
            clearTimeout(pending.timer);
            pending.resolve({ delivered: false, status: "offline", reason: "bridge_disconnected" });
            pendingDispatches.delete(dispatchId);
          }
          broadcastUi({ type: "bridge.status", bridge: bridgeStatus });
        }
      },
    },
  });

  const actualPort = server.port ?? 0;
  const serverUrl = hubBindUrl(hostname, actualPort);
  const info: ServerRuntimeInfo = {
    pid: process.pid,
    port: actualPort,
    url: serverUrl,
    root: defaultRoot,
    startedAt: Date.now(),
  };
  if (options.writeDiscovery !== false) {
    writeServerDiscovery(info);
  }
  if (hubMode) {
    writeDaemonInfo({
      pid: process.pid,
      port: actualPort,
      hostname,
      url: serverUrl,
      startedAt: info.startedAt,
      version: packageInfo.version,
    });
  }

  return {
    port: actualPort,
    url: serverUrl,
    root: defaultRoot,
    getBridgeStatus: () => ({ ...bridgeStatus }),
    stop() {
      unsubExecutor();
      executor.stopAllRuns();
      nodeUpdates.stop();
      nodeRegistry.stopAll();
      for (const timer of watchDebounces.values()) clearTimeout(timer);
      watchDebounces.clear();
      for (const w of watchers.values()) w.close();
      watchers.clear();
      for (const pending of pendingDispatches.values()) {
        clearTimeout(pending.timer);
        pending.resolve({ delivered: false, status: "offline", reason: "server_stopped" });
      }
      pendingDispatches.clear();
      if (options.writeDiscovery !== false) {
        removeServerDiscovery(defaultRoot, process.pid);
      }
      if (hubMode) {
        removeDaemonInfo(process.pid);
      }
      void server.stop(true);
    },
  };
}
