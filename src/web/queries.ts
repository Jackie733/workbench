import { useEffect, useMemo } from "react";
import { QueryClient, useQuery } from "@tanstack/react-query";
import type { GiteeIssueItem } from "../core/gitee.ts";
import type {
  AgentAction,
  AgentRunRecord,
  CascadeSyncItemResult,
  RequirementDetail,
  RequirementTier,
  RunTraceEvent,
  SandboxDriftInfo,
  Stage,
} from "../core/types.ts";
import type { RoutingConfig } from "../hub/types.ts";
import {
  api,
  ApiClientError,
  connectUiWebSocket,
  setApiProjectScope,
  type HubStateResponse,
  type InsightsQueryFilter,
  type ProjectInfoResponse,
} from "./api.ts";
import { resolveWarningParam } from "./i18n.ts";
import {
  activeRunnerChoice,
  findLockingRequirementRun,
  formatReviewFixFeedback,
  getModelEffortCapability,
  resolveRequirementRunScope,
  type RequirementRunScope,
  type Scope,
} from "./state.ts";
import { useDraftStore } from "./stores/draftStore.ts";
import { useStreamStore, type ActiveRunItem } from "./stores/streamStore.ts";
import { useUiStore } from "./stores/uiStore.ts";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2500,
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

export const queryKeys = {
  authStatus: ["auth", "status"] as const,
  hubState: ["hub", "state"] as const,
  project: (projectId: string | null) => ["project", projectId] as const,
  projectSandboxes: (projectId: string | null) => ["project", "sandboxes", projectId] as const,
  githubStatus: (projectId: string | null) => ["github", "status", projectId] as const,
  giteeStatus: (projectId: string | null) => ["gitee", "status", projectId] as const,
  giteeIssues: (projectId: string | null, filter: string, state: string, q: string) =>
    ["gitee", "issues", projectId, filter, state, q] as const,
  requirements: (projectId: string | null, scope: Scope) => ["requirements", projectId, scope] as const,
  requirement: (projectId: string | null, id: string | null) => ["requirement", projectId, id] as const,
  requirementRuns: (projectId: string | null, id: string | null) => ["requirement", "runs", projectId, id] as const,
  runContext: (projectId: string | null, id: string | null, runId: string | null) =>
    ["requirement", "runContext", projectId, id, runId] as const,
  hubInsights: (filter: InsightsQueryFilter) => ["hub", "insights", filter] as const,
  hubPricing: ["hub", "insights", "pricing"] as const,
  diff: (projectId: string | null, id: string | null, live = false) => ["diff", projectId, id, live ? "live" : "default"] as const,
  delivery: (projectId: string | null, id: string | null) => ["delivery", projectId, id] as const,
};

function resolveRunScope(): RequirementRunScope {
  const ui = useUiStore.getState();
  const hub = queryClient.getQueryData<HubStateResponse>(queryKeys.hubState);
  const projectId = ui.activeProjectId ?? hub?.activeProjectId ?? null;
  const project = queryClient.getQueryData<ProjectInfoResponse>(queryKeys.project(projectId));
  return resolveRequirementRunScope({
    activeProjectId: ui.activeProjectId,
    hubActiveProjectId: hub?.activeProjectId,
    projectRoot: project?.root,
    projects: hub?.projects,
  });
}

/** 命令式读取最新运行状态，用于请求与组合流程在产生副作用前复查。 */
export function findRequirementLockingRun(requirementId: string): ActiveRunItem | null {
  return (
    findLockingRequirementRun(Object.values(useStreamStore.getState().activeRuns), requirementId, resolveRunScope()) ??
    null
  );
}

export function guardRequirementRunLock(requirementId: string): boolean {
  if (!findRequirementLockingRun(requirementId)) return false;
  useUiStore.getState().showToastKey("toast.agentRunning", undefined, true);
  return true;
}

/** 详情页及其弹窗共用的响应式运行期限制判定。 */
export function useRequirementRunLock(requirementId: string | null): ActiveRunItem | null {
  const activeRuns = useStreamStore((s) => s.activeRuns);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const { data: hub } = useHubStateQuery();
  const projectKey = activeProjectId ?? hub?.activeProjectId ?? null;
  const { data: project } = useProjectQuery(projectKey);
  const scope = useMemo(
    () =>
      resolveRequirementRunScope({
        activeProjectId,
        hubActiveProjectId: hub?.activeProjectId,
        projectRoot: project?.root,
        projects: hub?.projects,
      }),
    [activeProjectId, hub?.activeProjectId, hub?.projects, project?.root],
  );
  return useMemo(() => {
    if (!requirementId) return null;
    return findLockingRequirementRun(Object.values(activeRuns), requirementId, scope) ?? null;
  }, [activeRuns, requirementId, scope]);
}

export function useAuthStatusQuery() {
  return useQuery({
    queryKey: queryKeys.authStatus,
    queryFn: () => api.authStatus(),
    staleTime: 30_000,
  });
}

export function useGitHubStatusQuery(activeProjectId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.githubStatus(activeProjectId),
    queryFn: () => api.getGitHubStatus(),
    enabled,
  });
}

export function useGiteeStatusQuery(activeProjectId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.giteeStatus(activeProjectId),
    queryFn: () => api.getGiteeStatus(),
    enabled,
  });
}

export function useGiteeIssuesQuery(
  activeProjectId: string | null,
  params: {
    filter: "assigned" | "created" | "all";
    state: "active" | "open" | "progressing" | "closed" | "all";
    q: string;
  },
  enabled: boolean,
) {
  return useQuery({
    queryKey: queryKeys.giteeIssues(activeProjectId, params.filter, params.state, params.q),
    queryFn: () => api.listGiteeIssues(params),
    enabled,
  });
}

export function useRequirementRunsQuery(activeProjectId: string | null, id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.requirementRuns(activeProjectId, id),
    queryFn: async () => {
      if (!id) return [];
      const res = await api.listRequirementRuns(id);
      return res.runs;
    },
    enabled: Boolean(id) && enabled,
  });
}

export function useRunContextQuery(
  activeProjectId: string | null,
  id: string | null,
  runId: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: queryKeys.runContext(activeProjectId, id, runId),
    queryFn: () => (id && runId ? api.getAgentRunContext(id, runId) : Promise.resolve({ runId: "", hasContext: false, context: null })),
    enabled: Boolean(id && runId) && enabled,
    staleTime: 15_000,
  });
}

export function useHubInsightsQuery(filter: InsightsQueryFilter, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.hubInsights(filter),
    queryFn: () => api.getHubInsights(filter),
    enabled,
    staleTime: 10_000,
  });
}

export function useHubPricingQuery(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.hubPricing,
    queryFn: () => api.getHubPricing(),
    enabled,
    staleTime: 15_000,
  });
}

const traceHydrationInFlight = new Map<string, Promise<void>>();
const logHydrationInFlight = new Map<string, Promise<void>>();

