import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { discoverProjectContext } from "../core/context.ts";
import {
  addDiscussion,
  finishAgentRun,
  getAgentRunContext,
  getProjectStatus,
  getRequirement,
  listRequirements,
  recordReviewReport,
  resolveDiscussions,
  saveAgentRunContext,
  startAgentRun,
} from "../core/engine.ts";
import { WorkbenchError } from "../core/errors.ts";
import { canonicalRoot, isProcessAlive, readBoundedText, resolveSafePath } from "../core/fs.ts";
import { extractMergeConflictContext, observeGitSnapshot } from "../core/git.ts";
import { resolveCodeRoot } from "../core/sandbox.ts";
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
  type RunTraceEvent,
} from "../core/types.ts";
import { clipHeadTailUtf8, sanitizeOutput } from "../core/validate.ts";
import { evaluateApproval } from "../core/validity.ts";
import {
  inspectSandboxDrift,
  prepareSandboxConflictResolution,
  reconcileSandboxBaseline,
  syncRequirementMirrorToSandbox,
} from "../core/worktree.ts";
import { discoverHarnesses, discoverHarnessesQuick, getLocalCatalogFingerprint } from "./discovery.ts";
import { synthesizeHandoffPacket, type ConflictHandoffContext } from "./handoff.ts";
import {
  buildHarnessCommand,
  buildOpencodeNonInteractiveConfig,
  ensureWbShim,
  isSessionExpiredError,
  NON_FATAL_FORM_CANCEL_RE,
  resolveRunTimeouts,
  type BuiltCommand,
  type CustomCommandBuilder,
  type TimeoutReason,
} from "./harness_cmd.ts";
import { appendRunLedger, type RunLedgerEntry } from "./ledger.ts";
import { parseReviewOutput, runCodingPostGate, syncDesignRunResult } from "./post_run.ts";
import { estimateTokens, resolveModelSpec, resolveQuotaPool } from "./pricing.ts";
import { buildExecutionPrompt } from "./prompt.ts";
import { readHubConfig } from "./registry.ts";
import {
  detectModelUnavailableError,
  detectRateLimitOrQuotaError,
  normalizeRoutingConfig,
  resolveRouteCandidates,
} from "./routing.ts";
import { createHarnessStreamAdapter, isUnsupportedJsonFlagError, stripCliNoise } from "./stream_adapters.ts";
import { isModelCoolingDown, recordModelRunOutcome } from "./telemetry.ts";
import { RunTraceCollector } from "./trace_collector.ts";
import type { HarnessId, HarnessInfo, HubObservabilityConfig, ModelTarget, RoutingConfig } from "./types.ts";

export { buildExecutionPrompt } from "./prompt.ts";
export {
  buildHarnessCommand,
  buildOpencodeNonInteractiveConfig,
  resolveRunTimeouts,
  type BuiltCommand,
  type CustomCommandBuilder,
  type TimeoutReason,
} from "./harness_cmd.ts";

export interface RunExecutorEvent {
  type:
    | "agent.run.started"
    | "agent.run.output"
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
  mode?: "ask" | "refine";
  useFallback?: boolean;
  autoFallbackAttempt?: number;
  autoHealAttempt?: number;
  forcePlainText?: boolean;
  forceFreshSession?: boolean;
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
  contextWindow: number;
  tracePath: string;
  contextPath: string;
  child: ChildProcess;
  startedAt: number;
  cancelled: boolean;
  timedOut: boolean;
  timeoutReason: TimeoutReason | null;
  killTimer?: ReturnType<typeof setTimeout>;
}

const ORPHAN_LEGACY_GRACE_MS = 5_000;
const MAX_AUTO_HEAL_ATTEMPTS = 2;
const globalActiveRunIds = new Set<string>();

function isHealthyForNativeResume(candidate: AgentRunRecord | null | undefined): boolean {
  if (!candidate || !candidate.nativeSessionId) return false;
  if (candidate.status === "cancelled" || candidate.rateLimited) return false;
  if (candidate.errorSummary?.includes("模型不可用")) return false;
  return true;
}

export type TelemetryOutcomeInput = Parameters<typeof recordModelRunOutcome>[0];

export class HubExecutor {
  private readonly activeJobs = new Map<string, ActiveJob>();
  private readonly runLogs = new Map<string, string>();
  private readonly traceCollectors = new Map<string, RunTraceCollector>();
  private readonly plainTextFallbackHarnesses = new Set<HarnessId>();
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

