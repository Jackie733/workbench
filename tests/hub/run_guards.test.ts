import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { approveDesign, createRequirement, getRequirement, initProject, propose } from "../../src/core/engine.ts";
import {
  isModelCoolingDown,
  readModelTelemetry,
} from "../../src/hub/telemetry.ts";
import { HubExecutor } from "../../src/hub/executor.ts";
import type { HarnessInfo } from "../../src/hub/types.ts";

const tempDirs: string[] = [];
const origHubEnv = process.env.WORKBENCH_HUB_DIR;

function makeTempHub(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-guard-hub-"));
  tempDirs.push(dir);
  process.env.WORKBENCH_HUB_DIR = dir;
}

function makeGitRepo(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wb-guard-${name}-`));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "app.ts"), "export const v = 1;\n");
  execFileSync("git", ["add", "app.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function harness(id: HarnessInfo["id"], executable: string): HarnessInfo {
  return {
    id,
    label: id,
    subscription: id,
    installed: true,
    executable,
    models: [],
    defaultModel: null,
    detectedAt: Date.now(),
  };
}

function waitForRun(executor: HubExecutor, runId: string): Promise<void> {
  return new Promise((resolve) => {
    const unsub = executor.subscribe((ev) => {
      if (ev.type === "agent.run.finished" && ev.runId === runId) {
        unsub();
        resolve();
      }
    });
  });
}

afterEach(() => {
  if (origHubEnv === undefined) delete process.env.WORKBENCH_HUB_DIR;
  else process.env.WORKBENCH_HUB_DIR = origHubEnv;
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("execution guards", () => {
  test("rejects implement/fix before approval and keeps design runs out of the implementation contract", async () => {
    makeTempHub();
    const repo = makeGitRepo("approval");
    await initProject(repo, { name: "Approval", privacyMode: "local" });
    await createRequirement(repo, {
      goal: "验证审批前置门禁",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });

    const prompts: string[] = [];
    const executor = new HubExecutor({
      initialHarnesses: [harness("codex", "codex")],
      commandBuilder: (_target, ctx) => {
        prompts.push(ctx.prompt);
        return { command: "bash", args: ["-c", "echo ok"], displayCommand: "mock-ok" };
      },
    });

    await expect(
      executor.startRun({ root: repo, requirementId: "REQ-001", action: "implement", harness: "codex", model: "gpt-6-astra" }),
    ).rejects.toMatchObject({ code: "approval_required" });
    await expect(
      executor.startRun({ root: repo, requirementId: "REQ-001", action: "fix", harness: "codex", model: "gpt-6-astra" }),
    ).rejects.toMatchObject({ code: "approval_required" });

    const design = await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "design",
      harness: "codex",
      model: "gpt-6-astra",
    });
    await waitForRun(executor, design.run.id);
    expect(prompts[0]).toContain("设计阶段禁止修改业务代码或测试");
    expect(prompts[0]).toContain("提交方案后立即结束本轮");
    expect(prompts[0]).not.toContain("修改代码后请重新运行真实测试验证");

    await propose(repo, "REQ-001", { designMarkdown: "# Design" });
    await approveDesign(repo, "REQ-001");

    const implement = await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "implement",
      harness: "codex",
      model: "gpt-6-astra",
    });
    await waitForRun(executor, implement.run.id);
    expect(prompts[1]).toContain("修改代码后请重新运行真实测试验证");
    expect(getRequirement(repo, "REQ-001").state.agentRuns?.at(-1)?.status).toBe("succeeded");
  }, { timeout: 15000 });

  test("records a Qoder CLI model downgrade and cools the requested model down", async () => {
    makeTempHub();
    const repo = makeGitRepo("qoder-fallback");
    await initProject(repo, { name: "QoderFallback", privacyMode: "local" });
    await createRequirement(repo, { goal: "验证模型降级记录" });

    const executor = new HubExecutor({
      initialHarnesses: [harness("qodercn", "qodercn")],
      commandBuilder: () => ({
        command: "bash",
        args: [
          "-c",
          `printf '%s\\n' '{"type":"system","subtype":"init","model":"auto","session_id":"q-fallback-1"}'
           printf '%s\\n' '{"type":"assistant","session_id":"q-fallback-1","message":{"content":[{"type":"text","text":"已降级执行。"}]}}'
           printf '%s\\n' '{"type":"result","subtype":"success","duration_ms":10,"result":"已降级执行。","session_id":"q-fallback-1"}'`,
        ],
        displayCommand: "mock-qoder-fallback",
      }),
    });

    const started = await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "ask",
      harness: "qodercn",
      model: "DeepSeek-Flash",
      message: "测试降级",
    });
    await waitForRun(executor, started.run.id);

    const run = getRequirement(repo, "REQ-001").state.agentRuns?.at(-1);
    expect(run).toMatchObject({
      model: "DeepSeek-Flash",
      effectiveModel: "auto",
      modelFallback: true,
      status: "succeeded",
    });
    const stats = readModelTelemetry().entries["qodercn::DeepSeek-Flash::ask"];
    expect(stats?.degradedRuns).toBe(1);
    expect(stats?.succeededRuns).toBe(0);
    expect(isModelCoolingDown("qodercn", "DeepSeek-Flash")).toBe(true);
  }, { timeout: 15000 });

  test("uses the final structured review verdict instead of prompt or tool chatter", async () => {
    makeTempHub();
    const repo = makeGitRepo("review-parse");
    await initProject(repo, { name: "ReviewParse", privacyMode: "local" });
    await createRequirement(repo, { goal: "验证审查解析" });

    const executor = new HubExecutor({
      initialHarnesses: [harness("codex", "codex")],
      commandBuilder: () => ({
        command: "bash",
        args: [
          "-c",
          `printf '%s\\n' 'Reading additional input from stdin...'
           printf '%s\\n' 'block 只是工具输出里的关键词，不能作为结论。'
           printf '%s\\n' '最终结论：'
           printf '%s\\n' '\`\`\`json'
           printf '%s\\n' '{"verdict":"concern","summary":"仅剩一个与本需求无关的既有测试失败"}'
           printf '%s\\n' '\`\`\`'`,
        ],
        displayCommand: "mock-review-tail",
      }),
    });

    const started = await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "review",
      harness: "codex",
      model: "codex-auto-review",
    });
    await waitForRun(executor, started.run.id);

    const detail = getRequirement(repo, "REQ-001", { currentCodeSnapshotHash: null });
    expect(detail.state.reviewReport).toMatchObject({
      verdict: "concern",
      summary: "仅剩一个与本需求无关的既有测试失败",
    });
  }, { timeout: 15000 });

  test("fails a review run with no structured verdict instead of guessing pass", async () => {
    makeTempHub();
    const repo = makeGitRepo("review-missing");
    await initProject(repo, { name: "ReviewMissing", privacyMode: "local" });
    await createRequirement(repo, { goal: "验证无结构结论" });

    const executor = new HubExecutor({
      initialHarnesses: [harness("codex", "codex")],
      commandBuilder: () => ({
        command: "bash",
        args: ["-c", "echo '看起来没问题，建议通过。'"],
        displayCommand: "mock-review-plain",
      }),
    });

    const started = await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "review",
      harness: "codex",
      model: "codex-auto-review",
    });
    await waitForRun(executor, started.run.id);

    const detail = getRequirement(repo, "REQ-001");
    const run = detail.state.agentRuns?.at(-1);
    expect(run?.status).toBe("failed");
    expect(run?.errorSummary).toContain("结构化结论");
    expect(detail.state.reviewReport).toBeUndefined();
  }, { timeout: 15000 });
});