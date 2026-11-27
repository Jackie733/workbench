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

export interface CodexAppServerOptions {
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

export interface CodexAppServerHandle {
  done: Promise<{ exitCode: number; sessionId?: string; errorMessage?: string; handshakeFailed?: boolean }>;
  cancel: () => void;
}

interface PendingRpc {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

function normalizeCodexTokenUsage(raw: Record<string, unknown>): RunTokenUsage | undefined {
  const inputTokens = toSafeCount(raw.inputTokens ?? raw.input_tokens);
  const cachedInput = toSafeCount(raw.cachedInputTokens ?? raw.cached_input_tokens);
  const cacheWrite = toSafeCount(raw.cacheWriteInputTokens ?? raw.cache_write_input_tokens);
  const outputTokens = toSafeCount(raw.outputTokens ?? raw.output_tokens);
  const reasoningTokens = toSafeCount(raw.reasoningOutputTokens ?? raw.reasoning_output_tokens);
  const reportedTotal = toSafeCount(raw.totalTokens ?? raw.total_tokens);
  // OpenAI/Codex inputTokens already includes cachedInputTokens; derive uncached without double-counting.
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInput);
  const totalTokens = Math.max(reportedTotal, inputTokens + outputTokens + reasoningTokens);
  if (totalTokens === 0 && inputTokens === 0 && outputTokens === 0) return undefined;
  return {
    inputTokens,
    uncachedInputTokens,
    cacheReadTokens: cachedInput,
    cacheWriteTokens: cacheWrite,
    outputTokens,
    reasoningTokens,
    totalTokens,
  };
}

function joinTextSegments(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    return v
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
          return (item as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Drives `codex app-server --stdio` over newline-delimited JSON-RPC 2.0 (v2 protocol),
 * emitting real-time text/thinking deltas and structured tool/turn trace events.
 */
export function driveCodexAppServerProcess(
  child: ChildProcess,
  options: CodexAppServerOptions,
): CodexAppServerHandle {
  let nextId = 1;
  let threadId: string | undefined;
  let turnId: string | undefined;
  let closed = false;
  let cancelled = false;
  let initialized = false;
  let turnIndex = 0;
  let lineBuf = "";
  let latestUsage: RunTokenUsage | undefined;
  let latestContextTokens: number | undefined;
  const pending = new Map<number, PendingRpc>();
  const startedToolItems = new Map<string, number>();
  const agentMessageDeltas = new Map<string, string>();
  const reasoningDeltas = new Map<string, string>();
  const completedAgentItems = new Set<string>();
  const completedReasoningItems = new Set<string>();
  const replySegments: string[] = [];

  let resolveTurnCompletion: ((turn: Record<string, unknown>) => void) | null = null;
  let rejectTurnCompletion: ((err: Error) => void) | null = null;
  const turnCompletionPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
    resolveTurnCompletion = resolve;
    rejectTurnCompletion = reject;
  });
  // Prevent unhandled rejection if child exits or is cancelled before turnCompletionPromise is awaited.
  turnCompletionPromise.catch(() => {});

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

  const handleServerRequest = (id: unknown, method: string) => {
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      method === "execCommandApproval" ||
      method === "applyPatchApproval"
    ) {
      writeJsonLine({
        jsonrpc: "2.0",
        id,
        result: { decision: options.readOnly ? "decline" : "accept" },
      });
      return;
    }
    writeJsonLine({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unsupported client method: ${method}` },
    });
  };

  const handleItemStarted = (item: Record<string, unknown>) => {
    const itemType = typeof item.type === "string" ? item.type : "";
    const callId = typeof item.id === "string" ? item.id : `codex-item-${turnIndex}-${Date.now()}`;
    const turn = Math.max(1, turnIndex);

    if (itemType === "commandExecution") {
      startedToolItems.set(callId, Date.now());
      const command = typeof item.command === "string" ? item.command : "";
      const wbCommand = extractWbCommand("bash", { command });
      const inp = formatToolInputBounded({ command });
      options.onTraceEvent?.({
        type: "tool.start",
        turnIndex: turn,
        callId,
        toolName: "exec",
        category: wbCommand ? "wb_cli" : "bash",
        summary: command.replace(/\s+/g, " ").trim().slice(0, 90),
        ...(inp.text !== undefined ? { inputText: inp.text } : {}),
        ...(inp.truncated ? { inputTruncated: true } : {}),
        ...(wbCommand ? { wbCommand } : {}),
      });
      return;
    }

    if (itemType === "mcpToolCall" || itemType === "dynamicToolCall") {
      startedToolItems.set(callId, Date.now());
      const toolName = typeof item.tool === "string" ? item.tool : "mcp_tool";
      const argsObj = item.arguments;
      const wbCommand = extractWbCommand(toolName, argsObj);
      const files = extractTouchedFiles(toolName, argsObj).all;
      const inp = formatToolInputBounded(argsObj);
      options.onTraceEvent?.({
        type: "tool.start",
        turnIndex: turn,
        callId,
        toolName,
        category: wbCommand ? "wb_cli" : "mcp",
        summary: summarizeToolInput(argsObj),
        ...(inp.text !== undefined ? { inputText: inp.text } : {}),
        ...(inp.truncated ? { inputTruncated: true } : {}),
        ...(files.length > 0 ? { filesTouched: files } : {}),
        ...(wbCommand ? { wbCommand } : {}),
      });
      return;
    }

    if (itemType === "webSearch") {
      startedToolItems.set(callId, Date.now());
      const query = typeof item.query === "string" ? item.query : "";
      options.onTraceEvent?.({
        type: "tool.start",
        turnIndex: turn,
        callId,
        toolName: "web_search",
        category: "web",
        summary: query.slice(0, 90),
      });
    }
  };

  const handleItemCompleted = (item: Record<string, unknown>) => {
    const itemType = typeof item.type === "string" ? item.type : "";
    const callId = typeof item.id === "string" ? item.id : `codex-item-${turnIndex}`;
    const turn = Math.max(1, turnIndex);
    const startedAt = startedToolItems.get(callId);
    if (startedAt !== undefined) startedToolItems.delete(callId);
    const reportedDuration =
      typeof item.durationMs === "number" && Number.isFinite(item.durationMs) && item.durationMs >= 0
        ? Math.round(item.durationMs)
        : undefined;
    const durationMs = reportedDuration ?? (startedAt !== undefined ? Math.max(0, Date.now() - startedAt) : undefined);

    if (itemType === "agentMessage") {
      completedAgentItems.add(callId);
      const rawText = typeof item.text === "string" ? item.text : agentMessageDeltas.get(callId) ?? "";
      agentMessageDeltas.delete(callId);
      const clean = rawText.trim();
      if (!clean) return;
      const bounded = formatTraceTextBounded(clean);
      options.onTraceEvent?.({
        type: "assistant.message",
        turnIndex: turn,
        text: bounded.text,
        ...(bounded.truncated ? { truncated: true } : {}),
      });
      options.onDisplayText?.(`${clean}\n`);
      replySegments.push(clean);
      return;
    }

    if (itemType === "reasoning") {
      completedReasoningItems.add(callId);
      const summaryTxt = joinTextSegments(item.summary).trim();
      const contentTxt = joinTextSegments(item.content).trim();
      const rawThink = contentTxt || summaryTxt || (reasoningDeltas.get(callId) ?? "").trim();
      reasoningDeltas.delete(callId);
      if (!rawThink) return;
      const bounded = formatTraceTextBounded(rawThink);
      options.onTraceEvent?.({
        type: "thinking",
        turnIndex: turn,
        text: bounded.text,
        ...(bounded.truncated ? { truncated: true } : {}),
      });
      options.onDisplayText?.(`💭 ${rawThink}\n`);
      return;
    }

    if (itemType === "commandExecution") {
      const command = typeof item.command === "string" ? item.command : "";
      const rawOut = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
      const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
      const wbCommand = extractWbCommand("bash", { command });
      const cat = wbCommand ? "wb_cli" : "bash";
      const summary = command.replace(/\s+/g, " ").trim().slice(0, 90);
      if (startedAt === undefined) {
        const inp = formatToolInputBounded({ command });
        options.onTraceEvent?.({
          type: "tool.start",
          turnIndex: turn,
          callId,
          toolName: "exec",
          category: cat,
          summary,
          ...(inp.text !== undefined ? { inputText: inp.text } : {}),
          ...(inp.truncated ? { inputTruncated: true } : {}),
          ...(wbCommand ? { wbCommand } : {}),
        });
      }
      const boundedOut = formatToolOutputBounded(rawOut);
      options.onTraceEvent?.({
        type: "tool.end",
        turnIndex: turn,
        callId,
        toolName: "exec",
        category: cat,
        summary,
        ...(boundedOut.output !== undefined ? { output: boundedOut.output } : {}),
        ...(boundedOut.outputBytes !== undefined ? { outputBytes: boundedOut.outputBytes } : {}),
        ...(boundedOut.outputTruncated ? { outputTruncated: true } : {}),
        ...(exitCode !== null && exitCode !== 0 ? { isError: true } : {}),
        exitCode,
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(wbCommand ? { wbCommand } : {}),
      });
      options.onDisplayText?.(`exec: ${summary}\n`);
      return;
    }

    if (itemType === "mcpToolCall" || itemType === "dynamicToolCall") {
      const toolName = typeof item.tool === "string" ? item.tool : "mcp_tool";
      const argsObj = item.arguments;
      const wbCommand = extractWbCommand(toolName, argsObj);
      const files = extractTouchedFiles(toolName, argsObj).all;
      const summary = summarizeToolInput(argsObj);
      if (startedAt === undefined) {
        const inp = formatToolInputBounded(argsObj);
        options.onTraceEvent?.({
          type: "tool.start",
          turnIndex: turn,
          callId,
          toolName,
          category: wbCommand ? "wb_cli" : "mcp",
          summary,
          ...(inp.text !== undefined ? { inputText: inp.text } : {}),
          ...(inp.truncated ? { inputTruncated: true } : {}),
          ...(files.length > 0 ? { filesTouched: files } : {}),
          ...(wbCommand ? { wbCommand } : {}),
        });
      }
      const boundedOut = formatToolOutputBounded(item.error ?? item.result ?? item.contentItems);
      const isError = Boolean(item.error) || item.status === "failed" || item.success === false;
      options.onTraceEvent?.({
        type: "tool.end",
        turnIndex: turn,
        callId,
        toolName,
        category: wbCommand ? "wb_cli" : "mcp",
        summary,
        ...(boundedOut.output !== undefined ? { output: boundedOut.output } : {}),
        ...(boundedOut.outputBytes !== undefined ? { outputBytes: boundedOut.outputBytes } : {}),
        ...(boundedOut.outputTruncated ? { outputTruncated: true } : {}),
        ...(isError ? { isError: true } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(files.length > 0 ? { filesTouched: files } : {}),
        ...(wbCommand ? { wbCommand } : {}),
      });
      options.onDisplayText?.(`🔧 调用工具: ${toolName}\n`);
      return;
    }

    if (itemType === "webSearch") {
      const query = typeof item.query === "string" ? item.query : "";
      if (startedAt === undefined) {
        options.onTraceEvent?.({
          type: "tool.start",
          turnIndex: turn,
          callId,
          toolName: "web_search",
          category: "web",
          summary: query.slice(0, 90),
        });
      }
      options.onTraceEvent?.({
        type: "tool.end",
        turnIndex: turn,
        callId,
        toolName: "web_search",
        category: "web",
        summary: query.slice(0, 90),
      });
      options.onDisplayText?.(`🔧 web_search (${query.slice(0, 90)})\n`);
      return;
    }

    if (itemType === "fileChange") {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const files = changes
        .map((c) => (c && typeof c === "object" ? String((c as Record<string, unknown>).path ?? "") : ""))
        .filter(Boolean);
      const summary = files.slice(0, 3).join(", ") + (files.length > 3 ? ` (+${files.length - 3})` : "");
      options.onTraceEvent?.({
        type: "tool.end",
        turnIndex: turn,
        callId,
        toolName: "file_change",
        category: "write",
        summary,
        output: summary,
        ...(files.length > 0 ? { filesTouched: files } : {}),
      });
      return;
    }

    if (itemType === "contextCompaction") {
      options.onTraceEvent?.({
        type: "context.compaction",
        turnIndex: turn,
        mode: "explicit",
      });
    }
  };

  const handleNotification = (method: string, params: Record<string, unknown>) => {
    if (method === "turn/started") {
      turnIndex += 1;
      const tObj = params.turn && typeof params.turn === "object" ? (params.turn as Record<string, unknown>) : null;
      if (tObj && typeof tObj.id === "string") turnId = tObj.id;
      options.onTraceEvent?.({ type: "turn.start", turnIndex });
      return;
    }

    if (method === "item/agentMessage/delta") {
      const delta = typeof params.delta === "string" ? params.delta : "";
      const itemId = typeof params.itemId === "string" ? params.itemId : "";
      if (!delta) return;
      if (itemId) {
        agentMessageDeltas.set(itemId, (agentMessageDeltas.get(itemId) ?? "") + delta);
      }
      options.onDelta?.("text", delta);
      return;
    }

    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      const delta = typeof params.delta === "string" ? params.delta : "";
      const itemId = typeof params.itemId === "string" ? params.itemId : "";
      if (!delta) return;
      if (itemId) {
        reasoningDeltas.set(itemId, (reasoningDeltas.get(itemId) ?? "") + delta);
      }
      options.onDelta?.("thinking", delta);
      return;
    }

    if (method === "item/started" && params.item && typeof params.item === "object") {
      handleItemStarted(params.item as Record<string, unknown>);
      return;
    }

    if (method === "item/completed" && params.item && typeof params.item === "object") {
      handleItemCompleted(params.item as Record<string, unknown>);
      return;
    }

    if (method === "thread/tokenUsage/updated" && params.tokenUsage && typeof params.tokenUsage === "object") {
      const tu = params.tokenUsage as Record<string, unknown>;
      const total = tu.total && typeof tu.total === "object" ? (tu.total as Record<string, unknown>) : null;
      const last = tu.last && typeof tu.last === "object" ? (tu.last as Record<string, unknown>) : null;
      const normalized = total ? normalizeCodexTokenUsage(total) : last ? normalizeCodexTokenUsage(last) : undefined;
      if (normalized) {
        latestUsage = normalized;
        options.onUsage?.(normalized, Math.max(1, turnIndex));
      }
      if (last) {
        const lastInput = toSafeCount(last.inputTokens ?? last.input_tokens);
        if (lastInput > 0) latestContextTokens = lastInput;
      }
      return;
    }

    if (method === "turn/completed") {
      const tObj = (params.turn && typeof params.turn === "object" ? params.turn : {}) as Record<string, unknown>;
      resolveTurnCompletion?.(tObj);
      return;
    }

    if (method === "error") {
      const errObj = params.error && typeof params.error === "object" ? (params.error as Record<string, unknown>) : null;
      const msg =
        typeof errObj?.message === "string"
          ? errObj.message
          : typeof params.message === "string"
            ? params.message
            : "";
      if (msg && params.willRetry !== true) {
        options.onWarning?.(`[codex] ${msg}\n`);
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

    if (hasId && hasMethod) {
      handleServerRequest(msg.id, String(msg.method));
      return;
    }

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

    if (hasMethod) {
      const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
      handleNotification(String(msg.method), params);
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
    rejectTurnCompletion?.(err);
  };

  child.stdout?.on("data", onStdoutData);

  const onExitOrClose = (code: number | null) => {
    closed = true;
    rejectAllPending(new Error(`codex app-server exited unexpectedly (code=${code ?? "null"})`));
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
        clientInfo: { name: "workbench", title: "Workbench", version: "5.0.0" },
        capabilities: { experimentalApi: true },
      });
      initialized = true;
      writeJsonLine({ jsonrpc: "2.0", method: "initialized" });

      const resolvedModel = options.model && options.model !== "default" ? options.model : undefined;
      const sandboxMode = options.readOnly ? "read-only" : "danger-full-access";

      let threadResult: Record<string, unknown> | null = null;
      if (options.resumedSessionId) {
        try {
          const resumed = await sendRequest<Record<string, unknown>>("thread/resume", {
            threadId: options.resumedSessionId,
            cwd: options.cwd,
            approvalPolicy: "never",
            sandbox: sandboxMode,
            ...(resolvedModel ? { model: resolvedModel } : {}),
          });
          if (resumed?.thread && typeof (resumed.thread as Record<string, unknown>).id === "string") {
            threadResult = resumed;
          }
        } catch {
          // Expired or unknown thread: fall back cleanly to a fresh thread.
        }
      }

      if (!threadResult) {
        threadResult = await sendRequest<Record<string, unknown>>("thread/start", {
          cwd: options.cwd,
          approvalPolicy: "never",
          sandbox: sandboxMode,
          ...(resolvedModel ? { model: resolvedModel } : {}),
        });
      }

      const threadObj = (threadResult?.thread && typeof threadResult.thread === "object"
        ? threadResult.thread
        : {}) as Record<string, unknown>;
      const resolvedThreadId = typeof threadObj.id === "string" ? threadObj.id : undefined;
      if (!resolvedThreadId) {
        throw new Error("codex app-server thread/start did not return thread.id");
      }
      threadId = resolvedThreadId;
      options.onSessionId?.(threadId);

      options.onDisplayText?.(
        `⚡ Codex App-Server 引擎已就绪 (model: ${resolvedModel ?? "default"}, thread: ${threadId})\n`,
      );

      const turnRes = await sendRequest<Record<string, unknown>>("turn/start", {
        threadId,
        cwd: options.cwd,
        approvalPolicy: "never",
        ...(resolvedModel ? { model: resolvedModel } : {}),
        ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}),
        input: [{ type: "text", text: options.prompt }],
      });
      const startedTurnObj = (turnRes?.turn && typeof turnRes.turn === "object"
        ? turnRes.turn
        : {}) as Record<string, unknown>;
      if (typeof startedTurnObj.id === "string") turnId = startedTurnObj.id;

      const completedTurn = await turnCompletionPromise;
      if (lineBuf.trim()) {
        handleLine(lineBuf);
        lineBuf = "";
      }

      // Flush any trailing deltas if item/completed was skipped for an item.
      for (const [itemId, text] of agentMessageDeltas.entries()) {
        if (completedAgentItems.has(itemId)) continue;
        const clean = text.trim();
        if (!clean) continue;
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
      agentMessageDeltas.clear();

      for (const [itemId, text] of reasoningDeltas.entries()) {
        if (completedReasoningItems.has(itemId)) continue;
        const clean = text.trim();
        if (!clean) continue;
        const bounded = formatTraceTextBounded(clean);
        options.onTraceEvent?.({
          type: "thinking",
          turnIndex: Math.max(1, turnIndex),
          text: bounded.text,
          ...(bounded.truncated ? { truncated: true } : {}),
        });
      }
      reasoningDeltas.clear();

      const fullReply = replySegments.join("\n\n").trim();
      if (fullReply) {
        options.onReplyText?.(fullReply);
      }

      options.onTraceEvent?.({
        type: "turn.end",
        turnIndex: Math.max(1, turnIndex),
        ...(latestContextTokens !== undefined ? { contextTokens: latestContextTokens } : {}),
        ...(latestUsage ? { usage: latestUsage } : {}),
      });

      const status = typeof completedTurn.status === "string" ? completedTurn.status : "completed";
      cleanupChild();

      if (status === "failed") {
        const errObj =
          completedTurn.error && typeof completedTurn.error === "object"
            ? (completedTurn.error as Record<string, unknown>)
            : null;
        const errMsg = sanitizeOutput(
          typeof errObj?.message === "string" ? errObj.message : "Codex turn failed",
          1500,
        ).text;
        options.onTraceEvent?.({ type: "run.error", message: errMsg });
        options.onDisplayText?.(`❌ ${errMsg}\n`);
        return { exitCode: 1, sessionId: threadId, errorMessage: errMsg };
      }

      if (status === "interrupted") {
        return { exitCode: 130, sessionId: threadId, errorMessage: "Codex turn interrupted" };
      }

      return { exitCode: 0, sessionId: threadId };
    } catch (err) {
      const errMsg = sanitizeOutput(err instanceof Error ? err.message : String(err), 1500).text;
      if (!cancelled) {
        options.onTraceEvent?.({ type: "run.error", message: errMsg });
        options.onDisplayText?.(`❌ ${errMsg}\n`);
      }
      cleanupChild();
      return {
        exitCode: 1,
        sessionId: threadId,
        errorMessage: errMsg,
        handshakeFailed: !initialized && !cancelled,
      };
    }
  };

  return {
    done: runProtocol(),
    cancel: () => {
      cancelled = true;
      if (threadId && turnId) {
        const id = nextId++;
        writeJsonLine({
          jsonrpc: "2.0",
          id,
          method: "turn/interrupt",
          params: { threadId, turnId },
        });
      }
      rejectAllPending(new Error("cancelled"));
    },
  };
}
