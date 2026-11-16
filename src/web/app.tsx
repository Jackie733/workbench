import { createRoot } from "react-dom/client";
import { HomeView, InitCard } from "./components/HomeView.tsx";
import { HubSidebar } from "./components/HubSidebar.tsx";
import { Modals } from "./components/Modals.tsx";
import { ToastBanner } from "./components/Primitives.tsx";
import { RightDrawer } from "./components/RightDrawer.tsx";
import { Topbar } from "./components/Topbar.tsx";
import { WorkspaceView } from "./components/WorkspaceView.tsx";
import { useWorkbench, WorkbenchProvider } from "./context.tsx";

function WorkbenchShell() {
  const { state } = useWorkbench();
  const showSidebar = state.hubMode;
  const showDrawer = Boolean(state.selectedId) && state.drawerOpen;

  return (
    <>
      <div id="main-root">
        <div className={`hub-layout ${showSidebar ? "with-sidebar" : ""} ${showDrawer ? "with-drawer" : ""}`}>
          {showSidebar && <HubSidebar />}
          <div className="main-stage">
            <div className="shell">
              <Topbar />
              {state.loading ? (
                <p className="muted">正在加载工作台…</p>
              ) : !state.project?.initialized ? (
                <InitCard />
              ) : state.selectedId ? (
                <WorkspaceView />
              ) : (
                <HomeView />
              )}
            </div>
          </div>
          {state.selectedId && <RightDrawer />}
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
    <WorkbenchProvider>
      <WorkbenchShell />
    </WorkbenchProvider>,
  );
}
