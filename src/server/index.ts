import packageInfo from "../../package.json";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ServerWebSocket } from "bun";
import { stageUpload } from "../core/attachments.ts";
import { getProjectStatus, initProject, pruneProjectTraces } from "../core/engine.ts";
import { WorkbenchError } from "../core/errors.ts";
import { canonicalRoot } from "../core/fs.ts";
import type { GiteeApiDeps } from "../core/gitee.ts";
import type { GitHubCommandDeps } from "../core/github.ts";
import { DEFAULT_OUTPUT_LANGUAGE, normalizeOutputLanguage } from "../core/language.ts";
import { hubBindUrl } from "../core/net.ts";
import {
  AGENT_ACTIONS,
  MAX_ATTACHMENT_TOTAL_BYTES,
  WORKBENCH_DIR,
  type AgentAction,
  type AgentRunRecord,
  type PrivacyMode,
  type RequirementDetail,
  type RunBillingMode,
} from "../core/types.ts";
import { isRecord } from "../core/validate.ts";
import { HubExecutor } from "../hub/executor.ts";
import { appendRunLedger, queryHubInsights, type InsightsQueryFilter, type RunLedgerEntry } from "../hub/ledger.ts";
import { RemoteNodeRegistry } from "../hub/node_bridge.ts";
import { NodeUpdates } from "../hub/node_updates.ts";
import { enrichAgentRunRecord, QUOTA_POOL_LABELS } from "../hub/pricing.ts";
import {
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
  updateHubObservability,
  updateHubPreferences,
  updateHubProjectMeta,
  writeDaemonInfo,
} from "../hub/registry.ts";
import { buildInitialProjectRouting, normalizeRoutingConfig } from "../hub/routing.ts";
import { isSourceRevisionPublished, readSourceRevision } from "../core/revision.ts";
import { clearModelCooldown, readModelTelemetry, recordModelRunOutcome, summarizeTelemetry } from "../hub/telemetry.ts";
import {
  type HarnessInfo,
  type HubConfig,
  type HubObservabilityConfig,
  type ModelPriceOverride,
  type RemoteNodeInfo,
  type RoutingConfig,
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
  type LocalProjectSnapshot,
} from "./project_api.ts";
import { removeServerDiscovery, writeServerDiscovery, type ServerRuntimeInfo } from "./runtime.ts";

