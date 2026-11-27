import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { acquireCodeRootLock, type CodeRootLockLease } from "../core/code_lock.ts";
import { discoverProjectContext } from "../core/context.ts";
import {
  addDiscussion,
  finishAgentRun,
  getAgentRunContext,
  getProjectStatus,
  getRequirement,
  listRequirements,
  recordDesignReviewReport,
  recordReviewReport,
  resolveDiscussions,
  saveAgentRunContext,
  setRequirementNeedsHuman,
  startAgentRun,
} from "../core/engine.ts";
import { WorkbenchError } from "../core/errors.ts";
import { canonicalRoot, isProcessAlive, readBoundedText, resolveSafePath } from "../core/fs.ts";
import {
  extractMergeConflictContext,
  hasMergeCommitsBetween,
  isAncestorCommit,
  observeGitSnapshot,
  observeIncrementalDiff,
} from "../core/git.ts";
import { isHeavyVerificationCommand } from "../core/runner.ts";
import { resolveCodeRoot } from "../core/sandbox.ts";
import { screenshotStagingDir } from "../core/screenshots.ts";
import {
  MAX_RUN_LOG_BYTES,
  WORKBENCH_DIR,
  type AgentAction,
  type AgentRunRecord,
  type OutputLanguage,
  type RequirementDetail,
  type RunBillingMode,
  type RunContextSnapshot,
  type RunDispatchReason,
  type RunHandoffMode,
  type RunTokenUsage,
  type RunTraceEvent,
} from "../core/types.ts";
import { clipHeadTailUtf8, sanitizeOutput } from "../core/validate.ts";
import { evaluateApproval } from "../core/validity.ts";
import {
  commitSandboxWipCheckpoint,
  inspectSandboxDrift,
  prepareSandboxConflictResolution,
  reconcileSandboxBaseline,
  syncCleanSandboxBeforeFirstImplement,
  syncRequirementMirrorToSandbox,
} from "../core/worktree.ts";
import { discoverHarnesses, discoverHarnessesQuick, getLocalCatalogFingerprint } from "./discovery.ts";
import { synthesizeHandoffPacket, type ConflictHandoffContext, type IncrementalReviewContext } from "./handoff.ts";
import {
  buildHarnessCommand,
  buildHarnessIsolationEnv,
  buildOpencodeNonInteractiveConfig,
  ensureWbShim,
  HARNESS_ISOLATION_MATRIX,
  isSessionExpiredError,
  NON_FATAL_FORM_CANCEL_RE,
  resolveRunTimeouts,
  type BuiltCommand,
  type CustomCommandBuilder,
  type TimeoutReason,
} from "./harness_cmd.ts";
import { appendRunLedger, type RunLedgerEntry } from "./ledger.ts";
import {
  normalizeReviewVerdictForManualCriteria,
  parseReviewOutput,
  runCodingPostGate,
  syncDesignRunResult,
} from "./post_run.ts";
import { estimateTokens, resolveModelSpec, resolveQuotaPool } from "./pricing.ts";
import { buildExecutionPrompt } from "./prompt.ts";
import { readHubConfig } from "./registry.ts";
import {
  detectModelUnavailableError,
  detectRateLimitOrQuotaError,
  normalizeRoutingConfig,
  resolveRouteCandidates,
} from "./routing.ts";
import { driveCodexAppServerProcess } from "./codex_app_server.ts";
import { driveOpencodeAcpProcess } from "./opencode_acp.ts";
import { createHarnessStreamAdapter, isUnsupportedJsonFlagError, stripCliNoise } from "./stream_adapters.ts";
import { isModelCoolingDown, recordModelRunOutcome } from "./telemetry.ts";
import { RunTraceCollector } from "./trace_collector.ts";
import type { HarnessId, HarnessInfo, HubObservabilityConfig, ModelTarget, RoutingConfig } from "./types.ts";

export { buildExecutionPrompt } from "./prompt.ts";
export {
  buildHarnessCommand,
  buildHarnessIsolationEnv,
  buildOpencodeNonInteractiveConfig,
  HARNESS_ISOLATION_MATRIX,
  resolveRunTimeouts,
  type BuiltCommand,
  type CustomCommandBuilder,
  type TimeoutReason,
} from "./harness_cmd.ts";

export interface RunExecutorEvent {
  type:
    | "agent.run.started"
    | "agent.run.output"
    | "agent.run.delta"
    | "agent.run.event"
    | "agent.run.metrics"
    | "agent.run.finished"
    | "workbench.updated"
    | "hub.updated";
  root: string;
  requirementId: string;
  runId: string;
  reason?: string;
  action?: AgentAction;
  harness?: string;
  model?: string;
  reasoningEffort?: ModelTarget["reasoningEffort"];
  quotaPool?: string;
  billingMode?: RunBillingMode;
  dispatchReason?: RunDispatchReason;
  handoffMode?: RunHandoffMode;
  parentRunId?: string;
  contextWindow?: number;
  tracePath?: string;
  contextPath?: string;
  effectiveModel?: string;
  modelFallback?: boolean;
  chunk?: string;
  channel?: "text" | "thinking";
  delta?: string;
  event?: RunTraceEvent;
  metrics?: Partial<AgentRunRecord>;
  status?: AgentRunRecord["status"];
  rateLimited?: boolean;
  errorSummary?: string;
  exitCode?: number | null;
  durationMs?: number;
  at: number;
}

export interface StartRunInput {
  root: string;
  requirementId: string;
  action: AgentAction;
  harness?: string;
  model?: string;
  reasoningEffort?: ModelTarget["reasoningEffort"];
  message?: string;
  anchor?: string;
  anchorIds?: string[];
  adoptDiscussionId?: string;
  mode?: "ask" | "refine";
  useFallback?: boolean;
  autoFallbackAttempt?: number;
  failedTargets?: string[];
  failedQuotaPools?: string[];
  autoHealAttempt?: number;
  /** Tracks the bounded 1-round automatic `block -> fix -> verify -> re-review` cycle (0 or 1). */
  reviewFixCycle?: number;
  forcePlainText?: boolean;
  disableRpcStdio?: boolean;
  forceFreshSession?: boolean;
  isInternalRetry?: boolean;
  reviewFormatRescue?: { sessionId: string; harness: HarnessId; model: string; reasoningEffort?: ModelTarget["reasoningEffort"] };
  dispatchReasonOverride?: RunDispatchReason;
  isAutoReview?: boolean;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  resolveConflict?: boolean;
}

interface ActiveJob {
  runId: string;
  root: string;
  requirementId: string;
  action: AgentAction;
  target: ModelTarget;
  effectiveModel?: string;
  modelFallback?: boolean;
  quotaPool: string;
  billingMode: RunBillingMode;
  dispatchReason: RunDispatchReason;
  handoffMode: RunHandoffMode;
  parentRunId?: string;
  resumedSessionId?: string;
  contextWindow: number;
  tracePath: string;
  contextPath: string;
  child: ChildProcess;
  startedAt: number;
  cancelled: boolean;
  timedOut: boolean;
  timeoutReason: TimeoutReason | null;
  killTimer?: ReturnType<typeof setTimeout>;
  lockLease?: CodeRootLockLease;
  onCancel?: () => void;
}

const ORPHAN_LEGACY_GRACE_MS = 5_000;
const MAX_AUTO_HEAL_ATTEMPTS = 2;
const MAX_AUTO_FALLBACK_ATTEMPTS = 3;
const MAX_RESUME_CONTEXT_TOKENS = 100_000;
const globalActiveRunIds = new Set<string>();

function checkAutoLoopBudget(
  detail: RequirementDetail,
  now = Date.now(),
): { exceeded: boolean; reason?: string } {
  const defaultBudgetMs = detail.state.tier === "sota" ? 45 * 60_000 : 30 * 60_000;
  const rawBudget = Number(process.env.WORKBENCH_AUTO_LOOP_BUDGET_MS ?? "");
  const budgetMs = Number.isFinite(rawBudget) && rawBudget > 0 ? Math.floor(rawBudget) : defaultBudgetMs;

  const rawMaxHeavy = Number(process.env.WORKBENCH_AUTO_LOOP_MAX_HEAVY_VERIFIES ?? "");
  const maxHeavyVerifies = Number.isFinite(rawMaxHeavy) && rawMaxHeavy > 0 ? Math.floor(rawMaxHeavy) : 3;

  const runs = detail.state.agentRuns ?? [];
  let anchorAt = 0;
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i]!;
    if (
      (r.action === "implement" || r.action === "fix") &&
      (!r.dispatchReason ||
        r.dispatchReason === "user" ||
        r.dispatchReason === "sota_escalate" ||
        r.dispatchReason === "manual_fallback" ||
        r.dispatchReason === "route_primary")
    ) {
      anchorAt = r.startedAt;
      break;
    }
  }
  if (!anchorAt) {
    anchorAt = detail.state.approval?.approvedAt ?? 0;
  }
  if (!anchorAt) return { exceeded: false };

  const elapsedMs = now - anchorAt;
  if (elapsedMs > budgetMs) {
    const elapsedMin = Math.max(1, Math.round(elapsedMs / 60_000));
    const budgetMin = Math.max(1, Math.round(budgetMs / 60_000));
    return {
      exceeded: true,
      reason: `自动闭环已持续 ${elapsedMin} 分钟（超过上限 ${budgetMin} 分钟），已自动熔断等待人工确认`,
    };
  }

  const heavyCount = detail.state.verifications.filter(
    (v) => v.startedAt >= anchorAt && isHeavyVerificationCommand(v.command),
  ).length;
  if (heavyCount >= maxHeavyVerifies) {
    return {
      exceeded: true,
      reason: `本轮自动闭环全量验证次数已达上限（${heavyCount}/${maxHeavyVerifies} 次），已自动熔断等待人工确认`,
    };
  }
  return { exceeded: false };
}

function isHealthyForNativeResume(candidate: AgentRunRecord | null | undefined): boolean {
  if (!candidate || !candidate.nativeSessionId) return false;
  if (candidate.status === "cancelled" || candidate.rateLimited) return false;
  if (candidate.errorSummary?.includes("模型不可用")) return false;
  if (typeof candidate.peakContextTokens === "number" && candidate.peakContextTokens >= MAX_RESUME_CONTEXT_TOKENS) {
    return false;
  }
  return true;
}

export type TelemetryOutcomeInput = Parameters<typeof recordModelRunOutcome>[0];

export class HubExecutor {
  private readonly activeJobs = new Map<string, ActiveJob>();
  private readonly runLogs = new Map<string, string>();
  private readonly traceCollectors = new Map<string, RunTraceCollector>();
  private readonly plainTextFallbackHarnesses = new Set<HarnessId>();
  private readonly rpcFallbackHarnesses = new Set<HarnessId>();
  private readonly listeners = new Set<(ev: RunExecutorEvent) => void>();
  private readonly cliEntryPath: string;
  private readonly commandBuilder?: CustomCommandBuilder;
  private readonly getHubPreferences?: () => {
    outputLanguage?: OutputLanguage;
    observability?: HubObservabilityConfig;
  };
  private readonly onTelemetryOutcome?: (outcome: TelemetryOutcomeInput) => void;
  private readonly onLedgerEntry?: (entry: RunLedgerEntry) => void;
  private readonly nodeId?: string;
  private readonly hasCustomInitialHarnesses: boolean;
  private readonly discoverQuickFn: () => HarnessInfo[];
  private readonly discoverFullFn: (signal?: AbortSignal) => Promise<HarnessInfo[]>;
  private cachedHarnesses: HarnessInfo[] | null = null;
  private lastFullRefreshAt = 0;
  private cachedCatalogFingerprint = "";
  private inFlightRefresh: Promise<HarnessInfo[]> | null = null;
  private refreshAbortController: AbortController | null = null;

