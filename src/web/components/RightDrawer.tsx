import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import {
  AlertTriangle,
  ArrowUp,
  BookmarkPlus,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileDiff,
  FileText,
  Loader2,
  MapPin,
  MessageSquare,
  Pencil,
  RotateCcw,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import type { AgentRunRecord, DiscussionEntry, RequirementDetail } from "../../core/types.ts";
import { formatAgentActionLabel, formatAgentStatusLabel, t, type UiLanguage } from "../i18n.ts";
import { copyTextToClipboard } from "../lib/clipboard.ts";
import { useCollapsePhase } from "../lib/utils.ts";
import {
  adoptDiscussion,
  cancelRun,
  deleteAnnotationAction,
  hydrateRunLog,
  hydrateRunTrace,
  openHandoff,
  openRunConsole,
  resolveAnnotationAction,
  runAskFromDrawer,
  runRefineFromDrawer,
  triggerActiveRun,
  useHubStateQuery,
  useProjectQuery,
  useRequirementAskError,
  useRequirementQuery,
} from "../queries.ts";
import {
  AGENT_RUN_TONE,
  findActiveAskRun,
  findLockingRequirementRun,
  formatDateTime,
  formatDurationHuman,
  formatPercent,
  formatTokenCount,
  formatUsd,
  getPendingRefineAnnotations,
  resolveRequirementRunScope,
} from "../state.ts";
import { useDraftStore } from "../stores/draftStore.ts";
import { useStreamStore, type StreamStoreState } from "../stores/streamStore.ts";
import { DEFAULT_DRAWER_WIDTH, MIN_DRAWER_WIDTH, useUiStore } from "../stores/uiStore.ts";
import {
  ChatConversation,
  ChatEmptyState,
  ChatMessage,
  useChatScroll,
} from "./chat/index.ts";
import { ConsoleMarkdown } from "./ConsoleMarkdown.tsx";
import { ConsoleOutput } from "./ConsoleOutput.tsx";
import { DiscussStreamCard } from "./DiscussStreamCard.tsx";
import { Icon } from "./Icon.tsx";
import { LiveTimer, RunnerSelect } from "./Primitives.tsx";
import { Alert, AlertDescription } from "./ui/alert.tsx";
import { AsyncButton } from "./ui/async-button.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Card } from "./ui/card.tsx";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible.tsx";
import {
  Composer,
  ComposerActionGroup,
  ComposerActions,
  ComposerHeader,
  ComposerInput,
} from "./ui/composer.tsx";
import { SimpleSelect } from "./ui/select.tsx";
import { Tabs, TabsList, TabsTab } from "./ui/tabs.tsx";
import { DiffViewerPanel } from "./WorkspaceView.tsx";

type DiscussFilter = "all" | "ask" | "refine";

type DrawerRunIds = { taskRunId: string | null; askRunId: string | null };

function useDrawerRunIds(reqId: string | null, activeProjectId: string | null): DrawerRunIds {
  const { data: hub } = useHubStateQuery();
  const { data: project } = useProjectQuery(activeProjectId ?? hub?.activeProjectId ?? null);
  const selectRunIds = useMemo(() => {
    const scope = resolveRequirementRunScope({
      activeProjectId,
      hubActiveProjectId: hub?.activeProjectId,
      projectRoot: project?.root,
      projects: hub?.projects,
    });
    let previousRuns: StreamStoreState["activeRuns"] | undefined;
    let ids: DrawerRunIds = { taskRunId: null, askRunId: null };
    return (s: StreamStoreState) => {
      // Chunk updates leave activeRuns alone; metric updates only matter here if a run ID changes.
      if (reqId && s.activeRuns !== previousRuns) {
        previousRuns = s.activeRuns;
        const runs = Object.values(s.activeRuns);
        const taskRunId = findLockingRequirementRun(runs, reqId, scope)?.id ?? null;
        const askRunId = findActiveAskRun(runs, reqId, scope)?.id ?? null;
        if (taskRunId !== ids.taskRunId || askRunId !== ids.askRunId) ids = { taskRunId, askRunId };
      }
      return ids;
    };
  }, [reqId, activeProjectId, hub?.activeProjectId, hub?.projects, project?.root]);
  return useStreamStore(selectRunIds);
}

const skipStreamSubscription = () => () => {};

// Keep mounted pane state and the last rendered output during collapse. Read the
// latest value again on open without subscribing the closed pane to new chunks.
function useDrawerStream<T>(active: boolean, select: (s: StreamStoreState) => T): T {
  return useSyncExternalStore(
    active ? useStreamStore.subscribe : skipStreamSubscription,
    () => select(useStreamStore.getState()),
    () => select(useStreamStore.getInitialState()),
  );
}

function computeMaxDrawerWidth(workspaceEl: HTMLElement | null): number {
  if (!workspaceEl) return DEFAULT_DRAWER_WIDTH;
  const available = workspaceEl.clientWidth;
  if (available <= 0) return DEFAULT_DRAWER_WIDTH;
  return Math.max(MIN_DRAWER_WIDTH, Math.floor(available * 0.5));
}

function clampDrawerWidth(width: number, maxWidth: number): number {
  return Math.min(Math.max(Math.round(width), MIN_DRAWER_WIDTH), Math.max(MIN_DRAWER_WIDTH, maxWidth));
}

export const RightDrawer = memo(function RightDrawer({ workspaceRef }: { workspaceRef?: RefObject<HTMLDivElement | null> }) {
  const language = useUiStore((s) => s.language);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const selectedId = useUiStore((s) => s.selectedId);
  const drawerOpen = useUiStore((s) => s.drawerOpen);
  const drawerWidth = useUiStore((s) => s.drawerWidth);
  const drawerTab = useUiStore((s) => s.drawerTab);
  const setDrawerOpen = useUiStore((s) => s.setDrawerOpen);
  const setDrawerWidth = useUiStore((s) => s.setDrawerWidth);
  const setDrawerTab = useUiStore((s) => s.setDrawerTab);

  const { data: reqData } = useRequirementQuery(activeProjectId, selectedId);
  const d = reqData?.detail ?? null;
  const { taskRunId, askRunId } = useDrawerRunIds(d?.state.id ?? null, activeProjectId);
  const discussions = d?.state.discussions;
  const pendingAnnotations = useMemo(() => getPendingRefineAnnotations(discussions), [discussions]);

  const phase = useCollapsePhase(drawerOpen, 245, 195);
  const openCls =
    phase === "open"
      ? "open"
      : phase === "opening"
        ? "opening"
        : phase === "entering"
          ? "collapsed entering"
          : phase === "closing"
            ? "collapsed closing"
            : "collapsed settled";

  const resizerRef = useRef<HTMLDivElement | null>(null);
  const [maxWidth, setMaxWidth] = useState<number>(DEFAULT_DRAWER_WIDTH);
  const syncDrawerCssWidth = useCallback(
    (preferredWidth: number) => {
      const wsEl = workspaceRef?.current ?? null;
      const nextMax = computeMaxDrawerWidth(wsEl);
      const effective = clampDrawerWidth(preferredWidth, nextMax);
      setMaxWidth(nextMax);
      if (wsEl) {
        wsEl.style.setProperty("--drawer-w", `${effective}px`);
      }
      return { nextMax, effective };
    },
    [workspaceRef],
  );

  useLayoutEffect(() => {
    syncDrawerCssWidth(drawerWidth);
  }, [drawerWidth, syncDrawerCssWidth]);

  useEffect(() => {
    const wsEl = workspaceRef?.current ?? null;
    if (!wsEl || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      syncDrawerCssWidth(useUiStore.getState().drawerWidth);
    });
    observer.observe(wsEl);
    return () => observer.disconnect();
  }, [workspaceRef, syncDrawerCssWidth]);

  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const wsEl = workspaceRef?.current ?? null;
    const resizerEl = resizerRef.current;
    if (!wsEl || !resizerEl || !drawerOpen) return;
    e.preventDefault();

    const startX = e.clientX;
    const startMax = computeMaxDrawerWidth(wsEl);
    const startWidth = clampDrawerWidth(useUiStore.getState().drawerWidth, startMax);
    let latestWidth = startWidth;
    let rafId = 0;

    resizerEl.setPointerCapture(e.pointerId);
    wsEl.setAttribute("data-resizing", "true");
    resizerEl.setAttribute("data-dragging", "true");

    const applyWidth = (w: number) => {
      wsEl.style.setProperty("--drawer-w", `${w}px`);
    };

    const onMove = (ev: PointerEvent) => {
      const delta = startX - ev.clientX;
      const currentMax = computeMaxDrawerWidth(wsEl);
      latestWidth = clampDrawerWidth(startWidth + delta, currentMax);
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
      wsEl.removeAttribute("data-resizing");
      resizerEl.removeAttribute("data-dragging");
      applyWidth(latestWidth);
      setDrawerWidth(latestWidth);
    };

    resizerEl.addEventListener("pointermove", onMove);
    resizerEl.addEventListener("pointerup", finish);
    resizerEl.addEventListener("pointercancel", finish);
  };

  const handleResizeDoubleClick = () => {
    const wsEl = workspaceRef?.current ?? null;
    const currentMax = computeMaxDrawerWidth(wsEl);
    const effective = clampDrawerWidth(drawerWidth, currentMax);
    if (Math.abs(effective - currentMax) <= 12) {
      const compactTarget =
        DEFAULT_DRAWER_WIDTH < currentMax - 24
          ? DEFAULT_DRAWER_WIDTH
          : Math.max(MIN_DRAWER_WIDTH, Math.min(440, Math.round(currentMax * 0.72)));
      setDrawerWidth(compactTarget);
    } else {
      setDrawerWidth(currentMax);
    }
  };

  const handleResizeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const wsEl = workspaceRef?.current ?? null;
    const currentMax = computeMaxDrawerWidth(wsEl);
    const effective = clampDrawerWidth(drawerWidth, currentMax);
    const step = e.shiftKey ? 48 : 16;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setDrawerWidth(clampDrawerWidth(effective + step, currentMax));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setDrawerWidth(clampDrawerWidth(effective - step, currentMax));
    } else if (e.key === "Home") {
      e.preventDefault();
      setDrawerWidth(MIN_DRAWER_WIDTH);
    } else if (e.key === "End") {
      e.preventDefault();
      setDrawerWidth(currentMax);
    }
  };

  const effectiveWidth = clampDrawerWidth(drawerWidth, maxWidth);

  return (
    <>
      <div
        className={`drawer-backdrop ${drawerOpen ? "open" : ""}`}
        aria-hidden="true"
        onClick={() => setDrawerOpen(false)}
      />
      <aside
        className={`drawer ${openCls}`}
        data-testid="right-drawer"
        aria-hidden={!drawerOpen}
      >
        {drawerOpen && (
          <div
            ref={resizerRef}
            className="drawer-resizer"
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label={t(language, "drawer.resizeAria")}
            aria-valuemin={MIN_DRAWER_WIDTH}
            aria-valuemax={maxWidth}
            aria-valuenow={effectiveWidth}
            title={t(language, "drawer.resizeTitle")}
            data-testid="drawer-resizer"
            onPointerDown={handleResizePointerDown}
            onDoubleClick={handleResizeDoubleClick}
            onKeyDown={handleResizeKeyDown}
          />
        )}
        <div className="drawer-inner">
          {!d ? (
            <div className="drawer-body" />
          ) : (
            <>
              <div className="drawer-head">
                <Tabs
                  className="w-full min-w-0 gap-0"
                  value={drawerTab}
                  onValueChange={(next) => setDrawerTab(next as "discuss" | "console" | "diff")}
                >
                  <TabsList size="sm" variant="underline" className="w-full justify-start">
                    <TabsTab
                      value="discuss"
                      className="grow-0"
                      data-action="set-drawer-tab"
                      data-tab="discuss"
                      data-testid="drawer-tab-discuss"
                    >
                      <Icon icon={MessageSquare} size={14} /> {t(language, "drawer.tab.discuss")}
                      {pendingAnnotations.length > 0 ? ` (${pendingAnnotations.length})` : ""}
                      {askRunId && (
                        <span className="pulse-dot" role="img" aria-label={t(language, "drawer.askRunning")} />
                      )}
                    </TabsTab>
                    <TabsTab
                      value="console"
                      className="grow-0"
                      data-action="set-drawer-tab"
                      data-tab="console"
                      data-testid="drawer-tab-console"
                    >
                      <Icon icon={Terminal} size={14} /> {t(language, "drawer.tab.console")}
                      {taskRunId && (
                        <span className="pulse-dot" role="img" aria-label={t(language, "drawer.running")} />
                      )}
                    </TabsTab>
                    <TabsTab
                      value="diff"
                      className="grow-0"
                      data-action="set-drawer-tab"
                      data-tab="diff"
                      data-testid="drawer-tab-diff"
                    >
                      <Icon icon={FileDiff} size={14} /> {t(language, "drawer.tab.diff")}
                    </TabsTab>
                  </TabsList>
                </Tabs>
                <Button
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                  className="drawer-close-btn"
                  data-testid="drawer-close-btn"
                  aria-label={t(language, "drawer.closeAria")}
                  title={t(language, "drawer.closeAria")}
                  onClick={() => setDrawerOpen(false)}
                >
                  <Icon icon={X} size={14} />
                </Button>
              </div>

              {drawerTab === "diff" && (
                <div className="drawer-body drawer-diff-body" data-testid="drawer-diff-pane">
                  <DiffViewerPanel d={d} inDrawer />
                </div>
              )}
              {drawerTab === "console" && (
                <DrawerConsolePane
                  reqId={d.state.id}
                  agentRuns={d.state.agentRuns}
                  language={language}
                  open={drawerOpen}
                  taskRunId={taskRunId}
                  askRunId={askRunId}
                />
              )}
            </>
          )}
          {/* Keep discussion controls and scroll state across tab switches. */}
          <DrawerDiscussionPane
            d={d}
            language={language}
            open={drawerOpen}
            selected={drawerTab === "discuss"}
            pendingAnnotations={pendingAnnotations}
            taskRunId={taskRunId}
            askRunId={askRunId}
          />
        </div>
      </aside>
    </>
  );
});

