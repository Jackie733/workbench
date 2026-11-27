import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
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
import { formatAgentActionLabel, formatAgentStatusLabel, t } from "../i18n.ts";
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
  useRequirementAskError,
  useRequirementAskRun,
  useRequirementQuery,
  useRequirementRunLock,
} from "../queries.ts";
import {
  AGENT_RUN_TONE,
  formatDateTime,
  formatDurationHuman,
  formatPercent,
  formatTokenCount,
  formatUsd,
  getPendingRefineAnnotations,
} from "../state.ts";
import { useDraftStore } from "../stores/draftStore.ts";
import { useStreamStore } from "../stores/streamStore.ts";
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

function computeMaxDrawerWidth(workspaceEl: HTMLElement | null): number {
  if (!workspaceEl) return DEFAULT_DRAWER_WIDTH;
  const available = workspaceEl.clientWidth;
  if (available <= 0) return DEFAULT_DRAWER_WIDTH;
  return Math.max(MIN_DRAWER_WIDTH, Math.floor(available * 0.5));
}

function clampDrawerWidth(width: number, maxWidth: number): number {
  return Math.min(Math.max(Math.round(width), MIN_DRAWER_WIDTH), Math.max(MIN_DRAWER_WIDTH, maxWidth));
}

export function RightDrawer({ workspaceRef }: { workspaceRef?: RefObject<HTMLDivElement | null> }) {
  const language = useUiStore((s) => s.language);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const selectedId = useUiStore((s) => s.selectedId);
  const drawerOpen = useUiStore((s) => s.drawerOpen);
  const drawerWidth = useUiStore((s) => s.drawerWidth);
  const drawerTab = useUiStore((s) => s.drawerTab);
  const busy = useUiStore((s) => s.busy);
  const setDrawerOpen = useUiStore((s) => s.setDrawerOpen);
  const setDrawerWidth = useUiStore((s) => s.setDrawerWidth);
  const setDrawerTab = useUiStore((s) => s.setDrawerTab);
  const setModal = useUiStore((s) => s.setModal);
  const triggerAnchorHighlight = useUiStore((s) => s.triggerAnchorHighlight);

  const { data: reqData } = useRequirementQuery(activeProjectId, selectedId);
  const d = reqData?.detail ?? null;
  const reqId = d?.state.id ?? "";

  // 双轨独立状态：activeTaskRun（主任务，驱动终端与写锁）与 activeAskRun（只读研讨，互不互斥）。
  const activeTaskRun = useRequirementRunLock(d?.state.id ?? null);
  const activeAskRun = useRequirementAskRun(d?.state.id ?? null);

  const discussDraft = useDraftStore((s) => (reqId ? s.discussDraftByReq[reqId] ?? "" : ""));
  const discussAnchor = useDraftStore((s) => (reqId ? s.discussAnchorByReq[reqId] ?? null : null));
  const discussFreshSession = useDraftStore((s) => (reqId ? Boolean(s.discussFreshSessionByReq[reqId]) : false));
  const setDiscussDraft = useDraftStore((s) => s.setDiscussDraft);
  const setDiscussAnchor = useDraftStore((s) => s.setDiscussAnchor);
  const setDiscussFreshSession = useDraftStore((s) => s.setDiscussFreshSession);

  const selectedRunByReq = useStreamStore((s) => s.selectedRunByReq);
  const logHydratedMap = useStreamStore((s) => s.logHydrated);
  const runTraces = useStreamStore((s) => s.runTraces);
  const liveRunMetrics = useStreamStore((s) => s.liveRunMetrics);
  const liveStreamDeltas = useStreamStore((s) => s.liveStreamDeltas);
  const lastAskError = useRequirementAskError(d?.state.id ?? null);
  const setLastAskError = useStreamStore((s) => s.setLastAskError);

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
  const [discussFilter, setDiscussFilter] = useState<DiscussFilter>("all");
  const [queueOpen, setQueueOpen] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedSummaries, setExpandedSummaries] = useState<Record<string, boolean>>({});
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

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

  const runs = d ? [...(d.state.agentRuns ?? [])].reverse() : [];
  const explicitSelectedId = reqId ? (selectedRunByReq[reqId] ?? null) : null;
  const activeRunForConsole = activeTaskRun ?? activeAskRun;
  const validSelectedId =
    explicitSelectedId &&
    (runs.some((r) => r.id === explicitSelectedId) ||
      (activeTaskRun && activeTaskRun.id === explicitSelectedId) ||
      (activeAskRun && activeAskRun.id === explicitSelectedId))
      ? explicitSelectedId
      : null;
  const currentRunId = validSelectedId ?? activeTaskRun?.id ?? runs[0]?.id ?? activeAskRun?.id ?? null;
  const baseRun =
    currentRunId
      ? activeTaskRun?.id === currentRunId
        ? activeTaskRun
        : activeAskRun?.id === currentRunId
          ? activeAskRun
          : runs.find((r) => r.id === currentRunId) ?? null
      : null;
  const currentLiveMetrics = currentRunId ? liveRunMetrics[currentRunId] : undefined;
  const currentRun = baseRun ? (currentLiveMetrics ? { ...baseRun, ...currentLiveMetrics } : baseRun) : null;

  const liveText = useStreamStore((s) => (currentRun ? s.liveRunLogs[currentRun.id] ?? "" : ""));
  const isLogHydrated = useStreamStore((s) => (currentRun ? Boolean(s.logHydrated[currentRun.id]) : false));
  const traceState = currentRun ? runTraces[currentRun.id] : undefined;

  const askStreamLog = useStreamStore((s) => (activeAskRun ? s.liveRunLogs[activeAskRun.id] ?? "" : ""));
  const askTraceEvents = activeAskRun ? runTraces[activeAskRun.id]?.events : undefined;
  const askLiveDelta = activeAskRun ? liveStreamDeltas[activeAskRun.id] : undefined;

  const discussions = d?.state.discussions ?? [];
  // 单一真相源：从服务端持久化的未解决 refine 批注直接派生，刷新不丢失、跨需求不串台。
  const pendingAnnotations = useMemo(() => getPendingRefineAnnotations(discussions), [discussions]);
  const pendingAnnotationIdSet = useMemo(() => new Set(pendingAnnotations.map((a) => a.id)), [pendingAnnotations]);

  // 对话流与顶部待处理批注队列分离：未解决的待提交批注集中在顶部栏，不重复刷屏。
  const threadItems = useMemo(() => {
    const base = discussions.filter((item) => !pendingAnnotationIdSet.has(item.id));
    if (discussFilter === "ask") return base.filter((item) => item.mode === "ask");
    if (discussFilter === "refine") return base.filter((item) => item.mode === "refine");
    return base;
  }, [discussions, pendingAnnotationIdSet, discussFilter]);

  const hasMixedDiscussionTypes = useMemo(() => {
    const hasAsk = discussions.some((item) => item.mode === "ask");
    const hasRefine = discussions.some((item) => item.mode === "refine" && !pendingAnnotationIdSet.has(item.id));
    return hasAsk && hasRefine;
  }, [discussions, pendingAnnotationIdSet]);

  const chatScroll = useChatScroll({
    active: Boolean(d) && drawerOpen && drawerTab === "discuss",
    itemCount: threadItems.length + (activeAskRun ? 1 : 0) + (lastAskError ? 1 : 0),
    layoutKey: `${reqId}:${activeAskRun?.id ?? ""}:${askTraceEvents?.length ?? 0}:${askLiveDelta?.text.length ?? 0}:${askLiveDelta?.thinking.length ?? 0}:${askStreamLog.length}:${lastAskError?.runId ?? ""}`,
  });

  useEffect(() => {
    setDiscussFilter("all");
    chatScroll.resetScroll(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqId]);

  useEffect(() => {
    if (!drawerOpen || drawerTab !== "console" || !reqId || !currentRun) return;
    if (!isLogHydrated || !logHydratedMap[currentRun.id]) {
      void hydrateRunLog(reqId, currentRun.id, false);
    }
    if (!traceState?.hydrated) {
      void hydrateRunTrace(reqId, currentRun.id, false);
    }
  }, [drawerOpen, drawerTab, reqId, currentRun?.id, isLogHydrated, traceState?.hydrated]);

  const handleCopyReply = async (id: string, text: string) => {
    const ok = await copyTextToClipboard(text);
    if (!ok) return;
    setCopiedId(id);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopiedId(null), 1800);
  };

  const effectiveWidth = clampDrawerWidth(drawerWidth, maxWidth);
  const stage = d?.state.stage;
  const isImplOrAccept = stage === "coding";
  const isReadonlyStage = stage === "done" || stage === "cancelled";

  const showComposerHeader = Boolean(discussAnchor || activeTaskRun || activeAskRun || isReadonlyStage);

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
                      {activeAskRun && (
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
                      {activeTaskRun && (
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

              {drawerTab === "diff" ? (
                <div className="drawer-body drawer-diff-body" data-testid="drawer-diff-pane">
                  <DiffViewerPanel d={d} inDrawer />
                </div>
              ) : drawerTab === "discuss" ? (
                <div className="drawer-body discuss-pane-layout" data-testid="discuss-pane">
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
                              disabled={busy || Boolean(activeTaskRun)}
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

                  <ChatConversation
                    scroll={chatScroll}
                    label={t(language, "drawer.tab.discuss")}
                    jumpLabel={t(language, "drawer.jumpBottom")}
                    viewportTestId="discuss-thread"
                    jumpTestId="discuss-jump-bottom-btn"
                  >
                    {threadItems.length === 0 && !activeAskRun && !lastAskError ? (
                      <ChatEmptyState
                        icon={<Icon icon={MessageSquare} size={16} />}
                        title={t(language, "drawer.tab.discuss")}
                        description={
                          discussions.length > 0 && discussFilter !== "all"
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
                                        disabled={Boolean(activeTaskRun)}
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

                    {activeAskRun && activeAskRun.status === "running" && (
                      <DiscussStreamCard
                        run={activeAskRun}
                        traceEvents={askTraceEvents}
                        liveDelta={askLiveDelta}
                        rawLog={askStreamLog}
                        language={language}
                        onStop={() => cancelRun(d.state.id, activeAskRun.id)}
                      />
                    )}

                    {!activeAskRun && lastAskError && (
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
                                disabled={busy || Boolean(activeAskRun)}
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
                  </ChatConversation>

                  <div className="shrink-0 pt-1">
                    <Composer
                      allowEmpty
                      value={discussDraft}
                      onValueChange={(val) => setDiscussDraft(d.state.id, val)}
                      onSubmit={() => {
                        if (!busy && !activeAskRun && discussDraft.trim()) {
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
                          {activeTaskRun && (
                            <div className="text-[11px] leading-snug text-muted-foreground" data-testid="drawer-run-lock-hint">
                              {t(language, "drawer.refineLockHint")}
                            </div>
                          )}
                          {activeAskRun && (
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
                            disabled={busy || Boolean(activeTaskRun) || isReadonlyStage}
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
                            disabled={busy || Boolean(activeAskRun)}
                            onAction={() => runAskFromDrawer(d.state.id)}
                          >
                            <Icon icon={ArrowUp} size={14} />
                          </AsyncButton>
                        </ComposerActionGroup>
                      </ComposerActions>
                    </Composer>
                  </div>
                </div>
              ) : (
                <div className="drawer-body" data-testid="console-pane">
                  <div className="console-toolbar">
                    <Button
                      size="xs"
                      type="button"
                      variant="ghost"
                      data-action="open-handoff"
                      data-testid="view-handoff-btn"
                      onClick={() => void openHandoff(d.state.id)}
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
                        onValueChange={(next) => void openRunConsole(d.state.id, next)}
                      />
                    )}
                  </div>

                  {currentRun ? (
                    <>
                      {activeRunForConsole && currentRun.id !== activeRunForConsole.id && (
                        <Alert variant="warning" className="console-historical-banner py-2 text-xs" data-testid="historical-run-banner">
                          <AlertDescription className="flex w-full items-center justify-between gap-2 text-foreground">
                            <span>{t(language, "drawer.viewingHistorical", { runId: currentRun.id })}</span>
                            <Button
                              size="xs"
                              type="button"
                              variant="ghost"
                              data-testid="jump-to-live-run-btn"
                              onClick={() => void openRunConsole(d.state.id, activeRunForConsole.id)}
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
                              onAction={() => cancelRun(d.state.id, currentRun.id)}
                            >
                              <Icon icon={Square} size={14} /> {t(language, "drawer.stop")}
                            </AsyncButton>
                          ) : currentRun.status === "failed" || currentRun.rateLimited ? (
                            <AsyncButton
                              key={`retry-fallback:${currentRun.id}`}
                              size="xs"
                              type="button"
                              data-testid="retry-fallback-btn"
                              onAction={() => triggerActiveRun(d.state.id, currentRun.action, { useFallback: true })}
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
                      <ConsoleOutput
                        runId={currentRun.id}
                        rawLog={liveText}
                        traceEvents={traceState?.events}
                        hasTrace={traceState ? traceState.hasTrace : undefined}
                        traceHydrated={Boolean(traceState?.hydrated)}
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
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
