import { useEffect, useRef, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { api } from "./api.ts";
import { EmptyHubCard, HomeView, InitCard, RemoteNodeOfflineCard } from "./components/HomeView.tsx";
import { HubSidebar } from "./components/HubSidebar.tsx";
import { LoginView } from "./components/LoginView.tsx";
import { Modals } from "./components/Modals.tsx";
import { ToastBanner } from "./components/Primitives.tsx";
import { RightDrawer } from "./components/RightDrawer.tsx";
import { Topbar } from "./components/Topbar.tsx";
import { WorkspaceView } from "./components/WorkspaceView.tsx";
import {
  queryClient,
  queryKeys,
  useAuthStatusQuery,
  useHubStateQuery,
  useProjectQuery,
  useWorkbenchWsSync,
} from "./queries.ts";
import { useUiStore } from "./stores/uiStore.ts";
import { applyDocumentLanguage, t } from "./i18n.ts";

function describePickedElement(el: HTMLElement): { selector: string; snippet: string } {
  const testId = el.getAttribute("data-testid");
  const action = el.getAttribute("data-action");
  const tag = el.tagName.toLowerCase();
  const classes = Array.from(el.classList).filter(Boolean).slice(0, 2).join(".");
  let selector = testId
    ? `[data-testid="${testId}"]`
    : el.id
      ? `#${el.id}`
      : action
        ? `[data-action="${action}"]`
        : `${tag}${classes ? `.${classes}` : ""}`;
  if (!testId && !el.id) {
    const ancestor = el.parentElement?.closest("[data-testid]") as HTMLElement | null;
    if (ancestor?.dataset.testid) {
      selector = `[data-testid="${ancestor.dataset.testid}"] ${selector}`;
    }
  }
  const snippet = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 60);
  return { selector, snippet };
}

function DomElementPicker() {
  const modal = useUiStore((s) => s.modal);
  const setModal = useUiStore((s) => s.setModal);
  const language = useUiStore((s) => s.language);
  const active = modal?.kind === "quick_report" && modal.pickingElement;
  const [hoverRect, setHoverRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [hoverLabel, setHoverLabel] = useState<string>("");

  useEffect(() => {
    if (!active) {
      setHoverRect(null);
      setHoverLabel("");
      return;
    }

    const onMove = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null;
      if (!target || target.closest('[data-testid="pick-element-banner"]')) {
        setHoverRect(null);
        return;
      }
      const rect = target.getBoundingClientRect();
      setHoverRect({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
      setHoverLabel(describePickedElement(target).selector);
    };

    const onClick = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null;
      if (!target || target.closest('[data-testid="pick-element-banner"]')) return;
      ev.preventDefault();
      ev.stopPropagation();
      const { selector, snippet } = describePickedElement(target);
      setModal((prev) =>
        prev?.kind === "quick_report"
          ? {
              ...prev,
              pickingElement: false,
              domSelector: selector,
              detail:
                prev.detail.trim() || !snippet
                  ? prev.detail
                  : t(useUiStore.getState().language, "picker.hit", { snippet, selector }),
            }
          : prev,
      );
    };

    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        setModal((prev) => (prev?.kind === "quick_report" ? { ...prev, pickingElement: false } : prev));
      }
    };

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [active, setModal]);

  if (!active) return null;

  return (
    <>
      {hoverRect && (
        <div
          style={{
            position: "fixed",
            left: hoverRect.left,
            top: hoverRect.top,
            width: hoverRect.width,
            height: hoverRect.height,
            border: "2px solid var(--accent)",
            background: "var(--accent-soft)",
            pointerEvents: "none",
            zIndex: 9998,
            borderRadius: 4,
          }}
        />
      )}
      <div
        data-testid="pick-element-banner"
        style={{
          position: "fixed",
          top: 12,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 9999,
          background: "var(--surface)",
          border: "1px solid var(--accent)",
          borderRadius: 10,
          padding: "8px 14px",
          boxShadow: "0 8px 24px rgba(0, 0, 0, 0.18)",
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontSize: 13,
        }}
      >
        <span>
          {hoverLabel
            ? t(language, "picker.bannerTarget", { selector: hoverLabel })
            : t(language, "picker.banner")}
        </span>
        <button
          type="button"
          className="btn xs"
          data-testid="cancel-pick-element-btn"
          onClick={() =>
            setModal((prev) => (prev?.kind === "quick_report" ? { ...prev, pickingElement: false } : prev))
          }
        >
          {t(language, "picker.cancel")}
        </button>
      </div>
    </>
  );
}

