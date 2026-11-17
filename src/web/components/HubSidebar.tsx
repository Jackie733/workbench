import { Plus, Settings, X } from "lucide-react";
import { useCollapsePhase } from "../lib/utils.ts";
import { openAddProjectModal, switchProject, useHubStateQuery, useProjectQuery } from "../queries.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { Icon } from "./Icon.tsx";

export function HubSidebar() {
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const desktopSidebarOpen = useUiStore((s) => s.desktopSidebarOpen);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const setModal = useUiStore((s) => s.setModal);

  const { data: hub } = useHubStateQuery();
  const { data: project } = useProjectQuery(activeProjectId);

  const projects = hub?.projects ?? [];
  const harnesses = hub?.harnesses ?? [];
  const routing = hub?.routing ?? null;
  const desktopPhase = useCollapsePhase(desktopSidebarOpen, 245, 195);
  const desktopCls =
    desktopPhase === "open"
      ? "desktop-open"
      : desktopPhase === "opening"
        ? "desktop-opening"
        : desktopPhase === "entering"
          ? "desktop-collapsed entering"
          : desktopPhase === "closing"
            ? "desktop-collapsed closing"
            : "desktop-collapsed settled";

  const presetLabel =
    routing?.activePreset === "sota_first"
      ? "SOTA 优先"
      : routing?.activePreset === "quota_saver"
        ? "极致省流"
        : "性价比均衡";

  return (
    <>
      {sidebarOpen && (
        <div
          className="sidebar-backdrop mobile-only"
          aria-hidden="true"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside
        className={`sidebar ${sidebarOpen ? "open" : ""} ${desktopCls}`}
        data-testid="hub-sidebar"
      >
        <div className="sidebar-inner">
          <div className="sb-brand mobile-only">
            <div className="sb-brand-title">
              <span className="sb-logo">W</span>
              <span>Workbench</span>
            </div>
            <button
              className="btn ghost xs sb-close-btn"
              type="button"
              title="收起侧边栏"
              aria-label="收起侧边栏"
              onClick={() => setSidebarOpen(false)}
            >
              <Icon icon={X} />
            </button>
          </div>

          <div className="sb-section">
            <div className="sb-head">
              <span>本地项目 ({projects.length})</span>
              <button
                className="btn ghost xs"
                type="button"
                data-action="open-add-project"
                data-testid="add-project-btn"
                title="添加或初始化项目"
                onClick={() => void openAddProjectModal()}
              >
                <Icon icon={Plus} size={14} /> 添加
              </button>
            </div>
            <div className="sb-list" data-testid="hub-project-list">
              {projects.length === 0 ? (
                <div className="muted xs" style={{ padding: "6px 8px" }}>
                  暂无纳管项目
                </div>
              ) : (
                projects.map((p) => {
                  const active =
                    p.id === activeProjectId || (activeProjectId === null && p.root === project?.root);
                  return (
                    <div
                      key={p.id}
                      className={`sb-item ${active ? "active" : ""}`}
                      data-action="switch-project"
                      data-id={p.id}
                      data-testid={`hub-project-${p.id}`}
                      title={p.root}
                      onClick={() => void switchProject(p.id)}
                    >
                      <div className="sb-item-main">
                        <span className={`sb-dot ${p.runningCount > 0 ? "running" : p.initialized ? "ready" : "uninit"}`} />
                        <span className="sb-item-name">{p.name}</span>
                      </div>
                      <div className="sb-item-badges">
                        {p.decisionCount > 0 && (
                          <span className="sb-badge warn" title="待拍板">
                            {p.decisionCount}
                          </span>
                        )}
                        {!p.initialized ? (
                          <span className="sb-badge muted">未初始化</span>
                        ) : p.activeCount > 0 ? (
                          <span className="sb-badge">{p.activeCount}</span>
                        ) : null}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="sb-section">
            <div className="sb-head">
              <span>算力与模型路由</span>
              <button
                className="btn ghost xs"
                type="button"
                data-action="open-routing"
                data-testid="sidebar-routing-btn"
                onClick={() =>
                  setModal({ kind: "routing", draft: null, customHarness: "opencode", customModel: "" })
                }
              >
                <Icon icon={Settings} size={14} /> 配置
              </button>
            </div>
            <div
              className="sb-preset-pill"
              role="button"
              tabIndex={0}
              onClick={() =>
                setModal({ kind: "routing", draft: null, customHarness: "opencode", customModel: "" })
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setModal({ kind: "routing", draft: null, customHarness: "opencode", customModel: "" });
                }
              }}
            >
              <span className="muted xs">当前策略</span>
              <span className="badge info">{presetLabel}</span>
            </div>
            <div className="sb-harnesses">
              {harnesses.map((h) => (
                <div key={h.id} className="sb-harness-row" title={h.subscription}>
                  <span className={`dot ${h.installed ? "online" : ""}`} />
                  <span className="sb-harness-name">{h.id}</span>
                  <span className="muted xs">{h.installed ? `${h.models.length} 模型` : "未安装"}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