    for (const job of this.activeJobs.values()) {
      if (job.root === base && job.requirementId === id) {
        throw new WorkbenchError(
          "revision_conflict",
          `${id} 当前已有正在执行的 Agent 任务（${job.target.harness}/${job.target.model}），请等待完成或先终止`,
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
    if (input.useFallback && prevRun) {
      const next = candidates.find((c) => `${c.harness}::${c.model}` !== `${prevRun.harness}::${prevRun.model}`);
      if (next) target = next;
    }

    // Persist human discussion/annotation if supplied before execution (skip on automatic retries)
    if (
      input.message?.trim() &&
      !(input.autoFallbackAttempt && input.autoFallbackAttempt > 0) &&
      !input.forcePlainText &&
      !input.forceFreshSession &&
      !input.reviewFormatRescue &&
      (input.action === "ask" || input.mode === "refine" || input.action === "design")
    ) {
      await addDiscussion(base, id, {
        actor: "human",
        mode: input.action === "ask" ? "ask" : "refine",
        message: input.message.trim(),
        anchor: input.anchor,
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
    });

    // Native session resume across design -> implement -> fix on the same harness.
    const prevLeadRun =
      input.action === "review"
        ? null
        : input.action === "implement" || input.action === "fix"
          ? ([...runsList].reverse().find((r) => r.action === "implement" || r.action === "fix") ??
            [...runsList].reverse().find((r) => r.action === "design") ??
            [...runsList].reverse().find((r) => r.action !== "review") ??
            null)
          : ([...runsList].reverse().find((r) => r.action === input.action) ?? null);

    const canResumeSameHarness = Boolean(
      input.reviewFormatRescue ||
        (!input.useFallback &&
          !input.forceFreshSession &&
          prevLeadRun &&
          prevLeadRun.harness === target.harness &&
          isHealthyForNativeResume(prevLeadRun) &&
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
      try {
        previousSpecHash = getAgentRunContext(base, id, prevLeadRun.id)?.specHashBefore ?? null;
      } catch {
        previousSpecHash = null;
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
          },
        );

    const structuredJsonEnabled =
      !input.forcePlainText && !this.plainTextFallbackHarnesses.has(target.harness);
    const allowResumeOnReview = Boolean(input.reviewFormatRescue);
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
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${shimBin}:${process.env.PATH ?? ""}`,
      WORKBENCH_ROOT: base,
      WORKBENCH_REQ_ID: id,
      WORKBENCH_HUB_PID: String(process.pid),
      WORKBENCH_OUTPUT_LANGUAGE: outputLanguage,
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

    const initialCmdLine = `$ ${built.displayCommand}\n`;
    this.runLogs.set(runId, initialCmdLine);
    appendDiskLog(initialCmdLine);
    const child = spawn(built.command, built.args, {
      cwd: codeRoot,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
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
      contextWindow: modelSpec.contextWindow,
      tracePath: traceRelPath,
      contextPath: contextRelPath,
      child,
      startedAt,
      cancelled: false,
      timedOut: false,
      timeoutReason: null,
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

    child.stdout?.on("data", (buf: Buffer) => {
      if (buf.length > 0) resetIdleTimer();
      stdoutLineBuf += buf.toString("utf8");
      const lines = stdoutLineBuf.split(/\r?\n/);
      stdoutLineBuf = lines.pop() ?? "";
      for (const line of lines) {
        handleAdapterResult(streamAdapter.feedLine(line), true);
      }
    });

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

    const finalize = async (exitCode: number | null, spawnErr?: string) => {
      if (finalized) return;
      finalized = true;
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(maxDurationTimer);
      if (livenessTimer) clearInterval(livenessTimer);
      if (job.killTimer) clearTimeout(job.killTimer);
      this.activeJobs.delete(runId);
      globalActiveRunIds.delete(runId);

      if (stdoutLineBuf.trim()) {
        handleAdapterResult(streamAdapter.feedLine(stdoutLineBuf), false);
        stdoutLineBuf = "";
      }
      const flushed = streamAdapter.flush();
      if (flushed) handleAdapterResult(flushed);

      const endedAt = Date.now();
      const durationMs = Math.max(0, endedAt - startedAt);
      const assembledLog = (this.runLogs.get(runId) ?? "") + (spawnErr ? `\n[spawn error] ${spawnErr}\n` : "");
      let rawLog =
        Buffer.byteLength(assembledLog, "utf8") > MAX_RUN_LOG_BYTES
          ? clipHeadTailUtf8(assembledLog, 1_500_000, 2_500_000).text
          : assembledLog;
      this.runLogs.set(runId, rawLog);

      const rateLimited = !job.cancelled && !job.timedOut && detectRateLimitOrQuotaError(rawLog, exitCode);
      const modelUnavailable = !job.cancelled && !job.timedOut && detectModelUnavailableError(rawLog, exitCode);
      const sessionExpired =
        canResumeSameHarness &&
        !input.forceFreshSession &&
        !job.cancelled &&
        !job.timedOut &&
        !spawnErr &&
        isSessionExpiredError(rawLog, exitCode);
      const shouldRetryPlainText =
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

      let snap: Awaited<ReturnType<typeof observeGitSnapshot>> = null;
      let latestReq: RequirementDetail | null = null;
      try {
        if (codeRoot !== base) {
          await reconcileSandboxBaseline(base, id).catch(() => null);
        }
        snap = await observeGitSnapshot(codeRoot);
        latestReq = getRequirement(base, id, { currentCodeSnapshotHash: snap?.fingerprint ?? null });
      } catch {
        // Ignore git/requirement read errors during finalize pre-observation.
      }

      let status: AgentRunRecord["status"] = job.cancelled
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
      const parsedReview =
        status === "succeeded" && input.action === "review" ? parseReviewOutput(replySource) : null;
      if (
        parsedReview &&
        parsedReview.verdict === "concern" &&
        Array.isArray(parsedReview.findings) &&
        parsedReview.findings.length > 0 &&
        parsedReview.findings.every((f) => f.severity === "low")
      ) {
        parsedReview.verdict = "pass";
      }
      const reviewParseFailed = status === "succeeded" && input.action === "review" && parsedReview === null;
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
      const nativeSessionId = capturedSessionId ?? matchedSessionId;
      const canRescueReviewFormat =
        reviewParseFailed &&
        !input.reviewFormatRescue &&
        Boolean(nativeSessionId) &&
        replySource.length > 80;

      const errorSummary =
        status === "failed"
          ? shouldRetryPlainText
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
                      : (spawnErr || rawLog.trim().split(/\r?\n/).slice(-3).join(" | ").slice(0, 300) || `退出码 ${exitCode}`)
          : undefined;
      const codeChanged = (snap?.fingerprint ?? null) !== (snapshotBefore?.fingerprint ?? null);

      const appendFinalizeNote = (line: string) => {
        emitCleanChunk(line);
        rawLog = this.runLogs.get(runId) ?? rawLog;
      };

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

      // 2. Deterministic Post-Coding Gate (auto-verify + auto-screenshot + auto-heal signal)
      let autoHealPending = false;
      let readyForReview = false;
      if (
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
          latestReq,
          snap,
          appendNote: appendFinalizeNote,
        });
        latestReq = gateResult.latestReq;
        snap = gateResult.snap;
        autoHealPending = gateResult.autoHealPending;
        readyForReview = gateResult.readyForReview;
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
              anchor: input.anchor,
              harness: target.harness,
              model: target.model,
              message: answerText,
            });
          }
        } else if (status === "succeeded" && input.action === "review" && snap?.fingerprint && parsedReview && latestReq) {
          await recordReviewReport(base, id, {
            reviewerHarness: target.harness,
            reviewerModel: target.model,
            verdict: parsedReview.verdict,
            summary: parsedReview.summary,
            markdown: parsedReview.markdown,
            ...(parsedReview.findings ? { findings: parsedReview.findings } : {}),
            reviewedSpecHash: latestReq.state.specHash,
            reviewedCodeSnapshotHash: snap.fingerprint,
          });
        } else if (status === "succeeded" && (input.mode === "refine" || (input.anchorIds && input.anchorIds.length > 0))) {
          if (input.anchorIds && input.anchorIds.length > 0) {
            await resolveDiscussions(base, id, { ids: input.anchorIds, resolved: true });
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
            codeChanged,
            tracePath: traceRelPath,
            contextPath: contextRelPath,
            ...(traceSummary.traceTruncated ? { traceTruncated: true } : {}),
            ...(traceSummary.healthWarnings?.length ? { healthWarnings: traceSummary.healthWarnings } : {}),
          },
          rawLog,
          snap?.fingerprint ?? null,
        );
        postRunDetail = finishedDetail;

        const lastRunObj = (finishedDetail.state.agentRuns ?? []).find((r) => r.id === runId) ?? null;
        await synthesizeHandoffPacket(base, id, {
          action: input.action,
          previousRun: lastRunObj,
          previousLogTail: rawLog.slice(-1500),
        });
        if (codeRoot !== base) {
          syncRequirementMirrorToSandbox(base, id, codeRoot);
        }
      } catch (error) {
        console.error(
          `[workbench] finalize failed for ${id}/${runId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // Decoupled fire-and-forget telemetry & ledger sidecars
      if (!shouldRetryPlainText && !sessionExpired) {
        queueMicrotask(() => {
          try {
            const outcome: TelemetryOutcomeInput = {
              harness: target.harness,
              model: target.model,
              action: input.action,
              status,
              durationMs,
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

      const alreadyRunning = () => this.getActiveRuns(base).some((r) => r.requirementId === id);

      if (shouldRetryPlainText && !alreadyRunning()) {
        void this.startRun({
          ...input,
          harness: target.harness,
          model: target.model,
          reasoningEffort: target.reasoningEffort,
          forcePlainText: true,
        }).catch(() => {});
        return;
      }

      if (sessionExpired && !alreadyRunning()) {
        void this.startRun({
          ...input,
          forceFreshSession: true,
        }).catch(() => {});
        return;
      }

      if (canRescueReviewFormat && nativeSessionId && !alreadyRunning()) {
        void this.startRun({
          root: base,
          requirementId: id,
          action: "review",
          isAutoReview: input.isAutoReview,
          reviewFormatRescue: {
            sessionId: nativeSessionId,
            harness: target.harness,
            model: target.model,
            reasoningEffort: target.reasoningEffort,
          },
        }).catch(() => {});
        return;
      }

      const isHarnessRunnable = (hId: string, availHarnesses: HarnessInfo[]): boolean =>
        availHarnesses.some((h) => h.id === hId && h.installed) || Boolean(this.commandBuilder);

      // Deterministic Auto-Heal: strictly stays within the current tier (never silently escalates to SOTA).
      const healAttempt = input.autoHealAttempt ?? 0;
      if (autoHealPending && healAttempt < MAX_AUTO_HEAL_ATTEMPTS) {
        try {
          const latestRouting = this.resolveProjectRouting(base);
          if (latestRouting.autoHeal !== false && !alreadyRunning()) {
            void this.startRun({
              root: base,
              requirementId: id,
              action: "fix",
              autoHealAttempt: healAttempt + 1,
            }).catch(() => {});
            return;
          }
        } catch {
          // Ignore routing errors on auto-heal.
        }
      }

      // One-shot blind cross-model review once plan_first coding passes verification.
      if (
        status === "succeeded" &&
        (input.action === "implement" || input.action === "fix") &&
        readyForReview &&
        postRunDetail &&
        postRunDetail.state.track !== "fast_track" &&
        postRunDetail.state.stage === "coding" &&
        postRunDetail.validity.acceptanceGate.ok &&
        postRunDetail.validity.reviewValidity.effectiveState !== "current"
      ) {
        try {
          const availHarnesses = await this.getHarnesses(false);
          const latestRouting = this.resolveProjectRouting(base);
          const alreadyReviewedOnce = Boolean(postRunDetail.state.reviewReport);
          if (latestRouting.autoReview !== false && !alreadyReviewedOnce) {
            const reviewCandidates = resolveRouteCandidates(latestRouting, availHarnesses, "review", tier).filter((c) =>
              isHarnessRunnable(c.harness, availHarnesses),
            );
            const reviewTarget =
              reviewCandidates.find((c) => c.harness !== target.harness) ?? reviewCandidates[0];
            if (reviewTarget && !alreadyRunning()) {
              void this.startRun({
                root: base,
                requirementId: id,
                action: "review",
                harness: reviewTarget.harness,
                model: reviewTarget.model,
                ...(reviewTarget.reasoningEffort ? { reasoningEffort: reviewTarget.reasoningEffort } : {}),
                isAutoReview: true,
              }).catch(() => {});
            }
          }
        } catch {
          // Ignore routing errors on auto-review.
        }
      }

      // Bounded single-hop automatic fallback within the SAME tier's fallbacks on 429 / model unavailable.
      const attempt = input.autoFallbackAttempt ?? 0;
      const isExplicitOverride = Boolean(input.harness && input.model);
      const shouldAutoFallback =
        status === "failed" &&
        !job.cancelled &&
        !job.timedOut &&
        attempt < 1 &&
        ((!isExplicitOverride && (modelUnavailable || (rateLimited && durationMs < 60_000))) ||
          (input.isAutoReview === true && (reviewParseFailed || modelUnavailable || rateLimited)));

      if (shouldAutoFallback && !alreadyRunning()) {
        try {
          const availHarnesses = await this.getHarnesses(false);
          const latestRouting = this.resolveProjectRouting(base);
          const fallbackPool = resolveRouteCandidates(latestRouting, availHarnesses, input.action, tier);
          const fallbackCandidate = fallbackPool.find(
            (c) =>
              `${c.harness}::${c.model}` !== `${target.harness}::${target.model}` &&
              isHarnessRunnable(c.harness, availHarnesses),
          );
          if (fallbackCandidate) {
            void this.startRun({
              ...input,
              harness: undefined,
              model: undefined,
              reasoningEffort: undefined,
              useFallback: true,
              autoFallbackAttempt: attempt + 1,
            }).catch(() => {});
          }
        } catch {
          // Ignore routing errors on auto-fallback.
        }
      }
    };

    child.on("error", (err) => {
      void finalize(1, err.message);
    });
    child.on("close", (code) => {
      void finalize(code);
    });

    return { run: record, detail, target };
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
