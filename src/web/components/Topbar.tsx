import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  BarChart3,
  Laptop,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Moon,
  Settings,
  Sparkles,
  Sun,
  Zap,
} from "lucide-react";
import { t } from "../i18n.ts";
import { backHome, logoutSession, useAuthStatusQuery, useHubStateQuery, useProjectQuery } from "../queries.ts";
import { bridgeStatusLabel } from "../state.ts";
import { useStreamStore } from "../stores/streamStore.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { BrandMark } from "./BrandMark.tsx";
import { Icon } from "./Icon.tsx";
import { UiLanguageSelect } from "./Primitives.tsx";

export function Topbar() {
  const theme = useUiStore((s) => s.theme);
  const language = useUiStore((s) => s.language);
  const mainView = useUiStore((s) => s.mainView);
  const headerRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const root = document.documentElement;
    const syncHeaderHeight = () => {
      const height = Math.ceil(header.getBoundingClientRect().height);
      if (height > 0) root.style.setProperty("--mobile-header-h", `${height}px`);
    };
    syncHeaderHeight();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(syncHeaderHeight);
    observer?.observe(header);
    window.addEventListener("resize", syncHeaderHeight);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", syncHeaderHeight);
      root.style.removeProperty("--mobile-header-h");
    };
  }, []);
  const setMainView = useUiStore((s) => s.setMainView);
  const selectedId = useUiStore((s) => s.selectedId);
  const drawerOpen = useUiStore((s) => s.drawerOpen);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const desktopSidebarOpen = useUiStore((s) => s.desktopSidebarOpen);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const setDesktopSidebarOpen = useUiStore((s) => s.setDesktopSidebarOpen);
  const setDrawerOpen = useUiStore((s) => s.setDrawerOpen);
  const setModal = useUiStore((s) => s.setModal);
  const toggleTheme = useUiStore((s) => s.toggleTheme);

  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 820px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 820px)");
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const activeRunCount = useStreamStore((s) => Object.keys(s.activeRuns).length);
  const { data: auth } = useAuthStatusQuery();
  const { data: hub } = useHubStateQuery();
  const { data: project } = useProjectQuery(activeProjectId);

  const isHub = Boolean(hub?.hubMode);
  const hasSidebar = Boolean(isHub || project?.initialized);
  const noHubProject = Boolean(hub?.hubMode && hub.projects.length === 0);
  const activeSummary = hub?.projects.find((p) => p.id === (activeProjectId ?? hub.activeProjectId)) ?? hub?.projects[0];
  const isRemoteProj = Boolean(activeSummary?.nodeId && activeSummary.nodeId !== "local");
  const projName = noHubProject
    ? ""
    : (activeSummary?.name ?? project?.project?.name ?? project?.root.split("/").pop() ?? "");
  const bridge = noHubProject ? undefined : project?.bridge;
  const working = Boolean(bridge?.connected && bridge.state !== "idle");
  const sidebarLabel = isMobile
    ? t(language, "topbar.toggleSidebarMobile")
    : desktopSidebarOpen
      ? t(language, "topbar.collapseSidebar")
      : t(language, "topbar.expandSidebar");

  return (
    <header ref={headerRef} className="topbar app-header" data-testid="app-header">
      <div className="topbar-left">
        <button
          className="app-brand-btn"
          type="button"
          title={t(language, "topbar.homeTitle")}
          onClick={() => {
            if (selectedId) backHome();
          }}
        >
          <BrandMark />
          <span className="app-brand-name">Workbench</span>
        </button>

        {hasSidebar && (
          <button
            className="btn ghost xs"
            type="button"
            data-action="toggle-sidebar"
            data-testid="toggle-sidebar-btn"
            title={sidebarLabel}
            aria-label={sidebarLabel}
            aria-expanded={isMobile ? sidebarOpen : desktopSidebarOpen}
            onClick={() => (isMobile ? setSidebarOpen(!sidebarOpen) : setDesktopSidebarOpen(!desktopSidebarOpen))}
          >
            <Icon icon={(isMobile ? sidebarOpen : desktopSidebarOpen) ? PanelLeftClose : PanelLeftOpen} />
          </button>
        )}

        {projName && (
          <div className="app-breadcrumb">
            <span className="muted">/</span>
            {selectedId ? (
              <>
                <button
                  className="btn ghost xs"
                  type="button"
                  data-action="back-home"
                  data-testid="back-home-btn"
                  onClick={() => backHome()}
                >
                  <Icon icon={ArrowLeft} size={14} /> {projName}
                </button>
                <span className="muted">/</span>
                <strong className="app-req-id">{selectedId}</strong>
              </>
            ) : (
              <span className="brand">{projName}</span>
            )}
            {isRemoteProj && activeSummary && (
              <span
                className={`badge ${activeSummary.nodeOnline === false ? "warning" : "info"}`}
                title={t(language, "topbar.nodeTitle", {
                  node: activeSummary.nodeName ?? activeSummary.nodeId ?? "",
                  root: activeSummary.root,
                })}
                data-testid="topbar-node-badge"
              >
                <Icon icon={Laptop} size={14} /> {activeSummary.nodeName ?? activeSummary.nodeId}
                {activeSummary.nodeOnline === false ? t(language, "topbar.offlineSuffix") : ""}
              </span>
            )}
          </div>
        )}

        {!projName && selectedId && (
          <div className="app-breadcrumb">
            <button
              className="btn ghost xs"
              type="button"
              data-action="back-home"
              data-testid="back-home-btn"
              onClick={() => backHome()}
            >
              <Icon icon={ArrowLeft} size={14} /> {t(language, "topbar.workspace")}
            </button>
            <span className="muted">/</span>
            <strong className="app-req-id">{selectedId}</strong>
          </div>
        )}

        <span className="bridge-pill" title={t(language, "topbar.bridgeTitle")}>
          <span className={`dot ${working ? "working" : bridge?.connected ? "online" : ""}`} />
          <span className="header-btn-label">{bridgeStatusLabel(bridge, language)}</span>
        </span>
      </div>

      <div className="topbar-right">
        <UiLanguageSelect className="topbar-language" />

        <button
          className={`btn xs ${mainView === "insights" ? "primary" : "ghost"}`}
          type="button"
          data-testid="topbar-insights-btn"
          title={t(language, "insights.title")}
          aria-label={t(language, "insights.navLabel")}
          onClick={() => {
            setSidebarOpen(false);
            setMainView(mainView === "insights" ? "workspace" : "insights");
          }}
        >
          <Icon icon={BarChart3} size={14} />
          <span className="header-btn-label">{t(language, "insights.navLabel")}</span>
        </button>

        {isHub && (
          <button
            className="btn ghost xs"
            type="button"
            data-action="open-evolution"
            data-testid="open-evolution-btn"
            title={t(language, "topbar.evolutionTitle")}
            aria-label={t(language, "topbar.evolutionAria")}
            onClick={() => {
              setSidebarOpen(false);
              setModal({ kind: "evolution", tab: "inbox", playbookDraft: null });
            }}
          >
            <Icon icon={Sparkles} size={14} />
            <span className="header-btn-label">{t(language, "topbar.evolutionLabel")}</span>
            {(hub?.evolutionOpenCount ?? 0) > 0 && (
              <span className="sb-badge warn" title={t(language, "topbar.pendingPains")}>
                {hub?.evolutionOpenCount}
              </span>
            )}
            {(hub?.cooldownCount ?? 0) > 0 && (
              <span className="sb-badge" title={t(language, "topbar.cooldownModels")}>
                {hub?.cooldownCount}
              </span>
            )}
          </button>
        )}

        <button
          className="btn ghost xs"
          type="button"
          data-action="open-quick-report"
          data-testid="open-quick-report-btn"
          title={t(language, "topbar.quickReportTitle")}
          aria-label={t(language, "topbar.quickReportAria")}
          onClick={() =>
            setModal({
              kind: "quick_report",
              title: "",
              detail: "",
              category: "ui_anomaly",
              domSelector: "",
              pickingElement: false,
              autoPromote: false,
            })
          }
        >
          <Icon icon={Zap} size={14} />
          <span className="header-btn-label">{t(language, "topbar.quickReportLabel")}</span>
        </button>

        <button
          className="btn ghost xs"
          type="button"
          data-action="open-routing"
          data-testid="open-routing-btn"
          title={t(language, "topbar.settingsTitle")}
          aria-label={t(language, "topbar.settingsAria")}
          onClick={() => setModal({ kind: "routing", draft: null })}
        >
          <Icon icon={Settings} size={14} />
          <span className="header-btn-label">{t(language, "topbar.settingsLabel")}</span>
        </button>

        <button
          className="btn ghost xs"
          type="button"
          data-action="toggle-theme"
          title={theme === "dark" ? t(language, "topbar.themeToLight") : t(language, "topbar.themeToDark")}
          aria-label={theme === "dark" ? t(language, "topbar.themeToLight") : t(language, "topbar.themeToDark")}
          onClick={toggleTheme}
        >
          <Icon icon={theme === "dark" ? Sun : Moon} size={14} />
        </button>

        <button
          className={`btn xs ${selectedId && drawerOpen ? "primary" : ""}`}
          type="button"
          data-action="toggle-drawer"
          data-testid="toggle-drawer-btn"
          disabled={!selectedId}
          aria-expanded={Boolean(selectedId && drawerOpen)}
          aria-label={drawerOpen ? t(language, "topbar.collapseDrawer") : t(language, "topbar.expandDrawer")}
          title={
            selectedId
              ? drawerOpen
                ? t(language, "topbar.drawerTitleOpen")
                : t(language, "topbar.drawerTitleClosed")
              : t(language, "topbar.drawerTitleDisabled")
          }
          onClick={() => {
            if (selectedId) setDrawerOpen(!drawerOpen);
          }}
        >
          {activeRunCount > 0 && <span className="pulse-dot" />}
          <Icon icon={selectedId && drawerOpen ? PanelRightClose : PanelRightOpen} size={14} />
          <span className="header-btn-label">
            {selectedId && drawerOpen ? t(language, "topbar.drawerLabelOpen") : t(language, "topbar.drawerLabelClosed")}
          </span>
        </button>

        {auth?.required && auth?.authenticated && (
          <button
            className="btn ghost xs"
            type="button"
            data-testid="logout-btn"
            title={t(language, "topbar.logout")}
            aria-label={t(language, "topbar.logout")}
            onClick={() => void logoutSession()}
          >
            <Icon icon={LogOut} size={14} />
          </button>
        )}
      </div>
    </header>
  );
}
