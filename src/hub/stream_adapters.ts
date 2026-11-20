import {
  MAX_TOOL_INPUT_BYTES,
  MAX_TOOL_OUTPUT_BYTES,
  MAX_TRACE_TEXT_BYTES,
  type RunTokenUsage,
  type RunToolCategory,
  type RunTraceEvent,
} from "../core/types.ts";
import { clipHeadTailUtf8, sanitizeOutput } from "../core/validate.ts";
import type { HarnessId } from "./types.ts";

const CLI_NOISE_RE =
  /^Model ".*" is not available right now; using ".*" instead\.?(?: Use \/model to choose another model\.?)?$/i;

const UNSUPPORTED_JSON_FLAG_RE =
  /(?:unknown|unexpected|unrecognized|invalid)\s+(?:option|argument|flag)[^\n]*(?:--json|--format|--output-format|--mode)/i;

export function stripCliNoise(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !CLI_NOISE_RE.test(line.trim()))
    .join("\n");
}

export function isUnsupportedJsonFlagError(text: string): boolean {
  return UNSUPPORTED_JSON_FLAG_RE.test(text);
}

export type PartialTraceEvent =
  | Omit<Extract<RunTraceEvent, { type: "turn.start" }>, "seq" | "ts">
  | Omit<Extract<RunTraceEvent, { type: "turn.end" }>, "seq" | "ts">
  | Omit<Extract<RunTraceEvent, { type: "thinking" }>, "seq" | "ts">
  | Omit<Extract<RunTraceEvent, { type: "tool.start" }>, "seq" | "ts">
  | Omit<Extract<RunTraceEvent, { type: "tool.end" }>, "seq" | "ts">
  | Omit<Extract<RunTraceEvent, { type: "context.compaction" }>, "seq" | "ts">
  | Omit<Extract<RunTraceEvent, { type: "assistant.message" }>, "seq" | "ts">
  | Omit<Extract<RunTraceEvent, { type: "raw.line" }>, "seq" | "ts">
  | Omit<Extract<RunTraceEvent, { type: "run.error" }>, "seq" | "ts">;

export interface AdapterLineResult {
  events: PartialTraceEvent[];
  displayText: string;
  replyText: string | null;
  sessionId?: string;
  effectiveModel?: string;
  modelFallback?: boolean;
  /** Authoritative run-level totals emitted by CLIs like qodercn/agy `result`. */
  authoritativeUsage?: RunTokenUsage;
  authoritativeCostUsd?: number;
  authoritativeTurnsCount?: number;
}

export interface HarnessStreamAdapter {
  feedLine(rawLine: string): AdapterLineResult;
  flush(): AdapterLineResult | null;
}

function summarizeToolInput(inp: unknown): string {
  if (typeof inp === "string") return inp.replace(/\s+/g, " ").trim().slice(0, 90);
  if (!inp || typeof inp !== "object") return "";
  const rec = inp as Record<string, unknown>;
  const raw =
    typeof rec.command === "string"
      ? rec.command
      : typeof rec.cmd === "string"
        ? rec.cmd
        : typeof rec.file_path === "string"
          ? rec.file_path
          : typeof rec.TargetFile === "string"
            ? rec.TargetFile
            : typeof rec.path === "string"
              ? rec.path
              : typeof rec.pattern === "string"
                ? rec.pattern
                : typeof rec.query === "string"
                  ? rec.query
                  : "";
  return raw.replace(/\s+/g, " ").trim().slice(0, 90);
}

function formatToolInputBounded(inp: unknown): { text?: string; truncated?: boolean } {
  if (inp === undefined || inp === null) return {};
  let raw: string;
  if (typeof inp === "string") {
    raw = inp;
  } else {
    try {
      raw = JSON.stringify(inp, null, 2);
    } catch {
      raw = String(inp);
    }
  }
  if (!raw.trim()) return {};
  const clipped = clipHeadTailUtf8(raw, 10 * 1024, MAX_TOOL_INPUT_BYTES - 10 * 1024);
  return {
    text: clipped.text,
    ...(clipped.truncated ? { truncated: true } : {}),
  };
}

function formatToolOutputBounded(rawOut: unknown): {
  output?: string;
  outputBytes?: number;
  outputTruncated?: boolean;
} {
  if (rawOut === undefined || rawOut === null) return {};
  let raw: string;
  if (typeof rawOut === "string") {
    raw = rawOut;
  } else if (Array.isArray(rawOut)) {
    const parts = rawOut.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
        return (item as { text: string }).text;
      }
      try {
        return JSON.stringify(item);
      } catch {
        return String(item);
      }
    });
    raw = parts.join("\n");
  } else {
    try {
      raw = JSON.stringify(rawOut, null, 2);
    } catch {
      raw = String(rawOut);
    }
  }
  const clipped = clipHeadTailUtf8(raw, 20 * 1024, MAX_TOOL_OUTPUT_BYTES - 20 * 1024);
  return {
    output: clipped.text,
    outputBytes: clipped.bytes,
    ...(clipped.truncated ? { outputTruncated: true } : {}),
  };
}

function formatTraceTextBounded(raw: string): { text: string; truncated: boolean } {
  const head = 40 * 1024;
  const tail = MAX_TRACE_TEXT_BYTES - head;
  const clipped = clipHeadTailUtf8(raw, head, tail);
  return { text: clipped.text, truncated: clipped.truncated };
}

