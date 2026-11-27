import React from "react";
import { create } from "zustand";
import { toastManager } from "../components/ui/toast.tsx";
import type { OutputLanguage } from "../../core/types.ts";
import {
  applyDocumentLanguage,
  describeClientErrorRef,
  persistUiLanguage,
  readStorageItem,
  readStoredUiLanguage,
  t,
  writeStorageItem,
  type MessageKey,
  type MessageParams,
  type UiLanguage,
} from "../i18n.ts";
import {
  initialTheme,
  type DiffViewMode,
  type DrawerTab,
  type MainView,
  type ModalState,
  type ProjectGroupMode,
  type ProjectSortMode,
  type Scope,
  type WorkspaceTab,
} from "../state.ts";

export const DEFAULT_SIDEBAR_WIDTH = 360;
export const MIN_SIDEBAR_WIDTH = 280;
export const MAX_SIDEBAR_WIDTH = 520;
export const DEFAULT_DRAWER_WIDTH = 720;
export const MIN_DRAWER_WIDTH = 320;
/** 暂缓热刷新提示的固定 id：重复事件只更新同一条提示，不堆叠。 */
export const RELOAD_PENDING_TOAST_ID = "web-reload-pending";

function initialSidebarWidth(): number {
  const raw = Number(readStorageItem("wb-sidebar-width"));
  if (Number.isFinite(raw) && raw >= MIN_SIDEBAR_WIDTH && raw <= MAX_SIDEBAR_WIDTH) {
    return Math.round(raw);
  }
  return DEFAULT_SIDEBAR_WIDTH;
}

function initialDesktopSidebarOpen(): boolean {
  const saved = readStorageItem("wb-sidebar-open");
  return saved === "false" ? false : true;
}

function initialProjectSort(): ProjectSortMode {
  const saved = readStorageItem("wb-project-sort");
  if (saved === "attention" || saved === "recent" || saved === "name" || saved === "added") {
    return saved;
  }
  return "attention";
}

function initialProjectGroup(): ProjectGroupMode {
  const saved = readStorageItem("wb-project-group");
  if (saved === "none" || saved === "node" || saved === "status" || saved === "category") {
    return saved;
  }
  return "none";
}

function initialProjectsCollapsed(): boolean {
  return readStorageItem("wb-projects-collapsed") === "true";
}

function initialDrawerWidth(): number {
  const raw = Number(readStorageItem("wb-drawer-width"));
  if (Number.isFinite(raw) && raw >= MIN_DRAWER_WIDTH) {
    return Math.round(raw);
  }
  return DEFAULT_DRAWER_WIDTH;
}

export interface UiStoreState {
  theme: "light" | "dark";
  language: UiLanguage;
  busy: boolean;
  sidebarOpen: boolean;
  desktopSidebarOpen: boolean;
  sidebarWidth: number;
  projectSort: ProjectSortMode;
  projectGroup: ProjectGroupMode;
  projectsCollapsed: boolean;
  activeProjectId: string | null;
  initPrivacy: "local" | "tracked";
  initName: string;
  initOutputLanguage: OutputLanguage | "inherit";
  scope: Scope;
  query: string;
  homeScrollY: number;
  /** 有热刷新被暂缓（弹窗/忙碌/输入中），等待空闲后补刷；仅内存态。 */
  pendingWebReload: boolean;

  selectedId: string | null;
  mainView: MainView;
  workspaceTab: WorkspaceTab;
  inspectedRunId: string | null;
  selectedDiffFile: string | null;
  diffViewMode: DiffViewMode;
  diffFileQuery: string;

  designViewVersion: number | null;
  designComparePrev: boolean;
  designCompareText: { prev: string; curr: string; prevVer: number; currVer: number } | null;

  expandedLogs: Record<string, string>;
  drawerOpen: boolean;
  drawerWidth: number;
  drawerTab: DrawerTab;
  highlightedAnchor: { anchor: string; nonce: number } | null;
  moreMenuOpen: boolean;
  modal: ModalState;
  /**
   * 弹窗实例序号：每次从关闭态重新打开弹窗或切换弹窗类型时递增。
   * 异步动作在发起时记录序号，只有弹窗实例未被替换时才允许关闭，避免旧请求关掉新弹窗。
   */
  modalInstanceId: number;

