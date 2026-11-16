import { create } from "zustand";
import { initialTheme, type DrawerTab, type LayoutMode, type ModalState, type Scope, type WorkspaceTab } from "../state.ts";

export interface UiStoreState {
  theme: "light" | "dark";
  busy: boolean;
  sidebarOpen: boolean;
  activeProjectId: string | null;
  initPrivacy: "local" | "tracked";
  initName: string;
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
  drawerTab: DrawerTab;
  moreMenuOpen: boolean;
  modal: ModalState;
  toast: { message: string; isError: boolean } | null;

  toggleTheme: () => void;
  setBusy: (busy: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
  setActiveProjectId: (id: string | null) => void;
  setInitPrivacy: (p: "local" | "tracked") => void;
  setInitName: (name: string) => void;
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
  activeProjectId: null,
  initPrivacy: "local",
  initName: "",
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
  setActiveProjectId: (activeProjectId) => set({ activeProjectId }),
  setInitPrivacy: (initPrivacy) => set({ initPrivacy }),
  setInitName: (initName) => set({ initName }),
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