export function extractWbCommand(toolName: string, input: unknown): string | undefined {
  const lower = toolName.trim().toLowerCase();
  if (/^(?:mcp__.*__)?wb_(list|get|propose|update_tasks|verify|screenshot)$/.test(lower)) {
    const sub = lower.replace(/^.*wb_/, "");
    return `wb_${sub}`;
  }
  if (input && typeof input === "object") {
    const rec = input as Record<string, unknown>;
    const cmd = typeof rec.command === "string" ? rec.command : typeof rec.cmd === "string" ? rec.cmd : "";
    const match = /(?:^|[;&|\s(])wb\s+(propose|verify|tasks|screenshot|get|list|show)\b/.exec(cmd);
    if (match) return `wb ${match[1]}`;
  } else if (typeof input === "string") {
    const match = /(?:^|[;&|\s(])wb\s+(propose|verify|tasks|screenshot|get|list|show)\b/.exec(input);
    if (match) return `wb ${match[1]}`;
  }
  return undefined;
}

export function classifyToolName(toolName: string, input?: unknown): RunToolCategory {
  if (extractWbCommand(toolName, input)) return "wb_cli";
  const lower = toolName.trim().toLowerCase();
  if (/^(?:bash|sh|shell|exec|command_execution|run_command|execute|terminal)$/.test(lower)) return "bash";
  if (lower.startsWith("mcp__") || lower.includes("mcp")) return "mcp";
  if (/subagent|invoke_subagent|delegate|spawn_agent|task(?:_tool)?$/.test(lower)) return "subagent";
  if (/web_search|search_web|fetch|read_url|webfetch|browser/.test(lower)) return "web";
  if (/write|edit|replace|patch|file_change|create_file|delete_file|notebookedit/.test(lower)) return "write";
  if (/grep|glob|search|find|list_dir|ls$/.test(lower)) return "search";
  if (/read|view|cat|open_file/.test(lower)) return "read";
  return "other";
}

export function extractTouchedFiles(toolName: string, input: unknown): {
  all: string[];
  read: string[];
  written: string[];
} {
  const cat = classifyToolName(toolName, input);
  const paths: string[] = [];
  const collect = (v: unknown) => {
    if (typeof v === "string" && v.trim() && v.length < 400 && !v.includes("\n")) {
      paths.push(v.trim());
    }
  };
  if (input && typeof input === "object") {
    const rec = input as Record<string, unknown>;
    collect(rec.file_path);
    collect(rec.path);
    collect(rec.AbsolutePath);
    collect(rec.TargetFile);
    collect(rec.target_file);
    collect(rec.SearchPath);
    if (Array.isArray(rec.paths)) for (const p of rec.paths) collect(p);
    if (Array.isArray(rec.files)) for (const p of rec.files) collect(p);
    if (Array.isArray(rec.changes)) {
      for (const ch of rec.changes) {
        if (ch && typeof ch === "object") collect((ch as Record<string, unknown>).path);
      }
    }
  }
  const uniq = Array.from(new Set(paths)).slice(0, 24);
  if (cat === "write") return { all: uniq, read: [], written: uniq };
  if (cat === "read" || cat === "search") return { all: uniq, read: uniq, written: [] };
  return { all: uniq, read: [], written: [] };
}

function toSafeCount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function normalizeUsageAnthropic(raw: Record<string, unknown>): RunTokenUsage {
  const uncached = toSafeCount(raw.input_tokens ?? raw.inputTokens);
  const cacheRead = toSafeCount(raw.cache_read_input_tokens ?? raw.cacheReadInputTokens ?? raw.cacheRead);
  const cacheWrite = toSafeCount(raw.cache_creation_input_tokens ?? raw.cacheCreationInputTokens ?? raw.cacheWrite);
  const output = toSafeCount(raw.output_tokens ?? raw.outputTokens);
  const reasoning = toSafeCount(raw.reasoning_tokens ?? raw.reasoningTokens);
  const inputTokens = uncached + cacheRead + cacheWrite;
  return {
    inputTokens,
    uncachedInputTokens: uncached,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
    reasoningTokens: reasoning,
    totalTokens: inputTokens + output + reasoning,
  };
}

function normalizeUsageOpenAi(raw: Record<string, unknown>): RunTokenUsage {
  const rawInput = toSafeCount(raw.input_tokens ?? raw.inputTokens);
  const cacheRead = toSafeCount(raw.cached_input_tokens ?? raw.cachedInputTokens ?? raw.cache_read_tokens);
  const uncached = Math.max(0, rawInput - cacheRead);
  const inputTokens = Math.max(rawInput, uncached + cacheRead);
  const output = toSafeCount(raw.output_tokens ?? raw.outputTokens);
  const reasoning = toSafeCount(raw.reasoning_output_tokens ?? raw.reasoningOutputTokens ?? raw.reasoning_tokens);
  return {
    inputTokens,
    uncachedInputTokens: uncached,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
    outputTokens: output,
    reasoningTokens: reasoning,
    totalTokens: inputTokens + output + reasoning,
  };
}

class QoderStreamAdapter implements HarnessStreamAdapter {
  private turnIndex = 0;
  private hasPriorReply = false;
  private pendingTools = new Map<string, { name: string; category: RunToolCategory; summary: string; startedAt: number; files: string[]; wbCommand?: string }>();

  constructor(private readonly requestedModel: string) {}

  feedLine(rawLine: string): AdapterLineResult {
    const trimmed = rawLine.trim();
    if (!trimmed || CLI_NOISE_RE.test(trimmed)) {
      return { events: [], displayText: "", replyText: null };
    }
    if (!trimmed.startsWith("{")) {
      return {
        events: [{ type: "raw.line", stream: "stdout", text: sanitizeOutput(trimmed, 8192).text }],
        displayText: `${trimmed}\n`,
        replyText: null,
      };
    }

    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return {
        events: [{ type: "raw.line", stream: "stdout", text: sanitizeOutput(trimmed, 8192).text }],
        displayText: `${trimmed}\n`,
        replyText: null,
      };
    }

    const type = evt.type;
    if (
      typeof evt.session_id !== "string" &&
      type !== "system" &&
      type !== "assistant" &&
      type !== "user" &&
      type !== "result"
    ) {
      return {
        events: [{ type: "raw.line", stream: "stdout", text: sanitizeOutput(trimmed, 8192).text }],
        displayText: `${trimmed}\n`,
        replyText: null,
      };
    }

    const sessionId = typeof evt.session_id === "string" ? evt.session_id : undefined;

    if (type === "system") {
      if (evt.subtype === "init") {
        const requested = this.requestedModel && this.requestedModel !== "default" ? this.requestedModel : "";
        const reported = typeof evt.model === "string" ? evt.model.trim() : "";
        const actual = reported || this.requestedModel;
        const modelFallback = Boolean(
          requested && requested.toLowerCase() !== "auto" && actual.toLowerCase() === "auto",
        );
        const fallbackNote = modelFallback
          ? ` ⚠️ 请求模型 ${requested} 不可用，已自动回退为 auto`
          : "";
        return {
          events: [],
          displayText: `⚡ Qoder 引擎已就绪 (model: ${actual}${fallbackNote})\n`,
          replyText: null,
          sessionId,
          ...(reported ? { effectiveModel: actual } : {}),
          ...(modelFallback ? { modelFallback: true } : {}),
        };
      }
      if (evt.subtype === "compact_boundary" || evt.subtype === "compaction") {
        const meta = (evt.compact_metadata ?? evt) as Record<string, unknown>;
        const beforeTokens = toSafeCount(meta.pre_tokens ?? meta.beforeTokens) || undefined;
        const afterTokens = toSafeCount(meta.post_tokens ?? meta.afterTokens) || undefined;
        const reclaimedTokens =
          beforeTokens !== undefined && afterTokens !== undefined
            ? Math.max(0, beforeTokens - afterTokens)
            : undefined;
        return {
          events: [
            {
              type: "context.compaction",
              turnIndex: Math.max(1, this.turnIndex),
              mode: "explicit",
              beforeTokens,
              afterTokens,
              reclaimedTokens,
              summary: typeof evt.summary === "string" ? evt.summary : undefined,
            },
          ],
          displayText: "",
          replyText: null,
          sessionId,
        };
      }
      return { events: [], displayText: "", replyText: null, sessionId };
    }

    if (type === "assistant" && evt.message && typeof evt.message === "object") {
      const msg = evt.message as Record<string, unknown>;
      const content = Array.isArray(msg.content) ? msg.content : [];
      const events: PartialTraceEvent[] = [];
      const displayParts: string[] = [];
      const replyParts: string[] = [];

      this.turnIndex++;
      events.push({ type: "turn.start", turnIndex: this.turnIndex });

      for (const rawBlock of content) {
        if (!rawBlock || typeof rawBlock !== "object") continue;
        const block = rawBlock as Record<string, unknown>;
        if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
          const clean = block.thinking.trim();
          const bounded = formatTraceTextBounded(clean);
          events.push({
            type: "thinking",
            turnIndex: this.turnIndex,
            text: bounded.text,
            ...(bounded.truncated ? { truncated: true } : {}),
          });
          displayParts.push(`💭 ${clean}`);
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          const toolName = block.name;
          const callId = typeof block.id === "string" ? block.id : `call-${this.turnIndex}-${events.length}`;
          const summary = summarizeToolInput(block.input);
          const category = classifyToolName(toolName, block.input);
          const files = extractTouchedFiles(toolName, block.input).all;
          const wbCommand = extractWbCommand(toolName, block.input);
          const inpBounded = formatToolInputBounded(block.input);
          this.pendingTools.set(callId, {
            name: toolName,
            category,
            summary,
            startedAt: Date.now(),
            files,
            wbCommand,
          });
          events.push({
            type: "tool.start",
            turnIndex: this.turnIndex,
            callId,
            toolName,
            category,
            summary,
            ...(inpBounded.text !== undefined ? { inputText: inpBounded.text } : {}),
            ...(inpBounded.truncated ? { inputTruncated: true } : {}),
            ...(files.length > 0 ? { filesTouched: files } : {}),
            ...(wbCommand ? { wbCommand } : {}),
          });
          displayParts.push(`🔧 调用工具: ${toolName}${summary ? ` (${summary})` : ""}`);
        } else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          const text = block.text.trim();
          const bounded = formatTraceTextBounded(text);
          events.push({
            type: "assistant.message",
            turnIndex: this.turnIndex,
            text: bounded.text,
            ...(bounded.truncated ? { truncated: true } : {}),
          });
          displayParts.push(text);
          replyParts.push(text);
          this.hasPriorReply = true;
        }
      }

      if (msg.usage && typeof msg.usage === "object") {
        const usage = normalizeUsageAnthropic(msg.usage as Record<string, unknown>);
        events.push({
          type: "turn.end",
          turnIndex: this.turnIndex,
          contextTokens: usage.inputTokens > 0 ? usage.inputTokens : undefined,
          usage,
        });
      }

      return {
        events,
        displayText: displayParts.length > 0 ? `${displayParts.join("\n")}\n` : "",
        replyText: replyParts.length > 0 ? replyParts.join("\n\n") : null,
        sessionId,
      };
    }

    if (type === "user" && evt.message && typeof evt.message === "object") {
      const msg = evt.message as Record<string, unknown>;
      const content = Array.isArray(msg.content) ? msg.content : [];
      const events: PartialTraceEvent[] = [];
      for (const rawBlock of content) {
        if (!rawBlock || typeof rawBlock !== "object") continue;
        const block = rawBlock as Record<string, unknown>;
        if (block.type !== "tool_result") continue;
        const callId = typeof block.tool_use_id === "string" ? block.tool_use_id : `call-${this.turnIndex}`;
        const pending = this.pendingTools.get(callId);
        if (pending) this.pendingTools.delete(callId);
        const durationMs = pending ? Math.max(0, Date.now() - pending.startedAt) : undefined;
        const boundedOut = formatToolOutputBounded(block.content);
        const isError = block.is_error === true;
        events.push({
          type: "tool.end",
          turnIndex: Math.max(1, this.turnIndex),
          callId,
          toolName: pending?.name ?? "tool",
          category: pending?.category ?? "other",
          summary: pending?.summary ?? "",
          ...(boundedOut.output !== undefined ? { output: boundedOut.output } : {}),
          ...(boundedOut.outputBytes !== undefined ? { outputBytes: boundedOut.outputBytes } : {}),
          ...(boundedOut.outputTruncated ? { outputTruncated: true } : {}),
          ...(isError ? { isError: true } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(pending?.files && pending.files.length > 0 ? { filesTouched: pending.files } : {}),
          ...(pending?.wbCommand ? { wbCommand: pending.wbCommand } : {}),
        });
      }
      return { events, displayText: "", replyText: null, sessionId };
    }

    if (type === "result") {
      const resultText = typeof evt.result === "string" && evt.result.trim() ? evt.result.trim() : null;
      const sec = ((Number(evt.duration_ms) || 0) / 1000).toFixed(1);
      const authUsage =
        evt.usage && typeof evt.usage === "object"
          ? normalizeUsageAnthropic(evt.usage as Record<string, unknown>)
          : undefined;
      const authCost =
        typeof evt.total_cost_usd === "number" && Number.isFinite(evt.total_cost_usd) && evt.total_cost_usd >= 0
          ? evt.total_cost_usd
          : undefined;
      const authTurns =
        typeof evt.num_turns === "number" && Number.isFinite(evt.num_turns) && evt.num_turns > 0
          ? Math.floor(evt.num_turns)
          : undefined;

      const events: PartialTraceEvent[] = [];
      if (evt.is_error) {
        events.push({
          type: "run.error",
          message: resultText ? sanitizeOutput(resultText, 2000).text : `执行异常结束 (${sec}s)`,
        });
        return {
          events,
          displayText: resultText ? `❌ ${resultText}\n` : `❌ 执行异常结束 (${sec}s)\n`,
          replyText: null,
          sessionId,
          ...(authUsage ? { authoritativeUsage: authUsage } : {}),
          ...(authCost !== undefined ? { authoritativeCostUsd: authCost } : {}),
          ...(authTurns !== undefined ? { authoritativeTurnsCount: authTurns } : {}),
        };
      }
      const reply = !this.hasPriorReply ? resultText : null;
      if (reply) {
        const bounded = formatTraceTextBounded(reply);
        events.push({
          type: "assistant.message",
          turnIndex: Math.max(1, this.turnIndex),
          text: bounded.text,
          ...(bounded.truncated ? { truncated: true } : {}),
        });
      }
      return {
        events,
        displayText: `\n✓ 执行完成 (耗时 ${sec}s)\n`,
        replyText: reply,
        sessionId,
        ...(authUsage ? { authoritativeUsage: authUsage } : {}),
        ...(authCost !== undefined ? { authoritativeCostUsd: authCost } : {}),
        ...(authTurns !== undefined ? { authoritativeTurnsCount: authTurns } : {}),
      };
    }

    return { events: [], displayText: "", replyText: null, sessionId };
  }

  flush(): AdapterLineResult | null {
    return null;
  }
}

