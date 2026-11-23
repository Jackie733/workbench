import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { discoverProjectContext } from "../core/context.ts";
import {
  addDiscussion,
  finishAgentRun,
  getProjectStatus,
  getRequirement,
  listRequirements,
  markDesigning,
  recordReviewReport,
  resolveDiscussions,
  saveAgentRunContext,
  startAgentRun,
} from "../core/engine.ts";
import { WorkbenchError } from "../core/errors.ts";
import { atomicWriteFile, canonicalRoot, isProcessAlive, readBoundedText, resolveSafePath } from "../core/fs.ts";
import { extractMergeConflictContext, observeGitSnapshot } from "../core/git.ts";
import {
  buildOutputLanguageDirective,
  buildResumeLanguageReminder,
  type ResolvedOutputLanguage,
} from "../core/language.ts";
import { resolveCodeRoot } from "../core/sandbox.ts";
import {
  MAX_RUN_LOG_BYTES,
  WORKBENCH_DIR,
  type AgentAction,
  type AgentRunRecord,
  type OutputLanguage,
  type RequirementDetail,
  type ReviewFinding,
  type ReviewVerdict,
  type RunBillingMode,
  type RunContextSnapshot,
  type RunDispatchReason,
  type RunHandoffMode,
  type RunTraceEvent,
} from "../core/types.ts";
import { clipHeadTailUtf8, sanitizeOutput } from "../core/validate.ts";
import { evaluateApproval } from "../core/validity.ts";
import { discoverHarnesses, discoverHarnessesQuick, getLocalCatalogFingerprint } from "./discovery.ts";
import {
  inspectFinishedRunForPainPoints,
  inspectRsiSandboxDrift,
  prepareSandboxConflictResolution,
  reconcileRsiSandboxBaseline,
  syncRequirementMirrorToSandbox,
  type EvolutionPainPoint,
  type PainPointReportInput,
} from "./evolution.ts";
import { synthesizeHandoffPacket, type ConflictHandoffContext } from "./handoff.ts";
import { appendRunLedger, type RunLedgerEntry } from "./ledger.ts";
import { estimateTokens, resolveModelSpec, resolveQuotaPool } from "./pricing.ts";
import { readHubConfig, resolveHubDir } from "./registry.ts";
import { detectModelUnavailableError, detectRateLimitOrQuotaError, resolveRouteCandidates } from "./routing.ts";
import { createHarnessStreamAdapter, isUnsupportedJsonFlagError, stripCliNoise } from "./stream_adapters.ts";
import { isModelCoolingDown, recordModelRunOutcome } from "./telemetry.ts";
import { RunTraceCollector } from "./trace_collector.ts";
import type { HarnessId, HarnessInfo, HubObservabilityConfig, ModelTarget, RoutingConfig } from "./types.ts";

export interface BuiltCommand {
  command: string;
  args: string[];
  displayCommand: string;
}

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
  forcePlainText?: boolean;
  isAutoReview?: boolean;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  resolveConflict?: boolean;
}

export type TimeoutReason = "idle" | "max_duration";

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

const ACTION_TIMEOUT_DEFAULTS: Record<AgentAction, { idleTimeoutMs: number; maxDurationMs: number }> = {
  ask: { idleTimeoutMs: 5 * 60_000, maxDurationMs: 20 * 60_000 },
  design: { idleTimeoutMs: 10 * 60_000, maxDurationMs: 60 * 60_000 },
  review: { idleTimeoutMs: 10 * 60_000, maxDurationMs: 60 * 60_000 },
  implement: { idleTimeoutMs: 15 * 60_000, maxDurationMs: 2 * 60 * 60_000 },
  fix: { idleTimeoutMs: 15 * 60_000, maxDurationMs: 2 * 60 * 60_000 },
};

/** Resolves sliding inactivity watchdog and protective wall-clock ceiling for a run. */
export function resolveRunTimeouts(
  action: AgentAction,
  overrides: { timeoutMs?: number; idleTimeoutMs?: number } = {},
): { idleTimeoutMs: number; maxDurationMs: number } {
  const defaults = ACTION_TIMEOUT_DEFAULTS[action] ?? ACTION_TIMEOUT_DEFAULTS.implement;
  const maxDurationMs =
    typeof overrides.timeoutMs === "number" && Number.isFinite(overrides.timeoutMs) && overrides.timeoutMs > 0
      ? Math.floor(overrides.timeoutMs)
      : defaults.maxDurationMs;
  const rawIdle =
    typeof overrides.idleTimeoutMs === "number" && Number.isFinite(overrides.idleTimeoutMs) && overrides.idleTimeoutMs > 0
      ? Math.floor(overrides.idleTimeoutMs)
      : Math.min(defaults.idleTimeoutMs, maxDurationMs);
  return {
    idleTimeoutMs: Math.min(rawIdle, maxDurationMs),
    maxDurationMs,
  };
}

export type CustomCommandBuilder = (
  target: ModelTarget,
  ctx: {
    root: string;
    requirementId: string;
    action: AgentAction;
    prompt: string;
    nativeSessionId?: string;
    harnesses: HarnessInfo[];
    structuredJson?: boolean;
  },
) => BuiltCommand;

function ensureWbShim(cliEntryPath: string): string {
  const binDir = path.join(resolveHubDir(), "bin");
  fs.mkdirSync(binDir, { recursive: true, mode: 0o755 });
  const shimPath = path.join(binDir, "wb");
  const content = `#!/usr/bin/env bash\nexec bun run ${JSON.stringify(cliEntryPath)} "$@"\n`;
  if (!fs.existsSync(shimPath) || fs.readFileSync(shimPath, "utf8") !== content) {
    atomicWriteFile(shimPath, content, 0o755);
  }
  return binDir;
}

const QODER_PRINT_MODE_GUARD =
  "Non-interactive -p print mode: NEVER run Bash/shell commands in the background (never set run_in_background=true, never trail commands with &), and NEVER end your turn waiting for a background notification (ending the turn immediately exits the CLI and kills running child processes). Execute checks synchronously and output the complete final response in this turn.";

