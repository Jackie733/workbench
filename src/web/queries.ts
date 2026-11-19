import { useEffect } from "react";
import { QueryClient, useQuery } from "@tanstack/react-query";
import type { GiteeIssueItem } from "../core/gitee.ts";
import type { AgentAction, AgentRunRecord, RequirementDetail } from "../core/types.ts";
import type { DispatchOutcome } from "../server/index.ts";
import type { SandboxDriftInfo } from "../hub/evolution.ts";
import { api, ApiClientError, connectUiWebSocket, setApiProjectScope, type HubStateResponse } from "./api.ts";
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

export function useWorkbenchWsSync(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const finishedSeen = new Set<string>();
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
            const fallbackNote =
              ev.modelFallback === true
                ? `；请求模型未生效，实际由 ${String(ev.effectiveModel ?? "auto")} 执行`
                : "";
            ui.showToast(`${reqId} 执行完成 (${model})${fallbackNote}`);
          } else if (status === "cancelled") {
            ui.showToast(`${reqId} 已终止执行`);
          } else if (ev.rateLimited) {
            ui.showToast(`${reqId} 模型额度受限，可在右侧抽屉点击「备援模型接力」`, true);
          } else {
            ui.showToast(`${reqId} 执行失败：${String(ev.errorSummary ?? "请查看控制台日志")}`, true);
          }
        }
        void queryClient.invalidateQueries({ queryKey: ["requirement"] });
        void queryClient.invalidateQueries({ queryKey: ["requirements"] });
        void queryClient.invalidateQueries({ queryKey: ["diff"] });
        void queryClient.invalidateQueries({ queryKey: queryKeys.hubState });
        return;
      }

      if (type === "workbench.reload_ui") {
        const tag = document.activeElement?.tagName;
        if (tag === "TEXTAREA" || tag === "INPUT") {
          useUiStore.getState().showToast("工作台前端已热编译更新，完成输入后刷新页面即可生效");
        } else {
          useUiStore.getState().showToast("工作台前端已更新，正在热刷新…");
          setTimeout(() => window.location.reload(), 180);
        }
        return;
      }

      if (type === "workbench.updated" || type === "hub.updated") {
        void queryClient.invalidateQueries();
      }
    });
    return disconnect;
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
      ui.showToast(`${err.message}（已为你刷新最新内容）`, true);
      await invalidateAllWorkbenchQueries();
      return null;
    }
    ui.showToast(err instanceof Error ? err.message : "操作失败", true);
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

export function handleDispatchOutcome(dispatch: DispatchOutcome | null, fallbackTitle: string): void {
  if (!dispatch) return;
  const ui = useUiStore.getState();
  if (dispatch.delivered && dispatch.status === "submitted") {
    ui.showToast("已将任务指令发送给当前 omp 会话");
    return;
  }
  if (dispatch.delivered && dispatch.status === "prefilled") {
    ui.showToast("已将任务指令预填到 omp 输入框");
    return;
  }
  const subtitle =
    dispatch.reason === "draft_conflict"
      ? "检测到 omp 输入框已有未发送草稿，为防覆盖未自动写入，请复制下方指令："
      : dispatch.reason === "source_busy"
        ? "当前 omp 会话正在执行其他任务，请复制下方指令或稍后重试："
        : "当前未连接实时 omp 会话，请复制下方指令或使用上方模型选择器后台自动执行：";
  ui.setModal({ kind: "prompt_fallback", title: fallbackTitle, subtitle, prompt: dispatch.prompt });
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
    ui.showToast(err instanceof Error ? err.message : "读取目录失败", true);
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
    ui.showToast(`${res.target.harness}/${res.target.model}${res.target.reasoningEffort ? ` [${res.target.reasoningEffort}]` : ""} 启动执行 (${action})…`);
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
      handleDispatchOutcome(res.dispatch, "按审查意见修复代码");
    }
    return;
  }
  if (useCli) {
    await triggerActiveRun(id, "fix", { message: feedback });
  } else {
    await runBusy(async () => {
      const out = await api.dispatch(id, { action: "fix" });
      await invalidateAllWorkbenchQueries();
      handleDispatchOutcome(out.dispatch, "按审查意见修复代码");
      return out;
    });
  }
}

export async function syncSandboxBaseAction(reqId: string): Promise<boolean> {
  const ui = useUiStore.getState();
  const res = await runBusy(() => api.syncRsiSandboxBase(reqId));
  if (!res) return false;
  await invalidateAllWorkbenchQueries();
  if (res.upToDate) {
    ui.showToast(`${reqId} 沙箱已与主干保持一致`);
    return true;
  }
  if (res.synced) {
    ui.showToast(`${reqId} 已同步主干最新提交，请复跑验证`);
    return true;
  }
  ui.showToast(`存在 ${res.conflictFiles.length} 个重叠修改文件，需由 Agent 合并同步`, true);
  return false;
}