class CodexStreamAdapter implements HarnessStreamAdapter {
  private turnIndex = 0;
  private itemStarts = new Map<string, number>();

  feedLine(rawLine: string): AdapterLineResult {
    const trimmed = rawLine.trim();
    if (!trimmed || CLI_NOISE_RE.test(trimmed)) {
      return { events: [], displayText: "", replyText: null };
    }
    if (!trimmed.startsWith("{")) {
      return {
        events: [{ type: "raw.line", stream: "stdout", text: sanitizeOutput(trimmed, 8192).text }],
        displayText: `${trimmed}\n`,
        replyText: null,
      };
    }

    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return {
        events: [{ type: "raw.line", stream: "stdout", text: sanitizeOutput(trimmed, 8192).text }],
        displayText: `${trimmed}\n`,
        replyText: null,
      };
    }

    if (typeof evt.type !== "string") {
      return {
        events: [{ type: "raw.line", stream: "stdout", text: sanitizeOutput(trimmed, 8192).text }],
        displayText: `${trimmed}\n`,
        replyText: null,
      };
    }

    const type = evt.type;
    if (type === "thread.started") {
      const sessionId = typeof evt.thread_id === "string" ? evt.thread_id : undefined;
      return {
        events: [],
        displayText: sessionId ? `session id: ${sessionId}\n` : "",
        replyText: null,
        sessionId,
      };
    }

    if (type === "turn.started") {
      this.turnIndex++;
      return {
        events: [{ type: "turn.start", turnIndex: this.turnIndex }],
        displayText: "",
        replyText: null,
      };
    }