function DrawerDiscussionPane({
  d,
  language,
  open,
  selected,
  pendingAnnotations,
  taskRunId: activeTaskRunId,
  askRunId: activeAskRunId,
}: DrawerRunIds & {
  d: RequirementDetail | null;
  language: UiLanguage;
  open: boolean;
  selected: boolean;
  pendingAnnotations: DiscussionEntry[];
}) {
  const reqId = d?.state.id ?? "";
  const busy = useUiStore((s) => s.busy);
  const setModal = useUiStore((s) => s.setModal);
  const triggerAnchorHighlight = useUiStore((s) => s.triggerAnchorHighlight);
  const discussDraft = useDraftStore((s) => (reqId ? s.discussDraftByReq[reqId] ?? "" : ""));
  const discussAnchor = useDraftStore((s) => (reqId ? s.discussAnchorByReq[reqId] ?? null : null));
  const discussFreshSession = useDraftStore((s) => (reqId ? Boolean(s.discussFreshSessionByReq[reqId]) : false));
  const setDiscussDraft = useDraftStore((s) => s.setDiscussDraft);
  const setDiscussAnchor = useDraftStore((s) => s.setDiscussAnchor);
  const setDiscussFreshSession = useDraftStore((s) => s.setDiscussFreshSession);
  const lastAskError = useRequirementAskError(d?.state.id ?? null);
  const setLastAskError = useStreamStore((s) => s.setLastAskError);

  const [discussFilter, setDiscussFilter] = useState<DiscussFilter>("all");
  const [queueOpen, setQueueOpen] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedSummaries, setExpandedSummaries] = useState<Record<string, boolean>>({});
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(copyTimerRef.current), []);

  const discussions = d?.state.discussions;
  const pendingAnnotationIdSet = useMemo(() => new Set(pendingAnnotations.map((a) => a.id)), [pendingAnnotations]);

  // 对话流与顶部待处理批注队列分离：未解决的待提交批注集中在顶部栏，不重复刷屏。
  const threadItems = useMemo(() => {
    const base = discussions?.filter((item) => !pendingAnnotationIdSet.has(item.id)) ?? [];
    if (discussFilter === "ask") return base.filter((item) => item.mode === "ask");
    if (discussFilter === "refine") return base.filter((item) => item.mode === "refine");
    return base;
  }, [discussions, pendingAnnotationIdSet, discussFilter]);

  const hasMixedDiscussionTypes = useMemo(() => {
    const hasAsk = discussions?.some((item) => item.mode === "ask");
    const hasRefine = discussions?.some((item) => item.mode === "refine" && !pendingAnnotationIdSet.has(item.id));
    return hasAsk && hasRefine;
  }, [discussions, pendingAnnotationIdSet]);

  useEffect(() => {
    setDiscussFilter("all");
  }, [reqId]);

  const handleCopyReply = async (id: string, text: string) => {
    const ok = await copyTextToClipboard(text);
    if (!ok) return;
    setCopiedId(id);
    clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopiedId(null), 1800);
  };

  const stage = d?.state.stage;
  const isImplOrAccept = stage === "coding";
  const isReadonlyStage = stage === "done" || stage === "cancelled";

  const showComposerHeader = Boolean(discussAnchor || activeTaskRunId || activeAskRunId || isReadonlyStage);
  return (
    <DrawerDiscussionConversation
      visible={Boolean(d) && selected}
      open={open}
      language={language}
      reqId={reqId}
      askRunId={activeAskRunId}
      lastAskErrorRunId={lastAskError?.runId}
      itemCount={threadItems.length + (activeAskRunId ? 1 : 0) + (lastAskError ? 1 : 0)}
      header={d && selected && (
        <>
          {pendingAnnotations.length > 0 && (
            <Collapsible
              open={queueOpen}
              onOpenChange={setQueueOpen}
              className="annot-queue"
              data-testid="pending-annotations"
            >
              <div className="annot-queue-head">
                <CollapsibleTrigger className="annot-queue-toggle">
                  <Icon icon={queueOpen ? ChevronDown : ChevronRight} size={14} />
                  <strong>{t(language, "drawer.pending", { count: pendingAnnotations.length })}</strong>
                </CollapsibleTrigger>
                <div className="annot-queue-actions">
                  {!isReadonlyStage && (
                    <AsyncButton
                      size="xs"
                      type="button"
                      variant="default"
                      data-testid="submit-pending-annotations-btn"
                      disabled={busy || Boolean(activeTaskRunId)}
                      onAction={() => runRefineFromDrawer(d.state.id, { annotationsOnly: true })}
                    >
                      <Icon icon={Pencil} size={14} />{" "}
                      {t(language, isImplOrAccept ? "drawer.pendingSubmitCode" : "drawer.pendingSubmit", {
                        count: pendingAnnotations.length,
                      })}
                    </AsyncButton>
                  )}
                </div>
              </div>
              <CollapsiblePanel>
                <div className="annot-queue-list">
                  {pendingAnnotations.map((a) => (
                    <div key={a.id} className="annot-chip" data-testid={`pending-annotation-${a.id}`}>
                      <div className="annot-chip-main">
                        {a.anchor && (
                          <button
                            type="button"
                            className="discuss-anchor-pill"
                            data-testid="anchor-jump-btn"
                            title={t(language, "drawer.jumpToAnchor", { anchor: a.anchor })}
                            onClick={() => triggerAnchorHighlight(a.anchor!)}
                          >
                            <Icon icon={MapPin} size={14} />
                            <span>{a.anchor}</span>
                          </button>
                        )}
                        <div className="annot-chip-text">{a.message}</div>
                      </div>
                      <div className="annot-chip-actions">
                        <Button
                          size="icon-xs"
                          type="button"
                          variant="ghost"
                          data-testid={`resolve-annotation-${a.id}`}
                          title={t(language, "drawer.resolveAnnotation")}
                          aria-label={t(language, "drawer.resolveAnnotation")}
                          disabled={busy}
                          onClick={() => void resolveAnnotationAction(d.state.id, [a.id], true)}
                        >
                          <Icon icon={Check} size={14} />
                        </Button>
                        <Button
                          size="icon-xs"
                          type="button"
                          variant="ghost"
                          data-testid={`delete-annotation-${a.id}`}
                          title={t(language, "drawer.removeAnnotation")}
                          aria-label={t(language, "drawer.removeAnnotation")}
                          disabled={busy}
                          onClick={() => void deleteAnnotationAction(d.state.id, a.id)}
                        >
                          <Icon icon={Trash2} size={14} />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </CollapsiblePanel>
            </Collapsible>
          )}

          {hasMixedDiscussionTypes && (
            <div className="flex shrink-0 flex-wrap items-center gap-1" data-testid="discuss-filter-bar">
              {(["all", "ask", "refine"] as const).map((f) => (
                <Button
                  key={f}
                  type="button"
                  size="xs"
                  variant={discussFilter === f ? "secondary" : "ghost"}
                  className="h-6 rounded-full px-2.5 text-[11.5px]"
                  data-testid={`discuss-filter-${f}`}
                  onClick={() => setDiscussFilter(f)}
                >
                  {t(language, `drawer.filter.${f}`)}
                </Button>
              ))}
            </div>
          )}
        </>
      )}
      composer={d && selected && (
        <div className="shrink-0 pt-1">
          <Composer
            allowEmpty
            value={discussDraft}
            onValueChange={(val) => setDiscussDraft(d.state.id, val)}
            onSubmit={() => {
              if (!busy && !activeAskRunId && discussDraft.trim()) {
                void runAskFromDrawer(d.state.id);
              }
            }}
          >
            {showComposerHeader && (
              <ComposerHeader>
                {discussAnchor && (
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      className="discuss-anchor-pill"
                      title={t(language, "drawer.jumpToAnchor", { anchor: discussAnchor })}
                      onClick={() => triggerAnchorHighlight(discussAnchor)}
                    >
                      <Icon icon={MapPin} size={14} />
                      <span>{discussAnchor}</span>
                    </button>
                    <Button
                      size="icon-xs"
                      type="button"
                      variant="ghost"
                      aria-label={t(language, "drawer.clearAnchor")}
                      onClick={() => setDiscussAnchor(d.state.id, null)}
                    >
                      <Icon icon={X} size={14} />
                    </Button>
                  </div>
                )}
                {activeTaskRunId && (
                  <div className="text-[11px] leading-snug text-muted-foreground" data-testid="drawer-run-lock-hint">
                    {t(language, "drawer.refineLockHint")}
                  </div>
                )}
                {activeAskRunId && (
                  <div className="text-[11px] leading-snug text-muted-foreground" data-testid="drawer-ask-lock-hint">
                    {t(language, "drawer.askLockHint")}
                  </div>
                )}
                {isReadonlyStage && (
                  <div className="text-[11px] leading-snug text-muted-foreground">
                    {t(language, "drawer.readonlyHint")}
                  </div>
                )}
              </ComposerHeader>
            )}

            <ComposerInput
              id="discuss-input"
              data-testid="discuss-input"
              placeholder={t(language, isImplOrAccept ? "drawer.placeholderFix" : "drawer.placeholder")}
            />

            <ComposerActions>
              <ComposerActionGroup>
                <RunnerSelect
                  stageAction="ask"
                  testId="drawer-runner-select"
                  tier={d.state.tier}
                  compact
                  popoverSide="top"
                  popoverAlign="start"
                />
                <Button
                  size="xs"
                  type="button"
                  variant={discussFreshSession ? "secondary" : "ghost"}
                  className="h-7 shrink-0 rounded-lg px-2 text-[11px]"
                  data-testid="discuss-fresh-topic-btn"
                  aria-pressed={discussFreshSession}
                  title={t(language, "drawer.freshTopicTitle")}
                  onClick={() => setDiscussFreshSession(d.state.id, !discussFreshSession)}
                >
                  <Icon icon={RotateCcw} size={14} /> {t(language, "drawer.freshTopic")}
                </Button>
              </ComposerActionGroup>

              <ComposerActionGroup align="end">
                <AsyncButton
                  size="xs"
                  type="button"
                  variant="outline"
                  className="h-7 shrink-0 rounded-lg px-2.5 text-[11.5px]"
                  data-action="run-refine"
                  data-testid="run-refine-btn"
                  disabled={busy || Boolean(activeTaskRunId) || isReadonlyStage}
                  title={t(language, isImplOrAccept ? "drawer.refineCodeBtnTitle" : "drawer.refineBtnTitle")}
                  onAction={() => runRefineFromDrawer(d.state.id)}
                >
                  <Icon icon={Pencil} size={14} />{" "}
                  {t(language, isImplOrAccept ? "drawer.refineCodeShort" : "drawer.refineShort")}
                </AsyncButton>
                <AsyncButton
                  size="icon-sm"
                  type="button"
                  variant="default"
                  className="size-7 shrink-0 rounded-lg"
                  data-action="run-ask"
                  data-testid="run-ask-btn"
                  aria-label={t(language, "drawer.sendAskAria")}
                  title={t(language, "drawer.sendAskAria")}
                  disabled={busy || Boolean(activeAskRunId)}
                  onAction={() => runAskFromDrawer(d.state.id)}
                >
                  <Icon icon={ArrowUp} size={14} />
                </AsyncButton>
              </ComposerActionGroup>
            </ComposerActions>
          </Composer>
        </div>
      )}
    >
      {d && selected && (
        <>
          {threadItems.length === 0 && !activeAskRunId && !lastAskError ? (
            <ChatEmptyState
              icon={<Icon icon={MessageSquare} size={16} />}
              title={t(language, "drawer.tab.discuss")}
              description={
                (discussions?.length ?? 0) > 0 && discussFilter !== "all"
                  ? t(language, "drawer.filterEmpty")
                  : t(language, "drawer.discussEmpty")
              }
            />
          ) : (
            threadItems.map((item, idx) => {
              if (item.kind === "refine_summary") {
                const expanded = Boolean(expandedSummaries[item.id]);
                const firstLine = item.message.split(/\r?\n/)[0] ?? item.message;
                return (
                  <Collapsible
                    key={item.id}
                    open={expanded}
                    onOpenChange={(open) =>
                      setExpandedSummaries((prev) => ({ ...prev, [item.id]: open }))
                    }
                    className="rounded-xl border border-dashed border-border bg-muted/40 overflow-hidden"
                    data-testid="discuss-refine-summary"
                  >
                    <CollapsibleTrigger className="flex w-full flex-wrap items-center gap-1.5 px-2.5 py-1.5 text-left text-[11.5px] text-muted-foreground transition-colors hover:text-foreground">
                      <Icon icon={expanded ? ChevronDown : ChevronRight} size={14} />
                      <Icon icon={Pencil} size={14} />
                      <span className="font-semibold text-foreground">
                        {t(language, "drawer.refineSummaryTitle")}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{firstLine.slice(0, 72)}</span>
                      <span className="text-[11px]">{formatDateTime(item.at, language)}</span>
                    </CollapsibleTrigger>
                    <CollapsiblePanel>
                      <div className="border-t border-dashed border-border px-3 py-2">
                        <ConsoleMarkdown text={item.message} language={language} />
                      </div>
                    </CollapsiblePanel>
                  </Collapsible>
                );
              }

              const prevItem = idx > 0 ? threadItems[idx - 1] : undefined;
              const grouped = Boolean(
                prevItem &&
                  prevItem.kind !== "refine_summary" &&
                  prevItem.actor === item.actor &&
                  item.actor === "human",
              );

              if (item.actor === "human") {
                return (
                  <ChatMessage
                    key={item.id}
                    side="outgoing"
                    grouped={grouped}
                    bubbleProps={{ variant: "default" }}
                    footer={
                      <span className="flex items-center gap-1.5">
                        <span>{t(language, "drawer.me")}</span>
                        <span>·</span>
                        <span>{formatDateTime(item.at, language)}</span>
                      </span>
                    }
                  >
                    <div className="flex flex-col gap-1.5">
                      {(item.mode === "refine" || item.anchor) && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          {item.mode === "refine" && (
                            <Badge variant={item.resolved ? "success" : "warning"} size="sm">
                              <Icon icon={item.resolved ? Check : MessageSquare} size={14} />{" "}
                              {item.resolved
                                ? t(language, "drawer.mode.resolved")
                                : t(language, "drawer.mode.annotate")}
                            </Badge>
                          )}
                          {item.anchor && (
                            <button
                              type="button"
                              className="discuss-anchor-pill"
                              data-testid="anchor-jump-btn"
                              title={t(language, "drawer.jumpToAnchor", { anchor: item.anchor })}
                              onClick={() => triggerAnchorHighlight(item.anchor!)}
                            >
                              <Icon icon={MapPin} size={14} />
                              <span>{item.anchor}</span>
                            </button>
                          )}
                        </div>
                      )}
                      <div className="discuss-human-text">
                        <ConsoleMarkdown text={item.message} language={language} />
                      </div>
                    </div>
                  </ChatMessage>
                );
              }

              const isCopied = copiedId === item.id;
              return (
                <ChatMessage
                  key={item.id}
                  side="incoming"
                  data-testid="discuss-agent-msg"
                  avatar={
                    <span
                      className="inline-flex size-7 items-center justify-center rounded-full border border-border bg-muted/60 text-primary"
                      aria-hidden="true"
                    >
                      <Icon icon={Sparkles} size={14} />
                    </span>
                  }
                  author={
                    <div className="flex w-full items-center justify-between gap-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <span className="font-semibold text-foreground">
                          {item.harness ?? "Agent"}
                          {item.model ? ` · ${item.model}` : ""}
                        </span>
                        {item.adopted && (
                          <Badge variant="success" size="sm">
                            <Icon icon={Check} size={14} /> {t(language, "drawer.adopted")}
                          </Badge>
                        )}
                      </div>
                      <span className="shrink-0 text-[11px] font-normal text-muted-foreground">
                        {formatDateTime(item.at, language)}
                      </span>
                    </div>
                  }
                  bubbleProps={{ variant: "card", className: "w-full" }}
                  footer={
                    <div className="flex w-full flex-col gap-1.5 pt-1">
                      <div className="flex flex-wrap items-center gap-1">
                        <Button
                          size="xs"
                          type="button"
                          variant="ghost"
                          className="h-6 px-2 text-[11.5px] text-muted-foreground hover:text-foreground"
                          data-testid="copy-discussion-btn"
                          onClick={() => void handleCopyReply(item.id, item.message)}
                        >
                          <Icon icon={isCopied ? Check : Copy} size={14} />{" "}
                          {t(language, isCopied ? "drawer.copied" : "drawer.copyReply")}
                        </Button>
                        {!isReadonlyStage && item.mode === "ask" && (
                          <>
                            <Button
                              size="xs"
                              type="button"
                              variant="ghost"
                              className="h-6 px-2 text-[11.5px] text-muted-foreground hover:text-foreground"
                              data-testid="discussion-to-annotation-btn"
                              onClick={() =>
                                setModal({
                                  kind: "annotate_anchor",
                                  anchor: item.anchor || "design.md",
                                  message: item.message.slice(0, 600),
                                  mode: "refine",
                                })
                              }
                            >
                              <Icon icon={BookmarkPlus} size={14} /> {t(language, "drawer.toAnnotation")}
                            </Button>
                            <AsyncButton
                              size="xs"
                              type="button"
                              variant="ghost"
                              className="h-6 px-2 text-[11.5px] text-muted-foreground hover:text-foreground"
                              data-testid="adopt-discussion-btn"
                              disabled={Boolean(activeTaskRunId)}
                              onAction={() => adoptDiscussion(d.state.id, item.id, item.message)}
                            >
                              <Icon icon={Check} size={14} />{" "}
                              {t(language, isImplOrAccept ? "drawer.adoptFix" : "drawer.adopt")}
                            </AsyncButton>
                          </>
                        )}
                      </div>
                      {(item.durationMs !== undefined ||
                        (item.toolCallsCount !== undefined && item.toolCallsCount > 0) ||
                        item.handoffMode ||
                        item.runId) && (
                        <div className="flex flex-wrap items-center gap-2 px-1 text-[11px] text-muted-foreground">
                          {item.durationMs !== undefined && (
                            <span>
                              {t(language, "drawer.replyMeta", {
                                duration: formatDurationHuman(item.durationMs),
                              })}
                            </span>
                          )}
                          {item.toolCallsCount !== undefined && item.toolCallsCount > 0 && (
                            <span>
                              {t(language, "drawer.replyMetaTools", { count: item.toolCallsCount })}
                            </span>
                          )}
                          {item.handoffMode === "native_resume" && (
                            <span>{t(language, "drawer.replyMetaResumed")}</span>
                          )}
                          {(item.handoffMode === "first_run" || item.handoffMode === "fresh_handoff") && (
                            <span>{t(language, "drawer.replyMetaFresh")}</span>
                          )}
                          {item.runId && (
                            <button
                              type="button"
                              className="discuss-trace-link"
                              onClick={() => void openRunConsole(d.state.id, item.runId!)}
                            >
                              {t(language, "drawer.inspectTrace")}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  }
                >
                  {item.anchor && (
                    <button
                      type="button"
                      className="discuss-anchor-pill"
                      data-testid="anchor-jump-btn"
                      title={t(language, "drawer.jumpToAnchor", { anchor: item.anchor })}
                      onClick={() => triggerAnchorHighlight(item.anchor!)}
                    >
                      <Icon icon={MapPin} size={14} />
                      <span>{item.anchor}</span>
                    </button>
                  )}
                  <div className="discuss-ai-body">
                    <ConsoleMarkdown text={item.message} language={language} />
                  </div>
                </ChatMessage>
              );
            })
          )}

          {!activeAskRunId && lastAskError && (
            <Alert variant="error" className="text-xs" data-testid="discuss-ask-error-card">
              <Icon icon={AlertTriangle} size={14} />
              <AlertDescription className="flex w-full flex-col gap-1.5 text-foreground">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-destructive-foreground">
                    {t(
                      language,
                      lastAskError.status === "cancelled"
                        ? "drawer.askCancelledTitle"
                        : "drawer.askFailedTitle",
                    )}
                  </span>
                  <Button
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                    aria-label={t(language, "drawer.dismissError")}
                    onClick={() =>
                      setLastAskError(d.state.id, null, {
                        projectId: lastAskError.projectId,
                        root: lastAskError.root,
                      })
                    }
                  >
                    <Icon icon={X} size={14} />
                  </Button>
                </div>
                {lastAskError.errorSummary && (
                  <div className="text-muted-foreground break-words">{lastAskError.errorSummary}</div>
                )}
                {lastAskError.message && (
                  <div>
                    <AsyncButton
                      size="xs"
                      type="button"
                      variant="outline"
                      data-testid="retry-ask-btn"
                      disabled={busy || Boolean(activeAskRunId)}
                      onAction={() =>
                        runAskFromDrawer(d.state.id, {
                          message: lastAskError.message,
                          anchor: lastAskError.anchor,
                        })
                      }
                    >
                      <Icon icon={RotateCcw} size={14} /> {t(language, "drawer.retryAsk")}
                    </AsyncButton>
                  </div>
                )}
              </AlertDescription>
            </Alert>
          )}
        </>
      )}
    </DrawerDiscussionConversation>
  );
}

function DrawerDiscussionConversation({
  visible,
  open,
  language,
  reqId,
  askRunId,
  lastAskErrorRunId,
  itemCount,
  header,
  composer,
  children,
}: {
  visible: boolean;
  open: boolean;
  language: UiLanguage;
  reqId: string;
  askRunId: string | null;
  lastAskErrorRunId?: string;
  itemCount: number;
  header: ReactNode;
  composer: ReactNode;
  children: ReactNode;
}) {
  const active = visible && open;
  const streaming = active && Boolean(askRunId);
  const activeAskRun = useDrawerStream(streaming, (s) => askRunId ? s.activeRuns[askRunId] : undefined);
  const rawLog = useDrawerStream(streaming, (s) => askRunId ? s.liveRunLogs[askRunId] ?? "" : "");
  const traceEvents = useDrawerStream(streaming, (s) => askRunId ? s.runTraces[askRunId]?.events : undefined);
  const liveDelta = useDrawerStream(streaming, (s) => askRunId ? s.liveStreamDeltas[askRunId] : undefined);
  const scroll = useChatScroll({
    active,
    itemCount,
    layoutKey: `${reqId}:${askRunId ?? ""}:${traceEvents?.length ?? 0}:${liveDelta?.text.length ?? 0}:${liveDelta?.thinking.length ?? 0}:${rawLog.length}:${lastAskErrorRunId ?? ""}`,
  });
  const { resetScroll } = scroll;
  useEffect(() => {
    resetScroll(true);
  }, [reqId, resetScroll]);

  if (!visible) return null;
  return (
    <div className="drawer-body discuss-pane-layout" data-testid="discuss-pane">
      {header}
      <ChatConversation
        scroll={scroll}
        label={t(language, "drawer.tab.discuss")}
        jumpLabel={t(language, "drawer.jumpBottom")}
        viewportTestId="discuss-thread"
        jumpTestId="discuss-jump-bottom-btn"
      >
        {children}
        {activeAskRun?.status === "running" && (
          <DiscussStreamCard
            run={activeAskRun}
            traceEvents={traceEvents}
            liveDelta={liveDelta}
            rawLog={rawLog}
            language={language}
            onStop={() => cancelRun(reqId, activeAskRun.id)}
          />
        )}
      </ChatConversation>
      {composer}
    </div>
  );
}

function DrawerConsolePane({
  reqId,
  agentRuns,
  taskRunId,
  askRunId,
  open,
  language,
}: DrawerRunIds & {
  reqId: string;
  agentRuns?: readonly AgentRunRecord[];
  open: boolean;
  language: UiLanguage;
}) {
  const runs = useMemo(() => agentRuns ? [...agentRuns].reverse() : [], [agentRuns]);
  const explicitSelectedId = useDrawerStream(open, (s) => s.selectedRunByReq[reqId] ?? null);
  const activeRunId = taskRunId ?? askRunId;
  const validSelectedId = explicitSelectedId && (
    explicitSelectedId === taskRunId || explicitSelectedId === askRunId || runs.some((r) => r.id === explicitSelectedId)
  ) ? explicitSelectedId : null;
  const currentRunId = validSelectedId ?? taskRunId ?? runs[0]?.id ?? askRunId;
  const liveRun = useDrawerStream(open, (s) => currentRunId && (currentRunId === taskRunId || currentRunId === askRunId)
    ? s.activeRuns[currentRunId]
    : undefined);
  const liveMetrics = useDrawerStream(open, (s) => currentRunId ? s.liveRunMetrics[currentRunId] : undefined);
  const baseRun = liveRun ?? runs.find((r) => r.id === currentRunId);
  const currentRun = baseRun ? (liveMetrics ? { ...baseRun, ...liveMetrics } : baseRun) : null;

  return (
    <div className="drawer-body" data-testid="console-pane">
      <div className="console-toolbar">
        <Button
          size="xs"
          type="button"
          variant="ghost"
          data-action="open-handoff"
          data-testid="view-handoff-btn"
          onClick={() => void openHandoff(reqId)}
        >
          <Icon icon={FileText} size={14} /> {t(language, "drawer.handoff")}
        </Button>
        {runs.length > 0 && (
          <SimpleSelect
            className="w-auto max-w-[260px] text-xs"
            data-testid="console-run-select"
            options={runs.map((r) => ({
              value: r.id,
              label: `${formatAgentActionLabel(language, r.action)} · ${r.harness}/${r.model}${
                r.modelFallback && r.effectiveModel
                  ? ` → ${t(language, "drawer.actual", { model: r.effectiveModel })}`
                  : ""
              } (${formatAgentStatusLabel(language, r.status)})`,
            }))}
            size="sm"
            value={currentRunId ?? ""}
            onValueChange={(next) => void openRunConsole(reqId, next)}
          />
        )}
      </div>

      {currentRun ? (
        <>
          {activeRunId && currentRun.id !== activeRunId && (
            <Alert variant="warning" className="console-historical-banner py-2 text-xs" data-testid="historical-run-banner">
              <AlertDescription className="flex w-full items-center justify-between gap-2 text-foreground">
                <span>{t(language, "drawer.viewingHistorical", { runId: currentRun.id })}</span>
                <Button
                  size="xs"
                  type="button"
                  variant="ghost"
                  data-testid="jump-to-live-run-btn"
                  onClick={() => void openRunConsole(reqId, activeRunId)}
                >
                  {t(language, "drawer.jumpToLive")}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          <div className="console-status-bar">
            <div className="console-status-info">
              {(() => {
                const tone = AGENT_RUN_TONE[currentRun.status];
                const badgeVariant = tone === "danger" ? "error" : tone === "neutral" ? "secondary" : tone;
                return (
                  <Badge variant={badgeVariant}>
                    <Icon
                      icon={
                        currentRun.status === "running"
                          ? Loader2
                          : currentRun.status === "succeeded"
                            ? Check
                            : X
                      }
                      size={14}
                      className={currentRun.status === "running" ? "spin" : undefined}
                    />{" "}
                    {formatAgentStatusLabel(language, currentRun.status)}
                  </Badge>
                );
              })()}
              <span className="xs">
                <strong>{currentRun.harness}</strong> · {currentRun.model}
              </span>
              {currentRun.modelFallback && currentRun.effectiveModel && (
                <Badge size="sm" variant="warning">
                  {t(language, "drawer.degraded", { model: currentRun.effectiveModel })}
                </Badge>
              )}
            </div>
            <div className="console-status-actions">
              {currentRun.status === "running" ? (
                <AsyncButton
                  key={`cancel-run:${currentRun.id}`}
                  size="xs"
                  type="button"
                  variant="destructive"
                  data-action="cancel-run"
                  data-testid="cancel-run-btn"
                  onAction={() => cancelRun(reqId, currentRun.id)}
                >
                  <Icon icon={Square} size={14} /> {t(language, "drawer.stop")}
                </AsyncButton>
              ) : currentRun.status === "failed" || currentRun.rateLimited ? (
                <AsyncButton
                  key={`retry-fallback:${currentRun.id}`}
                  size="xs"
                  type="button"
                  data-testid="retry-fallback-btn"
                  onAction={() => triggerActiveRun(reqId, currentRun.action, { useFallback: true })}
                >
                  <Icon icon={RotateCcw} size={14} /> {t(language, "drawer.retryFallback")}
                </AsyncButton>
              ) : null}
            </div>
          </div>
          {(currentRun.usage || currentRun.cost || currentRun.turnsCount !== undefined || currentRun.toolCallsCount !== undefined) && (
            <div className="console-telemetry-strip" data-testid="console-telemetry-strip">
              <span className="console-tel-chip">
                <span className="muted">{t(language, "audit.tokens")}:</span>{" "}
                <strong>{formatTokenCount(currentRun.usage?.totalTokens ?? 0)}</strong>
                {currentRun.usage && currentRun.usage.inputTokens > 0 && (
                  <span className="muted">
                    {" "}({t(language, "audit.cacheShort")} {formatPercent(currentRun.usage.cacheReadTokens / currentRun.usage.inputTokens)})
                  </span>
                )}
              </span>
              {currentRun.cost && (
                <span className="console-tel-chip">
                  <span className="muted">{currentRun.billingMode === "api" ? "API" : t(language, "audit.equivShort")}:</span>{" "}
                  <strong>{formatUsd(currentRun.billingMode === "api" ? currentRun.cost.apiCostUsd : currentRun.cost.equivalentCostUsd)}</strong>
                  {currentRun.quotaPool && <span className="muted"> · {currentRun.quotaPool}</span>}
                </span>
              )}
              <span className="console-tel-chip">
                <span className="muted">{t(language, "audit.turnsTools")}:</span>{" "}
                <strong>{currentRun.turnsCount ?? 0} / {currentRun.toolCallsCount ?? 0}</strong>
              </span>
              <span className="console-tel-chip">
                <span className="muted">{t(language, "audit.elapsed")}:</span>{" "}
                <strong>
                  {currentRun.status === "running"
                    ? <LiveTimer startedAt={currentRun.startedAt} />
                    : formatDurationHuman(currentRun.durationMs)}
                </strong>
              </span>
              {currentRun.peakContextTokens && currentRun.contextWindow ? (
                <span className="console-tel-chip">
                  <span className="muted">{t(language, "audit.ctxShort")}:</span>{" "}
                  <strong>{formatPercent(currentRun.peakContextTokens / currentRun.contextWindow)}</strong>
                </span>
              ) : null}
            </div>
          )}
          {currentRun.errorSummary && (
            <Alert variant="error" className="mb-2 text-xs">
              <Icon icon={AlertTriangle} size={14} />
              <AlertDescription className="text-foreground">{currentRun.errorSummary}</AlertDescription>
            </Alert>
          )}
          <DrawerConsoleOutput
            active={open}
            reqId={reqId}
            runId={currentRun.id}
            isRunning={currentRun.status === "running"}
            emptyText={t(language, "drawer.waiting")}
          />
        </>
      ) : (
        <Card className="p-4 text-center text-xs text-muted-foreground">
          {t(language, "drawer.consoleEmpty")}
        </Card>
      )}
    </div>
  );
}

function DrawerConsoleOutput({ active, reqId, runId, isRunning, emptyText }: {
  active: boolean;
  reqId: string;
  runId: string;
  isRunning: boolean;
  emptyText: string;
}) {
  const rawLog = useDrawerStream(active, (s) => s.liveRunLogs[runId] ?? "");
  const logHydrated = useDrawerStream(active, (s) => Boolean(s.logHydrated[runId]));
  const trace = useDrawerStream(active, (s) => s.runTraces[runId]);
  const traceHydrated = Boolean(trace?.hydrated);

  useEffect(() => {
    if (!active) return;
    if (!logHydrated) void hydrateRunLog(reqId, runId, false);
    if (!traceHydrated) void hydrateRunTrace(reqId, runId, false);
  }, [active, reqId, runId, logHydrated, traceHydrated]);

  return (
    <ConsoleOutput
      runId={runId}
      rawLog={rawLog}
      traceEvents={trace?.events}
      hasTrace={trace?.hasTrace}
      traceHydrated={traceHydrated}
      isRunning={isRunning}
      emptyText={emptyText}
    />
  );
}
