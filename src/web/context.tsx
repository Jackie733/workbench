import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { AgentAction, AgentRunRecord, PrivacyMode } from "../core/types.ts";
import type { BridgeStatus, DispatchOutcome } from "../server/index.ts";
import { api, ApiClientError, connectUiWebSocket, setApiProjectScope } from "./api.ts";
import {
  activeRunnerChoice,
  createInitialState,
  type AppState,
  type DrawerTab,
  type LayoutMode,
  type Scope,
  type WorkspaceTab,
} from "./state.ts";

export interface WorkbenchContextValue {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  showToast: (message: string, isError?: boolean) => void;
  refreshAll: (silent?: boolean) => Promise<void>;
  refreshHubMetadata: (force?: boolean) => Promise<void>;
  openRequirement: (id: string) => Promise<void>;
  backHome: () => Promise<void>;
  switchProject: (pid: string) => Promise<void>;
  openAddProjectModal: () => Promise<void>;
  triggerActiveRun: (
    reqId: string,
    action: AgentAction,
    opts?: {
      message?: string;
      anchor?: string;
      anchorIds?: string[];
      mode?: "ask" | "refine";
      useFallback?: boolean;
    },
  ) => Promise<void>;
  handleBannerAction: (actionId: string) => Promise<void>;
  executeVerify: (id: string, body: Parameters<typeof api.verify>[1]) => Promise<Awaited<ReturnType<typeof api.verify>> | null>;
  runBusy: <T>(fn: () => Promise<T>) => Promise<T | null>;
  shouldUseCliRunner: () => boolean;
  handleDispatchOutcome: (dispatch: DispatchOutcome | null, fallbackTitle: string) => void;
  toggleTheme: () => void;
  setScope: (scope: Scope) => Promise<void>;
  setLayout: (layout: LayoutMode) => void;
  setQuery: (q: string) => void;
  setWorkspaceTab: (tab: WorkspaceTab) => Promise<void>;
  setDrawerOpen: (open: boolean) => void;
  setDrawerTab: (tab: DrawerTab) => void;
  setSelectedRunnerKey: (key: string) => void;
  openHandoff: () => Promise<void>;
  toggleVerificationLog: (vid: string) => Promise<void>;
  refreshDiff: () => Promise<void>;
  openRunConsole: (runId: string) => Promise<void>;
  cancelRun: (runId: string) => Promise<void>;
  initProjectSubmit: () => Promise<void>;
  submitNewRequirement: (goal: string, dispatchAgent: boolean) => Promise<void>;
  submitFeedback: (feedback: string, dispatchAgent: boolean) => Promise<void>;
  submitLifecycle: (action: "block" | "cancel" | "reopen", reason: string) => Promise<void>;
  submitAnnotation: (anchor: string, message: string, mode: "ask" | "refine") => Promise<void>;
  runAskFromDrawer: () => Promise<void>;
  runRefineFromDrawer: () => Promise<void>;
  adoptDiscussion: (discId: string) => Promise<void>;
}

const WorkbenchContext = createContext<WorkbenchContextValue | null>(null);

export function useWorkbench(): WorkbenchContextValue {
  const ctx = useContext(WorkbenchContext);
  if (!ctx) throw new Error("useWorkbench must be used inside WorkbenchProvider");
  return ctx;
}