    if (type === "item.started" && evt.item && typeof evt.item === "object") {
      const item = evt.item as Record<string, unknown>;
      const callId = typeof item.id === "string" ? item.id : `item-${this.turnIndex}-${Date.now()}`;
      this.itemStarts.set(callId, Date.now());
      const itemType = String(item.type ?? "");
      if (itemType === "command_execution") {
        const command = typeof item.command === "string" ? item.command : "";
        const wbCommand = extractWbCommand("bash", { command });
        const cat = wbCommand ? "wb_cli" : "bash";
        const inp = formatToolInputBounded({ command });
        return {
          events: [
            {
              type: "tool.start",
              turnIndex: Math.max(1, this.turnIndex),
              callId,
              toolName: "exec",
              category: cat,
              summary: command.replace(/\s+/g, " ").trim().slice(0, 90),
              ...(inp.text !== undefined ? { inputText: inp.text } : {}),
              ...(inp.truncated ? { inputTruncated: true } : {}),
              ...(wbCommand ? { wbCommand } : {}),
            },
          ],
          displayText: "",
          replyText: null,
        };
      }
      if (itemType === "mcp_tool_call") {
        const toolName = typeof item.tool === "string" ? item.tool : typeof item.name === "string" ? item.name : "mcp_tool";
        const inp = formatToolInputBounded(item.arguments ?? item.input);
        const wbCommand = extractWbCommand(toolName, item.arguments ?? item.input);
        const files = extractTouchedFiles(toolName, item.arguments ?? item.input).all;
        return {
          events: [
            {
              type: "tool.start",
              turnIndex: Math.max(1, this.turnIndex),
              callId,
              toolName,
              category: wbCommand ? "wb_cli" : "mcp",
              summary: summarizeToolInput(item.arguments ?? item.input),
              ...(inp.text !== undefined ? { inputText: inp.text } : {}),
              ...(inp.truncated ? { inputTruncated: true } : {}),
              ...(files.length > 0 ? { filesTouched: files } : {}),
              ...(wbCommand ? { wbCommand } : {}),
            },
          ],
          displayText: "",
          replyText: null,
        };
      }
      return { events: [], displayText: "", replyText: null };
    }

    if (type === "item.completed" && evt.item && typeof evt.item === "object") {
      const item = evt.item as Record<string, unknown>;
      const callId = typeof item.id === "string" ? item.id : `item-${this.turnIndex}`;
      const startedAt = this.itemStarts.get(callId);
      if (startedAt !== undefined) this.itemStarts.delete(callId);
      const durationMs = startedAt !== undefined ? Math.max(0, Date.now() - startedAt) : undefined;
      const itemType = String(item.type ?? "");
      const turn = Math.max(1, this.turnIndex);

      if (itemType === "reasoning" && typeof item.text === "string" && item.text.trim()) {
        const clean = item.text.trim();
        const bounded = formatTraceTextBounded(clean);
        return {
          events: [
            {
              type: "thinking",
              turnIndex: turn,
              text: bounded.text,
              ...(bounded.truncated ? { truncated: true } : {}),
            },
          ],
          displayText: `thinking\n${clean}\n`,
          replyText: null,
        };
      }

      if (itemType === "command_execution") {
        const command = typeof item.command === "string" ? item.command : "";
        const rawOut = typeof item.aggregated_output === "string" ? item.aggregated_output : typeof item.output === "string" ? item.output : "";
        const exitCode = typeof item.exit_code === "number" ? item.exit_code : null;
        const wbCommand = extractWbCommand("bash", { command });
        const cat = wbCommand ? "wb_cli" : "bash";
        const boundedOut = formatToolOutputBounded(rawOut);
        const events: PartialTraceEvent[] = [];
        if (startedAt === undefined) {
          const inp = formatToolInputBounded({ command });
          events.push({
            type: "tool.start",
            turnIndex: turn,
            callId,
            toolName: "exec",
            category: cat,
            summary: command.replace(/\s+/g, " ").trim().slice(0, 90),
            ...(inp.text !== undefined ? { inputText: inp.text } : {}),
            ...(inp.truncated ? { inputTruncated: true } : {}),
            ...(wbCommand ? { wbCommand } : {}),
          });
        }
        events.push({
          type: "tool.end",
          turnIndex: turn,
          callId,
          toolName: "exec",
          category: cat,
          summary: command.replace(/\s+/g, " ").trim().slice(0, 90),
          ...(boundedOut.output !== undefined ? { output: boundedOut.output } : {}),
          ...(boundedOut.outputBytes !== undefined ? { outputBytes: boundedOut.outputBytes } : {}),
          ...(boundedOut.outputTruncated ? { outputTruncated: true } : {}),
          ...(exitCode !== null && exitCode !== 0 ? { isError: true } : {}),
          exitCode,
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(wbCommand ? { wbCommand } : {}),
        });
        const statusTxt = exitCode === 0 || exitCode === null ? "succeeded" : `exited ${exitCode}`;
        const durTxt = durationMs !== undefined ? ` in ${durationMs}ms` : "";
        return {
          events,
          displayText: `exec\n${command} ${statusTxt}${durTxt}:\n${rawOut ? `${rawOut.slice(0, 2000)}\n` : ""}`,
          replyText: null,
        };
      }

      if (itemType === "file_change") {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const files = changes
          .map((c) => (c && typeof c === "object" ? String((c as Record<string, unknown>).path ?? "") : ""))
          .filter(Boolean);
        const summary = files.slice(0, 3).join(", ") + (files.length > 3 ? ` (+${files.length - 3})` : "");
        const inp = formatToolInputBounded({ changes });
        return {
          events: [
            {
              type: "tool.start",
              turnIndex: turn,
              callId,
              toolName: "file_change",
              category: "write",
              summary,
              ...(inp.text !== undefined ? { inputText: inp.text } : {}),
              ...(files.length > 0 ? { filesTouched: files } : {}),
            },
            {
              type: "tool.end",
              turnIndex: turn,
              callId,
              toolName: "file_change",
              category: "write",
              summary,
              output: summary,
              ...(files.length > 0 ? { filesTouched: files } : {}),
            },
          ],
          displayText: summary ? `🔧 file_change (${summary})\n` : "",
          replyText: null,
        };
      }

      if (itemType === "mcp_tool_call") {
        const toolName = typeof item.tool === "string" ? item.tool : typeof item.name === "string" ? item.name : "mcp_tool";
        const wbCommand = extractWbCommand(toolName, item.arguments ?? item.input);
        const files = extractTouchedFiles(toolName, item.arguments ?? item.input).all;
        const boundedOut = formatToolOutputBounded(item.result ?? item.output ?? item.error);
        const isError = Boolean(item.error) || item.status === "failed";
        return {
          events: [
            {
              type: "tool.end",
              turnIndex: turn,
              callId,
              toolName,
              category: wbCommand ? "wb_cli" : "mcp",
              summary: summarizeToolInput(item.arguments ?? item.input),
              ...(boundedOut.output !== undefined ? { output: boundedOut.output } : {}),
              ...(boundedOut.outputBytes !== undefined ? { outputBytes: boundedOut.outputBytes } : {}),
              ...(boundedOut.outputTruncated ? { outputTruncated: true } : {}),
              ...(isError ? { isError: true } : {}),
              ...(durationMs !== undefined ? { durationMs } : {}),
              ...(files.length > 0 ? { filesTouched: files } : {}),
              ...(wbCommand ? { wbCommand } : {}),
            },
          ],
          displayText: `🔧 调用工具: ${toolName}\n`,
          replyText: null,
        };
      }

      if (itemType === "web_search") {
        const query = typeof item.query === "string" ? item.query : "";
        return {
          events: [
            {
              type: "tool.start",
              turnIndex: turn,
              callId,
              toolName: "web_search",
              category: "web",
              summary: query.slice(0, 90),
            },
            {
              type: "tool.end",
              turnIndex: turn,
              callId,
              toolName: "web_search",
              category: "web",
              summary: query.slice(0, 90),
            },
          ],
          displayText: `🔧 web_search (${query.slice(0, 90)})\n`,
          replyText: null,
        };
      }

      if (itemType === "agent_message" && typeof item.text === "string" && item.text.trim()) {
        const clean = item.text.trim();
        const bounded = formatTraceTextBounded(clean);
        return {
          events: [
            {
              type: "assistant.message",
              turnIndex: turn,
              text: bounded.text,
              ...(bounded.truncated ? { truncated: true } : {}),
            },
          ],
          displayText: `codex\n${clean}\n`,
          replyText: clean,
        };
      }
    }

