import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  ArrowLeft,
  BarChart3,
  Laptop,
  LayoutDashboard,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Moon,
  Settings,
  Sun,
} from "lucide-react";
import { t } from "../i18n.ts";
import { backHome, logoutSession, useAuthStatusQuery, useHubStateQuery, useProjectQuery } from "../queries.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { BrandMark } from "./BrandMark.tsx";
import { Icon } from "./Icon.tsx";
import { UiLanguageSelect } from "./Primitives.tsx";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./ui/alert-dialog.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";

export function Topbar() {
  const theme = useUiStore((s) => s.theme);
  const language = useUiStore((s) => s.language);
  const mainView = useUiStore((s) => s.mainView);
  const setMainView = useUiStore((s) => s.setMainView);
  const selectedId = useUiStore((s) => s.selectedId);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const desktopSidebarOpen = useUiStore((s) => s.desktopSidebarOpen);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const setDesktopSidebarOpen = useUiStore((s) => s.setDesktopSidebarOpen);
  const setModal = useUiStore((s) => s.setModal);
  const toggleTheme = useUiStore((s) => s.toggleTheme);

  const [logoutOpen, setLogoutOpen] = useState(false);
  const logout = useMutation({
    mutationFn: logoutSession,
    onSuccess: () => setLogoutOpen(false),
    onError: (error) => useUiStore.getState().showToastError(error),
  });
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 820px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 820px)");
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const headerRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // 窄屏下顶栏会换行变高；抽屉/侧栏/遮罩都按 --header-h 固定偏移，必须跟随实际高度。
    const ro = new ResizeObserver(() => {
      document.documentElement.style.setProperty("--header-h", `${el.offsetHeight}px`);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty("--header-h");
    };
  }, []);

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
        <div className="topbar-view-switch" role="group" aria-label={t(language, "topbar.viewSwitchAria")}>
          <button
            className={`seg-btn ${mainView !== "insights" ? "active" : ""}`}
            type="button"
            data-testid="topbar-workspace-btn"
            aria-pressed={mainView !== "insights"}
            onClick={() => {
              setSidebarOpen(false);
              setMainView("workspace");
            }}
          >
            <Icon icon={LayoutDashboard} size={14} />
            <span className="header-btn-label">{t(language, "topbar.workspaceView")}</span>
          </button>
          <button
            className={`seg-btn ${mainView === "insights" ? "active" : ""}`}
            type="button"
            data-testid="topbar-insights-btn"
            aria-pressed={mainView === "insights"}
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
        </div>

        <span className="topbar-divider" aria-hidden="true" />

        <Button
          size="icon-xs"
          type="button"
          variant="ghost"
          data-action="open-routing"
          data-testid="open-routing-btn"
          title={t(language, "topbar.settingsTitle")}
          aria-label={t(language, "topbar.settingsAria")}
          onClick={() => setModal({ kind: "routing", draft: null })}
        >
          <Icon icon={Settings} size={14} />
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

        <UiLanguageSelect iconOnly />

        {auth?.required && auth?.authenticated && (
          <>
            <span className="topbar-divider" aria-hidden="true" />
            <AlertDialog
              open={logoutOpen}
              onOpenChange={(open, event) => {
                if (logout.isPending) event.cancel();
                else setLogoutOpen(open);
              }}
            >
              <AlertDialogTrigger
                render={<Button size="icon-xs" type="button" variant="ghost" />}
                data-testid="logout-btn"
                title={t(language, "topbar.logout")}
                aria-label={t(language, "topbar.logout")}
              >
                <Icon icon={LogOut} size={14} />
              </AlertDialogTrigger>
              <AlertDialogPopup data-testid="logout-dialog">
                <AlertDialogHeader>
                  <AlertDialogTitle>{t(language, "topbar.logoutTitle")}</AlertDialogTitle>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose disabled={logout.isPending} render={<Button type="button" variant="ghost" />}>
                    {t(language, "common.cancel")}
                  </AlertDialogClose>
                  <Button type="button" variant="destructive" loading={logout.isPending} onClick={() => logout.mutate()}>
                    {t(language, "topbar.logout")}
                  </Button>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>
          </>
        )}
      </div>
    </header>
  );
}