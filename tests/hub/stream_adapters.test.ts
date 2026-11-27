import { describe, expect, test } from "bun:test";
import {
  MAX_TOOL_INPUT_BYTES,
  MAX_TOOL_OUTPUT_BYTES,
  MAX_TRACE_TEXT_BYTES,
} from "../../src/core/types.ts";
import {
  classifyToolName,
  createHarnessStreamAdapter,
  extractTouchedFiles,
  extractWbCommand,
  isUnsupportedJsonFlagError,
  stripCliNoise,
} from "../../src/hub/stream_adapters.ts";

describe("stream_adapters structured JSONL parsing & bounds", () => {
  test("parses qodercn stream-json events including thinking, tool_use/tool_result pairing, and authoritative result totals", () => {
    const adapter = createHarnessStreamAdapter("qodercn", "Qwen4-Max-Preview", true);

    const init = adapter.feedLine(
      JSON.stringify({ type: "system", subtype: "init", session_id: "qs-1", model: "auto" }),
    );
    expect(init.sessionId).toBe("qs-1");
    expect(init.modelFallback).toBe(true);
    expect(init.effectiveModel).toBe("auto");
    expect(init.displayText).toContain("⚡ Qoder 引擎已就绪");

    const asst = adapter.feedLine(
      JSON.stringify({
        type: "assistant",
        session_id: "qs-1",
        message: {
          content: [
            { type: "thinking", thinking: "先检查测试命令" },
            {
              type: "tool_use",
              id: "call-1",
              name: "bash",
              input: { command: "wb verify REQ-001 --all" },
            },
          ],
          usage: {
            input_tokens: 1000,
            cache_read_input_tokens: 800,
            cache_creation_input_tokens: 100,
            output_tokens: 120,
          },
        },
      }),
    );
    expect(asst.events.some((e) => e.type === "thinking")).toBe(true);
    const toolStart = asst.events.find((e) => e.type === "tool.start");
    expect(toolStart).toBeDefined();
    if (toolStart?.type === "tool.start") {
      expect(toolStart.category).toBe("wb_cli");
      expect(toolStart.wbCommand).toBe("wb verify");
    }

    const userToolRes = adapter.feedLine(
      JSON.stringify({
        type: "user",
        session_id: "qs-1",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-1",
              content: "PASS all checks",
              is_error: false,
            },
          ],
        },
      }),
    );
    const toolEnd = userToolRes.events.find((e) => e.type === "tool.end");
    expect(toolEnd?.type).toBe("tool.end");
    if (toolEnd?.type === "tool.end") {
      expect(toolEnd.wbCommand).toBe("wb verify");
      expect(toolEnd.output).toContain("PASS all checks");
    }

    const resultLine = adapter.feedLine(
      JSON.stringify({
        type: "result",
        session_id: "qs-1",
        result: "全部验收通过",
        duration_ms: 1850,
        num_turns: 2,
        total_cost_usd: 0.042,
        usage: {
          input_tokens: 1200,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 200,
          output_tokens: 300,
        },
      }),
    );
    expect(resultLine.authoritativeUsage).toEqual({
      inputTokens: 2200,
      uncachedInputTokens: 1200,
      cacheReadTokens: 800,
      cacheWriteTokens: 200,
      outputTokens: 300,
      reasoningTokens: 0,
      totalTokens: 2500,
    });
    expect(resultLine.authoritativeCostUsd).toBe(0.042);
    expect(resultLine.authoritativeTurnsCount).toBe(2);
    expect(resultLine.replyText).toBe("全部验收通过");
  });

  test("normalizes Codex OpenAI cache tokens without double-counting input_tokens", () => {
    const adapter = createHarnessStreamAdapter("codex", "gpt-5.4", true);
    const thread = adapter.feedLine(JSON.stringify({ type: "thread.started", thread_id: "codex-thread-99" }));
    expect(thread.sessionId).toBe("codex-thread-99");

    adapter.feedLine(JSON.stringify({ type: "turn.started" }));
    const startItem = adapter.feedLine(
      JSON.stringify({
        type: "item.started",
        item: { id: "cmd-1", type: "command_execution", command: "bun test" },
      }),
    );
    expect(startItem.events[0]?.type).toBe("tool.start");

    const doneItem = adapter.feedLine(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "bun test",
          exit_code: 0,
          aggregated_output: "10 passed",
        },
      }),
    );
    const tEnd = doneItem.events.find((e) => e.type === "tool.end");
    expect(tEnd?.type).toBe("tool.end");
    if (tEnd?.type === "tool.end") {
      expect(tEnd.exitCode).toBe(0);
      expect(tEnd.output).toContain("10 passed");
    }

    const turnDone = adapter.feedLine(
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 10_000,
          cached_input_tokens: 7_500,
          output_tokens: 500,
          reasoning_tokens: 200,
        },
      }),
    );
    const te = turnDone.events.find((e) => e.type === "turn.end");
    expect(te?.type).toBe("turn.end");
    if (te?.type === "turn.end") {
      expect(te.usage).toEqual({
        inputTokens: 10_000,
        uncachedInputTokens: 2_500,
        cacheReadTokens: 7_500,
        cacheWriteTokens: 0,
        outputTokens: 500,
        reasoningTokens: 200,
        totalTokens: 10_700,
      });
    }
  });

  test("parses OpenCode, AGY, and OMP structured streams cleanly", () => {
    const oc = createHarnessStreamAdapter("opencode", "opencode-go/glm-5", true);
    oc.feedLine(JSON.stringify({ type: "step_start", sessionID: "oc-1" }));
    const ocTool = oc.feedLine(
      JSON.stringify({
        type: "tool_use",
        sessionID: "oc-1",
        part: {
          callID: "oc-call-1",
          tool: "edit",
          state: {
            input: { file_path: "src/app.ts", old_string: "a", new_string: "b" },
            output: "updated src/app.ts",
            time: { start: 1000, end: 1120 },
          },
        },
      }),
    );
    expect(ocTool.events.map((e) => e.type)).toEqual(["tool.start", "tool.end"]);
    const ocFinish = oc.feedLine(
      JSON.stringify({
        type: "step_finish",
        sessionID: "oc-1",
        part: {
          cost: 0.015,
          tokens: { input: 300, output: 150, reasoning: 50, cache: { read: 1200, write: 100 } },
        },
      }),
    );
    const ocTurnEnd = ocFinish.events[0];
    expect(ocTurnEnd?.type).toBe("turn.end");
    if (ocTurnEnd?.type === "turn.end") {
      expect(ocTurnEnd.usage?.inputTokens).toBe(1600);
      expect(ocTurnEnd.usage?.totalTokens).toBe(1800);
      expect(ocTurnEnd.costUsd).toBe(0.015);
    }

    const agy = createHarnessStreamAdapter("agy", "gemini-2.5-pro", true);
    agy.feedLine(JSON.stringify({ type: "thinking", text: "planning steps" }));
    agy.feedLine(JSON.stringify({ type: "tool_call", id: "a1", name: "read_file", input: { file_path: "README.md" } }));
    const agyRes = agy.feedLine(
      JSON.stringify({
        type: "result",
        result: "Completed task",
        total_cost_usd: 0.02,
        usage: { input_tokens: 400, cache_read_input_tokens: 600, output_tokens: 80 },
      }),
    );
    expect(agyRes.authoritativeCostUsd).toBe(0.02);
    expect(agyRes.authoritativeUsage?.totalTokens).toBe(1080);

    const omp = createHarnessStreamAdapter("omp", "anthropic/claude-sonnet-4", true);
    omp.feedLine(JSON.stringify({ type: "turn_start" }));
    const ompStart = omp.feedLine(
      JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "omp-1",
        toolName: "write",
        args: { path: "src/new.ts" },
      }),
    );
    expect(ompStart.events[0]?.type).toBe("tool.start");
    const ompCmp = omp.feedLine(
      JSON.stringify({ type: "auto_compaction_end", tokensBefore: 50000, tokensAfter: 12000 }),
    );
    expect(ompCmp.events[0]?.type).toBe("context.compaction");
  });

  test("enforces 16KB/32KB/64KB bounds and handles non-protocol JSON, plain text, and unsupported flags", () => {
    const codex = createHarnessStreamAdapter("codex", "gpt-5.4", true);
    const mockVerdict = '{"verdict":"pass","summary":"LGTM","blockingIssues":[]}';
    const passed = codex.feedLine(mockVerdict);
    expect(passed.events[0]?.type).toBe("raw.line");
    expect(passed.displayText).toBe(`${mockVerdict}\n`);

    const bigInput = "X".repeat(MAX_TOOL_INPUT_BYTES + 4096);
    const bigOutput = `HEAD_${"A".repeat(MAX_TOOL_OUTPUT_BYTES + 8192)}_TAIL`;
    const bigReply = "R".repeat(MAX_TRACE_TEXT_BYTES + 4096);

    const oc = createHarnessStreamAdapter("opencode", "opencode-go/glm-5", true);
    const bigTool = oc.feedLine(
      JSON.stringify({
        type: "tool_use",
        part: {
          callID: "big-1",
          tool: "bash",
          state: { input: { command: bigInput }, output: bigOutput },
        },
      }),
    );
    const tStart = bigTool.events.find((e) => e.type === "tool.start");
    const tEnd = bigTool.events.find((e) => e.type === "tool.end");
    if (tStart?.type === "tool.start") {
      expect(tStart.inputTruncated).toBe(true);
      expect(Buffer.byteLength(tStart.inputText ?? "", "utf8")).toBeLessThanOrEqual(MAX_TOOL_INPUT_BYTES + 128);
    }
    if (tEnd?.type === "tool.end") {
      expect(tEnd.outputTruncated).toBe(true);
      expect(tEnd.output).toContain("HEAD_");
      expect(tEnd.output).toContain("_TAIL");
      expect(Buffer.byteLength(tEnd.output ?? "", "utf8")).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES + 256);
    }

    const bigMsg = oc.feedLine(JSON.stringify({ type: "text", part: { text: bigReply } }));
    const aMsg = bigMsg.events[0];
    if (aMsg?.type === "assistant.message") {
      expect(aMsg.truncated).toBe(true);
      expect(Buffer.byteLength(aMsg.text, "utf8")).toBeLessThanOrEqual(MAX_TRACE_TEXT_BYTES + 256);
    }

    const plain = createHarnessStreamAdapter("codex", "gpt-5.4", false);
    const plainLine = plain.feedLine("plain hello output");
    expect(plainLine.events[0]?.type).toBe("raw.line");
    expect(plainLine.replyText).toBe("plain hello output");

    // Multi-tool Codex turn still emits positive amortized contextTokens for native_resume gating
    const codexMulti = createHarnessStreamAdapter("codex", "gpt-5.4", true);
    codexMulti.feedLine(JSON.stringify({ type: "turn.started" }));
    for (let i = 1; i <= 3; i++) {
      codexMulti.feedLine(
        JSON.stringify({
          type: "item.started",
          item: { id: `cmd-${i}`, type: "command_execution", command: `echo ${i}` },
        }),
      );
    }
    const multiEnd = codexMulti.feedLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 400_000, cached_input_tokens: 300_000, output_tokens: 800, reasoning_tokens: 0 },
      }),
    );
    const multiTe = multiEnd.events.find((e) => e.type === "turn.end");
    expect(multiTe?.type).toBe("turn.end");
    if (multiTe?.type === "turn.end") {
      expect(multiTe.contextTokens).toBe(100_000);
    }

    expect(isUnsupportedJsonFlagError("error: unknown option '--json'")).toBe(true);
    expect(isUnsupportedJsonFlagError("error: invalid argument '--output-format'")).toBe(true);
    expect(isUnsupportedJsonFlagError("all tests passed")).toBe(false);
    expect(stripCliNoise('Model "foo" is not available right now; using "auto" instead.\nok')).toBe("ok");
    expect(classifyToolName("bash", { command: "wb verify REQ-001 --all" })).toBe("wb_cli");
    expect(extractWbCommand("bash", { command: "wb verify REQ-001 --all" })).toBe("wb verify");
    expect(extractTouchedFiles("write", { file_path: "src/a.ts" }).all).toContain("src/a.ts");
  });

  test("parses real AGY step_update/init/result protocol, text_delta buffering, PascalCase params, and AGY usage without double-counting thinking_tokens", () => {
    const adapter = createHarnessStreamAdapter("agy", "gemini-4-neon", true);

    const init = adapter.feedLine(
      JSON.stringify({
        event: "init",
        conversation_id: "agy-conv-1",
        init: { model: "gemini-4-neon-medium", cwd: "/repo", tools: ["read_file", "run_command"] },
      }),
    );
    expect(init.sessionId).toBe("agy-conv-1");
    expect(init.effectiveModel).toBe("gemini-4-neon-medium");
    expect(init.displayText).toContain("⚡ AGY 引擎已就绪");

    // user_input & system_message should be silently absorbed (no raw.line pollution)
    const userInput = adapter.feedLine(
      JSON.stringify({
        event: "step_update",
        step_update: { conversation_id: "agy-conv-1", step_index: 0, state: "DONE", step_type: "user_input" },
      }),
    );
    expect(userInput.events).toEqual([]);
    expect(userInput.displayText).toBe("");

    // Intermediate agent_response step (no text_delta, reports usage & duration)
    const step1 = adapter.feedLine(
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "agy-conv-1",
          step_index: 1,
          state: "DONE",
          step_type: "agent_response",
          duration_seconds: 2.5,
          usage: { input_tokens: 1000, output_tokens: 200, thinking_tokens: 120, cache_read_tokens: 500, total_tokens: 1200 },
        },
      }),
    );
    expect(step1.events.map((e) => e.type)).toEqual(["turn.start", "turn.end"]);
    const turnEnd1 = step1.events[1];
    if (turnEnd1?.type === "turn.end") {
      expect(turnEnd1.durationMs).toBe(2500);
      expect(turnEnd1.contextTokens).toBe(1500);
      expect(turnEnd1.usage).toEqual({
        inputTokens: 1500,
        uncachedInputTokens: 1000,
        cacheReadTokens: 500,
        cacheWriteTokens: 0,
        outputTokens: 80,
        reasoningTokens: 120,
        totalTokens: 1700,
      });
    }

    // Tool ACTIVE + DONE with PascalCase Path
    const toolActive = adapter.feedLine(
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "agy-conv-1",
          step_index: 2,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "read_file",
          tool_info: { name: "read_file", parameters: { Path: "/repo/src/app.ts" } },
        },
      }),
    );
    const tStart = toolActive.events[0];
    expect(tStart?.type).toBe("tool.start");
    if (tStart?.type === "tool.start") {
      expect(tStart.category).toBe("read");
      expect(tStart.summary).toBe("/repo/src/app.ts");
      expect(tStart.filesTouched).toContain("/repo/src/app.ts");
    }

    const toolDone = adapter.feedLine(
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "agy-conv-1",
          step_index: 2,
          state: "DONE",
          step_type: "tool",
          tool_name: "read_file",
          duration_seconds: 0.42,
          tool_info: { name: "read_file", parameters: { Path: "/repo/src/app.ts" }, output: "20 lines" },
        },
      }),
    );
    const tEnd = toolDone.events[0];
    expect(tEnd?.type).toBe("tool.end");
    if (tEnd?.type === "tool.end") {
      expect(tEnd.durationMs).toBe(420);
      expect(tEnd.output).toBe("20 lines");
      expect(tEnd.isError).toBeUndefined();
    }

    // Duplicate DONE for the same tool step_index is ignored idempotently
    const dupToolDone = adapter.feedLine(
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "agy-conv-1",
          step_index: 2,
          state: "DONE",
          step_type: "tool",
          tool_name: "read_file",
          duration_seconds: 0.42,
          tool_info: { name: "read_file", parameters: { Path: "/repo/src/app.ts" }, output: "20 lines" },
        },
      }),
    );
    expect(dupToolDone.events).toEqual([]);

    // Tool with CommandLine running wb verify + ERROR state
    adapter.feedLine(
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "agy-conv-1",
          step_index: 3,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: { name: "run_command", parameters: { CommandLine: "wb verify REQ-001 --all" } },
        },
      }),
    );
    const toolErr = adapter.feedLine(
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "agy-conv-1",
          step_index: 3,
          state: "ERROR",
          step_type: "tool",
          tool_name: "run_command",
          duration_seconds: 1.1,
          tool_info: {
            name: "run_command",
            parameters: { CommandLine: "wb verify REQ-001 --all" },
            error: { type: "TOOL_ERROR", message: "exit code 1" },
          },
        },
      }),
    );
    const tErrEnd = toolErr.events[0];
    expect(tErrEnd?.type).toBe("tool.end");
    if (tErrEnd?.type === "tool.end") {
      expect(tErrEnd.category).toBe("wb_cli");
      expect(tErrEnd.wbCommand).toBe("wb verify");
      expect(tErrEnd.isError).toBe(true);
      expect(tErrEnd.output).toContain("TOOL_ERROR: exit code 1");
    }

    // Streaming text_delta & thinking_delta chunks emit real-time UI deltas and coalesce on DONE
    const dThink = adapter.feedLine(
      JSON.stringify({
        event: "step_update",
        step_update: { conversation_id: "agy-conv-1", step_index: 4, state: "ACTIVE", step_type: "agent_response", thinking_delta: "先核对结果" },
      }),
    );
    expect(dThink.events).toEqual([]);
    expect(dThink.thinkingDelta).toBe("先核对结果");

    const d1 = adapter.feedLine(
      JSON.stringify({
        event: "step_update",
        step_update: { conversation_id: "agy-conv-1", step_index: 4, state: "ACTIVE", step_type: "agent_response", text_delta: "已完成 " },
      }),
    );
    expect(d1.events).toEqual([]);
    expect(d1.textDelta).toBe("已完成 ");
    const d2 = adapter.feedLine(
      JSON.stringify({
        event: "step_update",
        step_update: { conversation_id: "agy-conv-1", step_index: 4, state: "ACTIVE", step_type: "agent_response", text_delta: "全部修改。" },
      }),
    );
    expect(d2.textDelta).toBe("全部修改。");
    const dDone = adapter.feedLine(
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "agy-conv-1",
          step_index: 4,
          state: "DONE",
          step_type: "agent_response",
          duration_seconds: 1.8,
          usage: { input_tokens: 1200, output_tokens: 150, thinking_tokens: 50, cache_read_tokens: 800, total_tokens: 1350 },
        },
      }),
    );
    const msgEv = dDone.events.find((e) => e.type === "assistant.message");
    expect(msgEv?.type).toBe("assistant.message");
    if (msgEv?.type === "assistant.message") {
      expect(msgEv.text).toBe("已完成 全部修改。");
    }
    expect(dDone.replyText).toBe("已完成 全部修改。");

    // Result envelope does not duplicate already-emitted reply and keeps multi-step turnsCount
    const res = adapter.feedLine(
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "agy-conv-1",
          status: "SUCCESS",
          response: "已完成 全部修改。",
          duration_seconds: 6.2,
          num_turns: 1,
          usage: { input_tokens: 2200, output_tokens: 350, thinking_tokens: 170, cache_read_tokens: 1300, total_tokens: 2550 },
        },
      }),
    );
    expect(res.events).toEqual([]);
    expect(res.replyText).toBeNull();
    expect(res.authoritativeTurnsCount).toBe(2);
    expect(res.authoritativeUsage).toEqual({
      inputTokens: 3500,
      uncachedInputTokens: 2200,
      cacheReadTokens: 1300,
      cacheWriteTokens: 0,
      outputTokens: 180,
      reasoningTokens: 170,
      totalTokens: 3850,
    });
  });
});
