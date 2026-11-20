import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, Folder, Plus, Settings, Star, X } from "lucide-react";
import { api, type HubProjectSummary } from "../api.ts";
import { t } from "../i18n.ts";
import { useCollapsePhase } from "../lib/utils.ts";
import { openAddProjectModal, queryClient, queryKeys, switchProject, useHubStateQuery, useProjectQuery } from "../queries.ts";
import { groupHubProjects, type ProjectGroupMode, type ProjectSortMode } from "../state.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { BrandMark } from "./BrandMark.tsx";
import { HomeView } from "./HomeView.tsx";
import { Icon } from "./Icon.tsx";

export function HubSidebar() {
  const language = useUiStore((s) => s.language);
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const desktopSidebarOpen = useUiStore((s) => s.desktopSidebarOpen);
  const projectSort = useUiStore((s) => s.projectSort);
  const projectGroup = useUiStore((s) => s.projectGroup);
  const projectsCollapsed = useUiStore((s) => s.projectsCollapsed);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const setProjectSort = useUiStore((s) => s.setProjectSort);
  const setProjectGroup = useUiStore((s) => s.setProjectGroup);
  const setProjectsCollapsed = useUiStore((s) => s.setProjectsCollapsed);
  const setModal = useUiStore((s) => s.setModal);

  const [editingCatId, setEditingCatId] = useState<string | null>(null);
  const [catDraft, setCatDraft] = useState("");

  useEffect(() => {
    setEditingCatId(null);
  }, [activeProjectId, projectsCollapsed]);

  const { data: hub } = useHubStateQuery();
  const { data: project } = useProjectQuery(activeProjectId);

  const isHub = Boolean(hub?.hubMode);
  const projects = hub?.projects ?? [];
  const nodes = hub?.nodes ?? [];
  const remoteNodes = nodes.filter((n) => !n.isLocal);
  const hasMultiNode = remoteNodes.length > 0 || projects.some((p) => p.nodeId && p.nodeId !== "local");
  const activeNodeId = hub?.activeNodeId ?? "local";
  const activeNode = nodes.find((n) => n.nodeId === activeNodeId);
  const hubRevision = nodes.find((node) => node.isLocal)?.revision;

  const activeSummary =
    projects.find((p) => p.id === activeProjectId || (activeProjectId === null && p.root === project?.root)) ??
    projects[0] ??
    null;
  const noHubProject = Boolean(isHub && projects.length === 0);
  const remoteOffline = Boolean(isHub && activeSummary && activeSummary.nodeOnline === false);
  const showReqNav = Boolean(project?.initialized && !remoteOffline && !noHubProject);

  const updateNode = useMutation({
    mutationFn: api.updateNode,
    onError: (error) => useUiStore.getState().showToastError(error),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.hubState }),
  });

  const updateProjectMeta = useMutation({
    mutationFn: api.updateHubProjectMeta,
    onError: (error) => useUiStore.getState().showToastError(error),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.hubState }),
  });

  const harnesses = hub?.harnesses ?? [];
  const installedHarnesses = harnesses.filter((h) => h.installed);
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

  const projectSections = groupHubProjects(projects, projectGroup, projectSort, language);

  const openCategoryEditor = (p: HubProjectSummary) => {
    setEditingCatId((prev) => (prev === p.id ? null : p.id));
    setCatDraft(p.category ?? "");
  };

  const commitCategory = (projectId: string) => {
    const trimmed = catDraft.trim();
    updateProjectMeta.mutate({ projectId, category: trimmed ? trimmed : null });
    setEditingCatId(null);
  };

  const renderProjectRow = (p: HubProjectSummary) => {
    const active = p.id === activeProjectId || (activeProjectId === null && p.root === project?.root);
    const isRemote = Boolean(p.nodeId && p.nodeId !== "local");
    const offline = isRemote && p.nodeOnline === false;
    const editingCat = editingCatId === p.id;
    return (
      <div key={p.id}>
        <div
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
            {projectGroup !== "category" && p.category && (
              <span className="sb-badge" data-testid={`project-cat-badge-${p.id}`}>
                {p.category}
              </span>
            )}
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
            <button
              type="button"
              className={`btn ghost xs sb-meta-btn ${p.pinned ? "pinned" : ""}`}
              data-testid={`pin-project-${p.id}`}
              title={p.pinned ? t(language, "sidebar.unpin") : t(language, "sidebar.pin")}
              aria-label={p.pinned ? t(language, "sidebar.unpin") : t(language, "sidebar.pin")}
              onClick={(e) => {
                e.stopPropagation();
                updateProjectMeta.mutate({ projectId: p.id, pinned: !p.pinned });
              }}
            >
              <Icon icon={Star} size={14} />
            </button>
            <button
              type="button"
              className="btn ghost xs sb-meta-btn"
              data-testid={`category-project-${p.id}`}
              title={t(language, "sidebar.setCategory")}
              aria-label={t(language, "sidebar.setCategory")}
              onClick={(e) => {
                e.stopPropagation();
                openCategoryEditor(p);
              }}
            >
              <Icon icon={Folder} size={14} />
            </button>
          </div>
        </div>
        {editingCat && (
          <div
            className="sb-cat-editor"
            onClick={(e) => e.stopPropagation()}
            style={{ display: "flex", gap: 4, padding: "4px 6px 2px" }}
          >
            <input
              className="input"
              style={{ padding: "3px 6px", fontSize: 12 }}
              data-testid={`category-input-${p.id}`}
              maxLength={32}
              autoFocus
              value={catDraft}
              placeholder={t(language, "sidebar.categoryPlaceholder")}
              onChange={(e) => setCatDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitCategory(p.id);
                } else if (e.key === "Escape") {
                  setEditingCatId(null);
                }
              }}
            />
            <button
              type="button"
              className="btn primary xs"
              data-testid={`category-save-${p.id}`}
              onClick={() => commitCategory(p.id)}
            >
              <Icon icon={Check} size={14} />
            </button>
          </div>
        )}
      </div>
    );
  };

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

          {isHub && (
            <div className="sb-section sb-projects-section">
              <div className="sb-head">
                <button
                  type="button"
                  className="btn ghost xs"
                  data-testid="toggle-projects-collapse-btn"
                  aria-expanded={!projectsCollapsed}
                  title={projectsCollapsed ? t(language, "sidebar.expandProjects") : t(language, "sidebar.collapseProjects")}
                  style={{ padding: "2px 4px", minWidth: 0 }}
                  onClick={() => setProjectsCollapsed(!projectsCollapsed)}
                >
                  <Icon icon={projectsCollapsed ? ChevronRight : ChevronDown} size={14} />
                  <span>
                    {t(language, hasMultiNode ? "sidebar.projects" : "sidebar.localProjects", {
                      count: projects.length,
                    })}
                  </span>
                </button>
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

              {projectsCollapsed ? (
                activeSummary && (
                  <div
                    className="sb-item active sb-project-collapsed-pill"
                    onClick={() => setProjectsCollapsed(false)}
                    title={t(language, "sidebar.expandProjects")}
                  >
                    <div className="sb-item-main">
                      <span
                        className={`sb-dot ${
                          activeSummary.nodeOnline === false
                            ? ""
                            : activeSummary.runningCount > 0
                              ? "running"
                              : activeSummary.initialized
                                ? "ready"
                                : "uninit"
                        }`}
                      />
                      <span className="sb-item-name">{activeSummary.name}</span>
                    </div>
                    <div className="sb-item-badges">
                      {activeSummary.decisionCount > 0 && (
                        <span className="sb-badge warn">{activeSummary.decisionCount}</span>
                      )}
                      {activeSummary.activeCount > 0 && (
                        <span className="sb-badge">{activeSummary.activeCount}</span>
                      )}
                    </div>
                  </div>
                )
              ) : (
                <>
                  {projects.length > 0 && (
                    <div className="sb-project-controls">
                      <select
                        className="select xs"
                        data-testid="project-sort-select"
                        aria-label={t(language, "sidebar.sort.label")}
                        value={projectSort}
                        onChange={(e) => setProjectSort(e.target.value as ProjectSortMode)}
                      >
                        <option value="attention">{t(language, "sidebar.sort.attention")}</option>
                        <option value="recent">{t(language, "sidebar.sort.recent")}</option>
                        <option value="name">{t(language, "sidebar.sort.name")}</option>
                        <option value="added">{t(language, "sidebar.sort.added")}</option>
                      </select>
                      <select
                        className="select xs"
                        data-testid="project-group-select"
                        aria-label={t(language, "sidebar.group.label")}
                        value={projectGroup}
                        onChange={(e) => setProjectGroup(e.target.value as ProjectGroupMode)}
                      >
                        <option value="none">{t(language, "sidebar.group.none")}</option>
                        <option value="node">{t(language, "sidebar.group.node")}</option>
                        <option value="status">{t(language, "sidebar.group.status")}</option>
                        <option value="category">{t(language, "sidebar.group.category")}</option>
                      </select>
                    </div>
                  )}

                  <div className="sb-list sb-project-scroll" data-testid="hub-project-list">
                    {projects.length === 0 ? (
                      <div className="muted xs" style={{ padding: "6px 8px" }}>
                        {t(language, "sidebar.empty")}
                      </div>
                    ) : (
                      projectSections.map((section) => (
                        <div key={section.key}>
                          {section.label && (
                            <div className="sb-group-head" data-testid={`project-group-${section.key}`}>
                              {section.label} ({section.projects.length})
                            </div>
                          )}
                          {section.projects.map(renderProjectRow)}
                        </div>
                      ))
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {showReqNav && (
            <div className="sb-section sb-req-container">
              <HomeView />
            </div>
          )}

          {isHub && (
            <div className="sb-section sb-section-bottom sb-footer-compact">
              {remoteNodes.length > 0 && (
                <div className="sb-harnesses" data-testid="hub-nodes-list">
                  {nodes.map((n) => {
                    const running = n.update?.phase === "running";
                    const canUpdate = !n.isLocal && n.connected && n.updateEnabled && n.revision && hubRevision && n.revision !== hubRevision;
                    return (
                      <div key={n.nodeId}>
                        <div className="sb-harness-row" title={`${n.hostname} (${n.platform})`}>
                          <span className={`dot ${n.connected ? "online" : ""}`} />
                          <span className="sb-harness-name" style={{ fontFamily: "var(--sans)" }}>{n.name}</span>
                          {n.revision && <code className="muted xs" title={n.revision}>{n.revision.slice(0, 7)}</code>}
                          <span className="muted xs">{n.connected ? t(language, "common.online") : t(language, "common.offline")}</span>
                        </div>
                        {canUpdate && !running && (
                          <button
                            className="btn ghost xs"
                            type="button"
                            disabled={updateNode.isPending || n.activeRuns.length > 0}
                            onClick={() => {
                              if (window.confirm(t(language, "sidebar.nodeUpdateConfirm", { node: n.name, revision: hubRevision.slice(0, 7) }))) {
                                updateNode.mutate({ nodeId: n.nodeId, revision: hubRevision });
                              }
                            }}
                          >
                            {t(language, "sidebar.nodeUpdateAction", { revision: hubRevision.slice(0, 7) })}
                          </button>
                        )}
                        {n.update && (
                          <div className="muted xs" role="status">
                            {t(language, `sidebar.nodeUpdate.${n.update.phase}`, { revision: n.update.revision.slice(0, 7) })}
                            {n.update.message && ` — ${n.update.message}`}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

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
                  onClick={() => setModal({ kind: "routing", draft: null })}
                >
                  <Icon icon={Settings} size={14} /> {t(language, "sidebar.configure")}
                </button>
              </div>
              <div
                className="sb-preset-pill"
                role="button"
                tabIndex={0}
                onClick={() => setModal({ kind: "routing", draft: null })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    setModal({ kind: "routing", draft: null });
                  }
                }}
              >
                <span className="badge info">{presetLabel}</span>
                <span className="muted xs">
                  {t(language, "sidebar.harnessesReady", {
                    ready: installedHarnesses.length,
                    total: harnesses.length,
                  })}
                </span>
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
