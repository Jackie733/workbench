import * as fs from "node:fs";
import * as path from "node:path";
import {
  MAX_RUN_TRACE_BYTES,
  type AgentAction,
  type AgentRunRecord,
  type RunBillingMode,
  type RunCostSummary,
  type RunTokenUsage,
  type RunTraceEvent,
} from "../core/types.ts";
import { computeRunCost, type ResolvedModelPriceSpec } from "./pricing.ts";
import type { PartialTraceEvent } from "./stream_adapters.ts";

export interface TraceCollectorOptions {
  runId: string;
  action?: AgentAction;
  traceFilePath: string;
  startedAt: number;
  billingMode: RunBillingMode;
  quotaPool: string;
  modelSpec: ResolvedModelPriceSpec;
  onEvent?: (ev: RunTraceEvent) => void;
  onMetrics?: (metrics: Partial<AgentRunRecord>) => void;
  onWarning?: (line: string) => void;
}

const MAX_IN_MEMORY_EVENTS = 4000;
const METRICS_THROTTLE_MS = 500;

function emptyUsage(): RunTokenUsage {
  return {
    inputTokens: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

function addUsage(acc: RunTokenUsage, delta: RunTokenUsage): RunTokenUsage {
  const inputTokens = acc.inputTokens + delta.inputTokens;
  const uncachedInputTokens = acc.uncachedInputTokens + delta.uncachedInputTokens;
  const cacheReadTokens = acc.cacheReadTokens + delta.cacheReadTokens;
  const cacheWriteTokens = acc.cacheWriteTokens + delta.cacheWriteTokens;
  const outputTokens = acc.outputTokens + delta.outputTokens;
  const reasoningTokens = acc.reasoningTokens + delta.reasoningTokens;
  const totalTokens = inputTokens + outputTokens + reasoningTokens;
  return {
    inputTokens,
    uncachedInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
  };
}

type TraceInitOrHandoffOrEnd =
  | Omit<Extract<RunTraceEvent, { type: "run.init" }>, "seq" | "ts">
  | Omit<Extract<RunTraceEvent, { type: "handoff.snapshot" }>, "seq" | "ts">
  | Omit<Extract<RunTraceEvent, { type: "run.end" }>, "seq" | "ts">;

export type CollectorAppendInput = PartialTraceEvent | TraceInitOrHandoffOrEnd;

export class RunTraceCollector {
  private seq = 0;
  private traceBytesWritten = 0;
  private traceTruncated = false;
  private readonly memoryEvents: RunTraceEvent[] = [];

  private turnsCount = 0;
  private maxTurnIndexSeen = 0;
  private toolCallsCount = 0;
  private toolErrorCount = 0;
  private compactionCount = 0;
  private peakContextTokens = 0;
  private prevTurnContextTokens = 0;
  private sawExplicitCompactionInTurn = false;

  private turnUsageAcc: RunTokenUsage = emptyUsage();
  private turnReportedCostSum = 0;
  private hasTurnReportedCost = false;
  private authoritativeUsage: RunTokenUsage | undefined;
  private authoritativeCostUsd: number | undefined;
  private authoritativeTurnsCount: number | undefined;

  private ttftMs: number | undefined;
  private activeTools = new Set<string>();
  private toolBusyStartedAt: number | null = null;
  private accumulatedToolMs = 0;
  private lastMetricsEmitAt = 0;
  private hasWriteActivity = false;
  private warnedPureReadDrift = false;
  private warnedContextBloat = false;
  private readonly healthWarnings: string[] = [];

  constructor(private readonly opts: TraceCollectorOptions) {}

  private persistLine(ev: RunTraceEvent): void {
    try {
      const dir = path.dirname(this.opts.traceFilePath);
      if (fs.existsSync(dir)) {
        const line = `${JSON.stringify(ev)}\n`;
        this.traceBytesWritten += Buffer.byteLength(line, "utf8");
        fs.appendFileSync(this.opts.traceFilePath, line, "utf8");
      }
    } catch {
      // Trace persistence is best-effort during streaming and must never crash the executor.
    }
  }

  private pushEvent(ev: RunTraceEvent): void {
    this.memoryEvents.push(ev);
    if (this.memoryEvents.length > MAX_IN_MEMORY_EVENTS) {
      this.memoryEvents.shift();
    }
    this.persistLine(ev);
    this.opts.onEvent?.(ev);
  }

  private emitRawEvent(partial: CollectorAppendInput | { type: "trace.truncated"; maxBytes: number }, ts = Date.now()): RunTraceEvent {
    this.seq += 1;
    const full = { ...partial, seq: this.seq, ts } as RunTraceEvent;
    this.pushEvent(full);
    return full;
  }

  private maybeEmitMetrics(force = false, now = Date.now()): void {
    if (!this.opts.onMetrics) return;
    if (!force && now - this.lastMetricsEmitAt < METRICS_THROTTLE_MS) return;
    this.lastMetricsEmitAt = now;
    this.opts.onMetrics(this.snapshotMetrics(now));
  }

  setAuthoritativeTotals(totals: {
    usage?: RunTokenUsage;
    costUsd?: number;
    turnsCount?: number;
  }): void {
    if (totals.usage && totals.usage.totalTokens > 0) {
      this.authoritativeUsage = totals.usage;
    }
    if (typeof totals.costUsd === "number" && Number.isFinite(totals.costUsd) && totals.costUsd >= 0) {
      this.authoritativeCostUsd = totals.costUsd;
    }
    if (typeof totals.turnsCount === "number" && Number.isFinite(totals.turnsCount) && totals.turnsCount > 0) {
      this.authoritativeTurnsCount = Math.floor(totals.turnsCount);
    }
    this.maybeEmitMetrics(true);
  }

  append(input: CollectorAppendInput): void {
    const now = Date.now();

    // Update running statistical counters BEFORE truncation check so summary metrics stay 100% accurate.
    switch (input.type) {
      case "turn.start":
        this.maxTurnIndexSeen = Math.max(this.maxTurnIndexSeen, input.turnIndex);
        this.sawExplicitCompactionInTurn = false;
        break;
      case "turn.end":
        this.maxTurnIndexSeen = Math.max(this.maxTurnIndexSeen, input.turnIndex);
        this.turnsCount = Math.max(this.turnsCount + 1, this.maxTurnIndexSeen);
        if (input.usage) {
          this.turnUsageAcc = addUsage(this.turnUsageAcc, input.usage);
        }
        if (typeof input.costUsd === "number" && Number.isFinite(input.costUsd) && input.costUsd >= 0) {
          this.turnReportedCostSum += input.costUsd;
          this.hasTurnReportedCost = true;
        }
        if (typeof input.contextTokens === "number" && input.contextTokens > 0) {
          this.peakContextTokens = Math.max(this.peakContextTokens, input.contextTokens);
          if (
            this.prevTurnContextTokens > 8000 &&
            input.contextTokens < this.prevTurnContextTokens * 0.7 &&
            !this.sawExplicitCompactionInTurn
          ) {
            const reclaimedTokens = Math.max(0, this.prevTurnContextTokens - input.contextTokens);
            this.compactionCount += 1;
            this.emitRawEvent(
              {
                type: "context.compaction",
                turnIndex: input.turnIndex,
                mode: "inferred",
                beforeTokens: this.prevTurnContextTokens,
                afterTokens: input.contextTokens,
                reclaimedTokens,
                summary: `上下文占用由 ${this.prevTurnContextTokens} 降至 ${input.contextTokens}（推断压缩回收 ${reclaimedTokens} tokens）`,
              },
              now,
            );
          }
          this.prevTurnContextTokens = input.contextTokens;
          const bloatThreshold = Math.floor(this.opts.modelSpec.contextWindow * 0.85);
          if (bloatThreshold > 0 && input.contextTokens >= bloatThreshold && !this.warnedContextBloat) {
            this.warnedContextBloat = true;
            this.healthWarnings.push(`context_bloat:单轮上下文达到 ${input.contextTokens} tokens（窗口 85% 阈值 ${bloatThreshold}）`);
            this.opts.onWarning?.(
              `[workbench] ⚠️ 上下文接近窗口上限：单轮上下文已达 ${input.contextTokens} tokens（窗口 ${this.opts.modelSpec.contextWindow}），建议收敛并完成当前任务。\n`,
            );
          }
        }
        const effectiveTurns = Math.max(this.turnsCount, this.maxTurnIndexSeen);
        if (
          (this.opts.action === "implement" || this.opts.action === "fix") &&
          !this.hasWriteActivity &&
          effectiveTurns >= 15 &&
          !this.warnedPureReadDrift
        ) {
          this.warnedPureReadDrift = true;
          this.healthWarnings.push("pure_read_drift:连续15+轮未产生任何代码写操作");
          this.opts.onWarning?.(
            `[workbench] ⚠️ 探索漂移告警：已连续 ${effectiveTurns} 轮未产生任何代码修改，请收敛范围直接定位并修改目标文件。\n`,
          );
        }
        this.sawExplicitCompactionInTurn = false;
        break;
      case "thinking":
      case "assistant.message":
        if (this.ttftMs === undefined) {
          this.ttftMs = Math.max(0, now - this.opts.startedAt);
        }
        break;
      case "tool.start":
        if (this.ttftMs === undefined) {
          this.ttftMs = Math.max(0, now - this.opts.startedAt);
        }
        this.toolCallsCount += 1;
        if (
          input.category === "write" ||
          /^(edit|write|patch|apply_patch|multiedit|notebookedit|wb_propose)/i.test(input.toolName)
        ) {
          this.hasWriteActivity = true;
        }
        if (this.activeTools.size === 0) {
          this.toolBusyStartedAt = now;
        }
        this.activeTools.add(input.callId);
        break;
      case "tool.end":
        if (!this.activeTools.has(input.callId)) {
          // Adapters like opencode emit start+end back-to-back or only end when start was skipped.
          if (this.toolCallsCount === 0 || typeof input.durationMs === "number") {
            if (typeof input.durationMs === "number" && input.durationMs > 0 && this.activeTools.size === 0) {
              this.accumulatedToolMs += input.durationMs;
            }
          }
        } else {
          this.activeTools.delete(input.callId);
          if (this.activeTools.size === 0 && this.toolBusyStartedAt !== null) {
            const wallDelta = Math.max(0, now - this.toolBusyStartedAt);
            // Stream adapters like OpenCode emit tool.start and tool.end back-to-back with an authoritative durationMs.
            const effectiveDelta =
              typeof input.durationMs === "number" && input.durationMs > 0 && wallDelta < 5
                ? input.durationMs
                : wallDelta;
            this.accumulatedToolMs += effectiveDelta;
            this.toolBusyStartedAt = null;
          }
        }
        if (input.isError) {
          this.toolErrorCount += 1;
        }
        break;
      case "context.compaction":
        this.compactionCount += 1;
        this.sawExplicitCompactionInTurn = true;
        break;
      default:
        break;
    }

    const isLightweight =
      input.type === "run.init" ||
      input.type === "turn.start" ||
      input.type === "turn.end" ||
      input.type === "context.compaction" ||
      input.type === "run.error" ||
      input.type === "run.end";

    if (!isLightweight && this.traceBytesWritten >= MAX_RUN_TRACE_BYTES) {
      if (!this.traceTruncated) {
        this.traceTruncated = true;
        this.emitRawEvent({ type: "trace.truncated", maxBytes: MAX_RUN_TRACE_BYTES }, now);
      }
      this.maybeEmitMetrics(input.type === "tool.end", now);
      return;
    }

    this.emitRawEvent(input, now);
    this.maybeEmitMetrics(input.type === "turn.end" || input.type === "run.end", now);
  }

  private effectiveUsage(): RunTokenUsage {
    if (this.authoritativeUsage && this.authoritativeUsage.totalTokens > 0) {
      return this.authoritativeUsage;
    }
    return this.turnUsageAcc;
  }

  private effectiveCost(usage: RunTokenUsage): RunCostSummary {
    const reported =
      this.authoritativeCostUsd !== undefined
        ? this.authoritativeCostUsd
        : this.hasTurnReportedCost
          ? this.turnReportedCostSum
          : undefined;
    return computeRunCost(usage, this.opts.modelSpec, this.opts.billingMode, this.opts.quotaPool, reported);
  }

  private currentToolDurationMs(now = Date.now(), wallDurationMs = Math.max(0, now - this.opts.startedAt)): number {
    const inFlight = this.toolBusyStartedAt !== null ? Math.max(0, now - this.toolBusyStartedAt) : 0;
    return Math.min(wallDurationMs, Math.round(this.accumulatedToolMs + inFlight));
  }

  snapshotMetrics(now = Date.now()): Partial<AgentRunRecord> {
    const usage = this.effectiveUsage();
    const cost = this.effectiveCost(usage);
    const durationMs = Math.max(0, now - this.opts.startedAt);
    const toolDurationMs = this.currentToolDurationMs(now, durationMs);
    const llmDurationMs = Math.max(0, durationMs - toolDurationMs);
    const turnsCount = Math.max(this.turnsCount, this.maxTurnIndexSeen, this.authoritativeTurnsCount ?? 0);

    return {
      quotaPool: this.opts.quotaPool,
      billingMode: this.opts.billingMode,
      ...(usage.totalTokens > 0 ? { usage } : {}),
      cost,
      turnsCount,
      toolCallsCount: this.toolCallsCount,
      toolErrorCount: this.toolErrorCount,
      compactionCount: this.compactionCount,
      ...(this.peakContextTokens > 0 ? { peakContextTokens: this.peakContextTokens } : {}),
      contextWindow: this.opts.modelSpec.contextWindow,
      durationMs,
      llmDurationMs,
      toolDurationMs,
      ...(this.ttftMs !== undefined ? { ttftMs: this.ttftMs } : {}),
      ...(this.traceTruncated ? { traceTruncated: true } : {}),
      ...(this.healthWarnings.length > 0 ? { healthWarnings: [...this.healthWarnings] } : {}),
    };
  }

  finalizeRun(input: {
    status: "succeeded" | "failed" | "cancelled";
    exitCode: number | null;
    durationMs: number;
    specChanged?: boolean;
    codeChanged?: boolean;
    errorSummary?: string;
  }): {
    usage?: RunTokenUsage;
    cost: RunCostSummary;
    turnsCount: number;
    toolCallsCount: number;
    toolErrorCount: number;
    compactionCount: number;
    peakContextTokens?: number;
    contextWindow: number;
    llmDurationMs: number;
    toolDurationMs: number;
    ttftMs?: number;
    traceTruncated: boolean;
    healthWarnings?: string[];
  } {
    if (this.toolBusyStartedAt !== null) {
      this.accumulatedToolMs += Math.max(0, Date.now() - this.toolBusyStartedAt);
      this.toolBusyStartedAt = null;
      this.activeTools.clear();
    }

    const usage = this.effectiveUsage();
    const cost = this.effectiveCost(usage);
    const toolDurationMs = Math.min(input.durationMs, Math.round(this.accumulatedToolMs));
    const llmDurationMs = Math.max(0, input.durationMs - toolDurationMs);
    const turnsCount = Math.max(this.turnsCount, this.maxTurnIndexSeen, this.authoritativeTurnsCount ?? 0);

    this.append({
      type: "run.end",
      status: input.status,
      exitCode: input.exitCode,
      durationMs: input.durationMs,
      llmDurationMs,
      toolDurationMs,
      ...(this.ttftMs !== undefined ? { ttftMs: this.ttftMs } : {}),
      turnsCount,
      toolCallsCount: this.toolCallsCount,
      toolErrorCount: this.toolErrorCount,
      compactionCount: this.compactionCount,
      ...(this.peakContextTokens > 0 ? { peakContextTokens: this.peakContextTokens } : {}),
      contextWindow: this.opts.modelSpec.contextWindow,
      ...(usage.totalTokens > 0 ? { usage } : {}),
      cost,
      ...(input.specChanged !== undefined ? { specChanged: input.specChanged } : {}),
      ...(input.codeChanged !== undefined ? { codeChanged: input.codeChanged } : {}),
      ...(input.errorSummary ? { errorSummary: input.errorSummary } : {}),
    });

    return {
      ...(usage.totalTokens > 0 ? { usage } : {}),
      cost,
      turnsCount,
      toolCallsCount: this.toolCallsCount,
      toolErrorCount: this.toolErrorCount,
      compactionCount: this.compactionCount,
      ...(this.peakContextTokens > 0 ? { peakContextTokens: this.peakContextTokens } : {}),
      contextWindow: this.opts.modelSpec.contextWindow,
      llmDurationMs,
      toolDurationMs,
      ...(this.ttftMs !== undefined ? { ttftMs: this.ttftMs } : {}),
      traceTruncated: this.traceTruncated,
      ...(this.healthWarnings.length > 0 ? { healthWarnings: [...this.healthWarnings] } : {}),
    };
  }

  getEvents(afterSeq = 0, limit = 2000): {
    events: RunTraceEvent[];
    nextSeq: number;
    totalEvents: number;
    hasMore: boolean;
  } {
    const earliestInMem = this.memoryEvents[0]?.seq ?? 0;
    if (this.memoryEvents.length > 0 && afterSeq >= earliestInMem - 1) {
      const filtered = this.memoryEvents.filter((ev) => ev.seq > afterSeq);
      const hasMore = filtered.length > limit;
      const events = hasMore ? filtered.slice(0, limit) : filtered;
      const nextSeq = events.length > 0 ? events[events.length - 1]!.seq : Math.max(afterSeq, this.seq);
      return { events, nextSeq, totalEvents: this.seq, hasMore };
    }

    // Fallback to disk if memory window was exceeded.
    if (fs.existsSync(this.opts.traceFilePath)) {
      try {
        const raw = fs.readFileSync(this.opts.traceFilePath, "utf8");
        const parsed: RunTraceEvent[] = [];
        for (const line of raw.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed) as RunTraceEvent;
            if (obj && typeof obj.seq === "number" && obj.seq > afterSeq) {
              parsed.push(obj);
            }
          } catch {
            // Skip incomplete line.
          }
        }
        const hasMore = parsed.length > limit;
        const events = hasMore ? parsed.slice(0, limit) : parsed;
        const nextSeq = events.length > 0 ? events[events.length - 1]!.seq : Math.max(afterSeq, this.seq);
        return { events, nextSeq, totalEvents: this.seq, hasMore };
      } catch {
        // Fall through to in-memory buffer.
      }
    }

    const filtered = this.memoryEvents.filter((ev) => ev.seq > afterSeq);
    const hasMore = filtered.length > limit;
    const events = hasMore ? filtered.slice(0, limit) : filtered;
    const nextSeq = events.length > 0 ? events[events.length - 1]!.seq : Math.max(afterSeq, this.seq);
    return { events, nextSeq, totalEvents: this.seq, hasMore };
  }
}
