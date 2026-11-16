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
import { canonicalRoot } from "../core/fs.ts";
import { observeGitSnapshot } from "../core/git.ts";
import { MAX_EVIDENCE_BYTES, type AgentAction, type AgentRunRecord, type RequirementDetail, type ReviewVerdict } from "../core/types.ts";
import { sanitizeOutput } from "../core/validate.ts";
import { discoverHarnesses, discoverHarnessesQuick } from "./discovery.ts";
import { synthesizeHandoffPacket } from "./handoff.ts";
import { readHubConfig, resolveHubDir } from "./registry.ts";
import { detectRateLimitOrQuotaError, resolveRouteCandidates } from "./routing.ts";
import type { HarnessInfo, ModelTarget } from "./types.ts";

export interface BuiltCommand {
  command: string;
  args: string[];
  displayCommand: string;
}

export interface RunExecutorEvent {
  type: "agent.run.started" | "agent.run.output" | "agent.run.finished" | "workbench.updated";
  root: string;
  requirementId: string;
  runId: string;
  action?: AgentAction;
  harness?: string;
  model?: string;
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
}

interface ActiveJob {
  runId: string;
  root: string;
  requirementId: string;
  action: AgentAction;
  target: ModelTarget;
  child: ChildProcess;
  startedAt: number;
  cancelled: boolean;
  killTimer?: ReturnType<typeof setTimeout>;
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
    fs.writeFileSync(shimPath, content, { mode: 0o755 });
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
      if (ctx.nativeSessionId && ctx.action !== "review") {
        const args = ["exec", "resume", ctx.nativeSessionId, ctx.prompt];
        return { command: bin, args, displayCommand: `${bin} exec resume ${ctx.nativeSessionId}` };
      }
      const safetyFlags =
        ctx.action === "ask" || ctx.action === "review"
          ? ["-s", "read-only"]
          : ["--dangerously-bypass-approvals-and-sandbox"];
      const args = [
        "exec",
        "-C",
        ctx.root,
        "--skip-git-repo-check",
        ...(model && model !== "default" ? ["-m", model] : []),
        ...(effort ? ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
        ...safetyFlags,
        ctx.prompt,
      ];
      return { command: bin, args, displayCommand: `${bin} exec -C ${ctx.root} ${safetyFlags.join(" ")} (model=${model})` };
    }

    case "qodercn": {
      const bin = exe || "qodercn";
      const args = [
        "-w",
        ctx.root,
        "-o",
        "stream-json",
        "--permission-mode",
        "auto",
        ...(model && model !== "default" && model !== "Auto" ? ["-m", model] : []),
        ...(effort ? ["--reasoning-effort", effort] : []),
        "-p",
        ctx.prompt,
      ];
      return { command: bin, args, displayCommand: `${bin} -p -o stream-json -m ${model}` };
    }

    case "opencode": {
      const bin = exe || "opencode";
      const args = [
        "run",
        "--auto",
        ...(model && model !== "default" ? ["--model", model] : []),
        ...(ctx.nativeSessionId ? ["--session", ctx.nativeSessionId] : []),
        ctx.prompt,
      ];
      return { command: bin, args, displayCommand: `${bin} run --model ${model}` };
    }

    case "gemini": {
      const usesMise = Boolean(exe && exe.startsWith("mise "));
      const baseCmd = usesMise ? "mise" : exe || "gemini";
      const prefixArgs = usesMise ? ["x", "node@24.4.1", "--", "gemini"] : [];
      const args = [
        ...prefixArgs,
        "-p",
        ctx.prompt,
        ...(ctx.action === "ask" || ctx.action === "review" ? ["--approval-mode", "plan"] : ["--yolo"]),
        ...(model && model !== "default" ? ["-m", model] : []),
        ...(ctx.nativeSessionId ? ["--resume", ctx.nativeSessionId] : []),
      ];
      return { command: baseCmd, args, displayCommand: `gemini -p (model=${model})` };
    }

    case "omp": {
      const bin = exe || "omp";
      const args = [
        "-p",
        `--cwd=${ctx.root}`,
        ...(model && model !== "default" ? [`--model=${model}`] : []),
        ...(ctx.nativeSessionId ? [`--resume=${ctx.nativeSessionId}`] : []),
        ctx.prompt,
      ];
      return { command: bin, args, displayCommand: `${bin} -p --model=${model}` };
    }
  }
}

