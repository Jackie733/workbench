import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConsoleOutput } from "../../src/web/components/ConsoleOutput.tsx";
import { parseConsoleLog, stripAnsi } from "../../src/web/lib/consoleFormat.ts";

describe("stripAnsi", () => {
  test("removes CSI/OSC escape codes and normalizes CRLF", () => {
    const raw = "\x1b[32mOK\x1b[0m\r\n\x1b]0;title\x07line2\rline3";
    expect(stripAnsi(raw)).toBe("OK\nline2\nline3");
  });
});

describe("parseConsoleLog", () => {
  test("returns empty list for empty or whitespace logs", () => {
    expect(parseConsoleLog("")).toEqual([]);
    expect(parseConsoleLog("   \n\t  ")).toEqual([]);
  });

  test("parses Codex CLI session logs into primary and collapsible secondary blocks", () => {
    const longOutput = Array.from({ length: 10 }, (_, idx) => `file-${idx + 1}.ts`).join("\n");
    const codexLog = [
      "$ /usr/local/bin/codex exec -C /repo --dangerously-bypass-approvals-and-sandbox (model=gpt-5.4, effort=medium)",
      "Reading additional input from stdin...",
      "OpenAI Codex v0.114.0 (research preview)",
      "--------",
      "workdir: /repo",
      "model: gpt-5.4",
      "session id: sess-123",
      "--------",
      "user",
      "请接力执行工作台需求 REQ-004（可用命令行 `wb` 工具操作）。",
      "```text",
      "hook: inside-fenced-handoff",
      "```",
      "mcp startup: ready",
      "hook: SessionStart",
      "hook: UserPromptSubmit",
      "WARN rmcp::transport::worker: Worker quit with fatal: Transport channel closed",
      "thinking",
      "先排查样式表和抽屉组件。",
      "再设计结构化日志解析器。",
      "exec",
      "/bin/bash -lc 'ls src/web' in /repo succeeded in 42ms:",
      longOutput,
      "exec",
      "/bin/bash -lc 'bun test' in /repo exited 1 in 1.25s:",
      "Error: assertion failed at test.ts:10",
      "codex",
      "已完成终端优化与验证。",
      "",
      "```ts",
      "const ok = true;",
      "```",
      "tokens used",
      "12,480",
    ].join("\n");

    const blocks = parseConsoleLog(codexLog);
    expect(blocks.map((b) => b.kind)).toEqual([
      "command_env",
      "prompt_context",
      "lifecycle_noise",
      "thinking",
      "tool_call",
      "tool_call",
      "message",
      "status",
    ]);

    const [cmdEnv, promptCtx, noise, thinking, longExec, failedExec, reply, tokens] = blocks;
    expect(cmdEnv!.defaultCollapsed).toBe(true);
    expect(cmdEnv!.summary).toContain("codex exec");
    expect(cmdEnv!.summary).toContain("model=gpt-5.4");

    expect(promptCtx!.defaultCollapsed).toBe(true);
    expect(promptCtx!.content).toContain("hook: inside-fenced-handoff");

    expect(noise!.defaultCollapsed).toBe(true);
    expect(noise!.meta?.itemCount).toBe(4);

    expect(thinking!.defaultCollapsed).toBe(true);
    expect(thinking!.content).toContain("先排查样式表");

    expect(longExec!.defaultCollapsed).toBe(true);
    expect(longExec!.tone).toBe("info");
    expect(longExec!.summary).toContain("成功 (42ms)");

    expect(failedExec!.defaultCollapsed).toBe(false);
    expect(failedExec!.tone).toBe("danger");
    expect(failedExec!.content).toContain("Error: assertion failed");

    expect(reply!.defaultCollapsed).toBe(false);
    expect(reply!.content).toContain("已完成终端优化与验证");
    expect(reply!.content).toContain("const ok = true;");

    expect(tokens!.defaultCollapsed).toBe(false);
    expect(tokens!.content).toBe("tokens used: 12,480");
  });

  test("parses QoderCN stream lines, fallback warning, and pretty-prints JSON errors", () => {
    const qoderLog = [
      "$ qodercn -p -o stream-json --dangerously-skip-permissions -m DeepSeek-V4-Pro",
      "\u26a1 Qoder 引擎已就绪 (model: auto \u26a0\ufe0f 请求模型 DeepSeek-V4-Pro 不可用，已自动回退为 auto)",
      "\ud83d\udcad 需要检查 RightDrawer 的日志加载逻辑",
      "\ud83d\udd27 调用工具: Read (/repo/src/web/components/RightDrawer.tsx)",
      "我是正文回复内容。",
      "\u2713 执行完成 (耗时 3.4s)",
      '\u274c API error: 429 RESOURCE_EXHAUSTED {"error":{"code":429,"message":"Quota exceeded"}}',
    ].join("\n");

    const blocks = parseConsoleLog(qoderLog);
    expect(blocks.map((b) => b.kind)).toEqual([
      "command_env",
      "status",
      "thinking",
      "tool_call",
      "message",
      "status",
      "error",
    ]);

    expect(blocks[1]!.tone).toBe("warning");
    expect(blocks[2]!.defaultCollapsed).toBe(true);
    expect(blocks[3]!.collapsible).toBe(false);
    expect(blocks[4]!.defaultCollapsed).toBe(false);
    expect(blocks[5]!.tone).toBe("success");
    expect(blocks[6]!.tone).toBe("danger");
    expect(blocks[6]!.defaultCollapsed).toBe(false);
    expect(blocks[6]!.content).toContain('"code": 429');
  });

  test("preserves block IDs across incremental streaming appends", () => {
    const part1 = [
      "$ exec-mock",
      "hook: SessionStart",
      "thinking",
      "分析上下文",
    ].join("\n");
    const part2 = `${part1}\ncodex\n最终回复`;

    const first = parseConsoleLog(part1);
    const second = parseConsoleLog(part2);

    expect(second.slice(0, first.length).map((b) => b.id)).toEqual(first.map((b) => b.id));
    expect(second[second.length - 1]!.kind).toBe("message");
    expect(second[second.length - 1]!.content).toBe("最终回复");
  });

  test("keeps plain stdout lines expanded for CLI and E2E compatibility", () => {
    const blocks = parseConsoleLog("$ exec-mock\nmodel run finished ok\n");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.kind).toBe("command_env");
    expect(blocks[0]!.defaultCollapsed).toBe(true);
    expect(blocks[1]!.kind).toBe("message");
    expect(blocks[1]!.defaultCollapsed).toBe(false);
    expect(blocks[1]!.content).toBe("model run finished ok");
  });
});

describe("ConsoleOutput SSR rendering", () => {
  test("renders console-log-output container with collapsed secondary blocks and expanded primary output", () => {
    const log = [
      "$ codex exec (model=gpt-5.4)",
      "user",
      "请接力执行工作台需求 REQ-004",
      "hook: SessionStart",
      "codex",
      "核心正文输出 `inlineCode`",
      "[spawn error] ENOENT",
    ].join("\n");

    const html = renderToStaticMarkup(createElement(ConsoleOutput, { runId: "RUN-1", rawLog: log, isRunning: false }));
    expect(html).toContain('data-testid="console-log-output"');
    expect(html).toContain('data-testid="console-mode-structured"');
    expect(html).toContain('data-testid="console-mode-raw"');
    expect(html).toContain('data-testid="console-toggle-secondary-btn"');
    expect(html).toContain('data-testid="console-copy-btn"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("核心正文输出");
    expect(html).toContain('<code class="console-inline-code">inlineCode</code>');
    expect(html).toContain("[spawn error] ENOENT");
  });
});
