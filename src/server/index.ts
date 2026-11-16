import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ServerWebSocket } from "bun";
import {
  acceptRequirement,
  addDiscussion,
  approveDesign,
  authorizeFastTrack,
  blockRequirement,
  cancelRequirement,
  createRequirement,
  getAgentRunDetail,
  getDesignHistoryVersion,
  getProjectStatus,
  getRequirement,
  getVerificationEvidence,
  initProject,
  listRequirements,
  markDesigning,
  reopenRequirement,
  requestChanges,
  resolveDiscussions,
  unblockRequirement,
  updateDesign,
  updateSpec,
} from "../core/engine.ts";
import { WorkbenchError, type WorkbenchErrorCode } from "../core/errors.ts";
import { canonicalRoot } from "../core/fs.ts";
import { observeGitChanges, observeGitSnapshot } from "../core/git.ts";
import { runAllVerifications, runVerification } from "../core/runner.ts";
import { AGENT_ACTIONS, WORKBENCH_DIR, type AgentAction, type CriterionInput, type PrivacyMode, type Stage, type Track } from "../core/types.ts";
import { isRecord } from "../core/validate.ts";
import { HubExecutor } from "../hub/executor.ts";
import { synthesizeHandoffPacket } from "../hub/handoff.ts";
import {
  addCustomModel,
  applyHubRoutingPreset,
  browseDirectory,
  readHubConfig,
  registerHubProject,
  removeDaemonInfo,
  removeHubProject,
  setActiveHubProject,
  updateHubRouting,
  writeDaemonInfo,
} from "../hub/registry.ts";
import { ROUTING_PRESETS, type RoutingConfig, type RoutingPreset } from "../hub/types.ts";
import { buildAgentPrompt, type DispatchAction } from "./prompts.ts";
import { removeServerDiscovery, writeServerDiscovery, type ServerRuntimeInfo } from "./runtime.ts";

export interface BridgeStatus {
  connected: boolean;
  agent: string | null;
  sessionId: string | null;
  state: "idle" | "working" | "waiting_user" | "offline";
  model: string | null;
  updatedAt: number;
}

export interface DispatchOutcome {
  delivered: boolean;
  status: "submitted" | "prefilled" | "rejected" | "offline";
  reason?: string;
  prompt: string;
}

interface WsClientData {
  role: "ui" | "bridge";
  id: string;
}

export interface WorkbenchServerHandle {
  port: number;
  url: string;
  root: string;
  stop(): void;
  getBridgeStatus(): BridgeStatus;
}

function httpStatusForError(code: WorkbenchErrorCode): number {
  switch (code) {
    case "not_initialized":
    case "invalid_input":
    case "invalid_path":
    case "symlink_not_allowed":
      return 400;
    case "not_found":
      return 404;
    case "already_initialized":
    case "revision_conflict":
    case "invalid_transition":
    case "approval_required":
    case "acceptance_gate_failed":
    case "lock_timeout":
      return 409;
    case "corrupt_record":
    case "unsupported_schema":
    case "execution_failed":
      return 500;
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  let text = "";
  try {
    text = await req.text();
  } catch {
    throw new WorkbenchError("invalid_input", "无法读取请求体");
  }
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WorkbenchError("invalid_input", "请求体必须是合法 JSON");
  }
  if (!isRecord(parsed)) {
    throw new WorkbenchError("invalid_input", "请求体必须是 JSON 对象");
  }
  return parsed;
}

