import React from "react";
import { toast } from "sonner";
import { create } from "zustand";
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
import { initialTheme, type DrawerTab, type LayoutMode, type ModalState, type Scope, type WorkspaceTab } from "../state.ts";

export const DEFAULT_DRAWER_WIDTH = 720;
export const MIN_DRAWER_WIDTH = 320;

function initialDesktopSidebarOpen(): boolean {
  const saved = readStorageItem("wb-sidebar-open");
  return saved === "false" ? false : true;
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
  activeProjectId: string | null;
  initPrivacy: "local" | "tracked";
  initName: string;
  initOutputLanguage: OutputLanguage | "inherit";
  scope: Scope;
  layout: LayoutMode;
  query: string;
  homeScrollY: number;

  selectedId: string | null;
  workspaceTab: WorkspaceTab;
  selectedDiffFile: string | null;

  designViewVersion: number | null;
  designComparePrev: boolean;
  designCompareText: { prev: string; curr: string; prevVer: number; currVer: number } | null;

  expandedLogs: Record<string, string>;
  drawerOpen: boolean;
  drawerWidth: number;
  drawerTab: DrawerTab;
  moreMenuOpen: boolean;
  modal: ModalState;

  toggleTheme: () => void;
  setLanguage: (language: UiLanguage) => void;
  setBusy: (busy: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
  setDesktopSidebarOpen: (open: boolean) => void;
  setActiveProjectId: (id: string | null) => void;
  setInitPrivacy: (p: "local" | "tracked") => void;
  setInitName: (name: string) => void;
  setInitOutputLanguage: (lang: OutputLanguage | "inherit") => void;
  setScope: (scope: Scope) => void;
  setLayout: (layout: LayoutMode) => void;
  setQuery: (query: string) => void;
  setHomeScrollY: (y: number) => void;
  setSelectedId: (id: string | null) => void;
  setWorkspaceTab: (tab: WorkspaceTab) => void;
  setSelectedDiffFile: (file: string | null) => void;
  setDesignViewVersion: (v: number | null) => void;
  setDesignComparePrev: (v: boolean) => void;
  setDesignCompareText: (t: { prev: string; curr: string; prevVer: number; currVer: number } | null) => void;
  setExpandedLog: (vid: string, log: string | null) => void;
  clearExpandedLogs: () => void;
  setDrawerOpen: (open: boolean) => void;
  setDrawerWidth: (width: number) => void;
  setDrawerTab: (tab: DrawerTab) => void;
  setMoreMenuOpen: (open: boolean) => void;
  setModal: (modal: ModalState | ((prev: ModalState) => ModalState)) => void;
  showToast: (message: string, isError?: boolean) => void;
  showToastKey: (key: MessageKey, params?: MessageParams, isError?: boolean) => void;
  showToastError: (err: unknown) => void;
}

export const useUiStore = create<UiStoreState>((set) => ({
  theme: initialTheme(),
  language: readStoredUiLanguage(),
  busy: false,
  sidebarOpen: false,
  desktopSidebarOpen: initialDesktopSidebarOpen(),
  activeProjectId: null,
  initPrivacy: "local",
  initName: "",
  initOutputLanguage: "inherit",
  scope: "active",
  layout: "list",
  query: "",
  homeScrollY: 0,

  selectedId: null,
  workspaceTab: "spec",
  selectedDiffFile: null,

  designViewVersion: null,
  designComparePrev: false,
  designCompareText: null,

  expandedLogs: {},
  drawerOpen: false,
  drawerWidth: initialDrawerWidth(),
  drawerTab: "discuss",
  moreMenuOpen: false,
  modal: null,

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
  setActiveProjectId: (activeProjectId) => set({ activeProjectId }),
  setInitPrivacy: (initPrivacy) => set({ initPrivacy }),
  setInitName: (initName) => set({ initName }),
  setInitOutputLanguage: (initOutputLanguage) => set({ initOutputLanguage }),
  setScope: (scope) => set({ scope }),
  setLayout: (layout) => set({ layout }),
  setQuery: (query) => set({ query }),
  setHomeScrollY: (homeScrollY) => set({ homeScrollY }),
  setSelectedId: (selectedId) => set({ selectedId }),
  setWorkspaceTab: (workspaceTab) => set({ workspaceTab }),
  setSelectedDiffFile: (selectedDiffFile) => set({ selectedDiffFile }),
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
  setMoreMenuOpen: (moreMenuOpen) => set({ moreMenuOpen }),
  setModal: (modalOrUpdater) =>
    set((s) => ({
      modal: typeof modalOrUpdater === "function" ? modalOrUpdater(s.modal) : modalOrUpdater,
    })),
  showToast: (message, isError = false) => {
    if (isError) toast.error(message);
    else toast(message);
  },
  showToastKey: (key, params, isError = false) => {
    const message = React.createElement(LocalizedToastMessage, { messageKey: key, params });
    if (isError) toast.error(message);
    else toast(message);
  },
  showToastError: (err) => {
    const ref = describeClientErrorRef(err);
    if (ref.key) {
      const message = React.createElement(LocalizedToastMessage, { messageKey: ref.key, params: ref.params });
      toast.error(message);
    } else {
      toast.error(ref.text);
    }
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