    if (type === "turn.completed") {
      const turn = Math.max(1, this.turnIndex);
      const usage =
        evt.usage && typeof evt.usage === "object"
          ? normalizeUsageOpenAi(evt.usage as Record<string, unknown>)
          : undefined;
      return {
        events: [
          {
            type: "turn.end",
            turnIndex: turn,
            contextTokens: usage?.inputTokens,
            usage,
          },
        ],
        displayText: usage ? `tokens used\n${usage.totalTokens}\n` : "",
        replyText: null,
      };
    }

    if (type === "turn.failed" || type === "error") {
      const errMsg =
        typeof evt.message === "string"
          ? evt.message
          : evt.error && typeof evt.error === "object" && typeof (evt.error as { message?: unknown }).message === "string"
            ? (evt.error as { message: string }).message
            : trimmed;
      return {
        events: [{ type: "run.error", message: sanitizeOutput(errMsg, 2000).text }],
        displayText: `❌ ${errMsg}\n`,
        replyText: null,
      };
    }

    return {
      events: [{ type: "raw.line", stream: "stdout", text: sanitizeOutput(trimmed, 4096).text }],
      displayText: "",
      replyText: null,
    };
  }

  flush(): AdapterLineResult | null {
    return null;
  }
}

class OpencodeStreamAdapter implements HarnessStreamAdapter {
  private turnIndex = 0;

  feedLine(rawLine: string): AdapterLineResult {
    const trimmed = rawLine.trim();
    if (!trimmed || CLI_NOISE_RE.test(trimmed)) {
      return { events: [], displayText: "", replyText: null };
    }
    if (!trimmed.startsWith("{")) {
      return {
        events: [{ type: "raw.line", stream: "stdout", text: sanitizeOutput(trimmed, 8192).text }],
        displayText: `${trimmed}\n`,
        replyText: null,
      };
    }

    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return {
        events: [{ type: "raw.line", stream: "stdout", text: sanitizeOutput(trimmed, 8192).text }],
        displayText: `${trimmed}\n`,
        replyText: null,
      };
    }

    if (typeof evt.type !== "string") {
      return {
        events: [{ type: "raw.line", stream: "stdout", text: sanitizeOutput(trimmed, 8192).text }],
        displayText: `${trimmed}\n`,
        replyText: null,
      };
    }

    const sessionId =
      typeof evt.sessionID === "string"
        ? evt.sessionID
        : typeof evt.sessionId === "string"
          ? evt.sessionId
          : undefined;
    const type = String(evt.type ?? "");
    const part = (evt.part && typeof evt.part === "object" ? evt.part : evt) as Record<string, unknown>;

    if (type === "step_start") {
      this.turnIndex++;
      return {
        events: [{ type: "turn.start", turnIndex: this.turnIndex }],
        displayText: "",
        replyText: null,
        sessionId,
      };
    }

    if (type === "reasoning") {
      const text = typeof part.text === "string" ? part.text.trim() : "";
      if (!text) return { events: [], displayText: "", replyText: null, sessionId };
      const bounded = formatTraceTextBounded(text);
      return {
        events: [
          {
            type: "thinking",
            turnIndex: Math.max(1, this.turnIndex),
            text: bounded.text,
            ...(bounded.truncated ? { truncated: true } : {}),
          },
        ],
        displayText: `💭 ${text}\n`,
        replyText: null,
        sessionId,
      };
    }

    if (type === "tool_use") {
      const turn = Math.max(1, this.turnIndex);
      const toolName = typeof part.tool === "string" ? part.tool : typeof part.name === "string" ? part.name : "tool";
      const callId = typeof part.callID === "string" ? part.callID : typeof part.id === "string" ? part.id : `oc-${turn}-${Date.now()}`;
      const state = (part.state && typeof part.state === "object" ? part.state : {}) as Record<string, unknown>;
      const inputObj = state.input ?? part.input;
      const summary = summarizeToolInput(inputObj);
      const category = classifyToolName(toolName, inputObj);
      const files = extractTouchedFiles(toolName, inputObj).all;
      const wbCommand = extractWbCommand(toolName, inputObj);
      const inp = formatToolInputBounded(inputObj);
      const boundedOut = formatToolOutputBounded(state.error ?? state.output);
      const time = (state.time && typeof state.time === "object" ? state.time : null) as { start?: number; end?: number } | null;
      const durationMs =
        time && typeof time.start === "number" && typeof time.end === "number" && time.end >= time.start
          ? Math.round(time.end - time.start)
          : undefined;
      const isError = state.status === "error" || Boolean(state.error);

      return {
        events: [
          {
            type: "tool.start",
            turnIndex: turn,
            callId,
            toolName,
            category,
            summary,
            ...(inp.text !== undefined ? { inputText: inp.text } : {}),
            ...(inp.truncated ? { inputTruncated: true } : {}),
            ...(files.length > 0 ? { filesTouched: files } : {}),
            ...(wbCommand ? { wbCommand } : {}),
          },
          {
            type: "tool.end",
            turnIndex: turn,
            callId,
            toolName,
            category,
            summary,
            ...(boundedOut.output !== undefined ? { output: boundedOut.output } : {}),
            ...(boundedOut.outputBytes !== undefined ? { outputBytes: boundedOut.outputBytes } : {}),
            ...(boundedOut.outputTruncated ? { outputTruncated: true } : {}),
            ...(isError ? { isError: true } : {}),
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...(files.length > 0 ? { filesTouched: files } : {}),
            ...(wbCommand ? { wbCommand } : {}),
          },
        ],
        displayText: `🔧 调用工具: ${toolName}${summary ? ` (${summary})` : ""}\n`,
        replyText: null,
        sessionId,
      };
    }

    if (type === "text") {
      const text = typeof part.text === "string" ? part.text.trim() : "";
      if (!text) return { events: [], displayText: "", replyText: null, sessionId };
      const bounded = formatTraceTextBounded(text);
      return {
        events: [
          {
            type: "assistant.message",
            turnIndex: Math.max(1, this.turnIndex),
            text: bounded.text,
            ...(bounded.truncated ? { truncated: true } : {}),
          },
        ],
        displayText: `${text}\n`,
        replyText: text,
        sessionId,
      };
    }

    if (type === "step_finish") {
      const turn = Math.max(1, this.turnIndex);
      const tok = (part.tokens && typeof part.tokens === "object" ? part.tokens : null) as Record<string, unknown> | null;
      let usage: RunTokenUsage | undefined;
      if (tok) {
        const uncached = toSafeCount(tok.input);
        const output = toSafeCount(tok.output);
        const reasoning = toSafeCount(tok.reasoning);
        const cacheObj = (tok.cache && typeof tok.cache === "object" ? tok.cache : {}) as Record<string, unknown>;
        const cacheRead = toSafeCount(cacheObj.read);
        const cacheWrite = toSafeCount(cacheObj.write);
        const inputTokens = uncached + cacheRead + cacheWrite;
        usage = {
          inputTokens,
          uncachedInputTokens: uncached,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          outputTokens: output,
          reasoningTokens: reasoning,
          totalTokens: inputTokens + output + reasoning,
        };
      }
      const costUsd =
        typeof part.cost === "number" && Number.isFinite(part.cost) && part.cost >= 0 ? part.cost : undefined;
      return {
        events: [
          {
            type: "turn.end",
            turnIndex: turn,
            contextTokens: usage?.inputTokens,
            usage,
            ...(costUsd !== undefined ? { costUsd } : {}),
          },
        ],
        displayText: "",
        replyText: null,
        sessionId,
      };
    }