export async function dispatchSyncBaseWithAgent(
  detail: RequirementDetail,
  drift: SandboxDriftInfo,
  bridgeConnected: boolean,
): Promise<void> {
  const id = detail.state.id;
  const conflicts = drift.conflictFiles.slice(0, 8).join(", ");
  const msg =
    `当前工作目录是需求 ${id} 的隔离 Worktree 沙箱分支 ${drift.branch}（当前基线 ${drift.baseHead.slice(0, 7)}），落后主干目标提交 ${drift.mainHead.slice(0, 7)} 共 ${drift.behindCount} 个提交` +
    (conflicts ? `，重叠冲突文件：${conflicts}` : "") +
    `。本次任务仅聚焦同步主干与解决合并冲突，切勿重复返工已过期的旧审查意见。同步主干步骤：\n` +
    `1. 检查 git status：若存在未提交业务/测试改动，使用 git add -u 与显式业务文件路径暂存后 git commit -m "chore(${id}): wip before base sync"（或 git stash）保存当前进度；严禁提交 node_modules 或临时目录；\n` +
    `2. 执行 git merge --no-edit ${drift.mainHead}，手工解决冲突并保留当前需求全部功能与主干新增改动，完成后提交合并（若 stash 过请 pop）；\n` +
    `3. 运行 wb verify ${id} --all 与 wb tasks ${id} --ready（提交验收状态）。`;
  const useCli = shouldUseCliRunner("fix");
  if (detail.state.stage === "awaiting_acceptance" || detail.state.stage === "implementing") {
    const res = await runBusy(() =>
      api.requestChanges(id, {
        feedback: msg,
        expectedRevision: detail.state.revision,
        dispatchAgent: !useCli && bridgeConnected,
      }),
    );
    if (!res) return;
    await invalidateAllWorkbenchQueries();
    if (useCli) {
      await triggerActiveRun(id, "fix", { message: msg });
    } else {
      handleDispatchOutcome(res.dispatch, "同步主干并解决冲突");
    }
  } else if (useCli) {
    await triggerActiveRun(id, "fix", { message: msg });
  }
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
        handleDispatchOutcome(out.dispatch, "发送给 Agent 整理方案");
        return out;
      });
      break;
    }
    case "approve":
    case "approve_only": {
      const res = await runBusy(() => api.approve(id, { expectedRevision: rev, dispatchAgent: false }));
      if (res) {
        await invalidateAllWorkbenchQueries();
        ui.showToast(`${id} 方案已批准`);
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
          handleDispatchOutcome(res.dispatch, "批准并开始实施");
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
          handleDispatchOutcome(res.dispatch, "授权直接实施 (Fast-Track)");
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
        handleDispatchOutcome(out.dispatch, "开始实施指令");
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
        handleDispatchOutcome(out.dispatch, "修复失败项指令");
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
        handleDispatchOutcome(out.dispatch, "发起跨模型审查");
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
        ui.showToast(`验证执行完成：${passed}/${res.runs.length} 条命令通过`, passed < res.runs.length);
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
        ui.showToast(`${id} 已验收完成`);
      }
      break;
    }
    case "unblock": {
      const res = await runBusy(() => api.unblock(id, { expectedRevision: rev }));
      if (res) {
        await invalidateAllWorkbenchQueries();
        ui.showToast("已解除阻塞");
      }
      break;
    }
    case "reopen":
      ui.setModal({ kind: "lifecycle", action: "reopen", reason: "" });
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
    ui.showToast(err instanceof Error ? err.message : "读取日志失败", true);
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
  useUiStore.getState().showToast("已发送终止指令");
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
    ui.showToast("工作台初始化完成");
  }
}

export async function submitNewRequirement(
  goalRaw: string,
  dispatchAgent: boolean,
  _bridgeConnected: boolean,
  createGitHubIssue?: boolean,
  attachmentIds: string[] = [],
): Promise<void> {
  const goal = goalRaw.trim();
  const ui = useUiStore.getState();
  if (!goal) {
    ui.showToast("请先输入需求描述", true);
    return;
  }
  const useCli = dispatchAgent && shouldUseCliRunner("design");
  const res = await runBusy(() =>
    api.createRequirement({
      goal,
      dispatchAgent: dispatchAgent && !useCli,
      ...(createGitHubIssue !== undefined ? { createGitHubIssue } : {}),
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    }),
  );
  if (res) {
    ui.setModal(null);
    ui.setSelectedId(res.detail.state.id);
    ui.setWorkspaceTab("spec");
    await invalidateAllWorkbenchQueries();
    if (res.githubWarning) {
      ui.showToast(`需求 ${res.detail.state.id} 已创建（GitHub Issue 未同步：${res.githubWarning}）`, true);
    }
    if (dispatchAgent) {
      if (useCli) {
        await triggerActiveRun(res.detail.state.id, "design");
      } else {
        handleDispatchOutcome(res.dispatch, "新建需求并发送给 Agent");
      }
    } else if (!res.githubWarning) {
      const issueTag = res.detail.state.github?.issue ? `（已同步 Issue #${res.detail.state.github.issue.number}）` : "";
      ui.showToast(`已创建需求 ${res.detail.state.id}${issueTag}`);
    }
  }
}

