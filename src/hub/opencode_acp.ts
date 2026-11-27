import type { ChildProcess } from "node:child_process";
import type { RunTokenUsage } from "../core/types.ts";
import { sanitizeOutput } from "../core/validate.ts";
import {
  classifyToolName,
  extractTouchedFiles,
  extractWbCommand,
  formatToolInputBounded,
  formatToolOutputBounded,
  formatTraceTextBounded,
  summarizeToolInput,
  toSafeCount,
  type PartialTraceEvent,
} from "./stream_adapters.ts";

export interface OpencodeAcpSessionOptions {
  cwd: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  resumedSessionId?: string;
  readOnly?: boolean;
  onActivity?: () => void;
  onSessionId?: (sessionId: string) => void;
  onDelta?: (channel: "text" | "thinking", delta: string) => void;
  onTraceEvent?: (event: PartialTraceEvent) => void;
  onUsage?: (usage: RunTokenUsage, turnsCount?: number) => void;
  onReplyText?: (text: string) => void;
  onDisplayText?: (text: string) => void;
  onWarning?: (line: string) => void;
}

export interface OpencodeAcpHandle {
  done: Promise<{ exitCode: number; sessionId?: string; errorMessage?: string; handshakeFailed?: boolean }>;
  cancel: () => void;
}

interface PendingRpc {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

interface ActiveToolState {
  callId: string;
  toolName: string;
  category: ReturnType<typeof classifyToolName>;
  summary: string;
  startedAt: number;
  files: string[];
  wbCommand?: string;
  ended: boolean;
}

function isBlockedInReadOnly(kind: string, title: string): boolean {
  const k = kind.trim().toLowerCase();
  if (k === "edit" || k === "delete" || k === "write" || k === "execute" || k === "move") return true;
  const t = title.trim().toLowerCase();
  return /^(?:write|edit|patch|apply_patch|multiedit|delete|rm|mv|move|notebookedit|bash|shell|exec|execute|run|terminal|command)\b/.test(
    t,
  );
}

function extractAcpContentText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => extractAcpContentText(item)).filter(Boolean).join("\n");
  }
  if (typeof content === "object") {
    const rec = content as Record<string, unknown>;
    if (rec.type === "text" && typeof rec.text === "string") return rec.text;
    if (rec.type === "content" && rec.content) return extractAcpContentText(rec.content);
    if (typeof rec.text === "string") return rec.text;
    if (typeof rec.newText === "string") return rec.newText;
  }
  return "";
}

function extractLocations(locations: unknown): string[] {
  if (!Array.isArray(locations)) return [];
  const out: string[] = [];
  for (const loc of locations) {
    if (!loc || typeof loc !== "object") continue;
    const rec = loc as Record<string, unknown>;
    if (typeof rec.path === "string" && rec.path.trim()) out.push(rec.path.trim());
    else if (typeof rec.uri === "string" && rec.uri.trim()) out.push(rec.uri.trim());
  }
  return out;
}

function normalizeAcpUsage(raw: Record<string, unknown>): RunTokenUsage | undefined {
  const uncached = toSafeCount(raw.inputTokens ?? raw.input_tokens);
  const cacheRead = toSafeCount(raw.cachedReadTokens ?? raw.cached_read_tokens);
  const cacheWrite = toSafeCount(raw.cachedWriteTokens ?? raw.cached_write_tokens);
  const output = toSafeCount(raw.outputTokens ?? raw.output_tokens);
  const reasoning = toSafeCount(raw.thoughtTokens ?? raw.thought_tokens ?? raw.reasoningTokens);
  const reportedTotal = toSafeCount(raw.totalTokens ?? raw.total_tokens);
  const inputTokens = uncached + cacheRead + cacheWrite;
  const totalTokens = Math.max(reportedTotal, inputTokens + output + reasoning);
  if (totalTokens === 0 && inputTokens === 0 && output === 0) return undefined;
  return {
    inputTokens,
    uncachedInputTokens: uncached,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
    reasoningTokens: reasoning,
    totalTokens,
  };
}

/**
 * Drives an `opencode acp` child process over newline-delimited JSON-RPC 2.0,
 * emitting token-level text/thinking deltas and structured tool/turn trace events.
 */