    if (type === "error") {
      const msg = typeof evt.message === "string" ? evt.message : typeof part.message === "string" ? part.message : trimmed;
      return {
        events: [{ type: "run.error", message: sanitizeOutput(msg, 2000).text }],
        displayText: `❌ ${msg}\n`,
        replyText: null,
        sessionId,
      };
    }

    return { events: [], displayText: "", replyText: null, sessionId };
  }

  flush(): AdapterLineResult | null {
    return null;
  }
}

class AgyStreamAdapter implements HarnessStreamAdapter {
  private turnIndex = 0;
  private hasReply = false;
  private pendingTools = new Map<string, { name: string; category: RunToolCategory; summary: string; startedAt: number; files: string[]; wbCommand?: string }>();

  constructor(private readonly requestedModel: string) {}

  feedLine(rawLine: string): AdapterLineResult {
    const trimmed = rawLine.trim();
    if (!trimmed || CLI_NOISE_RE.test(trimmed)) {
      return { events: [], displayText: "", replyText: null };
    }
    if (!trimmed.startsWith("{")) {
      return {
        events: [{ type: "raw.line", stream: "stdout", text: sanitizeOutput(trimmed, 8192).text }],
        displayText: `${trimmed}\n`,
        replyText: trimmed,
      };
    }

    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return {
        events: [{ type: "raw.line", stream: "stdout", text: sanitizeOutput(trimmed, 8192).text }],
        displayText: `${trimmed}\n`,
        replyText: trimmed,
      };
    }

    if (typeof evt.type !== "string") {
      return {
        events: [{ type: "raw.line", stream: "stdout", text: sanitizeOutput(trimmed, 8192).text }],
        displayText: `${trimmed}\n`,
        replyText: null,
      };
    }

    const sessionId =
      typeof evt.conversation_id === "string"
        ? evt.conversation_id
        : typeof evt.session_id === "string"
          ? evt.session_id
          : typeof evt.sessionId === "string"
            ? evt.sessionId
            : undefined;
    const type = String(evt.type ?? "");
    const events: PartialTraceEvent[] = [];
    const displayParts: string[] = [];
    const replyParts: string[] = [];

    if (type === "system" && evt.subtype === "init") {
      const actual = typeof evt.model === "string" && evt.model.trim() ? evt.model.trim() : this.requestedModel;
      return {
        events: [],
        displayText: `⚡ AGY 引擎已就绪 (model: ${actual})\n`,
        replyText: null,
        sessionId,
        ...(typeof evt.model === "string" && evt.model.trim() ? { effectiveModel: evt.model.trim() } : {}),
      };
    }

