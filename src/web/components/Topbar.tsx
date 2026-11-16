import { ArrowLeft, Menu, MessageSquare, Moon, RefreshCw, Settings, Sun } from "lucide-react";
import { useWorkbench } from "../context.tsx";
import { bridgeStatusLabel } from "../state.ts";
import { Icon } from "./Icon.tsx";

export function Topbar() {
  const { state, setState, backHome, refreshAll, refreshHubMetadata, toggleTheme, setDrawerOpen } = useWorkbench();
  const projName = state.project?.project?.name ?? state.project?.root.split("/").pop() ?? "Workbench";
  const bridge = state.project?.bridge;
  const working = Boolean(bridge?.connected && bridge.state !== "idle");
  const activeRunCount = Object.keys(state.activeRuns).length;

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button
          className="btn ghost xs mobile-only"
          type="button"
          title="项目与算力侧栏"
          aria-label="项目与算力侧栏"
          onClick={() => setState((prev) => ({ ...prev, sidebarOpen: !prev.sidebarOpen }))}
        >
          <Icon icon={Menu} />
        </button>
        {state.selectedId ? (
          <>
            <button
              className="btn ghost"
              type="button"
              data-action="back-home"
              data-testid="back-home-btn"
              onClick={() => void backHome()}
            >
              <Icon icon={ArrowLeft} /> 工作
            </button>
            <span className="muted">/</span>
            <strong>{state.selectedId}</strong>
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
          data-action="refresh"
          title="刷新状态"
          aria-label="刷新状态"
          onClick={() => {
            void refreshHubMetadata(true);
            void refreshAll(true);
          }}
        >
          <Icon icon={RefreshCw} />
        </button>
        <button
          className="btn ghost xs"
          type="button"
          data-action="toggle-theme"
          title={state.theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
          aria-label={state.theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
          onClick={toggleTheme}
        >
          <Icon icon={state.theme === "dark" ? Sun : Moon} />
        </button>
        {state.selectedId ? (
          <button
            className={`btn ${state.drawerOpen ? "primary" : ""}`}
            type="button"
            data-action="toggle-drawer"
            data-testid="toggle-drawer-btn"
            onClick={() => setDrawerOpen(!state.drawerOpen)}
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
              setState((prev) => ({
                ...prev,
                modal: { kind: "routing", draft: prev.routing, customHarness: "opencode", customModel: "" },
              }))
            }
          >
            <Icon icon={Settings} /> 路由
          </button>
        )}
      </div>
    </header>
  );
}