export function WorkbenchProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AppState>(createInitialState);
  const stateRef = useRef<AppState>(state);
  stateRef.current = state;

  const refreshEpochRef = useRef(0);
  const busyRef = useRef(false);
  const finishedRunIdsRef = useRef(new Set<string>());
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", state.theme);
    localStorage.setItem("wb-theme", state.theme);
  }, [state.theme]);

  const showToast = useCallback((message: string, isError = false) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setState((prev) => ({ ...prev, toast: { message, isError } }));
    toastTimerRef.current = setTimeout(() => {
      setState((prev) => ({ ...prev, toast: null }));
    }, 4000);
  }, []);

  const handleDispatchOutcome = useCallback(
    (dispatch: DispatchOutcome | null, fallbackTitle: string) => {
      if (!dispatch) return;
      if (dispatch.delivered && dispatch.status === "submitted") {
        showToast("已将任务指令发送给当前 omp 会话");
        return;
      }
      if (dispatch.delivered && dispatch.status === "prefilled") {
        showToast("已将任务指令预填到 omp 输入框");
        return;
      }
      const subtitle =
        dispatch.reason === "draft_conflict"
          ? "检测到 omp 输入框已有未发送草稿，为防覆盖未自动写入，请复制下方指令："
          : dispatch.reason === "source_busy"
            ? "当前 omp 会话正在执行其他任务，请复制下方指令或稍后重试："
            : "当前未连接实时 omp 会话，请复制下方指令或使用上方模型下拉选择器后台自动执行：";
      setState((prev) => ({
        ...prev,
        modal: { kind: "prompt_fallback", title: fallbackTitle, subtitle, prompt: dispatch.prompt },
      }));
    },
    [showToast],
  );

  const shouldUseCliRunner = useCallback(() => {
    const s = stateRef.current;
    if (s.selectedRunnerKey === "manual_copy") return false;
    if (s.hubMode) return s.harnesses.some((h) => h.installed) || s.selectedRunnerKey !== "";
    return Boolean(s.selectedRunnerKey && s.selectedRunnerKey !== "manual_copy");
  }, []);

  const refreshHubMetadata = useCallback(async (force = false) => {
    if (stateRef.current.hubLoaded && !force) return;
    try {
      const hub = await api.getHubState();
      const nextActive: Record<string, AgentRunRecord & { requirementId: string }> = {};
      for (const run of hub.activeRuns) {
        nextActive[run.id] = run;
      }
      if (hub.hubMode && !stateRef.current.activeProjectId && hub.activeProjectId) {
        setApiProjectScope(hub.activeProjectId);
      }
      setState((prev) => ({
        ...prev,
        hubMode: hub.hubMode,
        hubLoaded: true,
        hubProjects: hub.projects,
        harnesses: hub.harnesses,
        routing: hub.routing,
        customModels: hub.customModels,
        activeProjectId:
          hub.hubMode && !prev.activeProjectId && hub.activeProjectId ? hub.activeProjectId : prev.activeProjectId,
        activeRuns: nextActive,
      }));
    } catch {
      // Keep resilient in standalone tests without hub metadata.
    }
  }, []);

  const refreshAll = useCallback(
    async (silent = false) => {
      if (busyRef.current) return;
      const epoch = ++refreshEpochRef.current;
      if (!silent && !stateRef.current.project) {
        setState((prev) => ({ ...prev, loading: true }));
      }
      try {
        await refreshHubMetadata();
        if (epoch !== refreshEpochRef.current || busyRef.current) return;

        const proj = await api.getProject();
        if (epoch !== refreshEpochRef.current || busyRef.current) return;

        if (!proj.initialized) {
          setState((prev) => ({
            ...prev,
            project: proj,
            items: [],
            detail: null,
            selectedId: null,
            initName: prev.initName || proj.root.split("/").pop() || "workbench",
            loading: false,
          }));
          return;
        }

        const list = await api.listRequirements(stateRef.current.scope);
        if (epoch !== refreshEpochRef.current || busyRef.current) return;

        let nextDetail = stateRef.current.detail;
        let nextDiff = stateRef.current.diffObs;
        const selectedId = stateRef.current.selectedId;

        if (selectedId) {
          const det = await api.getRequirement(selectedId);
          if (epoch !== refreshEpochRef.current || busyRef.current) return;
          nextDetail = det.detail;
          if (stateRef.current.workspaceTab === "changes") {
            const diffRes = await api.getDiff(selectedId);
            if (epoch !== refreshEpochRef.current || busyRef.current) return;
            nextDiff = diffRes.changes;
          }
        }

        setState((prev) => {
          const prevDesignVer = prev.detail?.state.designVersion ?? 0;
          const designAdvanced =
            nextDetail !== null &&
            nextDetail.state.designVersion > prevDesignVer &&
            nextDetail.designHistoryVersions.length > 1;
          return {
            ...prev,
            project: { ...proj, bridge: list.bridge },
            items: list.items,
            detail: nextDetail,
            diffObs: nextDiff,
            designViewVersion: designAdvanced ? nextDetail!.state.designVersion : prev.designViewVersion,
            designCompareText: designAdvanced ? null : prev.designCompareText,
            loading: false,
          };
        });
      } catch (err) {
        showToast(err instanceof Error ? err.message : "加载工作台失败", true);
        if (epoch === refreshEpochRef.current) {
          setState((prev) => ({ ...prev, loading: false }));
        }
      }
    },
    [refreshHubMetadata, showToast],
  );

  const runBusy = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | null> => {
      if (busyRef.current) return null;
      busyRef.current = true;
      setState((prev) => ({ ...prev, busy: true }));
      try {
        return await fn();
      } catch (err) {
        if (err instanceof ApiClientError && err.code === "revision_conflict") {
          showToast(`${err.message}（已为你刷新最新内容）`, true);
          busyRef.current = false;
          setState((prev) => ({ ...prev, busy: false }));
          await refreshAll(true);
          return null;
        }
        showToast(err instanceof Error ? err.message : "操作失败", true);
        return null;
      } finally {
        busyRef.current = false;
        setState((prev) => ({ ...prev, busy: false }));
      }
    },
    [refreshAll, showToast],
  );

  const openRequirement = useCallback(
    async (id: string) => {
      const epoch = ++refreshEpochRef.current;
      const scrollY = !stateRef.current.selectedId ? window.scrollY : stateRef.current.homeScrollY;
      setState((prev) => ({
        ...prev,
        homeScrollY: scrollY,
        selectedId: id,
        workspaceTab: "spec",
        editingSpec: false,
        editingDesign: false,
        designComparePrev: false,
        designCompareText: null,
        designViewVersion: null,
        moreMenuOpen: false,
        selectedRunnerKey: "",
        pendingAnnotations: [],
        discussAnchor: null,
      }));
      try {
        const res = await api.getRequirement(id);
        if (epoch !== refreshEpochRef.current) return;
        const runs = res.detail.state.agentRuns ?? [];
        const latestRun = runs.length > 0 ? runs[runs.length - 1]! : null;
        setState((prev) => ({
          ...prev,
          detail: res.detail,
          selectedRunId: latestRun ? latestRun.id : prev.selectedRunId,
        }));
        if (latestRun && stateRef.current.liveRunLogs[latestRun.id] === undefined) {
          api
            .getAgentRunLog(id, latestRun.id)
            .then((r) => {
              setState((prev) => ({
                ...prev,
                liveRunLogs: { ...prev.liveRunLogs, [latestRun.id]: r.log },
              }));
            })
            .catch(() => {});
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : "打开需求失败", true);
      }
      if (epoch === refreshEpochRef.current) {
        window.scrollTo(0, 0);
      }
    },
    [showToast],
  );

  const backHome = useCallback(async () => {
    stateRef.current = { ...stateRef.current, selectedId: null, detail: null, diffObs: null };
    setState((prev) => ({
      ...prev,
      selectedId: null,
      detail: null,
      diffObs: null,
      editingSpec: false,
      editingDesign: false,
      moreMenuOpen: false,
    }));
    await refreshAll(true);
  }, [refreshAll]);

  const executeVerify = useCallback(
    async (id: string, body: Parameters<typeof api.verify>[1]) => {
      return runBusy(async () => {
        const out = await api.verify(id, body);
        let nextDiff = stateRef.current.diffObs;
        if (stateRef.current.workspaceTab === "changes") {
          nextDiff = (await api.getDiff(id)).changes;
        }
        setState((prev) => ({ ...prev, detail: out.detail, diffObs: nextDiff }));
        return out;
      });
    },
    [runBusy],
  );

  const triggerActiveRun = useCallback(
    async (
      reqId: string,
      action: AgentAction,
      opts: {
        message?: string;
        anchor?: string;
        anchorIds?: string[];
        mode?: "ask" | "refine";
        useFallback?: boolean;
      } = {},
    ) => {
      const s = stateRef.current;
      const choice = opts.useFallback ? {} : activeRunnerChoice(s.selectedRunnerKey, s.routing, action);
      const res = await runBusy(async () => {
        const out = await api.startAgentRun(reqId, {
          action,
          harness: choice.harness,
          model: choice.model,
          reasoningEffort: choice.effort,
          message: opts.message,
          anchor: opts.anchor,
          anchorIds: opts.anchorIds,
          mode: opts.mode,
          useFallback: opts.useFallback,
        });
        setState((prev) => {
          const prevLog = prev.liveRunLogs[out.run.id] ?? "";
          const header = `$ ${out.target.harness}/${out.target.model} 启动执行 (${action})…\n`;
          const nextLogs = prevLog.startsWith(header)
            ? prev.liveRunLogs
            : { ...prev.liveRunLogs, [out.run.id]: header + prevLog };
          const nextActiveRuns = finishedRunIdsRef.current.has(out.run.id)
            ? prev.activeRuns
            : { ...prev.activeRuns, [out.run.id]: { ...out.run, requirementId: reqId } };
          return {
            ...prev,
            detail: out.detail,
            activeRuns: nextActiveRuns,
            liveRunLogs: nextLogs,
            selectedRunId: out.run.id,
            drawerOpen: true,
            drawerTab: action === "ask" || opts.mode === "refine" ? "discuss" : "console",
          };
        });
        return out;
      });
      if (res) {
        showToast(`已派发 ${res.target.harness}/${res.target.model} 执行`);
        if (finishedRunIdsRef.current.has(res.run.id)) {
          void refreshAll(true);
        }
      }
    },
    [refreshAll, runBusy, showToast],
  );

  const handleBannerAction = useCallback(
    async (actionId: string) => {
      const d = stateRef.current.detail;
      if (!d) return;
      const id = d.state.id;
      const rev = d.state.revision;

      switch (actionId) {
        case "dispatch_design": {
          if (shouldUseCliRunner()) {
            await triggerActiveRun(id, "design");
            break;
          }
          await runBusy(async () => {
            const out = await api.dispatch(id, { action: "design" });
            setState((prev) => ({ ...prev, detail: out.detail }));
            handleDispatchOutcome(out.dispatch, "已生成方案整理指令");
            return out;
          });
          break;
        }
        case "authorize_fast_track": {
          const dispatch = Boolean(stateRef.current.project?.bridge.connected);
          const res = await runBusy(async () => {
            const out = await api.fastTrack(id, { expectedRevision: rev, dispatchAgent: dispatch });
            setState((prev) => ({ ...prev, detail: out.detail, moreMenuOpen: false }));
            if (dispatch && out.dispatch) handleDispatchOutcome(out.dispatch, "快速通道已开启");
            return out;
          });
          if (res && !(dispatch && res.dispatch)) showToast("已开启快速通道，进入实施与验证阶段");
          break;
        }
        case "approve_and_implement": {
          if (shouldUseCliRunner()) {
            const res = await runBusy(async () => {
              const out = await api.approve(id, { expectedRevision: rev, dispatchAgent: false });
              setState((prev) => ({ ...prev, detail: out.detail }));
              return out;
            });
            if (res) await triggerActiveRun(id, "implement");
            break;
          }
          await runBusy(async () => {
            const out = await api.approve(id, { expectedRevision: rev, dispatchAgent: true });
            setState((prev) => ({ ...prev, detail: out.detail }));
            handleDispatchOutcome(out.dispatch, "方案已批准 · 开始实施指令");
            return out;
          });
          break;
        }
        case "approve_only": {
          const res = await runBusy(async () => {
            const out = await api.approve(id, { expectedRevision: rev, dispatchAgent: false });
            setState((prev) => ({ ...prev, detail: out.detail }));
            return out;
          });
          if (res) showToast("已批准方案，可随时选择模型后台执行或发送给会话");
          break;
        }
        case "dispatch_implement": {
          if (shouldUseCliRunner()) {
            await triggerActiveRun(id, "implement");
            break;
          }
          await runBusy(async () => {
            const out = await api.dispatch(id, { action: "implement" });
            setState((prev) => ({ ...prev, detail: out.detail }));
            handleDispatchOutcome(out.dispatch, "开始实施指令");
            return out;
          });
          break;
        }
        case "dispatch_fix": {
          if (shouldUseCliRunner()) {
            await triggerActiveRun(id, "fix");
            break;
          }
          await runBusy(async () => {
            const out = await api.dispatch(id, { action: "fix" });
            setState((prev) => ({ ...prev, detail: out.detail }));
            handleDispatchOutcome(out.dispatch, "修复失败项指令");
            return out;
          });
          break;
        }
        case "request_changes":
          setState((prev) => ({
            ...prev,
            modal: {
              kind: "feedback",
              feedback: "",
              dispatchAgent: shouldUseCliRunner() || Boolean(prev.project?.bridge.connected),
            },
          }));
          break;
        case "run_all_verifications": {
          const res = await executeVerify(id, { all: true });
          if (res) {
            const passed = res.runs.filter((r) => r.passed).length;
            showToast(`验证执行完成：${passed}/${res.runs.length} 条命令通过`, passed < res.runs.length);
          }
          break;
        }
        case "accept": {
          const res = await runBusy(async () => {
            const out = await api.accept(id, { expectedRevision: rev });
            setState((prev) => ({ ...prev, detail: out.detail }));
            return out;
          });
          if (res) showToast(`${id} 已验收完成`);
          break;
        }
        case "unblock": {
          const res = await runBusy(async () => {
            const out = await api.unblock(id, { expectedRevision: rev });
            setState((prev) => ({ ...prev, detail: out.detail }));
            return out;
          });
          if (res) showToast("已解除阻塞");
          break;
        }
        case "reopen":
          setState((prev) => ({ ...prev, modal: { kind: "lifecycle", action: "reopen", reason: "" } }));
          break;
      }
    },
    [executeVerify, handleDispatchOutcome, runBusy, shouldUseCliRunner, showToast, triggerActiveRun],
  );

  const switchProject = useCallback(
    async (pid: string) => {
      setState((prev) => ({ ...prev, sidebarOpen: false }));
      const res = await runBusy(async () => {
        await api.activateHubProject(pid);
        setApiProjectScope(pid);
        stateRef.current = {
          ...stateRef.current,
          activeProjectId: pid,
          selectedId: null,
          detail: null,
          diffObs: null,
          query: "",
        };
        setState((prev) => ({
          ...prev,
          activeProjectId: pid,
          selectedId: null,
          detail: null,
          diffObs: null,
          query: "",
        }));
        return true;
      });
      if (res) {
        await refreshHubMetadata(true);
        await refreshAll(true);
      }
    },
    [refreshAll, refreshHubMetadata, runBusy],
  );

  const openAddProjectModal = useCallback(async () => {
    setState((prev) => ({ ...prev, sidebarOpen: false }));
    try {
      const browse = await api.browseFs();
      setState((prev) => ({
        ...prev,
        modal: {
          kind: "add_project",
          browse,
          pathInput: browse.currentPath,
          nameInput: "",
          initPrivacy: "local",
        },
      }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        modal: { kind: "add_project", browse: null, pathInput: "", nameInput: "", initPrivacy: "local" },
      }));
      showToast(err instanceof Error ? err.message : "读取目录失败", true);
    }
  }, [showToast]);

  const toggleTheme = useCallback(() => {
    setState((prev) => ({ ...prev, theme: prev.theme === "dark" ? "light" : "dark" }));
  }, []);

  const setScope = useCallback(
    async (scope: Scope) => {
      stateRef.current = { ...stateRef.current, scope };
      setState((prev) => ({ ...prev, scope }));
      await refreshAll(true);
    },
    [refreshAll],
  );

  const setLayout = useCallback((layout: LayoutMode) => {
    setState((prev) => ({ ...prev, layout }));
  }, []);

  const setQuery = useCallback((query: string) => {
    setState((prev) => ({ ...prev, query }));
  }, []);

  const setWorkspaceTab = useCallback(
    async (tab: WorkspaceTab) => {
      stateRef.current = { ...stateRef.current, workspaceTab: tab };
      setState((prev) => ({ ...prev, workspaceTab: tab }));
      const sid = stateRef.current.selectedId;
      if (tab === "changes" && sid) {
        try {
          const diff = (await api.getDiff(sid)).changes;
          setState((prev) => ({ ...prev, diffObs: diff }));
        } catch (err) {
          showToast(err instanceof Error ? err.message : "读取 Diff 失败", true);
        }
      }
    },
    [showToast],
  );

  const setDrawerOpen = useCallback((drawerOpen: boolean) => {
    setState((prev) => ({ ...prev, drawerOpen }));
  }, []);

  const setDrawerTab = useCallback((drawerTab: DrawerTab) => {
    setState((prev) => ({ ...prev, drawerTab, drawerOpen: true }));
  }, []);

  const setSelectedRunnerKey = useCallback((selectedRunnerKey: string) => {
    stateRef.current = { ...stateRef.current, selectedRunnerKey };
    setState((prev) => ({ ...prev, selectedRunnerKey }));
  }, []);

  const openHandoff = useCallback(async () => {
    const d = stateRef.current.detail;
    if (!d) return;
    setState((prev) => ({ ...prev, moreMenuOpen: false }));
    await runBusy(async () => {
      const out = await api.getHandoff(d.state.id);
      setState((prev) => ({
        ...prev,
        detail: out.detail,
        modal: { kind: "handoff_preview", markdown: out.markdown },
      }));
      return out;
    });
  }, [runBusy]);

  const toggleVerificationLog = useCallback(
    async (vid: string) => {
      const d = stateRef.current.detail;
      if (!d) return;
      if (stateRef.current.expandedLogs[vid] !== undefined) {
        setState((prev) => {
          const next = { ...prev.expandedLogs };
          delete next[vid];
          return { ...prev, expandedLogs: next };
        });
        return;
      }
      try {
        const res = await api.getEvidence(d.state.id, vid);
        setState((prev) => ({
          ...prev,
          expandedLogs: { ...prev.expandedLogs, [vid]: res.log },
        }));
      } catch (err) {
        showToast(err instanceof Error ? err.message : "读取日志失败", true);
      }
    },
    [showToast],
  );

  const refreshDiff = useCallback(async () => {
    const sid = stateRef.current.selectedId;
    if (!sid) return;
    try {
      const diff = (await api.getDiff(sid)).changes;
      setState((prev) => ({ ...prev, diffObs: diff }));
      showToast("已刷新工作区 Git Diff");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "刷新 Diff 失败", true);
    }
  }, [showToast]);

  const openRunConsole = useCallback(async (runId: string) => {
    const d = stateRef.current.detail;
    if (!d) return;
    setState((prev) => ({
      ...prev,
      selectedRunId: runId,
      drawerOpen: true,
      drawerTab: "console",
    }));
    if (stateRef.current.liveRunLogs[runId] === undefined) {
      try {
        const res = await api.getAgentRunLog(d.state.id, runId);
        setState((prev) => ({ ...prev, liveRunLogs: { ...prev.liveRunLogs, [runId]: res.log } }));
      } catch {
        // ignore missing log
      }
    }
  }, []);

  const cancelRun = useCallback(
    async (runId: string) => {
      const d = stateRef.current.detail;
      if (!d) return;
      await api.cancelAgentRun(d.state.id, runId);
      showToast("已发送终止指令");
    },
    [showToast],
  );

  const initProjectSubmit = useCallback(async () => {
    const { initName, initPrivacy } = stateRef.current;
    const res = await runBusy(async () => {
      await api.initProject({ name: initName.trim() || undefined, privacyMode: initPrivacy });
      return true;
    });
    if (res) {
      await refreshAll(true);
      showToast("工作台初始化完成");
    }
  }, [refreshAll, runBusy, showToast]);

  const submitNewRequirement = useCallback(
    async (goalRaw: string, dispatchAgent: boolean) => {
      const goal = goalRaw.trim();
      if (!goal) {
        showToast("请先输入需求描述", true);
        return;
      }
      const useCli = dispatchAgent && shouldUseCliRunner();
      const res = await runBusy(async () => {
        const out = await api.createRequirement({ goal, dispatchAgent: useCli ? false : dispatchAgent });
        setState((prev) => ({
          ...prev,
          modal: null,
          homeScrollY: window.scrollY,
          selectedId: out.detail.state.id,
          detail: out.detail,
          workspaceTab: "spec",
          diffObs: null,
        }));
        if (dispatchAgent && !useCli) {
          handleDispatchOutcome(out.dispatch, "已创建需求 · 整理方案指令");
        }
        return out;
      });
      if (res) {
        window.scrollTo(0, 0);
        if (useCli) {
          await triggerActiveRun(res.detail.state.id, "design");
        } else if (!dispatchAgent) {
          showToast(`已保存草稿 ${res.detail.state.id}`);
        }
      }
    },
    [handleDispatchOutcome, runBusy, shouldUseCliRunner, showToast, triggerActiveRun],
  );

  const submitFeedback = useCallback(
    async (feedbackRaw: string, dispatchAgent: boolean) => {
      const d = stateRef.current.detail;
      if (!d) return;
      const feedback = feedbackRaw.trim();
      if (!feedback) {
        showToast("请填写修改意见", true);
        return;
      }
      const useCli = dispatchAgent && shouldUseCliRunner();
      const reqId = d.state.id;
      const rev = d.state.revision;
      const res = await runBusy(async () => {
        const out = await api.requestChanges(reqId, {
          feedback,
          expectedRevision: rev,
          dispatchAgent: useCli ? false : dispatchAgent,
        });
        setState((prev) => ({ ...prev, modal: null, detail: out.detail }));
        if (dispatchAgent && !useCli && out.dispatch) {
          handleDispatchOutcome(out.dispatch, "已退回 · 通知 Agent 修改指令");
        }
        return out;
      });
      if (res) {
        if (useCli) {
          await triggerActiveRun(reqId, "design", { mode: "refine", message: feedback });
        } else if (!(dispatchAgent && res.dispatch)) {
          showToast("已退回修改");
        }
      }
    },
    [handleDispatchOutcome, runBusy, shouldUseCliRunner, showToast, triggerActiveRun],
  );

  const submitLifecycle = useCallback(
    async (kind: "block" | "cancel" | "reopen", reasonRaw: string) => {
      const d = stateRef.current.detail;
      if (!d) return;
      const reason = reasonRaw.trim();
      if (!reason) {
        showToast("请填写原因", true);
        return;
      }
      const id = d.state.id;
      const rev = d.state.revision;
      const res = await runBusy(async () => {
        const out = await (kind === "block"
          ? api.block(id, { reason, expectedRevision: rev })
          : kind === "cancel"
            ? api.cancel(id, { reason, expectedRevision: rev })
            : api.reopen(id, { reason, expectedRevision: rev }));
        setState((prev) => ({ ...prev, modal: null, detail: out.detail }));
        return out;
      });
      if (res) showToast("状态已更新");
    },
    [runBusy, showToast],
  );

  const submitAnnotation = useCallback(
    async (anchor: string, msgRaw: string, mode: "ask" | "refine") => {
      const d = stateRef.current.detail;
      if (!d) return;
      const msg = msgRaw.trim();
      if (!msg) {
        showToast("请输入批注或问题内容", true);
        return;
      }
      const reqId = d.state.id;
      if (mode === "ask") {
        setState((prev) => ({ ...prev, modal: null, drawerOpen: true, drawerTab: "discuss" }));
        await triggerActiveRun(reqId, "ask", { message: msg, anchor, mode: "ask" });
        return;
      }
      const res = await runBusy(async () => {
        const out = await api.addDiscussion(reqId, { message: msg, anchor, mode: "refine" });
        const created = out.detail.state.discussions?.slice(-1)[0];
        setState((prev) => ({
          ...prev,
          detail: out.detail,
          modal: null,
          drawerOpen: true,
          drawerTab: "discuss",
          pendingAnnotations: created
            ? [...prev.pendingAnnotations, { id: created.id, anchor, message: msg }]
            : prev.pendingAnnotations,
        }));
        return out;
      });
      if (res) showToast("已加入待提交批注，可继续批注其他段落或统一发给 Agent 修订");
    },
    [runBusy, showToast, triggerActiveRun],
  );

  const runAskFromDrawer = useCallback(async () => {
    const s = stateRef.current;
    if (!s.detail) return;
    const msg = s.discussDraft.trim();
    if (!msg) {
      showToast("请先输入你想向模型提问的内容", true);
      return;
    }
    const anchor = s.discussAnchor ?? undefined;
    const reqId = s.detail.state.id;
    setState((prev) => ({ ...prev, discussDraft: "", discussAnchor: null }));
    await triggerActiveRun(reqId, "ask", { message: msg, anchor, mode: "ask" });
  }, [showToast, triggerActiveRun]);

  const runRefineFromDrawer = useCallback(async () => {
    const s = stateRef.current;
    if (!s.detail) return;
    const msg = s.discussDraft.trim();
    const notes = s.pendingAnnotations.map((a) => `[${a.anchor}] ${a.message}`);
    const combined = [msg, ...notes].filter(Boolean).join("\n");
    if (!combined) {
      showToast("请输入修改意见或先添加段落批注", true);
      return;
    }
    const anchorIds = s.pendingAnnotations.map((a) => a.id);
    const reqId = s.detail.state.id;
    setState((prev) => ({ ...prev, discussDraft: "", discussAnchor: null, pendingAnnotations: [] }));
    await triggerActiveRun(reqId, "design", { message: combined, anchorIds, mode: "refine" });
  }, [showToast, triggerActiveRun]);

  const adoptDiscussion = useCallback(
    async (discId: string) => {
      const d = stateRef.current.detail;
      if (!d) return;
      const item = (d.state.discussions ?? []).find((x) => x.id === discId);
      if (!item) return;
      await triggerActiveRun(d.state.id, "design", {
        mode: "refine",
        message: `请采纳以下讨论结论并修订技术方案与验收条件：\n${item.message}`,
        anchorIds: [discId],
      });
    },
    [triggerActiveRun],
  );

  // Initial load & WebSocket subscription
  useEffect(() => {
    void refreshAll();
    const disposeWs = connectUiWebSocket((ev) => {
      if (ev.type === "agent.run.output" && typeof ev.runId === "string" && typeof ev.chunk === "string") {
        const runId = ev.runId;
        const chunk = ev.chunk;
        setState((prev) => ({
          ...prev,
          liveRunLogs: { ...prev.liveRunLogs, [runId]: (prev.liveRunLogs[runId] ?? "") + chunk },
        }));
        return;
      }

      if (ev.type === "agent.run.started" && typeof ev.runId === "string") {
        const runId = ev.runId;
        const startedRun: AgentRunRecord & { requirementId: string } = {
          id: runId,
          requirementId: String(ev.requirementId ?? ""),
          action: (ev.action as AgentAction) ?? "design",
          harness: String(ev.harness ?? ""),
          model: String(ev.model ?? ""),
          status: "running",
          startedAt: Number(ev.at ?? Date.now()),
          endedAt: null,
          exitCode: null,
          durationMs: 0,
          logPath: `runs/run-${runId}.log`,
        };
        setState((prev) => ({
          ...prev,
          activeRuns: { ...prev.activeRuns, [runId]: startedRun },
          selectedRunId: runId,
        }));
        return;
      }

      if (ev.type === "agent.run.finished" && typeof ev.runId === "string") {
        const runId = ev.runId;
        finishedRunIdsRef.current.add(runId);
        setState((prev) => {
          const next = { ...prev.activeRuns };
          delete next[runId];
          return { ...prev, activeRuns: next };
        });
        const msg =
          ev.status === "succeeded"
            ? `${ev.harness}/${ev.model} 执行完成`
            : ev.status === "cancelled"
              ? "已终止 Agent 任务"
              : String(ev.errorSummary ?? "Agent 执行失败");
        showToast(msg, ev.status === "failed");
        void refreshHubMetadata(true);
        void refreshAll(true);
        return;
      }

      if (ev.type === "bridge.status") {
        setState((prev) =>
          prev.project ? { ...prev, project: { ...prev.project, bridge: ev.bridge as BridgeStatus } } : prev,
        );
        return;
      }

      if (ev.type === "workbench.updated" || ev.type === "hub.updated") {
        if (ev.type === "hub.updated") void refreshHubMetadata(true);
        void refreshAll(true);
      }
    });
    return () => {
      disposeWs();
    };
  }, [refreshAll, refreshHubMetadata, showToast]);

  // Global keyboard shortcut: 'n' opens New Requirement modal on home screen
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const s = stateRef.current;
      const tag = (document.activeElement?.tagName ?? "").toUpperCase();
      if (
        event.key.toLowerCase() === "n" &&
        !s.modal &&
        !s.selectedId &&
        s.project?.initialized &&
        tag !== "INPUT" &&
        tag !== "TEXTAREA"
      ) {
        event.preventDefault();
        setState((prev) => ({ ...prev, modal: { kind: "new_req", goal: "" } }));
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const value: WorkbenchContextValue = {
    state,
    setState,
    showToast,
    refreshAll,
    refreshHubMetadata,
    openRequirement,
    backHome,
    switchProject,
    openAddProjectModal,
    triggerActiveRun,
    handleBannerAction,
    executeVerify,
    runBusy,
    shouldUseCliRunner,
    handleDispatchOutcome,
    toggleTheme,
    setScope,
    setLayout,
    setQuery,
    setWorkspaceTab,
    setDrawerOpen,
    setDrawerTab,
    setSelectedRunnerKey,
    openHandoff,
    toggleVerificationLog,
    refreshDiff,
    openRunConsole,
    cancelRun,
    initProjectSubmit,
    submitNewRequirement,
    submitFeedback,
    submitLifecycle,
    submitAnnotation,
    runAskFromDrawer,
    runRefineFromDrawer,
    adoptDiscussion,
  };

  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>;
}