export async function hydrateRunLog(reqId: string, runId: string, force = false): Promise<void> {
  if (!reqId || !runId) return;
  const stream = useStreamStore.getState();
  if (!force && stream.logHydrated[runId]) return;
  const existing = logHydrationInFlight.get(runId);
  if (existing) return existing;
  const task = (async () => {
    try {
      const res = await api.getAgentRunLog(reqId, runId);
      useStreamStore.getState().setRunLogFull(runId, res.log, true);
    } catch {
      // Mark hydrated when missing on disk so UI does not spin forever.
      const prev = useStreamStore.getState().liveRunLogs[runId] ?? "";
      useStreamStore.getState().setRunLogFull(runId, prev, true);
    } finally {
      logHydrationInFlight.delete(runId);
    }
  })();
  logHydrationInFlight.set(runId, task);
  return task;
}

export async function hydrateRunTrace(reqId: string, runId: string, incremental = false): Promise<void> {
  if (!reqId || !runId) return;
  const inflightKey = `${runId}:${incremental ? "inc" : "full"}`;
  const existing = traceHydrationInFlight.get(inflightKey);
  if (existing) return existing;
  const task = (async () => {
    try {
      const stream = useStreamStore.getState();
      const prev = stream.runTraces[runId];
      let afterSeq = incremental && prev ? prev.lastSeq : 0;
      let append = incremental && Boolean(prev);
      for (let page = 0; page < 8; page += 1) {
        const res = await api.getAgentRunTrace(reqId, runId, afterSeq, 2000);
        useStreamStore.getState().applyTraceSnapshot(runId, res, append);
        if (!res.hasMore || res.events.length === 0) break;
        afterSeq = res.nextSeq;
        append = true;
      }
    } catch {
      const prev = useStreamStore.getState().runTraces[runId];
      if (!prev) {
        useStreamStore.getState().applyTraceSnapshot(runId, { events: [], nextSeq: 0, hasTrace: false }, false);
      }
    } finally {
      traceHydrationInFlight.delete(inflightKey);
    }
  })();
  traceHydrationInFlight.set(inflightKey, task);
  return task;
}

export function resolveEffectiveRouting(
  project?: ProjectInfoResponse | null,
): RoutingConfig | null {
  return project?.project?.routing ?? project?.routing ?? null;
}

function applyHubState(hub: HubStateResponse, snapshotStartedAt: number): void {
  useStreamStore.getState().syncActiveRuns(hub.activeRuns, snapshotStartedAt);
  const ui = useUiStore.getState();
  if (hub.hubMode) {
    const currentValid = Boolean(ui.activeProjectId && hub.projects.some((p) => p.id === ui.activeProjectId));
    if (!currentValid) {
      const nextId = hub.activeProjectId ?? hub.projects[0]?.id ?? null;
      if (ui.activeProjectId !== nextId) {
        setApiProjectScope(nextId);
        ui.setActiveProjectId(nextId);
        useDraftStore.getState().setProjectScope(nextId);
      }
    } else {
      useDraftStore.getState().setProjectScope(ui.activeProjectId);
    }
  } else {
    useDraftStore.getState().setProjectScope(null);
  }
}

/**
 * 连接建立后强制拉取一次权威 Hub 快照。
 * react-query 在缓存尚无数据时会复用在途请求（cancelRefetch 也不会中断），
 * 因此不能依赖 refetchQueries，必须真实发出新请求并清理旧的在途查询。
 */
export async function refreshHubStateAfterConnect(): Promise<void> {
  await queryClient.cancelQueries({ queryKey: queryKeys.hubState }, { revert: false });
  const snapshotStartedAt = Date.now();
  const hub = await api.getHubState();
  applyHubState(hub, snapshotStartedAt);
  queryClient.setQueryData(queryKeys.hubState, hub);
}

export function useHubStateQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.hubState,
    queryFn: async () => {
      // 记录请求发出时间：比它更晚到达的运行事件不能被这份快照回滚。
      const snapshotStartedAt = Date.now();
      const hub = await api.getHubState();
      applyHubState(hub, snapshotStartedAt);
      return hub;
    },
    refetchInterval: (query) => query.state.data?.nodes?.some((node) => node.update?.phase === "running") ? 3_000 : false,
    enabled,
  });
}

export function useProjectQuery(activeProjectId: string | null) {
  const { data: hub } = useHubStateQuery();
  const activeProj = hub?.projects.find((p) => p.id === (activeProjectId ?? hub.activeProjectId)) ?? hub?.projects[0];
  const nodeOffline = Boolean(hub?.hubMode && activeProj && activeProj.nodeOnline === false);
  const enabled = hub !== undefined && (!hub.hubMode || hub.projects.length > 0) && !nodeOffline;
  return useQuery({
    queryKey: queryKeys.project(activeProjectId),
    queryFn: async () => {
      const proj = await api.getProject();
      const ui = useUiStore.getState();
      if (!proj.initialized && !ui.initName) {
        ui.setInitName(proj.root.split("/").pop() || "workbench");
      }
      return proj;
    },
    enabled,
  });
}

export function useProjectSandboxesQuery(activeProjectId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.projectSandboxes(activeProjectId),
    queryFn: () => api.getProjectSandboxes(false),
    enabled,
  });
}

export function useRequirementsQuery(activeProjectId: string | null, scope: Scope, enabled: boolean) {
  const fetchScope = scope === "decisions" || scope === "sandboxes" ? "all" : scope;
  return useQuery({
    queryKey: queryKeys.requirements(activeProjectId, fetchScope),
    queryFn: () => api.listRequirements(fetchScope),
    enabled,
  });
}

export function isRequirementNotFoundError(error: unknown): boolean {
  return error instanceof ApiClientError && error.code === "not_found";
}

export function useRequirementQuery(activeProjectId: string | null, id: string | null) {
  return useQuery({
    queryKey: queryKeys.requirement(activeProjectId, id),
    queryFn: () => api.getRequirement(id!),
    enabled: Boolean(id),
  });
}

export function useDiffQuery(activeProjectId: string | null, id: string | null, enabled: boolean, live = false) {
  return useQuery({
    queryKey: queryKeys.diff(activeProjectId, id, live),
    queryFn: () => api.getDiff(id!, { live }),
    enabled: Boolean(id && enabled),
  });
}

export function useDeliveryQuery(activeProjectId: string | null, id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.delivery(activeProjectId, id),
    queryFn: () => api.getDelivery(id!),
    enabled: Boolean(id && enabled),
  });
}

export async function invalidateAllWorkbenchQueries(): Promise<void> {
  await queryClient.invalidateQueries();
}

export type ReloadUiAction = "reload-now" | "defer";

/**
 * 决定收到 `workbench.reload_ui` 后是立即热刷新还是暂缓。
 * 纯函数便于单测：手动触发的热重建优先；弹窗/忙碌/输入中一律暂缓，避免打断用户操作。
 */
export function resolveReloadUiAction(input: {
  manual: boolean;
  modalOpen: boolean;
  busy: boolean;
  activeTag?: string | null;
  contentEditable?: boolean;
}): ReloadUiAction {
  if (input.manual) return "reload-now";
  if (input.modalOpen || input.busy) return "defer";
  const tag = input.activeTag?.toUpperCase();
  if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return "defer";
  if (input.contentEditable === true) return "defer";
  return "reload-now";
}

