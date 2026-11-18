import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  addDiscussion,
  finishAgentRun,
  getRequirement,
  markDesigning,
  recordReviewReport,
  resolveDiscussions,
  startAgentRun,
} from "../core/engine.ts";
import { WorkbenchError } from "../core/errors.ts";
import { atomicWriteFile, canonicalRoot } from "../core/fs.ts";
import { observeGitSnapshot } from "../core/git.ts";
import {
  buildOutputLanguageDirective,
  buildResumeLanguageReminder,
  type ResolvedOutputLanguage,
} from "../core/language.ts";
import { resolveCodeRoot } from "../core/sandbox.ts";
import {
  MAX_EVIDENCE_BYTES,
  WORKBENCH_DIR,
  type AgentAction,
  type AgentRunRecord,
  type OutputLanguage,
  type RequirementDetail,
  type ReviewFinding,
  type ReviewVerdict,
} from "../core/types.ts";
import { sanitizeOutput } from "../core/validate.ts";
import { evaluateApproval } from "../core/validity.ts";
import { discoverHarnesses, discoverHarnessesQuick, getLocalCatalogFingerprint } from "./discovery.ts";
import {
  inspectFinishedRunForPainPoints,
  reconcileRsiSandboxBaseline,
  syncRequirementMirrorToSandbox,
  type EvolutionPainPoint,
  type PainPointReportInput,
} from "./evolution.ts";
import { synthesizeHandoffPacket } from "./handoff.ts";
import { readHubConfig, resolveHubDir } from "./registry.ts";
import { detectRateLimitOrQuotaError, resolveRouteCandidates } from "./routing.ts";
import { recordModelRunOutcome } from "./telemetry.ts";
import type { HarnessInfo, ModelTarget, RoutingConfig } from "./types.ts";

export interface BuiltCommand {
  command: string;
  args: string[];
  displayCommand: string;
}

