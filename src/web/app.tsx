import { Component, useEffect, useRef, type ErrorInfo, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { AnchoredToastProvider, ToastProvider } from "./components/ui/toast.tsx";
import { EmptyHubCard, EmptyRequirementsCard, InitCard, RemoteNodeOfflineCard } from "./components/HomeView.tsx";
import { HubSidebar } from "./components/HubSidebar.tsx";
import { LoginView } from "./components/LoginView.tsx";
import { Modals } from "./components/Modals.tsx";
import { RightDrawer } from "./components/RightDrawer.tsx";
import { Topbar } from "./components/Topbar.tsx";
import { WorkspaceView } from "./components/WorkspaceView.tsx";
import { InsightsView } from "./components/InsightsView.tsx";
import {
  isRequirementNotFoundError,
  queryClient,
  queryKeys,
  useAuthStatusQuery,
  useHubStateQuery,
  useProjectQuery,
  useRequirementQuery,
  useRequirementsQuery,
  useWorkbenchWsSync,
} from "./queries.ts";
import {
  filterRequirementsByScope,
  partitionPendingDecisions,
  pickDefaultRequirementId,
  type WorkspaceTab,
} from "./state.ts";
import { useStreamStore } from "./stores/streamStore.ts";
import { useUiStore } from "./stores/uiStore.ts";
import { applyDocumentLanguage, t } from "./i18n.ts";

class RootErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; message: string }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, message: "" };
  }

  static getDerivedStateFromError(error: Error): { hasError: boolean; message: string } {
    return { hasError: true, message: error?.message || "Unexpected UI render error" };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[workbench] UI render error:", error, info.componentStack);
  }

  override render() {
    if (!this.state.hasError) return this.props.children;
    const isEn = useUiStore.getState().language === "en";
    return (
      <div className="shell" data-testid="root-error-fallback" style={{ paddingTop: 48 }}>
        <div className="surface-card" style={{ maxWidth: 560, margin: "0 auto", padding: 20 }}>
          <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>
            {isEn ? "Interface encountered a runtime error" : "工作台界面发生渲染异常"}
          </h2>
          <p className="muted" style={{ margin: "0 0 12px", fontSize: 13 }}>
            {this.state.message}
          </p>
          <button
            type="button"
            className="btn sm primary"
            onClick={() => {
              this.setState({ hasError: false, message: "" });
              if (typeof window !== "undefined") window.location.reload();
            }}
          >
            {isEn ? "Reload Workbench" : "重新加载工作台"}
          </button>
        </div>
      </div>
    );
  }
}