  toggleTheme: () => void;
  setLanguage: (language: UiLanguage) => void;
  setBusy: (busy: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
  setDesktopSidebarOpen: (open: boolean) => void;
  setSidebarWidth: (width: number) => void;
  setProjectSort: (sort: ProjectSortMode) => void;
  setProjectGroup: (group: ProjectGroupMode) => void;
  setProjectsCollapsed: (collapsed: boolean) => void;
  setActiveProjectId: (id: string | null) => void;
  setInitPrivacy: (p: "local" | "tracked") => void;
  setInitName: (name: string) => void;
  setInitOutputLanguage: (lang: OutputLanguage | "inherit") => void;
  setScope: (scope: Scope) => void;
  setQuery: (query: string) => void;
  setHomeScrollY: (y: number) => void;
  setPendingWebReload: (pending: boolean) => void;
  setSelectedId: (id: string | null) => void;
  setMainView: (view: MainView) => void;
  setWorkspaceTab: (tab: WorkspaceTab) => void;
  setInspectedRunId: (runId: string | null) => void;
  setSelectedDiffFile: (file: string | null) => void;
  setDiffViewMode: (mode: DiffViewMode) => void;
  setDiffFileQuery: (query: string) => void;
  setDesignViewVersion: (v: number | null) => void;
  setDesignComparePrev: (v: boolean) => void;
  setDesignCompareText: (t: { prev: string; curr: string; prevVer: number; currVer: number } | null) => void;
  setExpandedLog: (vid: string, log: string | null) => void;
  clearExpandedLogs: () => void;
  setDrawerOpen: (open: boolean) => void;
  setDrawerWidth: (width: number) => void;
  setDrawerTab: (tab: DrawerTab) => void;
  triggerAnchorHighlight: (anchor: string) => void;
  clearAnchorHighlight: () => void;
  setMoreMenuOpen: (open: boolean) => void;
  setModal: (modal: ModalState | ((prev: ModalState) => ModalState)) => void;
  /** 关闭弹窗；传入实例序号时仅在弹窗未被替换的情况下关闭。 */
  closeModal: (instanceId?: number) => void;
  showToast: (message: string, isError?: boolean) => void;
  showToastKey: (key: MessageKey, params?: MessageParams, isError?: boolean) => void;
  showToastError: (err: unknown) => void;
  showReloadPendingToast: () => void;
  dismissReloadPendingToast: () => void;
}

export const useUiStore = create<UiStoreState>((set) => ({
  theme: initialTheme(),
  language: readStoredUiLanguage(),
  busy: false,
  sidebarOpen: false,
  desktopSidebarOpen: initialDesktopSidebarOpen(),
  sidebarWidth: initialSidebarWidth(),
  projectSort: initialProjectSort(),
  projectGroup: initialProjectGroup(),
  projectsCollapsed: initialProjectsCollapsed(),
  activeProjectId: null,
  initPrivacy: "local",
  initName: "",
  initOutputLanguage: "inherit",
  scope: "active",
  query: "",
  homeScrollY: 0,
  pendingWebReload: false,

  selectedId: null,
  mainView: "workspace",
  workspaceTab: "spec",
  inspectedRunId: null,
  selectedDiffFile: null,
  diffViewMode: "split",
  diffFileQuery: "",

  designViewVersion: null,
  designComparePrev: false,
  designCompareText: null,

  expandedLogs: {},
  drawerOpen: false,
  drawerWidth: initialDrawerWidth(),
  drawerTab: "discuss",
  highlightedAnchor: null,
  moreMenuOpen: false,
  modal: null,
  modalInstanceId: 0,

  toggleTheme: () =>
    set((s) => {
      const next = s.theme === "dark" ? "light" : "dark";
      if (typeof document !== "undefined") {
        document.documentElement.setAttribute("data-theme", next);
      }
      writeStorageItem("wb-theme", next);
      return { theme: next };
    }),
  setLanguage: (language) => {
    set({ language });
    applyDocumentLanguage(language);
    persistUiLanguage(language);
  },
  setBusy: (busy) => set({ busy }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setDesktopSidebarOpen: (desktopSidebarOpen) => {
    writeStorageItem("wb-sidebar-open", String(desktopSidebarOpen));
    set({ desktopSidebarOpen });
  },
  setSidebarWidth: (width) => {
    const clamped = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
    writeStorageItem("wb-sidebar-width", String(clamped));
    set({ sidebarWidth: clamped });
  },
  setProjectSort: (projectSort) => {
    writeStorageItem("wb-project-sort", projectSort);
    set({ projectSort });
  },
  setProjectGroup: (projectGroup) => {
    writeStorageItem("wb-project-group", projectGroup);
    set({ projectGroup });
  },
  setProjectsCollapsed: (projectsCollapsed) => {
    writeStorageItem("wb-projects-collapsed", String(projectsCollapsed));
    set({ projectsCollapsed });
  },
  setActiveProjectId: (activeProjectId) => set({ activeProjectId }),
  setInitPrivacy: (initPrivacy) => set({ initPrivacy }),
  setInitName: (initName) => set({ initName }),
  setInitOutputLanguage: (initOutputLanguage) => set({ initOutputLanguage }),
  setScope: (scope) => set({ scope }),
  setQuery: (query) => set({ query }),
  setHomeScrollY: (homeScrollY) => set({ homeScrollY }),
  setPendingWebReload: (pendingWebReload) => set({ pendingWebReload }),
  setSelectedId: (selectedId) => set({ selectedId, inspectedRunId: null, diffFileQuery: "" }),
  setMainView: (mainView) => set({ mainView }),
  setWorkspaceTab: (workspaceTab) => set({ workspaceTab }),
  setInspectedRunId: (inspectedRunId) => set({ inspectedRunId }),
  setSelectedDiffFile: (selectedDiffFile) => set({ selectedDiffFile }),
  setDiffViewMode: (diffViewMode) => set({ diffViewMode }),
  setDiffFileQuery: (diffFileQuery) => set({ diffFileQuery }),
  setDesignViewVersion: (designViewVersion) => set({ designViewVersion }),
  setDesignComparePrev: (designComparePrev) => set({ designComparePrev }),
  setDesignCompareText: (designCompareText) => set({ designCompareText }),
  setExpandedLog: (vid, log) =>
    set((s) => {
      const next = { ...s.expandedLogs };
      if (log === null) delete next[vid];
      else next[vid] = log;
      return { expandedLogs: next };
    }),
  clearExpandedLogs: () => set({ expandedLogs: {} }),
  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
  setDrawerWidth: (width) => {
    const rounded = Math.max(MIN_DRAWER_WIDTH, Math.round(width));
    writeStorageItem("wb-drawer-width", String(rounded));
    set({ drawerWidth: rounded });
  },
  setDrawerTab: (drawerTab) => set({ drawerTab }),
  triggerAnchorHighlight: (anchor) =>
    set((s) => ({
      workspaceTab: "spec",
      highlightedAnchor: { anchor, nonce: (s.highlightedAnchor?.nonce ?? 0) + 1 },
    })),
  clearAnchorHighlight: () => set({ highlightedAnchor: null }),
  setMoreMenuOpen: (moreMenuOpen) => set({ moreMenuOpen }),
  setModal: (modalOrUpdater) =>
    set((s) => {
      const modal = typeof modalOrUpdater === "function" ? modalOrUpdater(s.modal) : modalOrUpdater;
      // 同一弹窗内的字段编辑保持实例不变；重新打开或切换类型才视为新实例。
      const opensNewInstance = modal !== null && (s.modal === null || s.modal.kind !== modal.kind);
      return {
        modal,
        ...(opensNewInstance ? { modalInstanceId: s.modalInstanceId + 1 } : {}),
      };
    }),
  closeModal: (instanceId) =>
    set((s) => {
      if (instanceId !== undefined && instanceId !== s.modalInstanceId) return {};
      return { modal: null, modalInstanceId: s.modalInstanceId + 1 };
    }),
  showToast: (message, isError = false) => {
    toastManager.add({
      title: message,
      ...(isError ? { type: "error" } : {}),
    });
  },
  showToastKey: (key, params, isError = false) => {
    const message = React.createElement(LocalizedToastMessage, { messageKey: key, params });
    toastManager.add({
      title: message,
      ...(isError ? { type: "error" } : {}),
    });
  },
  showToastError: (err) => {
    const ref = describeClientErrorRef(err);
    if (ref.key) {
      const message = React.createElement(LocalizedToastMessage, { messageKey: ref.key, params: ref.params });
      toastManager.add({ title: message, type: "error" });
    } else {
      toastManager.add({ title: ref.text, type: "error" });
    }
  },
  showReloadPendingToast: () => {
    toastManager.add({
      id: RELOAD_PENDING_TOAST_ID,
      title: React.createElement(LocalizedToastMessage, { messageKey: "toast.reloadPending" }),
      timeout: 0,
      actionProps: {
        children: React.createElement(LocalizedToastMessage, { messageKey: "toast.reloadAction" }),
        onClick: () => window.location.reload(),
      },
    });
  },
  dismissReloadPendingToast: () => {
    toastManager.close(RELOAD_PENDING_TOAST_ID);
  },
}));

/**
 * Toast 内容在渲染时读取当前界面语言，因此提示已显示期间切换语言也会同步更新。
 * 保存消息键与参数而非已翻译字符串，避免即时反馈停留在旧语言。
 */
function LocalizedToastMessage({ messageKey, params }: { messageKey: MessageKey; params?: MessageParams }) {
  const language = useUiStore((s) => s.language);
  return React.createElement(React.Fragment, null, t(language, messageKey, params));
}
