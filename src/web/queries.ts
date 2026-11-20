import { useEffect } from "react";
import { QueryClient, useQuery } from "@tanstack/react-query";
import type { GiteeIssueItem } from "../core/gitee.ts";
import type { AgentAction, AgentRunRecord, CascadeSyncItemResult, RequirementDetail, SandboxDriftInfo, Stage } from "../core/types.ts";
import type { DispatchOutcome } from "../server/index.ts";
import { api, ApiClientError, connectUiWebSocket, setApiProjectScope, type HubStateResponse } from "./api.ts";
import { resolveWarningParam, type MessageKey } from "./i18n.ts";
import { activeRunnerChoice, formatReviewFixFeedback, getModelEffortCapability, type Scope } from "./state.ts";
import { useDraftStore } from "./stores/draftStore.ts";
import { useStreamStore } from "./stores/streamStore.ts";
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
  evolution: ["hub", "evolution"] as const,
  playbook: (projectId: string | null) => ["playbook", projectId] as const,
  project: (projectId: string | null) => ["project", projectId] as const,
  projectSandboxes: (projectId: string | null) => ["project", "sandboxes", projectId] as const,
  githubStatus: (projectId: string | null) => ["github", "status", projectId] as const,
  giteeStatus: (projectId: string | null) => ["gitee", "status", projectId] as const,
  giteeIssues: (projectId: string | null, filter: string, state: string, q: string) =>
    ["gitee", "issues", projectId, filter, state, q] as const,
  requirements: (projectId: string | null, scope: Scope) => ["requirements", projectId, scope] as const,
  requirement: (projectId: string | null, id: string | null) => ["requirement", projectId, id] as const,
  diff: (projectId: string | null, id: string | null, live = false) => ["diff", projectId, id, live ? "live" : "default"] as const,
  delivery: (projectId: string | null, id: string | null) => ["delivery", projectId, id] as const,
};

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

export function useEvolutionQuery(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.evolution,
    queryFn: () => api.getEvolution(),
    enabled,
  });
}

export function usePlaybookQuery(activeProjectId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.playbook(activeProjectId),
    queryFn: () => api.getPlaybook(),
    enabled,
  });
}