function WorkbenchShell() {
  useWorkbenchWsSync(true);
  const theme = useUiStore((s) => s.theme);
  const language = useUiStore((s) => s.language);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const mainView = useUiStore((s) => s.mainView);
  const selectedId = useUiStore((s) => s.selectedId);
  const scope = useUiStore((s) => s.scope);
  const drawerOpen = useUiStore((s) => s.drawerOpen);
  const desktopSidebarOpen = useUiStore((s) => s.desktopSidebarOpen);
  const activeRuns = useStreamStore((s) => s.activeRuns);
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const urlInitializedRef = useRef(false);

  useEffect(() => {
    if (urlInitializedRef.current || typeof window === "undefined") return;
    urlInitializedRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const reqParam = params.get("req")?.trim();
    const tabParam = params.get("tab")?.trim() as WorkspaceTab | null;
    const viewParam = params.get("view")?.trim();
    const ui = useUiStore.getState();
    if (viewParam === "insights") {
      ui.setMainView("insights");
    }
    if (reqParam && /^REQ-\d+$/i.test(reqParam)) {
      ui.setSelectedId(reqParam.toUpperCase());
    }
    if (tabParam === "spec" || tabParam === "diff" || tabParam === "changes" || tabParam === "timeline") {
      ui.setWorkspaceTab(tabParam);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (mainView === "insights") {
      url.searchParams.set("view", "insights");
    } else {
      url.searchParams.delete("view");
    }
    if (url.toString() !== window.location.href) {
      window.history.replaceState(null, "", url.toString());
    }
  }, [mainView]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    applyDocumentLanguage(language);
  }, [language]);

  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === "\\") {
        const ui = useUiStore.getState();
        if (ui.selectedId) {
          ev.preventDefault();
          ui.setDrawerOpen(!ui.drawerOpen);
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const { data: hub, isLoading: hubLoading } = useHubStateQuery();
  const { data: project, isLoading: projectLoading } = useProjectQuery(activeProjectId);

  const noHubProject = Boolean(hub?.hubMode && hub.projects.length === 0);
  const activeSummary =
    hub?.projects.find((p) => p.id === (activeProjectId ?? hub.activeProjectId)) ?? hub?.projects[0];
  const remoteOffline = Boolean(hub?.hubMode && activeSummary && activeSummary.nodeOnline === false);
  const projectReady = Boolean(project?.initialized && !noHubProject && !remoteOffline);
  const showSidebar = Boolean(hub?.hubMode || project?.initialized);
  const showDrawer = Boolean(selectedId) && drawerOpen && !remoteOffline;

  const { data: allReqList } = useRequirementsQuery(activeProjectId, "all", projectReady);
  const { isError: selectedReqIsError, error: selectedReqError } = useRequirementQuery(
    activeProjectId,
    projectReady ? selectedId : null,
  );
  const selectedReqNotFound = selectedReqIsError && isRequirementNotFoundError(selectedReqError);

  useEffect(() => {
    if (!projectReady || !selectedId || !selectedReqNotFound) return;
    useUiStore.getState().setSelectedId(null);
  }, [projectReady, selectedId, selectedReqNotFound]);

  useEffect(() => {
    if (!projectReady || selectedId !== null || !allReqList) return;
    const allItems = allReqList.items.filter(
      (item) =>
        !isRequirementNotFoundError(
          queryClient.getQueryState(queryKeys.requirement(activeProjectId, item.id))?.error,
        ),
    );
    if (allItems.length === 0) return;
    const runsList = Object.values(activeRuns);
    const activeItems = filterRequirementsByScope(allItems, "active");
    const scopedItems =
      scope === "decisions"
        ? partitionPendingDecisions(activeItems, runsList, activeProjectId).humanPending
        : scope === "sandboxes"
          ? activeItems
          : filterRequirementsByScope(allItems, scope);
    const candidates = scopedItems.length > 0 ? scopedItems : allItems;
    const defaultId = pickDefaultRequirementId(candidates, runsList, activeProjectId);
    if (defaultId) {
      const ui = useUiStore.getState();
      if (scopedItems.length === 0 && scope === "active") {
        ui.setScope("all");
      }
      ui.setSelectedId(defaultId);
    }
  }, [projectReady, selectedId, scope, allReqList, activeRuns, activeProjectId]);

  return (
    <>
      <div id="main-root" className={`app-shell isolate ${projectReady ? "detail-mode" : ""}`}>
        <Topbar />
        <div
          ref={layoutRef}
          className={`hub-layout ${showSidebar ? "with-sidebar" : ""} ${showSidebar && !desktopSidebarOpen ? "sidebar-collapsed" : ""} ${showDrawer ? "with-drawer" : ""}`}
        >
          {showSidebar && <HubSidebar layoutRef={layoutRef} />}
          <div className="hub-workspace" ref={workspaceRef}>
            <div className="main-stage">
              <div className="shell">
                {mainView === "insights" ? (
                  <InsightsView />
                ) : (hubLoading && !hub) || (!noHubProject && !remoteOffline && projectLoading && !project) ? (
                  <p className="muted">{t(language, "app.loading")}</p>
                ) : noHubProject ? (
                  <EmptyHubCard />
                ) : remoteOffline && activeSummary ? (
                  <RemoteNodeOfflineCard project={activeSummary} />
                ) : !project?.initialized ? (
                  <InitCard />
                ) : selectedId ? (
                  <WorkspaceView />
                ) : (
                  <EmptyRequirementsCard />
                )}
              </div>
            </div>
            {selectedId && !remoteOffline && mainView !== "insights" && <RightDrawer workspaceRef={workspaceRef} />}
          </div>
        </div>
      </div>
      <div id="modal-root">
        <Modals />
      </div>
    </>
  );
}

function AuthGate() {
  const theme = useUiStore((s) => s.theme);
  const language = useUiStore((s) => s.language);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    applyDocumentLanguage(language);
  }, [language]);

  useEffect(() => {
    const onUnauthorized = () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.authStatus });
    };
    window.addEventListener("wb:unauthorized", onUnauthorized);
    return () => window.removeEventListener("wb:unauthorized", onUnauthorized);
  }, []);

  const { data: auth, isLoading } = useAuthStatusQuery();

  if (isLoading && !auth) {
    return (
      <div className="shell" style={{ paddingTop: 48 }}>
        <p className="muted">{t(language, "app.authChecking")}</p>
      </div>
    );
  }

  if (auth?.required && !auth.authenticated) {
    return (
      <LoginView
        onAuthenticated={() => {
          void queryClient.invalidateQueries();
        }}
      />
    );
  }

  return <WorkbenchShell />;
}

applyDocumentLanguage(useUiStore.getState().language);
const rootEl = document.getElementById("app");
if (rootEl) {
  createRoot(rootEl).render(
    <RootErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ToastProvider position="bottom-right" timeout={4000} limit={4}>
          <AnchoredToastProvider>
            <AuthGate />
          </AnchoredToastProvider>
        </ToastProvider>
      </QueryClientProvider>
    </RootErrorBoundary>,
  );
}
