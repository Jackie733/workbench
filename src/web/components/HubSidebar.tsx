import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, Folder, Plus, Settings, Star, X } from "lucide-react";
import { api, type HubProjectSummary, type HubStateResponse } from "../api.ts";
import { t } from "../i18n.ts";
import { useCollapsePhase } from "../lib/utils.ts";
import {
  openAddProjectModal,
  queryClient,
  queryKeys,
  resolveEffectiveRouting,
  switchProject,
  useHubStateQuery,
  useProjectQuery,
} from "../queries.ts";
import { groupHubProjects, type ProjectGroupMode, type ProjectSortMode } from "../state.ts";
import { DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, useUiStore } from "../stores/uiStore.ts";
import { BrandMark } from "./BrandMark.tsx";
import { HomeView } from "./HomeView.tsx";
import { Icon } from "./Icon.tsx";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { SimpleSelect } from "./ui/select.tsx";

function computeMaxSidebarWidth(layoutEl: HTMLElement | null): number {
  const viewportW = layoutEl?.clientWidth || (typeof window !== "undefined" ? window.innerWidth : 1280);
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.floor(viewportW * 0.42)));
}

function clampSidebarWidth(width: number, maxWidth: number): number {
  return Math.min(Math.max(Math.round(width), MIN_SIDEBAR_WIDTH), Math.max(MIN_SIDEBAR_WIDTH, maxWidth));
}

interface NodeUpdateTarget {
  nodeId: string;
  name: string;
  revision: string;
}

