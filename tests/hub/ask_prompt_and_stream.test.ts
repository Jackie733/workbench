import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequirement, getRequirement, initProject } from "../../src/core/engine.ts";
import { driveCodexAppServerProcess } from "../../src/hub/codex_app_server.ts";
import { HubExecutor } from "../../src/hub/executor.ts";
import { synthesizeHandoffPacket } from "../../src/hub/handoff.ts";
import { buildHarnessCommand } from "../../src/hub/harness_cmd.ts";
import { driveOpencodeAcpProcess } from "../../src/hub/opencode_acp.ts";
import { buildExecutionPrompt } from "../../src/hub/prompt.ts";
import { buildInitialProjectRouting } from "../../src/hub/routing.ts";
import { createHarnessStreamAdapter, isUnsupportedJsonFlagError } from "../../src/hub/stream_adapters.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Ask prompt hygiene & OpenCode ACP streaming", () => {
  test("ask prompt for casual greeting stays compact, skips playbook/mandatory read directives, and adapts depth to intent", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wb-ask-prompt-"));
    tempDirs.push(repo);

    await initProject(repo, { name: "AskHygiene", privacyMode: "local" });
    fs.writeFileSync(
      path.join(repo, ".workbench", "playbook.md"),
      "# Playbook\n- [避坑 · REQ-008] 无关的历史经验教训条目\n",
      "utf8",
    );
    await createRequirement(repo, {
      goal: "优化中间界面显示的“正在加载需求详情”的UI样式和动画效果。",
    });

    const packet = await synthesizeHandoffPacket(repo, "REQ-001", {
      action: "ask",
      humanInstruction: "hi",
    });

    expect(packet.markdown).not.toContain("请用原生工具直接读取全文");
    expect(packet.markdown).not.toContain("无关的历史经验教训条目");
    expect(packet.markdown).not.toContain("本次执行特别嘱咐");

    const prompt = buildExecutionPrompt(
      packet.detail,
      packet.markdown,
      { action: "ask", message: "hi", anchor: "design.md#概述" },
      { outputLanguage: "zh-CN" },
    );

    expect(prompt).toContain("按问题意图自适应回答深度与工具调用");
    expect(prompt).toContain("不要主动读取文件");
    expect(prompt).toContain("handoff.md");
    expect(prompt).toContain("提问锚点：design.md#概述");
    expect(prompt).toContain("用户问题：hi");
    expect(prompt).not.toContain("请用原生工具直接读取全文");
    expect(prompt).not.toContain("无关的历史经验教训条目");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(1500);
  });

  test("driveOpencodeAcpProcess streams thinking/text deltas in real time, handles permissions, and falls back from expired resume", async () => {
    const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-acp-mock-"));
    tempDirs.push(scriptDir);
    const mockScript = path.join(scriptDir, "mock-acp.mjs");
    fs.writeFileSync(
      mockScript,
      `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const permOutcomes = {};
const configSets = [];

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id !== undefined && !msg.method) {
    permOutcomes[msg.id] = msg.result?.outcome?.outcome ?? null;
    return;
  }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
  } else if (msg.method === "session/resume") {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32001, message: "session expired" } });
  } else if (msg.method === "session/new") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: "ses_new_123",
        configOptions: [
          { id: "model", category: "model", type: "select", currentValue: "opencode/big-pickle" },
          {
            id: "reasoning_effort",
            category: "reasoning",
            type: "select",
            currentValue: "low",
            options: [{ value: "low" }, { value: "high" }],
          },
        ],
      },
    });
  } else if (msg.method === "session/set_config_option") {
    configSets.push(msg.params.configId + "=" + msg.params.value);
    send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [] } });
  } else if (msg.method === "session/prompt") {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "ses_new_123", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "思考片段" } } },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "ses_new_123", update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "read", kind: "read", rawInput: { path: "README.md" } } },
    });
    send({
      jsonrpc: "2.0",
      id: 901,
      method: "session/request_permission",
      params: {
        sessionId: "ses_new_123",
        toolCall: { toolCallId: "tc-2", title: "edit", kind: "edit" },
        options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }],
      },
    });
    send({
      jsonrpc: "2.0",
      id: 902,
      method: "session/request_permission",
      params: {
        sessionId: "ses_new_123",
        toolCall: { toolCallId: "tc-3", title: "bash", kind: "execute" },
        options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }],
      },
    });
    send({
      jsonrpc: "2.0",
      id: 903,
      method: "session/request_permission",
      params: {
        sessionId: "ses_new_123",
        toolCall: { toolCallId: "tc-4", title: "read", kind: "read" },
        options: [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }],
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "ses_new_123", update: { sessionUpdate: "usage_update", used: 95 } },
    });
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "ses_new_123", update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed", rawOutput: "ok" } },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "ses_new_123", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "你好，" } } },
      });
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "ses_new_123",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "世界！|" + permOutcomes[901] + "," + permOutcomes[902] + "," + permOutcomes[903] + "|" + configSets.join(","),
              },
            },
          },
        });
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { stopReason: "end_turn", usage: { totalTokens: 120, inputTokens: 100, outputTokens: 20 } },
        });
      }, 25);
    }, 25);
  }
});
`,
      "utf8",
    );

    const child = spawn(process.execPath, [mockScript], {
      cwd: scriptDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const deltas: Array<{ channel: string; delta: string; at: number }> = [];
    const traceEvents: string[] = [];
    let resolvedSessionId = "";
    let finalReply = "";
    let usageTokens = 0;

    const handle = driveOpencodeAcpProcess(child, {
      cwd: scriptDir,
      prompt: "hi",
      model: "opencode-go/deepseek-v4.1-flash",
      reasoningEffort: "high",
      resumedSessionId: "ses_expired",
      readOnly: true,
      onSessionId: (sid) => {
        resolvedSessionId = sid;
      },
      onDelta: (channel, delta) => {
        deltas.push({ channel, delta, at: Date.now() });
      },
      onTraceEvent: (ev) => {
        traceEvents.push(ev.type);
      },
      onUsage: (usage) => {
        usageTokens = usage.totalTokens;
      },
      onReplyText: (text) => {
        finalReply = text;
      },
    });

    const result = await handle.done;
    child.kill();

    expect(result.exitCode).toBe(0);
    expect(resolvedSessionId).toBe("ses_new_123");
    expect(finalReply).toBe(
      "你好，世界！|cancelled,cancelled,selected|model=opencode-go/deepseek-v4.1-flash,reasoning_effort=high",
    );
    expect(usageTokens).toBe(120);
    expect(deltas.map((d) => `${d.channel}:${d.delta}`)).toEqual([
      "thinking:思考片段",
      "text:你好，",
      "text:世界！|cancelled,cancelled,selected|model=opencode-go/deepseek-v4.1-flash,reasoning_effort=high",
    ]);
    // Verify incremental streaming actually happened across separate ticks before completion
    expect(deltas[2]!.at - deltas[1]!.at).toBeGreaterThanOrEqual(15);
    expect(traceEvents.filter((t) => t === "turn.start")).toHaveLength(1);
    expect(traceEvents.filter((t) => t === "turn.end")).toHaveLength(1);
    expect(traceEvents).toContain("tool.start");
    expect(traceEvents).toContain("tool.end");
    expect(traceEvents).toContain("assistant.message");
  });

  test("OpencodeStreamAdapter handles message.part.delta and text_delta when emitted", () => {
    const adapter = createHarnessStreamAdapter("opencode", "opencode-go/deepseek-v4.1-flash", true);
    const d1 = adapter.feedLine(
      JSON.stringify({
        type: "message.part.delta",
        sessionID: "ses-1",
        properties: { field: "reasoning", delta: "分析中" },
      }),
    );
    expect(d1.thinkingDelta).toBe("分析中");
    const d2 = adapter.feedLine(
      JSON.stringify({
        type: "message.part.delta",
        sessionID: "ses-1",
        properties: { field: "text", delta: "结果" },
      }),
    );
    expect(d2.textDelta).toBe("结果");
  });

  test("qodercn ask enables --include-partial-messages, handles unsupported flag fallback, and streams stream_event deltas", () => {
    const askCmd = buildHarnessCommand(
      { harness: "qodercn", model: "Qwen4-Max" },
      { root: process.cwd(), action: "ask", prompt: "hi", harnesses: [] },
    );
    expect(askCmd.args).toContain("-o");
    expect(askCmd.args).toContain("stream-json");
    expect(askCmd.args).toContain("--include-partial-messages");

    const implCmd = buildHarnessCommand(
      { harness: "qodercn", model: "Qwen4-Max" },
      { root: process.cwd(), action: "implement", prompt: "do", harnesses: [] },
    );
    expect(implCmd.args).not.toContain("--include-partial-messages");

    expect(isUnsupportedJsonFlagError("error: unknown option '--include-partial-messages'")).toBe(true);

    const adapter = createHarnessStreamAdapter("qodercn", "Qwen4-Max", true);
    const thinkDelta = adapter.feedLine(
      JSON.stringify({
        type: "stream_event",
        session_id: "q-1",
        event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "思考中" } },
      }),
    );
    expect(thinkDelta.thinkingDelta).toBe("思考中");

    const textDelta = adapter.feedLine(
      JSON.stringify({
        type: "stream_event",
        session_id: "q-1",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "你好" } },
      }),
    );
    expect(textDelta.textDelta).toBe("你好");
  });

  test("driveCodexAppServerProcess streams reasoning/text deltas in real time, falls back from expired resume, normalizes tokens, and declines write approvals in readOnly", async () => {
    const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-codex-app-mock-"));
    tempDirs.push(scriptDir);
    const mockScript = path.join(scriptDir, "mock-codex-app.mjs");
    fs.writeFileSync(
      mockScript,
      `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
let approvalDecision = null;

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id !== undefined && !msg.method) {
    approvalDecision = msg.result?.decision ?? null;
    return;
  }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { userAgent: "codex-mock" } });
  } else if (msg.method === "thread/resume") {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32001, message: "thread not found" } });
  } else if (msg.method === "thread/start") {
    send({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "thr_new_456" }, model: "gpt-6.2-sol", modelProvider: "openai", cwd: process.cwd(), approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "readOnly" } } });
  } else if (msg.method === "turn/start") {
    send({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: "turn_1", status: "inProgress", items: [], error: null } } });
    send({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thr_new_456", turn: { id: "turn_1", status: "inProgress", items: [], error: null } } });
    send({ jsonrpc: "2.0", method: "item/reasoning/summaryTextDelta", params: { threadId: "thr_new_456", turnId: "turn_1", itemId: "rs_1", summaryIndex: 0, delta: "正在推理" } });
    send({ jsonrpc: "2.0", method: "item/started", params: { threadId: "thr_new_456", turnId: "turn_1", startedAtMs: Date.now(), item: { id: "cmd_1", type: "commandExecution", command: "ls -la", cwd: process.cwd(), processId: "1", status: "inProgress", commandActions: [] } } });
    send({ jsonrpc: "2.0", id: 88, method: "item/fileChange/requestApproval", params: { threadId: "thr_new_456", turnId: "turn_1", itemId: "fc_1" } });
    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thr_new_456", turnId: "turn_1", completedAtMs: Date.now(), item: { id: "cmd_1", type: "commandExecution", command: "ls -la", cwd: process.cwd(), processId: "1", status: "completed", commandActions: [], aggregatedOutput: "README.md", exitCode: 0, durationMs: 12 } } });
      send({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thr_new_456", turnId: "turn_1", completedAtMs: Date.now(), item: { id: "rs_1", type: "reasoning", summary: ["正在推理"], content: [] } } });
      send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "thr_new_456", turnId: "turn_1", itemId: "msg_1", delta: "第一段：" } });
      setTimeout(() => {
        send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "thr_new_456", turnId: "turn_1", itemId: "msg_1", delta: "approval=" + approvalDecision } });
        send({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thr_new_456", turnId: "turn_1", completedAtMs: Date.now(), item: { id: "msg_1", type: "agentMessage", text: "第一段：approval=" + approvalDecision } } });
        send({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: { threadId: "thr_new_456", turnId: "turn_1", tokenUsage: { total: { inputTokens: 1000, cachedInputTokens: 600, outputTokens: 50, reasoningOutputTokens: 20, totalTokens: 1070 }, last: { inputTokens: 500, cachedInputTokens: 300, outputTokens: 50, reasoningOutputTokens: 20, totalTokens: 570 } } } });
        send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thr_new_456", turn: { id: "turn_1", status: "completed", items: [], error: null } } });
      }, 25);
    }, 25);
  }
});
`,
      "utf8",
    );

    const child = spawn(process.execPath, [mockScript], {
      cwd: scriptDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const deltas: Array<{ channel: string; delta: string; at: number }> = [];
    const traceEvents: string[] = [];
    let resolvedThreadId = "";
    let finalReply = "";
    let capturedUsage: import("../../src/core/types.ts").RunTokenUsage | undefined;

    const handle = driveCodexAppServerProcess(child, {
      cwd: scriptDir,
      prompt: "hi",
      model: "gpt-6.2-sol",
      reasoningEffort: "medium",
      resumedSessionId: "thr_expired",
      readOnly: true,
      onSessionId: (sid) => {
        resolvedThreadId = sid;
      },
      onDelta: (channel, delta) => {
        deltas.push({ channel, delta, at: Date.now() });
      },
      onTraceEvent: (ev) => {
        traceEvents.push(ev.type);
      },
      onUsage: (usage) => {
        capturedUsage = usage;
      },
      onReplyText: (text) => {
        finalReply = text;
      },
    });

    const result = await handle.done;
    child.kill();

    expect(result.exitCode).toBe(0);
    expect(resolvedThreadId).toBe("thr_new_456");
    expect(finalReply).toBe("第一段：approval=decline");
    expect(capturedUsage).toEqual({
      inputTokens: 1000,
      uncachedInputTokens: 400,
      cacheReadTokens: 600,
      cacheWriteTokens: 0,
      outputTokens: 50,
      reasoningTokens: 20,
      totalTokens: 1070,
    });
    expect(deltas.map((d) => `${d.channel}:${d.delta}`)).toEqual([
      "thinking:正在推理",
      "text:第一段：",
      "text:approval=decline",
    ]);
    expect(deltas[2]!.at - deltas[1]!.at).toBeGreaterThanOrEqual(15);
    expect(traceEvents).toContain("tool.start");
    expect(traceEvents).toContain("tool.end");
    expect(traceEvents).toContain("thinking");
    expect(traceEvents).toContain("assistant.message");
    expect(traceEvents).toContain("turn.end");
  });

  test("CodexStreamAdapter routes item.updated reasoning delta to thinkingDelta and HubExecutor falls back cleanly when app-server is unsupported", async () => {
    const adapter = createHarnessStreamAdapter("codex", "gpt-5.4", true);
    const thinkRes = adapter.feedLine(
      JSON.stringify({
        type: "item.updated",
        item: { type: "reasoning", delta: "推理片段" },
      }),
    );
    expect(thinkRes.thinkingDelta).toBe("推理片段");
    expect(thinkRes.textDelta).toBeUndefined();

    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wb-rpc-fallback-"));
    tempDirs.push(repo);
    await initProject(repo, { name: "RpcFallback", privacyMode: "local", routing: buildInitialProjectRouting() });
    await createRequirement(repo, { goal: "测试不支持 app-server 时自动降级" });

    const fakeCodex = path.join(repo, ".mock-old-codex.sh");
    fs.writeFileSync(
      fakeCodex,
      `#!/usr/bin/env bash
if [ "$1" = "app-server" ]; then
  echo "error: unrecognized subcommand 'app-server'" >&2
  exit 2
fi
echo '{"type":"turn.started"}'
echo '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"EXEC_FALLBACK_OK"}}'
echo '{"type":"turn.completed"}'
`,
      { mode: 0o755 },
    );

    const executor = new HubExecutor({
      initialHarnesses: [
        {
          id: "codex",
          label: "Codex",
          subscription: "Plus",
          installed: true,
          executable: fakeCodex,
          models: [{ id: "gpt-5.4", label: "GPT-5.4", tier: "balanced", source: "detected" }],
          defaultModel: "gpt-5.4",
          detectedAt: Date.now(),
        },
      ],
    });

    const finishedStatuses: string[] = [];
    const donePromise = new Promise<void>((resolve) => {
      const unsub = executor.subscribe((ev) => {
        if (ev.type === "agent.run.finished") {
          finishedStatuses.push(String(ev.status));
          if (ev.status === "succeeded") {
            unsub();
            resolve();
          }
        }
      });
    });

    await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "ask",
      harness: "codex",
      model: "gpt-5.4",
      message: "ping",
    });

    await donePromise;
    expect(finishedStatuses).toEqual(["failed", "succeeded"]);
    const detail = getRequirement(repo, "REQ-001");
    expect(detail.state.agentRuns).toHaveLength(2);
    expect(detail.state.discussions?.some((d) => d.actor === "agent" && d.message.includes("EXEC_FALLBACK_OK"))).toBe(
      true,
    );
  });
});