export function driveOpencodeAcpProcess(
  child: ChildProcess,
  options: OpencodeAcpSessionOptions,
): OpencodeAcpHandle {
  let nextId = 1;
  let sessionId: string | undefined;
  let closed = false;
  let cancelled = false;
  let initialized = false;
  let turnIndex = 0;
  let turnOpen = false;
  let lineBuf = "";
  let thinkingBuf = "";
  let textBuf = "";
  let latestContextTokens: number | undefined;
  const replySegments: string[] = [];
  const pending = new Map<number, PendingRpc>();
  const activeTools = new Map<string, ActiveToolState>();

  const ensureTurnStarted = () => {
    if (turnOpen) return;
    turnOpen = true;
    turnIndex += 1;
    options.onTraceEvent?.({ type: "turn.start", turnIndex });
  };

  const flushBuffers = () => {
    if (thinkingBuf.trim()) {
      ensureTurnStarted();
      const bounded = formatTraceTextBounded(thinkingBuf.trim());
      options.onTraceEvent?.({
        type: "thinking",
        turnIndex: Math.max(1, turnIndex),
        text: bounded.text,
        ...(bounded.truncated ? { truncated: true } : {}),
      });
      options.onDisplayText?.(`💭 ${thinkingBuf.trim()}\n`);
    }
    thinkingBuf = "";

    if (textBuf.trim()) {
      ensureTurnStarted();
      const clean = textBuf.trim();
      const bounded = formatTraceTextBounded(clean);
      options.onTraceEvent?.({
        type: "assistant.message",
        turnIndex: Math.max(1, turnIndex),
        text: bounded.text,
        ...(bounded.truncated ? { truncated: true } : {}),
      });
      options.onDisplayText?.(`${clean}\n`);
      replySegments.push(clean);
    }
    textBuf = "";
  };

  const writeJsonLine = (payload: Record<string, unknown>) => {
    if (closed || !child.stdin || child.stdin.destroyed || !child.stdin.writable) return;
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // Ignore write failures if child exited concurrently.
    }
  };

  const sendRequest = <T = unknown>(method: string, params: Record<string, unknown>): Promise<T> => {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, {
        method,
        resolve: (res) => resolve(res as T),
        reject,
      });
      writeJsonLine({ jsonrpc: "2.0", id, method, params });
    });
  };

  const handlePermissionRequest = (id: unknown, params: Record<string, unknown>) => {
    const toolCall = (params.toolCall && typeof params.toolCall === "object" ? params.toolCall : {}) as Record<
      string,
      unknown
    >;
    const kind = typeof toolCall.kind === "string" ? toolCall.kind : "";
    const title = typeof toolCall.title === "string" ? toolCall.title : "";
    const opts = Array.isArray(params.options) ? (params.options as Array<Record<string, unknown>>) : [];

    if (options.readOnly && isBlockedInReadOnly(kind, title)) {
      writeJsonLine({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
      return;
    }

    const allowOpt =
      opts.find((o) => o?.kind === "allow_once" && typeof o.optionId === "string") ??
      opts.find((o) => o?.kind === "allow_always" && typeof o.optionId === "string") ??
      opts.find((o) => typeof o?.optionId === "string" && !String(o.kind ?? "").startsWith("reject"));

    if (allowOpt && typeof allowOpt.optionId === "string") {
      writeJsonLine({
        jsonrpc: "2.0",
        id,
        result: { outcome: { outcome: "selected", optionId: allowOpt.optionId } },
      });
    } else {
      writeJsonLine({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
    }
  };

  const handleSessionUpdate = (params: Record<string, unknown>) => {
    const update = (params.update && typeof params.update === "object" ? params.update : null) as Record<
      string,
      unknown
    > | null;
    if (!update) return;
    const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";

    if (kind === "agent_thought_chunk") {
      const chunk = extractAcpContentText(update.content);
      if (!chunk) return;
      ensureTurnStarted();
      thinkingBuf += chunk;
      options.onDelta?.("thinking", chunk);
      return;
    }

    if (kind === "agent_message_chunk") {
      const chunk = extractAcpContentText(update.content);
      if (!chunk) return;
      ensureTurnStarted();
      textBuf += chunk;
      options.onDelta?.("text", chunk);
      return;
    }

    if (kind === "tool_call") {
      flushBuffers();
      ensureTurnStarted();
      const callId =
        typeof update.toolCallId === "string" && update.toolCallId
          ? update.toolCallId
          : `acp-tool-${turnIndex}-${activeTools.size + 1}`;
      if (activeTools.has(callId)) return;
      const rawTitle = typeof update.title === "string" && update.title.trim() ? update.title.trim() : "";
      const toolKind = typeof update.kind === "string" ? update.kind : "";
      const toolName = rawTitle || toolKind || "tool";
      const rawInput = update.rawInput;
      const summary = summarizeToolInput(rawInput) || rawTitle;
      const category = classifyToolName(toolKind || toolName, rawInput);
      const wbCommand = extractWbCommand(toolName, rawInput);
      const files = Array.from(
        new Set([...extractTouchedFiles(toolName, rawInput).all, ...extractLocations(update.locations)]),
      ).slice(0, 24);
      const inp = formatToolInputBounded(rawInput);

      activeTools.set(callId, {
        callId,
        toolName,
        category,
        summary,
        startedAt: Date.now(),
        files,
        wbCommand,
        ended: false,
      });

      options.onTraceEvent?.({
        type: "tool.start",
        turnIndex: Math.max(1, turnIndex),
        callId,
        toolName,
        category,
        summary,
        ...(inp.text !== undefined ? { inputText: inp.text } : {}),
        ...(inp.truncated ? { inputTruncated: true } : {}),
        ...(files.length > 0 ? { filesTouched: files } : {}),
        ...(wbCommand ? { wbCommand } : {}),
      });
      return;
    }

    if (kind === "tool_call_update") {
      const callId = typeof update.toolCallId === "string" ? update.toolCallId : "";
      const status = typeof update.status === "string" ? update.status.toLowerCase() : "";
      const existing = callId ? activeTools.get(callId) : undefined;
      const isTerminal = status === "completed" || status === "failed" || status === "cancelled";

      if (!existing && callId) {
        const rawTitle = typeof update.title === "string" && update.title.trim() ? update.title.trim() : "";
        const toolKind = typeof update.kind === "string" ? update.kind : "";
        const toolName = rawTitle || toolKind || "tool";
        const rawInput = update.rawInput;
        const summary = summarizeToolInput(rawInput) || rawTitle;
        const category = classifyToolName(toolKind || toolName, rawInput);
        const wbCommand = extractWbCommand(toolName, rawInput);
        const files = Array.from(
          new Set([...extractTouchedFiles(toolName, rawInput).all, ...extractLocations(update.locations)]),
        ).slice(0, 24);
        const inp = formatToolInputBounded(rawInput);
        ensureTurnStarted();
        const created: ActiveToolState = {
          callId,
          toolName,
          category,
          summary,
          startedAt: Date.now(),
          files,
          wbCommand,
          ended: false,
        };
        activeTools.set(callId, created);
        options.onTraceEvent?.({
          type: "tool.start",
          turnIndex: Math.max(1, turnIndex),
          callId,
          toolName,
          category,
          summary,
          ...(inp.text !== undefined ? { inputText: inp.text } : {}),
          ...(inp.truncated ? { inputTruncated: true } : {}),
          ...(files.length > 0 ? { filesTouched: files } : {}),
          ...(wbCommand ? { wbCommand } : {}),
        });
      }

      const targetTool = callId ? activeTools.get(callId) : undefined;
      if (isTerminal && targetTool && !targetTool.ended) {
        targetTool.ended = true;
        const rawOut =
          update.rawOutput !== undefined
            ? update.rawOutput
            : Array.isArray(update.content) && update.content.length > 0
              ? extractAcpContentText(update.content)
              : undefined;
        const boundedOut = formatToolOutputBounded(rawOut);
        const isError = status === "failed" || status === "cancelled";
        const files = Array.from(
          new Set([...targetTool.files, ...extractLocations(update.locations)]),
        ).slice(0, 24);

        options.onTraceEvent?.({
          type: "tool.end",
          turnIndex: Math.max(1, turnIndex),
          callId: targetTool.callId,
          toolName: targetTool.toolName,
          category: targetTool.category,
          summary: targetTool.summary,
          ...(boundedOut.output !== undefined ? { output: boundedOut.output } : {}),
          ...(boundedOut.outputBytes !== undefined ? { outputBytes: boundedOut.outputBytes } : {}),
          ...(boundedOut.outputTruncated ? { outputTruncated: true } : {}),
          ...(isError ? { isError: true } : {}),
          durationMs: Math.max(0, Date.now() - targetTool.startedAt),
          ...(files.length > 0 ? { filesTouched: files } : {}),
          ...(targetTool.wbCommand ? { wbCommand: targetTool.wbCommand } : {}),
        });
        options.onDisplayText?.(
          `🔧 调用工具: ${targetTool.toolName}${targetTool.summary ? ` (${targetTool.summary})` : ""}\n`,
        );
      }
      return;
    }

    if (kind === "usage_update") {
      const used = toSafeCount(update.used);
      if (used > 0) {
        latestContextTokens = used;
      }
    }
  };

  const handleLine = (rawLine: string) => {
    const trimmed = rawLine.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    options.onActivity?.();

    const hasId = Object.hasOwn(msg, "id") && msg.id !== undefined && msg.id !== null;
    const hasMethod = typeof msg.method === "string";

    // Server -> Client JSON-RPC request (e.g. session/request_permission)
    if (hasId && hasMethod) {
      const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
      if (msg.method === "session/request_permission") {
        handlePermissionRequest(msg.id, params);
      } else {
        writeJsonLine({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `Unsupported client method: ${String(msg.method)}` },
        });
      }
      return;
    }

    // Response to one of our requests
    if (hasId && !hasMethod) {
      const idNum = typeof msg.id === "number" ? msg.id : Number(msg.id);
      const req = pending.get(idNum);
      if (!req) return;
      pending.delete(idNum);
      if (msg.error && typeof msg.error === "object") {
        const errRec = msg.error as Record<string, unknown>;
        const errMsg = typeof errRec.message === "string" ? errRec.message : JSON.stringify(msg.error);
        req.reject(new Error(`${req.method}: ${errMsg}`));
      } else {
        req.resolve(msg.result);
      }
      return;
    }

    // Notification
    if (hasMethod && msg.method === "session/update") {
      const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
      handleSessionUpdate(params);
    }
  };

  const onStdoutData = (buf: Buffer) => {
    if (buf.length > 0) options.onActivity?.();
    lineBuf += buf.toString("utf8");
    const lines = lineBuf.split(/\r?\n/);
    lineBuf = lines.pop() ?? "";
    for (const line of lines) {
      handleLine(line);
    }
  };

  const rejectAllPending = (err: Error) => {
    for (const req of pending.values()) {
      req.reject(err);
    }
    pending.clear();
  };

  child.stdout?.on("data", onStdoutData);

  const onExitOrClose = (code: number | null) => {
    closed = true;
    rejectAllPending(new Error(`opencode acp exited unexpectedly (code=${code ?? "null"})`));
  };
  const onChildError = (err: Error) => {
    closed = true;
    rejectAllPending(err);
  };
  child.once("close", onExitOrClose);
  child.once("error", onChildError);

  const cleanupChild = () => {
    closed = true;
    child.stdout?.off("data", onStdoutData);
    child.off("close", onExitOrClose);
    child.off("error", onChildError);
    try {
      child.stdin?.end();
    } catch {
      // Ignore stdin close errors.
    }
  };

  const runProtocol = async (): Promise<{
    exitCode: number;
    sessionId?: string;
    errorMessage?: string;
    handshakeFailed?: boolean;
  }> => {
    try {
      await sendRequest("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "workbench", version: "5.0.0" },
      });
      initialized = true;

      let sessionResult: Record<string, unknown> | null = null;
      if (options.resumedSessionId) {
        try {
          const resumed = await sendRequest<Record<string, unknown>>("session/resume", {
            sessionId: options.resumedSessionId,
            cwd: options.cwd,
            mcpServers: [],
          });
          if (resumed && typeof resumed.sessionId === "string" && resumed.sessionId) {
            sessionResult = resumed;
          }
        } catch {
          // Expired or unknown session: fall back transparently to a fresh session.
        }
      }

      if (!sessionResult) {
        sessionResult = await sendRequest<Record<string, unknown>>("session/new", {
          cwd: options.cwd,
          mcpServers: [],
        });
      }

      const resolvedSessionId =
        sessionResult && typeof sessionResult.sessionId === "string" ? sessionResult.sessionId : undefined;
      if (!resolvedSessionId) {
        throw new Error("opencode acp session/new did not return a sessionId");
      }
      sessionId = resolvedSessionId;
      options.onSessionId?.(sessionId);

      const configOptions = Array.isArray(sessionResult.configOptions)
        ? (sessionResult.configOptions as Array<Record<string, unknown>>)
        : [];
      const modelConfig = configOptions.find((c) => c?.id === "model" || c?.category === "model");

      if (options.model && options.model !== "default") {
        const currentModel = typeof modelConfig?.currentValue === "string" ? modelConfig.currentValue : undefined;
        if (currentModel !== options.model) {
          try {
            await sendRequest("session/set_config_option", {
              sessionId,
              configId: typeof modelConfig?.id === "string" ? modelConfig.id : "model",
              value: options.model,
            });
          } catch (err) {
            const note = `[workbench] ⚠️ opencode acp 切换模型 ${options.model} 失败，将继续使用当前会话模型 (${err instanceof Error ? err.message : String(err)})\n`;
            options.onWarning?.(note);
          }
        }
      }

      if (options.reasoningEffort) {
        const effortConfig = configOptions.find((c) => {
          const id = typeof c?.id === "string" ? c.id.toLowerCase() : "";
          const cat = typeof c?.category === "string" ? c.category.toLowerCase() : "";
          return (
            id === "reasoning_effort" ||
            id === "reasoningeffort" ||
            id === "thought_level" ||
            id === "thinking" ||
            id === "variant" ||
            cat === "thought_level" ||
            cat === "reasoning"
          );
        });
        if (effortConfig && typeof effortConfig.id === "string") {
          const currentEffort =
            typeof effortConfig.currentValue === "string" ? effortConfig.currentValue : undefined;
          const allowedValues = Array.isArray(effortConfig.options)
            ? (effortConfig.options as Array<Record<string, unknown>>)
                .map((o) => (typeof o?.value === "string" ? o.value : typeof o?.id === "string" ? o.id : ""))
                .filter(Boolean)
            : [];
          const effortSupported = allowedValues.length === 0 || allowedValues.includes(options.reasoningEffort);
          if (effortSupported && currentEffort !== options.reasoningEffort) {
            try {
              await sendRequest("session/set_config_option", {
                sessionId,
                configId: effortConfig.id,
                value: options.reasoningEffort,
              });
            } catch (err) {
              const note = `[workbench] ⚠️ opencode acp 设置思考深度 ${options.reasoningEffort} 失败 (${err instanceof Error ? err.message : String(err)})\n`;
              options.onWarning?.(note);
            }
          }
        }
      }

      options.onDisplayText?.(
        `⚡ OpenCode ACP 引擎已就绪 (model: ${options.model || "default"}, session: ${sessionId})\n`,
      );

      const promptRes = (await sendRequest("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: options.prompt }],
      })) as Record<string, unknown> | null;

      if (lineBuf.trim()) {
        handleLine(lineBuf);
        lineBuf = "";
      }
      flushBuffers();

      const fullReply = replySegments.join("\n\n").trim();
      if (fullReply) {
        options.onReplyText?.(fullReply);
      }

      const usage =
        promptRes?.usage && typeof promptRes.usage === "object"
          ? normalizeAcpUsage(promptRes.usage as Record<string, unknown>)
          : undefined;
      if (usage) {
        options.onUsage?.(usage, Math.max(1, turnIndex));
      }
      const contextTokens = latestContextTokens ?? usage?.inputTokens;
      if (turnOpen || usage || contextTokens !== undefined) {
        options.onTraceEvent?.({
          type: "turn.end",
          turnIndex: Math.max(1, turnIndex),
          ...(contextTokens !== undefined ? { contextTokens } : {}),
          ...(usage ? { usage } : {}),
        });
        turnOpen = false;
      }

      cleanupChild();
      return { exitCode: 0, sessionId };
    } catch (err) {
      flushBuffers();
      const errMsg = sanitizeOutput(err instanceof Error ? err.message : String(err), 1500).text;
      if (!cancelled) {
        options.onTraceEvent?.({ type: "run.error", message: errMsg });
        options.onDisplayText?.(`❌ ${errMsg}\n`);
      }
      cleanupChild();
      return {
        exitCode: 1,
        sessionId,
        errorMessage: errMsg,
        handshakeFailed: !initialized && !cancelled,
      };
    }
  };

  return {
    done: runProtocol(),
    cancel: () => {
      cancelled = true;
      if (sessionId) {
        writeJsonLine({
          jsonrpc: "2.0",
          method: "session/cancel",
          params: { sessionId },
        });
      }
      rejectAllPending(new Error("cancelled"));
    },
  };
}