function WorkbenchShell() {
  useWorkbenchWsSync(true);
  const theme = useUiStore((s) => s.theme);
  const language = useUiStore((s) => s.language);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const selectedId = useUiStore((s) => s.selectedId);
  const drawerOpen = useUiStore((s) => s.drawerOpen);
  const desktopSidebarOpen = useUiStore((s) => s.desktopSidebarOpen);
  const workspaceRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    applyDocumentLanguage(language);
  }, [language]);

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
      const lang = useUiStore.getState().language;
      reportRuntimeError(
        t(lang, "runtime.errorTitle", { message: ev.message || t(lang, "runtime.unknownError") }),
        ev.error?.stack ?? `${ev.filename}:${ev.lineno}`,
      );
    };
    const onRejection = (ev: PromiseRejectionEvent) => {
      const lang = useUiStore.getState().language;
      const msg = ev.reason instanceof Error ? ev.reason.message : String(ev.reason ?? t(lang, "runtime.rejection"));
      reportRuntimeError(
        t(lang, "runtime.rejectionTitle", { message: msg }),
        ev.reason instanceof Error ? (ev.reason.stack ?? msg) : msg,
      );
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
          pickingElement: false,
          autoPromote: false,
        });
        return;
      }
      if ((ev.ctrlKey || ev.metaKey) && ev.key === "\\") {
        const ui = useUiStore.getState();
        if (ui.selectedId) {
          ev.preventDefault();
          ui.setDrawerOpen(!ui.drawerOpen);
        }
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

  const { data: hub, isLoading: hubLoading } = useHubStateQuery();
  const { data: project, isLoading: projectLoading } = useProjectQuery(activeProjectId);

  const showSidebar = Boolean(hub?.hubMode);
  const noHubProject = Boolean(hub?.hubMode && hub.projects.length === 0);
  const activeSummary =
    hub?.projects.find((p) => p.id === (activeProjectId ?? hub.activeProjectId)) ?? hub?.projects[0];
  const remoteOffline = Boolean(hub?.hubMode && activeSummary && activeSummary.nodeOnline === false);
  const showDrawer = Boolean(selectedId) && drawerOpen && !remoteOffline;

  return (
    <>
      <div id="main-root" className={`app-shell ${selectedId ? "detail-mode" : ""}`}>
        <Topbar />
        <div
          className={`hub-layout ${showSidebar ? "with-sidebar" : ""} ${showSidebar && !desktopSidebarOpen ? "sidebar-collapsed" : ""} ${showDrawer ? "with-drawer" : ""}`}
        >
          {showSidebar && <HubSidebar />}
          <div className="hub-workspace" ref={workspaceRef}>
            <div className="main-stage">
              <div className="shell">
                {(hubLoading && !hub) || (!noHubProject && !remoteOffline && projectLoading && !project) ? (
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
                  <HomeView />
                )}
              </div>
            </div>
            {selectedId && !remoteOffline && <RightDrawer workspaceRef={workspaceRef} />}
          </div>
        </div>
      </div>
      <div id="modal-root">
        <Modals />
      </div>
      <DomElementPicker />
      <div id="toast-root">
        <ToastBanner />
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
    <QueryClientProvider client={queryClient}>
      <AuthGate />
    </QueryClientProvider>,
  );
}