export async function submitImportGitHubIssue(issueRefRaw: string, dispatchAgent: boolean): Promise<void> {
  const issueRef = issueRefRaw.trim();
  const ui = useUiStore.getState();
  if (!issueRef) {
    ui.showToast("请输入 GitHub Issue 编号或 URL", true);
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
    if (res.alreadyExisted) {
      ui.showToast(`Issue #${res.detail.state.github?.issue?.number ?? ""} 已关联至现有需求 ${res.detail.state.id}`);
      return;
    }
    if (dispatchAgent) {
      if (useCli) {
        await triggerActiveRun(res.detail.state.id, "design");
      } else {
        handleDispatchOutcome(res.dispatch ?? null, "导入 Issue 并发送给 Agent");
      }
    } else {
      ui.showToast(`已从 Issue #${res.detail.state.github?.issue?.number ?? ""} 创建需求 ${res.detail.state.id}`);
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
    ui.showToast("请先选择一条 Gitee 工作项，或输入工作项编号 / URL", true);
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
    const ident = res.detail.state.github?.issue?.number ?? opts.issue?.ident ?? issueRef;
    if (res.alreadyExisted) {
      ui.showToast(`工作项 #${ident} 已关联至现有需求 ${res.detail.state.id}`);
      return;
    }
    if (opts.dispatchAgent) {
      if (useCli) {
        await triggerActiveRun(res.detail.state.id, "design");
      } else {
        handleDispatchOutcome(res.dispatch ?? null, "导入工作项并发送给 Agent");
      }
    } else {
      ui.showToast(`已从 Gitee 工作项 #${ident} 创建需求 ${res.detail.state.id}`);
    }
  }
}

export async function submitFeedback(detail: RequirementDetail, feedbackRaw: string, dispatchAgent: boolean): Promise<void> {
  const feedback = feedbackRaw.trim();
  const ui = useUiStore.getState();
  if (!feedback) {
    ui.showToast("请填写修改建议", true);
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
        handleDispatchOutcome(res.dispatch, targetAction === "design" ? "要求修订方案指令" : "要求修复代码指令");
      }
    } else {
      ui.showToast("已退回修改并记录反馈");
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
    ui.showToast("当前审查存在阻塞项，忽略阻塞并验收必须填写原因", true);
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
    ui.showToast(`${detail.state.id} 已记录风险说明并验收完成`);
  }
}

export async function submitLifecycle(
  detail: RequirementDetail,
  action: "block" | "cancel" | "reopen",
  reasonRaw: string,
): Promise<void> {
  const reason = reasonRaw.trim();
  const ui = useUiStore.getState();
  if (!reason) {
    ui.showToast("请填写原因", true);
    return;
  }
  const res = await runBusy(async () => {
    if (action === "block") return api.block(detail.state.id, { reason, expectedRevision: detail.state.revision });
    if (action === "cancel") return api.cancel(detail.state.id, { reason, expectedRevision: detail.state.revision });
    return api.reopen(detail.state.id, { reason, expectedRevision: detail.state.revision });
  });
  if (res) {
    ui.setModal(null);
    await invalidateAllWorkbenchQueries();
    ui.showToast("需求状态已更新");
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
    ui.showToast("请输入批注或问题内容", true);
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
      ui.showToast("批注已加入待发送列表，可在右侧统一「采纳批注并让 Agent 修订」");
      await queryClient.invalidateQueries({ queryKey: ["requirement"] });
    }
  }
}

export async function runAskFromDrawer(reqId: string): Promise<void> {
  const draft = useDraftStore.getState();
  const ui = useUiStore.getState();
  const msg = draft.discussDraft.trim();
  if (!msg) {
    ui.showToast("请先输入要探讨的问题", true);
    return;
  }
  const anchor = draft.discussAnchor ?? undefined;
  draft.setDiscussDraft("");
  draft.setDiscussAnchor(null);
  await triggerActiveRun(reqId, "ask", { message: msg, anchor, mode: "ask" });
}

export async function runRefineFromDrawer(reqId: string): Promise<void> {
  const draft = useDraftStore.getState();
  const ui = useUiStore.getState();
  const msg = draft.discussDraft.trim();
  const anchorIds = draft.pendingAnnotations.map((a) => a.id);
  const summary =
    msg ||
    (draft.pendingAnnotations.length > 0
      ? `请结合以下 ${draft.pendingAnnotations.length} 条批注修订技术方案：\n${draft.pendingAnnotations
          .map((a) => `- [${a.anchor}] ${a.message}`)
          .join("\n")}`
      : "");
  if (!summary) {
    ui.showToast("请输入修订要求或先添加章节批注", true);
    return;
  }
  draft.setDiscussDraft("");
  draft.setDiscussAnchor(null);
  draft.clearPendingAnnotations();
  await triggerActiveRun(reqId, "design", { message: summary, anchorIds, mode: "refine", runnerActionKey: "ask" });
}

export async function adoptDiscussion(reqId: string, discId: string, message: string): Promise<void> {
  await triggerActiveRun(reqId, "design", {
    message: `请采纳并落实此研讨结论：\n${message}`,
    anchorIds: [discId],
    mode: "refine",
  });
}