    if (type === "assistant" || type === "message") {
      const msg = (evt.message && typeof evt.message === "object" ? evt.message : evt) as Record<string, unknown>;
      const content = Array.isArray(msg.content) ? msg.content : null;
      this.turnIndex++;
      events.push({ type: "turn.start", turnIndex: this.turnIndex });
      if (content) {
        for (const rawBlock of content) {
          if (!rawBlock || typeof rawBlock !== "object") continue;
          const b = rawBlock as Record<string, unknown>;
          if ((b.type === "thinking" || b.type === "thought") && typeof (b.thinking ?? b.text) === "string") {
            const txt = String(b.thinking ?? b.text).trim();
            if (txt) {
              const bounded = formatTraceTextBounded(txt);
              events.push({ type: "thinking", turnIndex: this.turnIndex, text: bounded.text, ...(bounded.truncated ? { truncated: true } : {}) });
              displayParts.push(`💭 ${txt}`);
            }
          } else if ((b.type === "tool_use" || b.type === "tool_call" || b.type === "function_call") && typeof (b.name ?? b.tool) === "string") {
            const toolName = String(b.name ?? b.tool);
            const callId = typeof b.id === "string" ? b.id : `agy-${this.turnIndex}-${events.length}`;
            const rawIn = b.input ?? b.arguments ?? b.args;
            const summary = summarizeToolInput(rawIn);
            const category = classifyToolName(toolName, rawIn);
            const files = extractTouchedFiles(toolName, rawIn).all;
            const wbCommand = extractWbCommand(toolName, rawIn);
            const inp = formatToolInputBounded(rawIn);
            this.pendingTools.set(callId, { name: toolName, category, summary, startedAt: Date.now(), files, wbCommand });
            events.push({
              type: "tool.start",
              turnIndex: this.turnIndex,
              callId,
              toolName,
              category,
              summary,
              ...(inp.text !== undefined ? { inputText: inp.text } : {}),
              ...(inp.truncated ? { inputTruncated: true } : {}),
              ...(files.length > 0 ? { filesTouched: files } : {}),
              ...(wbCommand ? { wbCommand } : {}),
            });
            displayParts.push(`🔧 调用工具: ${toolName}${summary ? ` (${summary})` : ""}`);
          } else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
            const txt = b.text.trim();
            const bounded = formatTraceTextBounded(txt);
            events.push({ type: "assistant.message", turnIndex: this.turnIndex, text: bounded.text, ...(bounded.truncated ? { truncated: true } : {}) });
            displayParts.push(txt);
            replyParts.push(txt);
            this.hasReply = true;
          }
        }
      } else if (typeof msg.text === "string" && msg.text.trim()) {
        const txt = msg.text.trim();
        const bounded = formatTraceTextBounded(txt);
        events.push({ type: "assistant.message", turnIndex: this.turnIndex, text: bounded.text, ...(bounded.truncated ? { truncated: true } : {}) });
        displayParts.push(txt);
        replyParts.push(txt);
        this.hasReply = true;
      }
      if (msg.usage && typeof msg.usage === "object") {
        const u = normalizeUsageAnthropic(msg.usage as Record<string, unknown>);
        events.push({ type: "turn.end", turnIndex: this.turnIndex, contextTokens: u.inputTokens || undefined, usage: u });
      }
      return {
        events,
        displayText: displayParts.length > 0 ? `${displayParts.join("\n")}\n` : "",
        replyText: replyParts.length > 0 ? replyParts.join("\n\n") : null,
        sessionId,
      };
    }

    if (type === "user" && evt.message && typeof evt.message === "object") {
      const content = Array.isArray((evt.message as { content?: unknown }).content)
        ? ((evt.message as { content: unknown[] }).content)
        : [];
      for (const rawBlock of content) {
        if (!rawBlock || typeof rawBlock !== "object") continue;
        const b = rawBlock as Record<string, unknown>;
        if (b.type !== "tool_result" && b.type !== "function_response") continue;
        const callId = typeof b.tool_use_id === "string" ? b.tool_use_id : `agy-${this.turnIndex}`;
        const pending = this.pendingTools.get(callId);
        if (pending) this.pendingTools.delete(callId);
        const boundedOut = formatToolOutputBounded(b.content ?? b.response ?? b.output);
        events.push({
          type: "tool.end",
          turnIndex: Math.max(1, this.turnIndex),
          callId,
          toolName: pending?.name ?? "tool",
          category: pending?.category ?? "other",
          summary: pending?.summary ?? "",
          ...(boundedOut.output !== undefined ? { output: boundedOut.output } : {}),
          ...(boundedOut.outputBytes !== undefined ? { outputBytes: boundedOut.outputBytes } : {}),
          ...(boundedOut.outputTruncated ? { outputTruncated: true } : {}),
          ...(b.is_error === true ? { isError: true } : {}),
          ...(pending ? { durationMs: Math.max(0, Date.now() - pending.startedAt) } : {}),
          ...(pending?.files && pending.files.length > 0 ? { filesTouched: pending.files } : {}),
          ...(pending?.wbCommand ? { wbCommand: pending.wbCommand } : {}),
        });
      }
      return { events, displayText: "", replyText: null, sessionId };
    }

    if (type === "thinking" || type === "thought") {
      const txt = typeof (evt.text ?? evt.thinking) === "string" ? String(evt.text ?? evt.thinking).trim() : "";
      if (!txt) return { events: [], displayText: "", replyText: null, sessionId };
      const bounded = formatTraceTextBounded(txt);
      return {
        events: [{ type: "thinking", turnIndex: Math.max(1, this.turnIndex), text: bounded.text, ...(bounded.truncated ? { truncated: true } : {}) }],
        displayText: `💭 ${txt}\n`,
        replyText: null,
        sessionId,
      };
    }

    if (type === "tool_use" || type === "tool_call") {
      const turn = Math.max(1, this.turnIndex || 1);
      const toolName = String(evt.name ?? evt.tool ?? "tool");
      const callId = typeof evt.id === "string" ? evt.id : `agy-${turn}-${Date.now()}`;
      const rawIn = evt.input ?? evt.arguments;
      const summary = summarizeToolInput(rawIn);
      const category = classifyToolName(toolName, rawIn);
      const files = extractTouchedFiles(toolName, rawIn).all;
      const wbCommand = extractWbCommand(toolName, rawIn);
      const inp = formatToolInputBounded(rawIn);
      this.pendingTools.set(callId, { name: toolName, category, summary, startedAt: Date.now(), files, wbCommand });
      return {
        events: [
          {
            type: "tool.start",
            turnIndex: turn,
            callId,
            toolName,
            category,
            summary,
            ...(inp.text !== undefined ? { inputText: inp.text } : {}),
            ...(inp.truncated ? { inputTruncated: true } : {}),
            ...(files.length > 0 ? { filesTouched: files } : {}),
            ...(wbCommand ? { wbCommand } : {}),
          },
        ],
        displayText: `🔧 调用工具: ${toolName}${summary ? ` (${summary})` : ""}\n`,
        replyText: null,
        sessionId,
      };
    }

    if (type === "tool_result") {
      const turn = Math.max(1, this.turnIndex || 1);
      const callId = typeof (evt.tool_use_id ?? evt.callId ?? evt.id) === "string" ? String(evt.tool_use_id ?? evt.callId ?? evt.id) : `agy-${turn}`;
      const pending = this.pendingTools.get(callId);
      if (pending) this.pendingTools.delete(callId);
      const boundedOut = formatToolOutputBounded(evt.output ?? evt.content ?? evt.result);
      return {
        events: [
          {
            type: "tool.end",
            turnIndex: turn,
            callId,
            toolName: pending?.name ?? String(evt.name ?? evt.tool ?? "tool"),
            category: pending?.category ?? "other",
            summary: pending?.summary ?? "",
            ...(boundedOut.output !== undefined ? { output: boundedOut.output } : {}),
            ...(boundedOut.outputBytes !== undefined ? { outputBytes: boundedOut.outputBytes } : {}),
            ...(boundedOut.outputTruncated ? { outputTruncated: true } : {}),
            ...(evt.is_error === true ? { isError: true } : {}),
            ...(pending ? { durationMs: Math.max(0, Date.now() - pending.startedAt) } : {}),
            ...(pending?.files && pending.files.length > 0 ? { filesTouched: pending.files } : {}),
            ...(pending?.wbCommand ? { wbCommand: pending.wbCommand } : {}),
          },
        ],
        displayText: "",
        replyText: null,
        sessionId,
      };
    }

    if (type === "result") {
      const resultText = typeof evt.result === "string" && evt.result.trim() ? evt.result.trim() : null;
      const authUsage = evt.usage && typeof evt.usage === "object" ? normalizeUsageAnthropic(evt.usage as Record<string, unknown>) : undefined;
      const authCost = typeof evt.total_cost_usd === "number" && Number.isFinite(evt.total_cost_usd) ? evt.total_cost_usd : undefined;
      const reply = !this.hasReply ? resultText : null;
      if (reply) {
        const bounded = formatTraceTextBounded(reply);
        events.push({ type: "assistant.message", turnIndex: Math.max(1, this.turnIndex), text: bounded.text, ...(bounded.truncated ? { truncated: true } : {}) });
      }
      if (evt.is_error) {
        events.push({ type: "run.error", message: resultText ? sanitizeOutput(resultText, 2000).text : "AGY 执行失败" });
      }
      return {
        events,
        displayText: evt.is_error ? `❌ ${resultText ?? "执行失败"}\n` : reply ? `${reply}\n` : "",
        replyText: evt.is_error ? null : reply,
        sessionId,
        ...(authUsage ? { authoritativeUsage: authUsage } : {}),
        ...(authCost !== undefined ? { authoritativeCostUsd: authCost } : {}),
      };
    }

    if (type === "error") {
      const msg = typeof evt.message === "string" ? evt.message : trimmed;
      return {
        events: [{ type: "run.error", message: sanitizeOutput(msg, 2000).text }],
        displayText: `❌ ${msg}\n`,
        replyText: null,
        sessionId,
      };
    }

    return {
      events: [{ type: "raw.line", stream: "stdout", text: sanitizeOutput(trimmed, 4096).text }],
      displayText: "",
      replyText: null,
      sessionId,
    };
  }

  flush(): AdapterLineResult | null {
    return null;
  }
}

class OmpStreamAdapter implements HarnessStreamAdapter {
  private turnIndex = 0;
  private pendingTools = new Map<string, { name: string; category: RunToolCategory; summary: string; startedAt: number; files: string[]; wbCommand?: string }>();

  feedLine(rawLine: string): AdapterLineResult {
    const trimmed = rawLine.trim();
    if (!trimmed || CLI_NOISE_RE.test(trimmed)) {
      return { events: [], displayText: "", replyText: null };
    }
    if (!trimmed.startsWith("{")) {
      return {
        events: [{ type: "raw.line", stream: "stdout", text: sanitizeOutput(trimmed, 8192).text }],
        displayText: `${trimmed}\n`,
        replyText: null,
      };
    }

    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return {
        events: [{ type: "raw.line", stream: "stdout", text: sanitizeOutput(trimmed, 8192).text }],
        displayText: `${trimmed}\n`,
        replyText: null,
      };
    }

    if (typeof evt.type !== "string") {
      return {
        events: [{ type: "raw.line", stream: "stdout", text: sanitizeOutput(trimmed, 8192).text }],
        displayText: `${trimmed}\n`,
        replyText: null,
      };
    }

    const type = String(evt.type ?? "");
    const sessionId =
      typeof evt.sessionId === "string"
        ? evt.sessionId
        : type === "session" || type === "session_start"
          ? typeof evt.id === "string"
            ? evt.id
            : undefined
          : undefined;

    if (type === "turn_start") {
      this.turnIndex++;
      return {
        events: [{ type: "turn.start", turnIndex: this.turnIndex }],
        displayText: "",
        replyText: null,
        sessionId,
      };
    }

