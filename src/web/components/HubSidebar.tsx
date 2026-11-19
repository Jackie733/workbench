import { Plus, Settings, X } from "lucide-react";
import { t } from "../i18n.ts";
import { useCollapsePhase } from "../lib/utils.ts";
import { openAddProjectModal, switchProject, useHubStateQuery, useProjectQuery } from "../queries.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { BrandMark } from "./BrandMark.tsx";
import { Icon } from "./Icon.tsx";

export function HubSidebar() {
  const language = useUiStore((s) => s.language);
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const desktopSidebarOpen = useUiStore((s) => s.desktopSidebarOpen);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const setModal = useUiStore((s) => s.setModal);

  const { data: hub } = useHubStateQuery();
  const { data: project } = useProjectQuery(activeProjectId);

  const projects = hub?.projects ?? [];
  const nodes = hub?.nodes ?? [];
  const remoteNodes = nodes.filter((n) => !n.isLocal);
  const hasMultiNode = remoteNodes.length > 0 || projects.some((p) => p.nodeId && p.nodeId !== "local");
  const activeNodeId = hub?.activeNodeId ?? "local";
  const activeNode = nodes.find((n) => n.nodeId === activeNodeId);
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
      ? t(language, "preset.sota_first")
      : routing?.activePreset === "quota_saver"
        ? t(language, "preset.quota_saver")
        : t(language, "preset.balanced");

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
              <BrandMark />
              <span>Workbench</span>
            </div>
            <button
              className="btn ghost xs sb-close-btn"
              type="button"
              title={t(language, "sidebar.collapse")}
              aria-label={t(language, "sidebar.collapse")}
              onClick={() => setSidebarOpen(false)}
            >
              <Icon icon={X} />
            </button>
          </div>

          <div className="sb-section">
            <div className="sb-head">
              <span>
                {t(language, hasMultiNode ? "sidebar.projects" : "sidebar.localProjects", {
                  count: projects.length,
                })}
              </span>
              <button
                className="btn ghost xs"
                type="button"
                data-action="open-add-project"
                data-testid="add-project-btn"
                title={t(language, "sidebar.addTitle")}
                onClick={() => void openAddProjectModal(activeNodeId)}
              >
                <Icon icon={Plus} size={14} /> {t(language, "sidebar.add")}
              </button>
            </div>
            <div className="sb-list" data-testid="hub-project-list">
              {projects.length === 0 ? (
                <div className="muted xs" style={{ padding: "6px 8px" }}>
                  {t(language, "sidebar.empty")}
                </div>
              ) : (
                projects.map((p) => {
                  const active =
                    p.id === activeProjectId || (activeProjectId === null && p.root === project?.root);
                  const isRemote = Boolean(p.nodeId && p.nodeId !== "local");
                  const offline = isRemote && p.nodeOnline === false;
                  return (
                    <div
                      key={p.id}
                      className={`sb-item ${active ? "active" : ""}`}
                      data-action="switch-project"
                      data-id={p.id}
                      data-testid={`hub-project-${p.id}`}
                      title={isRemote ? `[${p.nodeName ?? p.nodeId}] ${p.root}` : p.root}
                      onClick={() => void switchProject(p.id)}
                    >
                      <div className="sb-item-main">
                        <span
                          className={`sb-dot ${
                            offline ? "" : p.runningCount > 0 ? "running" : p.initialized ? "ready" : "uninit"
                          }`}
                        />
                        <span className="sb-item-name">{p.name}</span>
                      </div>
                      <div className="sb-item-badges">
                        {isRemote && (
                          <span className="sb-badge" title={t(language, "sidebar.nodeTitle", { node: p.nodeName ?? p.nodeId ?? "" })}>
                            {p.nodeName ?? p.nodeId}
                          </span>
                        )}
                        {p.decisionCount > 0 && (
                          <span className="sb-badge warn" title={t(language, "sidebar.decisionTitle")}>
                            {p.decisionCount}
                          </span>
                        )}
                        {offline ? (
                          <span className="sb-badge muted">{t(language, "common.offline")}</span>
                        ) : !p.initialized ? (
                          <span className="sb-badge muted">{t(language, "sidebar.uninitialized")}</span>
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

          {remoteNodes.length > 0 && (
            <div className="sb-section">
              <div className="sb-head">
                <span>
                  {t(language, "sidebar.nodes", {
                    connected: nodes.filter((n) => n.connected).length,
                    total: nodes.length,
                  })}
                </span>
              </div>
              <div className="sb-harnesses" data-testid="hub-nodes-list">
                {nodes.map((n) => (
                  <div key={n.nodeId} className="sb-harness-row" title={`${n.hostname} (${n.platform})`}>
                    <span className={`dot ${n.connected ? "online" : ""}`} />
                    <span className="sb-harness-name" style={{ fontFamily: "var(--sans)" }}>
                      {n.name}
                    </span>
                    <span className="muted xs">
                      {n.connected ? t(language, "common.online") : t(language, "common.offline")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="sb-section sb-section-bottom">
            <div className="sb-head">
              <span>
                {t(language, "sidebar.routing")}
                {hasMultiNode && activeNode ? ` · ${activeNode.name}` : ""}
              </span>
              <button
                className="btn ghost xs"
                type="button"
                data-action="open-routing"
                data-testid="sidebar-routing-btn"
                onClick={() =>
                  setModal({ kind: "routing", draft: null })
                }
              >
                <Icon icon={Settings} size={14} /> {t(language, "sidebar.configure")}
              </button>
            </div>
            <div
              className="sb-preset-pill"
              role="button"
              tabIndex={0}
              onClick={() =>
                setModal({ kind: "routing", draft: null })
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setModal({ kind: "routing", draft: null });
                }
              }}
            >
              <span className="muted xs">{t(language, "sidebar.currentPolicy")}</span>
              <span className="badge info">{presetLabel}</span>
            </div>
            <div className="sb-harnesses">
              {harnesses.map((h) => (
                <div key={h.id} className="sb-harness-row" title={h.subscription}>
                  <span className={`dot ${h.installed ? "online" : ""}`} />
                  <span className="sb-harness-name">{h.id}</span>
                  <span className="muted xs">
                    {h.installed
                      ? t(
                          language,
                          h.models.length === 1 ? "sidebar.modelCountOne" : "sidebar.modelCountOther",
                          { count: h.models.length },
                        )
                      : t(language, "common.uninstalled")}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