export function useWorkbenchWsSync(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const finishedSeen = new Set<string>();

    let reloadTimer: ReturnType<typeof setTimeout> | undefined;

    const readReloadGate = (manual: boolean): ReloadUiAction => {
      const ui = useUiStore.getState();
      const active = typeof document !== "undefined" ? document.activeElement : null;
      return resolveReloadUiAction({
        manual,
        modalOpen: ui.modal !== null,
        busy: ui.busy,
        activeTag: active?.tagName,
        contentEditable: active instanceof HTMLElement ? active.isContentEditable : false,
      });
    };

    const deferReload = () => {
      if (reloadTimer !== undefined) {
        clearTimeout(reloadTimer);
        reloadTimer = undefined;
      }
      const ui = useUiStore.getState();
      ui.setPendingWebReload(true);
      ui.showReloadPendingToast();
    };

    const scheduleReload = (manual: boolean) => {
      const ui = useUiStore.getState();
      ui.setPendingWebReload(false);
      ui.dismissReloadPendingToast();
      clearTimeout(reloadTimer);
      ui.showToastKey("toast.reloadNow");
      reloadTimer = setTimeout(() => {
        reloadTimer = undefined;
        // 定时器内复核：180ms 内若用户打开弹窗或开始输入，则转为暂缓而不是打断。
        if (readReloadGate(manual) === "reload-now") {
          window.location.reload();
          return;
        }
        deferReload();
      }, 180);
    };

    const requestReload = (manual: boolean) => {
      if (readReloadGate(manual) === "reload-now") scheduleReload(manual);
      else deferReload();
    };

    const drainPendingReload = () => {
      if (!useUiStore.getState().pendingWebReload) return;
      if (reloadTimer !== undefined) return;
      if (readReloadGate(false) !== "reload-now") return;
      scheduleReload(false);
    };

    const unsubscribeReloadDrain = useUiStore.subscribe(drainPendingReload);
    const onFocusOut = () => drainPendingReload();
    if (typeof document !== "undefined") document.addEventListener("focusout", onFocusOut);

    const disconnect = connectUiWebSocket(
      (ev) => {
        const type = ev.type;
        if (type === "agent.run.started") {
          const runId = typeof ev.runId === "string" ? ev.runId : "";
          const reqId = typeof ev.requirementId === "string" ? ev.requirementId : "";
          if (!runId) return;
          const rec: AgentRunRecord & { requirementId: string; root?: string; projectId?: string } = {
            id: runId,
            requirementId: reqId,
            ...(typeof ev.root === "string" ? { root: ev.root } : {}),
            ...(typeof ev.projectId === "string" ? { projectId: ev.projectId } : {}),
            action: (ev.action as AgentAction) ?? "design",
            harness: String(ev.harness ?? ""),
            model: String(ev.model ?? ""),
            status: "running",
            startedAt: typeof ev.at === "number" ? ev.at : Date.now(),
            endedAt: null,
            exitCode: null,
            durationMs: 0,
            logPath: "",
          };
          useStreamStore.getState().setRunStarted(rec);
          void queryClient.invalidateQueries({ queryKey: ["requirement"] });
          void queryClient.invalidateQueries({ queryKey: queryKeys.hubState });
          return;
        }

        if (type === "agent.run.output") {
          const runId = typeof ev.runId === "string" ? ev.runId : "";
          const chunk = typeof ev.chunk === "string" ? ev.chunk : "";
          if (!runId || !chunk) return;
          useStreamStore.getState().appendRunLog(runId, chunk);
          return;
        }

        if (type === "agent.run.event") {
          const runId = typeof ev.runId === "string" ? ev.runId : "";
          const evtObj = ev.event;
          if (!runId || !evtObj || typeof evtObj !== "object") return;
          useStreamStore.getState().pushTraceEvent(runId, evtObj as RunTraceEvent);
          return;
        }

        if (type === "agent.run.metrics") {
          const runId = typeof ev.runId === "string" ? ev.runId : "";
          const metricsObj = ev.metrics;
          if (!runId || !metricsObj || typeof metricsObj !== "object") return;
          useStreamStore.getState().updateLiveMetrics(runId, metricsObj as Partial<AgentRunRecord>);
          return;
        }

        if (type === "agent.run.finished") {
          const runId = typeof ev.runId === "string" ? ev.runId : "";
          if (!runId) return;
          useStreamStore.getState().markRunFinished(runId);
          const reqId = typeof ev.requirementId === "string" ? ev.requirementId : "";
          if (reqId) {
            void hydrateRunTrace(reqId, runId, true);
            void hydrateRunLog(reqId, runId, true);
          }
          if (!finishedSeen.has(runId)) {
            finishedSeen.add(runId);
            const status = ev.status as AgentRunRecord["status"] | undefined;
            const model = typeof ev.model === "string" ? ev.model : "";
            const ui = useUiStore.getState();
            if (status === "succeeded") {
              if (ev.modelFallback === true) {
                ui.showToastKey("toast.runSucceededFallback", {
                  id: reqId,
                  model,
                  effective: String(ev.effectiveModel ?? "auto"),
                });
              } else {
                ui.showToastKey("toast.runSucceeded", { id: reqId, model });
              }
            } else if (status === "cancelled") {
              ui.showToastKey("toast.runCancelled", { id: reqId });
            } else if (ev.rateLimited) {
              ui.showToastKey("toast.runRateLimited", { id: reqId }, true);
            } else {
              ui.showToastKey(
                "toast.runFailed",
                { id: reqId, error: String(ev.errorSummary ?? "unknown") },
                true,
              );
            }
          }
          void queryClient.invalidateQueries({ queryKey: ["requirement"] });
          void queryClient.invalidateQueries({ queryKey: ["requirements"] });
          void queryClient.invalidateQueries({ queryKey: ["diff"] });
          void queryClient.invalidateQueries({ queryKey: queryKeys.hubState });
          void queryClient.invalidateQueries({ queryKey: ["hub", "insights"] });
          return;
        }

        if (type === "workbench.reload_ui") {
          requestReload(ev.manual === true);
          return;
        }

        if (type === "hub.updated" && ev.reason === "project.activated") {
          const hub = queryClient.getQueryData<HubStateResponse>(queryKeys.hubState);
          if (typeof ev.projectId === "string" && typeof ev.at === "number" && hub?.projects.some((p) => p.id === ev.projectId)) {
            cacheProjectActivation(ev.projectId, ev.at);
          } else {
            void queryClient.invalidateQueries({ queryKey: queryKeys.hubState });
          }
          return;
        }

        if (type === "workbench.updated" || type === "hub.updated") {
          void queryClient.invalidateQueries();
        }
      },
      {
        onConnected: () => {
          // 首次连接与重连都补拉运行快照；初始请求在途时也必须真实发出新请求。
          void refreshHubStateAfterConnect().catch(() => {
            void queryClient.refetchQueries({ queryKey: queryKeys.hubState, type: "active" }, { cancelRefetch: true });
          });
          void queryClient.refetchQueries({ queryKey: ["requirement"], type: "active" }, { cancelRefetch: true });
          void queryClient.refetchQueries({ queryKey: ["requirements"], type: "active" }, { cancelRefetch: true });
        },
        onReconnect: () => {
          void queryClient.invalidateQueries();
          const ui = useUiStore.getState();
          const stream = useStreamStore.getState();
          const reqId = ui.selectedId;
          if (reqId) {
            const runId =
              stream.selectedRunByReq[reqId] ??
              Object.values(stream.activeRuns).find((r) => r.requirementId === reqId)?.id ??
              ui.inspectedRunId;
            if (runId) {
              void hydrateRunTrace(reqId, runId, true);
              void hydrateRunLog(reqId, runId, true);
            }
          }
        },
      },
    );
    return () => {
      clearTimeout(reloadTimer);
      unsubscribeReloadDrain();
      if (typeof document !== "undefined") document.removeEventListener("focusout", onFocusOut);
      disconnect();
    };
  }, [enabled]);
}