export function buildExecutionPrompt(
  detail: RequirementDetail,
  handoffMarkdown: string,
  input: StartRunInput,
): string {
  const reqId = detail.state.id;
  if (input.action === "ask") {
    return [
      `你当前处于「仅提问探讨（Read-Only Consultation）」模式，请针对需求 ${reqId}（${detail.state.title}）回答用户问题。`,
      "重要约束：",
      "- 严禁修改任何仓库代码、严禁运行写操作工具、严禁修改 .workbench/ 文件或调用 wb propose / wb tasks。",
      "- 请直接用清晰简练的中文 Markdown 给出解答、原理分析或方案权衡建议。",
      "",
      input.anchor ? `提问锚点：${input.anchor}` : "",
      `用户问题：${input.message?.trim() || "请解释当前技术方案的核心思路与风险点。"}`,
      "",
      "参考上下文简报：",
      handoffMarkdown,
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (input.action === "review") {
    return [
      `请你作为独立的代码与交付审查者（Cross-Model Reviewer），审查工作台需求 ${reqId}（${detail.state.title}）。`,
      "重要约束：",
      "- 严禁修改仓库业务代码或调用 wb propose / wb tasks；只读检查 Git Diff、测试证据与 Spec 一致性。",
      "- 请在输出最后附上一个明确的结论 JSON 块，格式严格如下：",
      '```json\n{"verdict":"pass"|"concern"|"block","summary":"一句话核心审查结论"}\n```',
      "",
      "审查范围与交接简报（包含需求契约、验收状态与当前 Git 现场）：",
      handoffMarkdown,
    ].join("\n");
  }

  const modeVerb =
    input.action === "design"
      ? `请梳理或修订 ${reqId} 的规范、结构化验收条件与技术方案，并通过 \`wb propose ${reqId} ...\`（或 MCP 工具 wb_propose）提交，同时在 --note 或 handoffNote 中总结关键决策。`
      : input.action === "fix"
        ? `请诊断并修复 ${reqId} 当前失败或过期的验收条件，改完后务必运行 \`wb verify ${reqId} --all\`（或 wb_verify）获取最新真实验证证据，全部通过后执行 \`wb tasks ${reqId} --ready\`。`
        : `请依据已确认的规范/方案完成 ${reqId} 的代码实现与测试验证：用 \`wb tasks ${reqId}\` 维护步骤，用 \`wb verify ${reqId} --all\` 跑通真实测试，全部通过后执行 \`wb tasks ${reqId} --ready\` 提交人类验收。`;

  return [
    `请接力执行工作台需求 ${reqId}（可用命令行 \`wb\` 工具操作，WORKBENCH_ROOT 已自动指向当前仓库）。`,
    modeVerb,
    "注意：你无权也无需执行批准或最终验收操作；修改代码后请重新运行真实测试验证。",
    "",
    handoffMarkdown,
  ].join("\n");
}

function parseReviewOutput(rawOutput: string): { verdict: ReviewVerdict; summary: string; markdown: string } {
  const clean = sanitizeOutput(rawOutput, 48 * 1024).text.trim();
  const jsonBlocks = Array.from(clean.matchAll(/```json\s*([\s\S]*?)```/gi));
  for (let i = jsonBlocks.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(jsonBlocks[i]![1]!) as { verdict?: string; summary?: string };
      if (parsed.verdict === "pass" || parsed.verdict === "concern" || parsed.verdict === "block") {
        return {
          verdict: parsed.verdict,
          summary: parsed.summary?.trim() || `审查结论：${parsed.verdict}`,
          markdown: clean,
        };
      }
    } catch {
      // Try earlier block or fallback heuristic.
    }
  }
  const lower = clean.toLowerCase();
  const verdict: ReviewVerdict = /\bblock\b|阻塞|严重缺陷|不通过/.test(lower)
    ? "block"
    : /\bconcern\b|风险|建议修改|注意/.test(lower)
      ? "concern"
      : "pass";
  const firstLine = clean.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim().slice(0, 180) ?? "已完成代码审查";
  return { verdict, summary: firstLine, markdown: clean || "（空审查输出）" };
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
          return {
            displayText: `⚡ Qoder 引擎已就绪 (model: ${evt.model || fallbackModel})\n`,
            replyText: null,
            sessionId,
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

export class HubExecutor {
  private readonly activeJobs = new Map<string, ActiveJob>();
  private readonly runLogs = new Map<string, string>();
  private readonly listeners = new Set<(ev: RunExecutorEvent) => void>();
  private readonly cliEntryPath: string;
  private readonly commandBuilder?: CustomCommandBuilder;
  private cachedHarnesses: HarnessInfo[] | null = null;

  constructor(options: {
    cliEntryPath?: string;
    commandBuilder?: CustomCommandBuilder;
    initialHarnesses?: HarnessInfo[];
  } = {}) {
    this.cliEntryPath = options.cliEntryPath ?? path.resolve(import.meta.dir, "../cli/index.ts");
    this.commandBuilder = options.commandBuilder;
    if (options.initialHarnesses) {
      this.cachedHarnesses = options.initialHarnesses;
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

  async getHarnesses(forceRefresh = false, quickOnly = false): Promise<HarnessInfo[]> {
    const cfg = readHubConfig();
    if (forceRefresh) {
      this.cachedHarnesses = await discoverHarnesses(cfg.customModels);
      return this.cachedHarnesses;
    }
    if (!this.cachedHarnesses) {
      this.cachedHarnesses = discoverHarnessesQuick(cfg.customModels);
      if (!quickOnly) {
        void discoverHarnesses(cfg.customModels)
          .then((full) => {
            this.cachedHarnesses = full;
          })
          .catch(() => {});
      }
    }
    return this.cachedHarnesses;
  }

  syncCustomModels(customModels: Record<string, string[]>): HarnessInfo[] {
    const base = this.cachedHarnesses ?? discoverHarnessesQuick(customModels);
    this.cachedHarnesses = base.map((h) => {
      const extras = customModels[h.id] ?? [];
      const seen = new Set(h.models.map((m) => m.id));
      const merged = [...h.models];
      for (const id of extras) {
        if (!seen.has(id)) {
          seen.add(id);
          merged.push({ id, tier: "balanced", source: "custom" });
        }
      }
      return { ...h, models: merged };
    });
    return this.cachedHarnesses;
  }

  getActiveRuns(root?: string): Array<AgentRunRecord & { requirementId: string }> {
    const out: Array<AgentRunRecord & { requirementId: string }> = [];
    for (const job of this.activeJobs.values()) {
      if (root && job.root !== root) continue;
      out.push({
        id: job.runId,
        requirementId: job.requirementId,
        action: job.action,
        harness: job.target.harness,
        model: job.target.model,
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

    const cfg = readHubConfig();
    const harnesses = await this.getHarnesses(false);
    const currentDetail = getRequirement(base, id, { currentCodeSnapshotHash: (await observeGitSnapshot(base))?.fingerprint ?? null });
    const prevRun = (currentDetail.state.agentRuns ?? []).slice(-1)[0] ?? null;

    const override: Partial<ModelTarget> | null =
      input.harness && input.model
        ? { harness: input.harness as ModelTarget["harness"], model: input.model, reasoningEffort: input.reasoningEffort }
        : null;
    const candidates = resolveRouteCandidates(cfg.routing, harnesses, input.action, override);

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
    const { markdown: handoffMd, detail: postHandoffDetail } = await synthesizeHandoffPacket(base, id, {
      action: input.action,
      humanInstruction: input.message,
      anchorIds: input.anchorIds,
      previousRun: prevRun,
      previousLogTail: prevTail,
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

    const prompt = buildExecutionPrompt(postHandoffDetail, handoffMd, input);
    const built = this.commandBuilder
      ? this.commandBuilder(target, {
          root: base,
          requirementId: id,
          action: input.action,
          prompt,
          nativeSessionId: canResumeSameHarness ? prevRun!.nativeSessionId : undefined,
          harnesses,
        })
      : buildHarnessCommand(target, {
          root: base,
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

    const snapshotBefore = await observeGitSnapshot(base);
    const detail = await startAgentRun(base, id, record, snapshotBefore?.fingerprint ?? null);

    const shimBin = ensureWbShim(this.cliEntryPath);
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${shimBin}:${process.env.PATH ?? ""}`,
      WORKBENCH_ROOT: base,
      WORKBENCH_REQ_ID: id,
    };

    this.runLogs.set(runId, `$ ${built.displayCommand}\n`);
    const child = spawn(built.command, built.args, {
      cwd: base,
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

    const timeoutMs = input.timeoutMs ?? 600_000;
    const timeoutTimer = setTimeout(() => {
      this.killProcessGroup(job);
    }, timeoutMs);

    const cleanReplyParts: string[] = [];
    let stdoutLineBuf = "";
    let capturedSessionId: string | undefined;

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
      if (parsed.replyText) cleanReplyParts.push(parsed.replyText);
      if (parsed.displayText) emitCleanChunk(parsed.displayText);
    };

    const onStdoutChunk = (buf: Buffer) => {
      const chunk = buf.toString("utf8");
      if (target.harness !== "qodercn") {
        const cleaned = stripCliNoise(chunk);
        if (cleaned) emitCleanChunk(cleaned);
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
      const cleaned = stripCliNoise(buf.toString("utf8"));
      if (cleaned.trim()) emitCleanChunk(cleaned);
    };

    child.stdout?.on("data", onStdoutChunk);
    child.stderr?.on("data", onStderrChunk);

    let finalized = false;
    const finalize = async (exitCode: number | null, spawnErr?: string) => {
      if (finalized) return;
      finalized = true;
      clearTimeout(timeoutTimer);
      if (job.killTimer) clearTimeout(job.killTimer);
      this.activeJobs.delete(runId);

      if (target.harness === "qodercn" && stdoutLineBuf.trim()) {
        handleQoderLine(stdoutLineBuf);
        stdoutLineBuf = "";
      }

      const endedAt = Date.now();
      const durationMs = Math.max(0, endedAt - startedAt);
      const rawLog = (this.runLogs.get(runId) ?? "") + (spawnErr ? `\n[spawn error] ${spawnErr}\n` : "");
      const rateLimited = !job.cancelled && detectRateLimitOrQuotaError(rawLog, exitCode);
      const status: AgentRunRecord["status"] = job.cancelled
        ? "cancelled"
        : exitCode === 0 && !spawnErr
          ? "succeeded"
          : "failed";

      const sessMatch = /session[_ -]?id[:=]\s*([A-Za-z0-9._-]{6,64})/i.exec(rawLog);
      const nativeSessionId = capturedSessionId ?? sessMatch?.[1];
      const errorSummary =
        status === "failed"
          ? rateLimited
            ? `${target.harness}/${target.model} 疑似额度不足或触发限流，建议切换备援模型接力重试`
            : (spawnErr || rawLog.trim().split(/\r?\n/).slice(-3).join(" | ").slice(0, 300) || `退出码 ${exitCode}`)
          : undefined;

      try {
        const snap = await observeGitSnapshot(base);
        const latestReq = getRequirement(base, id, { currentCodeSnapshotHash: snap?.fingerprint ?? null });

        // Post-run side effects by action
        if (status === "succeeded" && input.action === "ask") {
          const cleanAnswer =
            cleanReplyParts.join("\n\n").trim() ||
            stripCliNoise(rawLog.replace(/^\$ .*\n/, ""))
              .trim();
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
        } else if (status === "succeeded" && input.action === "review" && snap?.fingerprint) {
          const reviewSource =
            cleanReplyParts.join("\n\n").trim() || stripCliNoise(rawLog.replace(/^\$ .*\n/, ""));
          const parsed = parseReviewOutput(reviewSource);
          await recordReviewReport(base, id, {
            reviewerHarness: target.harness,
            reviewerModel: target.model,
            verdict: parsed.verdict,
            summary: parsed.summary,
            markdown: parsed.markdown,
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
            errorSummary,
          },
          rawLog,
          snap?.fingerprint ?? null,
        );

        const lastRunObj = (finishedDetail.state.agentRuns ?? []).find((r) => r.id === runId) ?? null;
        await synthesizeHandoffPacket(base, id, {
          action: input.action,
          previousRun: lastRunObj,
          previousLogTail: rawLog.slice(-1500),
        });
      } catch {
        // Keep daemon alive even if workspace disappeared during run.
      }

      this.emit({
        type: "agent.run.finished",
        root: base,
        requirementId: id,
        runId,
        action: input.action,
        harness: target.harness,
        model: target.model,
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
