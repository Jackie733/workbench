import { useEffect } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { HomeView, InitCard } from "./components/HomeView.tsx";
import { HubSidebar } from "./components/HubSidebar.tsx";
import { Modals } from "./components/Modals.tsx";
import { ToastBanner } from "./components/Primitives.tsx";
import { RightDrawer } from "./components/RightDrawer.tsx";
import { Topbar } from "./components/Topbar.tsx";
import { WorkspaceView } from "./components/WorkspaceView.tsx";
import { queryClient, useHubStateQuery, useProjectQuery, useWorkbenchWsSync } from "./queries.ts";
import { useUiStore } from "./stores/uiStore.ts";

function WorkbenchShell() {
  useWorkbenchWsSync();
  const theme = useUiStore((s) => s.theme);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const selectedId = useUiStore((s) => s.selectedId);
  const drawerOpen = useUiStore((s) => s.drawerOpen);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const { data: hub } = useHubStateQuery();
  const { data: project, isLoading: projectLoading } = useProjectQuery(activeProjectId);

  const showSidebar = Boolean(hub?.hubMode);
  const showDrawer = Boolean(selectedId) && drawerOpen;

  return (
    <>
      <div id="main-root">
        <div className={`hub-layout ${showSidebar ? "with-sidebar" : ""} ${showDrawer ? "with-drawer" : ""}`}>
          {showSidebar && <HubSidebar />}
          <div className="main-stage">
            <div className="shell">
              <Topbar />
              {projectLoading && !project ? (
                <p className="muted">正在加载工作台…</p>
              ) : !project?.initialized ? (
                <InitCard />
              ) : selectedId ? (
                <WorkspaceView />
              ) : (
                <HomeView />
              )}
            </div>
          </div>
          {selectedId && <RightDrawer />}
        </div>
      </div>
      <div id="modal-root">
        <Modals />
      </div>
      <div id="toast-root">
        <ToastBanner />
      </div>
    </>
  );
}

const rootEl = document.getElementById("app");
if (rootEl) {
  createRoot(rootEl).render(
    <QueryClientProvider client={queryClient}>
      <WorkbenchShell />
    </QueryClientProvider>,
  );
}