export function HubSidebar({ layoutRef }: { layoutRef?: RefObject<HTMLDivElement | null> }) {
  const language = useUiStore((s) => s.language);
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const desktopSidebarOpen = useUiStore((s) => s.desktopSidebarOpen);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const projectSort = useUiStore((s) => s.projectSort);
  const projectGroup = useUiStore((s) => s.projectGroup);
  const projectsCollapsed = useUiStore((s) => s.projectsCollapsed);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const setProjectSort = useUiStore((s) => s.setProjectSort);
  const setProjectGroup = useUiStore((s) => s.setProjectGroup);
  const setProjectsCollapsed = useUiStore((s) => s.setProjectsCollapsed);
  const setModal = useUiStore((s) => s.setModal);

  const [editingCatId, setEditingCatId] = useState<string | null>(null);
  const [catDraft, setCatDraft] = useState("");
  const [pendingPins, setPendingPins] = useState(() => new Map<string, boolean>());
  const [nodeUpdateTarget, setNodeUpdateTarget] = useState<NodeUpdateTarget | null>(null);
  const [nodeUpdateOpen, setNodeUpdateOpen] = useState(false);
  const resizerRef = useRef<HTMLDivElement | null>(null);
  const [maxWidth, setMaxWidth] = useState<number>(MAX_SIDEBAR_WIDTH);
  const recentSnapshotRef = useRef<Map<string, number>>(new Map());

  const syncSidebarCssWidth = useCallback(
    (preferredWidth: number) => {
      const layoutEl = layoutRef?.current ?? null;
      const nextMax = computeMaxSidebarWidth(layoutEl);
      const effective = clampSidebarWidth(preferredWidth, nextMax);
      setMaxWidth(nextMax);
      if (layoutEl) {
        layoutEl.style.setProperty("--sidebar-w", `${effective}px`);
      }
      return { nextMax, effective };
    },
    [layoutRef],
  );

  useLayoutEffect(() => {
    syncSidebarCssWidth(sidebarWidth);
  }, [sidebarWidth, syncSidebarCssWidth]);

  useEffect(() => {
    const layoutEl = layoutRef?.current ?? null;
    if (!layoutEl || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      syncSidebarCssWidth(useUiStore.getState().sidebarWidth);
    });
    observer.observe(layoutEl);
    return () => observer.disconnect();
  }, [layoutRef, syncSidebarCssWidth]);

  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const layoutEl = layoutRef?.current ?? null;
    const resizerEl = resizerRef.current;
    if (!layoutEl || !resizerEl || !desktopSidebarOpen) return;
    e.preventDefault();

    const startX = e.clientX;
    const startMax = computeMaxSidebarWidth(layoutEl);
    const startWidth = clampSidebarWidth(useUiStore.getState().sidebarWidth, startMax);
    let latestWidth = startWidth;
    let rafId = 0;

    resizerEl.setPointerCapture(e.pointerId);
    layoutEl.setAttribute("data-resizing", "true");
    resizerEl.setAttribute("data-dragging", "true");

    const applyWidth = (w: number) => {
      layoutEl.style.setProperty("--sidebar-w", `${w}px`);
    };

    const onMove = (ev: PointerEvent) => {
      const delta = ev.clientX - startX;
      const currentMax = computeMaxSidebarWidth(layoutEl);
      latestWidth = clampSidebarWidth(startWidth + delta, currentMax);
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          applyWidth(latestWidth);
        });
      }
    };

    const finish = () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      resizerEl.removeEventListener("pointermove", onMove);
      resizerEl.removeEventListener("pointerup", finish);
      resizerEl.removeEventListener("pointercancel", finish);
      layoutEl.removeAttribute("data-resizing");
      resizerEl.removeAttribute("data-dragging");
      applyWidth(latestWidth);
      setSidebarWidth(latestWidth);
    };

    resizerEl.addEventListener("pointermove", onMove);
    resizerEl.addEventListener("pointerup", finish);
    resizerEl.addEventListener("pointercancel", finish);
  };

  const handleResizeDoubleClick = () => {
    const layoutEl = layoutRef?.current ?? null;
    const currentMax = computeMaxSidebarWidth(layoutEl);
    setSidebarWidth(clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH, currentMax));
  };

  const handleResizeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const layoutEl = layoutRef?.current ?? null;
    const currentMax = computeMaxSidebarWidth(layoutEl);
    const effective = clampSidebarWidth(sidebarWidth, currentMax);
    const step = e.shiftKey ? 48 : 16;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      setSidebarWidth(clampSidebarWidth(effective + step, currentMax));
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      setSidebarWidth(clampSidebarWidth(effective - step, currentMax));
    } else if (e.key === "Home") {
      e.preventDefault();
      setSidebarWidth(clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH, currentMax));
    }
  };

  useEffect(() => {
    setEditingCatId(null);
  }, [activeProjectId, projectsCollapsed]);

  const { data: hub } = useHubStateQuery();
  const { data: project, isLoading: projectLoading } = useProjectQuery(activeProjectId);

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
  const projectPending = projectLoading && !project;
  const showReqNav = Boolean((project?.initialized || projectPending) && !remoteOffline && !noHubProject);

  const updateNode = useMutation({
    mutationFn: api.updateNode,
    onError: (error) => useUiStore.getState().showToastError(error),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.hubState }),
  });

  const updateProjectMeta = useMutation({
    mutationFn: api.updateHubProjectMeta,
    onSuccess: async (_, { projectId, pinned }) => {
      if (pinned === undefined) return;
      await queryClient.cancelQueries({ queryKey: queryKeys.hubState });
      queryClient.setQueryData<HubStateResponse>(queryKeys.hubState, (hub) => hub && ({
        ...hub,
        projects: hub.projects.map((item) => item.id === projectId ? { ...item, pinned } : item),
      }));
    },
    onError: (error, { pinned }) => {
      const ui = useUiStore.getState();
      if (pinned === undefined) ui.showToastError(error);
      else ui.showToastKey(pinned ? "sidebar.pinFailed" : "sidebar.unpinFailed", undefined, true);
    },
    onSettled: (_, __, { projectId, pinned }) => {
      if (pinned !== undefined) {
        setPendingPins((previous) => {
          const next = new Map(previous);
          next.delete(projectId);
          return next;
        });
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.hubState });
    },
  });

  const targetNode = nodeUpdateTarget ? nodes.find((node) => node.nodeId === nodeUpdateTarget.nodeId) : undefined;
  const targetNodeEligible = Boolean(
    targetNode &&
      targetNode.connected &&
      targetNode.updateEnabled &&
      targetNode.revision &&
      hubRevision &&
      targetNode.revision !== hubRevision &&
      targetNode.activeRuns.length === 0 &&
      targetNode.update?.phase !== "running",
  );
  const targetNodeSynced = Boolean(targetNode && hubRevision && targetNode.revision === hubRevision);
  const { isPending: isNodeUpdatePending, isError: isNodeUpdateError, reset: resetNodeUpdate } = updateNode;

  useEffect(() => {
    if (!nodeUpdateOpen || !nodeUpdateTarget || isNodeUpdatePending) return;
    if (isNodeUpdateError) {
      if (targetNodeSynced) {
        setNodeUpdateOpen(false);
        resetNodeUpdate();
      }
      return;
    }
    if (!targetNodeEligible) {
      setNodeUpdateOpen(false);
    }
  }, [
    isNodeUpdateError,
    isNodeUpdatePending,
    nodeUpdateOpen,
    nodeUpdateTarget,
    resetNodeUpdate,
    targetNodeEligible,
    targetNodeSynced,
  ]);

  const handleNodeUpdateOpenChange = (open: boolean) => {
    setNodeUpdateOpen(open);
    if (!open) resetNodeUpdate();
  };

  const confirmNodeUpdate = () => {
    const target = nodeUpdateTarget;
    if (!target || isNodeUpdatePending || !targetNodeEligible) return;
    updateNode.mutate(
      { nodeId: target.nodeId, revision: target.revision },
      {
        onSuccess: () => {
          setNodeUpdateOpen(false);
          resetNodeUpdate();
        },
      },
    );
  };

  const harnesses = hub?.harnesses ?? [];
  const installedHarnesses = harnesses.filter((h) => h.installed);
  const routing = resolveEffectiveRouting(project);
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

  const leadLabel = routing?.defaultLead?.primary
    ? `${routing.defaultLead.primary.harness}/${routing.defaultLead.primary.model}`
    : t(language, "sidebar.routing");

  // 仅在首次见到项目时记录会话快照；点击切换项目不会重排项目队列。
  for (const p of projects) {
    if (!recentSnapshotRef.current.has(p.id)) {
      recentSnapshotRef.current.set(p.id, p.lastOpenedAt);
    }
  }
  const projectSections = groupHubProjects(
    projects,
    projectGroup,
    projectSort,
    language,
    recentSnapshotRef.current,
  );

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
    const pendingPin = pendingPins.get(p.id);
    const pinned = pendingPin ?? Boolean(p.pinned);
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
              <Badge size="sm" variant="secondary" className="sb-badge" data-testid={`project-cat-badge-${p.id}`}>
                {p.category}
              </Badge>
            )}
            {isRemote && (
              <Badge size="sm" variant="secondary" className="sb-badge" title={t(language, "sidebar.nodeTitle", { node: p.nodeName ?? p.nodeId ?? "" })}>
                {p.nodeName ?? p.nodeId}
              </Badge>
            )}
            {p.decisionCount > 0 && (
              <Badge size="sm" variant="warning" className="sb-badge warn" title={t(language, "sidebar.decisionTitle")}>
                {p.decisionCount}
              </Badge>
            )}
            {offline ? (
              <Badge size="sm" variant="outline" className="sb-badge text-muted-foreground">{t(language, "common.offline")}</Badge>
            ) : !p.initialized ? (
              <Badge size="sm" variant="outline" className="sb-badge text-muted-foreground">{t(language, "sidebar.uninitialized")}</Badge>
            ) : p.activeCount > 0 ? (
              <Badge size="sm" variant="secondary" className="sb-badge">{p.activeCount}</Badge>
            ) : null}
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="sb-meta-btn sb-pin-btn aria-busy:cursor-progress"
              data-testid={`pin-project-${p.id}`}
              title={t(language, pinned ? "sidebar.unpin" : "sidebar.pin")}
              aria-label={t(language, "sidebar.pin")}
              aria-pressed={pinned}
              aria-busy={pendingPin !== undefined || undefined}
              aria-disabled={pendingPin !== undefined || undefined}
              onClick={(e) => {
                e.stopPropagation();
                if (pendingPin !== undefined) return;
                setPendingPins((previous) => new Map(previous).set(p.id, !pinned));
                updateProjectMeta.mutate({ projectId: p.id, pinned: !pinned });
              }}
            >
              <Icon icon={Star} size={14} />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="sb-meta-btn"
              data-testid={`category-project-${p.id}`}
              title={t(language, "sidebar.setCategory")}
              aria-label={t(language, "sidebar.setCategory")}
              onClick={(e) => {
                e.stopPropagation();
                openCategoryEditor(p);
              }}
            >
              <Icon icon={Folder} size={14} />
            </Button>
          </div>
        </div>
        {editingCat && (
          <div
            className="sb-cat-editor flex items-center gap-1 pt-1 px-1.5"
            onClick={(e) => e.stopPropagation()}
          >
            <Input
              size="sm"
              className="flex-1"
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
            <Button
              type="button"
              size="icon-xs"
              data-testid={`category-save-${p.id}`}
              onClick={() => commitCategory(p.id)}
            >
              <Icon icon={Check} size={14} />
            </Button>
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
            <Button
              className="sb-close-btn"
              size="icon-xs"
              type="button"
              variant="ghost"
              title={t(language, "sidebar.collapse")}
              aria-label={t(language, "sidebar.collapse")}
              onClick={() => setSidebarOpen(false)}
            >
              <Icon icon={X} />
            </Button>
          </div>

          {isHub && (
            <div className="sb-section sb-projects-section">
              <div className="sb-head">
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  data-testid="toggle-projects-collapse-btn"
                  aria-expanded={!projectsCollapsed}
                  title={projectsCollapsed ? t(language, "sidebar.expandProjects") : t(language, "sidebar.collapseProjects")}
                  className="px-1 py-0.5 min-w-0"
                  onClick={() => setProjectsCollapsed(!projectsCollapsed)}
                >
                  <Icon icon={projectsCollapsed ? ChevronRight : ChevronDown} size={14} />
                  <span>
                    {t(language, hasMultiNode ? "sidebar.projects" : "sidebar.localProjects", {
                      count: projects.length,
                    })}
                  </span>
                </Button>
                <Button
                  size="xs"
                  type="button"
                  variant="ghost"
                  data-action="open-add-project"
                  data-testid="add-project-btn"
                  title={t(language, "sidebar.addTitle")}
                  onClick={() => void openAddProjectModal(activeNodeId)}
                >
                  <Icon icon={Plus} size={14} /> {t(language, "sidebar.add")}
                </Button>
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
                        <Badge size="sm" variant="warning" className="sb-badge warn">{activeSummary.decisionCount}</Badge>
                      )}
                      {activeSummary.activeCount > 0 && (
                        <Badge size="sm" variant="secondary" className="sb-badge">{activeSummary.activeCount}</Badge>
                      )}
                    </div>
                  </div>
                )
              ) : (
                <>
                  {projects.length > 0 && (
                    <div className="sb-project-controls">
                      <SimpleSelect
                        aria-label={t(language, "sidebar.sort.label")}
                        className="w-full min-w-0 text-xs"
                        data-testid="project-sort-select"
                        options={[
                          { value: "attention", label: t(language, "sidebar.sort.attention") },
                          { value: "recent", label: t(language, "sidebar.sort.recent") },
                          { value: "name", label: t(language, "sidebar.sort.name") },
                          { value: "added", label: t(language, "sidebar.sort.added") },
                        ]}
                        size="sm"
                        value={projectSort}
                        onValueChange={(next) => {
                          const nextSort = next as ProjectSortMode;
                          if (nextSort === "recent") {
                            const refreshed = new Map<string, number>();
                            for (const proj of projects) refreshed.set(proj.id, proj.lastOpenedAt);
                            recentSnapshotRef.current = refreshed;
                          }
                          setProjectSort(nextSort);
                        }}
                      />
                      <SimpleSelect
                        aria-label={t(language, "sidebar.group.label")}
                        className="w-full min-w-0 text-xs"
                        data-testid="project-group-select"
                        options={[
                          { value: "none", label: t(language, "sidebar.group.none") },
                          { value: "node", label: t(language, "sidebar.group.node") },
                          { value: "status", label: t(language, "sidebar.group.status") },
                          { value: "category", label: t(language, "sidebar.group.category") },
                        ]}
                        size="sm"
                        value={projectGroup}
                        onValueChange={(next) => setProjectGroup(next as ProjectGroupMode)}
                      />
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
                          <>
                            <Button
                              size="xs"
                              type="button"
                              variant="ghost"
                              data-testid={`node-update-${n.nodeId}`}
                              disabled={updateNode.isPending || n.activeRuns.length > 0}
                              onClick={() => {
                                resetNodeUpdate();
                                setNodeUpdateTarget({
                                  nodeId: n.nodeId,
                                  name: n.name,
                                  revision: hubRevision,
                                });
                                setNodeUpdateOpen(true);
                              }}
                            >
                              {t(language, "sidebar.nodeUpdateAction", { revision: hubRevision.slice(0, 7) })}
                            </Button>
                            {n.activeRuns.length > 0 && (
                              <div className="muted xs">
                                {t(language, "sidebar.nodeUpdateBusyHint", { revision: hubRevision.slice(0, 7) })}
                              </div>
                            )}
                          </>
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
                <Button
                  size="xs"
                  type="button"
                  variant="ghost"
                  data-action="open-routing"
                  data-testid="sidebar-routing-btn"
                  onClick={() =>
                    setModal({
                      kind: "routing",
                      tab: "routing",
                      draft: null,
                    })
                  }
                >
                  <Icon icon={Settings} size={14} /> {t(language, "sidebar.configure")}
                </Button>
              </div>
              <div
                className="sb-preset-pill"
                role="button"
                tabIndex={0}
                onClick={() =>
                  setModal({
                    kind: "routing",
                    tab: "routing",
                    draft: null,
                  })
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    setModal({
                      kind: "routing",
                      tab: "routing",
                      draft: null,
                    });
                  }
                }}
              >
                <Badge variant="info" className="truncate max-w-[140px]">{leadLabel}</Badge>
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
        {desktopSidebarOpen && (
          <div
            ref={resizerRef}
            className="sidebar-resizer"
            data-testid="sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label={t(language, "sidebar.resizeAria")}
            aria-valuemin={MIN_SIDEBAR_WIDTH}
            aria-valuemax={maxWidth}
            aria-valuenow={clampSidebarWidth(sidebarWidth, maxWidth)}
            title={t(language, "sidebar.resizeTitle")}
            tabIndex={0}
            onPointerDown={handleResizePointerDown}
            onDoubleClick={handleResizeDoubleClick}
            onKeyDown={handleResizeKeyDown}
          />
        )}
      </aside>
      <AlertDialog open={nodeUpdateOpen} onOpenChange={handleNodeUpdateOpenChange}>
        <AlertDialogPopup data-testid="node-update-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t(language, "sidebar.nodeUpdateTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(language, "sidebar.nodeUpdateConfirm", {
                node: nodeUpdateTarget?.name ?? "",
                revision: nodeUpdateTarget?.revision.slice(0, 7) ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              data-testid="node-update-cancel"
              render={<Button variant="ghost" />}
            >
              {t(language, "common.cancel")}
            </AlertDialogClose>
            <Button
              data-testid="node-update-confirm"
              disabled={updateNode.isPending || !targetNodeEligible}
              loading={updateNode.isPending}
              variant="default"
              onClick={confirmNodeUpdate}
            >
              {t(language, "sidebar.nodeUpdateConfirmAction")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
