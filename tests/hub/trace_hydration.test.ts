import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createRequirement,
  getRequirement,
  initProject,
  startAgentRun,
  finishAgentRun,
} from "../../src/core/engine.ts";
import { MAX_RUN_TRACE_BYTES, WORKBENCH_DIR, type AgentRunRecord } from "../../src/core/types.ts";
import { HubExecutor } from "../../src/hub/executor.ts";
import { readRunLedger } from "../../src/hub/ledger.ts";
import { resolveModelSpec } from "../../src/hub/pricing.ts";
import { registerHubProject } from "../../src/hub/registry.ts";
import { buildInitialProjectRouting } from "../../src/hub/routing.ts";
import { createHarnessStreamAdapter } from "../../src/hub/stream_adapters.ts";
import { RunTraceCollector } from "../../src/hub/trace_collector.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";

const tempDirs: string[] = [];
const servers: WorkbenchServerHandle[] = [];
const origHubDir = process.env.WORKBENCH_HUB_DIR;

function makeTempHub(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-trace-hyd-hub-"));
  tempDirs.push(dir);
  process.env.WORKBENCH_HUB_DIR = dir;
  return dir;
}

function makeGitRepo(prefix = "trace-hyd"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wb-${prefix}-`));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "README.md"), "# Demo\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()!.stop();
  }
  if (origHubDir === undefined) delete process.env.WORKBENCH_HUB_DIR;
  else process.env.WORKBENCH_HUB_DIR = origHubDir;
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("structured trace hydration, 8MB soft cap, fast-fail fallback, legacy runs & pruning", () => {
  test("writes .events.jsonl + .context.json, supports ?afterSeq= catch-up, and serves legacy runs without trace cleanly", async () => {
    makeTempHub();
    const repo = makeGitRepo("e2e-hyd");
    await initProject(repo, { name: "HydrationRepo", privacyMode: "local", routing: buildInitialProjectRouting() });
    await createRequirement(repo, { goal: "测试结构化轨迹与增量恢复" });
    const reg = registerHubProject(repo, { name: "HydrationRepo" });

    const executor = new HubExecutor({
      initialHarnesses: [
        {
          id: "qodercn",
          label: "Qoder",
          subscription: "Pro",
          installed: true,
          executable: "qodercn",
          models: [{ id: "Qwen4-Max-Preview", label: "Qwen4", tier: "balanced", source: "detected" }],
          defaultModel: "Qwen4-Max-Preview",
          detectedAt: Date.now(),
        },
      ],
      commandBuilder: () => {
        const lines = [
          JSON.stringify({ type: "system", subtype: "init", session_id: "q-hyd-1", model: "Qwen4-Max-Preview" }),
          JSON.stringify({
            type: "assistant",
            session_id: "q-hyd-1",
            message: {
              content: [
                { type: "thinking", thinking: "分析仓储状态" },
                { type: "tool_use", id: "tc-1", name: "bash", input: { command: "echo hi" } },
              ],
            },
          }),
          JSON.stringify({
            type: "user",
            session_id: "q-hyd-1",
            message: { content: [{ type: "tool_result", tool_use_id: "tc-1", content: "hi" }] },
          }),
          JSON.stringify({
            type: "result",
            session_id: "q-hyd-1",
            result: "结构化执行完毕",
            duration_ms: 420,
            usage: { input_tokens: 500, cache_read_input_tokens: 1500, output_tokens: 200 },
          }),
        ];
        const script = lines.map((l) => `printf '%s\\n' ${JSON.stringify(l)}`).join("; ");
        return { command: "bash", args: ["-c", script], displayCommand: "mock-qoder-structured" };
      },
    });

    const srv = await startWorkbenchServer({ root: repo, port: 0, hubMode: true, executor });
    servers.push(srv);

    let finishedRunId = "";
    const donePromise = new Promise<void>((resolve) => {
      const unsub = executor.subscribe((ev) => {
        if (ev.type === "agent.run.finished") {
          finishedRunId = ev.runId;
          unsub();
          resolve();
        }
      });
    });

    const started = await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "design",
      harness: "qodercn",
      model: "Qwen4-Max-Preview",
    });
    await donePromise;
    expect(finishedRunId).toBe(started.run.id);

    const traceRes = (await (
      await fetch(`${srv.url}/api/requirements/REQ-001/runs/${started.run.id}/trace?project=${reg.project.id}`)
    ).json()) as { hasTrace: boolean; events: Array<{ seq: number; type: string }>; nextSeq: number };
    expect(traceRes.hasTrace).toBe(true);
    expect(traceRes.events.some((e) => e.type === "run.init")).toBe(true);
    expect(traceRes.events.some((e) => e.type === "handoff.snapshot")).toBe(true);
    expect(traceRes.events.some((e) => e.type === "tool.start")).toBe(true);
    expect(traceRes.events.some((e) => e.type === "tool.end")).toBe(true);
    expect(traceRes.events.some((e) => e.type === "run.end")).toBe(true);

    // Incremental catch-up returns only later events
    const firstSeq = traceRes.events[1]!.seq;
    const incRes = (await (
      await fetch(`${srv.url}/api/requirements/REQ-001/runs/${started.run.id}/trace?afterSeq=${firstSeq}&project=${reg.project.id}`)
    ).json()) as { events: Array<{ seq: number }> };
    expect(incRes.events.every((e) => e.seq > firstSeq)).toBe(true);
    expect(incRes.events.length).toBeLessThan(traceRes.events.length);

    const ctxRes = (await (
      await fetch(`${srv.url}/api/requirements/REQ-001/runs/${started.run.id}/context?project=${reg.project.id}`)
    ).json()) as { hasContext: boolean; context: { handoffMarkdown: string; sections: Array<{ key: string }> } | null };
    expect(ctxRes.hasContext).toBe(true);
    expect(ctxRes.context?.handoffMarkdown).toContain("REQ-001");
    expect(ctxRes.context?.sections.length).toBeGreaterThan(0);

    // Seed a legacy run without .events.jsonl and confirm graceful fallback
    const legacyId = "RUN-LEGACY-1";
    const legacyRecord: AgentRunRecord = {
      id: legacyId,
      action: "ask",
      harness: "codex",
      model: "gpt-5.4",
      status: "succeeded",
      startedAt: Date.now() - 5000,
      endedAt: Date.now() - 4000,
      exitCode: 0,
      durationMs: 1000,
      logPath: `runs/run-${legacyId}.log`,
    };
    await startAgentRun(repo, "REQ-001", legacyRecord);
    await finishAgentRun(
      repo,
      "REQ-001",
      legacyId,
      { status: "succeeded", endedAt: Date.now() - 4000, exitCode: 0, durationMs: 1000 },
      "Legacy plain terminal output\n",
    );
    const legacyTrace = (await (
      await fetch(`${srv.url}/api/requirements/REQ-001/runs/${legacyId}/trace?project=${reg.project.id}`)
    ).json()) as { hasTrace: boolean; events: unknown[] };
    expect(legacyTrace.hasTrace).toBe(false);
    expect(legacyTrace.events).toEqual([]);
    const legacyRaw = (await (
      await fetch(`${srv.url}/api/requirements/REQ-001/runs/${legacyId}?project=${reg.project.id}`)
    ).json()) as { log: string };
    expect(legacyRaw.log).toContain("Legacy plain terminal output");

    // Standalone local executor appends ledger when not overridden
    expect(readRunLedger().some((e) => e.runId === started.run.id)).toBe(true);
  }, { timeout: 15000 });

  test("enforces 8MB soft cap on trace files while keeping turn.end and run.end metrics accurate", () => {
    const dir = makeTempHub();
    const traceFile = path.join(dir, "run-cap.events.jsonl");
    const spec = resolveModelSpec("codex", "gpt-5.4");
    const collector = new RunTraceCollector({
      runId: "RUN-CAP",
      traceFilePath: traceFile,
      startedAt: Date.now() - 1000,
      billingMode: "subscription",
      quotaPool: "openai-codex",
      modelSpec: spec,
    });

    const chunk = "A".repeat(28 * 1024);
    for (let i = 0; i < 320; i += 1) {
      collector.append({
        type: "tool.end",
        turnIndex: 1,
        callId: `c-${i}`,
        toolName: "bash",
        category: "bash",
        summary: "dump",
        output: chunk,
        durationMs: 5,
      });
    }
    collector.append({
      type: "turn.end",
      turnIndex: 1,
      contextTokens: 12_000,
      usage: {
        inputTokens: 12_000,
        uncachedInputTokens: 2_000,
        cacheReadTokens: 10_000,
        cacheWriteTokens: 0,
        outputTokens: 600,
        reasoningTokens: 0,
        totalTokens: 12_600,
      },
    });
    const summary = collector.finalizeRun({
      status: "succeeded",
      exitCode: 0,
      durationMs: 2500,
    });
    expect(summary.traceTruncated).toBe(true);
    expect(summary.usage?.totalTokens).toBe(12_600);
    const stat = fs.statSync(traceFile);
    expect(stat.size).toBeLessThan(MAX_RUN_TRACE_BYTES + 200_000);
    const lines = fs.readFileSync(traceFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string });
    expect(lines.some((l) => l.type === "trace.truncated")).toBe(true);
    expect(lines.some((l) => l.type === "turn.end")).toBe(true);
    expect(lines[lines.length - 1]?.type).toBe("run.end");
  });

  test("fast-fail retries in plain-text mode when CLI rejects JSON flag (<5s)", async () => {
    makeTempHub();
    const repo = makeGitRepo("fast-fail");
    await initProject(repo, { name: "FastFail", privacyMode: "local", routing: buildInitialProjectRouting() });
    await createRequirement(repo, { goal: "测试 JSON 参数快速回退" });

    const fakeCli = path.join(repo, ".mock-codex.sh");
    fs.writeFileSync(
      fakeCli,
      `#!/usr/bin/env bash
for arg in "$@"; do
  if [ "$arg" = "--json" ]; then
    echo "error: unknown option '--json'" >&2
    exit 1
  fi
done
echo "PLAIN_RETRY_OK"
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
          executable: fakeCli,
          models: [{ id: "gpt-5.4", label: "GPT-5.4", tier: "balanced", source: "detected" }],
          defaultModel: "gpt-5.4",
          detectedAt: Date.now(),
        },
      ],
    });

    const finishedEvents: Array<{ runId: string; status?: string }> = [];
    const secondFinished = new Promise<void>((resolve) => {
      const unsub = executor.subscribe((ev) => {
        if (ev.type === "agent.run.finished") {
          finishedEvents.push({ runId: ev.runId, status: ev.status });
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

    await secondFinished;
    expect(finishedEvents.length).toBeGreaterThanOrEqual(2);
    expect(finishedEvents[0]?.status).toBe("failed");
    expect(finishedEvents.at(-1)?.status).toBe("succeeded");
    const runs = getRequirement(repo, "REQ-001").state.agentRuns ?? [];
    expect(runs.length).toBe(2);
    expect(executor.getLiveLog(runs[1]!.id)).toContain("PLAIN_RETRY_OK");
  }, { timeout: 15000 });

  test("prunes expired trace/context/log files while keeping run-*.json metadata intact", async () => {
    makeTempHub();
    const repo = makeGitRepo("prune-traces");
    await initProject(repo, { name: "PruneRepo", privacyMode: "local" });
    await createRequirement(repo, { goal: "清理过期重型轨迹" });
    const reg = registerHubProject(repo, { name: "PruneRepo" });

    const oldId = "RUN-OLD-1";
    const oldTs = Date.now() - 40 * 86_400_000;
    await startAgentRun(repo, "REQ-001", {
      id: oldId,
      action: "design",
      harness: "qodercn",
      model: "Qwen4-Max-Preview",
      status: "succeeded",
      startedAt: oldTs,
      endedAt: oldTs + 1000,
      exitCode: 0,
      durationMs: 1000,
      logPath: `runs/run-${oldId}.log`,
      tracePath: `runs/run-${oldId}.events.jsonl`,
      contextPath: `runs/run-${oldId}.context.json`,
    });
    await finishAgentRun(
      repo,
      "REQ-001",
      oldId,
      { status: "succeeded", endedAt: oldTs + 1000, exitCode: 0, durationMs: 1000 },
      "old log contents",
    );
    const runsDir = path.join(repo, WORKBENCH_DIR, "items", "REQ-001", "runs");
    fs.writeFileSync(path.join(runsDir, `run-${oldId}.events.jsonl`), '{"seq":1,"ts":1,"type":"run.error","message":"x"}\n');
    fs.writeFileSync(path.join(runsDir, `run-${oldId}.context.json`), '{"schemaVersion":1}\n');

    const srv = await startWorkbenchServer({ root: repo, port: 0, hubMode: true });
    servers.push(srv);

    const pruneRes = (await (
      await fetch(`${srv.url}/api/hub/insights/prune`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retentionDays: 30 }),
      })
    ).json()) as { deletedFiles: number; freedBytes: number };
    expect(pruneRes.deletedFiles).toBe(3); // .log, .events.jsonl, .context.json
    expect(pruneRes.freedBytes).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(runsDir, `run-${oldId}.json`))).toBe(true);
    expect(fs.existsSync(path.join(runsDir, `run-${oldId}.events.jsonl`))).toBe(false);
    expect(fs.existsSync(path.join(runsDir, `run-${oldId}.context.json`))).toBe(false);
    expect(fs.existsSync(path.join(runsDir, `run-${oldId}.log`))).toBe(false);
    expect(reg.project.id).toBeTruthy();
  });

  test("preserves back-to-back tool.end durationMs for OpenCode stream adapter", () => {
    const dir = makeTempHub();
    const traceFile = path.join(dir, "run-opencode-dur.events.jsonl");
    const collector = new RunTraceCollector({
      runId: "RUN-OC-DUR",
      traceFilePath: traceFile,
      startedAt: Date.now() - 8000,
      billingMode: "subscription",
      quotaPool: "opencode-go",
      modelSpec: resolveModelSpec("opencode", "opencode-go/deepseek-v4.1-flash"),
    });

    const adapter = createHarnessStreamAdapter("opencode", "opencode-go/deepseek-v4.1-flash", true);
    const parsed = adapter.feedLine(
      JSON.stringify({
        type: "tool_use",
        sessionID: "oc-dur",
        part: {
          callID: "oc-1",
          tool: "bash",
          state: {
            input: { command: "bun run test" },
            output: "ok",
            time: { start: 1000, end: 6200 },
          },
        },
      }),
    );
    for (const ev of parsed.events) collector.append(ev);

    const summary = collector.finalizeRun({ status: "succeeded", exitCode: 0, durationMs: 8000 });
    expect(summary.toolDurationMs).toBeGreaterThanOrEqual(5200);
    expect(summary.llmDurationMs).toBeLessThanOrEqual(2800);
  });
});