export async function runBusy<T>(fn: () => Promise<T>): Promise<T | null> {
  const ui = useUiStore.getState();
  if (ui.busy) return null;
  ui.setBusy(true);
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiClientError && err.code === "revision_conflict") {
      ui.showToastKey("toast.revisionConflict", undefined, true);
      await invalidateAllWorkbenchQueries();
      return null;
    }
    ui.showToastError(err);
    return null;
  } finally {
    useUiStore.getState().setBusy(false);
  }
}

export function shouldUseCliRunner(_action?: AgentAction): boolean {
  return true;
}

export async function openRequirement(id: string): Promise<void> {
  const ui = useUiStore.getState();
  const scrollEl = typeof document !== "undefined" ? document.querySelector(".sb-req-scroll") : null;
  if (scrollEl) {
    ui.setHomeScrollY(scrollEl.scrollTop);
  }
  ui.setMainView("workspace");
  ui.setSelectedId(id);
  ui.setInspectedRunId(null);
  ui.setSidebarOpen(false);
  ui.setWorkspaceTab("spec");
  ui.setSelectedDiffFile(null);
  ui.setDiffFileQuery("");
  ui.setDesignViewVersion(null);
  ui.setDesignComparePrev(false);
  ui.setDesignCompareText(null);
  ui.clearExpandedLogs();
  useDraftStore.getState().cancelEditSpec();
  useDraftStore.getState().cancelEditDesign();
  await queryClient.invalidateQueries({ queryKey: queryKeys.requirement(ui.activeProjectId, id) });
}

export function backHome(): void {
  const ui = useUiStore.getState();
  const savedY = ui.homeScrollY;
  const isMobile = typeof window !== "undefined" && window.matchMedia("(max-width: 820px)").matches;
  if (isMobile) {
    ui.setSidebarOpen(true);
  } else {
    ui.setDesktopSidebarOpen(true);
  }
  void queryClient.invalidateQueries({ queryKey: ["requirements"] });
  requestAnimationFrame(() => {
    const scrollEl = typeof document !== "undefined" ? document.querySelector(".sb-req-scroll") : null;
    if (scrollEl && savedY > 0) scrollEl.scrollTop = savedY;
  });
}

function cacheProjectActivation(pid: string, lastOpenedAt: number): void {
  queryClient.setQueryData<HubStateResponse>(queryKeys.hubState, (hub) => hub && ({
    ...hub,
    activeProjectId: pid,
    projects: hub.projects.map((item) => item.id === pid ? { ...item, lastOpenedAt } : item),
  }));
}

export async function switchProject(pid: string): Promise<void> {
  const ui = useUiStore.getState();
  ui.setSidebarOpen(false);
  ui.setMainView("workspace");
  if (pid === ui.activeProjectId) return;
  await runBusy(async () => {
    const { project } = await api.activateHubProject(pid);
    setApiProjectScope(pid);
    ui.setActiveProjectId(pid);
    useDraftStore.getState().setProjectScope(pid);
    ui.setSelectedId(null);
    ui.setInspectedRunId(null);
    ui.setSelectedDiffFile(null);
    ui.setQuery("");
    ui.setHomeScrollY(0);
    cacheProjectActivation(pid, project.lastOpenedAt);
  });
}

export async function openAddProjectModal(preferredNodeId?: string): Promise<void> {
  const ui = useUiStore.getState();
  ui.setSidebarOpen(false);
  const nodeId = preferredNodeId && preferredNodeId !== "local" ? preferredNodeId : "local";
  try {
    const browse = await api.browseFs(undefined, nodeId);
    ui.setModal({
      kind: "add_project",
      nodeId,
      browse,
      pathInput: browse.currentPath,
      nameInput: "",
      initPrivacy: "local",
    });
  } catch (err) {
    ui.setModal({ kind: "add_project", nodeId, browse: null, pathInput: "", nameInput: "", initPrivacy: "local" });
    ui.showToastError(err);
  }
}

export async function logoutSession(): Promise<void> {
  const session = await api.logout();
  await queryClient.cancelQueries({ queryKey: queryKeys.authStatus });
  queryClient.setQueryData(queryKeys.authStatus, { required: true, ...session });
  queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "auth" });
}

export async function triggerActiveRun(
  reqId: string,
  action: AgentAction,
  opts?: {
    message?: string;
    anchor?: string;
    anchorIds?: string[];
    mode?: "ask" | "refine";
    useFallback?: boolean;
    runnerActionKey?: AgentAction;
  },
): Promise<void> {
  if (guardRequirementRunLock(reqId)) return;
  const scope = resolveRunScope();
  const hub = queryClient.getQueryData<HubStateResponse>(queryKeys.hubState);
  const project = queryClient.getQueryData<ProjectInfoResponse>(queryKeys.project(scope.projectId));
  const drafts = useDraftStore.getState().runnerOverrides;
  const override =
    opts?.runnerActionKey && drafts[opts.runnerActionKey]?.key ? drafts[opts.runnerActionKey] : drafts[action];
  const selectedRunnerKey = override?.key ?? "";
  const selectedEffort = override?.effort ?? "";
  const cachedReq = queryClient.getQueryData<{ detail?: RequirementDetail }>(
    queryKeys.requirement(scope.projectId, reqId),
  );
  const reqTier: RequirementTier = cachedReq?.detail?.state.tier ?? "standard";
  const choice = activeRunnerChoice(
    selectedRunnerKey,
    resolveEffectiveRouting(project),
    action,
    selectedEffort,
    reqTier,
  );
  const effortCap = getModelEffortCapability(hub?.harnesses ?? [], choice.harness, choice.model);
  const effectiveEffort =
    effortCap.mode === "configurable"
      ? choice.effort && effortCap.efforts.includes(choice.effort)
        ? choice.effort
        : undefined
      : undefined;
  const ui = useUiStore.getState();

  let requestStartedAt = 0;
  const res = await runBusy(async () => {
    // 产生请求副作用前读取最新运行状态，防住延迟回调与并发入口。
    if (guardRequirementRunLock(reqId)) return null;
    requestStartedAt = Date.now();
    return api.startAgentRun(reqId, {
      action,
      harness: selectedRunnerKey ? choice.harness : undefined,
      model: selectedRunnerKey ? choice.model : undefined,
      reasoningEffort: effectiveEffort,
      message: opts?.message,
      anchor: opts?.anchor,
      anchorIds: opts?.anchorIds,
      mode: opts?.mode,
      useFallback: opts?.useFallback,
    });
  });

  if (res) {
    useStreamStore.getState().setRunStarted({
      ...res.run,
      requirementId: reqId,
      // 使用发起请求时的项目作用域，避免响应到达前切换项目导致归属漂移。
      ...(scope.projectId ? { projectId: scope.projectId } : {}),
      ...(scope.projectRoot ? { root: scope.projectRoot } : {}),
    }, requestStartedAt);
    ui.setDrawerOpen(true);
    ui.setDrawerTab(action === "ask" ? "discuss" : "console");
    ui.showToastKey("toast.runStarted", {
      target: `${res.target.harness}/${res.target.model}${res.target.reasoningEffort ? ` [${res.target.reasoningEffort}]` : ""}`,
      action,
    });
    await queryClient.invalidateQueries({ queryKey: ["requirement"] });
    // Hub 快照刷新属于请求完成后的后台同步，不应继续占用按钮的局部 loading，
    // 否则网络或远端状态挂起时，已启动运行的操作按钮会长时间保持不可用。
    void queryClient.invalidateQueries({ queryKey: queryKeys.hubState }).catch(() => undefined);
  }
}

