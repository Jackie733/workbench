import { useEffect, useState } from "react";
import {
  ArrowLeft,
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
import { backHome, useHubStateQuery, useProjectQuery } from "../queries.ts";
import { bridgeStatusLabel } from "../state.ts";
import { useStreamStore } from "../stores/streamStore.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { Icon } from "./Icon.tsx";

export function Topbar() {
  const theme = useUiStore((s) => s.theme);
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
  const { data: hub } = useHubStateQuery();
  const { data: project } = useProjectQuery(activeProjectId);

  const isHub = Boolean(hub?.hubMode);
  const noHubProject = Boolean(hub?.hubMode && hub.projects.length === 0);
  const projName = noHubProject ? "" : (project?.project?.name ?? project?.root.split("/").pop() ?? "");
  const bridge = noHubProject ? undefined : project?.bridge;
  const working = Boolean(bridge?.connected && bridge.state !== "idle");

  return (
    <header className="topbar app-header" data-testid="app-header">
      <div className="topbar-left">
        <button
          className="app-brand-btn"
          type="button"
          title="Workbench 工作台"
          onClick={() => {
            if (selectedId) backHome();
          }}
        >
          <span className="sb-logo">W</span>
          <span className="app-brand-name">Workbench</span>
        </button>

        {isHub && (
          <button
            className="btn ghost xs"
            type="button"
            data-action="toggle-sidebar"
            data-testid="toggle-sidebar-btn"
            title={isMobile ? "项目与算力侧栏" : desktopSidebarOpen ? "收起左侧栏" : "展开左侧栏"}
            aria-label={isMobile ? "项目与算力侧栏" : desktopSidebarOpen ? "收起左侧栏" : "展开左侧栏"}
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
              <Icon icon={ArrowLeft} size={14} /> 工作
            </button>
            <span className="muted">/</span>
            <strong className="app-req-id">{selectedId}</strong>
          </div>
        )}

        <span className="bridge-pill" title="本地 CLI / omp 会话状态">
          <span className={`dot ${working ? "working" : bridge?.connected ? "online" : ""}`} />
          <span className="header-btn-label">{bridgeStatusLabel(bridge)}</span>
        </span>
      </div>

      <div className="topbar-right">
        {isHub && (
          <button
            className="btn ghost xs"
            type="button"
            data-action="open-evolution"
            data-testid="open-evolution-btn"
            title="自进化与 RSI 中心"
            aria-label="自进化中心"
            onClick={() => {
              setSidebarOpen(false);
              setModal({ kind: "evolution", tab: "inbox", playbookDraft: null });
            }}
          >
            <Icon icon={Sparkles} size={14} />
            <span className="header-btn-label">自进化中心</span>
            {(hub?.evolutionOpenCount ?? 0) > 0 && (
              <span className="sb-badge warn" title="待处理痛点">
                {hub?.evolutionOpenCount}
              </span>
            )}
            {(hub?.cooldownCount ?? 0) > 0 && (
              <span className="sb-badge" title="冷却中模型">
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
          title="随手报修 / 自进化建议 (Alt+R)"
          aria-label="随手报修 / 自进化建议"
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
          <span className="header-btn-label">报修</span>
        </button>

        <button
          className="btn ghost xs"
          type="button"
          data-action="open-routing"
          data-testid="open-routing-btn"
          title="工作台设置（全局与项目）"
          aria-label="工作台设置"
          onClick={() => setModal({ kind: "routing", draft: null })}
        >
          <Icon icon={Settings} size={14} />
          <span className="header-btn-label">设置</span>
        </button>

        <button
          className="btn ghost xs"
          type="button"
          data-action="toggle-theme"
          title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
          aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
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
          aria-label={drawerOpen ? "收起右侧栏" : "展开右侧栏"}
          title={
            selectedId
              ? drawerOpen
                ? "收起研讨与终端侧栏 (Ctrl+\\)"
                : "展开研讨与终端侧栏 (Ctrl+\\)"
              : "打开任意需求后可展开研讨与终端侧栏"
          }
          onClick={() => {
            if (selectedId) setDrawerOpen(!drawerOpen);
          }}
        >
          {activeRunCount > 0 && <span className="pulse-dot" />}
          <Icon icon={selectedId && drawerOpen ? PanelRightClose : PanelRightOpen} size={14} />
          <span className="header-btn-label">{selectedId && drawerOpen ? "收起侧栏" : "研讨 / 终端"}</span>
        </button>
      </div>
    </header>
  );
}
