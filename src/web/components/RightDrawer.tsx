import { useEffect, useRef } from "react";
import { useWorkbench } from "../context.tsx";
import { formatDateTime } from "../state.ts";
import { LiveTimer, MarkdownView, RunnerSelect } from "./Primitives.tsx";

export function RightDrawer() {
  const {
    state,
    setState,
    setDrawerOpen,
    setDrawerTab,
    openHandoff,
    openRunConsole,
    cancelRun,
    triggerActiveRun,
    runAskFromDrawer,
    runRefineFromDrawer,
    adoptDiscussion,
  } = useWorkbench();

  const d = state.detail;
  const openCls = state.drawerOpen ? "open" : "collapsed";
  const threadRef = useRef<HTMLDivElement | null>(null);
  const consolePreRef = useRef<HTMLPreElement | null>(null);

  const reqId = d?.state.id ?? "";
  const activeRun = d
    ? Object.values(state.activeRuns).find((r) => r.requirementId === reqId) ?? null
    : null;
  const runs = d ? [...(d.state.agentRuns ?? [])].reverse() : [];
  const currentRunId = activeRun?.id ?? state.selectedRunId ?? runs[0]?.id ?? null;
  const currentRun =
    currentRunId
      ? activeRun?.id === currentRunId
        ? activeRun
        : runs.find((r) => r.id === currentRunId) ?? null
      : null;
  const liveText = currentRun ? state.liveRunLogs[currentRun.id] ?? "" : "";
  const streamText = activeRun ? state.liveRunLogs[activeRun.id] ?? "" : "";

  useEffect(() => {
    if (state.drawerOpen && state.drawerTab === "discuss" && threadRef.current && activeRun) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [state.drawerOpen, state.drawerTab, activeRun, streamText]);

  useEffect(() => {
    if (state.drawerOpen && state.drawerTab === "console" && consolePreRef.current) {
      consolePreRef.current.scrollTop = consolePreRef.current.scrollHeight;
    }
  }, [state.drawerOpen, state.drawerTab, liveText]);

  if (!d) {
    return <aside className={`drawer ${openCls}`} data-testid="right-drawer" />;
  }

  const discussions = d.state.discussions ?? [];

  return (
    <aside className={`drawer ${openCls}`} data-testid="right-drawer">
      <div className="drawer-head">
        <div className="drawer-tabs">
          <button
            className={`drawer-tab ${state.drawerTab === "discuss" ? "active" : ""}`}
            type="button"
            data-action="set-drawer-tab"
            data-tab="discuss"
            data-testid="drawer-tab-discuss"
            onClick={() => setDrawerTab("discuss")}
          >
            💬 研讨与批注{state.pendingAnnotations.length > 0 ? ` (${state.pendingAnnotations.length})` : ""}
          </button>
          <button
            className={`drawer-tab ${state.drawerTab === "console" ? "active" : ""}`}
            type="button"
            data-action="set-drawer-tab"
            data-tab="console"
            data-testid="drawer-tab-console"
            onClick={() => setDrawerTab("console")}
          >
            &gt;_ 执行终端{activeRun ? " ●" : ""}
          </button>
        </div>
        <button
          className="btn ghost xs"
          type="button"
          title="收起右侧栏"
          onClick={() => setDrawerOpen(false)}
        >
          ×
        </button>
      </div>

      {state.drawerTab === "discuss" ? (
        <div className="drawer-body" data-testid="discuss-pane">
          {state.pendingAnnotations.length > 0 && (
            <div className="annot-queue" data-testid="pending-annotations">
              <div className="annot-queue-head">
                <strong>待提交批注 ({state.pendingAnnotations.length})</strong>
                <button
                  className="btn ghost xs"
                  type="button"
                  onClick={() => setState((prev) => ({ ...prev, pendingAnnotations: [] }))}
                >
                  清空
                </button>
              </div>
              {state.pendingAnnotations.map((a) => (
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
                    onClick={() =>
                      setState((prev) => ({
                        ...prev,
                        pendingAnnotations: prev.pendingAnnotations.filter((x) => x.id !== a.id),
                      }))
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="discuss-thread" data-testid="discuss-thread" ref={threadRef}>
            {discussions.length === 0 && !activeRun ? (
              <div className="empty-card xs muted" style={{ textAlign: "center" }}>
                针对方案有疑问或不满意之处？可悬停正文段落点「💬 批注」，或在下方直接向任意模型提问探讨（不会擅自改写方案）。
              </div>
            ) : (
              discussions.map((item) => (
                <div key={item.id} className={`discuss-msg ${item.actor}`}>
                  <div className="discuss-meta">
                    <span>
                      {item.actor === "human"
                        ? "我"
                        : `${item.harness ?? "Agent"}${item.model ? ` · ${item.model}` : ""}`}
                    </span>
                    <span className={`badge ${item.mode === "ask" ? "info" : "warning"}`}>
                      {item.mode === "ask" ? "探讨" : item.resolved ? "已落实" : "批注"}
                    </span>
                    <span className="muted xs">{formatDateTime(item.at)}</span>
                  </div>
                  {item.anchor && (
                    <div className="xs muted" style={{ marginBottom: 4 }}>
                      锚点：{item.anchor}
                    </div>
                  )}
                  <MarkdownView markdown={item.message} className="md-body xs" />
                  {item.actor === "agent" && item.mode === "ask" && (
                    <div style={{ marginTop: 6 }}>
                      <button
                        className="btn ghost xs"
                        type="button"
                        onClick={() => void adoptDiscussion(item.id)}
                      >
                        采纳此回复并更新方案
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
                  <span>
                    ⚡ {activeRun.harness} · {activeRun.model}
                  </span>
                  <span className="badge info">
                    流式输出中 · <LiveTimer startedAt={activeRun.startedAt} />
                  </span>
                </div>
                <pre className="discuss-stream-pre" data-testid="discuss-stream-output">
                  {streamText.trim() || "正在连接模型并分析上下文…"}
                </pre>
              </div>
            )}
          </div>

          <div className="drawer-composer">
            {state.discussAnchor && (
              <div className="xs muted" style={{ marginBottom: 4 }}>
                锚点：<strong>{state.discussAnchor}</strong>{" "}
                <button
                  className="btn ghost xs"
                  type="button"
                  onClick={() => setState((prev) => ({ ...prev, discussAnchor: null }))}
                >
                  ×
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
              value={state.discussDraft}
              placeholder="向选定模型提问探讨（Ask），或写下修改要求让 Agent 修订方案…"
              onChange={(e) => setState((prev) => ({ ...prev, discussDraft: e.target.value }))}
            />
            <div className="drawer-composer-actions">
              <button
                className="btn"
                type="button"
                data-action="run-ask"
                data-testid="run-ask-btn"
                disabled={state.busy || Boolean(activeRun)}
                onClick={() => void runAskFromDrawer()}
              >
                💡 仅提问探讨
              </button>
              <button
                className="btn primary"
                type="button"
                data-action="run-refine"
                data-testid="run-refine-btn"
                disabled={state.busy || Boolean(activeRun)}
                onClick={() => void runRefineFromDrawer()}
              >
                ✏️ 让 Agent 修订
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
              onClick={() => void openHandoff()}
            >
              📄 交接简报 handoff.md
            </button>
            {runs.length > 0 && (
              <select
                className="select xs"
                value={currentRunId ?? ""}
                onChange={(e) => void openRunConsole(e.target.value)}
              >
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.action} · {r.harness}/{r.model} ({r.status})
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
                      ? "执行中"
                      : currentRun.status === "succeeded"
                        ? "已完成"
                        : currentRun.status === "cancelled"
                          ? "已终止"
                          : "失败"}
                  </span>
                  <span className="xs" style={{ marginLeft: 6 }}>
                    <strong>{currentRun.harness}</strong> · {currentRun.model}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  {currentRun.status === "running" ? (
                    <button
                      className="btn danger xs"
                      type="button"
                      data-action="cancel-run"
                      data-testid="cancel-run-btn"
                      onClick={() => void cancelRun(currentRun.id)}
                    >
                      终止任务
                    </button>
                  ) : currentRun.status === "failed" || currentRun.rateLimited ? (
                    <button
                      className="btn primary xs"
                      type="button"
                      data-testid="retry-fallback-btn"
                      onClick={() => void triggerActiveRun(d.state.id, currentRun.action, { useFallback: true })}
                    >
                      切换备援模型重试
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
                {liveText || "等待终端输出…"}
              </pre>
            </>
          ) : (
            <div className="empty-card xs muted" style={{ textAlign: "center" }}>
              尚未通过调度器触发 Agent 执行。可在主横幅选择模型后点击「⚡ 后台执行」。
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