export function useHubStateQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.hubState,
    queryFn: async () => {
      const hub = await api.getHubState();
      useStreamStore.getState().syncActiveRuns(hub.activeRuns);
      const ui = useUiStore.getState();
      if (hub.hubMode) {
        const currentValid = Boolean(ui.activeProjectId && hub.projects.some((p) => p.id === ui.activeProjectId));
        if (!currentValid) {
          const nextId = hub.activeProjectId ?? hub.projects[0]?.id ?? null;
          if (ui.activeProjectId !== nextId) {
            setApiProjectScope(nextId);
            ui.setActiveProjectId(nextId);
          }
        }
      }
      return hub;
    },
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
  return useQuery({
    queryKey: queryKeys.requirements(activeProjectId, scope),
    queryFn: () => api.listRequirements(scope),
    enabled,
  });
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

    const disconnect = connectUiWebSocket((ev) => {
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

      if (type === "agent.run.finished") {
        const runId = typeof ev.runId === "string" ? ev.runId : "";
        if (!runId) return;
        useStreamStore.getState().markRunFinished(runId);
        if (!finishedSeen.has(runId)) {
          finishedSeen.add(runId);
          const status = ev.status as AgentRunRecord["status"] | undefined;
          const reqId = typeof ev.requirementId === "string" ? ev.requirementId : "";
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
        return;
      }

      if (type === "workbench.reload_ui") {
        requestReload(ev.manual === true);
        return;
      }

      if (type === "workbench.updated" || type === "hub.updated") {
        void queryClient.invalidateQueries();
      }
    });
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

export function shouldUseCliRunner(action?: AgentAction): boolean {
  const hub = queryClient.getQueryData<HubStateResponse>(queryKeys.hubState);
  const draft = useDraftStore.getState();
  const key = action ? (draft.runnerOverrides[action]?.key ?? "") : draft.selectedRunnerKey;
  if (key === "manual_copy") return false;
  if (hub?.hubMode) return hub.harnesses.some((h) => h.installed) || key !== "";
  return Boolean(key && key !== "manual_copy");
}

export function handleDispatchOutcome(dispatch: DispatchOutcome | null, fallbackTitle: MessageKey): void {
  if (!dispatch) return;
  const ui = useUiStore.getState();
  if (dispatch.delivered && dispatch.status === "submitted") {
    ui.showToastKey("toast.dispatchSubmitted");
    return;
  }
  if (dispatch.delivered && dispatch.status === "prefilled") {
    ui.showToastKey("toast.dispatchPrefilled");
    return;
  }
  const subtitleKey =
    dispatch.reason === "draft_conflict"
      ? "fallback.subtitle.draft"
      : dispatch.reason === "source_busy"
        ? "fallback.subtitle.busy"
        : "fallback.subtitle.offline";
  ui.setModal({
    kind: "prompt_fallback",
    titleKey: fallbackTitle,
    subtitleKey,
    prompt: dispatch.prompt,
  });
}

export async function openRequirement(id: string): Promise<void> {
  const ui = useUiStore.getState();
  if (!ui.selectedId) {
    ui.setHomeScrollY(window.scrollY);
  }
  ui.setSelectedId(id);
  ui.setWorkspaceTab("spec");
  ui.setSelectedDiffFile(null);
  ui.setDesignViewVersion(null);
  ui.setDesignComparePrev(false);
  ui.setDesignCompareText(null);
  ui.clearExpandedLogs();
  useDraftStore.getState().cancelEditSpec();
  useDraftStore.getState().cancelEditDesign();
  useDraftStore.getState().clearRunnerOverrides();
  await queryClient.invalidateQueries({ queryKey: queryKeys.requirement(ui.activeProjectId, id) });
}

export function backHome(): void {
  const ui = useUiStore.getState();
  const savedY = ui.homeScrollY;
  ui.setSelectedId(null);
  ui.setSelectedDiffFile(null);
  useDraftStore.getState().cancelEditSpec();
  useDraftStore.getState().cancelEditDesign();
  void queryClient.invalidateQueries({ queryKey: ["requirements"] });
  requestAnimationFrame(() => window.scrollTo(0, savedY));
}

export async function switchProject(pid: string): Promise<void> {
  const ui = useUiStore.getState();
  ui.setSidebarOpen(false);
  const ok = await runBusy(async () => {
    await api.activateHubProject(pid);
    setApiProjectScope(pid);
    ui.setActiveProjectId(pid);
    ui.setSelectedId(null);
    ui.setSelectedDiffFile(null);
    ui.setQuery("");
    return true;
  });
  if (ok) {
    await invalidateAllWorkbenchQueries();
  }
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
  await api.logout();
  await queryClient.invalidateQueries({ queryKey: queryKeys.authStatus });
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
  const hub = queryClient.getQueryData<HubStateResponse>(queryKeys.hubState);
  const drafts = useDraftStore.getState().runnerOverrides;
  const override =
    opts?.runnerActionKey && drafts[opts.runnerActionKey]?.key ? drafts[opts.runnerActionKey] : drafts[action];
  const selectedRunnerKey = override?.key ?? "";
  const selectedEffort = override?.effort ?? "";
  const choice = activeRunnerChoice(selectedRunnerKey, hub?.routing ?? null, action, selectedEffort);
  const effortCap = getModelEffortCapability(hub?.harnesses ?? [], choice.harness, choice.model);
  const effectiveEffort =
    effortCap.mode === "configurable"
      ? choice.effort && effortCap.efforts.includes(choice.effort)
        ? choice.effort
        : undefined
      : undefined;
  const ui = useUiStore.getState();

  const res = await runBusy(async () => {
    return api.startAgentRun(reqId, {
      action,
      harness: selectedRunnerKey && selectedRunnerKey !== "manual_copy" ? choice.harness : undefined,
      model: selectedRunnerKey && selectedRunnerKey !== "manual_copy" ? choice.model : undefined,
      reasoningEffort: effectiveEffort,
      message: opts?.message,
      anchor: opts?.anchor,
      anchorIds: opts?.anchorIds,
      mode: opts?.mode,
      useFallback: opts?.useFallback,
    });
  });

  if (res) {
    useStreamStore.getState().setRunStarted({ ...res.run, requirementId: reqId });
    ui.setDrawerOpen(true);
    ui.setDrawerTab(action === "ask" ? "discuss" : "console");
    ui.showToastKey("toast.runStarted", {
      target: `${res.target.harness}/${res.target.model}${res.target.reasoningEffort ? ` [${res.target.reasoningEffort}]` : ""}`,
      action,
    });
    await queryClient.invalidateQueries({ queryKey: ["requirement"] });
    await queryClient.invalidateQueries({ queryKey: queryKeys.hubState });
  }
}

export async function executeVerify(id: string, body: Parameters<typeof api.verify>[1]) {
  return runBusy(async () => {
    const out = await api.verify(id, body);
    await queryClient.invalidateQueries({ queryKey: ["requirement"] });
    await queryClient.invalidateQueries({ queryKey: ["requirements"] });
    return out;
  });
}

export async function captureUiScreenshots(id: string, label?: string) {
  return runBusy(async () => {
    const out = await api.captureScreenshots(id, label);
    await queryClient.invalidateQueries({ queryKey: ["requirement"] });
    await queryClient.invalidateQueries({ queryKey: ["requirements"] });
    return out;
  });
}

export async function dispatchFixFromReview(
  detail: RequirementDetail,
  bridgeConnected: boolean,
  opts?: { selectedFindingIds?: string[] },
): Promise<void> {
  const id = detail.state.id;
  const report = detail.state.reviewReport;
  const feedback = report
    ? formatReviewFixFeedback(report, opts?.selectedFindingIds)
    : "请根据最新跨模型 Code Review 意见定位修复问题，并重跑全量验证。";
  const useCli = shouldUseCliRunner("fix");
  const canMoveStage = detail.state.stage === "awaiting_acceptance" || detail.state.stage === "implementing";
  if (canMoveStage) {
    const res = await runBusy(() =>
      api.requestChanges(id, {
        feedback,
        expectedRevision: detail.state.revision,
        dispatchAgent: !useCli && bridgeConnected,
      }),
    );
    if (!res) return;
    await invalidateAllWorkbenchQueries();
    if (useCli) {
      await triggerActiveRun(id, "fix", { message: feedback });
    } else {
      handleDispatchOutcome(res.dispatch, "fallback.title.fixReview");
    }
    return;
  }
  if (useCli) {
    await triggerActiveRun(id, "fix", { message: feedback });
  } else {
    await runBusy(async () => {
      const out = await api.dispatch(id, { action: "fix" });
      await invalidateAllWorkbenchQueries();
      handleDispatchOutcome(out.dispatch, "fallback.title.fixReview");
      return out;
    });
  }
}

export async function syncSandboxBaseAction(
  reqId: string,
  options: { fetchRemote?: boolean; useEvolutionHub?: boolean } = {},
): Promise<boolean> {
  const ui = useUiStore.getState();
  const res = await runBusy(() =>
    options.useEvolutionHub
      ? api.syncRsiSandboxBase(reqId)
      : api.syncSandboxBase(reqId, { fetchRemote: options.fetchRemote !== false }),
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
  bridgeConnected: boolean,
): Promise<void> {
  const id = detail.state.id;
  const ui = useUiStore.getState();
  const conflicts = drift.conflictFiles.slice(0, 8).join(", ");
  const targetLabel = drift.targetRef ?? drift.mainHead.slice(0, 7);
  const msg =
    `当前工作目录是需求 ${id} 的隔离 Worktree 沙箱分支 ${drift.branch}（当前基线 ${drift.baseHead.slice(0, 7)}），落后主干目标 ${targetLabel} 共 ${drift.behindCount} 个提交` +
    (conflicts ? `，真实冲突文件：${conflicts}` : "") +
    `。本次任务仅聚焦同步主干与解决合并冲突，切勿重复返工已通过的功能或已过期的旧审查意见。同步步骤：\n` +
    `1. 检查 git status：若存在未提交业务/测试改动，使用 git add -u 与显式业务文件路径暂存后 git commit -m "chore(${id}): wip before base sync"（或 git stash）保存当前进度；严禁提交 node_modules 或临时目录；\n` +
    `2. 执行 git merge --no-edit ${drift.mainHead}，手工解决冲突并保留当前需求全部功能与主干新增改动，完成后提交合并（若 stash 过请 pop）；\n` +
    `3. 运行 wb verify ${id} --all 与 wb tasks ${id} --ready（提交验收状态）。`;
  const useCli = shouldUseCliRunner("fix");
  const hub = queryClient.getQueryData<HubStateResponse>(queryKeys.hubState);
  const drafts = useDraftStore.getState().runnerOverrides;
  const override = drafts.fix;
  const selectedRunnerKey = override?.key ?? "";
  const selectedEffort = override?.effort ?? "";
  const choice = activeRunnerChoice(selectedRunnerKey, hub?.routing ?? null, "fix", selectedEffort);
  const effortCap = getModelEffortCapability(hub?.harnesses ?? [], choice.harness, choice.model);
  const effectiveEffort =
    effortCap.mode === "configurable"
      ? choice.effort && effortCap.efforts.includes(choice.effort)
        ? choice.effort
        : undefined
      : undefined;

  const res = await runBusy(() =>
    api.syncResolveSandbox(id, {
      approveFirst: detail.state.stage === "awaiting_approval",
      expectedRevision: detail.state.revision,
      useCli,
      dispatchAgent: !useCli && bridgeConnected,
      harness: useCli && selectedRunnerKey && selectedRunnerKey !== "manual_copy" ? choice.harness : undefined,
      model: useCli && selectedRunnerKey && selectedRunnerKey !== "manual_copy" ? choice.model : undefined,
      reasoningEffort: useCli ? effectiveEffort : undefined,
      message: msg,
    }),
  );
  if (!res) return;
  if (res.run && res.target) {
    useStreamStore.getState().setRunStarted({ ...res.run, requirementId: id });
    ui.setDrawerOpen(true);
    ui.setDrawerTab("console");
    ui.showToastKey("toast.runStarted", {
      target: `${res.target.harness}/${res.target.model}${res.target.reasoningEffort ? ` [${res.target.reasoningEffort}]` : ""}`,
      action: "fix",
    });
  } else if (res.dispatch) {
    handleDispatchOutcome(res.dispatch, "fallback.title.syncBase");
  }
  await invalidateAllWorkbenchQueries();
}

export async function handleBannerAction(detail: RequirementDetail, actionId: string, bridgeConnected: boolean): Promise<void> {
  const id = detail.state.id;
  const rev = detail.state.revision;
  const ui = useUiStore.getState();

  switch (actionId) {
    case "dispatch_design": {
      if (shouldUseCliRunner("design")) {
        await triggerActiveRun(id, "design");
        break;
      }
      await runBusy(async () => {
        const out = await api.dispatch(id, { action: "design" });
        await invalidateAllWorkbenchQueries();
        handleDispatchOutcome(out.dispatch, "fallback.title.design");
        return out;
      });
      break;
    }
    case "approve":
    case "approve_only": {
      const res = await runBusy(() => api.approve(id, { expectedRevision: rev, dispatchAgent: false }));
      if (res) {
        await invalidateAllWorkbenchQueries();
        ui.showToastKey("toast.approved", { id });
      }
      break;
    }
    case "approve_and_implement": {
      const useCli = shouldUseCliRunner("implement");
      const res = await runBusy(() =>
        api.approve(id, {
          expectedRevision: rev,
          dispatchAgent: !useCli,
        }),
      );
      if (res) {
        await invalidateAllWorkbenchQueries();
        if (useCli) {
          await triggerActiveRun(id, "implement");
        } else {
          handleDispatchOutcome(res.dispatch, "fallback.title.approve");
        }
      }
      break;
    }
    case "fast_track":
    case "authorize_fast_track": {
      const useCli = shouldUseCliRunner("implement");
      const res = await runBusy(() =>
        api.fastTrack(id, {
          expectedRevision: rev,
          dispatchAgent: !useCli && bridgeConnected,
        }),
      );
      if (res) {
        await invalidateAllWorkbenchQueries();
        if (useCli) {
          await triggerActiveRun(id, "implement");
        } else {
          handleDispatchOutcome(res.dispatch, "fallback.title.fastTrack");
        }
      }
      break;
    }
    case "dispatch_implement": {
      if (shouldUseCliRunner("implement")) {
        await triggerActiveRun(id, "implement");
        break;
      }
      await runBusy(async () => {
        const out = await api.dispatch(id, { action: "implement" });
        await invalidateAllWorkbenchQueries();
        handleDispatchOutcome(out.dispatch, "fallback.title.implement");
        return out;
      });
      break;
    }
    case "dispatch_fix": {
      if (shouldUseCliRunner("fix")) {
        await triggerActiveRun(id, "fix");
        break;
      }
      await runBusy(async () => {
        const out = await api.dispatch(id, { action: "fix" });
        await invalidateAllWorkbenchQueries();
        handleDispatchOutcome(out.dispatch, "fallback.title.fix");
        return out;
      });
      break;
    }
    case "dispatch_review": {
      if (shouldUseCliRunner("review")) {
        await triggerActiveRun(id, "review");
        break;
      }
      await runBusy(async () => {
        const out = await api.dispatch(id, { action: "review" });
        await invalidateAllWorkbenchQueries();
        handleDispatchOutcome(out.dispatch, "fallback.title.dispatchReview");
        return out;
      });
      break;
    }
    case "dispatch_fix_review": {
      await dispatchFixFromReview(detail, bridgeConnected);
      break;
    }
    case "sync_base": {
      await syncSandboxBaseAction(id);
      break;
    }
    case "request_changes": {
      const targetAction: AgentAction =
        detail.state.stage === "awaiting_approval" || detail.state.stage === "draft" || detail.state.stage === "designing"
          ? "design"
          : "fix";
      ui.setModal({
        kind: "feedback",
        feedback: "",
        dispatchAgent: shouldUseCliRunner(targetAction) || bridgeConnected,
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
    case "accept": {
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
    case "unblock": {
      const res = await runBusy(() => api.unblock(id, { expectedRevision: rev }));
      if (res) {
        await invalidateAllWorkbenchQueries();
        ui.showToastKey("toast.unblocked");
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
  stream.setSelectedRunId(runId);
  ui.setDrawerOpen(true);
  ui.setDrawerTab("console");
  if (stream.liveRunLogs[runId] === undefined) {
    try {
      const res = await api.getAgentRunLog(reqId, runId);
      stream.setRunLogFull(runId, res.log);
    } catch {
      // ignore missing log
    }
  }
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
  _bridgeConnected: boolean,
  createGitHubIssue?: boolean,
  attachmentIds: string[] = [],
  sandboxOpts?: { createSandbox?: boolean; stackedOnReqId?: string },
): Promise<void> {
  const goal = goalRaw.trim();
  const ui = useUiStore.getState();
  if (!goal) {
    ui.showToastKey("toast.needGoal", undefined, true);
    return;
  }
  const useCli = dispatchAgent && shouldUseCliRunner("design");
  const res = await runBusy(() =>
    api.createRequirement({
      goal,
      dispatchAgent: dispatchAgent && !useCli,
      ...(createGitHubIssue !== undefined ? { createGitHubIssue } : {}),
      ...(sandboxOpts?.createSandbox ? { createSandbox: true } : {}),
      ...(sandboxOpts?.stackedOnReqId ? { stackedOnReqId: sandboxOpts.stackedOnReqId } : {}),
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    }),
  );
  if (res) {
    ui.setModal(null);
    ui.setSelectedId(res.detail.state.id);
    ui.setWorkspaceTab("spec");
    await invalidateAllWorkbenchQueries();
    if (res.githubWarning) {
      ui.showToastKey(
        "toast.createdWithIssueWarn",
        {
          id: res.detail.state.id,
          warning: resolveWarningParam(res.githubWarning, res.githubWarningRef),
        },
        true,
      );
    }
    if (dispatchAgent) {
      if (useCli) {
        await triggerActiveRun(res.detail.state.id, "design");
      } else {
        handleDispatchOutcome(res.dispatch, "fallback.title.newReq");
      }
    } else if (!res.githubWarning) {
      if (res.detail.state.github?.issue) {
        ui.showToastKey("toast.createdIssue", {
          id: res.detail.state.id,
          number: res.detail.state.github.issue.number,
        });
      } else {
        ui.showToastKey("toast.created", { id: res.detail.state.id });
      }
    }
  }
}

export async function submitImportGitHubIssue(issueRefRaw: string, dispatchAgent: boolean): Promise<void> {
  const issueRef = issueRefRaw.trim();
  const ui = useUiStore.getState();
  if (!issueRef) {
    ui.showToastKey("toast.needIssueRef", undefined, true);
    return;
  }
  const useCli = dispatchAgent && shouldUseCliRunner("design");
  const res = await runBusy(() =>
    api.importGitHubIssue({
      provider: "github",
      issueRef,
      dispatchAgent: dispatchAgent && !useCli,
    }),
  );
  if (res) {
    ui.setModal(null);
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
      if (useCli) {
        await triggerActiveRun(res.detail.state.id, "design");
      } else {
        handleDispatchOutcome(res.dispatch ?? null, "fallback.title.import");
      }
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
  const issueRef = opts.issueRef?.trim() ?? "";
  if (!opts.issue && !issueRef) {
    ui.showToastKey("gitee.toastNeedRef", undefined, true);
    return;
  }
  const useCli = opts.dispatchAgent && shouldUseCliRunner("design");
  const res = await runBusy(() =>
    api.importGitHubIssue({
      provider: "gitee",
      ...(opts.issue ? { giteeIssue: opts.issue } : { issueRef }),
      dispatchAgent: opts.dispatchAgent && !useCli,
    }),
  );
  if (res) {
    ui.setModal(null);
    ui.setSelectedId(res.detail.state.id);
    ui.setWorkspaceTab("spec");
    await invalidateAllWorkbenchQueries();
    const ident = String(res.detail.state.github?.issue?.number ?? opts.issue?.ident ?? issueRef);
    if (res.alreadyExisted) {
      ui.showToastKey("gitee.toastLinkedExisting", { ident, id: res.detail.state.id });
      return;
    }
    if (opts.dispatchAgent) {
      if (useCli) {
        await triggerActiveRun(res.detail.state.id, "design");
      } else {
        handleDispatchOutcome(res.dispatch ?? null, "gitee.toastDispatchAction");
      }
    } else {
      ui.showToastKey("gitee.toastCreated", { ident, id: res.detail.state.id });
    }
  }
}

export async function submitFeedback(detail: RequirementDetail, feedbackRaw: string, dispatchAgent: boolean): Promise<void> {
  const feedback = feedbackRaw.trim();
  const ui = useUiStore.getState();
  if (!feedback) {
    ui.showToastKey("toast.needFeedback", undefined, true);
    return;
  }
  const targetAction: AgentAction =
    detail.state.stage === "awaiting_approval" || detail.state.stage === "draft" || detail.state.stage === "designing"
      ? "design"
      : "fix";
  const useCli = dispatchAgent && shouldUseCliRunner(targetAction);
  const res = await runBusy(() =>
    api.requestChanges(detail.state.id, {
      feedback,
      expectedRevision: detail.state.revision,
      dispatchAgent: dispatchAgent && !useCli,
    }),
  );
  if (res) {
    ui.setModal(null);
    await invalidateAllWorkbenchQueries();
    if (dispatchAgent) {
      if (useCli) {
        await triggerActiveRun(detail.state.id, targetAction, { message: feedback });
      } else {
        handleDispatchOutcome(
          res.dispatch,
          targetAction === "design" ? "fallback.title.feedback" : "fallback.title.feedbackFix",
        );
      }
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
  if (verdict === "block" && !reason) {
    ui.showToastKey("toast.acceptOverrideReasonRequired", undefined, true);
    return;
  }
  const res = await runBusy(() =>
    api.accept(detail.state.id, {
      expectedRevision: detail.state.revision,
      overrideReason: reason || "已人工确认并接受当前审查风险",
      ...(acceptedRisks.length > 0 ? { acceptedRisks } : {}),
    }),
  );
  if (res) {
    ui.setModal(null);
    await invalidateAllWorkbenchQueries();
    ui.showToastKey("toast.acceptOverrideDone", { id: detail.state.id });
  }
}

export async function submitLifecycle(
  detail: RequirementDetail,
  action: "block" | "cancel" | "reopen",
  reasonRaw: string,
  opts?: { preserveApproval?: boolean },
): Promise<void> {
  const reason = reasonRaw.trim();
  const ui = useUiStore.getState();
  if (!reason) {
    ui.showToastKey("toast.needReason", undefined, true);
    return;
  }
  const res = await runBusy(async () => {
    if (action === "block") return api.block(detail.state.id, { reason, expectedRevision: detail.state.revision });
    if (action === "cancel") return api.cancel(detail.state.id, { reason, expectedRevision: detail.state.revision });
    return api.reopen(detail.state.id, {
      reason,
      ...(opts?.preserveApproval ? { preserveApproval: true } : {}),
      expectedRevision: detail.state.revision,
    });
  });
  if (res) {
    ui.setModal(null);
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
  const draft = useDraftStore.getState();
  if (!msg) {
    ui.showToastKey("toast.needAnnotation", undefined, true);
    return;
  }
  if (mode === "ask") {
    ui.setModal(null);
    ui.setDrawerOpen(true);
    ui.setDrawerTab("discuss");
    await triggerActiveRun(reqId, "ask", { message: msg, anchor, mode: "ask" });
  } else {
    const out = await runBusy(() => api.addDiscussion(reqId, { mode: "refine", anchor, message: msg }));
    if (out) {
      draft.addPendingAnnotation({ id: out.entry.id, anchor, message: msg });
      ui.setModal(null);
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
  const anchor = draft.discussAnchor ?? undefined;
  draft.setDiscussDraft("");
  draft.setDiscussAnchor(null);
  await triggerActiveRun(reqId, "ask", { message: msg, anchor, mode: "ask" });
}

function resolveRefineActionForStage(stage?: Stage): "design" | "fix" | "readonly" {
  if (stage === "done" || stage === "cancelled" || stage === "blocked") {
    return "readonly";
  }
  if (stage === "implementing" || stage === "awaiting_acceptance") {
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
  await triggerActiveRun(reqId, targetAction, {
    message:
      targetAction === "fix"
        ? `请采纳此研讨结论并修改代码、运行验证：\n${message}`
        : `请采纳并落实此研讨结论：\n${message}`,
    anchorIds: [discId],
    mode: "refine",
  });
}
