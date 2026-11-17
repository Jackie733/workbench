import { ArrowLeft, Menu, MessageSquare, Moon, RefreshCw, Settings, Sun, Zap } from "lucide-react";
import { backHome, invalidateAllWorkbenchQueries, useHubStateQuery, useProjectQuery } from "../queries.ts";
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
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const setDrawerOpen = useUiStore((s) => s.setDrawerOpen);
  const setModal = useUiStore((s) => s.setModal);
  const toggleTheme = useUiStore((s) => s.toggleTheme);

  const activeRunCount = useStreamStore((s) => Object.keys(s.activeRuns).length);
  const { data: hub } = useHubStateQuery();
  const { data: project } = useProjectQuery(activeProjectId);

  const noHubProject = Boolean(hub?.hubMode && hub.projects.length === 0);
  const projName = noHubProject ? "Workbench" : (project?.project?.name ?? project?.root.split("/").pop() ?? "Workbench");
  const bridge = noHubProject ? undefined : project?.bridge;
  const working = Boolean(bridge?.connected && bridge.state !== "idle");

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button
          className="btn ghost xs mobile-only"
          type="button"
          title="项目与算力侧栏"
          aria-label="项目与算力侧栏"
          onClick={() => setSidebarOpen(!sidebarOpen)}
        >
          <Icon icon={Menu} />
        </button>
        {selectedId ? (
          <>
            <button
              className="btn ghost"
              type="button"
              data-action="back-home"
              data-testid="back-home-btn"
              onClick={() => backHome()}
            >
              <Icon icon={ArrowLeft} /> 工作
            </button>
            <span className="muted">/</span>
            <strong>{selectedId}</strong>
          </>
        ) : (
          <span className="brand">{projName}</span>
        )}
        <span className="bridge-pill" title="本地 CLI / omp 会话状态">
          <span className={`dot ${working ? "working" : bridge?.connected ? "online" : ""}`} />
          {bridgeStatusLabel(bridge)}
        </span>
      </div>
      <div className="topbar-right">
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
          <Icon icon={Zap} size={14} /> 报修
        </button>
        <button
          className="btn ghost xs"
          type="button"
          data-action="refresh"
          title="刷新状态"
          aria-label="刷新状态"
          onClick={() => void invalidateAllWorkbenchQueries()}
        >
          <Icon icon={RefreshCw} />
        </button>
        <button
          className="btn ghost xs"
          type="button"
          data-action="toggle-theme"
          title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
          aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
          onClick={toggleTheme}
        >
          <Icon icon={theme === "dark" ? Sun : Moon} />
        </button>
        {selectedId ? (
          <button
            className={`btn ${drawerOpen ? "primary" : ""}`}
            type="button"
            data-action="toggle-drawer"
            data-testid="toggle-drawer-btn"
            onClick={() => setDrawerOpen(!drawerOpen)}
          >
            {activeRunCount > 0 && <span className="pulse-dot" />}
            <Icon icon={MessageSquare} /> 研讨 / 终端
          </button>
        ) : (
          <button
            className="btn ghost xs"
            type="button"
            title="模型路由配置"
            onClick={() =>
              setModal({
                kind: "routing",
                draft: hub?.routing ?? null,
                customHarness: "opencode",
                customModel: "",
              })
            }
          >
            <Icon icon={Settings} /> 路由
          </button>
        )}
      </div>
    </header>
  );
}
