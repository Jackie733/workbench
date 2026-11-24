import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { Crosshair, X } from "lucide-react";
import { AnchoredToastProvider, ToastProvider } from "./components/ui/toast.tsx";
import { api } from "./api.ts";
import { EmptyHubCard, EmptyRequirementsCard, InitCard, RemoteNodeOfflineCard } from "./components/HomeView.tsx";
import { HubSidebar } from "./components/HubSidebar.tsx";
import { Icon } from "./components/Icon.tsx";
import { LoginView } from "./components/LoginView.tsx";
import { Modals } from "./components/Modals.tsx";
import { RightDrawer } from "./components/RightDrawer.tsx";
import { Topbar } from "./components/Topbar.tsx";
import { WorkspaceView } from "./components/WorkspaceView.tsx";
import { InsightsView } from "./components/InsightsView.tsx";
import {
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

declare const __WORKBENCH_BUILD_COMMIT__: string | undefined;
declare const __WORKBENCH_BUILD_TIME__: string | undefined;

const BUILD_COMMIT =
  typeof __WORKBENCH_BUILD_COMMIT__ === "string" && __WORKBENCH_BUILD_COMMIT__ ? __WORKBENCH_BUILD_COMMIT__ : undefined;
const MAX_BREADCRUMBS = 12;
const uiBreadcrumbs: string[] = [];
const reportedRuntimeErrors = new Set<string>();

function pushUiBreadcrumb(entry: string): void {
  const normalized = entry.trim().replace(/\s+/g, " ").slice(0, 180);
  if (!normalized) return;
  if (uiBreadcrumbs[uiBreadcrumbs.length - 1] === normalized) return;
  uiBreadcrumbs.push(normalized);
  if (uiBreadcrumbs.length > MAX_BREADCRUMBS) {
    uiBreadcrumbs.splice(0, uiBreadcrumbs.length - MAX_BREADCRUMBS);
  }
}

function sendRuntimeErrorPainPoint(
  title: string,
  detail: string,
  extra?: { component?: string; componentStack?: string },
): void {
  if (!title || reportedRuntimeErrors.has(title)) return;
  reportedRuntimeErrors.add(title);
  const ui = useUiStore.getState();
  const stack = extra?.componentStack?.trim();
  const fallbackComponent = stack?.split(/\r?\n/)[1]?.trim().slice(0, 120);
  void api
    .reportPainPoint({
      source: "ui_error",
      category: "ui_anomaly",
      title: title.slice(0, 140),
      detail,
      context: {
        requirementId: ui.selectedId ?? undefined,
        viewport: typeof window !== "undefined" ? `${window.innerWidth}x${window.innerHeight}` : undefined,
        theme: ui.theme,
        urlPath: typeof window !== "undefined" ? window.location.pathname : undefined,
        ...(BUILD_COMMIT ? { buildCommit: BUILD_COMMIT } : {}),
        ...((extra?.component ?? fallbackComponent) ? { component: extra?.component ?? fallbackComponent } : {}),
        ...(stack ? { componentStack: stack.slice(0, 2000) } : {}),
        ...(uiBreadcrumbs.length > 0 ? { breadcrumbs: uiBreadcrumbs.slice(-MAX_BREADCRUMBS) } : {}),
      },
    })
    .catch(() => {});
}

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
    const lang = useUiStore.getState().language;
    sendRuntimeErrorPainPoint(
      t(lang, "runtime.errorTitle", { message: error?.message || t(lang, "runtime.unknownError") }),
      error?.stack ?? error?.message ?? "React render error",
      {
        component: "RootErrorBoundary",
        componentStack: info.componentStack ?? undefined,
      },
    );
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
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Icon icon={Crosshair} size={14} />
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
          <Icon icon={X} size={14} /> {t(language, "picker.cancel")}
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
    const onDocClick = (ev: MouseEvent) => {
      const rawTarget = ev.target;
      if (!(rawTarget instanceof HTMLElement)) return;
      const actionable = rawTarget.closest("button, a, [role='button'], [data-testid], [data-action]") as HTMLElement | null;
      const target = actionable ?? rawTarget;
      const desc = describePickedElement(target);
      pushUiBreadcrumb(`click ${desc.selector}${desc.snippet ? ` (${desc.snippet.slice(0, 40)})` : ""}`);
    };
    const unsubscribeUi = useUiStore.subscribe((next, prev) => {
      if (
        next.mainView !== prev.mainView ||
        next.selectedId !== prev.selectedId ||
        next.workspaceTab !== prev.workspaceTab ||
        next.modal?.kind !== prev.modal?.kind
      ) {
        pushUiBreadcrumb(
          `ui view=${next.mainView} req=${next.selectedId ?? "-"} tab=${next.workspaceTab} modal=${next.modal?.kind ?? "-"}`,
        );
      }
    });
    const onError = (ev: ErrorEvent) => {
      const lang = useUiStore.getState().language;
      sendRuntimeErrorPainPoint(
        t(lang, "runtime.errorTitle", { message: ev.message || t(lang, "runtime.unknownError") }),
        ev.error?.stack ?? `${ev.filename}:${ev.lineno}`,
      );
    };
    const onRejection = (ev: PromiseRejectionEvent) => {
      const lang = useUiStore.getState().language;
      const msg = ev.reason instanceof Error ? ev.reason.message : String(ev.reason ?? t(lang, "runtime.rejection"));
      sendRuntimeErrorPainPoint(
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

    document.addEventListener("click", onDocClick, true);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("click", onDocClick, true);
      unsubscribeUi();
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
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
  const { isError: selectedReqError } = useRequirementQuery(activeProjectId, projectReady ? selectedId : null);

  useEffect(() => {
    if (!projectReady || !selectedId || !selectedReqError) return;
    useUiStore.getState().setSelectedId(null);
  }, [projectReady, selectedId, selectedReqError]);

  useEffect(() => {
    if (!projectReady || selectedId !== null || !allReqList) return;
    const allItems = allReqList.items;
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
      <DomElementPicker />
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