export async function executeVerify(id: string, body: Parameters<typeof api.verify>[1]) {
  if (guardRequirementRunLock(id)) return null;
  return runBusy(async () => {
    if (guardRequirementRunLock(id)) return null;
    const out = await api.verify(id, body);
    await queryClient.invalidateQueries({ queryKey: ["requirement"] });
    await queryClient.invalidateQueries({ queryKey: ["requirements"] });
    return out;
  });
}

export async function captureUiScreenshots(id: string, label?: string) {
  if (guardRequirementRunLock(id)) return null;
  return runBusy(async () => {
    if (guardRequirementRunLock(id)) return null;
    const out = await api.captureScreenshots(id, label);
    await queryClient.invalidateQueries({ queryKey: ["requirement"] });
    await queryClient.invalidateQueries({ queryKey: ["requirements"] });
    return out;
  });
}

export async function dispatchFixFromReview(
  detail: RequirementDetail,
  opts?: { selectedFindingIds?: string[] },
): Promise<void> {
  const id = detail.state.id;
  if (guardRequirementRunLock(id)) return;
  const report = detail.state.reviewReport;
  const feedback = report
    ? formatReviewFixFeedback(report, opts?.selectedFindingIds)
    : "请根据最新跨模型 Code Review 意见定位修复问题，并重跑全量验证。";
  await triggerActiveRun(id, "fix", { message: feedback });
}

export async function setRequirementTierAction(
  detail: RequirementDetail,
  tier: RequirementTier,
  opts?: { reason?: string; dispatchFix?: boolean },
): Promise<void> {
  const id = detail.state.id;
  if (guardRequirementRunLock(id)) return;
  const scope = resolveRunScope();
  const ui = useUiStore.getState();
  let requestStartedAt = 0;
  const res = await runBusy(() => {
    requestStartedAt = Date.now();
    return api.setRequirementTier(id, {
      tier,
      expectedRevision: detail.state.revision,
      ...(opts?.reason ? { reason: opts.reason } : {}),
      ...(opts?.dispatchFix ? { dispatchFix: true } : {}),
    });
  });
  if (!res) return;
  if (res.run && res.target) {
    useStreamStore.getState().setRunStarted(
      {
        ...res.run,
        requirementId: id,
        ...(scope.projectId ? { projectId: scope.projectId } : {}),
        ...(scope.projectRoot ? { root: scope.projectRoot } : {}),
      },
      requestStartedAt,
    );
    ui.setDrawerOpen(true);
    ui.setDrawerTab("console");
    ui.showToastKey("toast.runStarted", {
      target: `${res.target.harness}/${res.target.model}${res.target.reasoningEffort ? ` [${res.target.reasoningEffort}]` : ""}`,
      action: "fix",
    });
  } else {
    ui.showToastKey(tier === "sota" ? "toast.tierSota" : "toast.tierStandard", { id });
  }
  await invalidateAllWorkbenchQueries();
}

export async function syncSandboxBaseAction(
  reqId: string,
  options: { fetchRemote?: boolean } = {},
): Promise<boolean> {
  if (guardRequirementRunLock(reqId)) return false;
  const ui = useUiStore.getState();
  const res = await runBusy(() =>
    api.syncSandboxBase(reqId, { fetchRemote: options.fetchRemote !== false }),
  );
  if (!res) return false;
  await invalidateAllWorkbenchQueries();
  if (res.upToDate) {
    ui.showToastKey("toast.sandboxUpToDate", { id: reqId });
    return true;
  }
  if (res.synced) {
    ui.showToastKey("toast.sandboxSynced", { id: reqId });
    return true;
  }
  ui.showToastKey("toast.sandboxConflicts", { count: res.conflictFiles.length }, true);
  return false;
}

export function notifyCascadeSyncResults(results?: CascadeSyncItemResult[]): void {
  if (!results || results.length === 0) return;
  const ui = useUiStore.getState();
  const synced = results.filter((r) => r.status === "synced");
  const conflicted = results.filter((r) => r.status === "conflict");
  if (conflicted.length > 0) {
    ui.showToastKey(
      "home.cascadeConflict",
      {
        synced: synced.length,
        conflicts: conflicted.map((c) => c.requirementId).join(", "),
      },
      true,
    );
  } else if (synced.length > 0) {
    ui.showToastKey("home.cascadeSynced", {
      count: synced.length,
      ids: synced.map((s) => s.requirementId).join(", "),
    });
  }
}

