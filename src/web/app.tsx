import { useEffect } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { api } from "./api.ts";
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

  useEffect(() => {
    const reportedErrors = new Set<string>();
    const reportRuntimeError = (title: string, detail: string) => {
      if (!title || reportedErrors.has(title)) return;
      reportedErrors.add(title);
      const ui = useUiStore.getState();
      void api
        .reportPainPoint({
          source: "ui_error",
          category: "ui_anomaly",
          title: title.slice(0, 140),
          detail,
          context: {
            requirementId: ui.selectedId ?? undefined,
            viewport: `${window.innerWidth}x${window.innerHeight}`,
            theme: ui.theme,
            urlPath: window.location.pathname,
          },
        })
        .catch(() => {});
    };

    const onError = (ev: ErrorEvent) => {
      reportRuntimeError(`前端运行时异常: ${ev.message || "Unknown error"}`, ev.error?.stack ?? `${ev.filename}:${ev.lineno}`);
    };
    const onRejection = (ev: PromiseRejectionEvent) => {
      const msg = ev.reason instanceof Error ? ev.reason.message : String(ev.reason ?? "Promise rejection");
      reportRuntimeError(`前端未捕获异步异常: ${msg}`, ev.reason instanceof Error ? (ev.reason.stack ?? msg) : msg);
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.altKey && ev.key.toLowerCase() === "r") {
        ev.preventDefault();
        useUiStore.getState().setModal({
          kind: "quick_report",
          title: "",
          detail: "",
          category: "ui_anomaly",
          domSelector: "",
          autoPromote: false,
        });
      }
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

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
