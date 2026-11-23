import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  addDiscussion,
  approveDesign,
  authorizeFastTrack,
  createRequirement,
  getRequirement,
  initProject,
  propose,
  spawnSubRequirements,
  updateProjectConfig,
  updateTasks,
} from "../../src/core/engine.ts";
import { observeGitSnapshot } from "../../src/core/git.ts";
import { runVerification } from "../../src/core/runner.ts";
import { synthesizeHandoffPacket } from "../../src/hub/handoff.ts";
import {
  isModelCoolingDown,
  readModelTelemetry,
} from "../../src/hub/telemetry.ts";
import { buildExecutionPrompt, buildHarnessCommand, buildOpencodeNonInteractiveConfig, HubExecutor } from "../../src/hub/executor.ts";
import { buildPresetRouting, detectModelUnavailableError } from "../../src/hub/routing.ts";
import { executeWorkbenchTool } from "../../src/mcp/tools.ts";
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

  test("detects Model unavailable errors, cools down dead models, and auto-falls back once on auto-routed runs and auto-reviews", async () => {
    expect(detectModelUnavailableError("Error: Model unavailable: opencode-go/deepseek-v4.1-flash", 1)).toBe(true);
    expect(detectModelUnavailableError("Error: Model unavailable: x", 0)).toBe(false);

    makeTempHub();
    const repo = makeGitRepo("auto-fallback");
    await initProject(repo, { name: "AutoFallback", privacyMode: "local" });
    await createRequirement(repo, {
      goal: "验证不可用模型与自动审查的单次自动切备援",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design\nAuto fallback.", actor: "agent" });
    await approveDesign(repo, "REQ-001");

    const routing = buildPresetRouting("balanced");
    routing.autoReview = false;
    routing.stages.fix = {
      primary: { harness: "opencode", model: "opencode-go/deepseek-v4.1-flash" },
      fallbacks: [{ harness: "qodercn", model: "DeepSeek-Flash" }],
    };
    routing.stages.review = {
      primary: { harness: "qodercn", model: "Qwen4-Max-Preview" },
      fallbacks: [{ harness: "codex", model: "gpt-6.2-sol" }],
    };

    const seenTargets: string[] = [];
    let executor!: HubExecutor;
    const waitUntilRunsFinished = (minCount: number) =>
      new Promise<void>((resolve) => {
        const check = () => {
          const runs = getRequirement(repo, "REQ-001").state.agentRuns ?? [];
          if (runs.length >= minCount && runs.every((r) => r.status !== "running")) {
            unsub();
            resolve();
          }
        };
        const unsub = executor.subscribe((ev) => {
          if (ev.type === "agent.run.finished") check();
        });
        check();
      });

    executor = new HubExecutor({
      initialHarnesses: [harness("opencode", "opencode"), harness("qodercn", "qodercn"), harness("codex", "codex")],
      getHubPreferences: () => ({ routing }),
      commandBuilder: (target) => {
        seenTargets.push(`${target.harness}/${target.model}`);
        if (target.model === "opencode-go/deepseek-v4.1-flash") {
          return {
            command: "bash",
            args: ["-c", "echo 'Error: Model unavailable: opencode-go/deepseek-v4.1-flash' >&2; exit 1"],
            displayCommand: "mock-unavailable",
          };
        }
        if (target.model === "Qwen4-Max-Preview") {
          return {
            command: "bash",
            args: ["-c", "echo 'Waiting for background command...'; exit 0"],
            displayCommand: "mock-review-no-json",
          };
        }
        if (target.model === "gpt-6.2-sol") {
          return {
            command: "bash",
            args: [
              "-c",
              `printf '%s\\n' '\`\`\`json' '{"verdict":"pass","summary":"备援模型复审通过"}' '\`\`\`'`,
            ],
            displayCommand: "mock-review-pass",
          };
        }
        return { command: "bash", args: ["-c", "echo 'ok'"], displayCommand: "mock-fix-ok" };
      },
    });

    const fixDone = waitUntilRunsFinished(2);
    await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "fix",
      mode: "refine",
      message: "同步主干并解决冲突",
    });
    await fixDone;

    expect(seenTargets).toEqual(["opencode/opencode-go/deepseek-v4.1-flash", "qodercn/DeepSeek-Flash"]);
    expect(isModelCoolingDown("opencode", "opencode-go/deepseek-v4.1-flash")).toBe(true);
    const afterFix = getRequirement(repo, "REQ-001");
    expect(afterFix.state.agentRuns?.map((r) => r.status)).toEqual(["failed", "succeeded"]);
    expect(afterFix.state.agentRuns?.[0]?.errorSummary).toContain("模型不可用");
    expect(afterFix.state.discussions?.filter((d) => d.message === "同步主干并解决冲突")).toHaveLength(1);

    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const snap = (await observeGitSnapshot(repo))!;
    await updateTasks(repo, "REQ-001", {
      tasks: [{ title: "done", status: "done" }],
      readyForAcceptance: true,
      currentCodeSnapshotHash: snap.fingerprint,
    });

    const reviewDone = waitUntilRunsFinished(4);
    await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "review",
      isAutoReview: true,
    });
    await reviewDone;

    expect(seenTargets.slice(2)).toEqual(["qodercn/Qwen4-Max-Preview", "codex/gpt-6.2-sol"]);
    const afterReview = getRequirement(repo, "REQ-001", { currentCodeSnapshotHash: snap.fingerprint });
    expect(afterReview.state.reviewReport).toMatchObject({
      reviewerHarness: "codex",
      reviewerModel: "gpt-6.2-sol",
      verdict: "pass",
    });
  }, { timeout: 15000 });

  test("injects qodercn print-mode non-background guard and review evidence-reuse constraints", async () => {
    makeTempHub();
    const repo = makeGitRepo("qoder-guard");
    await initProject(repo, { name: "QoderGuard", privacyMode: "local" });
    const req = await createRequirement(repo, { goal: "校验非交互提示词" });

    const cmd = buildHarnessCommand(
      { harness: "qodercn", model: "Qwen4-Max-Preview" },
      { root: repo, action: "review", prompt: "review now", harnesses: [] },
    );
    const sysIdx = cmd.args.indexOf("--append-system-prompt");
    expect(sysIdx).toBeGreaterThanOrEqual(0);
    expect(cmd.args[sysIdx + 1]).toContain("run_in_background=true");
    expect(cmd.args[sysIdx + 1]).toContain("immediately exits the CLI");

    const reviewPrompt = buildExecutionPrompt(req, "# handoff", {
      root: repo,
      requirementId: "REQ-001",
      action: "review",
    });
    expect(reviewPrompt).toContain("禁止在后台运行命令");
    expect(reviewPrompt).toContain("优先复用匹配证据");
  });

  test("M1 session affinity: review session is never resumed by fix, while implement -> fix reuses same harness/session", async () => {
    makeTempHub();
    const repo = makeGitRepo("affinity");
    await initProject(repo, { name: "AffinityRepo", privacyMode: "local" });
    await createRequirement(repo, { goal: "保持读写会话隔离并复用编码会话" });
    await propose(repo, "REQ-001", {
      designMarkdown: "# Design\n\nWrite code.",
      criteria: [{ id: "AC-1", description: "passes", command: "echo ok", required: true }],
      actor: "agent",
    });
    await approveDesign(repo, "REQ-001");

    const routing = buildPresetRouting("balanced");
    routing.autoReview = false;
    routing.stages.implement = {
      primary: { harness: "qodercn", model: "Qwen4-Max-Preview" },
      fallbacks: [],
    };
    routing.stages.fix = {
      primary: { harness: "codex", model: "gpt-6.2-sol" },
      fallbacks: [],
    };
    routing.stages.review = {
      primary: { harness: "qodercn", model: "Qwen4-Max-Preview" },
      fallbacks: [],
    };

    const calls: Array<{
      action: string;
      harness: string;
      model: string;
      nativeSessionId: string | undefined;
      prompt: string;
    }> = [];
    let executor!: HubExecutor;
    const waitUntilCount = (n: number) =>
      new Promise<void>((resolve) => {
        const check = () => {
          const runs = getRequirement(repo, "REQ-001").state.agentRuns ?? [];
          if (runs.length >= n && runs.every((r) => r.status !== "running")) {
            unsub();
            resolve();
          }
        };
        const unsub = executor.subscribe((ev) => {
          if (ev.type === "agent.run.finished") check();
        });
        check();
      });

    executor = new HubExecutor({
      initialHarnesses: [harness("qodercn", "qodercn"), harness("codex", "codex")],
      getHubPreferences: () => ({ routing }),
      commandBuilder: (target, ctx) => {
        calls.push({
          action: ctx.action,
          harness: target.harness,
          model: target.model,
          nativeSessionId: ctx.nativeSessionId,
          prompt: ctx.prompt,
        });
        if (ctx.action === "review") {
          const reviewPayload = JSON.stringify({
            verdict: "concern",
            summary: "存在判空隐患",
            findings: [
              {
                id: "F-1",
                severity: "high",
                title: "缺少判空",
                files: ["src/app.ts"],
                detail: "param may be undefined",
                suggestion: "guard null before deref",
              },
            ],
          });
          return {
            command: "bash",
            args: [
              "-c",
              `printf 'session_id: sess-rev-222\\n\`\`\`json\\n%s\\n\`\`\`\\n' '${reviewPayload}'`,
            ],
            displayCommand: "mock-review",
          };
        }
        const sid = ctx.action === "implement" ? "sess-impl-111" : "sess-fix-333";
        return {
          command: "bash",
          args: ["-c", `printf 'session_id: %s\\nok\\n' '${sid}'`],
          displayCommand: `mock-${ctx.action}`,
        };
      },
    });

    const w1 = waitUntilCount(1);
    await executor.startRun({ root: repo, requirementId: "REQ-001", action: "implement" });
    await w1;

    // A read-only review runs on qodercn and emits sess-rev-222 + structured findings.
    const w2 = waitUntilCount(2);
    await executor.startRun({ root: repo, requirementId: "REQ-001", action: "review" });
    await w2;

    // Next fix must reuse qodercn (implement affinity), MUST NOT resume sess-rev-222,
    // and compact resume context must include finding file:line, detail, and suggestion.
    const w3 = waitUntilCount(3);
    await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "fix",
      mode: "refine",
      message: "微调报错提示",
    });
    await w3;

    expect(calls[0]!.harness).toBe("qodercn");
    expect(calls[2]!.harness).toBe("qodercn");
    expect(calls[2]!.nativeSessionId).not.toBe("sess-rev-222");
    expect(calls[2]!.nativeSessionId).toBe("sess-impl-111");
    expect(calls[2]!.prompt).toContain("src/app.ts");
    expect(calls[2]!.prompt).toContain("param may be undefined");
    expect(calls[2]!.prompt).toContain("guard null before deref");
  }, { timeout: 15000 });

  test("M1/M2/M3 handoff & prompt inject repo context/Q&A, strip Bun-specific boilerplate for Rust repos, and gate screenshots", async () => {
    makeTempHub();
    const repo = makeGitRepo("rust-context");
    fs.writeFileSync(path.join(repo, "AGENTS.md"), "# Workspace Rules\n\n## Core Invariants\nStrict typing.");
    fs.writeFileSync(path.join(repo, "Cargo.toml"), "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n");
    fs.mkdirSync(path.join(repo, "src", "web"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "web", "app.tsx"), "export const ui = 1;\n");

    await initProject(repo, { name: "RustDemo", privacyMode: "local" });
    await createRequirement(repo, { goal: "父架构设计" });
    await propose(repo, "REQ-001", {
      designMarkdown: "# Parent Architecture\n\n## Tasks\n- 拆分子模块 Rust Parser",
      criteria: [{ id: "AC-1", description: "cargo check", command: "cargo check", required: true }],
      actor: "agent",
    });
    const spawned = await spawnSubRequirements(repo, "REQ-001");
    const childId = spawned.created[0]!.state.id;

    await addDiscussion(repo, childId, {
      actor: "human",
      mode: "ask",
      message: "为什么用 nom 而不是 regex？",
    });
    await addDiscussion(repo, childId, {
      actor: "agent",
      mode: "ask",
      message: "nom 支持流式零拷贝解析。",
    });
    await updateProjectConfig(repo, { verification: { fastCommand: "echo cargo-ok", autoScreenshots: undefined } });
    await authorizeFastTrack(repo, childId);

    const { markdown, detail } = await synthesizeHandoffPacket(repo, childId, { action: "implement" });
    expect(markdown).toContain("REQ-001");
    expect(markdown).toContain("AGENTS.md");
    expect(markdown).toContain("echo cargo-ok");
    expect(markdown).toContain("为什么用 nom 而不是 regex");

    // Non-Bun repos must not receive hardcoded bun test / tsc / EROFS boilerplate; fast_track skips checklist bloat.
    const implPrompt = buildExecutionPrompt(detail, markdown, {
      root: repo,
      requirementId: childId,
      action: "implement",
    });
    expect(implPrompt).not.toContain("EROFS");
    expect(implPrompt).not.toContain("bun run typecheck");
    expect(implPrompt).not.toContain("wb_update_tasks` 记录实施清单");

    // Modified src/web file must NOT trigger auto screenshots when uiRelated !== true and autoScreenshots is unset.
    await runVerification(repo, childId, { command: "echo cargo-ok", criterionIds: ["AC-1"] });
    const toolRes = (await executeWorkbenchTool(repo, "wb_update_tasks", {
      id: childId,
      tasks: [{ title: "finish parser", status: "done" }],
      readyForAcceptance: true,
    })) as { screenshotCapture?: unknown };
    expect(toolRes.screenshotCapture).toBeUndefined();
  });

  test("M2 skips automatic autoReview on fast_track implement runs", async () => {
    makeTempHub();
    const repo = makeGitRepo("fast-no-autorev");
    await initProject(repo, { name: "FastTrackAutoRev", privacyMode: "local" });
    await createRequirement(repo, { goal: "快速修复文案" });
    await propose(repo, "REQ-001", {
      designMarkdown: "# Fast Plan",
      criteria: [{ id: "AC-1", description: "ok", command: "echo ok", required: true }],
      actor: "agent",
    });
    await authorizeFastTrack(repo, "REQ-001");

    const routing = buildPresetRouting("balanced");
    routing.autoReview = true;
    routing.stages.implement = {
      primary: { harness: "codex", model: "gpt-6.2-sol" },
      fallbacks: [],
    };
    routing.stages.review = {
      primary: { harness: "qodercn", model: "Qwen4-Max-Preview" },
      fallbacks: [],
    };

    const ranActions: string[] = [];
    const executor = new HubExecutor({
      initialHarnesses: [harness("codex", "codex"), harness("qodercn", "qodercn")],
      getHubPreferences: () => ({ routing }),
      commandBuilder: (_target, ctx) => {
        ranActions.push(ctx.action);
        return { command: "bash", args: ["-c", "echo done"], displayCommand: `mock-${ctx.action}` };
      },
    });

    const snap = (await observeGitSnapshot(repo))!;
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    await updateTasks(repo, "REQ-001", {
      tasks: [{ title: "quick change", status: "done" }],
      readyForAcceptance: true,
      currentCodeSnapshotHash: snap.fingerprint,
    });

    let finishedRunId = "";
    const done = new Promise<void>((resolve) => {
      const unsub = executor.subscribe((ev) => {
        if (ev.type === "agent.run.finished" && ev.runId === finishedRunId) {
          unsub();
          resolve();
        }
      });
    });
    const started = await executor.startRun({ root: repo, requirementId: "REQ-001", action: "implement" });
    finishedRunId = started.run.id;
    await done;
    await new Promise((r) => setTimeout(r, 150));

    expect(ranActions).toEqual(["implement"]);
  }, { timeout: 15000 });

  test("Phase 1: disables opencode websearch, upgrades non-fatal form cancel after ready submission, and drops resolved failures from handoff", async () => {
    const mergedCfg = JSON.parse(
      buildOpencodeNonInteractiveConfig('{"model":"opencode-go/deepseek-v4.1-flash","tools":{"bash":true}}'),
    ) as { model?: string; tools?: Record<string, boolean> };
    expect(mergedCfg.model).toBe("opencode-go/deepseek-v4.1-flash");
    expect(mergedCfg.tools).toEqual({ bash: true, websearch: false });

    makeTempHub();
    const repo = makeGitRepo("opencode-nonfatal");
    await initProject(repo, { name: "OpencodeNonFatal", privacyMode: "local" });
    await createRequirement(repo, { goal: "验证 OpenCode 延迟表单报错兜底与交接包清理" });
    await propose(repo, "REQ-001", {
      designMarkdown: "# Design\nClean.",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
      actor: "agent",
    });
    await approveDesign(repo, "REQ-001");

    // Seed an initial failed verification, then pass on the exact same code snapshot
    await runVerification(repo, "REQ-001", { command: "echo broken && exit 1", criterionIds: ["AC-1"] });
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });

    // Handoff packet must NOT include the superseded failure log
    const cleanPacket = await synthesizeHandoffPacket(repo, "REQ-001", { action: "implement" });
    expect(cleanPacket.markdown).not.toContain("echo broken");

    const routing = buildPresetRouting("balanced");
    routing.autoReview = true;
    routing.stages.implement = {
      primary: { harness: "opencode", model: "opencode-go/deepseek-v4.1-flash" },
      fallbacks: [],
    };
    routing.stages.review = {
      primary: { harness: "codex", model: "gpt-6.2-sol" },
      fallbacks: [],
    };

    const actionsSeen: string[] = [];
    let observedOpencodeCfg = "";
    const executor = new HubExecutor({
      initialHarnesses: [harness("opencode", "opencode"), harness("codex", "codex")],
      getHubPreferences: () => ({ routing }),
      commandBuilder: (_target, ctx) => {
        actionsSeen.push(ctx.action);
        if (ctx.action === "implement") {
          const enginePath = path.resolve(import.meta.dir, "../../src/core/engine.ts");
          const gitPath = path.resolve(import.meta.dir, "../../src/core/git.ts");
          return {
            command: "bun",
            args: [
              "-e",
              `
              import { updateTasks } from ${JSON.stringify(enginePath)};
              import { observeGitSnapshot } from ${JSON.stringify(gitPath)};
              console.log("OPENCODE_CFG=" + (process.env.OPENCODE_CONFIG_CONTENT ?? ""));
              const snap = await observeGitSnapshot(process.cwd());
              await updateTasks(process.cwd(), "REQ-001", {
                tasks: [{ title: "done", status: "done" }],
                readyForAcceptance: true,
                currentCodeSnapshotHash: snap.fingerprint,
              });
              console.log('{"type":"error","error":{"type":"unknown","message":"Cancelled a request for input this run cannot answer: Web Search"}}');
              process.exit(1);
              `,
            ],
            displayCommand: "mock-opencode-late-cancel",
          };
        }
        return {
          command: "bash",
          args: ["-c", `printf '%s\\n' '\`\`\`json' '{"verdict":"pass","summary":"复核通过"}' '\`\`\`'`],
          displayCommand: "mock-review",
        };
      },
    });

    const reviewFinished = new Promise<void>((resolve) => {
      const unsub = executor.subscribe((ev) => {
        if (ev.type === "agent.run.finished" && ev.action === "implement") {
          observedOpencodeCfg = executor.getLiveLog(ev.runId) ?? "";
        }
        if (ev.type === "agent.run.finished" && ev.action === "review") {
          unsub();
          resolve();
        }
      });
    });

    await executor.startRun({ root: repo, requirementId: "REQ-001", action: "implement" });
    await reviewFinished;
    await new Promise((r) => setTimeout(r, 80));

    expect(observedOpencodeCfg).toContain('"websearch":false');
    expect(actionsSeen).toEqual(["implement", "review"]);
    const finalDetail = getRequirement(repo, "REQ-001");
    expect(finalDetail.state.agentRuns?.[0]?.status).toBe("succeeded");
    expect(finalDetail.state.reviewReport?.verdict).toBe("pass");

    // If NOT readyForAcceptance, the same exit code still results in status === "failed"
    await createRequirement(repo, { goal: "未提交验收仍应判定失败" });
    await propose(repo, "REQ-002", {
      designMarkdown: "# Design\nIncomplete.",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
      actor: "agent",
    });
    await approveDesign(repo, "REQ-002");
    const executor2 = new HubExecutor({
      initialHarnesses: [harness("opencode", "opencode")],
      getHubPreferences: () => ({ routing }),
      commandBuilder: () => ({
        command: "bash",
        args: ["-c", `echo 'Cancelled a request for input this run cannot answer: Web Search'; exit 1`],
        displayCommand: "mock-opencode-incomplete-fail",
      }),
    });
    const started2 = await executor2.startRun({ root: repo, requirementId: "REQ-002", action: "implement" });
    await waitForRun(executor2, started2.run.id);
    expect(getRequirement(repo, "REQ-002").state.agentRuns?.[0]?.status).toBe("failed");
  }, { timeout: 15000 });

  test("Phase 2: skips session_affinity and native_resume when prior peakContextTokens exceeds 100k", async () => {
    makeTempHub();
    const repo = makeGitRepo("bloat-guard");
    await initProject(repo, { name: "BloatGuard", privacyMode: "local" });
    await createRequirement(repo, { goal: "上下文膨胀后自动切回干净交接" });
    await propose(repo, "REQ-001", {
      designMarkdown: "# Design\nClean.",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
      actor: "agent",
    });
    await approveDesign(repo, "REQ-001");

    const { startAgentRun, finishAgentRun } = await import("../../src/core/engine.ts");
    const runId = "RUN-BLOATED-1";
    await startAgentRun(repo, "REQ-001", {
      id: runId,
      action: "implement",
      harness: "opencode",
      model: "opencode-go/deepseek-v4.1-flash",
      status: "running",
      startedAt: Date.now() - 2000,
      endedAt: null,
      exitCode: null,
      durationMs: 0,
      logPath: `runs/run-${runId}.log`,
    });
    await finishAgentRun(
      repo,
      "REQ-001",
      runId,
      {
        status: "succeeded",
        endedAt: Date.now() - 1000,
        exitCode: 0,
        durationMs: 1000,
        nativeSessionId: "ses_bloated_123456",
        peakContextTokens: 150_000,
      },
      "ok\n",
    );

    const routing = buildPresetRouting("balanced");
    routing.autoReview = false;
    routing.stages.fix = {
      primary: { harness: "qodercn", model: "DeepSeek-Flash" },
      fallbacks: [],
    };
    const seen: Array<{ harness: string; model: string; nativeSessionId?: string }> = [];
    const executor = new HubExecutor({
      initialHarnesses: [harness("opencode", "opencode"), harness("qodercn", "qodercn")],
      getHubPreferences: () => ({ routing }),
      commandBuilder: (target, ctx) => {
        seen.push({ harness: target.harness, model: target.model, nativeSessionId: ctx.nativeSessionId });
        return { command: "bash", args: ["-c", "echo ok"], displayCommand: "mock-fix" };
      },
    });

    const started = await executor.startRun({ root: repo, requirementId: "REQ-001", action: "fix" });
    await waitForRun(executor, started.run.id);

    expect(seen).toEqual([{ harness: "qodercn", model: "DeepSeek-Flash", nativeSessionId: undefined }]);
    expect(getRequirement(repo, "REQ-001").state.agentRuns?.at(-1)?.handoffMode).toBe("fresh_handoff");
  }, { timeout: 15000 });

  test("Phase 3: enforces design In-Scope/Out-of-Scope + bug root-cause prompt and records drift/bloat healthWarnings", async () => {
    makeTempHub();
    const repo = makeGitRepo("phase3-guards");
    await initProject(repo, { name: "Phase3Guards", privacyMode: "local" });
    await createRequirement(repo, { goal: "定位并修复前端运行时报错" });
    const detail = getRequirement(repo, "REQ-001");

    const { buildExecutionPrompt } = await import("../../src/hub/executor.ts");
    const { synthesizeHandoffPacket } = await import("../../src/hub/handoff.ts");
    const { RunTraceCollector } = await import("../../src/hub/trace_collector.ts");

    const handoff = await synthesizeHandoffPacket(repo, "REQ-001", { action: "design" });
    const designPrompt = buildExecutionPrompt(detail, handoff.markdown, {
      root: repo,
      requirementId: "REQ-001",
      action: "design",
    });
    expect(designPrompt).toContain("设计阶段禁止修改业务代码或测试");
    expect(designPrompt).toContain("提交方案后立即结束本轮");
    expect(designPrompt).toContain("In-Scope");
    expect(designPrompt).toContain("Out-of-Scope");
    expect(designPrompt).toContain("Bug/报错修复");

    const warningsEmitted: string[] = [];
    const collector = new RunTraceCollector({
      runId: "RUN-DRIFT-1",
      action: "fix",
      traceFilePath: path.join(repo, ".workbench/items/REQ-001/runs/run-drift.events.jsonl"),
      startedAt: Date.now() - 5000,
      billingMode: "api",
      quotaPool: "openai",
      modelSpec: {
        contextWindow: 128_000,
        input: 1,
        cacheRead: 0.25,
        cacheWrite: 0,
        output: 2,
        source: "builtin",
      },
      onWarning: (line) => warningsEmitted.push(line),
    });

    for (let i = 1; i <= 15; i++) {
      collector.append({ type: "turn.start", turnIndex: i });
      collector.append({
        type: "tool.start",
        turnIndex: i,
        callId: `c-${i}`,
        toolName: "read",
        category: "read",
        summary: "read file",
      });
      collector.append({
        type: "tool.end",
        turnIndex: i,
        callId: `c-${i}`,
        toolName: "read",
        category: "read",
        summary: "done",
      });
      collector.append({
        type: "turn.end",
        turnIndex: i,
        ...(i === 15 ? { contextTokens: 90_000 } : {}),
      });
    }

    const summary = collector.finalizeRun({
      status: "succeeded",
      exitCode: 0,
      durationMs: 5000,
    });
    expect(summary.healthWarnings).toEqual([
      "context_bloat:单轮上下文达到 90000 tokens（阈值 83200）",
      "pure_read_drift:连续15+轮未产生任何代码写操作",
    ]);
    expect(warningsEmitted).toHaveLength(2);
    expect(warningsEmitted[0]).toContain("上下文膨胀告警");
    expect(warningsEmitted[1]).toContain("探索漂移告警");
  });
});