export async function dispatchSyncBaseWithAgent(
  detail: RequirementDetail,
  drift: SandboxDriftInfo,
): Promise<void> {
  const id = detail.state.id;
  if (guardRequirementRunLock(id)) return;
  const ui = useUiStore.getState();
  const conflicts = drift.conflictFiles.slice(0, 8).join(", ");
  const targetLabel = drift.targetRef ?? drift.mainHead.slice(0, 7);
  const msg =
    `当前工作目录是需求 ${id} 的隔离 Worktree 沙箱分支 ${drift.branch}（当前基线 ${drift.baseHead.slice(0, 7)}），落后主干目标 ${targetLabel} 共 ${drift.behindCount} 个提交` +
    (conflicts ? `，真实冲突文件：${conflicts}` : "") +
    `。本次任务仅聚焦同步主干与解决合并冲突，切勿重复返工已通过的功能或已过期的旧审查意见。同步步骤：\n` +
    `1. 检查 git status：若存在未提交业务/测试改动，使用 git add -u 与显式业务文件路径暂存后 git commit -m "chore(${id}): wip before base sync"（或 git stash）保存当前进度；严禁提交 node_modules 或临时目录；\n` +
    `2. 执行 git merge --no-edit ${drift.mainHead}，手工解决冲突并保留当前需求全部功能与主干新增改动，完成后提交合并（若 stash 过请 pop）；\n` +
    `3. 运行 wb verify ${id} --all。`;
  const scope = resolveRunScope();
  const hub = queryClient.getQueryData<HubStateResponse>(queryKeys.hubState);
  const project = queryClient.getQueryData<ProjectInfoResponse>(queryKeys.project(scope.projectId));
  const drafts = useDraftStore.getState().runnerOverrides;
  const override = drafts.fix;
  const selectedRunnerKey = override?.key ?? "";
  const selectedEffort = override?.effort ?? "";
  const choice = activeRunnerChoice(
    selectedRunnerKey,
    resolveEffectiveRouting(project),
    "fix",
    selectedEffort,
    detail.state.tier ?? "standard",
  );
  const effortCap = getModelEffortCapability(hub?.harnesses ?? [], choice.harness, choice.model);
  const effectiveEffort =
    effortCap.mode === "configurable"
      ? choice.effort && effortCap.efforts.includes(choice.effort)
        ? choice.effort
        : undefined
      : undefined;

  let requestStartedAt = 0;
  const res = await runBusy(() => {
    requestStartedAt = Date.now();
    return api.syncResolveSandbox(id, {
      approveFirst: detail.state.stage === "planning" && Boolean(detail.state.designHash),
      expectedRevision: detail.state.revision,
      harness: selectedRunnerKey ? choice.harness : undefined,
      model: selectedRunnerKey ? choice.model : undefined,
      reasoningEffort: effectiveEffort,
      message: msg,
    });
  });
  if (!res) return;
  if (res.run && res.target) {
    useStreamStore.getState().setRunStarted({
      ...res.run,
      requirementId: id,
      ...(scope.projectId ? { projectId: scope.projectId } : {}),
      ...(scope.projectRoot ? { root: scope.projectRoot } : {}),
    }, requestStartedAt);
    ui.setDrawerOpen(true);
    ui.setDrawerTab("console");
    ui.showToastKey("toast.runStarted", {
      target: `${res.target.harness}/${res.target.model}${res.target.reasoningEffort ? ` [${res.target.reasoningEffort}]` : ""}`,
      action: "fix",
    });
  }
  await invalidateAllWorkbenchQueries();
}

export async function handleBannerAction(detail: RequirementDetail, actionId: string): Promise<void> {
  const id = detail.state.id;
  if (guardRequirementRunLock(id)) return;
  const rev = detail.state.revision;
  const ui = useUiStore.getState();

  switch (actionId) {
    case "dispatch_design": {
      await triggerActiveRun(id, "design");
      break;
    }
    case "approve":
    case "approve_only": {
      const res = await runBusy(() => api.approve(id, { expectedRevision: rev }));
      if (res) {
        await invalidateAllWorkbenchQueries();
        ui.showToastKey("toast.approved", { id });
      }
      break;
    }
    case "approve_and_implement": {
      const res = await runBusy(() =>
        api.approve(id, {
          expectedRevision: rev,
        }),
      );
      if (res) {
        await invalidateAllWorkbenchQueries();
        await triggerActiveRun(id, "implement");
      }
      break;
    }
    case "fast_track":
    case "authorize_fast_track": {
      const res = await runBusy(() =>
        api.fastTrack(id, {
          expectedRevision: rev,
        }),
      );
      if (res) {
        await invalidateAllWorkbenchQueries();
        await triggerActiveRun(id, "implement");
      }
      break;
    }
    case "dispatch_implement": {
      await triggerActiveRun(id, "implement");
      break;
    }
    case "dispatch_fix": {
      await triggerActiveRun(id, "fix");
      break;
    }
    case "escalate_sota": {
      await setRequirementTierAction(detail, "sota", { dispatchFix: true });
      break;
    }
    case "dispatch_review": {
      await triggerActiveRun(id, "review");
      break;
    }
    case "dispatch_fix_review": {
      await dispatchFixFromReview(detail);
      break;
    }
    case "sync_base": {
      await syncSandboxBaseAction(id);
      break;
    }
    case "request_changes": {
      ui.setModal({
        kind: "feedback",
        feedback: "",
        dispatchAgent: true,
      });
      break;
    }
    case "run_all_verifications": {
      const res = await executeVerify(id, { all: true });
      if (res) {
        const passed = res.runs.filter((r) => r.passed).length;
        ui.showToastKey(
          "toast.verifyDone",
          { passed, total: res.runs.length },
          passed < res.runs.length,
        );
      }
      break;
    }
    case "accept_override":
    case "accept": {
      if (!detail.validity.acceptanceGate.ok) {
        ui.setModal({
          kind: "accept_override",
          verdict: "block",
          summary: detail.validity.acceptanceGate.blockers.join("；"),
          reason: "",
          acceptedRisks: detail.validity.acceptanceGate.blockers,
        });
        break;
      }
      const report = detail.state.reviewReport;
      const revState = detail.validity.reviewValidity.effectiveState;
      const needsOverrideModal =
        Boolean(report) &&
        ((revState === "current" && (report!.verdict === "block" || report!.verdict === "concern")) ||
          (revState === "stale" && report!.verdict === "block"));
      if (needsOverrideModal && report) {
        ui.setModal({
          kind: "accept_override",
          verdict: revState === "stale" ? "stale" : report.verdict,
          summary: report.summary,
          reason: "",
          acceptedRisks: (report.findings ?? []).map((f) => `[${f.severity}] ${f.id}: ${f.title}`),
        });
        break;
      }
      const res = await runBusy(() => api.accept(id, { expectedRevision: rev }));
      if (res) {
        await invalidateAllWorkbenchQueries();
        ui.showToastKey("toast.accepted", { id });
      }
      break;
    }
    case "reopen":
      ui.setModal({
        kind: "lifecycle",
        action: "reopen",
        reason: "",
        preserveApproval: detail.validity.approval.valid,
      });
      break;
  }
}

export async function openHandoff(reqId: string): Promise<void> {
  const ui = useUiStore.getState();
  ui.setMoreMenuOpen(false);
  await runBusy(async () => {
    const out = await api.getHandoff(reqId);
    ui.setModal({ kind: "handoff_preview", markdown: out.markdown });
    await queryClient.invalidateQueries({ queryKey: ["requirement"] });
    return out;
  });
}

export async function toggleVerificationLog(reqId: string, vid: string): Promise<void> {
  const ui = useUiStore.getState();
  if (ui.expandedLogs[vid] !== undefined) {
    ui.setExpandedLog(vid, null);
    return;
  }
  try {
    const res = await api.getEvidence(reqId, vid);
    ui.setExpandedLog(vid, res.log);
  } catch (err) {
    ui.showToastError(err);
  }
}

export async function openRunConsole(reqId: string, runId: string): Promise<void> {
  const ui = useUiStore.getState();
  const stream = useStreamStore.getState();
  stream.setSelectedRunForReq(reqId, runId);
  ui.setDrawerOpen(true);
  ui.setDrawerTab("console");
  await Promise.all([
    hydrateRunTrace(reqId, runId, false),
    hydrateRunLog(reqId, runId, false),
  ]);
}