  constructor(options: {
    cliEntryPath?: string;
    commandBuilder?: CustomCommandBuilder;
    initialHarnesses?: HarnessInfo[];
    discoverQuick?: () => HarnessInfo[];
    discoverFull?: (signal?: AbortSignal) => Promise<HarnessInfo[]>;
    getHubPreferences?: () => {
      outputLanguage?: OutputLanguage;
      observability?: HubObservabilityConfig;
    };
    onTelemetryOutcome?: (outcome: TelemetryOutcomeInput) => void;
    onLedgerEntry?: (entry: RunLedgerEntry) => void;
    nodeId?: string;
  } = {}) {
    this.cliEntryPath = options.cliEntryPath ?? path.resolve(import.meta.dir, "../cli/index.ts");
    this.commandBuilder = options.commandBuilder;
    this.discoverQuickFn = options.discoverQuick ?? (() => discoverHarnessesQuick());
    this.discoverFullFn = options.discoverFull ?? ((signal) => discoverHarnesses({ signal }));
    this.getHubPreferences = options.getHubPreferences;
    this.onTelemetryOutcome = options.onTelemetryOutcome;
    this.onLedgerEntry = options.onLedgerEntry;
    this.nodeId = options.nodeId;
    this.hasCustomInitialHarnesses = Boolean(options.initialHarnesses);
    if (options.initialHarnesses) {
      this.cachedHarnesses = options.initialHarnesses;
      this.lastFullRefreshAt = Date.now();
    }
  }