async function buildWebBundle(webDir: string): Promise<{ html: string; css: string; js: string } | null> {
  const htmlPath = path.join(webDir, "index.html");
  const cssPath = path.join(webDir, "styles.css");
  const entryTsx = path.join(webDir, "app.tsx");
  const entryTs = fs.existsSync(entryTsx) ? entryTsx : path.join(webDir, "app.ts");
  if (!fs.existsSync(htmlPath) || !fs.existsSync(entryTs)) return null;

  const html = fs.readFileSync(htmlPath, "utf8");
  const css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, "utf8") : "";
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
}): Promise<WorkbenchServerHandle> {
  const defaultRoot = canonicalRoot(options.root);
  const hubMode = options.hubMode === true;
  const hostname = options.hostname ?? "127.0.0.1";
  const webDir = options.webDir ?? path.resolve(import.meta.dir, "../web");
  let cachedWeb = await buildWebBundle(webDir);
  const isDevWeb = process.env.WORKBENCH_DEV_WEB === "1";
  const executor = options.executor ?? new HubExecutor();

  if (hubMode && (fs.existsSync(path.join(defaultRoot, ".git")) || fs.existsSync(path.join(defaultRoot, WORKBENCH_DIR, "project.json")))) {
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

  const unsubExecutor = executor.subscribe((ev) => {
    broadcastUi(ev as unknown as Record<string, unknown>);
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
            broadcastUi({ type: "workbench.updated", reason: "fs", root: projectRoot, at: Date.now() });
          }, 60),
        );
      });
      watchers.set(projectRoot, w);
    } catch {
      // Ignore watch errors on unsupported filesystems; API broadcasts still run.
    }
  };

  const syncAllWatchers = () => {
    ensureWatcherFor(defaultRoot);
    if (hubMode) {
      const cfg = readHubConfig();
      for (const p of cfg.projects) {
        ensureWatcherFor(p.root);
      }
    }
  };

  syncAllWatchers();

  const resolveRequestRoot = (req: Request, url: URL): string => {
    const param = url.searchParams.get("project") ?? req.headers.get("x-workbench-project");
    if (param) {
      const cfg = readHubConfig();
      const byId = cfg.projects.find((p) => p.id === param);
      if (byId) return byId.root;
      // Allow single-project root match
      if (param === "default") return defaultRoot;
      throw new WorkbenchError("not_found", `未找到目标项目: ${param}`);
    }
    if (hubMode) {
      const cfg = readHubConfig();
      const active = cfg.projects.find((p) => p.id === cfg.activeProjectId) ?? cfg.projects[0];
      if (active) return active.root;
    }
    return defaultRoot;
  };

  const buildHubProjectsSnapshot = async () => {
    const cfg = readHubConfig();
    const rawList =
      hubMode && cfg.projects.length > 0
        ? cfg.projects
        : [
            {
              id: "default",
              name: path.basename(defaultRoot) || "workbench",
              root: defaultRoot,
              addedAt: Date.now(),
              lastOpenedAt: Date.now(),
            },
          ];
    const projects = await Promise.all(
      rawList.map(async (entry) => {
        const status = getProjectStatus(entry.root);
        const isGitRepo = fs.existsSync(path.join(entry.root, ".git"));
        let activeCount = 0;
        let decisionCount = 0;
        if (status.initialized) {
          try {
            const snap = await observeGitSnapshot(entry.root);
            const items = listRequirements(entry.root, { scope: "active", currentCodeSnapshotHash: snap?.fingerprint ?? null });
            activeCount = items.length;
            decisionCount = items.filter((i) => i.needsDecision).length;
          } catch {
            // Keep resilient if a project is mid-migration.
          }
        }
        const runningCount = executor.getActiveRuns(entry.root).length;
        return {
          ...entry,
          initialized: status.initialized,
          isGitRepo,
          activeCount,
          decisionCount,
          runningCount,
        };
      }),
    );
    return { cfg, projects };
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

  const handleApi = async (req: Request, url: URL): Promise<Response> => {
    const pathname = url.pathname;
    const method = req.method.toUpperCase();

    if (method === "GET" && pathname === "/api/health") {
      return jsonResponse({ ok: true, root: defaultRoot, serverPid: process.pid, hubMode });
    }

    // --- Hub & Global Discovery/Routing Routes ---
    if (method === "GET" && pathname === "/api/hub/state") {
      const [{ cfg, projects }, harnesses] = await Promise.all([buildHubProjectsSnapshot(), executor.getHarnesses(false, !hubMode)]);
      return jsonResponse({
        hubMode,
        activeProjectId: hubMode ? (cfg.activeProjectId ?? projects[0]?.id ?? null) : null,
        projects: hubMode ? projects : [],
        harnesses,
        routing: cfg.routing,
        customModels: cfg.customModels,
        activeRuns: executor.getActiveRuns(),
      });
    }

    if (method === "POST" && pathname === "/api/hub/projects") {
      const body = await readBody(req);
      const rawRoot = typeof body.root === "string" ? body.root : "";
      const { project } = registerHubProject(rawRoot, {
        name: typeof body.name === "string" ? body.name : undefined,
        activate: body.activate !== false,
      });
      if ((body.initPrivacy === "local" || body.initPrivacy === "tracked") && !getProjectStatus(project.root).initialized) {
        await initProject(project.root, { name: project.name, privacyMode: body.initPrivacy });
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
      ensureWatcherFor(project.root);
      broadcastUi({ type: "hub.updated", reason: "project.activated", projectId: project.id, at: Date.now() });
      const { cfg, projects } = await buildHubProjectsSnapshot();
      return jsonResponse({ project, activeProjectId: cfg.activeProjectId, projects });
    }

    const hubDeleteMatch = /^\/api\/hub\/projects\/([^/]+)$/.exec(pathname);
    if (method === "DELETE" && hubDeleteMatch) {
      const projectId = decodeURIComponent(hubDeleteMatch[1]!);
      const cfg = removeHubProject(projectId);
      broadcastUi({ type: "hub.updated", reason: "project.removed", projectId, at: Date.now() });
      return jsonResponse({ activeProjectId: cfg.activeProjectId, projects: (await buildHubProjectsSnapshot()).projects });
    }

    if (method === "GET" && pathname === "/api/fs/browse") {
      const target = url.searchParams.get("path") ?? undefined;
      return jsonResponse(browseDirectory(target));
    }

    if (method === "GET" && pathname === "/api/hub/harnesses") {
      const harnesses = await executor.getHarnesses(false);
      return jsonResponse({ harnesses });
    }

    if (method === "POST" && pathname === "/api/hub/harnesses/refresh") {
      const harnesses = await executor.getHarnesses(true);
      return jsonResponse({ harnesses });
    }

    if (method === "GET" && pathname === "/api/hub/routing") {
      const cfg = readHubConfig();
      return jsonResponse({ routing: cfg.routing, customModels: cfg.customModels });
    }

    if (method === "PUT" && pathname === "/api/hub/routing") {
      const body = await readBody(req);
      const cfg = updateHubRouting(body as unknown as RoutingConfig);
      broadcastUi({ type: "hub.updated", reason: "routing.updated", at: Date.now() });
      return jsonResponse({ routing: cfg.routing, customModels: cfg.customModels });
    }

    if (method === "POST" && pathname === "/api/hub/routing/preset") {
      const body = await readBody(req);
      const preset = typeof body.preset === "string" ? body.preset : "";
      if (!(ROUTING_PRESETS as readonly string[]).includes(preset)) {
        throw new WorkbenchError("invalid_input", `无效的路由预设: ${preset}`);
      }
      const cfg = applyHubRoutingPreset(preset as RoutingPreset);
      broadcastUi({ type: "hub.updated", reason: "routing.preset", preset, at: Date.now() });
      return jsonResponse({ routing: cfg.routing, customModels: cfg.customModels });
    }

    if (method === "POST" && pathname === "/api/hub/models/custom") {
      const body = await readBody(req);
      const harness = typeof body.harness === "string" ? body.harness : "";
      const model = typeof body.model === "string" ? body.model : "";
      const cfg = addCustomModel(harness, model);
      const harnesses = executor.syncCustomModels(cfg.customModels);
      return jsonResponse({ customModels: cfg.customModels, harnesses });
    }

    // --- Project-Scoped Routes (?project=<id> or default) ---
    const base = resolveRequestRoot(req, url);

    if (method === "GET" && pathname === "/api/project") {
      const status = getProjectStatus(base);
      const git = await observeGitSnapshot(base);
      return jsonResponse({
        ...status,
        root: base,
        bridge: bridgeStatus,
        git: git ? { isGitRepo: true, head: git.head, dirty: git.dirty, fingerprint: git.fingerprint } : { isGitRepo: false },
      });
    }

    if (method === "POST" && pathname === "/api/project/init") {
      const body = await readBody(req);
      const project = await initProject(base, {
        name: typeof body.name === "string" ? body.name : undefined,
        privacyMode: body.privacyMode === "tracked" ? "tracked" : "local",
      });
      ensureWatcherFor(base);
      broadcastUi({ type: "workbench.updated", reason: "project.init", root: base, at: Date.now() });
      return jsonResponse({ initialized: true, project }, 201);
    }

    if (method === "GET" && pathname === "/api/requirements") {
      const scope = (url.searchParams.get("scope") ?? "active") as "active" | "done" | "cancelled" | "all";
      const stageParam = url.searchParams.get("stage");
      const snapshot = await observeGitSnapshot(base);
      const items = listRequirements(base, {
        scope,
        stage: stageParam ? (stageParam as Stage) : undefined,
        currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
      });
      return jsonResponse({
        items,
        codeSnapshotHash: snapshot?.fingerprint ?? null,
        bridge: bridgeStatus,
      });
    }

    if (method === "POST" && pathname === "/api/requirements") {
      const body = await readBody(req);
      const goal = typeof body.goal === "string" ? body.goal : "";
      const title = typeof body.title === "string" ? body.title : undefined;
      const track: Track = body.track === "fast_track" ? "fast_track" : "plan_first";
      const snapshot = await observeGitSnapshot(base);
      let detail = await createRequirement(base, {
        goal,
        title,
        criteria: Array.isArray(body.criteria) ? (body.criteria as CriterionInput[]) : undefined,
        track,
        currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
      });

      let dispatch: DispatchOutcome | null = null;
      if (body.dispatchAgent === true) {
        detail = await markDesigning(base, detail.state.id, {
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        const prompt = buildAgentPrompt(detail, "design");
        dispatch = await dispatchToBridge(detail.state.id, "design", "send", prompt);
      }

      broadcastUi({ type: "workbench.updated", reason: "requirement.created", id: detail.state.id, at: Date.now() });
      return jsonResponse({ detail, dispatch }, 201);
    }

    // Routes matching /api/requirements/:id[/...]
    const reqMatch = /^\/api\/requirements\/(REQ-\d{3,})(?:\/(.*))?$/.exec(pathname);
    if (reqMatch) {
      const id = reqMatch[1]!;
      const sub = reqMatch[2] ?? "";

      if (method === "GET" && sub === "") {
        const snapshot = await observeGitSnapshot(base);
        const detail = getRequirement(base, id, { currentCodeSnapshotHash: snapshot?.fingerprint ?? null });
        return jsonResponse({ detail, bridge: bridgeStatus, codeSnapshotHash: snapshot?.fingerprint ?? null });
      }

      if (method === "GET" && sub === "diff") {
        const detail = getRequirement(base, id);
        const changes = await observeGitChanges(base, { sinceHead: detail.state.baseline?.head ?? null });
        return jsonResponse({ changes });
      }

      const histMatch = /^history\/(\d+)$/.exec(sub);
      if (method === "GET" && histMatch) {
        const version = Number(histMatch[1]);
        const markdown = getDesignHistoryVersion(base, id, version);
        return jsonResponse({ version, markdown });
      }

      const evMatch = /^evidence\/([^/]+)$/.exec(sub);
      if (method === "GET" && evMatch) {
        const evidence = getVerificationEvidence(base, id, decodeURIComponent(evMatch[1]!));
        return jsonResponse(evidence);
      }

      if (method === "PATCH" && sub === "spec") {
        const body = await readBody(req);
        const snapshot = await observeGitSnapshot(base);
        const detail = await updateSpec(base, id, {
          title: typeof body.title === "string" ? body.title : undefined,
          specMarkdown: typeof body.specMarkdown === "string" ? body.specMarkdown : undefined,
          criteria: Array.isArray(body.criteria) ? (body.criteria as CriterionInput[]) : undefined,
          expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        broadcastUi({ type: "workbench.updated", reason: "spec.updated", root: base, id, at: Date.now() });
        return jsonResponse({ detail });
      }

      if (method === "PATCH" && sub === "design") {
        const body = await readBody(req);
        const snapshot = await observeGitSnapshot(base);
        const detail = await updateDesign(base, id, {
          designMarkdown: typeof body.designMarkdown === "string" ? body.designMarkdown : "",
          expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
          actor: "human",
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        broadcastUi({ type: "workbench.updated", reason: "design.updated", root: base, id, at: Date.now() });
        return jsonResponse({ detail });
      }

      if (method === "GET" && sub === "handoff") {
        const synthesized = await synthesizeHandoffPacket(base, id, { action: "implement" });
        return jsonResponse({ markdown: synthesized.markdown, detail: synthesized.detail });
      }

      if (method === "POST" && sub === "discussions") {
        const body = await readBody(req);
        const snapshot = await observeGitSnapshot(base);
        const res = await addDiscussion(base, id, {
          actor: "human",
          mode: body.mode === "refine" ? "refine" : "ask",
          anchor: typeof body.anchor === "string" ? body.anchor : undefined,
          message: typeof body.message === "string" ? body.message : "",
          resolved: typeof body.resolved === "boolean" ? body.resolved : undefined,
          expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        broadcastUi({ type: "workbench.updated", reason: "discussion.added", root: base, id, at: Date.now() });
        return jsonResponse(res, 201);
      }

      if (method === "POST" && sub === "discussions/resolve") {
        const body = await readBody(req);
        const snapshot = await observeGitSnapshot(base);
        const detail = await resolveDiscussions(base, id, {
          ids: Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : undefined,
          resolved: typeof body.resolved === "boolean" ? body.resolved : true,
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        broadcastUi({ type: "workbench.updated", reason: "discussion.resolved", root: base, id, at: Date.now() });
        return jsonResponse({ detail });
      }

      if (method === "POST" && sub === "run") {
        const body = await readBody(req);
        const action = typeof body.action === "string" && (AGENT_ACTIONS as readonly string[]).includes(body.action)
          ? (body.action as AgentAction)
          : "design";
        const started = await executor.startRun({
          root: base,
          requirementId: id,
          action,
          harness: typeof body.harness === "string" ? body.harness : undefined,
          model: typeof body.model === "string" ? body.model : undefined,
          reasoningEffort:
            body.reasoningEffort === "low" ||
            body.reasoningEffort === "medium" ||
            body.reasoningEffort === "high" ||
            body.reasoningEffort === "xhigh"
              ? body.reasoningEffort
              : undefined,
          message: typeof body.message === "string" ? body.message : undefined,
          anchor: typeof body.anchor === "string" ? body.anchor : undefined,
          anchorIds: Array.isArray(body.anchorIds) ? body.anchorIds.filter((x): x is string => typeof x === "string") : undefined,
          mode: body.mode === "refine" ? "refine" : body.mode === "ask" ? "ask" : undefined,
          useFallback: body.useFallback === true,
          timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
        });
        return jsonResponse(started, 202);
      }

      const runCancelMatch = /^runs\/([^/]+)\/cancel$/.exec(sub);
      if (method === "POST" && runCancelMatch) {
        const runId = decodeURIComponent(runCancelMatch[1]!);
        const cancelled = executor.cancelRun(runId);
        return jsonResponse({ cancelled, runId });
      }

      const runDetailMatch = /^runs\/([^/]+)$/.exec(sub);
      if (method === "GET" && runDetailMatch) {
        const runId = decodeURIComponent(runDetailMatch[1]!);
        const liveLog = executor.getLiveLog(runId);
        if (liveLog !== null) {
          const active = executor.getActiveRuns(base).find((r) => r.id === runId);
          if (active) return jsonResponse({ record: active, log: liveLog });
        }
        return jsonResponse(getAgentRunDetail(base, id, runId));
      }

      if (method === "POST" && sub === "approve") {
        const body = await readBody(req);
        const snapshot = await observeGitSnapshot(base);
        const detail = await approveDesign(base, id, {
          expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
          baseline: snapshot,
          note: typeof body.note === "string" ? body.note : undefined,
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        let dispatch: DispatchOutcome | null = null;
        if (body.dispatchAgent === true) {
          const prompt = buildAgentPrompt(detail, "implement");
          dispatch = await dispatchToBridge(id, "implement", "send", prompt);
        }
        broadcastUi({ type: "workbench.updated", reason: "approved", id, at: Date.now() });
        return jsonResponse({ detail, dispatch });
      }

      if (method === "POST" && sub === "fast-track") {
        const body = await readBody(req);
        const snapshot = await observeGitSnapshot(base);
        const detail = await authorizeFastTrack(base, id, {
          expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
          baseline: snapshot,
          note: typeof body.note === "string" ? body.note : undefined,
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        let dispatch: DispatchOutcome | null = null;
        if (body.dispatchAgent === true) {
          const prompt = buildAgentPrompt(detail, "implement");
          dispatch = await dispatchToBridge(id, "implement", "send", prompt);
        }
        broadcastUi({ type: "workbench.updated", reason: "fast_tracked", id, at: Date.now() });
        return jsonResponse({ detail, dispatch });
      }

      if (method === "POST" && sub === "request-changes") {
        const body = await readBody(req);
        const snapshot = await observeGitSnapshot(base);
        const detail = await requestChanges(base, id, {
          feedback: typeof body.feedback === "string" ? body.feedback : "",
          expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        let dispatch: DispatchOutcome | null = null;
        if (body.dispatchAgent === true) {
          const action: DispatchAction = detail.state.stage === "designing" ? "design" : "fix";
          dispatch = await dispatchToBridge(id, action, "send", buildAgentPrompt(detail, action));
        }
        broadcastUi({ type: "workbench.updated", reason: "changes_requested", id, at: Date.now() });
        return jsonResponse({ detail, dispatch });
      }

      if (method === "POST" && sub === "verify") {
        const body = await readBody(req);
        const timeoutMs = typeof body.timeoutMs === "number" ? body.timeoutMs : undefined;
        broadcastUi({ type: "verify.started", id, at: Date.now() });
        try {
          if (body.all === true || typeof body.command !== "string") {
            const res = await runAllVerifications(base, id, { timeoutMs });
            broadcastUi({ type: "workbench.updated", reason: "verified", id, at: Date.now() });
            return jsonResponse({ detail: res.detail, runs: res.runs.map((r) => r.record) });
          }
          const criterionIds = Array.isArray(body.criterionIds)
            ? body.criterionIds.filter((c): c is string => typeof c === "string")
            : [];
          const res = await runVerification(base, id, {
            command: body.command,
            criterionIds,
            timeoutMs,
          });
          broadcastUi({ type: "workbench.updated", reason: "verified", id, at: Date.now() });
          return jsonResponse({ detail: res.detail, runs: [res.record] });
        } finally {
          broadcastUi({ type: "verify.finished", id, at: Date.now() });
        }
      }

      if (method === "POST" && sub === "accept") {
        const body = await readBody(req);
        const snapshot = await observeGitSnapshot(base);
        const detail = await acceptRequirement(base, id, {
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
          expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
          note: typeof body.note === "string" ? body.note : undefined,
        });
        broadcastUi({ type: "workbench.updated", reason: "accepted", id, at: Date.now() });
        return jsonResponse({ detail });
      }

      if (method === "POST" && sub === "block") {
        const body = await readBody(req);
        const snapshot = await observeGitSnapshot(base);
        const detail = await blockRequirement(base, id, {
          reason: typeof body.reason === "string" ? body.reason : "",
          expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        broadcastUi({ type: "workbench.updated", reason: "blocked", id, at: Date.now() });
        return jsonResponse({ detail });
      }

      if (method === "POST" && sub === "unblock") {
        const body = await readBody(req);
        const snapshot = await observeGitSnapshot(base);
        const detail = await unblockRequirement(base, id, {
          expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        broadcastUi({ type: "workbench.updated", reason: "unblocked", id, at: Date.now() });
        return jsonResponse({ detail });
      }

      if (method === "POST" && sub === "cancel") {
        const body = await readBody(req);
        const snapshot = await observeGitSnapshot(base);
        const detail = await cancelRequirement(base, id, {
          reason: typeof body.reason === "string" ? body.reason : "",
          expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        broadcastUi({ type: "workbench.updated", reason: "cancelled", id, at: Date.now() });
        return jsonResponse({ detail });
      }

      if (method === "POST" && sub === "reopen") {
        const body = await readBody(req);
        const snapshot = await observeGitSnapshot(base);
        const detail = await reopenRequirement(base, id, {
          reason: typeof body.reason === "string" ? body.reason : "",
          expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        broadcastUi({ type: "workbench.updated", reason: "reopened", id, at: Date.now() });
        return jsonResponse({ detail });
      }

      if (method === "POST" && sub === "dispatch") {
        const body = await readBody(req);
        const action = (body.action === "implement" || body.action === "fix" ? body.action : "design") as DispatchAction;
        const mode = body.mode === "prefill" ? "prefill" : "send";
        const snapshot = await observeGitSnapshot(base);
        let detail = getRequirement(base, id, { currentCodeSnapshotHash: snapshot?.fingerprint ?? null });

        if (action === "design" && detail.state.stage === "draft") {
          detail = await markDesigning(base, id, { currentCodeSnapshotHash: snapshot?.fingerprint ?? null });
          broadcastUi({ type: "workbench.updated", reason: "designing", id, at: Date.now() });
        }

        const prompt = buildAgentPrompt(detail, action);
        const dispatch = await dispatchToBridge(id, action, mode, prompt);
        return jsonResponse({ detail, dispatch });
      }
    }

    return jsonResponse({ error: { code: "not_found", message: `未知接口: ${method} ${pathname}` } }, 404);
  };

  const server = Bun.serve<WsClientData>({
    hostname,
    port: options.port ?? 0,
    async fetch(req, bunServer) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        const role = url.searchParams.get("role") === "bridge" ? "bridge" : "ui";
        const upgraded = bunServer.upgrade(req, { data: { role, id: randomUUID() } });
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
  const serverUrl = `http://${hostname}:${actualPort}`;
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
      version: "5.0.0",
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