export async function openRunAudit(reqId: string, runId: string): Promise<void> {
  const ui = useUiStore.getState();
  if (ui.selectedId !== reqId) {
    await openRequirement(reqId);
  }
  const latestUi = useUiStore.getState();
  latestUi.setMainView("workspace");
  latestUi.setWorkspaceTab("audit");
  latestUi.setInspectedRunId(runId);
  void hydrateRunTrace(reqId, runId, false);
  void hydrateRunLog(reqId, runId, false);
}

export async function jumpToRequirementFromInsights(projectId: string | undefined, reqId: string): Promise<void> {
  const ui = useUiStore.getState();
  if (projectId) {
    const hub = queryClient.getQueryData<HubStateResponse>(queryKeys.hubState);
    const matched = hub?.projects.find((p) => p.id === projectId || p.root === projectId);
    const targetProjectId = matched?.id ?? (!projectId.startsWith("/") ? projectId : undefined);
    if (targetProjectId && targetProjectId !== ui.activeProjectId) {
      await switchProject(targetProjectId);
    }
  }
  await openRequirement(reqId);
}

export async function cancelRun(reqId: string, runId: string): Promise<void> {
  await api.cancelAgentRun(reqId, runId);
  useUiStore.getState().showToastKey("toast.cancelled");
}

export async function initProjectSubmit(): Promise<void> {
  const ui = useUiStore.getState();
  const res = await runBusy(() =>
    api.initProject({
      name: ui.initName.trim() || undefined,
      privacyMode: ui.initPrivacy,
      ...(ui.initOutputLanguage !== "inherit" ? { outputLanguage: ui.initOutputLanguage } : {}),
    }),
  );
  if (res) {
    await invalidateAllWorkbenchQueries();
    ui.showToastKey("toast.initialized");
  }
}

export async function submitNewRequirement(
  goalRaw: string,
  dispatchAgent: boolean,
  createGitHubIssue?: boolean,
  attachmentIds: string[] = [],
  sandboxOpts?: { createSandbox?: boolean; stackedOnReqId?: string; tier?: RequirementTier },
): Promise<void> {
  const goal = goalRaw.trim();
  const ui = useUiStore.getState();
  const modalInstanceId = ui.modalInstanceId;
  if (!goal) {
    ui.showToastKey("toast.needGoal", undefined, true);
    return;
  }
  const res = await runBusy(() =>
    api.createRequirement({
      goal,
      ...(sandboxOpts?.tier ? { tier: sandboxOpts.tier } : {}),
      ...(createGitHubIssue !== undefined ? { createGitHubIssue } : {}),
      ...(sandboxOpts?.createSandbox ? { createSandbox: true } : {}),
      ...(sandboxOpts?.stackedOnReqId ? { stackedOnReqId: sandboxOpts.stackedOnReqId } : {}),
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    }),
  );
  if (res) {
    ui.closeModal(modalInstanceId);
    ui.setSelectedId(res.detail.state.id);
    ui.setWorkspaceTab("spec");
    if (res.githubWarning) {
      ui.showToastKey(
        "toast.createdWithIssueWarn",
        {
          id: res.detail.state.id,
          warning: resolveWarningParam(res.githubWarning, res.githubWarningRef),
        },
        true,
      );
    } else if (!dispatchAgent) {
      if (res.detail.state.github?.issue) {
        ui.showToastKey("toast.createdIssue", {
          id: res.detail.state.id,
          number: res.detail.state.github.issue.number,
        });
      } else {
        ui.showToastKey("toast.created", { id: res.detail.state.id });
      }
    }
    await invalidateAllWorkbenchQueries();
    if (dispatchAgent) {
      await triggerActiveRun(res.detail.state.id, "design");
    }
  }
}

export async function submitImportGitHubIssue(issueRefRaw: string, dispatchAgent: boolean): Promise<void> {
  const issueRef = issueRefRaw.trim();
  const ui = useUiStore.getState();
  const modalInstanceId = ui.modalInstanceId;
  if (!issueRef) {
    ui.showToastKey("toast.needIssueRef", undefined, true);
    return;
  }
  const res = await runBusy(() =>
    api.importGitHubIssue({
      provider: "github",
      issueRef,
    }),
  );
  if (res) {
    ui.closeModal(modalInstanceId);
    ui.setSelectedId(res.detail.state.id);
    ui.setWorkspaceTab("spec");
    await invalidateAllWorkbenchQueries();
    const issueNumber =
      "number" in res.issue ? res.issue.number : (res.detail.state.github?.issue?.number ?? "");
    if (res.alreadyExisted) {
      ui.showToastKey("toast.issueLinkedExisting", {
        number: issueNumber,
        id: res.detail.state.id,
      });
      return;
    }
    if (dispatchAgent) {
      await triggerActiveRun(res.detail.state.id, "design");
    } else {
      ui.showToastKey("toast.createdFromIssue", {
        number: issueNumber,
        id: res.detail.state.id,
      });
    }
  }
}

export async function submitImportGiteeIssue(opts: {
  issue?: GiteeIssueItem | null;
  issueRef?: string;
  dispatchAgent: boolean;
}): Promise<void> {
  const ui = useUiStore.getState();
  const modalInstanceId = ui.modalInstanceId;
  const issueRef = opts.issueRef?.trim() ?? "";
  if (!opts.issue && !issueRef) {
    ui.showToastKey("gitee.toastNeedRef", undefined, true);
    return;
  }
  const res = await runBusy(() =>
    api.importGitHubIssue({
      provider: "gitee",
      ...(opts.issue ? { giteeIssue: opts.issue } : { issueRef }),
    }),
  );
  if (res) {
    ui.closeModal(modalInstanceId);
    ui.setSelectedId(res.detail.state.id);
    ui.setWorkspaceTab("spec");
    await invalidateAllWorkbenchQueries();
    const ident = String(res.detail.state.github?.issue?.number ?? opts.issue?.ident ?? issueRef);
    if (res.alreadyExisted) {
      ui.showToastKey("gitee.toastLinkedExisting", { ident, id: res.detail.state.id });
      return;
    }
    if (opts.dispatchAgent) {
      await triggerActiveRun(res.detail.state.id, "design");
    } else {
      ui.showToastKey("gitee.toastCreated", { ident, id: res.detail.state.id });
    }
  }
}

export async function submitFeedback(detail: RequirementDetail, feedbackRaw: string, dispatchAgent: boolean): Promise<void> {
  const feedback = feedbackRaw.trim();
  const ui = useUiStore.getState();
  const modalInstanceId = ui.modalInstanceId;
  if (!feedback) {
    ui.showToastKey("toast.needFeedback", undefined, true);
    return;
  }
  if (guardRequirementRunLock(detail.state.id)) return;
  const targetAction: AgentAction = detail.state.stage === "planning" ? "design" : "fix";
  const res = await runBusy(() =>
    api.requestChanges(detail.state.id, {
      feedback,
      expectedRevision: detail.state.revision,
    }),
  );
  if (res) {
    ui.closeModal(modalInstanceId);
    await invalidateAllWorkbenchQueries();
    if (dispatchAgent) {
      await triggerActiveRun(detail.state.id, targetAction, { message: feedback });
    } else {
      ui.showToastKey("toast.changesRecordedFix");
    }
  }
}