export interface RunExecutorEvent {
  type: "agent.run.started" | "agent.run.output" | "agent.run.finished" | "workbench.updated" | "hub.updated";
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
  timeoutMs?: number;
  idleTimeoutMs?: number;
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

export function buildHarnessCommand(
  target: ModelTarget,
  ctx: {
    root: string;
    action: AgentAction;
    prompt: string;
    nativeSessionId?: string;
    harnesses: HarnessInfo[];
  },
): BuiltCommand {
  const info = ctx.harnesses.find((h) => h.id === target.harness);
  const exe = info?.executable;
  const model = target.model;
  const effort = target.reasoningEffort;

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
          displayCommand: `${bin} exec resume ${ctx.nativeSessionId} ${summarySelection}`,
        };
      }
      const safetyFlags = isReadOnly ? ["-s", "read-only"] : ["--dangerously-bypass-approvals-and-sandbox"];
      const args = [
        "exec",
        "-C",
        ctx.root,
        "--skip-git-repo-check",
        ...modelFlags,
        ...effortFlags,
        ...safetyFlags,
        ctx.prompt,
      ];
      return { command: bin, args, displayCommand: `${bin} exec -C ${ctx.root} ${safetyFlags.join(" ")} ${summarySelection}` };
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
        "-o",
        "stream-json",
        ...permissionFlags,
        ...(model && model !== "default" && model !== "Auto" ? ["-m", model] : []),
        ...(effort && effortAllowed ? ["--reasoning-effort", effort] : []),
        ...(ctx.nativeSessionId && ctx.action !== "review" ? ["-r", ctx.nativeSessionId] : []),
        "-p",
        ctx.prompt,
      ];
      return {
        command: bin,
        args,
        displayCommand: `${bin} -p -o stream-json ${permissionFlags.join(" ")} -m ${model}${ctx.nativeSessionId && ctx.action !== "review" ? ` -r ${ctx.nativeSessionId}` : ""}`,
      };
    }

    case "opencode": {
      const bin = exe || "opencode";
      const args = [
        "run",
        "--standalone",
        "--auto",
        ...(model && model !== "default" ? ["--model", model] : []),
        ...(effort && effort !== "minimal" ? ["--thinking"] : []),
        ...(ctx.nativeSessionId ? ["--session", ctx.nativeSessionId] : []),
        ctx.prompt,
      ];
      return { command: bin, args, displayCommand: `${bin} run --standalone --model ${model}` };
    }

    case "agy": {
      const bin = exe || "agy";
      const mode = ctx.action === "ask" || ctx.action === "review" ? "plan" : "auto";
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

      const args = [
        "-p",
        ctx.prompt,
        "--mode",
        mode,
        ...(mode === "auto" ? ["--dangerously-skip-permissions"] : []),
        ...(resolvedModel && resolvedModel !== "default" ? ["--model", resolvedModel] : []),
        ...(resolvedEffort ? ["--effort", resolvedEffort] : []),
        ...(ctx.nativeSessionId ? ["--conversation", ctx.nativeSessionId] : []),
      ];
      return { command: bin, args, displayCommand: `${bin} -p --mode ${mode} (model=${resolvedModel})` };
    }

    case "omp": {
      const bin = exe || "omp";
      const args = [
        "-p",
        `--cwd=${ctx.root}`,
        ...(model && model !== "default" ? [`--model=${model}`] : []),
        ...(effort ? [`--thinking=${effort}`] : []),
        ...(ctx.nativeSessionId ? [`--resume=${ctx.nativeSessionId}`] : []),
        ctx.prompt,
      ];
      return { command: bin, args, displayCommand: `${bin} -p --model=${model}` };
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
        parts.push(`  - [${f.severity}] \`${f.id}\` ${f.title}`);
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
  options: { resumedSession?: boolean; outputLanguage?: ResolvedOutputLanguage } = {},
): string {
  const reqId = detail.state.id;
  const lang: ResolvedOutputLanguage = options.outputLanguage ?? "zh-CN";

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
      "- 注：若当前处于只读沙箱且需要可写临时目录的浏览器/Puppeteer 用例因 EROFS 无法启动，请直接核验 `.workbench/items/" + reqId + "/evidence/` 既有真实运行日志并执行 `tsc --noEmit` 与非浏览器单元测试，勿将沙箱只读限制误判为代码缺失。",
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
  const modeVerb =
    input.action === "design"
      ? `请仅执行 ${reqId} 的设计阶段：梳理或修订规范、结构化验收条件与技术方案（设计验收条件时避免命令重复包含，例如若已有全量 \`bun test\`，仅在需独立隔离时保留子集测试以节省验证耗时），并通过 \`wb propose ${reqId} ...\`（或 MCP 工具 wb_propose）提交，同时在 --note 或 handoffNote 中总结关键决策。设计阶段禁止修改业务代码或测试，禁止运行 \`wb verify\`、\`wb tasks --ready\` 或把实施任务标记为完成；提交方案后立即结束本轮，等待人类在工作台审阅批准。`
      : input.action === "fix"
        ? hasReviewToFix || Boolean(detail.state.lastFeedback)
          ? `请结合交接简报第 1 节中的最新跨模型 Code Review 问题清单、人类反馈及失败/过期验收条件，逐条定位修复问题并补充必要的回归测试；改完后务必运行 \`wb verify ${reqId} --all\`（或 wb_verify）获取最新真实验证证据，全部通过后执行 \`wb tasks ${reqId} --ready\`。`
          : `请诊断并修复 ${reqId} 当前失败或过期的验收条件，改完后务必运行 \`wb verify ${reqId} --all\`（或 wb_verify）获取最新真实验证证据，全部通过后执行 \`wb tasks ${reqId} --ready\`。`
        : `请依据已确认的规范/方案完成 ${reqId} 的代码实现与测试验证：用 \`wb tasks ${reqId}\` 维护步骤，用 \`wb verify ${reqId} --all\` 跑通真实测试，全部通过后执行 \`wb tasks ${reqId} --ready\` 提交人类验收。`;

  const boundaryGuard =
    input.action === "design"
      ? "注意：你无权也无需执行批准或最终验收操作；本轮只产出方案，提交后立即停止，不要继续实施。"
      : "注意：你无权也无需执行批准或最终验收操作；修改代码后请重新运行真实测试验证。";

  const screenshotHint =
    input.action === "implement" || input.action === "fix"
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
  ].join("\n");
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