export function buildHarnessCommand(
  target: ModelTarget,
  ctx: {
    root: string;
    action: AgentAction;
    prompt: string;
    nativeSessionId?: string;
    harnesses: HarnessInfo[];
    structuredJson?: boolean;
  },
): BuiltCommand {
  const info = ctx.harnesses.find((h) => h.id === target.harness);
  const exe = info?.executable;
  const model = target.model;
  const effort = target.reasoningEffort;
  const structuredJson = ctx.structuredJson !== false;

  switch (target.harness) {
    case "codex": {
      const bin = exe || "codex";
      const isReadOnly = ctx.action === "ask" || ctx.action === "review";
      const modelFlags = model && model !== "default" ? ["-m", model] : [];
      const effortFlags = effort ? ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`] : [];
      const summarySelection = `(model=${model}${effort ? `, effort=${effort}` : ""})`;

      if (ctx.nativeSessionId && ctx.action !== "review") {
        // Preserve model, reasoning effort, and bypass/read-only sandbox flags across native resume.
        const resumeSafetyFlags = isReadOnly
          ? ["-c", 'sandbox_mode="read-only"']
          : ["--dangerously-bypass-approvals-and-sandbox"];
        const args = [
          "exec",
          "resume",
          ...(structuredJson ? ["--json"] : []),
          "--skip-git-repo-check",
          ...modelFlags,
          ...effortFlags,
          ...resumeSafetyFlags,
          ctx.nativeSessionId,
          ctx.prompt,
        ];
        return {
          command: bin,
          args,
          displayCommand: `${bin} exec resume ${structuredJson ? "--json " : ""}${ctx.nativeSessionId} ${summarySelection}`,
        };
      }
      const safetyFlags = isReadOnly ? ["-s", "read-only"] : ["--dangerously-bypass-approvals-and-sandbox"];
      const args = [
        "exec",
        ...(structuredJson ? ["--json"] : []),
        "-C",
        ctx.root,
        "--skip-git-repo-check",
        ...modelFlags,
        ...effortFlags,
        ...safetyFlags,
        ctx.prompt,
      ];
      return {
        command: bin,
        args,
        displayCommand: `${bin} exec ${structuredJson ? "--json " : ""}-C ${ctx.root} ${safetyFlags.join(" ")} ${summarySelection}`,
      };
    }

    case "qodercn": {
      const bin = exe || "qodercn";
      const isReadOnly = ctx.action === "ask" || ctx.action === "review";
      const modelInfo = info?.models.find((m) => m.id === model);
      const effortAllowed =
        model !== "Auto" &&
        model !== "Fast" &&
        (!modelInfo?.supportedEfforts || modelInfo.supportedEfforts.length > 0) &&
        !modelInfo?.effortLocked;
      // Execution stages skip per-command remote permission checks; read-only stages keep auto mode.
      const permissionFlags = isReadOnly ? ["--permission-mode", "auto"] : ["--dangerously-skip-permissions"];
      const args = [
        "-w",
        ctx.root,
        ...(structuredJson ? ["-o", "stream-json"] : []),
        ...permissionFlags,
        "--append-system-prompt",
        QODER_PRINT_MODE_GUARD,
        ...(model && model !== "default" && model !== "Auto" ? ["-m", model] : []),
        ...(effort && effortAllowed ? ["--reasoning-effort", effort] : []),
        ...(ctx.nativeSessionId && ctx.action !== "review" ? ["-r", ctx.nativeSessionId] : []),
        "-p",
        ctx.prompt,
      ];
      return {
        command: bin,
        args,
        displayCommand: `${bin} -p${structuredJson ? " -o stream-json" : ""} ${permissionFlags.join(" ")} -m ${model}${ctx.nativeSessionId && ctx.action !== "review" ? ` -r ${ctx.nativeSessionId}` : ""}`,
      };
    }

    case "opencode": {
      const bin = exe || "opencode";
      const args = [
        "run",
        ...(structuredJson ? ["--format", "json"] : []),
        "--standalone",
        "--auto",
        ...(model && model !== "default" ? ["--model", model] : []),
        ...(effort && effort !== "minimal" ? ["--thinking"] : []),
        ...(ctx.nativeSessionId ? ["--session", ctx.nativeSessionId] : []),
        ctx.prompt,
      ];
      return {
        command: bin,
        args,
        displayCommand: `${bin} run${structuredJson ? " --format json" : ""} --standalone --model ${model}`,
      };
    }

    case "agy": {
      const bin = exe || "agy";
      // Only read-only stages pin plan mode; execution stages let AGY resolve its configured mode
      // so hosts without a terminal sandbox no longer get an explicitly requested auto mode.
      const usePlanMode = ctx.action === "ask" || ctx.action === "review";
      const modelInfo =
        info?.models.find((m) => m.id === model) ??
        info?.models.find((m) => m.effortVariants && Object.values(m.effortVariants).includes(model));
      const agyEffortRaw =
        effort && (effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh" || effort === "max")
          ? effort
          : undefined;
      let resolvedModel = model;
      let resolvedEffort = agyEffortRaw;
      if (modelInfo?.effortVariants) {
        const targetEff = resolvedEffort ?? modelInfo.defaultEffort;
        if (targetEff && modelInfo.effortVariants[targetEff]) {
          resolvedModel = modelInfo.effortVariants[targetEff]!;
          resolvedEffort =
            targetEff === "low" || targetEff === "medium" || targetEff === "high" || targetEff === "xhigh" || targetEff === "max"
              ? targetEff
              : resolvedEffort;
        } else if (modelInfo.defaultEffort && modelInfo.effortVariants[modelInfo.defaultEffort]) {
          resolvedModel = modelInfo.effortVariants[modelInfo.defaultEffort]!;
        } else {
          const firstVariant = Object.values(modelInfo.effortVariants)[0];
          if (firstVariant) resolvedModel = firstVariant;
        }
      } else if (modelInfo?.effortLocked) {
        resolvedEffort =
          modelInfo.defaultEffort &&
          (modelInfo.defaultEffort === "low" ||
            modelInfo.defaultEffort === "medium" ||
            modelInfo.defaultEffort === "high" ||
            modelInfo.defaultEffort === "xhigh" ||
            modelInfo.defaultEffort === "max")
            ? modelInfo.defaultEffort
            : undefined;
      } else if (modelInfo?.supportedEfforts && modelInfo.supportedEfforts.length === 0) {
        resolvedEffort = undefined;
      }

      const modeFlags = usePlanMode ? ["--mode", "plan"] : [];
      const permissionFlags = usePlanMode ? [] : ["--dangerously-skip-permissions"];
      const args = [
        "-p",
        ctx.prompt,
        ...(structuredJson ? ["--output-format", "stream-json"] : []),
        ...modeFlags,
        ...permissionFlags,
        ...(resolvedModel && resolvedModel !== "default" ? ["--model", resolvedModel] : []),
        ...(resolvedEffort ? ["--effort", resolvedEffort] : []),
        ...(ctx.nativeSessionId ? ["--conversation", ctx.nativeSessionId] : []),
      ];
      return {
        command: bin,
        args,
        displayCommand: `${bin} -p${structuredJson ? " --output-format stream-json" : ""}${usePlanMode ? " --mode plan" : ""} (model=${resolvedModel})`,
      };
    }

    case "omp": {
      const bin = exe || "omp";
      const args = [
        "-p",
        ...(structuredJson ? ["--mode=json"] : []),
        `--cwd=${ctx.root}`,
        ...(model && model !== "default" ? [`--model=${model}`] : []),
        ...(effort ? [`--thinking=${effort}`] : []),
        ...(ctx.nativeSessionId ? [`--resume=${ctx.nativeSessionId}`] : []),
        ctx.prompt,
      ];
      return {
        command: bin,
        args,
        displayCommand: `${bin} -p${structuredJson ? " --mode=json" : ""} --model=${model}`,
      };
    }
  }
}

function buildCompactResumeContext(
  detail: RequirementDetail,
  input: StartRunInput,
  outputLanguage: ResolvedOutputLanguage,
): string {
  const { state, validity } = detail;
  const parts: string[] = [
    `- **当前阶段**：\`${state.stage}\` | **版本**：rev ${state.revision}（当前为同会话原生续接，完整简报已更新至 \`${WORKBENCH_DIR}/items/${state.id}/handoff.md\`，无需重复通读未改动文件）`,
    buildResumeLanguageReminder(outputLanguage),
  ];
  if (state.tasks.length > 0) {
    const remaining = state.tasks.filter((t) => t.status !== "done");
    if (remaining.length > 0) {
      parts.push("**未完成任务**：");
      for (const t of remaining) {
        parts.push(`- [${t.status}] \`${t.id}\` ${t.title}${t.note ? `（${t.note}）` : ""}`);
      }
    }
  }
  const failedEv = [...validity.verifications].reverse().find((v) => v.effectiveState === "failed");
  if (failedEv) {
    parts.push(`- **最新失败验证**：\`${failedEv.record.command}\`（退出码 ${failedEv.record.exitCode}）`);
  }
  if (state.reviewReport && (state.reviewReport.verdict !== "pass" || input.action === "fix")) {
    const rev = state.reviewReport;
    parts.push(
      `- **最新跨模型审查（${rev.verdict} / ${validity.reviewValidity.effectiveState}）**：${rev.summary}`,
    );
    if (rev.findings && rev.findings.length > 0) {
      for (const f of rev.findings.slice(0, 10)) {
        const loc = f.files && f.files.length > 0 ? ` (${f.files.join(", ")})` : "";
        const detailHint = f.detail ? `：${f.detail}` : "";
        const fixHint = f.suggestion ? ` → 建议：${f.suggestion}` : "";
        parts.push(`  - [${f.severity}] \`${f.id}\` ${f.title}${loc}${detailHint}${fixHint}`);
      }
    }
  }
  if (state.lastFeedback) {
    parts.push(`- **最新打回意见**：${state.lastFeedback}`);
  }
  if (input.message?.trim() && input.action !== "ask") {
    parts.push(`- **本次追加指令**：${input.message.trim()}`);
  }
  const pendingNotes = (state.discussions ?? []).filter((d) => !d.resolved);
  if (pendingNotes.length > 0) {
    parts.push("**待处理批注/讨论**：");
    for (const d of pendingNotes.slice(-6)) {
      parts.push(`- (${d.actor}/${d.mode}) ${d.anchor ? `[${d.anchor}] ` : ""}${d.message}`);
    }
  }
  return parts.join("\n");
}

export function buildExecutionPrompt(
  detail: RequirementDetail,
  handoffMarkdown: string,
  input: StartRunInput,
  options: {
    resumedSession?: boolean;
    outputLanguage?: ResolvedOutputLanguage;
    fastCommand?: string | null;
    fullCommand?: string | null;
  } = {},
): string {
  const reqId = detail.state.id;
  const lang: ResolvedOutputLanguage = options.outputLanguage ?? "zh-CN";
  const fastVerifyHint = options.fastCommand
    ? `快速检查（\`${options.fastCommand}\`）及针对改动模块的轻量测试`
    : "快速类型/语法检查及针对改动模块的轻量测试";

  if (input.action === "ask") {
    const langInstruction =
      lang === "en"
        ? "- Reply in clear, concise English Markdown."
        : "- 请直接用清晰简练的简体中文 Markdown 给出解答、原理分析或方案权衡建议。";
    return [
      `你当前处于「仅提问探讨（Read-Only Consultation）」模式，请针对需求 ${reqId}（${detail.state.title}）回答用户问题。`,
      "重要约束：",
      "- 严禁修改任何仓库代码、严禁运行写操作工具、严禁修改 .workbench/ 文件或调用 wb propose / wb tasks。",
      langInstruction,
      buildOutputLanguageDirective(lang, "ask"),
      "",
      input.anchor ? `提问锚点：${input.anchor}` : "",
      `用户问题：${input.message?.trim() || "请解释当前技术方案的核心思路与风险点。"}`,
      "",
      ...(options.resumedSession
        ? [
            `（同会话续接；如需最新完整上下文请按需查看 ${WORKBENCH_DIR}/items/${reqId}/handoff.md）`,
          ]
        : ["参考上下文简报：", handoffMarkdown]),
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (input.action === "review") {
    return [
      `请你作为独立的代码与交付审查者（Cross-Model Reviewer），审查工作台需求 ${reqId}（${detail.state.title}）。`,
      "重要约束：",
      "- 严禁修改仓库业务代码或调用 wb propose / wb tasks；只读检查 Git Diff、测试证据与 Spec 一致性。",
      "- 非交互同步约束：禁止在后台运行命令（如 run_in_background 或 &）或以“等待后台任务通知”结束本轮；请同步执行命令并在本轮直接输出完整结论与 JSON 块。",
      "- 优先复用匹配证据：先核验 `.workbench/items/" +
        reqId +
        `/evidence/\` 是否已有通过且 codeSnapshotHash 与当前工作区一致的验证日志；若已有匹配通过证据，直接核验日志并仅运行${fastVerifyHint}，禁止重跑耗时的全量多分钟测试套（仅在证据缺失、过期或存在疑点时再重跑全量）。`,
      "- 结论判定聚焦代码与 AC：只有实际代码缺陷、安全风险或必需 AC 未满足时才给出 `block` 或 `concern`；若代码与证据均已达标、仅存在待人工确认或非必需流程提醒，请给 `pass` 并在正文说明，切勿要求超出当前 AC 范围的额外宿主证明。",
      "- 注：若当前处于只读沙箱且需要可写目录的端到端/浏览器用例因只读限制无法启动，请直接核验 `.workbench/items/" +
        reqId +
        "/evidence/` 既有真实运行日志并执行静态检查与非浏览器单元测试，勿将沙箱只读限制误判为代码缺失。",
      buildOutputLanguageDirective(lang, "review"),
      "- 请在输出最后附上一个明确的结论 JSON 块，格式严格如下（`findings` 为可选结构化问题列表，有具体问题时建议填写以便前端逐条定位修复）：",
      lang === "en"
        ? '```json\n{"verdict":"pass"|"concern"|"block","summary":"One-sentence core review summary in English","findings":[{"id":"F-1","severity":"high"|"medium"|"low","title":"Short issue title","criterionIds":["AC-1"],"files":["src/path.ts:10"],"suggestion":"Concrete fix"}]}\n```'
        : '```json\n{"verdict":"pass"|"concern"|"block","summary":"用简体中文写出的一句话核心审查结论","findings":[{"id":"F-1","severity":"high"|"medium"|"low","title":"简明问题描述","criterionIds":["AC-1"],"files":["src/path.ts:10"],"suggestion":"具体修复建议"}]}\n```',
      "",
      "审查范围与交接简报（包含需求契约、验收状态与当前 Git 现场）：",
      handoffMarkdown,
    ].join("\n");
  }

  const hasReviewToFix = Boolean(detail.state.reviewReport && detail.state.reviewReport.verdict !== "pass");
  const isCurrentReview = detail.validity.reviewValidity.effectiveState === "current";
  const hasHumanFeedback = Boolean(detail.state.lastFeedback) || Boolean(input.message?.trim());
  const isFastTrack = detail.state.track === "fast_track";
  const modeVerb =
    input.action === "design"
      ? `请仅执行 ${reqId} 的设计阶段：梳理或修订规范、结构化验收条件与技术方案（验收条件按分层设计：${options.fastCommand ? `AC-1 用 \`${options.fastCommand}\`、` : ""}AC-2 优先绑定针对改动模块的局部测试命令；仅在改动业务/测试代码时才增加一条 \`${options.fullCommand ?? "全量测试"}\` 作为最终门禁，纯文档/配置调整勿捆绑全量测试；若预计改动局限在少数文件且风险可控，可建议采用轻量快速方案），并通过 \`wb propose ${reqId} ...\`（或 MCP 工具 wb_propose）提交，同时在 --note 或 handoffNote 中总结关键决策。设计阶段禁止修改业务代码或测试，禁止运行 \`wb verify\`、\`wb tasks --ready\` 或把实施任务标记为完成；提交方案后立即结束本轮，等待人类在工作台审阅批准。`
      : input.action === "fix" && input.resolveConflict
        ? `本次任务仅聚焦将主干最新提交合并到当前沙箱分支并解决合并冲突（切勿重复返工已通过的既有实现或过期审查意见）：1) 若存在未提交业务改动请先安全暂存或提交（严禁提交 node_modules 或 .workbench）；2) 合并目标主干提交并完整保留本需求功能与主干新增改动；3) 运行 \`wb verify ${reqId} --all\` 验证全部通过后执行 \`wb tasks ${reqId} --ready\`。`
        : input.action === "fix"
        ? hasReviewToFix && isCurrentReview
          ? `请结合交接简报第 1 节中的最新跨模型 Code Review 问题清单、人类反馈及失败/过期验收条件，逐条定位修复问题并补充必要的回归测试；改完后务必运行 \`wb verify ${reqId} --all\`（或 wb_verify）获取最新真实验证证据，全部通过后执行 \`wb tasks ${reqId} --ready\`。`
          : hasReviewToFix && hasHumanFeedback
            ? `请优先执行交接简报第 1 节中的人类最新指令/打回反馈（如同步主干、解决冲突或专项调整）；历史 Code Review 意见已过期仅供参考，切勿重复返工已修复项，改完后务必运行 \`wb verify ${reqId} --all\`（或 wb_verify）获取最新真实验证证据，全部通过后执行 \`wb tasks ${reqId} --ready\`。`
            : hasReviewToFix || hasHumanFeedback
              ? `请结合交接简报第 1 节中的最新跨模型 Code Review 问题清单、人类反馈及失败/过期验收条件，逐条定位修复问题并补充必要的回归测试；改完后务必运行 \`wb verify ${reqId} --all\`（或 wb_verify）获取最新真实验证证据，全部通过后执行 \`wb tasks ${reqId} --ready\`。`
              : `请诊断并修复 ${reqId} 当前失败或过期的验收条件，改完后务必运行 \`wb verify ${reqId} --all\`（或 wb_verify）获取最新真实验证证据，全部通过后执行 \`wb tasks ${reqId} --ready\`。`
        : isFastTrack
          ? `请依据需求目标（快速通道）完成 ${reqId} 的代码修改与验证：改完后运行 \`wb verify ${reqId} --all\`（或 \`wb verify ${reqId} --cmd ...\`）获取真实验证证据，全部通过后直接执行 \`wb tasks ${reqId} --ready\` 提交人类验收（快速通道无需额外拆解任务清单）。`
          : `请依据已确认的规范/方案完成 ${reqId} 的代码实现与测试验证：用 \`wb tasks ${reqId}\` 维护步骤，用 \`wb verify ${reqId} --all\` 跑通真实测试，全部通过后执行 \`wb tasks ${reqId} --ready\` 提交人类验收。`;

  const boundaryGuard =
    input.action === "design"
      ? "注意：你无权也无需执行批准或最终验收操作；本轮只产出方案，提交后立即停止，不要继续实施。"
      : [
          "注意：你无权也无需执行批准或最终验收操作；修改代码后请重新运行真实测试验证，勿留下后台未完成命令即结束本轮。",
          "执行规范（减少无效耗时）：",
          "- 开发调试期仅运行类型检查与针对当前改动模块的局部测试文件，禁止自行直接运行全量测试；全量验证统一通过 `wb verify <REQ-ID> --all` 触发（同快照已通过的条目会自动复用）。",
          "- 严禁越界修改无关文件或试图修补与本需求无关的既有/偶发失败测试；遇无关失败先重试一次确认，并将情况记录到 `wb tasks <REQ-ID> --handoff-note` 即可。",
          "- 更新交接/交付说明请使用 `wb tasks <REQ-ID> --handoff-note '{...}'`（或 MCP `wb_update_tasks`），禁止在实施或修复阶段为了写说明而调用 `wb propose`。",
        ].join("\n");

  const screenshotHint =
    (input.action === "implement" || input.action === "fix") && detail.state.uiRelated === true
      ? "若本次需求涉及 UI，提交验收时会自动采集界面截图证据；也可随时执行 `wb screenshot <REQ-ID>`（或 MCP wb_screenshot）补充采集。"
      : "";

  return [
    `请接力执行工作台需求 ${reqId}（可用命令行 \`wb\` 工具操作，WORKBENCH_ROOT 已自动指向当前仓库）。`,
    modeVerb,
    boundaryGuard,
    screenshotHint,
    "",
    buildOutputLanguageDirective(lang, "plan"),
    "",
    options.resumedSession ? buildCompactResumeContext(detail, input, lang) : handoffMarkdown,
  ]
    .filter((line, idx, arr) => !(line === "" && arr[idx - 1] === ""))
    .join("\n");
}

function parseReviewFindings(rawFindings: unknown): ReviewFinding[] | undefined {
  if (!Array.isArray(rawFindings) || rawFindings.length === 0) return undefined;
  const out: ReviewFinding[] = [];
  for (let idx = 0; idx < rawFindings.length && out.length < 50; idx++) {
    const item = rawFindings[idx];
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const rawTitle = typeof obj.title === "string" ? sanitizeOutput(obj.title.trim(), 380).text.trim() : "";
    if (!rawTitle) continue;
    const sev = obj.severity === "high" || obj.severity === "medium" || obj.severity === "low" ? obj.severity : "medium";
    const id =
      typeof obj.id === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(obj.id.trim())
        ? obj.id.trim()
        : `F-${out.length + 1}`;
    const detail =
      typeof obj.detail === "string" && obj.detail.trim()
        ? sanitizeOutput(obj.detail.trim(), 1800).text.trim()
        : undefined;
    const suggestion =
      typeof obj.suggestion === "string" && obj.suggestion.trim()
        ? sanitizeOutput(obj.suggestion.trim(), 1400).text.trim()
        : undefined;
    const criterionIds = Array.isArray(obj.criterionIds)
      ? obj.criterionIds
          .filter((c): c is string => typeof c === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(c.trim()))
          .map((c) => c.trim())
          .slice(0, 16)
      : undefined;
    const files = Array.isArray(obj.files)
      ? obj.files
          .filter((f): f is string => typeof f === "string" && f.trim().length > 0)
          .map((f) => sanitizeOutput(f.trim(), 480).text.trim())
          .filter(Boolean)
          .slice(0, 16)
      : undefined;
    out.push({
      id,
      severity: sev,
      title: rawTitle,
      ...(detail ? { detail } : {}),
      ...(criterionIds && criterionIds.length > 0 ? { criterionIds } : {}),
      ...(files && files.length > 0 ? { files } : {}),
      ...(suggestion ? { suggestion } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

function parseReviewOutput(
  rawOutput: string,
): { verdict: ReviewVerdict; summary: string; markdown: string; findings?: ReviewFinding[] } | null {
  const clean = sanitizeOutput(rawOutput, 256 * 1024).text.trim();
  if (!clean) return null;
  const jsonBlocks = Array.from(clean.matchAll(/```json\s*([\s\S]*?)```/gi));
  for (let i = jsonBlocks.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(jsonBlocks[i]![1]!) as { verdict?: string; summary?: string; findings?: unknown };
      if (parsed.verdict === "pass" || parsed.verdict === "concern" || parsed.verdict === "block") {
        const findings = parseReviewFindings(parsed.findings);
        return {
          verdict: parsed.verdict,
          summary: parsed.summary?.trim() || `审查结论：${parsed.verdict}`,
          markdown: clean,
          ...(findings ? { findings } : {}),
        };
      }
    } catch {
      // Try an earlier block.
    }
  }
  // Accept a bare JSON verdict object at the tail; never guess from prose or tool chatter.
  const bareMatches = Array.from(
    clean.slice(-8192).matchAll(/\{[^{}]*"verdict"\s*:\s*"(pass|concern|block)"[^{}]*\}/g),
  );
  const bare = bareMatches.pop();
  if (bare) {
    try {
      const parsed = JSON.parse(bare[0]) as { verdict: ReviewVerdict; summary?: string };
      return {
        verdict: parsed.verdict,
        summary: parsed.summary?.trim() || `审查结论：${parsed.verdict}`,
        markdown: clean,
      };
    } catch {
      // Malformed bare object.
    }
  }
  return null;
}

const ORPHAN_LEGACY_GRACE_MS = 5_000;
const globalActiveRunIds = new Set<string>();

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
    routing?: RoutingConfig;
    outputLanguage?: OutputLanguage;
    observability?: HubObservabilityConfig;
  };
  private readonly onTelemetryOutcome?: (outcome: TelemetryOutcomeInput) => void;
  private readonly onPainPoint?: (input: PainPointReportInput) => EvolutionPainPoint | null;
  private readonly onLedgerEntry?: (entry: RunLedgerEntry) => void;
  private readonly nodeId?: string;
  private readonly hasCustomInitialHarnesses: boolean;
  private cachedHarnesses: HarnessInfo[] | null = null;
  private cachedHarnessesAt = 0;
  private cachedCatalogFingerprint = "";
  private inFlightRefresh: Promise<HarnessInfo[]> | null = null;

  constructor(options: {
    cliEntryPath?: string;
    commandBuilder?: CustomCommandBuilder;
    initialHarnesses?: HarnessInfo[];
    getHubPreferences?: () => {
      routing?: RoutingConfig;
      outputLanguage?: OutputLanguage;
      observability?: HubObservabilityConfig;
    };
    onTelemetryOutcome?: (outcome: TelemetryOutcomeInput) => void;
    onPainPoint?: (input: PainPointReportInput) => EvolutionPainPoint | null;
    onLedgerEntry?: (entry: RunLedgerEntry) => void;
    nodeId?: string;
  } = {}) {
    this.cliEntryPath = options.cliEntryPath ?? path.resolve(import.meta.dir, "../cli/index.ts");
    this.commandBuilder = options.commandBuilder;
    this.getHubPreferences = options.getHubPreferences;
    this.onTelemetryOutcome = options.onTelemetryOutcome;
    this.onPainPoint = options.onPainPoint;
    this.onLedgerEntry = options.onLedgerEntry;
    this.nodeId = options.nodeId;
    this.hasCustomInitialHarnesses = Boolean(options.initialHarnesses);
    if (options.initialHarnesses) {
      this.cachedHarnesses = options.initialHarnesses;
      this.cachedHarnessesAt = Date.now();
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
      .map((h) => `${h.id}:${h.installed}:${h.models.map((m) => `${m.id}@${m.tier}@${m.supportedEfforts?.join(",") ?? ""}`).join("|")}`)
      .join(";");
  }

  private runFullHarnessRefresh(): Promise<HarnessInfo[]> {
    if (this.inFlightRefresh) return this.inFlightRefresh;
    const prevSig = this.harnessesSignature(this.cachedHarnesses);
    this.inFlightRefresh = discoverHarnesses()
      .then((full) => {
        this.cachedHarnesses = full;
        this.cachedHarnessesAt = Date.now();
        this.cachedCatalogFingerprint = getLocalCatalogFingerprint();
        if (this.harnessesSignature(full) !== prevSig) {
          this.emit({
            type: "hub.updated",
            reason: "harnesses.refreshed",
            root: "",
            requirementId: "",
            runId: "",
            at: Date.now(),
          });
        }
        return full;
      })
      .finally(() => {
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
      this.cachedHarnesses = discoverHarnessesQuick();
      this.cachedHarnessesAt = Date.now();
      this.cachedCatalogFingerprint = getLocalCatalogFingerprint();
      if (!quickOnly) {
        void this.runFullHarnessRefresh().catch(() => {});
      }
      return this.cachedHarnesses;
    }
    if (!quickOnly && !this.hasCustomInitialHarnesses) {
      const currentFp = getLocalCatalogFingerprint();
      const expired = Date.now() - this.cachedHarnessesAt > HARNESS_REFRESH_TTL_MS;
      if (expired || currentFp !== this.cachedCatalogFingerprint) {
        void this.runFullHarnessRefresh().catch(() => {});
      }
    }
    return this.cachedHarnesses;
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
        throw new WorkbenchError("revision_conflict", `${id} 当前已有正在执行的 Agent 任务（${job.target.harness}/${job.target.model}），请等待完成或先终止`);
      }
    }

    const prefs = this.getHubPreferences?.();
    const cfg = prefs?.routing ? null : readHubConfig();
    const activeRouting = prefs?.routing ?? cfg!.routing;
    const hubOutputLanguage = prefs?.outputLanguage ?? cfg?.outputLanguage;
    let observability = prefs?.observability ?? cfg?.observability;
    if (!observability && prefs?.routing) {
      try {
        observability = readHubConfig().observability;
      } catch {
        observability = undefined;
      }
    }
    const harnesses = await this.getHarnesses(false);
    const codeRoot = resolveCodeRoot(base, id);
    let currentDetail = getRequirement(base, id, { currentCodeSnapshotHash: (await observeGitSnapshot(codeRoot))?.fingerprint ?? null });
    if (input.action === "fix" && input.resolveConflict && (currentDetail.state.stage === "done" || currentDetail.state.stage === "awaiting_acceptance")) {
      currentDetail = await prepareSandboxConflictResolution(base, id);
    }
    if (input.action === "implement" || input.action === "fix") {
      const stage = currentDetail.state.stage;
      if (stage !== "implementing" && stage !== "awaiting_acceptance") {
        throw new WorkbenchError(
          "approval_required",
          `${id} 当前阶段（${stage}）不能执行 ${input.action}；必须先由人类批准方案并进入实施阶段`,
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
    const runsList = currentDetail.state.agentRuns ?? [];
    const prevRun = runsList.slice(-1)[0] ?? null;

    let sessionAffinityApplied = false;
    let override: Partial<ModelTarget> | null =
      input.harness && input.model
        ? { harness: input.harness as ModelTarget["harness"], model: input.model, reasoningEffort: input.reasoningEffort }
        : input.reasoningEffort
          ? { reasoningEffort: input.reasoningEffort }
          : null;

    // Session affinity: when action is "fix" with no explicit override or fallback request,
    // prefer the most recent healthy implement/fix runner instead of cold-starting a third harness.
    if (!input.harness && !input.model && !input.useFallback && input.action === "fix") {
      const lastImplRun = [...runsList]
        .reverse()
        .find((r) => (r.action === "implement" || r.action === "fix") && r.status === "succeeded" && !r.rateLimited);
      const isRunnable =
        lastImplRun &&
        (harnesses.some((h) => h.id === lastImplRun.harness && h.installed) || Boolean(this.commandBuilder));
      if (lastImplRun && isRunnable && !isModelCoolingDown(lastImplRun.harness, lastImplRun.model)) {
        sessionAffinityApplied = true;
        override = {
          harness: lastImplRun.harness as HarnessId,
          model: lastImplRun.model,
          ...(input.reasoningEffort
            ? { reasoningEffort: input.reasoningEffort }
            : lastImplRun.reasoningEffort
              ? { reasoningEffort: lastImplRun.reasoningEffort as ModelTarget["reasoningEffort"] }
              : {}),
        };
      }
    }
    const candidates = resolveRouteCandidates(activeRouting, harnesses, input.action, override);

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
      (input.action === "ask" || input.mode === "refine" || input.action === "design")
    ) {
      await addDiscussion(base, id, {
        actor: "human",
        mode: input.action === "ask" ? "ask" : "refine",
        message: input.message.trim(),
        anchor: input.anchor,
      });
    }

    // Mark draft -> designing only when actually modifying design
    if (input.action === "design" && currentDetail.state.stage === "draft") {
      await markDesigning(base, id);
    }

    let conflictContext: ConflictHandoffContext | undefined;
    if (input.action === "fix" && input.resolveConflict) {
      const driftInfo = await inspectRsiSandboxDrift(base, id, { includeSiblings: false, fetchRemote: false }).catch(() => null);
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

    // Determine whether we can safely use same-harness native session resume.
    // Skip read-only "review" runs so persona stays clean while still resuming the prior write session.
    const prevWriteRun = [...runsList].reverse().find((r) => r.action !== "review") ?? null;
    const canResumeSameHarness =
      !input.useFallback &&
      prevWriteRun &&
      prevWriteRun.harness === target.harness &&
      Boolean(prevWriteRun.nativeSessionId) &&
      prevWriteRun.status !== "cancelled" &&
      !prevWriteRun.rateLimited &&
      input.action !== "review";

    const handoffMode: RunHandoffMode = canResumeSameHarness
      ? "native_resume"
      : runsList.length > 0
        ? "fresh_handoff"
        : "first_run";
    const parentRunId = canResumeSameHarness ? prevWriteRun!.id : prevRun?.id;
    const dispatchReason: RunDispatchReason = input.resolveConflict
      ? "conflict_resolve"
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
                  : "route_primary";

    const projectMeta = getProjectStatus(base).project;
    const projectContext = discoverProjectContext(codeRoot, projectMeta);
    const prompt = buildExecutionPrompt(postHandoffDetail, handoffMd, input, {
      resumedSession: Boolean(canResumeSameHarness),
      outputLanguage,
      fastCommand: projectContext.fastCommand,
      fullCommand: projectContext.fullCommand,
    });
    const structuredJsonEnabled =
      !input.forcePlainText && !this.plainTextFallbackHarnesses.has(target.harness);
    const built = this.commandBuilder
      ? this.commandBuilder(target, {
          root: codeRoot,
          requirementId: id,
          action: input.action,
          prompt,
          nativeSessionId: canResumeSameHarness ? prevWriteRun!.nativeSessionId : undefined,
          harnesses,
          structuredJson: structuredJsonEnabled,
        })
      : buildHarnessCommand(target, {
          root: codeRoot,
          action: input.action,
          prompt,
          nativeSessionId: canResumeSameHarness ? prevWriteRun!.nativeSessionId : undefined,
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
      ...(canResumeSameHarness && prevWriteRun?.nativeSessionId ? { resumedSessionId: prevWriteRun.nativeSessionId } : {}),
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
      ...(postHandoffDetail.state.handoffNote !== undefined ? { handoffNoteSnapshot: postHandoffDetail.state.handoffNote } : {}),
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
    const collector = new RunTraceCollector({
      runId,
      traceFilePath: traceDiskPath,
      startedAt,
      billingMode: poolInfo.billingMode,
      quotaPool: poolInfo.quotaPool,
      modelSpec,
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
      ...(canResumeSameHarness && prevWriteRun?.nativeSessionId ? { resumedSessionId: prevWriteRun.nativeSessionId } : {}),
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
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${shimBin}:${process.env.PATH ?? ""}`,
      WORKBENCH_ROOT: base,
      WORKBENCH_REQ_ID: id,
      WORKBENCH_HUB_PID: String(process.pid),
      WORKBENCH_OUTPUT_LANGUAGE: outputLanguage,
      ...(codeRoot !== base ? { WORKBENCH_RSI_DEPTH: "1" } : {}),
    };

    const liveLogPath = path.join(base, WORKBENCH_DIR, "items", id, "runs", `run-${runId}.log`);
    const appendDiskLog = (text: string) => {
      if (!text) return;
      try {
        if (fs.existsSync(path.dirname(liveLogPath))) {
          fs.appendFileSync(liveLogPath, text, "utf8");
        }
      } catch {
        // Real-time disk flush is best-effort; finalize writes the bounded log atomically.
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

    this.emit({
      type: "agent.run.started",
      root: base,
      requirementId: id,
      runId,
      action: input.action,
      harness: target.harness,
      model: target.model,
      status: "running",
      at: startedAt,
    });

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

    // Keep the watchdog alive while long silent verification/task updates advance state.json.
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
          // Ignore transient stat failures while state.json is atomically replaced.
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

    const streamAdapter = createHarnessStreamAdapter(
      target.harness,
      target.model,
      structuredJsonEnabled,
    );

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

    const onStdoutChunk = (buf: Buffer) => {
      if (buf.length > 0) resetIdleTimer();
      stdoutLineBuf += buf.toString("utf8");
      const lines = stdoutLineBuf.split(/\r?\n/);
      stdoutLineBuf = lines.pop() ?? "";
      for (const line of lines) {
        handleAdapterResult(streamAdapter.feedLine(line), true);
      }
    };

    const onStderrChunk = (buf: Buffer) => {
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
    };

    child.stdout?.on("data", onStdoutChunk);
    child.stderr?.on("data", onStderrChunk);

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
      const rawLog =
        Buffer.byteLength(assembledLog, "utf8") > MAX_RUN_LOG_BYTES
          ? clipHeadTailUtf8(assembledLog, 1_500_000, 2_500_000).text
          : assembledLog;
      this.runLogs.set(runId, rawLog);

      const rateLimited = !job.cancelled && !job.timedOut && detectRateLimitOrQuotaError(rawLog, exitCode);
      const modelUnavailable = !job.cancelled && !job.timedOut && detectModelUnavailableError(rawLog, exitCode);
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

      let status: AgentRunRecord["status"] = job.cancelled
        ? "cancelled"
        : exitCode === 0 && !spawnErr && !job.timedOut
          ? "succeeded"
          : "failed";
      const replySource =
        cleanReplyParts.join("\n\n").trim() ||
        stdoutReplyTail.trim() ||
        stripCliNoise(rawLog.replace(/^\$ .*\n/, ""));
      const parsedReview =
        status === "succeeded" && input.action === "review" ? parseReviewOutput(replySource) : null;
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
      // Only accept line-anchored CLI header lines like `session id: <uuid>` rather than arbitrary grep/code output.
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
      const errorSummary =
        status === "failed"
          ? shouldRetryPlainText
            ? "CLI 不支持结构化 JSON 输出参数，已自动降级为纯文本模式重试"
            : reviewParseFailed
              ? "审查输出缺少可解析的结构化结论（需在末尾输出 ```json {\"verdict\":\"pass|concern|block\",\"summary\":\"…\"} ```），未写入审查报告；请重跑跨模型审查"
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

      let snap: Awaited<ReturnType<typeof observeGitSnapshot>> = null;
      let latestReq: RequirementDetail | null = null;
      try {
        if (codeRoot !== base) {
          await reconcileRsiSandboxBaseline(base, id).catch(() => null);
        }
        snap = await observeGitSnapshot(codeRoot);
        latestReq = getRequirement(base, id, { currentCodeSnapshotHash: snap?.fingerprint ?? null });
      } catch {
        // Ignore git/requirement read errors during finalize pre-observation; handled below.
      }
      const specChanged = latestReq ? latestReq.state.specHash !== specHashBefore : false;
      const codeChanged = (snap?.fingerprint ?? null) !== (snapshotBefore?.fingerprint ?? null);

      const traceSummary = collector.finalizeRun({
        status,
        exitCode,
        durationMs,
        specChanged,
        codeChanged,
        errorSummary,
      });

      if (!shouldRetryPlainText) {
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
          // Telemetry write failure must not abort run finalization.
        }
      }

      let postRunDetail: RequirementDetail | null = null;
      try {
        // Post-run side effects by action
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
          },
          rawLog,
          snap?.fingerprint ?? null,
        );
        postRunDetail = finishedDetail;

        const lastRunObj = (finishedDetail.state.agentRuns ?? []).find((r) => r.id === runId) ?? null;
        const postHandoff = await synthesizeHandoffPacket(base, id, {
          action: input.action,
          previousRun: lastRunObj,
          previousLogTail: rawLog.slice(-1500),
        });
        if (lastRunObj) {
          inspectFinishedRunForPainPoints({
            root: base,
            requirementId: id,
            run: lastRunObj,
            detail: postHandoff.detail,
            rawLog,
            timedOut: job.timedOut,
            timeoutReason: job.timeoutReason,
            isRsiSandbox: codeRoot !== base,
            ...(this.nodeId ? { nodeId: this.nodeId } : {}),
            ...(this.onPainPoint ? { onReport: this.onPainPoint } : {}),
          });
        }
        if (codeRoot !== base) {
          syncRequirementMirrorToSandbox(base, id, codeRoot);
        }
      } catch (error) {
        // Keep daemon alive even if workspace disappeared during run, but surface the failure.
        console.error(
          `[workbench] finalize failed for ${id}/${runId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (!shouldRetryPlainText) {
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
          // Ledger recording must never break run finalization.
        }
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

      if (shouldRetryPlainText) {
        const alreadyRunning = this.getActiveRuns(base).some((r) => r.requirementId === id);
        if (!alreadyRunning) {
          void this.startRun({
            ...input,
            harness: target.harness,
            model: target.model,
            reasoningEffort: target.reasoningEffort,
            forcePlainText: true,
          }).catch((err) => {
            console.error(
              `[workbench] plain-text fallback retry failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        }
        return;
      }

      const isHarnessRunnable = (hId: string, availHarnesses: HarnessInfo[]): boolean =>
        availHarnesses.some((h) => h.id === hId && h.installed) || Boolean(this.commandBuilder);

      // Auto-trigger cross-model review once plan_first implement/fix succeeds and submits for acceptance.
      // Fast-track skips automatic review so humans can inspect Diff and accept directly (or trigger review manually).
      if (
        status === "succeeded" &&
        (input.action === "implement" || input.action === "fix") &&
        postRunDetail &&
        postRunDetail.state.track !== "fast_track" &&
        postRunDetail.state.stage === "awaiting_acceptance" &&
        postRunDetail.validity.acceptanceGate.ok &&
        postRunDetail.validity.reviewValidity.effectiveState !== "current"
      ) {
        try {
          const latestPrefs = this.getHubPreferences?.();
          const latestRouting = latestPrefs?.routing ?? readHubConfig().routing;
          if (latestRouting.autoReview !== false) {
            const availHarnesses = await this.getHarnesses(false);
            const reviewTarget = resolveRouteCandidates(latestRouting, availHarnesses, "review")[0];
            const canAutoRun = Boolean(reviewTarget) && isHarnessRunnable(reviewTarget!.harness, availHarnesses);
            const alreadyRunning = this.getActiveRuns(base).some((r) => r.requirementId === id);
            if (canAutoRun && !alreadyRunning) {
              void this.startRun({
                root: base,
                requirementId: id,
                action: "review",
                isAutoReview: true,
              }).catch((err) => {
                console.error(
                  `[workbench] auto-review failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
                );
              });
            }
          }
        } catch {
          // Never crash finalize if auto-review dispatch encounters a routing error.
        }
      }

      // Bounded single-hop automatic fallback on unavailable model, fast rate-limit, or auto-review parse failure.
      const attempt = input.autoFallbackAttempt ?? 0;
      const isExplicitOverride = Boolean(input.harness && input.model);
      const shouldAutoFallback =
        status === "failed" &&
        !job.cancelled &&
        !job.timedOut &&
        attempt < 1 &&
        ((!isExplicitOverride && (modelUnavailable || (rateLimited && durationMs < 60_000))) ||
          (input.isAutoReview === true && (reviewParseFailed || modelUnavailable || rateLimited)));

      if (shouldAutoFallback) {
        try {
          const latestPrefs = this.getHubPreferences?.();
          const latestRouting = latestPrefs?.routing ?? readHubConfig().routing;
          const availHarnesses = await this.getHarnesses(false);
          const candidates = resolveRouteCandidates(latestRouting, availHarnesses, input.action);
          const fallbackCandidate = candidates.find(
            (c) =>
              `${c.harness}::${c.model}` !== `${target.harness}::${target.model}` &&
              isHarnessRunnable(c.harness, availHarnesses),
          );
          const alreadyRunning = this.getActiveRuns(base).some((r) => r.requirementId === id);
          if (fallbackCandidate && !alreadyRunning) {
            void this.startRun({
              ...input,
              harness: undefined,
              model: undefined,
              reasoningEffort: undefined,
              useFallback: true,
              autoFallbackAttempt: attempt + 1,
            }).catch((err) => {
              console.error(
                `[workbench] auto-fallback failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
          }
        } catch {
          // Never crash finalize if auto-fallback dispatch encounters a routing error.
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

  /** Marks orphaned `running` records from dead Hub hosts as failed while preserving any flushed logs. */
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
            // Best-effort recovery; never abort Hub startup on a single requirement error.
          }
        }
      }
    }

    return recovered;
  }

  stopAllRuns(): void {
    for (const job of this.activeJobs.values()) {
      job.cancelled = true;
      this.killProcessGroup(job);
    }
  }
}