  subscribe(fn: (ev: RunExecutorEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(ev: RunExecutorEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch {
        // Ignore subscriber failures.
      }
    }
  }

  private harnessesSignature(list: HarnessInfo[] | null): string {
    if (!list) return "";
    return list
      .map(
        (h) =>
          `${h.id}:${h.installed}:${h.defaultModel ?? ""}:${h.note ?? ""}:${h.models
            .map(
              (m) =>
                `${m.id}@${m.source}@${m.tier}@${m.label ?? ""}@${m.defaultEffort ?? ""}@${m.supportedEfforts?.join(",") ?? ""}`,
            )
            .join("|")}`,
      )
      .join(";");
  }

  private runFullHarnessRefresh(): Promise<HarnessInfo[]> {
    if (this.inFlightRefresh) return this.inFlightRefresh;
    const prevSig = this.harnessesSignature(this.cachedHarnesses);
    const ac = new AbortController();
    this.refreshAbortController = ac;
    this.inFlightRefresh = this.discoverFullFn(ac.signal)
      .then((full) => {
        if (ac.signal.aborted) {
          return this.cachedHarnesses ?? full;
        }
        const now = Date.now();
        this.cachedHarnesses = full;
        this.lastFullRefreshAt = now;
        this.cachedCatalogFingerprint = getLocalCatalogFingerprint();
        if (this.harnessesSignature(full) !== prevSig) {
          this.emit({
            type: "hub.updated",
            reason: "harnesses.refreshed",
            root: "",
            requirementId: "",
            runId: "",
            at: now,
          });
        }
        return full;
      })
      .finally(() => {
        if (this.refreshAbortController === ac) {
          this.refreshAbortController = null;
        }
        this.inFlightRefresh = null;
      });
    return this.inFlightRefresh;
  }

  async getHarnesses(forceRefresh = false, quickOnly = false): Promise<HarnessInfo[]> {
    const HARNESS_REFRESH_TTL_MS = 30 * 60_000;
    if (forceRefresh) {
      return this.runFullHarnessRefresh();
    }
    if (!this.cachedHarnesses) {
      this.cachedHarnesses = this.discoverQuickFn();
      this.cachedCatalogFingerprint = getLocalCatalogFingerprint();
      if (!quickOnly && !this.hasCustomInitialHarnesses) {
        void this.runFullHarnessRefresh().catch(() => {});
      }
      return this.cachedHarnesses;
    }
    if (!quickOnly && !this.hasCustomInitialHarnesses) {
      const currentFp = getLocalCatalogFingerprint();
      const expired =
        this.lastFullRefreshAt === 0 || Date.now() - this.lastFullRefreshAt > HARNESS_REFRESH_TTL_MS;
      if (expired || currentFp !== this.cachedCatalogFingerprint) {
        void this.runFullHarnessRefresh().catch(() => {});
      }
    }
    return this.cachedHarnesses;
  }

  /**
   * Strict project-scoped routing resolution (Zero Global Fallback).
   * Runtime reads ONLY `.workbench/project.json`'s `routing` field.
   */
  private resolveProjectRouting(projectRoot: string): RoutingConfig {
    const status = getProjectStatus(projectRoot);
    if (!status.initialized || !status.project) {
      throw new WorkbenchError("not_initialized", "项目尚未初始化 .workbench/，请先执行初始化");
    }
    if (!status.project.routing) {
      throw new WorkbenchError(
        "invalid_input",
        "项目尚未配置模型路由（.workbench/project.json 缺少 routing），请在项目路由设置中保存配置",
      );
    }
    return normalizeRoutingConfig(status.project.routing);
  }

  getActiveRuns(root?: string): Array<AgentRunRecord & { requirementId: string; root?: string }> {
    const out: Array<AgentRunRecord & { requirementId: string; root?: string }> = [];
    for (const job of this.activeJobs.values()) {
      if (root && job.root !== root) continue;
      const liveMetrics = this.traceCollectors.get(job.runId)?.snapshotMetrics();
      out.push({
        id: job.runId,
        requirementId: job.requirementId,
        root: job.root,
        action: job.action,
        harness: job.target.harness,
        model: job.target.model,
        ...(job.effectiveModel ? { effectiveModel: job.effectiveModel } : {}),
        ...(job.modelFallback ? { modelFallback: true } : {}),
        ...(job.target.reasoningEffort ? { reasoningEffort: job.target.reasoningEffort } : {}),
        quotaPool: job.quotaPool,
        billingMode: job.billingMode,
        dispatchReason: job.dispatchReason,
        handoffMode: job.handoffMode,
        ...(job.parentRunId ? { parentRunId: job.parentRunId } : {}),
        contextWindow: job.contextWindow,
        tracePath: job.tracePath,
        contextPath: job.contextPath,
        ...(liveMetrics ?? {}),
        status: "running",
        startedAt: job.startedAt,
        endedAt: null,
        exitCode: null,
        durationMs: Date.now() - job.startedAt,
        logPath: `runs/run-${job.runId}.log`,
      });
    }
    return out;
  }

  getLiveLog(runId: string): string | null {
    return this.runLogs.get(runId) ?? null;
  }

  getLiveTrace(
    runId: string,
    afterSeq = 0,
    limit = 2000,
  ): { events: RunTraceEvent[]; nextSeq: number; totalEvents: number; hasMore: boolean } | null {
    const collector = this.traceCollectors.get(runId);
    if (!collector) return null;
    return collector.getEvents(afterSeq, limit);
  }

  async startRun(input: StartRunInput): Promise<{ run: AgentRunRecord; detail: RequirementDetail; target: ModelTarget }> {
    const base = canonicalRoot(input.root);
    const id = input.requirementId;

    const isAskTrack = input.action === "ask";
    for (const job of this.activeJobs.values()) {
      if (job.root !== base || job.requirementId !== id) continue;
      // 双轨并发：只读探讨（ask）与主任务执行（design/implement/fix/review）互不互斥，仅同轨道内串行。
      if ((job.action === "ask") === isAskTrack) {
        throw new WorkbenchError(
          "revision_conflict",
          isAskTrack
            ? `${id} 当前已有正在进行的提问探讨（${job.target.harness}/${job.target.model}），请等待回复完成或先停止`
            : `${id} 当前已有正在执行的 Agent 任务（${job.target.harness}/${job.target.model}），请等待完成或先终止`,
        );
      }
    }

    const prefs = this.getHubPreferences?.();
    const harnesses = await this.getHarnesses(false);
    const activeRouting = this.resolveProjectRouting(base);
    const cfg = prefs?.outputLanguage !== undefined && prefs?.observability !== undefined ? null : readHubConfig();
    const hubOutputLanguage = prefs?.outputLanguage ?? cfg?.outputLanguage;
    const observability = prefs?.observability ?? cfg?.observability;

    const codeRoot = resolveCodeRoot(base, id);
    // ask 属于无副作用的轻量只读探讨，不抢占 codeRoot 读写锁，允许在编码/验证等任务运行期间并发提问。
    const lockMode =
      input.action === "implement" || input.action === "fix"
        ? ("write" as const)
        : input.action === "review"
          ? ("read" as const)
          : null;
    const codeRootLockLease = lockMode
      ? acquireCodeRootLock(codeRoot, lockMode, { kind: input.action, requirementId: id })
      : undefined;

    try {
      let currentDetail = getRequirement(base, id, {
        currentCodeSnapshotHash: (await observeGitSnapshot(codeRoot))?.fingerprint ?? null,
      });
      if (input.action === "fix" && input.resolveConflict && currentDetail.state.stage === "done") {
        currentDetail = await prepareSandboxConflictResolution(base, id);
      }
      if (input.action === "implement" || input.action === "fix") {
        const stage = currentDetail.state.stage;
        if (stage !== "coding") {
          throw new WorkbenchError(
            "approval_required",
            `${id} 当前阶段（${stage}）不能执行 ${input.action}；必须先由人类批准方案或启用快速通道进入编码阶段`,
          );
        }
        const approval = evaluateApproval(currentDetail.state);
        if (!approval.valid) {
          throw new WorkbenchError(
            "approval_required",
            `${id} 尚未获得有效方案批准：${approval.reason ?? "请先由人类批准方案"}`,
          );
        }
      }

      // FLOW §2.1: before first `implement` on a clean isolated sandbox with zero ahead commits, auto fast-forward to latest main.
      const preRunsList = currentDetail.state.agentRuns ?? [];
      if (
        input.action === "implement" &&
        codeRoot !== base &&
        !preRunsList.some((r) => r.action === "implement" || r.action === "fix")
      ) {
        const synced = await syncCleanSandboxBeforeFirstImplement(base, id, {
          parentLeaseId: codeRootLockLease?.id,
        }).catch(() => ({ synced: false }));
        if (synced.synced) {
          currentDetail = getRequirement(base, id, {
            currentCodeSnapshotHash: (await observeGitSnapshot(codeRoot))?.fingerprint ?? null,
          });
        }
      }

      const tier = currentDetail.state.tier;
      const runsList = currentDetail.state.agentRuns ?? [];
      const prevRun = runsList.slice(-1)[0] ?? null;

    let sessionAffinityApplied = false;
    let override: Partial<ModelTarget> | null = input.reviewFormatRescue
      ? {
          harness: input.reviewFormatRescue.harness,
          model: input.reviewFormatRescue.model,
          reasoningEffort: input.reviewFormatRescue.reasoningEffort,
        }
      : input.harness && input.model
        ? { harness: input.harness as ModelTarget["harness"], model: input.model, reasoningEffort: input.reasoningEffort }
        : input.reasoningEffort
          ? { reasoningEffort: input.reasoningEffort }
          : null;

    const tierCandidates = resolveRouteCandidates(activeRouting, harnesses, input.action, tier);
    const tierCandidateKeys = new Set(tierCandidates.map((c) => `${c.harness}::${c.model}`));

    // Session affinity: keep design/implement/fix single-threaded on the active tier's most recent lead runner
    // (never locking back onto a standard model after the user escalated to SOTA tier).
    if (
      !override &&
      !input.useFallback &&
      !input.forceFreshSession &&
      input.dispatchReasonOverride !== "sota_escalate" &&
      (input.action === "implement" || input.action === "fix")
    ) {
      const lastLeadRun = [...runsList]
        .reverse()
        .find(
          (r) =>
            (r.action === "implement" || r.action === "fix" || r.action === "design") &&
            r.status !== "cancelled" &&
            !r.rateLimited &&
            !r.errorSummary?.includes("模型不可用") &&
            tierCandidateKeys.has(`${r.harness}::${r.model}`),
        );
      const isRunnable =
        lastLeadRun &&
        (harnesses.some((h) => h.id === lastLeadRun.harness && h.installed) || Boolean(this.commandBuilder));
      if (lastLeadRun && isRunnable && !isModelCoolingDown(lastLeadRun.harness, lastLeadRun.model)) {
        sessionAffinityApplied = true;
        override = {
          harness: lastLeadRun.harness as HarnessId,
          model: lastLeadRun.model,
          ...(input.reasoningEffort
            ? { reasoningEffort: input.reasoningEffort }
            : lastLeadRun.reasoningEffort
              ? { reasoningEffort: lastLeadRun.reasoningEffort as ModelTarget["reasoningEffort"] }
              : {}),
        };
      }
    }

    const candidates = resolveRouteCandidates(activeRouting, harnesses, input.action, tier, override);
    let target = candidates[0]!;
    if (
      input.useFallback &&
      prevRun &&
      !(input.autoFallbackAttempt && input.autoFallbackAttempt > 0 && input.harness && input.model)
    ) {
      const next = candidates.find((c) => `${c.harness}::${c.model}` !== `${prevRun.harness}::${prevRun.model}`);
      if (next) target = next;
    }

    // Persist human discussion/annotation if supplied before execution (skip on automatic retries)
    if (
      input.message?.trim() &&
      !(input.autoFallbackAttempt && input.autoFallbackAttempt > 0) &&
      !input.isInternalRetry &&
      !input.forcePlainText &&
      !input.reviewFormatRescue &&
      (input.action === "ask" || input.mode === "refine" || input.action === "design")
    ) {
      const isAskAction = input.action === "ask";
      const isBatchRefineSummary = input.mode === "refine" && Boolean(input.anchorIds && input.anchorIds.length > 0);
      await addDiscussion(base, id, {
        actor: "human",
        mode: isAskAction ? "ask" : "refine",
        kind: isAskAction ? "chat" : isBatchRefineSummary ? "refine_summary" : "chat",
        message: input.message.trim(),
        anchor: input.anchor,
        ...(!isAskAction ? { resolved: true } : {}),
      });
    }

    let conflictContext: ConflictHandoffContext | undefined;
    if (input.action === "fix" && input.resolveConflict) {
      const driftInfo = await inspectSandboxDrift(base, id, { includeSiblings: false, fetchRemote: false }).catch(() => null);
      if (driftInfo) {
        let mainCommitsSummary = "";
        try {
          mainCommitsSummary = execFileSync(
            "git",
            ["-C", base, "log", "--oneline", "-n", "15", `${driftInfo.baseHead}..${driftInfo.mainHead}`],
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
          ).trim();
        } catch {
          mainCommitsSummary = "";
        }
        let conflictExcerpt = await extractMergeConflictContext(codeRoot, 2600);
        if (!conflictExcerpt && driftInfo.conflictFiles.length > 0) {
          try {
            conflictExcerpt = execFileSync(
              "git",
              [
                "-C",
                base,
                "diff",
                driftInfo.baseHead,
                driftInfo.mainHead,
                "--",
                ...driftInfo.conflictFiles.slice(0, 6),
              ],
              { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
            )
              .trim()
              .slice(0, 2600);
          } catch {
            conflictExcerpt = "";
          }
        }
        conflictContext = {
          branch: driftInfo.branch,
          baseHead: driftInfo.baseHead,
          mainHead: driftInfo.mainHead,
          targetRef: driftInfo.targetRef,
          behindCount: driftInfo.behindCount,
          conflictFiles: driftInfo.conflictFiles,
          ...(mainCommitsSummary ? { mainCommitsSummary } : {}),
          ...(conflictExcerpt ? { conflictExcerpt } : {}),
        };
      }
    }

    const isDesignReview =
      input.action === "review" &&
      currentDetail.state.stage === "planning" &&
      currentDetail.state.designHash !== "";

    // WB-15: Native session resume and exact incremental re-review diff (`lastReviewCommit..HEAD`)
    // ONLY when isolated worktree is active, reviewer harness+model match, prior context is healthy, and history is linear.
    // Otherwise ALWAYS degrade cleanly to full diff (`baselineHead..HEAD`) + `fresh_handoff`.
    let prevReviewRun: AgentRunRecord | null = null;
    if (
      input.action === "review" &&
      !isDesignReview &&
      !input.reviewFormatRescue &&
      !input.forceFreshSession &&
      !input.useFallback &&
      codeRoot !== base
    ) {
      const priorReview = currentDetail.state.reviewReport;
      const isCodingReviewRun = (r: AgentRunRecord) =>
        r.action === "review" &&
        r.dispatchReason !== "design_review" &&
        r.dispatchReason !== "auto_design_review";
      prevReviewRun =
        (priorReview?.reviewerSessionId
          ? [...runsList].reverse().find((r) => isCodingReviewRun(r) && r.nativeSessionId === priorReview.reviewerSessionId)
          : null) ??
        [...runsList].reverse().find((r) => isCodingReviewRun(r) && Boolean(r.nativeSessionId)) ??
        null;
    }
    let canResumeReviewSession = Boolean(
      prevReviewRun &&
        prevReviewRun.harness === target.harness &&
        prevReviewRun.model === target.model &&
        isHealthyForNativeResume(prevReviewRun),
    );

    let incrementalReview: IncrementalReviewContext | undefined;
    if (
      canResumeReviewSession &&
      currentDetail.state.reviewReport?.reviewedCommit
    ) {
      const prevCommit = currentDetail.state.reviewReport.reviewedCommit;
      const curSnap = await observeGitSnapshot(codeRoot);
      if (curSnap?.head && !curSnap.dirty) {
        const isAnc = await isAncestorCommit(codeRoot, prevCommit, curSnap.head);
        const hasMerges = isAnc ? await hasMergeCommitsBetween(codeRoot, prevCommit, "HEAD") : true;
        const baselineHead = currentDetail.state.baseline?.head ?? null;
        const baselineOk = !baselineHead || (await isAncestorCommit(codeRoot, baselineHead, prevCommit));
        if (isAnc && !hasMerges && baselineOk) {
          const inc = await observeIncrementalDiff(codeRoot, prevCommit);
          if (inc.ok) {
            incrementalReview = {
              fromCommit: prevCommit,
              files: inc.files,
              diff: inc.diff,
              truncated: inc.truncated,
            };
          }
        }
      }
    }
    if (!incrementalReview) {
      canResumeReviewSession = false;
    }

    const prevTail = prevRun ? (this.runLogs.get(prevRun.id) ?? undefined) : undefined;
    const {
      markdown: handoffMd,
      detail: postHandoffDetail,
      outputLanguage,
      composition,
    } = await synthesizeHandoffPacket(base, id, {
      action: input.action,
      humanInstruction: input.message,
      anchorIds: input.anchorIds,
      previousRun: prevRun,
      previousLogTail: prevTail,
      hubOutputLanguage,
      resolveConflict: input.resolveConflict,
      conflictContext,
      targetHarness: target.harness,
      incrementalReview,
    });

    // 收集同需求当前并发运行中正在占用的原生会话，避免双轨并发时两个子进程同时续接同一 session 文件。
    const inUseSessionIds = new Set<string>();
    let hasConcurrentAsk = false;
    for (const job of this.activeJobs.values()) {
      if (job.root !== base || job.requirementId !== id) continue;
      if (job.resumedSessionId) inUseSessionIds.add(job.resumedSessionId);
      if (job.action === "ask") hasConcurrentAsk = true;
    }

    // Native session resume within the coding phase (implement <-> fix), completed post-approval ask -> implement
    // (only when no concurrent ask is running), same-action retries, and eligible incremental re-reviews (WB-15).
    const findLeadCodingRunForResume = (): AgentRunRecord | null => {
      const approvedAt = currentDetail.state.approval?.approvedAt ?? 0;
      const lastPlanRevisedAt = currentDetail.state.timeline.reduce(
        (max, ev) => (ev.kind === "plan_revised" && ev.at > max ? ev.at : max),
        0,
      );
      for (let idx = runsList.length - 1; idx >= 0; idx--) {
        const r = runsList[idx]!;
        if (r.action === "design") break;
        if (lastPlanRevisedAt > 0 && r.startedAt < lastPlanRevisedAt) break;
        if (r.action === "implement" || r.action === "fix") return r;
      }
      if (hasConcurrentAsk) return null;
      const askCutoff = Math.max(approvedAt, lastPlanRevisedAt);
      for (let idx = runsList.length - 1; idx >= 0; idx--) {
        const r = runsList[idx]!;
        if (r.action === "design") break;
        if (r.startedAt < askCutoff) break;
        if (r.action === "ask" && r.status === "succeeded") return r;
      }
      return null;
    };
    const prevLeadRun =
      input.action === "review"
        ? prevReviewRun
        : input.action === "implement" || input.action === "fix"
          ? findLeadCodingRunForResume()
          : ([...runsList].reverse().find((r) => r.action === input.action && r.status !== "running") ?? null);

    const canResumeSameHarness = Boolean(
      input.reviewFormatRescue ||
        canResumeReviewSession ||
        (!input.useFallback &&
          !input.forceFreshSession &&
          prevLeadRun &&
          prevLeadRun.harness === target.harness &&
          isHealthyForNativeResume(prevLeadRun) &&
          (!prevLeadRun.nativeSessionId || !inUseSessionIds.has(prevLeadRun.nativeSessionId)) &&
          input.action !== "review"),
    );

    const resumedSessionId = input.reviewFormatRescue
      ? input.reviewFormatRescue.sessionId
      : canResumeSameHarness
        ? prevLeadRun!.nativeSessionId
        : undefined;

    const handoffMode: RunHandoffMode = canResumeSameHarness
      ? "native_resume"
      : runsList.length > 0
        ? "fresh_handoff"
        : "first_run";
    const parentRunId = canResumeSameHarness && prevLeadRun ? prevLeadRun.id : prevRun?.id;
    const dispatchReason: RunDispatchReason =
      input.dispatchReasonOverride ??
      (input.resolveConflict
        ? "conflict_resolve"
        : (input.autoHealAttempt ?? 0) > 0
          ? "auto_heal"
          : input.isAutoReview
            ? "auto_review"
            : input.useFallback
              ? "auto_fallback"
              : input.action === "ask"
                ? "ask"
                : input.mode === "refine"
                  ? "refine"
                  : input.harness && input.model
                    ? prevRun &&
                      prevRun.status === "failed" &&
                      `${prevRun.harness}::${prevRun.model}` !== `${input.harness}::${input.model}`
                      ? "manual_fallback"
                      : "user"
                    : sessionAffinityApplied
                      ? "session_affinity"
                      : "route_primary");

    const projectMeta = getProjectStatus(base).project;
    const projectContext = discoverProjectContext(codeRoot, projectMeta);
    const preSpecMarkdown = postHandoffDetail.specMarkdown;
    const preDesignMarkdown = postHandoffDetail.designMarkdown;

    let previousSpecHash: string | null = null;
    if (canResumeSameHarness && prevLeadRun) {
      previousSpecHash = prevLeadRun.specHashAfter ?? null;
      if (!previousSpecHash) {
        try {
          previousSpecHash = getAgentRunContext(base, id, prevLeadRun.id)?.specHashBefore ?? null;
        } catch {
          previousSpecHash = null;
        }
      }
    }

    const prompt = input.reviewFormatRescue
      ? outputLanguage === "en"
        ? 'Your previous review response lacked the required structured JSON verdict block. Output ONLY the fenced ```json block now:\n```json\n{"verdict":"pass"|"concern"|"block","summary":"One-sentence core review summary","findings":[{"id":"F-1","severity":"high"|"medium"|"low","title":"Short title","files":["path"],"suggestion":"Concrete fix"}]}\n```'
        : '你上一轮审查输出缺少必需的结构化 JSON 结论块。请基于刚才的审查结论，仅输出一个 ```json 代码块：\n```json\n{"verdict":"pass"|"concern"|"block","summary":"一句话核心审查结论","findings":[{"id":"F-1","severity":"high"|"medium"|"low","title":"简明问题描述","files":["path"],"suggestion":"具体修复建议"}]}\n```'
      : buildExecutionPrompt(
          postHandoffDetail,
          handoffMd,
          { ...input, root: base, conflictContext },
          {
            resumedSession: canResumeSameHarness,
            outputLanguage,
            fastCommand: projectContext.fastCommand,
            fullCommand: projectContext.fullCommand,
            previousSpecHash,
            incrementalReviewFromCommit: incrementalReview?.fromCommit ?? null,
          },
        );

    const structuredJsonEnabled =
      !input.forcePlainText && !this.plainTextFallbackHarnesses.has(target.harness);
    const allowResumeOnReview = Boolean(input.reviewFormatRescue || canResumeReviewSession);
    const built = this.commandBuilder
      ? this.commandBuilder(target, {
          root: codeRoot,
          requirementId: id,
          action: input.action,
          prompt,
          nativeSessionId: resumedSessionId,
          allowResumeOnReview,
          harnesses,
          structuredJson: structuredJsonEnabled,
        })
      : buildHarnessCommand(target, {
          root: codeRoot,
          action: input.action,
          prompt,
          nativeSessionId: resumedSessionId,
          allowResumeOnReview,
          harnesses,
          structuredJson: structuredJsonEnabled,
        });

    const targetHarnessInfo = harnesses.find((h) => h.id === target.harness);
    const targetModelInfo =
      targetHarnessInfo?.models.find((m) => m.id === target.model) ??
      targetHarnessInfo?.models.find((m) => m.effortVariants && Object.values(m.effortVariants).includes(target.model));
    const poolInfo = resolveQuotaPool(target.harness, target.model, {
      billingOverrides: observability?.billingOverrides,
      isFreeHint: targetModelInfo?.isFree,
    });
    const modelSpec = resolveModelSpec(target.harness, target.model, harnesses, observability);

    const startedAt = Date.now();
    const runId = `RUN-${startedAt}-${randomUUID().slice(0, 6)}`;
    const snapshotBefore = await observeGitSnapshot(codeRoot);
    const specHashBefore = postHandoffDetail.state.specHash;
    const traceRelPath = `runs/run-${runId}.events.jsonl`;
    const contextSnapshot: RunContextSnapshot = {
      schemaVersion: 1,
      runId,
      requirementId: id,
      action: input.action,
      capturedAt: startedAt,
      handoffMode,
      ...(parentRunId ? { parentRunId } : {}),
      ...(resumedSessionId ? { resumedSessionId } : {}),
      dispatchReason,
      selectedTarget: {
        harness: target.harness,
        model: target.model,
        ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}),
      },
      routeCandidates: candidates.map((c) => ({
        harness: c.harness,
        model: c.model,
        ...(c.reasoningEffort ? { reasoningEffort: c.reasoningEffort } : {}),
        ...(`${c.harness}::${c.model}` !== `${target.harness}::${target.model}` ? { skippedReason: "backup" } : {}),
      })),
      specHashBefore,
      codeSnapshotHashBefore: snapshotBefore?.fingerprint ?? null,
      handoffTotalBytes: composition.totalBytes,
      handoffBudgetBytes: composition.budgetBytes,
      handoffEstTokens: composition.estTokens,
      promptBytes: Buffer.byteLength(prompt, "utf8"),
      promptEstTokens: estimateTokens(prompt),
      sections: composition.sections,
      truncatedSections: composition.truncatedSections,
      handoffMarkdown: handoffMd,
      promptText: prompt,
    };
    const contextRelPath = saveAgentRunContext(base, id, runId, contextSnapshot);

    const record: AgentRunRecord = {
      id: runId,
      action: input.action,
      harness: target.harness,
      model: target.model,
      ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}),
      quotaPool: poolInfo.quotaPool,
      billingMode: poolInfo.billingMode,
      dispatchReason,
      handoffMode,
      ...(parentRunId ? { parentRunId } : {}),
      contextWindow: modelSpec.contextWindow,
      hubPid: process.pid,
      status: "running",
      startedAt,
      endedAt: null,
      exitCode: null,
      durationMs: 0,
      logPath: `runs/run-${runId}.log`,
      tracePath: traceRelPath,
      contextPath: contextRelPath,
    };