const CLI_NOISE_RE = /^Model ".*" is not available right now; using ".*" instead\.?(?: Use \/model to choose another model\.?)?$/i;

function stripCliNoise(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !CLI_NOISE_RE.test(line.trim()))
    .join("\n");
}

function summarizeToolInput(inp: unknown): string {
  if (!inp || typeof inp !== "object") return "";
  const rec = inp as Record<string, unknown>;
  const raw =
    typeof rec.command === "string"
      ? rec.command
      : typeof rec.file_path === "string"
        ? rec.file_path
        : typeof rec.path === "string"
          ? rec.path
          : typeof rec.pattern === "string"
            ? rec.pattern
            : "";
  return raw.replace(/\s+/g, " ").trim().slice(0, 90);
}

interface ParsedStreamLine {
  displayText: string;
  replyText: string | null;
  sessionId?: string;
  effectiveModel?: string;
  modelFallback?: boolean;
}

function parseQoderStreamLine(rawLine: string, fallbackModel: string, hasPriorReply: boolean): ParsedStreamLine {
  const trimmed = rawLine.trim();
  if (!trimmed || CLI_NOISE_RE.test(trimmed)) {
    return { displayText: "", replyText: null };
  }
  if (trimmed.startsWith("{")) {
    try {
      const evt = JSON.parse(trimmed) as {
        type?: string;
        subtype?: string;
        model?: string;
        session_id?: string;
        result?: string;
        is_error?: boolean;
        duration_ms?: number;
        message?: {
          content?: Array<{
            type?: string;
            thinking?: string;
            text?: string;
            name?: string;
            input?: unknown;
          }>;
        };
      };
      const isQoderEnvelope =
        typeof evt.session_id === "string" &&
        (evt.type === "system" || evt.type === "assistant" || evt.type === "user" || evt.type === "result");
      if (!isQoderEnvelope) {
        return { displayText: `${trimmed}\n`, replyText: null };
      }
      const sessionId = evt.session_id;
      if (evt.type === "system") {
        if (evt.subtype === "init") {
          const requested = fallbackModel && fallbackModel !== "default" ? fallbackModel : "";
          const reported = typeof evt.model === "string" ? evt.model.trim() : "";
          const actual = reported || fallbackModel;
          const modelFallback = Boolean(
            requested && requested.toLowerCase() !== "auto" && actual.toLowerCase() === "auto",
          );
          const fallbackNote = modelFallback
            ? ` ⚠️ 请求模型 ${requested} 不可用，已自动回退为 auto`
            : "";
          return {
            displayText: `⚡ Qoder 引擎已就绪 (model: ${actual}${fallbackNote})\n`,
            replyText: null,
            sessionId,
            ...(reported ? { effectiveModel: actual } : {}),
            ...(modelFallback ? { modelFallback: true } : {}),
          };
        }
        return { displayText: "", replyText: null, sessionId };
      }
      if (evt.type === "assistant" && Array.isArray(evt.message?.content)) {
        const displayParts: string[] = [];
        const replyParts: string[] = [];
        for (const block of evt.message.content) {
          if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
            displayParts.push(`💭 ${block.thinking.trim()}`);
          } else if (block.type === "tool_use" && typeof block.name === "string") {
            const summary = summarizeToolInput(block.input);
            displayParts.push(`🔧 调用工具: ${block.name}${summary ? ` (${summary})` : ""}`);
          } else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
            const text = block.text.trim();
            displayParts.push(text);
            replyParts.push(text);
          }
        }
        return {
          displayText: displayParts.length > 0 ? `${displayParts.join("\n")}\n` : "",
          replyText: replyParts.length > 0 ? replyParts.join("\n\n") : null,
          sessionId,
        };
      }
      if (evt.type === "result") {
        const resultText = typeof evt.result === "string" && evt.result.trim() ? evt.result.trim() : null;
        const sec = ((Number(evt.duration_ms) || 0) / 1000).toFixed(1);
        if (evt.is_error) {
          return {
            displayText: resultText ? `❌ ${resultText}\n` : `❌ 执行异常结束 (${sec}s)\n`,
            replyText: null,
            sessionId,
          };
        }
        return {
          displayText: `\n✓ 执行完成 (耗时 ${sec}s)\n`,
          replyText: !hasPriorReply ? resultText : null,
          sessionId,
        };
      }
      return { displayText: "", replyText: null, sessionId };
    } catch {
      // Fall through and treat as plain stdout text if line is not valid JSON.
    }
  }
  return { displayText: `${trimmed}\n`, replyText: null };
}

