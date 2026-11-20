import { QueryClientContext } from "@tanstack/react-query";
import { diffLines } from "diff";
import {
  Activity,
  ArrowRight,
  Check,
  CircleOff,
  Clock,
  Cpu,
  FileText,
  GitBranch,
  Layers,
  Loader2,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { useContext, useEffect, useMemo, useState } from "react";
import type { AgentRunRecord, RequirementDetail, RunTraceEvent, TimelineEvent } from "../../core/types.ts";
import { formatAgentActionLabel, formatAgentStatusLabel, t, type MessageKey, type UiLanguage } from "../i18n.ts";
import {
  hydrateRunLog,
  hydrateRunTrace,
  openHandoff,
  openRunConsole,
  useRequirementRunsQuery,
  useRunContextQuery,
} from "../queries.ts";
import {
  AGENT_RUN_TONE,
  formatBytes,
  formatDateTime,
  formatDurationHuman,
  formatPercent,
  formatTokenCount,
  formatUsd,
} from "../state.ts";
import { useStreamStore } from "../stores/streamStore.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { CompositionBar, ContextGrowthChart } from "./Charts.tsx";
import { ConsoleOutput } from "./ConsoleOutput.tsx";
import { Icon } from "./Icon.tsx";
import { MarkdownView } from "./Primitives.tsx";

type InspectorTab = "trace" | "context" | "usage" | "raw";
type TimelineFilter = "all" | "agent" | "review" | "verify" | "system";
type ContextSubView = "diff" | "handoff" | "prompt";

function handoffModeLabel(language: UiLanguage, mode?: AgentRunRecord["handoffMode"]): string {
  if (mode === "native_resume") return t(language, "audit.handoff.nativeResume");
  if (mode === "fresh_handoff") return t(language, "audit.handoff.freshHandoff");
  return t(language, "audit.handoff.firstRun");
}

function timelineCategory(ev: TimelineEvent): TimelineFilter {
  if (ev.kind.startsWith("review_")) return "review";
  if (ev.kind.startsWith("verification_")) return "verify";
  if (ev.kind === "agent_run_started" || ev.kind === "agent_run_finished" || ev.kind === "agent_handoff" || ev.actor === "agent") {
    return "agent";
  }
  return "system";
}

function RunInspectorSection({
  reqId,
  runs,
  inspectedRun,
}: {
  reqId: string;
  runs: AgentRunRecord[];
  inspectedRun: AgentRunRecord;
}) {
  const language = useUiStore((s) => s.language);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const [subTab, setSubTab] = useState<InspectorTab>("trace");
  const [contextView, setContextView] = useState<ContextSubView>("handoff");

  const rawLog = useStreamStore((s) => s.liveRunLogs[inspectedRun.id] ?? "");
  const isLogHydrated = useStreamStore((s) => Boolean(s.logHydrated[inspectedRun.id]));
  const traceState = useStreamStore((s) => s.runTraces[inspectedRun.id]);

  const { data: ctxData, isLoading: ctxLoading } = useRunContextQuery(
    activeProjectId,
    reqId,
    inspectedRun.id,
    subTab === "context" || subTab === "usage",
  );
  const parentRun = inspectedRun.parentRunId ? runs.find((r) => r.id === inspectedRun.parentRunId) ?? null : null;
  const { data: parentCtxData } = useRunContextQuery(
    activeProjectId,
    reqId,
    parentRun?.id ?? null,
    subTab === "context" && Boolean(parentRun?.id) && contextView === "diff",
  );

  useEffect(() => {
    if (!isLogHydrated && (subTab === "trace" || subTab === "raw")) {
      void hydrateRunLog(reqId, inspectedRun.id, false);
    }
    if (!traceState?.hydrated && (subTab === "trace" || subTab === "usage")) {
      void hydrateRunTrace(reqId, inspectedRun.id, false);
    }
  }, [reqId, inspectedRun.id, subTab, isLogHydrated, traceState?.hydrated]);

  const turnPoints = useMemo(() => {
    const events = traceState?.events ?? [];
    const pts: Array<{ turnIndex: number; contextTokens: number }> = [];
    const compactions: Array<{ turnIndex: number; mode: string; reclaimedTokens?: number }> = [];
    for (const ev of events) {
      if (ev.type === "turn.end") {
        const ctx = ev.contextTokens ?? ev.usage?.inputTokens ?? 0;
        if (ctx > 0) pts.push({ turnIndex: ev.turnIndex, contextTokens: ctx });
      } else if (ev.type === "context.compaction") {
        compactions.push({ turnIndex: ev.turnIndex, mode: ev.mode, reclaimedTokens: ev.reclaimedTokens });
      }
    }
    return { pts, compactions };
  }, [traceState?.events]);

  const topTools = useMemo(() => {
    const events = traceState?.events ?? [];
    const starts = new Map<string, Extract<RunTraceEvent, { type: "tool.start" }>>();
    const rows: Array<{ callId: string; toolName: string; summary: string; durationMs: number; isError: boolean }> = [];
    for (const ev of events) {
      if (ev.type === "tool.start") {
        starts.set(ev.callId, ev);
      } else if (ev.type === "tool.end") {
        const s = starts.get(ev.callId);
        rows.push({
          callId: ev.callId,
          toolName: ev.toolName,
          summary: ev.summary || s?.summary || "",
          durationMs: ev.durationMs ?? (s ? Math.max(0, ev.ts - s.ts) : 0),
          isError: Boolean(ev.isError),
        });
      }
    }
    return rows.sort((a, b) => b.durationMs - a.durationMs).slice(0, 8);
  }, [traceState?.events]);

  const handoffDiffChunks = useMemo(() => {
    if (!ctxData?.context?.handoffMarkdown || !parentCtxData?.context?.handoffMarkdown) return null;
    return diffLines(parentCtxData.context.handoffMarkdown, ctxData.context.handoffMarkdown);
  }, [ctxData?.context?.handoffMarkdown, parentCtxData?.context?.handoffMarkdown]);

  const usage = inspectedRun.usage;
  const cost = inspectedRun.cost;

  return (
    <div className="card audit-inspector-card" data-testid="run-inspector-panel">
      <div className="card-head" style={{ flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <h3 style={{ margin: 0 }}>
            {t(language, "audit.inspectorTitle", { runId: inspectedRun.id })}
          </h3>
          <span className={`badge ${AGENT_RUN_TONE[inspectedRun.status]}`}>
            {formatAgentActionLabel(language, inspectedRun.action)} · {formatAgentStatusLabel(language, inspectedRun.status)}
          </span>
          <span className="muted xs">
            {inspectedRun.harness} / {inspectedRun.effectiveModel ?? inspectedRun.model}
          </span>
        </div>
        <div className="segmented" role="tablist">
          {(["trace", "context", "usage", "raw"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={subTab === tab}
              className={subTab === tab ? "active" : ""}
              data-testid={`inspector-tab-${tab}`}
              onClick={() => setSubTab(tab)}
            >
              {t(language, `audit.tab.${tab}` as MessageKey)}
            </button>
          ))}
        </div>
      </div>

      {subTab === "trace" && (
        <div className="audit-inspector-console" data-testid="inspector-pane-trace">
          <ConsoleOutput
            runId={inspectedRun.id}
            rawLog={rawLog}
            traceEvents={traceState?.events}
            hasTrace={traceState ? traceState.hasTrace : undefined}
            traceHydrated={Boolean(traceState?.hydrated)}
            isRunning={inspectedRun.status === "running"}
            emptyText={t(language, "drawer.waiting")}
          />
        </div>
      )}

      {subTab === "context" && (
        <div className="audit-context-pane" data-testid="inspector-pane-context">
          {ctxLoading ? (
            <div className="muted xs">{t(language, "common.loading")}</div>
          ) : !ctxData?.hasContext || !ctxData.context ? (
            <div className="callout info xs">{t(language, "audit.noContextSnapshot")}</div>
          ) : (
            <>
              <div className="audit-kv-grid">
                <div>
                  <span className="muted xs">{t(language, "audit.handoffMode")}</span>
                  <div className="xs"><strong>{handoffModeLabel(language, ctxData.context.handoffMode)}</strong></div>
                </div>
                <div>
                  <span className="muted xs">{t(language, "audit.dispatchReason")}</span>
                  <div className="xs"><strong>{ctxData.context.dispatchReason}</strong></div>
                </div>
                <div>
                  <span className="muted xs">{t(language, "audit.promptFootprint")}</span>
                  <div className="xs">
                    <strong>
                      ~{formatTokenCount(ctxData.context.promptEstTokens)} tok ({formatBytes(ctxData.context.promptBytes)})
                    </strong>
                  </div>
                </div>
                {ctxData.context.resumedSessionId && (
                  <div>
                    <span className="muted xs">{t(language, "audit.resumedSession")}</span>
                    <div className="xs"><code>{ctxData.context.resumedSessionId}</code></div>
                  </div>
                )}
              </div>

              {ctxData.context.routeCandidates.length > 0 && (
                <div className="audit-route-candidates">
                  <div className="muted xs" style={{ marginBottom: 4 }}>{t(language, "audit.routeCandidates")}</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {ctxData.context.routeCandidates.map((cand, idx) => {
                      const isPicked =
                        cand.harness === ctxData.context!.selectedTarget.harness &&
                        cand.model === ctxData.context!.selectedTarget.model;
                      return (
                        <span
                          key={`${cand.harness}-${cand.model}-${idx}`}
                          className={`badge xs ${isPicked ? "success" : ""}`}
                        >
                          {cand.harness}/{cand.model}
                          {cand.reasoningEffort ? ` (${cand.reasoningEffort})` : ""}
                          {!isPicked && cand.skippedReason ? ` · ${cand.skippedReason}` : ""}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

              <div style={{ marginTop: 10 }}>
                <div className="muted xs" style={{ marginBottom: 6 }}>{t(language, "audit.handoffComposition")}</div>
                <CompositionBar
                  sections={ctxData.context.sections}
                  totalBytes={ctxData.context.handoffTotalBytes}
                  budgetBytes={ctxData.context.handoffBudgetBytes}
                />
                <div className="audit-section-table">
                  {ctxData.context.sections.map((s) => (
                    <div key={s.key} className="audit-section-row xs">
                      <span>{s.label}</span>
                      <span className="muted">
                        ~{formatTokenCount(s.estTokens)} tok · {formatBytes(s.finalBytes)}
                        {s.truncated && (
                          <span className="badge warning xs" style={{ marginLeft: 6 }}>
                            {t(language, "audit.trimmedFrom", { raw: formatBytes(s.rawBytes) })}
                          </span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="audit-context-view-bar">
                <div className="segmented">
                  <button
                    type="button"
                    className={contextView === "handoff" ? "active" : ""}
                    onClick={() => setContextView("handoff")}
                  >
                    {t(language, "audit.viewHandoffMd")}
                  </button>
                  <button
                    type="button"
                    className={contextView === "prompt" ? "active" : ""}
                    onClick={() => setContextView("prompt")}
                  >
                    {t(language, "audit.viewFullPrompt")}
                  </button>
                  {parentRun && (
                    <button
                      type="button"
                      className={contextView === "diff" ? "active" : ""}
                      data-testid="handoff-diff-btn"
                      onClick={() => setContextView("diff")}
                    >
                      {t(language, "audit.viewHandoffDiff")}
                    </button>
                  )}
                </div>
              </div>

              {contextView === "handoff" && (
                <div className="audit-context-scroll" data-testid="context-handoff-md">
                  <MarkdownView markdown={ctxData.context.handoffMarkdown} />
                </div>
              )}
              {contextView === "prompt" && (
                <pre className="audit-context-pre" data-testid="context-full-prompt">
                  {ctxData.context.promptText}
                </pre>
              )}
              {contextView === "diff" && (
                <div className="audit-context-diff" data-testid="context-handoff-diff">
                  {!handoffDiffChunks ? (
                    <div className="muted xs">{t(language, "audit.noParentContextDiff")}</div>
                  ) : (
                    <pre className="audit-diff-pre">
                      {handoffDiffChunks.map((part, idx) => (
                        <span
                          key={idx}
                          className={part.added ? "diff-add" : part.removed ? "diff-del" : "diff-ctx"}
                        >
                          {part.value}
                        </span>
                      ))}
                    </pre>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {subTab === "usage" && (
        <div className="audit-usage-pane" data-testid="inspector-pane-usage">
          <div className="audit-metrics-grid">
            <div className="audit-metric-box">
              <div className="muted xs">{t(language, "audit.tokens")}</div>
              <div className="audit-metric-val">{formatTokenCount(usage?.totalTokens ?? 0)}</div>
              <div className="muted xs">
                in {formatTokenCount(usage?.inputTokens ?? 0)} · cacheRead {formatTokenCount(usage?.cacheReadTokens ?? 0)} · out{" "}
                {formatTokenCount(usage?.outputTokens ?? 0)}
                {usage?.reasoningTokens ? ` · reason ${formatTokenCount(usage.reasoningTokens)}` : ""}
              </div>
              {usage && usage.inputTokens > 0 && (
                <div className="xs" style={{ marginTop: 4 }}>
                  {t(language, "audit.cacheHitRate")}:{" "}
                  <strong>{formatPercent(usage.cacheReadTokens / usage.inputTokens)}</strong>
                </div>
              )}
            </div>

            <div className="audit-metric-box">
              <div className="muted xs">{t(language, "audit.dualCost")}</div>
              <div className="audit-metric-val">
                {formatUsd(cost?.apiCostUsd ?? 0)} <span className="muted xs">/ {t(language, "audit.equivShort")} {formatUsd(cost?.equivalentCostUsd ?? 0)}</span>
              </div>
              <div className="muted xs">
                {t(language, "audit.pool")}: <strong>{inspectedRun.quotaPool ?? cost?.quotaPool ?? "—"}</strong> ·{" "}
                {t(language, `insights.billing.${inspectedRun.billingMode ?? cost?.billingMode ?? "subscription"}` as MessageKey)} ·{" "}
                {cost?.costSource ?? "unknown"}
              </div>
            </div>

            <div className="audit-metric-box">
              <div className="muted xs">{t(language, "audit.timingSplit")}</div>
              <div className="audit-metric-val">{formatDurationHuman(inspectedRun.durationMs)}</div>
              <div className="muted xs">
                LLM {formatDurationHuman(inspectedRun.llmDurationMs ?? inspectedRun.durationMs)} · Tool{" "}
                {formatDurationHuman(inspectedRun.toolDurationMs ?? 0)}
                {inspectedRun.ttftMs !== undefined ? ` · TTFT ${formatDurationHuman(inspectedRun.ttftMs)}` : ""}
              </div>
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <div className="muted xs" style={{ marginBottom: 6 }}>{t(language, "audit.contextGrowthTitle")}</div>
            <ContextGrowthChart
              turns={turnPoints.pts}
              contextWindow={inspectedRun.contextWindow ?? 200_000}
              compactions={turnPoints.compactions}
              emptyText={t(language, "audit.noTurnMetrics")}
            />
          </div>

          {topTools.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="muted xs" style={{ marginBottom: 6 }}>{t(language, "audit.topToolsTitle")}</div>
              <div className="audit-section-table">
                {topTools.map((tool) => (
                  <div key={tool.callId} className="audit-section-row xs">
                    <span>
                      <strong>{tool.toolName}</strong>{" "}
                      <span className="muted">{tool.summary.slice(0, 72)}</span>
                    </span>
                    <span className={tool.isError ? "danger-text" : "muted"}>
                      {formatDurationHuman(tool.durationMs)}{tool.isError ? " (ERR)" : ""}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {subTab === "raw" && (
        <div className="audit-inspector-console" data-testid="inspector-pane-raw">
          <div className="muted xs" style={{ marginBottom: 6, display: "flex", gap: 12, flexWrap: "wrap" }}>
            <span>log: <code>{inspectedRun.logPath}</code></span>
            {inspectedRun.tracePath && <span>trace: <code>{inspectedRun.tracePath}</code></span>}
            {inspectedRun.contextPath && <span>context: <code>{inspectedRun.contextPath}</code></span>}
          </div>
          <ConsoleOutput
            runId={inspectedRun.id}
            rawLog={rawLog}
            isRunning={inspectedRun.status === "running"}
            defaultViewMode="raw"
          />
        </div>
      )}
    </div>
  );
}

function LiveRunsMerge({
  reqId,
  initialRuns,
  children,
}: {
  reqId: string;
  initialRuns: AgentRunRecord[];
  children: (runs: AgentRunRecord[]) => React.ReactNode;
}) {
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const activeRuns = useStreamStore((s) => s.activeRuns);
  const liveRunMetrics = useStreamStore((s) => s.liveRunMetrics);
  const { data: fetchedRuns } = useRequirementRunsQuery(activeProjectId, reqId, true);

  const mergedRuns = useMemo(() => {
    const byId = new Map<string, AgentRunRecord>();
    for (const r of initialRuns) byId.set(r.id, r);
    for (const r of fetchedRuns ?? []) byId.set(r.id, r);
    for (const r of Object.values(activeRuns)) {
      if (r.requirementId === reqId) byId.set(r.id, r);
    }
    const list = Array.from(byId.values()).map((r) => {
      const m = liveRunMetrics[r.id];
      return m ? { ...r, ...m } : r;
    });
    return list.sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));
  }, [initialRuns, fetchedRuns, activeRuns, liveRunMetrics, reqId]);

  return <>{children(mergedRuns)}</>;
}

function ExecutionAuditTabInner({
  d,
  runs,
  hasQueryClient,
}: {
  d: RequirementDetail;
  runs: AgentRunRecord[];
  hasQueryClient: boolean;
}) {
  const language = useUiStore((s) => s.language);
  const inspectedRunId = useUiStore((s) => s.inspectedRunId);
  const setInspectedRunId = useUiStore((s) => s.setInspectedRunId);
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>("all");

  const inspectedRun = useMemo(() => {
    if (runs.length === 0) return null;
    if (inspectedRunId) {
      const hit = runs.find((r) => r.id === inspectedRunId);
      if (hit) return hit;
    }
    return runs[0] ?? null;
  }, [runs, inspectedRunId]);

  const totals = useMemo(() => {
    let tokens = 0;
    let cacheRead = 0;
    let inputTokens = 0;
    let apiCost = 0;
    let equivCost = 0;
    let durationMs = 0;
    let toolCalls = 0;
    let toolErrors = 0;
    let compactions = 0;
    for (const r of runs) {
      tokens += r.usage?.totalTokens ?? 0;
      cacheRead += r.usage?.cacheReadTokens ?? 0;
      inputTokens += r.usage?.inputTokens ?? 0;
      apiCost += r.cost?.apiCostUsd ?? 0;
      equivCost += r.cost?.equivalentCostUsd ?? 0;
      durationMs += r.durationMs ?? 0;
      toolCalls += r.toolCallsCount ?? 0;
      toolErrors += r.toolErrorCount ?? 0;
      compactions += r.compactionCount ?? 0;
    }
    return {
      tokens,
      cacheHitRate: inputTokens > 0 ? cacheRead / inputTokens : 0,
      apiCost,
      equivCost,
      durationMs,
      toolCalls,
      toolErrors,
      compactions,
    };
  }, [runs]);

  const events = useMemo(() => {
    const rev = [...d.state.timeline].reverse();
    if (timelineFilter === "all") return rev;
    return rev.filter((ev) => timelineCategory(ev) === timelineFilter);
  }, [d.state.timeline, timelineFilter]);

  return (
    <>
      {runs.length > 0 && (
        <div className="audit-summary-strip" data-testid="req-audit-summary">
          <div className="audit-sum-pill">
            <Icon icon={Activity} size={14} />
            <span>{t(language, "audit.runsCount", { count: runs.length })}</span>
          </div>
          <div className="audit-sum-pill">
            <Icon icon={Cpu} size={14} />
            <span>
              {formatTokenCount(totals.tokens)} tok ({t(language, "audit.cacheShort")} {formatPercent(totals.cacheHitRate)})
            </span>
          </div>
          <div className="audit-sum-pill">
            <span>
              API {formatUsd(totals.apiCost)} · {t(language, "audit.equivShort")} {formatUsd(totals.equivCost)}
            </span>
          </div>
          <div className="audit-sum-pill">
            <Icon icon={Clock} size={14} />
            <span>{formatDurationHuman(totals.durationMs)}</span>
          </div>
          <div className="audit-sum-pill">
            <Icon icon={Wrench} size={14} />
            <span>
              {totals.toolCalls} tools{totals.toolErrors > 0 ? ` (${totals.toolErrors} err)` : ""}
            </span>
          </div>
          {totals.compactions > 0 && (
            <div className="audit-sum-pill">
              <Icon icon={Layers} size={14} />
              <span>{totals.compactions} compactions</span>
            </div>
          )}
        </div>
      )}

      {runs.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h3>{t(language, "timeline.runs")}</h3>
            <button className="btn xs" type="button" onClick={() => void openHandoff(d.state.id)}>
              <Icon icon={FileText} size={14} /> {t(language, "timeline.viewHandoff")}
            </button>
          </div>
          {runs.map((r) => {
            const selected = inspectedRun?.id === r.id;
            return (
              <div
                key={r.id}
                className={`timeline-item audit-run-row ${selected ? "is-selected" : ""}`}
                data-testid={`audit-run-row-${r.id}`}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span className={`badge ${AGENT_RUN_TONE[r.status]}`}>
                    <Icon
                      icon={
                        r.status === "running"
                          ? Loader2
                          : r.status === "succeeded"
                            ? Check
                            : r.status === "cancelled"
                              ? CircleOff
                              : X
                      }
                      size={14}
                      className={r.status === "running" ? "spin" : undefined}
                    />{" "}
                    {formatAgentActionLabel(language, r.action)} · {formatAgentStatusLabel(language, r.status)}
                  </span>
                  <strong style={{ fontSize: 13 }}>
                    {r.harness} / {r.model}
                  </strong>
                  {r.modelFallback && r.effectiveModel && (
                    <span className="badge warning xs">
                      {t(language, "timeline.actual", { model: r.effectiveModel })}
                    </span>
                  )}
                  {r.quotaPool && (
                    <span className="badge xs" title={r.billingMode}>
                      {r.quotaPool} · {r.billingMode ?? "subscription"}
                    </span>
                  )}
                  {r.handoffMode && (
                    <span className="muted xs" style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                      <Icon icon={GitBranch} size={14} />
                      {handoffModeLabel(language, r.handoffMode)}
                      {r.parentRunId && (
                        <>
                          <Icon icon={ArrowRight} size={14} />
                          <code>{r.parentRunId.slice(-6)}</code>
                        </>
                      )}
                    </span>
                  )}
                  <span className="muted xs">
                    {r.durationMs}ms{r.usage?.totalTokens ? ` · ${formatTokenCount(r.usage.totalTokens)} tok` : ""}
                    {r.cost?.equivalentCostUsd ? ` · ${formatUsd(r.cost.equivalentCostUsd)}` : ""}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  {hasQueryClient && (
                    <button
                      className={`btn xs ${selected ? "primary" : "ghost"}`}
                      type="button"
                      data-testid={`inspect-run-btn-${r.id}`}
                      onClick={() => setInspectedRunId(r.id)}
                    >
                      {t(language, "audit.inspectDetails")}
                    </button>
                  )}
                  <button
                    className="btn ghost xs"
                    type="button"
                    data-testid={`view-run-output-btn-${r.id}`}
                    onClick={() => void openRunConsole(d.state.id, r.id)}
                  >
                    <Icon icon={Terminal} size={14} /> {t(language, "timeline.viewOutput")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {hasQueryClient && inspectedRun && (
        <RunInspectorSection reqId={d.state.id} runs={runs} inspectedRun={inspectedRun} />
      )}

      <div className="card">
        <div className="card-head" style={{ flexWrap: "wrap", gap: 8 }}>
          <h3>{t(language, "timeline.title")}</h3>
          <div className="segmented">
            {(["all", "agent", "review", "verify", "system"] as const).map((f) => (
              <button
                key={f}
                type="button"
                className={timelineFilter === f ? "active" : ""}
                onClick={() => setTimelineFilter(f)}
              >
                {t(language, `audit.timelineFilter.${f}` as MessageKey)}
              </button>
            ))}
          </div>
        </div>
        {events.map((ev, i) => (
          <div key={`${ev.at}-${i}`} className="timeline-item">
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <strong style={{ fontSize: 13.5 }}>{ev.summary}</strong>
                {ev.runId && (
                  <button
                    type="button"
                    className="btn ghost xs"
                    onClick={() => {
                      setInspectedRunId(ev.runId!);
                      void openRunConsole(d.state.id, ev.runId!);
                    }}
                  >
                    <Icon icon={Terminal} size={14} /> {ev.runId.slice(-6)}
                  </button>
                )}
              </div>
              <span className="muted" style={{ fontSize: 12 }}>
                {formatDateTime(ev.at, language)}
              </span>
            </div>
            {ev.detail && (
              <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
                {ev.detail}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

export function TimelineRunsTab({ d }: { d: RequirementDetail }) {
  const hasQueryClient = Boolean(useContext(QueryClientContext));
  const staticRuns = useMemo(
    () => [...(d.state.agentRuns ?? [])].sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id)),
    [d.state.agentRuns],
  );

  if (!hasQueryClient) {
    return <ExecutionAuditTabInner d={d} runs={staticRuns} hasQueryClient={false} />;
  }

  return (
    <LiveRunsMerge reqId={d.state.id} initialRuns={d.state.agentRuns ?? []}>
      {(runs) => <ExecutionAuditTabInner d={d} runs={runs} hasQueryClient={true} />}
    </LiveRunsMerge>
  );
}