    const detail = await startAgentRun(base, id, record, snapshotBefore?.fingerprint ?? null);
    if (
      detail.state.needsHuman &&
      (input.action === "implement" || input.action === "fix" || input.action === "design") &&
      (dispatchReason === "user" ||
        dispatchReason === "sota_escalate" ||
        dispatchReason === "route_primary" ||
        dispatchReason === "session_affinity" ||
        dispatchReason === "manual_fallback" ||
        dispatchReason === "refine")
    ) {
      await setRequirementNeedsHuman(base, id, null, snapshotBefore?.fingerprint ?? null).catch(() => null);
    }
    if (codeRoot !== base) {
      syncRequirementMirrorToSandbox(base, id, codeRoot);
    }

    const traceDiskPath = resolveSafePath(base, `${WORKBENCH_DIR}/items/${id}/${traceRelPath}`);
    let emitWarningChunk: ((line: string) => void) | null = null;
    const collector = new RunTraceCollector({
      runId,
      action: input.action,
      traceFilePath: traceDiskPath,
      startedAt,
      billingMode: poolInfo.billingMode,
      quotaPool: poolInfo.quotaPool,
      modelSpec,
      onWarning: (line) => emitWarningChunk?.(line),
      onEvent: (ev) => {
        this.emit({
          type: "agent.run.event",
          root: base,
          requirementId: id,
          runId,
          event: ev,
          at: ev.ts,
        });
      },
      onMetrics: (metrics) => {
        this.emit({
          type: "agent.run.metrics",
          root: base,
          requirementId: id,
          runId,
          metrics,
          at: Date.now(),
        });
      },
    });
    this.traceCollectors.set(runId, collector);
    this.emit({
      type: "agent.run.started",
      root: base,
      requirementId: id,
      runId,
      action: input.action,
      harness: target.harness,
      model: target.model,
      ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}),
      quotaPool: poolInfo.quotaPool,
      billingMode: poolInfo.billingMode,
      dispatchReason,
      handoffMode,
      ...(parentRunId ? { parentRunId } : {}),
      contextWindow: modelSpec.contextWindow,
      tracePath: traceRelPath,
      contextPath: contextRelPath,
      metrics: collector.snapshotMetrics(),
      status: "running",
      at: startedAt,
    });
    collector.append({
      type: "run.init",
      action: input.action,
      harness: target.harness,
      model: target.model,
      ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}),
      quotaPool: poolInfo.quotaPool,
      billingMode: poolInfo.billingMode,
      dispatchReason,
      handoffMode,
      ...(parentRunId ? { parentRunId } : {}),
      ...(resumedSessionId ? { resumedSessionId } : {}),
      structuredJson: structuredJsonEnabled,
    });
    collector.append({
      type: "handoff.snapshot",
      handoffMode,
      contextPath: contextRelPath,
      handoffTotalBytes: composition.totalBytes,
      handoffBudgetBytes: composition.budgetBytes,
      handoffEstTokens: composition.estTokens,
      promptBytes: contextSnapshot.promptBytes,
      promptEstTokens: contextSnapshot.promptEstTokens,
      sections: composition.sections,
      truncatedSections: composition.truncatedSections,
    });

    const shimBin = ensureWbShim(this.cliEntryPath);
    const isReadOnly = input.action === "ask" || input.action === "review";
    const screenshotOutDir =
      input.action === "implement" || input.action === "fix" ? screenshotStagingDir(base, id) : null;
    if (screenshotOutDir) {
      fs.rmSync(screenshotOutDir, { recursive: true, force: true });
      fs.mkdirSync(screenshotOutDir, { recursive: true });
    }
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...buildHarnessIsolationEnv(target.harness),
      PATH: `${shimBin}:${process.env.PATH ?? ""}`,
      WORKBENCH_ROOT: base,
      WORKBENCH_REQ_ID: id,
      WORKBENCH_RUN_ACTION: input.action,
      WORKBENCH_HUB_PID: String(process.pid),
      WORKBENCH_OUTPUT_LANGUAGE: outputLanguage,
      ...(screenshotOutDir ? { WORKBENCH_SCREENSHOT_OUT_DIR: screenshotOutDir } : {}),
      ...(target.harness === "opencode"
        ? { OPENCODE_CONFIG_CONTENT: buildOpencodeNonInteractiveConfig(process.env.OPENCODE_CONFIG_CONTENT, { readOnly: isReadOnly }) }
        : {}),
    };

    const liveLogPath = path.join(base, WORKBENCH_DIR, "items", id, "runs", `run-${runId}.log`);
    const appendDiskLog = (text: string) => {
      if (!text) return;
      try {
        if (fs.existsSync(path.dirname(liveLogPath))) {
          fs.appendFileSync(liveLogPath, text, "utf8");
        }
      } catch {
        // Real-time disk flush is best-effort.
      }
    };

    const rpcStdioAllowed =
      structuredJsonEnabled &&
      !input.disableRpcStdio &&
      !this.rpcFallbackHarnesses.has(target.harness) &&
      !this.commandBuilder;
    const useOpencodeAcp =
      target.harness === "opencode" &&
      input.action === "ask" &&
      rpcStdioAllowed;
    const useCodexAppServer =
      target.harness === "codex" &&
      input.action === "ask" &&
      rpcStdioAllowed;
    const useRpcStdio = useOpencodeAcp || useCodexAppServer;
    const opencodeBin = targetHarnessInfo?.executable || "opencode";
    const codexBin = targetHarnessInfo?.executable || "codex";
    const spawnCommand = useOpencodeAcp
      ? opencodeBin
      : useCodexAppServer
        ? codexBin
        : built.command;
    const spawnArgs = useOpencodeAcp
      ? ["acp"]
      : useCodexAppServer
        ? ["app-server", "--stdio"]
        : built.args;
    const displayCommand = useOpencodeAcp
      ? `${opencodeBin} acp --model ${target.model}${resumedSessionId ? ` --resume ${resumedSessionId}` : ""}`
      : useCodexAppServer
        ? `${codexBin} app-server --stdio --model ${target.model}${resumedSessionId ? ` --resume ${resumedSessionId}` : ""}`
        : built.displayCommand;

    const initialCmdLine = `$ ${displayCommand}\n`;
    this.runLogs.set(runId, initialCmdLine);
    appendDiskLog(initialCmdLine);
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: codeRoot,
      detached: process.platform !== "win32",
      stdio: [useRpcStdio ? "pipe" : "ignore", "pipe", "pipe"],
      env: childEnv,
    });

    const job: ActiveJob = {
      runId,
      root: base,
      requirementId: id,
      action: input.action,
      target,
      quotaPool: poolInfo.quotaPool,
      billingMode: poolInfo.billingMode,
      dispatchReason,
      handoffMode,
      ...(parentRunId ? { parentRunId } : {}),
      ...(resumedSessionId ? { resumedSessionId } : {}),
      contextWindow: modelSpec.contextWindow,
      tracePath: traceRelPath,
      contextPath: contextRelPath,
      child,
      startedAt,
      cancelled: false,
      timedOut: false,
      timeoutReason: null,
      lockLease: codeRootLockLease,
    };
    this.activeJobs.set(runId, job);
    globalActiveRunIds.add(runId);

    const { idleTimeoutMs, maxDurationMs } = resolveRunTimeouts(input.action, {
      timeoutMs: input.timeoutMs,
      idleTimeoutMs: input.idleTimeoutMs,
    });
    let finalized = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let livenessTimer: ReturnType<typeof setInterval> | undefined;

    const triggerTimeout = (reason: TimeoutReason) => {
      if (finalized || job.cancelled || job.timedOut) return;
      job.timedOut = true;
      job.timeoutReason = reason;
      job.onCancel?.();
      this.killProcessGroup(job);
    };

    const resetIdleTimer = () => {
      if (finalized || job.cancelled || job.timedOut) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => triggerTimeout("idle"), idleTimeoutMs);
    };

    resetIdleTimer();
    const maxDurationTimer = setTimeout(() => triggerTimeout("max_duration"), maxDurationMs);

    if (idleTimeoutMs >= 10_000) {
      const stateFile = path.join(base, WORKBENCH_DIR, "items", id, "state.json");
      let lastStateMtimeMs = 0;
      try {
        lastStateMtimeMs = fs.statSync(stateFile).mtimeMs;
      } catch {
        lastStateMtimeMs = 0;
      }
      const probeIntervalMs = Math.min(60_000, Math.max(5_000, Math.floor(idleTimeoutMs / 3)));
      livenessTimer = setInterval(() => {
        if (finalized || job.cancelled || job.timedOut) return;
        try {
          const mtime = fs.statSync(stateFile).mtimeMs;
          if (mtime > lastStateMtimeMs) {
            lastStateMtimeMs = mtime;
            resetIdleTimer();
          }
        } catch {
          // Ignore transient stat failures.
        }
      }, probeIntervalMs);
      livenessTimer.unref?.();
    }

    const cleanReplyParts: string[] = [];
    let stdoutReplyTail = "";
    let stdoutLineBuf = "";
    let capturedSessionId: string | undefined;

    const appendStdoutReply = (text: string) => {
      if (!text) return;
      const next = stdoutReplyTail + text;
      stdoutReplyTail = next.length > 64 * 1024 ? next.slice(next.length - 64 * 1024) : next;
    };

    const emitCleanChunk = (rawChunk: string) => {
      const text = sanitizeOutput(rawChunk, 64 * 1024).text;
      if (!text) return;
      const cur = (this.runLogs.get(runId) ?? "") + text;
      const bounded =
        Buffer.byteLength(cur, "utf8") > MAX_RUN_LOG_BYTES
          ? clipHeadTailUtf8(cur, 1_500_000, 2_500_000).text
          : cur;
      this.runLogs.set(runId, bounded);
      appendDiskLog(text);
      this.emit({
        type: "agent.run.output",
        root: base,
        requirementId: id,
        runId,
        chunk: text,
        at: Date.now(),
      });
    };
    emitWarningChunk = emitCleanChunk;

    const streamAdapter = createHarnessStreamAdapter(target.harness, target.model, structuredJsonEnabled);

    const handleAdapterResult = (
      parsed: ReturnType<typeof streamAdapter.feedLine>,
      hadTrailingNewline = true,
    ) => {
      if (parsed.sessionId) capturedSessionId = parsed.sessionId;
      if (parsed.effectiveModel) job.effectiveModel = parsed.effectiveModel;
      if (parsed.modelFallback) job.modelFallback = true;
      if (
        parsed.authoritativeUsage ||
        parsed.authoritativeCostUsd !== undefined ||
        parsed.authoritativeTurnsCount !== undefined
      ) {
        collector.setAuthoritativeTotals({
          usage: parsed.authoritativeUsage,
          costUsd: parsed.authoritativeCostUsd,
          turnsCount: parsed.authoritativeTurnsCount,
        });
      }
      for (const ev of parsed.events) {
        collector.append(ev);
      }
      if (parsed.thinkingDelta) {
        this.emit({
          type: "agent.run.delta",
          root: base,
          requirementId: id,
          runId,
          action: input.action,
          channel: "thinking",
          delta: parsed.thinkingDelta,
          at: Date.now(),
        });
      }
      if (parsed.textDelta) {
        this.emit({
          type: "agent.run.delta",
          root: base,
          requirementId: id,
          runId,
          action: input.action,
          channel: "text",
          delta: parsed.textDelta,
          at: Date.now(),
        });
      }
      if (parsed.replyText) {
        cleanReplyParts.push(parsed.replyText);
      }
      if (parsed.displayText) {
        const allRawLine = parsed.events.length > 0 && parsed.events.every((e) => e.type === "raw.line");
        const displayOut = !hadTrailingNewline && allRawLine ? parsed.displayText.replace(/\n$/, "") : parsed.displayText;
        emitCleanChunk(displayOut);
        if (allRawLine) {
          appendStdoutReply(displayOut);
        }
      }
    };

    const rpcCallbacks = {
      cwd: codeRoot,
      prompt,
      model: target.model,
      reasoningEffort: target.reasoningEffort,
      resumedSessionId,
      readOnly: isReadOnly,
      onActivity: resetIdleTimer,
      onSessionId: (sid: string) => {
        capturedSessionId = sid;
      },
      onDelta: (channel: "text" | "thinking", delta: string) => {
        this.emit({
          type: "agent.run.delta",
          root: base,
          requirementId: id,
          runId,
          action: input.action,
          channel,
          delta,
          at: Date.now(),
        });
      },
      onTraceEvent: (ev: Parameters<typeof collector.append>[0]) => collector.append(ev),
      onUsage: (usage: RunTokenUsage, turnsCount?: number) => {
        collector.setAuthoritativeTotals({ usage, turnsCount });
      },
      onReplyText: (text: string) => {
        cleanReplyParts.push(text);
      },
      onDisplayText: (text: string) => emitCleanChunk(text),
      onWarning: (line: string) => emitCleanChunk(line),
    };

    const acpHandle = useOpencodeAcp
      ? driveOpencodeAcpProcess(child, rpcCallbacks)
      : useCodexAppServer
        ? driveCodexAppServerProcess(child, rpcCallbacks)
        : null;

    if (acpHandle) {
      job.onCancel = acpHandle.cancel;
    } else {
      child.stdout?.on("data", (buf: Buffer) => {
        if (buf.length > 0) resetIdleTimer();
        stdoutLineBuf += buf.toString("utf8");
        const lines = stdoutLineBuf.split(/\r?\n/);
        stdoutLineBuf = lines.pop() ?? "";
        for (const line of lines) {
          handleAdapterResult(streamAdapter.feedLine(line), true);
        }
      });
    }

    child.stderr?.on("data", (buf: Buffer) => {
      if (buf.length > 0) resetIdleTimer();
      const cleaned = stripCliNoise(buf.toString("utf8"));
      if (cleaned.trim()) {
        collector.append({
          type: "raw.line",
          stream: "stderr",
          text: sanitizeOutput(cleaned, 8192).text,
        });
        emitCleanChunk(cleaned);
      }
    });

    const finalize = async (
      exitCode: number | null,
      spawnErr?: string,
      rpcOpts?: { errorMessage?: string; handshakeFailed?: boolean },
    ) => {
      if (finalized) return;
      finalized = true;
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(maxDurationTimer);
      if (livenessTimer) clearInterval(livenessTimer);
      if (job.killTimer) clearTimeout(job.killTimer);

      let status: AgentRunRecord["status"] = "failed";
      let rateLimited = false;
      let modelUnavailable = false;
      let sessionExpired = false;
      let shouldRetryPlainText = false;
      let shouldFallbackFromRpc = false;
      let snap: Awaited<ReturnType<typeof observeGitSnapshot>> = null;
      let latestReq: RequirementDetail | null = null;
      let parsedReview: ReturnType<typeof parseReviewOutput> = null;
      let reviewParseFailed = false;
      let nativeSessionId: string | undefined;
      let canRescueReviewFormat = false;
      let errorSummary: string | undefined;
      let rawLog = this.runLogs.get(runId) ?? "";
      let endedAt = Date.now();
      let durationMs = Math.max(0, endedAt - startedAt);
      let codeChanged = false;
      let wipCommitHash: string | undefined;
      let autoHealPending = false;
      let readyForReview = false;
      let noCodeChange = false;
      let bugPausedReason: string | null = null;
      let unrelatedTimeoutFiles: string[] | undefined;

      try {
        if (stdoutLineBuf.trim()) {
          handleAdapterResult(streamAdapter.feedLine(stdoutLineBuf), false);
          stdoutLineBuf = "";
        }
        const flushed = streamAdapter.flush();
        if (flushed) handleAdapterResult(flushed);

        endedAt = Date.now();
        durationMs = Math.max(0, endedAt - startedAt);
        const assembledLog = (this.runLogs.get(runId) ?? "") + (spawnErr ? `\n[spawn error] ${spawnErr}\n` : "");
        rawLog =
          Buffer.byteLength(assembledLog, "utf8") > MAX_RUN_LOG_BYTES
            ? clipHeadTailUtf8(assembledLog, 1_500_000, 2_500_000).text
            : assembledLog;
        this.runLogs.set(runId, rawLog);

        rateLimited = !job.cancelled && !job.timedOut && detectRateLimitOrQuotaError(rawLog, exitCode);
        modelUnavailable = !job.cancelled && !job.timedOut && detectModelUnavailableError(rawLog, exitCode);
        sessionExpired =
          canResumeSameHarness &&
          !input.forceFreshSession &&
          !job.cancelled &&
          !job.timedOut &&
          !spawnErr &&
          isSessionExpiredError(rawLog, exitCode);
        shouldFallbackFromRpc =
          useRpcStdio &&
          !input.disableRpcStdio &&
          !job.cancelled &&
          !job.timedOut &&
          !spawnErr &&
          exitCode !== 0 &&
          durationMs < 5000 &&
          Boolean(rpcOpts?.handshakeFailed);
        if (shouldFallbackFromRpc) {
          this.rpcFallbackHarnesses.add(target.harness);
        }
        shouldRetryPlainText =
          !shouldFallbackFromRpc &&
          structuredJsonEnabled &&
          !input.forcePlainText &&
          !job.cancelled &&
          !job.timedOut &&
          !spawnErr &&
          exitCode !== 0 &&
          durationMs < 5000 &&
          isUnsupportedJsonFlagError(rawLog);
        if (shouldRetryPlainText) {
          this.plainTextFallbackHarnesses.add(target.harness);
        }

        try {
          if (codeRoot !== base) {
            await reconcileSandboxBaseline(base, id).catch(() => null);
          }
          snap = await observeGitSnapshot(codeRoot);
          latestReq = getRequirement(base, id, { currentCodeSnapshotHash: snap?.fingerprint ?? null });
        } catch {
          // Ignore git/requirement read errors during finalize pre-observation.
        }

        status = job.cancelled
          ? "cancelled"
          : exitCode === 0 && !spawnErr && !job.timedOut
            ? "succeeded"
            : "failed";
        if (
          status === "failed" &&
          (input.action === "implement" || input.action === "fix") &&
          !job.cancelled &&
          !job.timedOut &&
          !spawnErr &&
          !rateLimited &&
          !modelUnavailable &&
          NON_FATAL_FORM_CANCEL_RE.test(rawLog.slice(-4096)) &&
          latestReq &&
          latestReq.state.stage === "coding" &&
          latestReq.validity.acceptanceGate.ok &&
          latestReq.state.updatedAt >= startedAt
        ) {
          status = "succeeded";
          const note = "[workbench] 检测到 CLI 非致命交互表单取消退出码，但本轮已完成全部验证，按成功终态收尾。\n";
          rawLog = `${rawLog}${rawLog.endsWith("\n") || !rawLog ? "" : "\n"}${note}`;
          this.runLogs.set(runId, rawLog);
        }

        const replySource =
          cleanReplyParts.join("\n\n").trim() ||
          stdoutReplyTail.trim() ||
          stripCliNoise(rawLog.replace(/^\$ .*\n/, ""));
        parsedReview =
          status === "succeeded" && input.action === "review" ? parseReviewOutput(replySource) : null;
        if (parsedReview && !isDesignReview && latestReq) {
          parsedReview = normalizeReviewVerdictForManualCriteria(parsedReview, latestReq.state.criteria);
        }
        if (
          parsedReview &&
          parsedReview.verdict === "concern" &&
          Array.isArray(parsedReview.findings) &&
          parsedReview.findings.length > 0 &&
          parsedReview.findings.every((f) => f.severity === "low")
        ) {
          parsedReview.verdict = "pass";
        }
        reviewParseFailed = status === "succeeded" && input.action === "review" && parsedReview === null;
        if (reviewParseFailed) status = "failed";

        const invalidSessionTokens = new Set([
          "string",
          "number",
          "boolean",
          "undefined",
          "null",
          "object",
          "unknown",
          "default",
          "canresumesameharness",
        ]);
        const sessMatches = Array.from(
          rawLog.matchAll(/^(?:session id|session_id)\s*:\s*["']?([0-9a-f]{8}-[0-9a-f-]{27}|[A-Za-z0-9][A-Za-z0-9._-]{7,63})["']?\s*$/gim),
        );
        let matchedSessionId: string | undefined;
        for (let i = sessMatches.length - 1; i >= 0; i--) {
          const cand = sessMatches[i]![1]!;
          if (!invalidSessionTokens.has(cand.toLowerCase())) {
            matchedSessionId = cand;
            break;
          }
        }
        nativeSessionId = capturedSessionId ?? matchedSessionId;
        canRescueReviewFormat =
          reviewParseFailed &&
          !input.reviewFormatRescue &&
          Boolean(nativeSessionId) &&
          replySource.length > 80;

        errorSummary =
          status === "failed"
            ? shouldFallbackFromRpc
              ? "CLI 不支持流式 RPC 协议，已自动降级为标准命令行模式重试"
              : shouldRetryPlainText
                ? "CLI 不支持结构化 JSON 输出参数，已自动降级为纯文本模式重试"
                : sessionExpired
                  ? "原生会话已过期或不存在，已自动降级为全新交接重试"
                  : reviewParseFailed
                    ? canRescueReviewFormat
                      ? "审查输出缺少结构化 JSON 结论块，正在自动补全格式化输出"
                      : "审查输出缺少可解析的结构化结论（需在末尾输出 ```json {\"verdict\":\"pass|concern|block\",\"summary\":\"…\"} ```），未写入审查报告；请重跑跨模型审查"
                    : job.timedOut
                      ? job.timeoutReason === "max_duration"
                        ? `执行超时（单次运行已达安全上限 ${Math.round(maxDurationMs / 1000)}s），已保留当前代码与会话进度，可直接继续执行接力完成`
                        : `执行超时（连续 ${Math.round(idleTimeoutMs / 1000)}s 无输出或进展，疑似网络断流或命令挂起），建议检查代理或重试`
                      : modelUnavailable
                        ? `${target.harness}/${target.model} 模型不可用或未在当前 CLI 授权，已临时冷却并建议切换备援模型`
                        : rateLimited
                          ? `${target.harness}/${target.model} 疑似额度不足或触发限流，建议切换备援模型接力重试`
                          : (spawnErr ||
                              rpcOpts?.errorMessage ||
                              rawLog.trim().split(/\r?\n/).slice(-3).join(" | ").slice(0, 300) ||
                              `退出码 ${exitCode}`)
            : undefined;
        codeChanged = (snap?.fingerprint ?? null) !== (snapshotBefore?.fingerprint ?? null);

        const appendFinalizeNote = (line: string) => {
          emitCleanChunk(line);
          rawLog = this.runLogs.get(runId) ?? rawLog;
        };

        // 0. Commit sandbox WIP checkpoint BEFORE checking bug_pause or running post-gate so partial edits persist cleanly.
        if ((input.action === "implement" || input.action === "fix") && codeRoot !== base) {
          try {
            const wipRes = await commitSandboxWipCheckpoint(base, id, {
              action: input.action,
              runId,
              status,
              parentLeaseId: job.lockLease?.id,
            });
            if (wipRes.committed && wipRes.commitHash) {
              wipCommitHash = wipRes.commitHash;
              appendFinalizeNote(
                `[workbench] 已自动提交沙箱 WIP 检查点 ${wipRes.commitHash.slice(0, 7)}（${wipRes.files.length} 个文件）。\n`,
              );
              snap = await observeGitSnapshot(codeRoot);
              latestReq = getRequirement(base, id, { currentCodeSnapshotHash: snap?.fingerprint ?? null });
            } else if (wipRes.commitHash) {
              wipCommitHash = wipRes.commitHash;
            }
          } catch (err) {
            appendFinalizeNote(
              `[workbench] 自动提交沙箱 WIP 检查点跳过：${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }

        // WB-21 / FLOW §1B: detect explicit Bug pause marker (`workbench-pause`) BEFORE post-coding verification/autoHeal
        // so intentional pauses (e.g. after writing a failing repro test requiring an architecture change) escalate directly.
        if (
          status === "succeeded" &&
          (input.action === "implement" || input.action === "fix") &&
          latestReq?.state.kind === "bug" &&
          latestReq.state.stage === "coding" &&
          !job.cancelled &&
          !job.timedOut &&
          !spawnErr &&
          !rateLimited &&
          !modelUnavailable
        ) {
          const combinedText = `${cleanReplyParts.join("\n")}\n${stdoutReplyTail}\n${rawLog.slice(-4000)}`;
          const pauseMatch = /```workbench-pause\s*\n([\s\S]*?)\n```/i.exec(combinedText);
          if (pauseMatch) {
            const blockBody = pauseMatch[1]!.trim();
            try {
              const parsedPause = JSON.parse(blockBody) as { reason?: unknown };
              if (typeof parsedPause.reason === "string" && parsedPause.reason.trim()) {
                bugPausedReason = sanitizeOutput(parsedPause.reason.trim(), 1000).text.trim();
              }
            } catch {
              if (blockBody) bugPausedReason = sanitizeOutput(blockBody, 1000).text.trim();
            }
          }
        }

        // 1. File-Native Design Sync (inline ```workbench-criteria, skip duplicate propose)
        if (status === "succeeded" && input.action === "design" && latestReq) {
          latestReq = await syncDesignRunResult({
            base,
            codeRoot,
            id,
            latestReq,
            preSpecMarkdown,
            preDesignMarkdown,
            codeChanged,
            projectContext,
            snapshotFingerprint: snap?.fingerprint ?? null,
            appendNote: appendFinalizeNote,
          });
        }

        // 2. Deterministic Post-Coding Gate (auto-verify + auto-screenshot + zero-change & env-failure guards)
        if (
          !bugPausedReason &&
          status === "succeeded" &&
          (input.action === "implement" || input.action === "fix") &&
          latestReq &&
          !job.cancelled &&
          !job.timedOut &&
          !spawnErr &&
          !rateLimited &&
          !modelUnavailable
        ) {
          const gateResult = await runCodingPostGate({
            base,
            codeRoot,
            id,
            action: input.action,
            codeChanged,
            lockLeaseId: job.lockLease?.id,
            latestReq,
            snap,
            appendNote: appendFinalizeNote,
          });
          latestReq = gateResult.latestReq;
          snap = gateResult.snap;
          autoHealPending = gateResult.autoHealPending;
          readyForReview = gateResult.readyForReview;
          noCodeChange = gateResult.noCodeChange;
          unrelatedTimeoutFiles = gateResult.unrelatedTimeoutFiles;
        }
      } finally {
        job.lockLease?.release();
      }

      const specChanged = latestReq ? latestReq.state.specHash !== specHashBefore : false;
      const traceSummary = collector.finalizeRun({
        status,
        exitCode,
        durationMs,
        specChanged,
        codeChanged,
        errorSummary,
      });

      let postRunDetail: RequirementDetail | null = null;
      try {
        if (status === "succeeded" && input.action === "ask") {
          const cleanAnswer =
            cleanReplyParts.join("\n\n").trim() ||
            stdoutReplyTail.trim() ||
            stripCliNoise(rawLog.replace(/^\$ .*\n/, "")).trim();
          const answerText = cleanAnswer.slice(0, 24 * 1024);
          if (answerText) {
            await addDiscussion(base, id, {
              actor: "agent",
              mode: "ask",
              kind: "chat",
              anchor: input.anchor,
              harness: target.harness,
              model: target.model,
              message: answerText,
              runId,
              durationMs,
              toolCallsCount: traceSummary.toolCallsCount,
              handoffMode,
            });
          }
        } else if (status === "succeeded" && input.action === "review" && parsedReview && latestReq) {
          if (isDesignReview) {
            await recordDesignReviewReport(base, id, {
              reviewerHarness: target.harness,
              reviewerModel: target.model,
              verdict: parsedReview.verdict,
              summary: parsedReview.summary,
              markdown: parsedReview.markdown,
              ...(parsedReview.findings ? { findings: parsedReview.findings } : {}),
              reviewedSpecHash: latestReq.state.specHash,
              reviewedDesignHash: latestReq.state.designHash,
              currentCodeSnapshotHash: snap?.fingerprint ?? null,
            });
          } else if (snap?.fingerprint) {
            await recordReviewReport(base, id, {
              reviewerHarness: target.harness,
              reviewerModel: target.model,
              verdict: parsedReview.verdict,
              summary: parsedReview.summary,
              markdown: parsedReview.markdown,
              ...(parsedReview.findings ? { findings: parsedReview.findings } : {}),
              reviewedSpecHash: latestReq.state.specHash,
              reviewedCodeSnapshotHash: snap.fingerprint,
              ...(codeRoot !== base && snap.head && !snap.dirty ? { reviewedCommit: snap.head } : {}),
              ...(nativeSessionId ? { reviewerSessionId: nativeSessionId } : {}),
            });
          }
        } else if (
          status === "succeeded" &&
          (input.mode === "refine" || (input.anchorIds && input.anchorIds.length > 0) || input.adoptDiscussionId)
        ) {
          if (input.anchorIds && input.anchorIds.length > 0) {
            await resolveDiscussions(base, id, { ids: input.anchorIds, resolved: true });
          }
          if (input.adoptDiscussionId) {
            await resolveDiscussions(base, id, { ids: [input.adoptDiscussionId], adopted: true });
          }
        }

        const finishedDetail = await finishAgentRun(
          base,
          id,
          runId,
          {
            status,
            endedAt,
            exitCode,
            durationMs,
            nativeSessionId,
            rateLimited,
            ...(job.effectiveModel ? { effectiveModel: job.effectiveModel } : {}),
            ...(job.modelFallback ? { modelFallback: true } : {}),
            errorSummary,
            quotaPool: poolInfo.quotaPool,
            billingMode: poolInfo.billingMode,
            ...(traceSummary.usage ? { usage: traceSummary.usage } : {}),
            cost: traceSummary.cost,
            turnsCount: traceSummary.turnsCount,
            toolCallsCount: traceSummary.toolCallsCount,
            toolErrorCount: traceSummary.toolErrorCount,
            compactionCount: traceSummary.compactionCount,
            ...(traceSummary.peakContextTokens !== undefined ? { peakContextTokens: traceSummary.peakContextTokens } : {}),
            contextWindow: traceSummary.contextWindow,
            llmDurationMs: traceSummary.llmDurationMs,
            toolDurationMs: traceSummary.toolDurationMs,
            ...(traceSummary.ttftMs !== undefined ? { ttftMs: traceSummary.ttftMs } : {}),
            specChanged,
            ...(latestReq?.state.specHash ? { specHashAfter: latestReq.state.specHash } : {}),
            codeChanged,
            ...(noCodeChange ? { noCodeChange: true } : {}),
            ...(wipCommitHash ? { wipCommitHash } : {}),
            tracePath: traceRelPath,
            contextPath: contextRelPath,
            ...(traceSummary.traceTruncated ? { traceTruncated: true } : {}),
            ...(traceSummary.healthWarnings?.length ? { healthWarnings: traceSummary.healthWarnings } : {}),
          },
          rawLog,
          snap?.fingerprint ?? null,
        );
        postRunDetail = finishedDetail;
        this.activeJobs.delete(runId);
        globalActiveRunIds.delete(runId);

        if (!this.getActiveRuns(base).some((r) => r.requirementId === id && r.action !== "ask")) {
          const lastRunObj = (finishedDetail.state.agentRuns ?? []).find((r) => r.id === runId) ?? null;
          await synthesizeHandoffPacket(base, id, {
            action: input.action,
            previousRun: lastRunObj,
            previousLogTail: rawLog.slice(-1500),
            targetHarness: target.harness,
          });
          if (codeRoot !== base) {
            syncRequirementMirrorToSandbox(base, id, codeRoot);
          }
        }
      } catch (error) {
        console.error(
          `[workbench] finalize failed for ${id}/${runId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        this.activeJobs.delete(runId);
        globalActiveRunIds.delete(runId);
      }

      // Decoupled fire-and-forget telemetry & ledger sidecars
      if (!shouldFallbackFromRpc && !shouldRetryPlainText && !sessionExpired) {
        queueMicrotask(() => {
          try {
            const outcome: TelemetryOutcomeInput = {
              harness: target.harness,
              model: target.model,
              action: input.action,
              status,
              durationMs,
              quotaPool: poolInfo.quotaPool,
              rateLimited,
              timedOut: job.timedOut,
              modelFallback: job.modelFallback === true,
              modelUnavailable,
              now: endedAt,
              ...(traceSummary.usage?.totalTokens ? { tokens: traceSummary.usage.totalTokens } : {}),
              ...(traceSummary.usage?.cacheReadTokens ? { cacheReadTokens: traceSummary.usage.cacheReadTokens } : {}),
              apiCostUsd: traceSummary.cost.apiCostUsd,
              equivalentCostUsd: traceSummary.cost.equivalentCostUsd,
              toolCalls: traceSummary.toolCallsCount,
            };
            if (this.onTelemetryOutcome) {
              this.onTelemetryOutcome(outcome);
            } else {
              recordModelRunOutcome(outcome);
            }
          } catch {
            // Sidecar telemetry must never crash executor.
          }

          try {
            const ledgerEntry: RunLedgerEntry = {
              schemaVersion: 1,
              runId,
              projectRoot: base,
              nodeId: this.nodeId ?? "local",
              requirementId: id,
              requirementTitle: (postRunDetail ?? latestReq ?? currentDetail).state.title,
              action: input.action,
              harness: target.harness,
              model: target.model,
              ...(job.effectiveModel ? { effectiveModel: job.effectiveModel } : {}),
              ...(job.modelFallback ? { modelFallback: true } : {}),
              ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}),
              quotaPool: poolInfo.quotaPool,
              billingMode: poolInfo.billingMode,
              status,
              dispatchReason,
              handoffMode,
              startedAt,
              endedAt,
              durationMs,
              llmDurationMs: traceSummary.llmDurationMs,
              toolDurationMs: traceSummary.toolDurationMs,
              ...(traceSummary.ttftMs !== undefined ? { ttftMs: traceSummary.ttftMs } : {}),
              ...(traceSummary.usage ? { usage: traceSummary.usage } : {}),
              apiCostUsd: traceSummary.cost.apiCostUsd,
              equivalentCostUsd: traceSummary.cost.equivalentCostUsd,
              costSource: traceSummary.cost.costSource,
              turnsCount: traceSummary.turnsCount,
              toolCallsCount: traceSummary.toolCallsCount,
              toolErrorCount: traceSummary.toolErrorCount,
              compactionCount: traceSummary.compactionCount,
              ...(traceSummary.peakContextTokens !== undefined ? { peakContextTokens: traceSummary.peakContextTokens } : {}),
              contextWindow: traceSummary.contextWindow,
              ...(composition.truncatedSections.length > 0 ? { handoffTruncated: true } : {}),
              ...(rateLimited ? { rateLimited: true } : {}),
              ...(job.timedOut ? { timedOut: true } : {}),
              specChanged,
              codeChanged,
            };
            if (this.onLedgerEntry) {
              this.onLedgerEntry(ledgerEntry);
            } else if (!this.nodeId) {
              appendRunLedger(ledgerEntry);
            }
          } catch {
            // Sidecar ledger must never crash executor.
          }
        });
      }

      this.traceCollectors.delete(runId);

      this.emit({
        type: "agent.run.finished",
        root: base,
        requirementId: id,
        runId,
        action: input.action,
        harness: target.harness,
        model: target.model,
        ...(job.effectiveModel ? { effectiveModel: job.effectiveModel } : {}),
        ...(job.modelFallback ? { modelFallback: true } : {}),
        status,
        rateLimited,
        errorSummary,
        exitCode,
        durationMs,
        metrics: {
          ...traceSummary,
          quotaPool: poolInfo.quotaPool,
          billingMode: poolInfo.billingMode,
          specChanged,
          codeChanged,
        },
        at: endedAt,
      });
      this.emit({
        type: "workbench.updated",
        root: base,
        requirementId: id,
        runId,
        at: endedAt,
      });

      const alreadyRunning = () =>
        this.getActiveRuns(base).some((r) => r.requirementId === id && (r.action === "ask") === isAskTrack);

      if (shouldFallbackFromRpc && !alreadyRunning()) {
        void this.startRun({
          ...input,
          harness: target.harness,
          model: target.model,
          reasoningEffort: target.reasoningEffort,
          disableRpcStdio: true,
          isInternalRetry: true,
        }).catch(() => {});
        return;
      }

      if (shouldRetryPlainText && !alreadyRunning()) {
        void this.startRun({
          ...input,
          harness: target.harness,
          model: target.model,
          reasoningEffort: target.reasoningEffort,
          forcePlainText: true,
          isInternalRetry: true,
        }).catch(() => {});
        return;
      }

      if (sessionExpired && !alreadyRunning()) {
        void this.startRun({
          ...input,
          forceFreshSession: true,
          isInternalRetry: true,
        }).catch(() => {});
        return;
      }

      if (canRescueReviewFormat && nativeSessionId && !alreadyRunning()) {
        void this.startRun({
          root: base,
          requirementId: id,
          action: "review",
          isAutoReview: input.isAutoReview,
          ...(input.reviewFixCycle !== undefined ? { reviewFixCycle: input.reviewFixCycle } : {}),
          ...(input.dispatchReasonOverride ? { dispatchReasonOverride: input.dispatchReasonOverride } : {}),
          reviewFormatRescue: {
            sessionId: nativeSessionId,
            harness: target.harness,
            model: target.model,
            reasoningEffort: target.reasoningEffort,
          },
        }).catch(() => {});
        return;
      }

      if (bugPausedReason && postRunDetail?.state.kind === "bug" && postRunDetail.state.stage === "coding") {
        await setRequirementNeedsHuman(
          base,
          id,
          { source: "bug_pause", reason: bugPausedReason, at: Date.now() },
          snap?.fingerprint ?? null,
        ).catch(() => null);
        this.emit({ type: "workbench.updated", root: base, requirementId: id, runId, at: Date.now() });
        return;
      }

      if (unrelatedTimeoutFiles && unrelatedTimeoutFiles.length > 0 && postRunDetail?.state.stage === "coding") {
        await setRequirementNeedsHuman(
          base,
          id,
          {
            source: "env_failure",
            reason: `全量验证仅在无关测试文件发生超时波动（${unrelatedTimeoutFiles.join("、")}），已跳过自动修复以避免越界修改，请核查环境或重跑验证`,
            at: Date.now(),
          },
          snap?.fingerprint ?? null,
        ).catch(() => null);
        this.emit({ type: "workbench.updated", root: base, requirementId: id, runId, at: Date.now() });
        return;
      }

      const isHarnessRunnable = (hId: string, availHarnesses: HarnessInfo[]): boolean =>
        availHarnesses.some((h) => h.id === hId && h.installed) || Boolean(this.commandBuilder);

      // Deterministic Auto-Heal: strictly stays within the current tier (never silently escalates to SOTA).
      // Anti-Loop (WB-16): 1st fix resumes native session; 2nd fix forces fresh_handoff to break fixation.
      // During a review `block` remediation cycle (WB-14), cap test-failure rescue to at most 1 attempt.
      const healAttempt = input.autoHealAttempt ?? 0;
      const reviewFixCycle = input.reviewFixCycle ?? 0;
      const maxHealAttempts = reviewFixCycle > 0 ? 1 : MAX_AUTO_HEAL_ATTEMPTS;
      if (autoHealPending && healAttempt < maxHealAttempts) {
        const budgetCheck = postRunDetail ? checkAutoLoopBudget(postRunDetail) : { exceeded: false };
        if (budgetCheck.exceeded && postRunDetail?.state.stage === "coding") {
          await setRequirementNeedsHuman(
            base,
            id,
            {
              source: reviewFixCycle > 0 ? "review_loop_exhausted" : "auto_heal_exhausted",
              reason: budgetCheck.reason ?? "自动闭环已达预算上限，请人工接管",
              at: Date.now(),
            },
            snap?.fingerprint ?? null,
          ).catch(() => null);
          this.emit({ type: "workbench.updated", root: base, requirementId: id, runId, at: Date.now() });
          return;
        }
        try {
          const latestRouting = this.resolveProjectRouting(base);
          if (latestRouting.autoHeal !== false && !alreadyRunning()) {
            const nextHealAttempt = healAttempt + 1;
            void this.startRun({
              root: base,
              requirementId: id,
              action: "fix",
              autoHealAttempt: nextHealAttempt,
              ...(reviewFixCycle > 0 ? { reviewFixCycle } : {}),
              ...(nextHealAttempt >= 2 ? { forceFreshSession: true } : {}),
            }).catch(() => {});
            return;
          }
        } catch {
          // Ignore routing errors on auto-heal.
        }
      } else if (autoHealPending && healAttempt >= maxHealAttempts && postRunDetail?.state.stage === "coding") {
        // WB-19 / FLOW §3.1: explicitly escalate to `needs_human` once auto-heal or review-fix rescue budget is exhausted.
        const blockersSummary = postRunDetail.validity.acceptanceGate.blockers.slice(0, 3).join("；");
        const reason =
          reviewFixCycle > 0
            ? `审查阻断修复后的验证抢救已达上限（1 次）仍未通过${blockersSummary ? `：${blockersSummary}` : ""}`
            : `自动自愈已达上限（${maxHealAttempts} 次）仍未通过验证${blockersSummary ? `：${blockersSummary}` : ""}`;
        await setRequirementNeedsHuman(
          base,
          id,
          {
            source: reviewFixCycle > 0 ? "review_loop_exhausted" : "auto_heal_exhausted",
            reason,
            at: Date.now(),
          },
          snap?.fingerprint ?? null,
        ).catch(() => null);
        this.emit({
          type: "workbench.updated",
          root: base,
          requirementId: id,
          runId,
          at: Date.now(),
        });
      }

      // WB-22 / FLOW §1.3: SOTA tier automatically triggers 1 independent heterogeneous design review after design submission.
      if (
        status === "succeeded" &&
        input.action === "design" &&
        postRunDetail &&
        postRunDetail.state.stage === "planning" &&
        postRunDetail.state.tier === "sota" &&
        postRunDetail.state.designHash !== "" &&
        !postRunDetail.state.lastFeedback &&
        postRunDetail.validity.designReviewValidity?.effectiveState !== "current"
      ) {
        try {
          const availHarnesses = await this.getHarnesses(false);
          const latestRouting = this.resolveProjectRouting(base);
          if (latestRouting.autoReview !== false && !alreadyRunning()) {
            const reviewCandidates = resolveRouteCandidates(latestRouting, availHarnesses, "review", tier).filter((c) =>
              isHarnessRunnable(c.harness, availHarnesses),
            );
            const reviewTarget =
              reviewCandidates.find((c) => c.harness !== target.harness) ?? reviewCandidates[0];
            if (reviewTarget) {
              void this.startRun({
                root: base,
                requirementId: id,
                action: "review",
                harness: reviewTarget.harness,
                model: reviewTarget.model,
                ...(reviewTarget.reasoningEffort ? { reasoningEffort: reviewTarget.reasoningEffort } : {}),
                isAutoReview: true,
                dispatchReasonOverride: "auto_design_review",
              }).catch(() => {});
              return;
            }
          }
        } catch {
          // Ignore routing errors on auto design review.
        }
      }

      // Capped 1-round `block` auto-remediation loop (WB-14 / FLOW §3.2):
      // Initial auto-review returning `block` -> 1 same-tier `fix` -> verify (max 1 rescue) -> 1 automatic re-review -> stop.
      // WB-22: design reviews (`isDesignReview`) NEVER auto-remediate or escalate to needs_human.
      if (
        status === "succeeded" &&
        input.action === "review" &&
        !isDesignReview &&
        input.isAutoReview === true &&
        parsedReview?.verdict === "block" &&
        reviewFixCycle < 1 &&
        postRunDetail &&
        postRunDetail.state.stage === "coding"
      ) {
        const budgetCheck = checkAutoLoopBudget(postRunDetail);
        if (budgetCheck.exceeded) {
          await setRequirementNeedsHuman(
            base,
            id,
            {
              source: "review_loop_exhausted",
              reason: budgetCheck.reason ?? "自动审查修复闭环已达预算上限，请人工接管",
              at: Date.now(),
            },
            snap?.fingerprint ?? null,
          ).catch(() => null);
          this.emit({ type: "workbench.updated", root: base, requirementId: id, runId, at: Date.now() });
          return;
        }
        try {
          const latestRouting = this.resolveProjectRouting(base);
          if (latestRouting.autoReview !== false && latestRouting.autoHeal !== false && !alreadyRunning()) {
            void this.startRun({
              root: base,
              requirementId: id,
              action: "fix",
              reviewFixCycle: 1,
              dispatchReasonOverride: "auto_review_fix",
            }).catch(() => {});
            return;
          }
        } catch {
          // Ignore routing errors on auto review fix.
        }
      } else if (
        status === "succeeded" &&
        input.action === "review" &&
        input.isAutoReview === true &&
        parsedReview &&
        parsedReview.verdict !== "pass" &&
        reviewFixCycle >= 1 &&
        postRunDetail &&
        postRunDetail.state.stage === "coding"
      ) {
        // WB-19: 1-round block remediation completed and re-review still did not pass -> escalate to `needs_human`.
        await setRequirementNeedsHuman(
          base,
          id,
          {
            source: "review_loop_exhausted",
            reason: `自动审查修复闭环（1 轮）后复审结论仍为 ${parsedReview.verdict}：${parsedReview.summary.slice(0, 240)}`,
            at: Date.now(),
          },
          snap?.fingerprint ?? null,
        ).catch(() => null);
        this.emit({
          type: "workbench.updated",
          root: base,
          requirementId: id,
          runId,
          at: Date.now(),
        });
      }

      // Automatic cross-model review (initial review once automated commands pass, or 1-shot re-review closing reviewFixCycle=1).
      // WB-21 / FLOW §3.2: auto-review runs for `plan_first` AND `kind: "bug"`, decoupled from regular `feature + fast_track`.
      if (
        status === "succeeded" &&
        (input.action === "implement" || input.action === "fix") &&
        readyForReview &&
        !noCodeChange &&
        postRunDetail &&
        (postRunDetail.state.track !== "fast_track" || postRunDetail.state.kind === "bug") &&
        postRunDetail.state.stage === "coding" &&
        postRunDetail.validity.approval.valid &&
        postRunDetail.validity.reviewValidity.effectiveState !== "current"
      ) {
        try {
          const availHarnesses = await this.getHarnesses(false);
          const latestRouting = this.resolveProjectRouting(base);
          const alreadyReviewedOnce = Boolean(
            postRunDetail.state.reviewReport &&
              postRunDetail.state.reviewReport.reviewedAt >= (postRunDetail.state.approval?.approvedAt ?? 0),
          );
          const isClosingReviewFixCycle = reviewFixCycle === 1;
          if (latestRouting.autoReview !== false && (!alreadyReviewedOnce || isClosingReviewFixCycle)) {
            const reviewCandidates = resolveRouteCandidates(latestRouting, availHarnesses, "review", tier).filter((c) =>
              isHarnessRunnable(c.harness, availHarnesses),
            );
            const priorReview = postRunDetail.state.reviewReport;
            const sameReviewerTarget =
              isClosingReviewFixCycle && priorReview
                ? reviewCandidates.find(
                    (c) =>
                      c.harness === priorReview.reviewerHarness &&
                      c.model === priorReview.reviewerModel &&
                      !isModelCoolingDown(c.harness, c.model),
                  )
                : undefined;
            const reviewTarget =
              sameReviewerTarget ??
              reviewCandidates.find((c) => c.harness !== target.harness) ??
              reviewCandidates[0];
            if (reviewTarget && !alreadyRunning()) {
              void this.startRun({
                root: base,
                requirementId: id,
                action: "review",
                harness: reviewTarget.harness,
                model: reviewTarget.model,
                ...(reviewTarget.reasoningEffort ? { reasoningEffort: reviewTarget.reasoningEffort } : {}),
                isAutoReview: true,
                ...(isClosingReviewFixCycle
                  ? { reviewFixCycle: 1, dispatchReasonOverride: "auto_re_review" as const }
                  : { reviewFixCycle: 0 }),
              }).catch(() => {});
            }
          }
        } catch {
          // Ignore routing errors on auto-review.
        }
      }

      // Bounded multi-hop automatic fallback within the SAME tier's fallbacks on 429 / model unavailable.
      // Skips any model already tried AND any quota pool already hit by rateLimit in this chain.
      const attempt = input.autoFallbackAttempt ?? 0;
      const isExplicitOverride = Boolean(input.harness && input.model) && attempt === 0;
      const shouldAutoFallback =
        status === "failed" &&
        !job.cancelled &&
        !job.timedOut &&
        attempt < MAX_AUTO_FALLBACK_ATTEMPTS &&
        ((!isExplicitOverride && (modelUnavailable || rateLimited)) ||
          (input.isAutoReview === true && (reviewParseFailed || modelUnavailable || rateLimited)));

      let dispatchedFallback = false;
      if (shouldAutoFallback && !alreadyRunning()) {
        try {
          const availHarnesses = await this.getHarnesses(false);
          const latestRouting = this.resolveProjectRouting(base);
          const fallbackPool = resolveRouteCandidates(latestRouting, availHarnesses, input.action, tier);
          const nextFailedTargets = Array.from(
            new Set([...(input.failedTargets ?? []), `${target.harness}::${target.model}`]),
          );
          const nextFailedPools = rateLimited
            ? Array.from(new Set([...(input.failedQuotaPools ?? []), poolInfo.quotaPool]))
            : [...(input.failedQuotaPools ?? [])];
          const fallbackCandidate = fallbackPool.find((c) => {
            const key = `${c.harness}::${c.model}`;
            if (nextFailedTargets.includes(key)) return false;
            const cPool = resolveQuotaPool(c.harness, c.model).quotaPool;
            if (nextFailedPools.includes(cPool)) return false;
            return isHarnessRunnable(c.harness, availHarnesses);
          });
          if (fallbackCandidate) {
            dispatchedFallback = true;
            void this.startRun({
              ...input,
              harness: fallbackCandidate.harness,
              model: fallbackCandidate.model,
              reasoningEffort: fallbackCandidate.reasoningEffort,
              useFallback: true,
              ...(rateLimited ? { forceFreshSession: true } : {}),
              autoFallbackAttempt: attempt + 1,
              failedTargets: nextFailedTargets,
              failedQuotaPools: nextFailedPools,
              ...(input.dispatchReasonOverride ? {} : { dispatchReasonOverride: "auto_fallback" }),
            }).catch(() => {});
          }
        } catch {
          // Ignore routing errors on auto-fallback.
        }
      }

      if (
        !dispatchedFallback &&
        status === "failed" &&
        !job.cancelled &&
        !job.timedOut &&
        (rateLimited || modelUnavailable) &&
        postRunDetail &&
        (postRunDetail.state.stage === "coding" || postRunDetail.state.stage === "planning") &&
        !alreadyRunning()
      ) {
        await setRequirementNeedsHuman(
          base,
          id,
          {
            source: "env_failure",
            reason: `模型 ${target.harness}/${target.model} 额度不足或不可用，且所有可用备援池均已耗尽，请检查额度或切换路由后重试`,
            at: Date.now(),
          },
          snap?.fingerprint ?? null,
        ).catch(() => null);
        this.emit({ type: "workbench.updated", root: base, requirementId: id, runId, at: Date.now() });
      }
    };

    if (acpHandle) {
      void acpHandle.done.then((res) => {
        if (res.sessionId) capturedSessionId = res.sessionId;
        void finalize(res.exitCode, undefined, {
          errorMessage: res.errorMessage,
          handshakeFailed: res.handshakeFailed,
        }).finally(() => {
          this.killProcessGroup(job);
        });
      });
    }

    child.on("error", (err) => {
      void finalize(1, err.message);
    });
    child.on("close", (code) => {
      if (acpHandle && !finalized) {
        // Wait for acpHandle.done if stdout/protocol is finishing; fallback if it crashed early.
        setTimeout(() => {
          if (!finalized) void finalize(code);
        }, 50);
        return;
      }
      void finalize(code);
    });

    return { run: record, detail, target };
    } catch (err) {
      codeRootLockLease?.release();
      throw err;
    }
  }

  private killProcessGroup(job: ActiveJob): void {
    try {
      job.child.stdout?.destroy();
      job.child.stderr?.destroy();
    } catch {
      // Ignore stream destroy errors.
    }
    try {
      if (process.platform !== "win32" && job.child.pid) {
        process.kill(-job.child.pid, "SIGTERM");
      } else {
        job.child.kill("SIGTERM");
      }
    } catch {
      // Ignore already exited process.
    }
    job.killTimer = setTimeout(() => {
      try {
        if (process.platform !== "win32" && job.child.pid) {
          process.kill(-job.child.pid, "SIGKILL");
        } else {
          job.child.kill("SIGKILL");
        }
      } catch {
        // Already gone.
      }
    }, 150);
    job.killTimer.unref?.();
  }

  cancelRun(runId: string): boolean {
    const job = this.activeJobs.get(runId);
    if (!job) return false;
    job.cancelled = true;
    job.onCancel?.();
    this.killProcessGroup(job);
    return true;
  }

  async recoverOrphanedRuns(roots: string[]): Promise<Array<{ root: string; requirementId: string; runId: string }>> {
    const recovered: Array<{ root: string; requirementId: string; runId: string }> = [];
    const seenRoots = new Set<string>();
    const now = Date.now();

    for (const rawRoot of roots) {
      let base: string;
      try {
        base = canonicalRoot(rawRoot);
      } catch {
        continue;
      }
      if (seenRoots.has(base)) continue;
      seenRoots.add(base);

      let summaries: ReturnType<typeof listRequirements>;
      try {
        summaries = listRequirements(base, { scope: "active" });
      } catch {
        continue;
      }

      for (const summary of summaries) {
        let detail: RequirementDetail;
        try {
          detail = getRequirement(base, summary.id);
        } catch {
          continue;
        }
        const staleRuns = (detail.state.agentRuns ?? []).filter((run) => {
          if (run.status !== "running") return false;
          if (this.activeJobs.has(run.id) || globalActiveRunIds.has(run.id)) return false;
          if (typeof run.hubPid === "number") {
            return run.hubPid === process.pid || !isProcessAlive(run.hubPid);
          }
          return now - run.startedAt > ORPHAN_LEGACY_GRACE_MS;
        });

        for (const run of staleRuns) {
          const logFile = path.join(base, WORKBENCH_DIR, "items", summary.id, run.logPath);
          let existingLog = "";
          try {
            if (fs.existsSync(logFile)) {
              existingLog = readBoundedText(logFile, MAX_RUN_LOG_BYTES);
            }
          } catch {
            existingLog = "";
          }
          const note = "[workbench] 宿主进程已重启或异常退出，孤儿运行已自动回收。\n";
          const rawLog = existingLog.includes(note.trim()) ? existingLog : `${existingLog}${existingLog.endsWith("\n") || !existingLog ? "" : "\n"}${note}`;
          const endedAt = Date.now();
          const errorSummary = "运行宿主已重启或异常退出（孤儿运行已自动回收）";
          try {
            await finishAgentRun(
              base,
              summary.id,
              run.id,
              {
                status: "failed",
                endedAt,
                exitCode: null,
                durationMs: Math.max(0, endedAt - run.startedAt),
                errorSummary,
              },
              rawLog,
            );
            recovered.push({ root: base, requirementId: summary.id, runId: run.id });
            this.emit({
              type: "agent.run.finished",
              root: base,
              requirementId: summary.id,
              runId: run.id,
              action: run.action,
              harness: run.harness,
              model: run.model,
              status: "failed",
              errorSummary,
              exitCode: null,
              durationMs: Math.max(0, endedAt - run.startedAt),
              at: endedAt,
            });
            this.emit({
              type: "workbench.updated",
              root: base,
              requirementId: summary.id,
              runId: run.id,
              at: endedAt,
            });
          } catch {
            // Best-effort recovery.
          }
        }
      }
    }

    return recovered;
  }

  stopAllRuns(): void {
    this.refreshAbortController?.abort();
    this.refreshAbortController = null;
    for (const job of this.activeJobs.values()) {
      job.cancelled = true;
      this.killProcessGroup(job);
    }
  }
}