export type TelemetryOutcomeInput = Parameters<typeof recordModelRunOutcome>[0];

export class HubExecutor {
  private readonly activeJobs = new Map<string, ActiveJob>();
  private readonly runLogs = new Map<string, string>();
  private readonly listeners = new Set<(ev: RunExecutorEvent) => void>();
  private readonly cliEntryPath: string;
  private readonly commandBuilder?: CustomCommandBuilder;
  private readonly getHubPreferences?: () => { routing?: RoutingConfig; outputLanguage?: OutputLanguage };
  private readonly onTelemetryOutcome?: (outcome: TelemetryOutcomeInput) => void;
  private readonly onPainPoint?: (input: PainPointReportInput) => EvolutionPainPoint | null;
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
    getHubPreferences?: () => { routing?: RoutingConfig; outputLanguage?: OutputLanguage };
    onTelemetryOutcome?: (outcome: TelemetryOutcomeInput) => void;
    onPainPoint?: (input: PainPointReportInput) => EvolutionPainPoint | null;
    nodeId?: string;
  } = {}) {
    this.cliEntryPath = options.cliEntryPath ?? path.resolve(import.meta.dir, "../cli/index.ts");
    this.commandBuilder = options.commandBuilder;
    this.getHubPreferences = options.getHubPreferences;
    this.onTelemetryOutcome = options.onTelemetryOutcome;
    this.onPainPoint = options.onPainPoint;
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
    const harnesses = await this.getHarnesses(false);
    const codeRoot = resolveCodeRoot(base, id);
    const currentDetail = getRequirement(base, id, { currentCodeSnapshotHash: (await observeGitSnapshot(codeRoot))?.fingerprint ?? null });
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
    const prevRun = (currentDetail.state.agentRuns ?? []).slice(-1)[0] ?? null;

    const override: Partial<ModelTarget> | null =
      input.harness && input.model
        ? { harness: input.harness as ModelTarget["harness"], model: input.model, reasoningEffort: input.reasoningEffort }
        : input.reasoningEffort
          ? { reasoningEffort: input.reasoningEffort }
          : null;
    const candidates = resolveRouteCandidates(activeRouting, harnesses, input.action, override);

    let target = candidates[0]!;
    if (input.useFallback && prevRun) {
      const next = candidates.find((c) => `${c.harness}::${c.model}` !== `${prevRun.harness}::${prevRun.model}`);
      if (next) target = next;
    }

    // Persist human discussion/annotation if supplied before execution
    if (input.message?.trim() && (input.action === "ask" || input.mode === "refine" || input.action === "design")) {
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

    const prevTail = prevRun ? (this.runLogs.get(prevRun.id) ?? undefined) : undefined;
    const {
      markdown: handoffMd,
      detail: postHandoffDetail,
      outputLanguage,
    } = await synthesizeHandoffPacket(base, id, {
      action: input.action,
      humanInstruction: input.message,
      anchorIds: input.anchorIds,
      previousRun: prevRun,
      previousLogTail: prevTail,
      hubOutputLanguage,
    });

    // Determine whether we can safely use same-harness native session resume
    const canResumeSameHarness =
      !input.useFallback &&
      prevRun &&
      prevRun.harness === target.harness &&
      Boolean(prevRun.nativeSessionId) &&
      prevRun.status !== "cancelled" &&
      !prevRun.rateLimited &&
      input.action !== "review";

    const prompt = buildExecutionPrompt(postHandoffDetail, handoffMd, input, {
      resumedSession: Boolean(canResumeSameHarness),
      outputLanguage,
    });
    const built = this.commandBuilder
      ? this.commandBuilder(target, {
          root: codeRoot,
          requirementId: id,
          action: input.action,
          prompt,
          nativeSessionId: canResumeSameHarness ? prevRun!.nativeSessionId : undefined,
          harnesses,
        })
      : buildHarnessCommand(target, {
          root: codeRoot,
          action: input.action,
          prompt,
          nativeSessionId: canResumeSameHarness ? prevRun!.nativeSessionId : undefined,
          harnesses,
        });

    const startedAt = Date.now();
    const runId = `RUN-${startedAt}-${randomUUID().slice(0, 6)}`;
    const record: AgentRunRecord = {
      id: runId,
      action: input.action,
      harness: target.harness,
      model: target.model,
      ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}),
      status: "running",
      startedAt,
      endedAt: null,
      exitCode: null,
      durationMs: 0,
      logPath: `runs/run-${runId}.log`,
    };

    const snapshotBefore = await observeGitSnapshot(codeRoot);
    const detail = await startAgentRun(base, id, record, snapshotBefore?.fingerprint ?? null);
    if (codeRoot !== base) {
      syncRequirementMirrorToSandbox(base, id, codeRoot);
    }

    const shimBin = ensureWbShim(this.cliEntryPath);
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${shimBin}:${process.env.PATH ?? ""}`,
      WORKBENCH_ROOT: base,
      WORKBENCH_REQ_ID: id,
      WORKBENCH_OUTPUT_LANGUAGE: outputLanguage,
      ...(codeRoot !== base ? { WORKBENCH_RSI_DEPTH: "1" } : {}),
    };

    this.runLogs.set(runId, `$ ${built.displayCommand}\n`);
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
      child,
      startedAt,
      cancelled: false,
      timedOut: false,
      timeoutReason: null,
    };
    this.activeJobs.set(runId, job);

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
      const text = sanitizeOutput(rawChunk, 32 * 1024).text;
      if (!text) return;
      const cur = (this.runLogs.get(runId) ?? "") + text;
      const bounded = cur.length > MAX_EVIDENCE_BYTES ? cur.slice(cur.length - MAX_EVIDENCE_BYTES) : cur;
      this.runLogs.set(runId, bounded);
      this.emit({
        type: "agent.run.output",
        root: base,
        requirementId: id,
        runId,
        chunk: text,
        at: Date.now(),
      });
    };

    const handleQoderLine = (line: string) => {
      const parsed = parseQoderStreamLine(line, target.model, cleanReplyParts.length > 0);
      if (parsed.sessionId) capturedSessionId = parsed.sessionId;
      if (parsed.effectiveModel) job.effectiveModel = parsed.effectiveModel;
      if (parsed.modelFallback) job.modelFallback = true;
      if (parsed.replyText) cleanReplyParts.push(parsed.replyText);
      if (parsed.displayText) emitCleanChunk(parsed.displayText);
    };

    const onStdoutChunk = (buf: Buffer) => {
      if (buf.length > 0) resetIdleTimer();
      const chunk = buf.toString("utf8");
      if (target.harness !== "qodercn") {
        const cleaned = stripCliNoise(chunk);
        if (cleaned) {
          appendStdoutReply(cleaned);
          emitCleanChunk(cleaned);
        }
        return;
      }
      stdoutLineBuf += chunk;
      const lines = stdoutLineBuf.split(/\r?\n/);
      stdoutLineBuf = lines.pop() ?? "";
      for (const line of lines) {
        handleQoderLine(line);
      }
    };

    const onStderrChunk = (buf: Buffer) => {
      if (buf.length > 0) resetIdleTimer();
      const cleaned = stripCliNoise(buf.toString("utf8"));
      if (cleaned.trim()) emitCleanChunk(cleaned);
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

      if (target.harness === "qodercn" && stdoutLineBuf.trim()) {
        handleQoderLine(stdoutLineBuf);
        stdoutLineBuf = "";
      }

      const endedAt = Date.now();
      const durationMs = Math.max(0, endedAt - startedAt);
      const rawLog = (this.runLogs.get(runId) ?? "") + (spawnErr ? `\n[spawn error] ${spawnErr}\n` : "");
      const rateLimited = !job.cancelled && !job.timedOut && detectRateLimitOrQuotaError(rawLog, exitCode);
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
          ? reviewParseFailed
            ? "审查输出缺少可解析的结构化结论（需在末尾输出 ```json {\"verdict\":\"pass|concern|block\",\"summary\":\"…\"} ```），未写入审查报告；请重跑跨模型审查"
            : job.timedOut
              ? job.timeoutReason === "max_duration"
                ? `执行超时（单次运行已达安全上限 ${Math.round(maxDurationMs / 1000)}s），已保留当前代码与会话进度，可直接继续执行接力完成`
                : `执行超时（连续 ${Math.round(idleTimeoutMs / 1000)}s 无输出或进展，疑似网络断流或命令挂起），建议检查代理或重试`
              : rateLimited
                ? `${target.harness}/${target.model} 疑似额度不足或触发限流，建议切换备援模型接力重试`
                : (spawnErr || rawLog.trim().split(/\r?\n/).slice(-3).join(" | ").slice(0, 300) || `退出码 ${exitCode}`)
          : undefined;

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
          now: endedAt,
        };
        if (this.onTelemetryOutcome) {
          this.onTelemetryOutcome(outcome);
        } else {
          recordModelRunOutcome(outcome);
        }
      } catch {
        // Telemetry write failure must not abort run finalization.
      }

      let postRunDetail: RequirementDetail | null = null;
      try {
        if (codeRoot !== base) {
          await reconcileRsiSandboxBaseline(base, id).catch(() => null);
        }
        const snap = await observeGitSnapshot(codeRoot);
        const latestReq = getRequirement(base, id, { currentCodeSnapshotHash: snap?.fingerprint ?? null });

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
        } else if (status === "succeeded" && input.action === "review" && snap?.fingerprint && parsedReview) {
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
        at: endedAt,
      });
      this.emit({
        type: "workbench.updated",
        root: base,
        requirementId: id,
        runId,
        at: endedAt,
      });

      // Auto-trigger cross-model review once implement/fix succeeds and submits for acceptance.
      if (
        status === "succeeded" &&
        (input.action === "implement" || input.action === "fix") &&
        postRunDetail &&
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
            const canAutoRun =
              Boolean(reviewTarget) &&
              (availHarnesses.some((h) => h.id === reviewTarget!.harness && h.installed) ||
                Boolean(this.commandBuilder));
            const alreadyRunning = this.getActiveRuns(base).some((r) => r.requirementId === id);
            if (canAutoRun && !alreadyRunning) {
              void this.startRun({
                root: base,
                requirementId: id,
                action: "review",
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

  stopAllRuns(): void {
    for (const job of this.activeJobs.values()) {
      job.cancelled = true;
      this.killProcessGroup(job);
    }
  }
}