export async function submitAcceptOverride(
  detail: RequirementDetail,
  verdict: "pass" | "concern" | "block" | "stale" | "missing",
  reasonRaw: string,
  acceptedRisks: string[],
): Promise<void> {
  const reason = reasonRaw.trim();
  const ui = useUiStore.getState();
  const modalInstanceId = ui.modalInstanceId;
  if (verdict === "block" && !reason) {
    ui.showToastKey("toast.acceptOverrideReasonRequired", undefined, true);
    return;
  }
  if (guardRequirementRunLock(detail.state.id)) return;
  const res = await runBusy(() =>
    api.accept(detail.state.id, {
      expectedRevision: detail.state.revision,
      overrideReason: reason || "已人工确认并接受当前审查风险",
      ...(acceptedRisks.length > 0 ? { acceptedRisks } : {}),
    }),
  );
  if (res) {
    ui.closeModal(modalInstanceId);
    await invalidateAllWorkbenchQueries();
    ui.showToastKey("toast.acceptOverrideDone", { id: detail.state.id });
  }
}

export async function submitLifecycle(
  detail: RequirementDetail,
  action: "cancel" | "reopen",
  reasonRaw: string,
  opts?: { preserveApproval?: boolean },
): Promise<void> {
  const reason = reasonRaw.trim();
  const ui = useUiStore.getState();
  const modalInstanceId = ui.modalInstanceId;
  if (!reason) {
    ui.showToastKey("toast.needReason", undefined, true);
    return;
  }
  if (guardRequirementRunLock(detail.state.id)) return;
  const res = await runBusy(async () => {
    if (action === "cancel") return api.cancel(detail.state.id, { reason, expectedRevision: detail.state.revision });
    return api.reopen(detail.state.id, {
      reason,
      ...(opts?.preserveApproval ? { preserveApproval: true } : {}),
      expectedRevision: detail.state.revision,
    });
  });
  if (res) {
    ui.closeModal(modalInstanceId);
    await invalidateAllWorkbenchQueries();
    ui.showToastKey("toast.lifecycleUpdated");
  }
}

export async function submitAnnotation(
  reqId: string,
  anchor: string,
  messageRaw: string,
  mode: "ask" | "refine",
): Promise<void> {
  const msg = messageRaw.trim();
  const ui = useUiStore.getState();
  const modalInstanceId = ui.modalInstanceId;
  const draft = useDraftStore.getState();
  if (!msg) {
    ui.showToastKey("toast.needAnnotation", undefined, true);
    return;
  }
  if (mode === "ask") {
    // 触发现有执行器的同需求调度名额，运行期间暂停并保留弹窗输入。
    if (guardRequirementRunLock(reqId)) return;
    // 先等待调度请求结束再关闭弹窗，确保当前按钮在缓慢响应期间仍可见并展示 loading。
    await triggerActiveRun(reqId, "ask", { message: msg, anchor, mode: "ask" });
    ui.closeModal(modalInstanceId);
    ui.setDrawerOpen(true);
    ui.setDrawerTab("discuss");
  } else {
    const out = await runBusy(() => api.addDiscussion(reqId, { mode: "refine", anchor, message: msg }));
    if (out) {
      draft.addPendingAnnotation({ id: out.entry.id, anchor, message: msg });
      ui.closeModal(modalInstanceId);
      ui.setDrawerOpen(true);
      ui.setDrawerTab("discuss");
      ui.showToastKey("toast.annotationQueued");
      await queryClient.invalidateQueries({ queryKey: ["requirement"] });
    }
  }
}

export async function runAskFromDrawer(reqId: string): Promise<void> {
  const draft = useDraftStore.getState();
  const ui = useUiStore.getState();
  const msg = draft.discussDraft.trim();
  if (!msg) {
    ui.showToastKey("toast.needQuestion", undefined, true);
    return;
  }
  // 先复查运行状态，避免拦截时清空用户草稿。
  if (guardRequirementRunLock(reqId)) return;
  const anchor = draft.discussAnchor ?? undefined;
  draft.setDiscussDraft("");
  draft.setDiscussAnchor(null);
  await triggerActiveRun(reqId, "ask", { message: msg, anchor, mode: "ask" });
}

function resolveRefineActionForStage(stage?: Stage): "design" | "fix" | "readonly" {
  if (stage === "done" || stage === "cancelled") {
    return "readonly";
  }
  if (stage === "coding") {
    return "fix";
  }
  return "design";
}

function readCachedRequirementStage(reqId: string): Stage | undefined {
  const ui = useUiStore.getState();
  const cached = queryClient.getQueryData<{ detail?: RequirementDetail }>(
    queryKeys.requirement(ui.activeProjectId, reqId),
  );
  return cached?.detail?.state.stage;
}

export async function runRefineFromDrawer(reqId: string): Promise<void> {
  const draft = useDraftStore.getState();
  const ui = useUiStore.getState();
  const stage = readCachedRequirementStage(reqId);
  const targetAction = resolveRefineActionForStage(stage);
  if (targetAction === "readonly") {
    ui.showToastKey("drawer.stageReadonly", undefined, true);
    return;
  }
  const msg = draft.discussDraft.trim();
  const anchorIds = draft.pendingAnnotations.map((a) => a.id);
  const summary =
    msg ||
    (draft.pendingAnnotations.length > 0
      ? `请结合以下 ${draft.pendingAnnotations.length} 条批注${targetAction === "fix" ? "修改代码并验证" : "修订技术方案"}：\n${draft.pendingAnnotations
          .map((a) => `- [${a.anchor}] ${a.message}`)
          .join("\n")}`
      : "");
  if (!summary) {
    ui.showToastKey("toast.needRefine", undefined, true);
    return;
  }
  // 先复查运行状态，避免拦截时清空讨论草稿与排队批注。
  if (guardRequirementRunLock(reqId)) return;
  draft.setDiscussDraft("");
  draft.setDiscussAnchor(null);
  draft.clearPendingAnnotations();
  await triggerActiveRun(reqId, targetAction, { message: summary, anchorIds, mode: "refine", runnerActionKey: "ask" });
}

export async function adoptDiscussion(reqId: string, discId: string, message: string): Promise<void> {
  const ui = useUiStore.getState();
  const stage = readCachedRequirementStage(reqId);
  const targetAction = resolveRefineActionForStage(stage);
  if (targetAction === "readonly") {
    ui.showToastKey("drawer.stageReadonly", undefined, true);
    return;
  }
  if (guardRequirementRunLock(reqId)) return;
  await triggerActiveRun(reqId, targetAction, {
    message:
      targetAction === "fix"
        ? `请采纳此研讨结论并修改代码、运行验证：\n${message}`
        : `请采纳并落实此研讨结论：\n${message}`,
    anchorIds: [discId],
    mode: "refine",
  });
}
