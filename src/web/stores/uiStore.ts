import { create } from "zustand";
import type { OutputLanguage } from "../../core/types.ts";
import { initialTheme, type DrawerTab, type LayoutMode, type ModalState, type Scope, type WorkspaceTab } from "../state.ts";

export const DEFAULT_DRAWER_WIDTH = 720;
export const MIN_DRAWER_WIDTH = 320;

function initialDesktopSidebarOpen(): boolean {
  if (typeof localStorage === "undefined") return true;
  const saved = localStorage.getItem("wb-sidebar-open");
  return saved === "false" ? false : true;
}

function initialDrawerWidth(): number {
  if (typeof localStorage === "undefined") return DEFAULT_DRAWER_WIDTH;
  const raw = Number(localStorage.getItem("wb-drawer-width"));
  if (Number.isFinite(raw) && raw >= MIN_DRAWER_WIDTH) {
    return Math.round(raw);
  }
  return DEFAULT_DRAWER_WIDTH;
}

export interface UiStoreState {
  theme: "light" | "dark";
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
  toast: { message: string; isError: boolean } | null;

  toggleTheme: () => void;
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
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export const useUiStore = create<UiStoreState>((set) => ({
  theme: initialTheme(),
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
  toast: null,

  toggleTheme: () =>
    set((s) => {
      const next = s.theme === "dark" ? "light" : "dark";
      if (typeof document !== "undefined") {
        document.documentElement.setAttribute("data-theme", next);
      }
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("wb-theme", next);
      }
      return { theme: next };
    }),
  setBusy: (busy) => set({ busy }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setDesktopSidebarOpen: (desktopSidebarOpen) => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("wb-sidebar-open", String(desktopSidebarOpen));
    }
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
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("wb-drawer-width", String(rounded));
    }
    set({ drawerWidth: rounded });
  },
  setDrawerTab: (drawerTab) => set({ drawerTab }),
  setMoreMenuOpen: (moreMenuOpen) => set({ moreMenuOpen }),
  setModal: (modalOrUpdater) =>
    set((s) => ({
      modal: typeof modalOrUpdater === "function" ? modalOrUpdater(s.modal) : modalOrUpdater,
    })),
  showToast: (message, isError = false) => {
    if (toastTimer) clearTimeout(toastTimer);
    set({ toast: { message, isError } });
    toastTimer = setTimeout(() => {
      set({ toast: null });
    }, 4000);
  },
}));