interface WsClientData {
  role: "ui" | "node";
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
  const buildCommit = readSourceRevision()?.slice(0, 12) ?? "";
  const buildTime = new Date().toISOString();
  const build = await Bun.build({
    entrypoints: [entryTs],
    target: "browser",
    format: "esm",
    minify: false,
    define: {
      __WORKBENCH_BUILD_COMMIT__: JSON.stringify(buildCommit),
      __WORKBENCH_BUILD_TIME__: JSON.stringify(buildTime),
    },
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
  const nodeRegistry = new RemoteNodeRegistry();
  const enrichLedgerEntry = (
    entry: RunLedgerEntry,
    nid: string,
    nodeNameHint?: string,
  ): RunLedgerEntry => {
    try {
      const cfg = readHubConfig();
      const targetNode = isLocalNodeId(nid) ? LOCAL_NODE_ID : nid;
      const proj = cfg.projects.find(
        (p) => (p.nodeId ?? LOCAL_NODE_ID) === targetNode && p.root === entry.projectRoot,
      );
      return {
        ...entry,
        nodeId: targetNode,
        nodeName:
          nodeNameHint ??
          (isLocalNodeId(targetNode)
            ? os.hostname()
            : nodeRegistry.getNode(targetNode)?.name ?? proj?.nodeName ?? targetNode),
        ...(proj ? { projectId: proj.id, projectName: proj.name } : {}),
      };
    } catch {
      return entry;
    }
  };
  const executor =
    options.executor ??
    new HubExecutor({
      getHubPreferences: () => {
        const cfg = readHubConfig();
        return {
          outputLanguage: cfg.outputLanguage,
          observability: cfg.observability,
        };
      },
      onLedgerEntry: (entry) => {
        appendRunLedger(enrichLedgerEntry(entry, LOCAL_NODE_ID, os.hostname()));
      },
    });
  const serverStartedAt = Date.now();
  const revision = readSourceRevision();

  if (hubMode && isAutoRegistrableProjectRoot(defaultRoot)) {
    registerHubProject(defaultRoot, { activate: false });
  }

  const recoveryRoots = hubMode
    ? [defaultRoot, ...readHubConfig().projects.filter((p) => isLocalNodeId(p.nodeId)).map((p) => p.root)]
    : [defaultRoot];
  await executor.recoverOrphanedRuns(recoveryRoots).catch((err) => {
    console.error(`[workbench] orphan run recovery warning: ${err instanceof Error ? err.message : String(err)}`);
  });

  const uiSockets = new Set<ServerWebSocket<WsClientData>>();
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
            routing: snap.routing ?? null,
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
          routing: snap?.routing ?? null,
        };
      }),
    );
    return { cfg, projects };
  };

  const buildAllNodesList = (cfg: HubConfig, localHarnesses: HarnessInfo[]): RemoteNodeInfo[] => {
    const enrichRuns = (
      runs: Array<AgentRunRecord & { requirementId: string; root?: string; projectId?: string }>,
      nid: string,
      harnesses: HarnessInfo[],
    ) =>
      runs.map((r) => ({
        ...enrichAgentRunRecord(r, undefined, { harnesses, observability: cfg.observability }),
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
      activeRuns: enrichRuns(executor.getActiveRuns(), LOCAL_NODE_ID, localHarnesses),
      workbenchVersion: packageInfo.version,
      revision,
    };

    const connected = nodeRegistry.listConnectedNodes().map((n) => ({
      ...n,
      activeRuns: enrichRuns(n.activeRuns, n.nodeId, n.harnesses),
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

  const handleProjectApi = createProjectApiHandler({
    executor,
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
      if (isSourceRevisionPublished(revision) === false) {
        throw new WorkbenchError(
          "revision_conflict",
          `Hub commit ${revision.slice(0, 7)} has not been pushed to origin yet; run git push first`,
        );
      }
      return jsonResponse(await nodeUpdates.start(updateNode[1], revision), 202);
    }
    if (method === "GET" && pathname === "/api/hub/state") {
      const [{ cfg, projects }, localHarnesses] = await Promise.all([
        buildHubProjectsSnapshot(),
        executor.getHarnesses(false, false),
      ]);
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
      let activeRouting: RoutingConfig | null = null;
      if (hubMode) {
        activeRouting = activeProj?.routing ?? null;
      } else {
        try {
          const localStatus = getProjectStatus(defaultRoot);
          if (localStatus.initialized && localStatus.project?.routing) {
            activeRouting = normalizeRoutingConfig(localStatus.project.routing);
          }
        } catch {
          activeRouting = null;
        }
      }

      const effectiveGiteeToken = resolveEffectiveGiteeToken(cfg);
      return jsonResponse({
        hubMode,
        activeProjectId: activeId,
        activeNodeId,
        projects: hubMode ? projects : [],
        nodes,
        harnesses: effectiveHarnesses,
        routing: activeRouting,
        outputLanguage: cfg.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE,
        giteeTokenConfigured: Boolean(effectiveGiteeToken),
        giteeTokenMasked: maskAccessToken(effectiveGiteeToken),
        activeRuns,
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
      nodeRegistry.broadcastConfigSync(cfg.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE, effectiveToken, cfg.observability);
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
        const harnesses = await executor.getHarnesses(false);
        await initProject(project.root, {
          name: project.name,
          privacyMode: initPrivacy,
          routing: buildInitialProjectRouting(harnesses),
        });
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
      broadcastUi({ type: "hub.updated", reason: "project.activated", projectId: project.id, at: project.lastOpenedAt });
      if (url.searchParams.get("summary") === "0") {
        return jsonResponse({ project, activeProjectId: project.id });
      }
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

    if (method === "POST" && pathname === "/api/hub/telemetry/clear-cooldown") {
      const body = await readBody(req);
      const harness = typeof body.harness === "string" ? body.harness : undefined;
      const model = typeof body.model === "string" ? body.model : undefined;
      clearModelCooldown(harness, model);
      broadcastUi({ type: "hub.updated", reason: "telemetry.cleared", at: Date.now() });
      return jsonResponse({ telemetry: summarizeTelemetry() });
    }

    if (method === "GET" && pathname === "/api/hub/insights") {
      const daysRaw = url.searchParams.get("days");
      const parsedDays = daysRaw !== null ? Number(daysRaw) : 7;
      const days = parsedDays === 0 ? 0 : parsedDays === 30 ? 30 : 7;
      const projectIdParam = url.searchParams.get("projectId")?.trim() || undefined;
      const nodeIdParam = url.searchParams.get("nodeId")?.trim() || undefined;
      const quotaPoolParam = url.searchParams.get("quotaPool")?.trim() || undefined;
      const harnessParam = url.searchParams.get("harness")?.trim() || undefined;
      const actionRaw = url.searchParams.get("action")?.trim() || undefined;
      const actionParam =
        actionRaw && (AGENT_ACTIONS as readonly string[]).includes(actionRaw)
          ? (actionRaw as AgentAction)
          : undefined;
      const billingRaw = url.searchParams.get("billingMode")?.trim() || undefined;
      const billingModeParam =
        billingRaw === "subscription" || billingRaw === "api" || billingRaw === "free"
          ? (billingRaw as RunBillingMode)
          : undefined;
      const statusRaw = url.searchParams.get("status")?.trim() || undefined;
      const statusParam =
        statusRaw === "running" || statusRaw === "succeeded" || statusRaw === "failed" || statusRaw === "cancelled"
          ? (statusRaw as AgentRunRecord["status"])
          : undefined;

      const filter: InsightsQueryFilter = {
        days,
        ...(projectIdParam ? { projectId: projectIdParam } : {}),
        ...(nodeIdParam ? { nodeId: nodeIdParam } : {}),
        ...(quotaPoolParam ? { quotaPool: quotaPoolParam } : {}),
        ...(harnessParam ? { harness: harnessParam } : {}),
        ...(actionParam ? { action: actionParam } : {}),
        ...(billingModeParam ? { billingMode: billingModeParam } : {}),
        ...(statusParam ? { status: statusParam } : {}),
      };
      const cfg = readHubConfig();
      const telemetry = readModelTelemetry();
      return jsonResponse(
        queryHubInsights(filter, {
          cooldowns: telemetry.cooldowns,
          projects: cfg.projects,
        }),
      );
    }

    if (method === "GET" && pathname === "/api/hub/insights/pricing") {
      const cfg = readHubConfig();
      return jsonResponse({
        observability: cfg.observability ?? {},
        quotaPoolLabels: QUOTA_POOL_LABELS,
      });
    }

    if (method === "PUT" && pathname === "/api/hub/insights/pricing") {
      const body = await readBody(req);
      const patch: HubObservabilityConfig = {};
      if (typeof body.traceRetentionDays === "number" && Number.isFinite(body.traceRetentionDays)) {
        patch.traceRetentionDays = body.traceRetentionDays;
      }
      if (body.billingOverrides && isRecord(body.billingOverrides)) {
        patch.billingOverrides = body.billingOverrides as Record<string, RunBillingMode>;
      }
      if (body.pricingOverrides && isRecord(body.pricingOverrides)) {
        patch.pricingOverrides = body.pricingOverrides as Record<string, ModelPriceOverride>;
      }
      const cfg = updateHubObservability(patch);
      nodeRegistry.broadcastConfigSync(
        cfg.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE,
        resolveEffectiveGiteeToken(cfg),
        cfg.observability,
      );
      broadcastUi({ type: "hub.updated", reason: "observability.updated", at: Date.now() });
      return jsonResponse({ observability: cfg.observability ?? {} });
    }

    if (method === "POST" && pathname === "/api/hub/insights/prune") {
      const body = await readBody(req);
      const cfg = readHubConfig();
      const retentionDays =
        typeof body.retentionDays === "number" && Number.isFinite(body.retentionDays)
          ? Math.max(0, Math.floor(body.retentionDays))
          : (cfg.observability?.traceRetentionDays ?? 30);
      const roots = new Set<string>();
      for (const p of cfg.projects) {
        if (isLocalNodeId(p.nodeId)) roots.add(p.root);
      }
      if (!hubMode && fs.existsSync(path.join(defaultRoot, WORKBENCH_DIR))) {
        roots.add(defaultRoot);
      }
      let deletedFiles = 0;
      let freedBytes = 0;
      let scannedRuns = 0;
      let projectsPruned = 0;
      for (const r of roots) {
        if (!fs.existsSync(path.join(r, WORKBENCH_DIR))) continue;
        const activeRunIds = new Set(executor.getActiveRuns(r).map((run) => run.id));
        const res = pruneProjectTraces(r, retentionDays, activeRunIds);
        deletedFiles += res.deletedFiles;
        freedBytes += res.freedBytes;
        scannedRuns += res.scannedRuns;
        projectsPruned += 1;
      }
      broadcastUi({ type: "hub.updated", reason: "observability.pruned", at: Date.now() });
      return jsonResponse({ deletedFiles, freedBytes, scannedRuns, projectsPruned, retentionDays });
    }

    if (method === "POST" && pathname === "/api/hub/reload-web") {
      const res = await reloadWebBundle({ manual: true });
      return jsonResponse({ ok: true, ...res });
    }

    // --- Project-Scoped Routes (?project=<id> or default) ---
    const target = resolveRequestTarget(req, url)!;
    if (!isLocalNodeId(target.nodeId)) {
      const cfg = readHubConfig();
      const giteeToken = resolveEffectiveGiteeToken(cfg);
      const outputLanguage = cfg.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE;
      const res = await nodeRegistry.forwardProjectHttp(
        target.nodeId,
        target.root,
        req,
        url,
        outputLanguage,
        giteeToken,
        cfg.observability,
      );
      if (method !== "GET") return res;

      const reqMatch = /^\/api\/requirements\/(REQ-\d{3,})(?:\/(.*))?$/.exec(pathname);
      if (!reqMatch) return res;
      const reqId = reqMatch[1]!;
      const sub = reqMatch[2] ?? "";
      const remoteNode = nodeRegistry.listConnectedNodes().find((n) => n.nodeId === target.nodeId);
      const remoteHarnesses = remoteNode?.harnesses ?? [];
      const activeForReq = (remoteNode?.activeRuns ?? []).filter(
        (r) => r.requirementId === reqId && (!r.root || r.root === target.root),
      );

      const fetchRemoteJson = async (remotePath: string): Promise<Record<string, unknown> | null> => {
        try {
          const rpcRes = await nodeRegistry.rpc(
            target.nodeId,
            {
              kind: "project_http",
              method: "GET",
              pathname: remotePath,
              search: "",
              projectRoot: target.root,
              outputLanguage,
              ...(giteeToken !== undefined ? { giteeAccessToken: giteeToken } : {}),
              ...(cfg.observability !== undefined ? { observability: cfg.observability } : {}),
            },
            15_000,
          );
          if (rpcRes.status >= 200 && rpcRes.status < 300 && isRecord(rpcRes.bodyJson)) {
            return rpcRes.bodyJson as Record<string, unknown>;
          }
        } catch {
          // Best-effort remote fallback for older nodes.
        }
        return null;
      };

      const enrichRemoteRuns = async (runs: AgentRunRecord[]): Promise<AgentRunRecord[]> => {
        const mergedMap = new Map<string, AgentRunRecord>();
        for (const r of runs) mergedMap.set(r.id, r);
        for (const active of activeForReq) {
          const existing = mergedMap.get(active.id);
          mergedMap.set(active.id, existing ? { ...existing, ...active } : active);
        }
        const merged = Array.from(mergedMap.values()).sort(
          (a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id),
        );
        // Fetch raw logs only for the most recent runs missing structured usage (running first, up to 8 runs).
        const needLog = merged
          .filter((r) => !r.usage)
          .sort((a, b) => (a.status === "running" ? -1 : 1) - (b.status === "running" ? -1 : 1) || b.startedAt - a.startedAt)
          .slice(0, 8);
        const logMap = new Map<string, string>();
        await Promise.all(
          needLog.map(async (r) => {
            const detail = await fetchRemoteJson(`/api/requirements/${reqId}/runs/${encodeURIComponent(r.id)}`);
            if (detail && typeof detail.log === "string") {
              logMap.set(r.id, detail.log);
            }
          }),
        );
        return merged.map((r) =>
          enrichAgentRunRecord(r, logMap.get(r.id), {
            harnesses: remoteHarnesses,
            observability: cfg.observability,
          }),
        );
      };

      if (sub === "" && res.ok) {
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (body && isRecord(body.detail) && isRecord((body.detail as { state?: unknown }).state)) {
          const detailObj = body.detail as unknown as RequirementDetail;
          const enrichedRuns = await enrichRemoteRuns(detailObj.state.agentRuns ?? []);
          return jsonResponse({
            ...body,
            detail: {
              ...detailObj,
              state: {
                ...detailObj.state,
                agentRuns: enrichedRuns,
              },
            },
          });
        }
        return jsonResponse(body ?? {});
      }

      if (sub === "runs") {
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as { runs?: AgentRunRecord[] } | null;
          const runs = Array.isArray(body?.runs) ? body.runs : [];
          return jsonResponse({ runs: await enrichRemoteRuns(runs) });
        }
        if (res.status === 404) {
          const detailBody = await fetchRemoteJson(`/api/requirements/${reqId}`);
          const detailObj =
            detailBody && isRecord(detailBody.detail) ? (detailBody.detail as unknown as RequirementDetail) : null;
          const baseRuns = Array.isArray(detailObj?.state?.agentRuns) ? detailObj.state.agentRuns : [];
          return jsonResponse({ runs: await enrichRemoteRuns(baseRuns) });
        }
      }

      const traceMatch = /^runs\/([^/]+)\/trace$/.exec(sub);
      if (traceMatch) {
        const runId = decodeURIComponent(traceMatch[1]!);
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
          if (body && isRecord(body.record)) {
            const rec = body.record as unknown as AgentRunRecord;
            const log = !rec.usage
              ? ((await fetchRemoteJson(`/api/requirements/${reqId}/runs/${encodeURIComponent(runId)}`))?.log as
                  | string
                  | undefined)
              : undefined;
            return jsonResponse({
              ...body,
              record: enrichAgentRunRecord(rec, log, { harnesses: remoteHarnesses, observability: cfg.observability }),
            });
          }
          return jsonResponse(body ?? {});
        }
        if (res.status === 404) {
          const detailBody = await fetchRemoteJson(`/api/requirements/${reqId}`);
          const detailObj =
            detailBody && isRecord(detailBody.detail) ? (detailBody.detail as unknown as RequirementDetail) : null;
          const baseRun =
            detailObj?.state?.agentRuns?.find((r) => r.id === runId) ??
            activeForReq.find((r) => r.id === runId) ??
            null;
          const runDetail = await fetchRemoteJson(`/api/requirements/${reqId}/runs/${encodeURIComponent(runId)}`);
          const log = typeof runDetail?.log === "string" ? runDetail.log : undefined;
          const rawRecord = (baseRun ?? (isRecord(runDetail?.record) ? (runDetail.record as unknown as AgentRunRecord) : null));
          const record = rawRecord
            ? enrichAgentRunRecord(rawRecord, log, { harnesses: remoteHarnesses, observability: cfg.observability })
            : null;
          return jsonResponse({
            runId,
            live: record?.status === "running",
            hasTrace: false,
            record,
            events: [],
            nextSeq: 0,
            totalEvents: 0,
            hasMore: false,
          });
        }
      }

      const contextMatch = /^runs\/([^/]+)\/context$/.exec(sub);
      if (contextMatch && res.status === 404) {
        const runId = decodeURIComponent(contextMatch[1]!);
        return jsonResponse({ runId, hasContext: false, context: null });
      }

      const runDetailMatch = /^runs\/([^/]+)$/.exec(sub);
      if (runDetailMatch && res.ok) {
        const body = (await res.json().catch(() => null)) as { record?: AgentRunRecord; log?: string } | null;
        if (body && isRecord(body.record)) {
          return jsonResponse({
            record: enrichAgentRunRecord(body.record, body.record.usage ? undefined : body.log, {
              harnesses: remoteHarnesses,
              observability: cfg.observability,
            }),
            log: body.log ?? "",
          });
        }
        return jsonResponse(body ?? {});
      }

      return res;
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
        const role = roleParam === "node" ? "node" : "ui";
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
        } else if (ws.data.role === "node" && ws.data.nodeId) {
          const cfg = readHubConfig();
          nodeRegistry.registerSocket(ws, {
            nodeId: ws.data.nodeId,
            name: ws.data.nodeMeta?.name ?? ws.data.nodeId,
            hostname: ws.data.nodeMeta?.hostname ?? ws.data.nodeId,
            platform: ws.data.nodeMeta?.platform ?? "linux",
            workbenchVersion: ws.data.nodeMeta?.workbenchVersion,
            outputLanguage: cfg.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE,
            giteeAccessToken: resolveEffectiveGiteeToken(cfg),
            observability: cfg.observability,
          });
          broadcastUi({ type: "hub.updated", reason: "node.connected", nodeId: ws.data.nodeId, at: Date.now() });
        }
      },
      message(ws, message) {
        if (ws.data.role === "node" && ws.data.nodeId) {
          nodeRegistry.handleMessage(ws, ws.data.nodeId, Buffer.isBuffer(message) ? message : String(message), {
            onTelemetry: (_nid, outcome) => {
              recordModelRunOutcome(outcome);
              broadcastUi({ type: "hub.updated", reason: "telemetry.updated", at: Date.now() });
            },
            onLedgerEntry: (nid, nodeName, entry) => {
              appendRunLedger(enrichLedgerEntry(entry, nid, nodeName));
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
    const managedService = Boolean(process.env.INVOCATION_ID || process.env.XPC_SERVICE_NAME);
    writeDaemonInfo({
      pid: process.pid,
      port: actualPort,
      hostname,
      url: serverUrl,
      startedAt: info.startedAt,
      version: packageInfo.version,
      ...(managedService ? { managedService: true } : {}),
    });
  }

  return {
    port: actualPort,
    url: serverUrl,
    root: defaultRoot,
    stop() {
      unsubExecutor();
      executor.stopAllRuns();
      nodeUpdates.stop();
      nodeRegistry.stopAll();
      for (const timer of watchDebounces.values()) clearTimeout(timer);
      watchDebounces.clear();
      for (const w of watchers.values()) w.close();
      watchers.clear();
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
