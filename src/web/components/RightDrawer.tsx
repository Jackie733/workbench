import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { FileText, Lightbulb, MessageSquare, Pencil, Terminal, X, Zap } from "lucide-react";
import { t } from "../i18n.ts";
import { useCollapsePhase } from "../lib/utils.ts";
import {
  adoptDiscussion,
  cancelRun,
  openHandoff,
  openRunConsole,
  runAskFromDrawer,
  runRefineFromDrawer,
  triggerActiveRun,
  useRequirementQuery,
} from "../queries.ts";
import { formatDateTime } from "../state.ts";
import { useDraftStore } from "../stores/draftStore.ts";
import { useStreamStore } from "../stores/streamStore.ts";
import { DEFAULT_DRAWER_WIDTH, MIN_DRAWER_WIDTH, useUiStore } from "../stores/uiStore.ts";
import { Icon } from "./Icon.tsx";
import { LiveTimer, MarkdownView, RunnerSelect } from "./Primitives.tsx";

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

  const pendingAnnotations = useDraftStore((s) => s.pendingAnnotations);
  const discussDraft = useDraftStore((s) => s.discussDraft);
  const discussAnchor = useDraftStore((s) => s.discussAnchor);
  const setDiscussDraft = useDraftStore((s) => s.setDiscussDraft);
  const setDiscussAnchor = useDraftStore((s) => s.setDiscussAnchor);
  const removePendingAnnotation = useDraftStore((s) => s.removePendingAnnotation);
  const clearPendingAnnotations = useDraftStore((s) => s.clearPendingAnnotations);

  const activeRuns = useStreamStore((s) => s.activeRuns);
  const selectedRunId = useStreamStore((s) => s.selectedRunId);

  const { data: reqData } = useRequirementQuery(activeProjectId, selectedId);
  const d = reqData?.detail ?? null;

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
  const threadRef = useRef<HTMLDivElement | null>(null);
  const consolePreRef = useRef<HTMLPreElement | null>(null);
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

  const reqId = d?.state.id ?? "";
  const activeRun = d
    ? Object.values(activeRuns).find(
        (r) => r.requirementId === reqId && (!r.projectId || r.projectId === activeProjectId),
      ) ?? null
    : null;
  const runs = d ? [...(d.state.agentRuns ?? [])].reverse() : [];
  const currentRunId = activeRun?.id ?? selectedRunId ?? runs[0]?.id ?? null;
  const currentRun =
    currentRunId
      ? activeRun?.id === currentRunId
        ? activeRun
        : runs.find((r) => r.id === currentRunId) ?? null
      : null;

  const liveText = useStreamStore((s) => (currentRun ? s.liveRunLogs[currentRun.id] ?? "" : ""));
  const streamText = useStreamStore((s) => (activeRun ? s.liveRunLogs[activeRun.id] ?? "" : ""));

  useEffect(() => {
    if (drawerOpen && drawerTab === "discuss" && threadRef.current && activeRun) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [drawerOpen, drawerTab, activeRun, streamText]);

  useEffect(() => {
    if (drawerOpen && drawerTab === "console" && consolePreRef.current) {
      consolePreRef.current.scrollTop = consolePreRef.current.scrollHeight;
    }
  }, [drawerOpen, drawerTab, liveText]);

  const effectiveWidth = clampDrawerWidth(drawerWidth, maxWidth);
  const discussions = d?.state.discussions ?? [];

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
                <div className="drawer-tabs">
                  <button
                    className={`drawer-tab ${drawerTab === "discuss" ? "active" : ""}`}
                    type="button"
                    data-action="set-drawer-tab"
                    data-tab="discuss"
                    data-testid="drawer-tab-discuss"
                    onClick={() => setDrawerTab("discuss")}
                  >
                    <Icon icon={MessageSquare} size={14} /> {t(language, "drawer.tab.discuss")}
                    {pendingAnnotations.length > 0 ? ` (${pendingAnnotations.length})` : ""}
                  </button>
                  <button
                    className={`drawer-tab ${drawerTab === "console" ? "active" : ""}`}
                    type="button"
                    data-action="set-drawer-tab"
                    data-tab="console"
                    data-testid="drawer-tab-console"
                    onClick={() => setDrawerTab("console")}
                  >
                    <Icon icon={Terminal} size={14} /> {t(language, "drawer.tab.console")}
                    {activeRun && (
                      <span className="pulse-dot" role="img" aria-label={t(language, "drawer.running")} />
                    )}
                  </button>
                </div>
              </div>

              {drawerTab === "discuss" ? (
                <div className="drawer-body" data-testid="discuss-pane">
                  {pendingAnnotations.length > 0 && (
                    <div className="annot-queue" data-testid="pending-annotations">
                      <div className="annot-queue-head">
                        <strong>{t(language, "drawer.pending", { count: pendingAnnotations.length })}</strong>
                        <button
                          className="btn ghost xs"
                          type="button"
                          onClick={() => clearPendingAnnotations()}
                        >
                          {t(language, "common.clear")}
                        </button>
                      </div>
                      {pendingAnnotations.map((a) => (
                        <div key={a.id} className="annot-chip">
                          <div>
                            <span className="badge info">{a.anchor}</span>
                            <div className="xs" style={{ marginTop: 4 }}>
                              {a.message}
                            </div>
                          </div>
                          <button
                            className="btn ghost xs"
                            type="button"
                            aria-label={t(language, "drawer.removeAnnotation")}
                            onClick={() => removePendingAnnotation(a.id)}
                          >
                            <Icon icon={X} size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="discuss-thread" data-testid="discuss-thread" ref={threadRef}>
                    {discussions.length === 0 && !activeRun ? (
                      <div className="empty-card xs muted" style={{ textAlign: "center" }}>
                        {t(language, "drawer.discussEmpty")}
                      </div>
                    ) : (
                      discussions.map((item) => (
                        <div key={item.id} className={`discuss-msg ${item.actor}`}>
                          <div className="discuss-meta">
                            <span>
                              {item.actor === "human"
                                ? t(language, "drawer.me")
                                : `${item.harness ?? "Agent"}${item.model ? ` · ${item.model}` : ""}`}
                            </span>
                            <span className={`badge ${item.mode === "ask" ? "info" : "warning"}`}>
                              {item.mode === "ask"
                                ? t(language, "drawer.mode.ask")
                                : item.resolved
                                  ? t(language, "drawer.mode.resolved")
                                  : t(language, "drawer.mode.annotate")}
                            </span>
                            <span className="muted xs">{formatDateTime(item.at, language)}</span>
                          </div>
                          {item.anchor && (
                            <div className="xs muted" style={{ marginBottom: 4 }}>
                              {t(language, "drawer.anchor", { anchor: item.anchor })}
                            </div>
                          )}
                          <MarkdownView markdown={item.message} className="md-body xs" />
                          {item.actor === "agent" && item.mode === "ask" && (
                            <div style={{ marginTop: 6 }}>
                              <button
                                className="btn ghost xs"
                                type="button"
                                onClick={() => void adoptDiscussion(d.state.id, item.id, item.message)}
                              >
                                {t(language, "drawer.adopt")}
                              </button>
                            </div>
                          )}
                        </div>
                      ))
                    )}

                    {activeRun && activeRun.status === "running" && (
                      <div className="discuss-msg agent discuss-streaming" data-testid="discuss-stream-card">
                        <div className="discuss-meta">
                          <span className="pulse-dot" />
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                            <Icon icon={Zap} size={14} /> {activeRun.harness} · {activeRun.model}
                          </span>
                          <span className="badge info">
                            {t(language, "drawer.streaming")} · <LiveTimer startedAt={activeRun.startedAt} />
                          </span>
                        </div>
                        <pre className="discuss-stream-pre" data-testid="discuss-stream-output">
                          {streamText.trim() || t(language, "drawer.connecting")}
                        </pre>
                      </div>
                    )}
                  </div>

                  <div className="drawer-composer">
                    {discussAnchor && (
                      <div className="xs muted" style={{ marginBottom: 4 }}>
                        {t(language, "drawer.anchor", { anchor: discussAnchor })}{" "}
                        <button
                          className="btn ghost xs"
                          type="button"
                          aria-label={t(language, "drawer.clearAnchor")}
                          onClick={() => setDiscussAnchor(null)}
                        >
                          <Icon icon={X} size={14} />
                        </button>
                      </div>
                    )}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, marginBottom: 6 }}>
                      <RunnerSelect stageAction="ask" testId="drawer-runner-select" />
                    </div>
                    <textarea
                      className="textarea"
                      id="discuss-input"
                      data-testid="discuss-input"
                      rows={3}
                      value={discussDraft}
                      placeholder={t(language, "drawer.placeholder")}
                      onChange={(e) => setDiscussDraft(e.target.value)}
                    />
                    <div className="drawer-composer-actions">
                      <button
                        className="btn"
                        type="button"
                        data-action="run-ask"
                        data-testid="run-ask-btn"
                        disabled={busy || Boolean(activeRun)}
                        onClick={() => void runAskFromDrawer(d.state.id)}
                      >
                        <Icon icon={Lightbulb} size={14} /> {t(language, "drawer.ask")}
                      </button>
                      <button
                        className="btn primary"
                        type="button"
                        data-action="run-refine"
                        data-testid="run-refine-btn"
                        disabled={busy || Boolean(activeRun)}
                        onClick={() => void runRefineFromDrawer(d.state.id)}
                      >
                        <Icon icon={Pencil} size={14} /> {t(language, "drawer.refine")}
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="drawer-body" data-testid="console-pane">
                  <div className="console-toolbar">
                    <button
                      className="btn ghost xs"
                      type="button"
                      data-action="open-handoff"
                      data-testid="view-handoff-btn"
                      onClick={() => void openHandoff(d.state.id)}
                    >
                      <Icon icon={FileText} size={14} /> {t(language, "drawer.handoff")}
                    </button>
                    {runs.length > 0 && (
                      <select
                        className="select xs"
                        value={currentRunId ?? ""}
                        onChange={(e) => void openRunConsole(d.state.id, e.target.value)}
                      >
                        {runs.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.action} · {r.harness}/{r.model}
                            {r.modelFallback && r.effectiveModel
                              ? ` → ${t(language, "drawer.actual", { model: r.effectiveModel })}`
                              : ""}{" "}
                            ({r.status})
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  {currentRun ? (
                    <>
                      <div className="console-status-bar">
                        <div>
                          <span
                            className={`badge ${
                              currentRun.status === "running"
                                ? "info"
                                : currentRun.status === "succeeded"
                                  ? "success"
                                  : "danger"
                            }`}
                          >
                            {currentRun.status === "running"
                              ? t(language, "drawer.status.running")
                              : currentRun.status === "succeeded"
                                ? t(language, "drawer.status.succeeded")
                                : currentRun.status === "cancelled"
                                  ? t(language, "drawer.status.cancelled")
                                  : t(language, "drawer.status.failed")}
                          </span>
                          <span className="xs" style={{ marginLeft: 6 }}>
                            <strong>{currentRun.harness}</strong> · {currentRun.model}
                          </span>
                          {currentRun.modelFallback && currentRun.effectiveModel && (
                            <span className="badge warning xs" style={{ marginLeft: 6 }}>
                              {t(language, "drawer.degraded", { model: currentRun.effectiveModel })}
                            </span>
                          )}
                        </div>
                        <div style={{ display: "flex", gap: 6 }}>
                          {currentRun.status === "running" ? (
                            <button
                              className="btn danger xs"
                              type="button"
                              data-action="cancel-run"
                              data-testid="cancel-run-btn"
                              onClick={() => void cancelRun(d.state.id, currentRun.id)}
                            >
                              {t(language, "drawer.stop")}
                            </button>
                          ) : currentRun.status === "failed" || currentRun.rateLimited ? (
                            <button
                              className="btn primary xs"
                              type="button"
                              data-testid="retry-fallback-btn"
                              onClick={() => void triggerActiveRun(d.state.id, currentRun.action, { useFallback: true })}
                            >
                              {t(language, "drawer.retryFallback")}
                            </button>
                          ) : null}
                        </div>
                      </div>
                      {currentRun.errorSummary && (
                        <div className="callout danger xs" style={{ marginBottom: 8 }}>
                          {currentRun.errorSummary}
                        </div>
                      )}
                      <pre className="console-log" data-testid="console-log-output" ref={consolePreRef}>
                        {liveText || t(language, "drawer.waiting")}
                      </pre>
                    </>
                  ) : (
                    <div className="empty-card xs muted" style={{ textAlign: "center" }}>
                      {t(language, "drawer.consoleEmpty")}
                    </div>
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
