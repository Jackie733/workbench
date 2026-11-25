import { useEffect, useState } from "react";
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
  Sun,
} from "lucide-react";
import { t } from "../i18n.ts";
import { backHome, logoutSession, useAuthStatusQuery, useHubStateQuery, useProjectQuery } from "../queries.ts";
import { useStreamStore } from "../stores/streamStore.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { BrandMark } from "./BrandMark.tsx";
import { Icon } from "./Icon.tsx";
import { UiLanguageSelect } from "./Primitives.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";

export function Topbar() {
  const theme = useUiStore((s) => s.theme);
  const language = useUiStore((s) => s.language);
  const mainView = useUiStore((s) => s.mainView);
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
  const sidebarLabel = isMobile
    ? t(language, "topbar.toggleSidebarMobile")
    : desktopSidebarOpen
      ? t(language, "topbar.collapseSidebar")
      : t(language, "topbar.expandSidebar");

  return (
    <header className="topbar app-header" data-testid="app-header">
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
          <Button
            size="icon-xs"
            type="button"
            variant="ghost"
            data-action="toggle-sidebar"
            data-testid="toggle-sidebar-btn"
            title={sidebarLabel}
            aria-label={sidebarLabel}
            aria-expanded={isMobile ? sidebarOpen : desktopSidebarOpen}
            onClick={() => (isMobile ? setSidebarOpen(!sidebarOpen) : setDesktopSidebarOpen(!desktopSidebarOpen))}
          >
            <Icon icon={(isMobile ? sidebarOpen : desktopSidebarOpen) ? PanelLeftClose : PanelLeftOpen} />
          </Button>
        )}

        {projName && (
          <div className="app-breadcrumb">
            <span className="muted">/</span>
            {selectedId ? (
              <>
                <Button
                  size="xs"
                  type="button"
                  variant="ghost"
                  data-action="back-home"
                  data-testid="back-home-btn"
                  onClick={() => backHome()}
                >
                  <Icon icon={ArrowLeft} size={14} /> {projName}
                </Button>
                <span className="muted">/</span>
                <strong className="app-req-id">{selectedId}</strong>
              </>
            ) : (
              <span className="brand">{projName}</span>
            )}
            {isRemoteProj && activeSummary && (
              <Badge
                variant={activeSummary.nodeOnline === false ? "warning" : "info"}
                title={t(language, "topbar.nodeTitle", {
                  node: activeSummary.nodeName ?? activeSummary.nodeId ?? "",
                  root: activeSummary.root,
                })}
                data-testid="topbar-node-badge"
              >
                <Icon icon={Laptop} size={14} /> {activeSummary.nodeName ?? activeSummary.nodeId}
                {activeSummary.nodeOnline === false ? t(language, "topbar.offlineSuffix") : ""}
              </Badge>
            )}
          </div>
        )}

        {!projName && selectedId && (
          <div className="app-breadcrumb">
            <Button
              size="xs"
              type="button"
              variant="ghost"
              data-action="back-home"
              data-testid="back-home-btn"
              onClick={() => backHome()}
            >
              <Icon icon={ArrowLeft} size={14} /> {t(language, "topbar.workspace")}
            </Button>
            <span className="muted">/</span>
            <strong className="app-req-id">{selectedId}</strong>
          </div>
        )}

      </div>

      <div className="topbar-right">
        <UiLanguageSelect className="topbar-language" />

        <Button
          size="xs"
          type="button"
          variant={mainView === "insights" ? "default" : "ghost"}
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
        </Button>

        <Button
          size="xs"
          type="button"
          variant="ghost"
          data-action="open-routing"
          data-testid="open-routing-btn"
          title={t(language, "topbar.settingsTitle")}
          aria-label={t(language, "topbar.settingsAria")}
          onClick={() => setModal({ kind: "routing", draft: null })}
        >
          <Icon icon={Settings} size={14} />
          <span className="header-btn-label">{t(language, "topbar.settingsLabel")}</span>
        </Button>

        <Button
          size="icon-xs"
          type="button"
          variant="ghost"
          data-action="toggle-theme"
          title={theme === "dark" ? t(language, "topbar.themeToLight") : t(language, "topbar.themeToDark")}
          aria-label={theme === "dark" ? t(language, "topbar.themeToLight") : t(language, "topbar.themeToDark")}
          onClick={toggleTheme}
        >
          <Icon icon={theme === "dark" ? Sun : Moon} size={14} />
        </Button>

        <Button
          size="xs"
          type="button"
          variant={selectedId && drawerOpen ? "default" : "outline"}
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
        </Button>

        {auth?.required && auth?.authenticated && (
          <Button
            size="icon-xs"
            type="button"
            variant="ghost"
            data-testid="logout-btn"
            title={t(language, "topbar.logout")}
            aria-label={t(language, "topbar.logout")}
            onClick={() => void logoutSession()}
          >
            <Icon icon={LogOut} size={14} />
          </Button>
        )}
      </div>
    </header>
  );
}