    if (type === "tool_execution_start" || type === "tool_call") {
      const turn = Math.max(1, this.turnIndex || 1);
      const toolName = String(evt.toolName ?? evt.tool ?? "tool");
      const callId = String(evt.toolCallId ?? evt.callId ?? `omp-${turn}-${Date.now()}`);
      const rawIn = evt.args ?? evt.arguments ?? evt.input;
      const summary = summarizeToolInput(rawIn);
      const category = classifyToolName(toolName, rawIn);
      const files = extractTouchedFiles(toolName, rawIn).all;
      const wbCommand = extractWbCommand(toolName, rawIn);
      const inp = formatToolInputBounded(rawIn);
      this.pendingTools.set(callId, { name: toolName, category, summary, startedAt: Date.now(), files, wbCommand });
      return {
        events: [
          {
            type: "tool.start",
            turnIndex: turn,
            callId,
            toolName,
            category,
            summary,
            ...(inp.text !== undefined ? { inputText: inp.text } : {}),
            ...(inp.truncated ? { inputTruncated: true } : {}),
            ...(files.length > 0 ? { filesTouched: files } : {}),
            ...(wbCommand ? { wbCommand } : {}),
          },
        ],
        displayText: `🔧 调用工具: ${toolName}${summary ? ` (${summary})` : ""}\n`,
        replyText: null,
        sessionId,
      };
    }

    if (type === "tool_execution_end" || type === "tool_result") {
      const turn = Math.max(1, this.turnIndex || 1);
      const callId = String(evt.toolCallId ?? evt.callId ?? `omp-${turn}`);
      const pending = this.pendingTools.get(callId);
      if (pending) this.pendingTools.delete(callId);
      const durationMs = pending ? Math.max(0, Date.now() - pending.startedAt) : undefined;
      const boundedOut = formatToolOutputBounded(evt.result ?? evt.output);
      const isError = evt.isError === true || evt.success === false;
      return {
        events: [
          {
            type: "tool.end",
            turnIndex: turn,
            callId,
            toolName: pending?.name ?? String(evt.toolName ?? evt.tool ?? "tool"),
            category: pending?.category ?? "other",
            summary: pending?.summary ?? "",
            ...(boundedOut.output !== undefined ? { output: boundedOut.output } : {}),
            ...(boundedOut.outputBytes !== undefined ? { outputBytes: boundedOut.outputBytes } : {}),
            ...(boundedOut.outputTruncated ? { outputTruncated: true } : {}),
            ...(isError ? { isError: true } : {}),
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...(pending?.files && pending.files.length > 0 ? { filesTouched: pending.files } : {}),
            ...(pending?.wbCommand ? { wbCommand: pending.wbCommand } : {}),
          },
        ],
        displayText: "",
        replyText: null,
        sessionId,
      };
    }

    if (type === "message_end" && evt.message && typeof evt.message === "object") {
      const msg = evt.message as Record<string, unknown>;
      if (msg.role === "assistant") {
        const turn = Math.max(1, this.turnIndex || 1);
        const events: PartialTraceEvent[] = [];
        const displayParts: string[] = [];
        const replyParts: string[] = [];
        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const rawBlock of content) {
          if (!rawBlock || typeof rawBlock !== "object") continue;
          const b = rawBlock as Record<string, unknown>;
          if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
            const clean = b.thinking.trim();
            const bounded = formatTraceTextBounded(clean);
            events.push({ type: "thinking", turnIndex: turn, text: bounded.text, ...(bounded.truncated ? { truncated: true } : {}) });
            displayParts.push(`💭 ${clean}`);
          } else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
            const clean = b.text.trim();
            const bounded = formatTraceTextBounded(clean);
            events.push({ type: "assistant.message", turnIndex: turn, text: bounded.text, ...(bounded.truncated ? { truncated: true } : {}) });
            displayParts.push(clean);
            replyParts.push(clean);
          }
        }
        if (msg.usage && typeof msg.usage === "object") {
          const uObj = msg.usage as Record<string, unknown>;
          const uncached = toSafeCount(uObj.input ?? uObj.inputTokens);
          const cacheRead = toSafeCount(uObj.cacheRead ?? uObj.cacheReadTokens);
          const cacheWrite = toSafeCount(uObj.cacheWrite ?? uObj.cacheWriteTokens);
          const output = toSafeCount(uObj.output ?? uObj.outputTokens);
          const reasoning = toSafeCount(uObj.reasoning ?? uObj.reasoningTokens);
          const inputTokens = uncached + cacheRead + cacheWrite;
          const usage: RunTokenUsage = {
            inputTokens,
            uncachedInputTokens: uncached,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
            outputTokens: output,
            reasoningTokens: reasoning,
            totalTokens: toSafeCount(uObj.totalTokens) || inputTokens + output + reasoning,
          };
          const costObj = uObj.cost && typeof uObj.cost === "object" ? (uObj.cost as Record<string, unknown>) : null;
          const costUsd =
            costObj && typeof costObj.total === "number" && Number.isFinite(costObj.total) && costObj.total >= 0
              ? costObj.total
              : undefined;
          events.push({
            type: "turn.end",
            turnIndex: turn,
            contextTokens: usage.inputTokens || undefined,
            usage,
            ...(costUsd !== undefined ? { costUsd } : {}),
          });
        }
        return {
          events,
          displayText: displayParts.length > 0 ? `${displayParts.join("\n")}\n` : "",
          replyText: replyParts.length > 0 ? replyParts.join("\n\n") : null,
          sessionId,
        };
      }
    }

    if (type === "compaction" || type === "auto_compaction_end") {
      const beforeTokens = toSafeCount(evt.tokensBefore ?? evt.beforeTokens) || undefined;
      const afterTokens = toSafeCount(evt.tokensAfter ?? evt.afterTokens) || undefined;
      const reclaimedTokens =
        beforeTokens !== undefined && afterTokens !== undefined
          ? Math.max(0, beforeTokens - afterTokens)
          : undefined;
      return {
        events: [
          {
            type: "context.compaction",
            turnIndex: Math.max(1, this.turnIndex || 1),
            mode: "explicit",
            beforeTokens,
            afterTokens,
            reclaimedTokens,
          },
        ],
        displayText: "",
        replyText: null,
        sessionId,
      };
    }

    if (type === "error") {
      const msg = typeof evt.message === "string" ? evt.message : trimmed;
      return {
        events: [{ type: "run.error", message: sanitizeOutput(msg, 2000).text }],
        displayText: `❌ ${msg}\n`,
        replyText: null,
        sessionId,
      };
    }

    return { events: [], displayText: "", replyText: null, sessionId };
  }

  flush(): AdapterLineResult | null {
    return null;
  }
}

class PlainTextStreamAdapter implements HarnessStreamAdapter {
  feedLine(rawLine: string): AdapterLineResult {
    const cleaned = stripCliNoise(rawLine);
    if (!cleaned.trim()) {
      return { events: [], displayText: "", replyText: null };
    }
    return {
      events: [{ type: "raw.line", stream: "stdout", text: sanitizeOutput(cleaned, 8192).text }],
      displayText: `${cleaned}\n`,
      replyText: cleaned,
    };
  }
  flush(): AdapterLineResult | null {
    return null;
  }
}

export function createHarnessStreamAdapter(
  harness: HarnessId,
  requestedModel: string,
  structuredJson = true,
): HarnessStreamAdapter {
  if (!structuredJson) {
    return new PlainTextStreamAdapter();
  }
  switch (harness) {
    case "qodercn":
      return new QoderStreamAdapter(requestedModel);
    case "codex":
      return new CodexStreamAdapter();
    case "opencode":
      return new OpencodeStreamAdapter();
    case "agy":
      return new AgyStreamAdapter(requestedModel);
    case "omp":
      return new OmpStreamAdapter();
  }
}
