import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  approveDesign,
  createRequirement,
  getRequirement,
  initProject,
  propose,
  updateProjectConfig,
} from "../../src/core/engine.ts";
import { observeGitSnapshot } from "../../src/core/git.ts";
import { createOrReuseWorktree } from "../../src/core/worktree.ts";
import { HubExecutor } from "../../src/hub/executor.ts";
import { synthesizeHandoffPacket } from "../../src/hub/handoff.ts";
import { buildInitialProjectRouting } from "../../src/hub/routing.ts";
import type { HarnessInfo } from "../../src/hub/types.ts";

const tempDirs: string[] = [];
const origHubDir = process.env.WORKBENCH_HUB_DIR;
const origChromePath = process.env.WORKBENCH_CHROME_PATH;
let activeHubDir = "";

function makeTempHub(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-autonomy-hub-"));
  tempDirs.push(dir);
  activeHubDir = dir;
  process.env.WORKBENCH_HUB_DIR = dir;
  return dir;
}

function makeGitRepo(name = "repo"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wb-autonomy-${name}-`));
  tempDirs.push(dir);
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "app.ts"), "export const initial = true;\n");
  execFileSync("git", ["add", "app.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function makeHarness(
  id: HarnessInfo["id"],
  models: Array<{ id: string; tier: HarnessInfo["models"][number]["tier"] }>,
): HarnessInfo {
  return {
    id,
    label: id,
    subscription: "Test",
    installed: true,
    executable: id,
    models: models.map((m) => ({ id: m.id, tier: m.tier, source: "detected" })),
    defaultModel: models[0]!.id,
    detectedAt: Date.now(),
  };
}

function writeMockScript(name: string, body: string): string {
  const p = path.join(activeHubDir || os.tmpdir(), `${name}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(p, body, "utf8");
  return p;
}

function waitForRun(executor: HubExecutor, runId: string, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`Timed out waiting for run ${runId}`));
    }, timeoutMs);
    const unsub = executor.subscribe((ev) => {
      if (ev.type === "agent.run.finished" && ev.runId === runId) {
        clearTimeout(timer);
        unsub();
        resolve();
      }
    });
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

beforeEach(() => {
  makeTempHub();
  process.env.WORKBENCH_CHROME_PATH = "/nonexistent-chrome-for-test";
});

afterEach(() => {
  if (origHubDir === undefined) delete process.env.WORKBENCH_HUB_DIR;
  else process.env.WORKBENCH_HUB_DIR = origHubDir;
  if (origChromePath === undefined) delete process.env.WORKBENCH_CHROME_PATH;
  else process.env.WORKBENCH_CHROME_PATH = origChromePath;
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Agent autonomy, file-native design sync, auto-heal, and blind cross-review", () => {
  test("initial project routing does not force reasoningEffort=low and assigns 3 explicit roles", () => {
    const harnesses = [
      makeHarness("codex", [{ id: "gpt-6-astra", tier: "sota" }]),
      makeHarness("qodercn", [{ id: "Qwen4-Max-Preview", tier: "balanced" }]),
      makeHarness("opencode", [{ id: "opencode-go/deepseek-v4.1-flash", tier: "fast" }]),
    ];
    const cfg = buildInitialProjectRouting(harnesses);
    expect(cfg.autoReview).toBe(true);
    expect(cfg.autoHeal).toBe(true);
    for (const role of ["defaultLead", "sotaLead", "reviewer"] as const) {
      expect(cfg[role].primary.reasoningEffort).not.toBe("low");
    }
    expect(cfg.reviewer.primary.harness).not.toBe(cfg.defaultLead.primary.harness);
  });

  test("File-Native Design Sync imports design.md & criteria.json from main repo and worktree sandbox without wb propose", async () => {
    const repo = makeGitRepo("file-native-design");
    await initProject(repo, { name: "FileNativeDesign", privacyMode: "local", routing: buildInitialProjectRouting() });
    await createRequirement(repo, { goal: "Add JWT helper" });
    await createRequirement(repo, { goal: "Worktree design item" });
    const sandbox = await createOrReuseWorktree(repo, "REQ-002");

    const harnesses = [makeHarness("codex", [{ id: "gpt-6-astra", tier: "sota" }])];
    const seenRoots: string[] = [];
    const executor = new HubExecutor({
      initialHarnesses: harnesses,
      commandBuilder: (_target, ctx) => {
        seenRoots.push(ctx.root);
        const itemId = ctx.prompt.includes("REQ-002") ? "REQ-002" : "REQ-001";
        const content = itemId === "REQ-002" ? "# Worktree Design\nIsolated sandbox plan.\n" : "# Main Design\nUse JWT verification.\n";
        const script = writeMockScript(
          `design-${itemId}`,
          `
import * as fs from "node:fs";
import * as path from "node:path";
const itemDir = path.join(${JSON.stringify(ctx.root)}, ".workbench", "items", ${JSON.stringify(itemId)});
fs.mkdirSync(itemDir, { recursive: true });
fs.writeFileSync(path.join(itemDir, "design.md"), ${JSON.stringify(content)});
fs.writeFileSync(path.join(itemDir, "criteria.json"), JSON.stringify([{ id: "AC-1", description: "passes check", command: "echo ok", required: true }], null, 2));
console.log("Design written directly to disk");
`,
        );
        return { command: "bun", args: [script], displayCommand: "mock-design" };
      },
    });

    const run1 = await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "design",
      harness: "codex",
      model: "gpt-6-astra",
    });
    await waitForRun(executor, run1.run.id);
    const d1 = getRequirement(repo, "REQ-001");
    expect(d1.state.stage).toBe("planning");
    expect(d1.state.designVersion).toBeGreaterThanOrEqual(1);
    expect(d1.designMarkdown).toContain("Use JWT verification.");
    expect(d1.state.criteria.some((c) => c.id === "AC-1" && c.command === "echo ok")).toBe(true);
    expect(fs.existsSync(path.join(repo, ".workbench", "items", "REQ-001", "criteria.json"))).toBe(false);

    const run2 = await executor.startRun({
      root: repo,
      requirementId: "REQ-002",
      action: "design",
      harness: "codex",
      model: "gpt-6-astra",
    });
    await waitForRun(executor, run2.run.id);
    expect(fs.realpathSync(seenRoots[1]!)).toBe(fs.realpathSync(sandbox.worktreePath));
    const d2 = getRequirement(repo, "REQ-002");
    expect(d2.state.stage).toBe("planning");
    expect(d2.designMarkdown).toContain("Isolated sandbox plan.");
    expect(d2.state.criteria.some((c) => c.id === "AC-1" && c.command === "echo ok")).toBe(true);
    expect(fs.existsSync(path.join(sandbox.worktreePath, ".workbench", "items", "REQ-002", "criteria.json"))).toBe(false);
  }, { timeout: 15000 });

  test("Orchestrator Auto-Verify satisfies acceptanceGate on passing implement run without manual wb verify", async () => {
    const repo = makeGitRepo("auto-verify-pass");
    await initProject(repo, { name: "AutoVerifyPass", privacyMode: "local" });
    const harnesses = [makeHarness("codex", [{ id: "gpt-6-astra", tier: "sota" }])];
    const routing = buildInitialProjectRouting(harnesses);
    routing.autoReview = false;
    await updateProjectConfig(repo, { routing });

    await createRequirement(repo, {
      goal: "Write verified export",
      criteria: [{ id: "AC-1", description: "contains verified", command: "grep -q verified app.ts", required: true }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design\nExport verified.", actor: "agent" });
    await approveDesign(repo, "REQ-001");

    const executor = new HubExecutor({
      initialHarnesses: harnesses,
      commandBuilder: (_target, ctx) => {
        const script = writeMockScript(
          "impl-pass",
          `
import * as fs from "node:fs";
import * as path from "node:path";
fs.writeFileSync(path.join(${JSON.stringify(ctx.root)}, "app.ts"), "export const verified = true;\\n");
console.log("Implemented feature");
`,
        );
        return { command: "bun", args: [script], displayCommand: "mock-impl" };
      },
    });

    const impl = await executor.startRun({ root: repo, requirementId: "REQ-001", action: "implement" });
    await waitForRun(executor, impl.run.id);
    await waitUntil(() => getRequirement(repo, "REQ-001").state.verifications.length > 0, 8000, "auto verify");

    const snap = await observeGitSnapshot(repo);
    const detail = getRequirement(repo, "REQ-001", { currentCodeSnapshotHash: snap?.fingerprint ?? null });
    expect(detail.state.stage).toBe("coding");
    expect(detail.validity.acceptanceGate.ok).toBe(true);
    expect(detail.validity.verifications[0]?.effectiveState).toBe("passed");
  }, { timeout: 15000 });

  test("Orchestrator Auto-Heal runs failed-verify fix with dispatchReason=auto_heal resuming native session until pass", async () => {
    const repo = makeGitRepo("auto-heal");
    await initProject(repo, { name: "AutoHeal", privacyMode: "local" });
    const harnesses = [makeHarness("codex", [{ id: "gpt-6-astra", tier: "sota" }])];
    const routing = buildInitialProjectRouting(harnesses);
    routing.autoReview = false;
    routing.autoHeal = true;
    await updateProjectConfig(repo, { routing });

    await createRequirement(repo, {
      goal: "Write healed export",
      criteria: [{ id: "AC-1", description: "contains healed", command: "grep -q healed app.ts", required: true }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design\nExport healed.", actor: "agent" });
    await approveDesign(repo, "REQ-001");

    const calls: Array<{ action: string; nativeSessionId?: string }> = [];
    const executor = new HubExecutor({
      initialHarnesses: harnesses,
      commandBuilder: (_target, ctx) => {
        calls.push({ action: ctx.action, nativeSessionId: ctx.nativeSessionId });
        if (ctx.action === "implement") {
          const script = writeMockScript(
            "heal-impl",
            `
import * as fs from "node:fs";
import * as path from "node:path";
console.log(JSON.stringify({ type: "thread.started", thread_id: "ses_heal_99" }));
fs.writeFileSync(path.join(${JSON.stringify(ctx.root)}, "app.ts"), "export const broken = true;\\n");
`,
          );
          return { command: "bun", args: [script], displayCommand: "mock-impl-fail" };
        }
        const script = writeMockScript(
          "heal-fix",
          `
import * as fs from "node:fs";
import * as path from "node:path";
fs.writeFileSync(path.join(${JSON.stringify(ctx.root)}, "app.ts"), "export const healed = true;\\n");
console.log("Healed feature");
`,
        );
        return { command: "bun", args: [script], displayCommand: "mock-fix-heal" };
      },
    });

    const finishedRuns: string[] = [];
    const unsub = executor.subscribe((ev) => {
      if (ev.type === "agent.run.finished") finishedRuns.push(ev.runId);
    });
    await executor.startRun({ root: repo, requirementId: "REQ-001", action: "implement" });
    await waitUntil(() => finishedRuns.length === 2, 10000, "2 finished runs (implement + auto_heal)");
    unsub();

    const snap = await observeGitSnapshot(repo);
    const detail = getRequirement(repo, "REQ-001", { currentCodeSnapshotHash: snap?.fingerprint ?? null });
    const runs = detail.state.agentRuns ?? [];
    expect(detail.state.stage).toBe("coding");
    expect(calls).toEqual([
      { action: "implement", nativeSessionId: undefined },
      { action: "fix", nativeSessionId: "ses_heal_99" },
    ]);
    expect(runs[0]?.action).toBe("implement");
    expect(runs[1]?.action).toBe("fix");
    expect(runs[1]?.dispatchReason).toBe("auto_heal");
    expect(runs[1]?.handoffMode).toBe("native_resume");
    expect(detail.validity.acceptanceGate.ok).toBe(true);
  }, { timeout: 15000 });

  test("Auto-Review prefers cross-harness blind review and stops after 1 round even on block", async () => {
    const repo = makeGitRepo("cross-review-one-shot");
    await initProject(repo, { name: "CrossReviewOneShot", privacyMode: "local" });
    const harnesses = [
      makeHarness("codex", [{ id: "gpt-6-astra", tier: "sota" }]),
      makeHarness("qodercn", [{ id: "Qwen4-Max-Preview", tier: "balanced" }]),
    ];
    const routing = buildInitialProjectRouting(harnesses);
    routing.autoReview = true;
    await updateProjectConfig(repo, { routing });

    await createRequirement(repo, {
      goal: "Test one-shot blind cross review",
      criteria: [{ id: "AC-1", description: "ok", command: "echo ok", required: true }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design\nCross review.", actor: "agent" });
    await approveDesign(repo, "REQ-001");

    const calls: Array<{ action: string; harness: string; nativeSessionId?: string }> = [];
    const executor = new HubExecutor({
      initialHarnesses: harnesses,
      commandBuilder: (target, ctx) => {
        calls.push({ action: ctx.action, harness: target.harness, nativeSessionId: ctx.nativeSessionId });
        if (ctx.action === "implement") {
          const script = writeMockScript(
            "cr-impl",
            `
import * as fs from "node:fs";
import * as path from "node:path";
console.log(JSON.stringify({ type: "thread.started", thread_id: "ses_impl_codex" }));
fs.writeFileSync(path.join(${JSON.stringify(ctx.root)}, "app.ts"), "export const v = 2;\\n");
`,
          );
          return { command: "bun", args: [script], displayCommand: "mock-impl" };
        }
        const script = writeMockScript(
          "cr-review",
          `
console.log(${JSON.stringify(
            '```json\n{"verdict":"block","summary":"Critical defect","findings":[{"id":"F-1","severity":"high","title":"Null deref"}]}\n```',
          )});
`,
        );
        return { command: "bun", args: [script], displayCommand: "mock-review-block" };
      },
    });

    const finishedRuns: string[] = [];
    const unsub = executor.subscribe((ev) => {
      if (ev.type === "agent.run.finished") finishedRuns.push(ev.runId);
    });
    await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "implement",
      harness: "codex",
      model: "gpt-6-astra",
    });

    await waitUntil(() => {
      const runs = getRequirement(repo, "REQ-001").state.agentRuns ?? [];
      return finishedRuns.length >= 2 && runs.some((r) => r.action === "review" && r.status !== "running");
    }, 10000, "auto review completion");

    // Settle briefly to ensure no 2nd review or auto-heal is spawned on block
    await new Promise((res) => setTimeout(res, 250));
    unsub();
    const detail = getRequirement(repo, "REQ-001");
    const reviewRuns = (detail.state.agentRuns ?? []).filter((r) => r.action === "review");
    expect(reviewRuns.length).toBe(1);
    expect(reviewRuns[0]?.harness).toBe("qodercn");
    expect(calls[1]?.nativeSessionId).toBeUndefined();
    expect(detail.state.reviewReport?.verdict).toBe("block");
  }, { timeout: 15000 });

  test("Manual non-command criterion does not falsely trigger auto_heal when automated commands pass", async () => {
    const repo = makeGitRepo("no-false-auto-heal");
    await initProject(repo, { name: "NoFalseHeal", privacyMode: "local" });
    const harnesses = [makeHarness("codex", [{ id: "gpt-6-astra", tier: "sota" }])];
    const routing = buildInitialProjectRouting(harnesses);
    routing.autoReview = false;
    routing.autoHeal = true;
    await updateProjectConfig(repo, { routing });

    await createRequirement(repo, {
      goal: "Passing command plus manual required check",
      criteria: [
        { id: "AC-1", description: "auto check", command: "grep -q ok app.ts", required: true },
        { id: "AC-2", description: "manual visual signoff", required: true },
      ],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design\nCheck manual gate.", actor: "agent" });
    await approveDesign(repo, "REQ-001");

    const executor = new HubExecutor({
      initialHarnesses: harnesses,
      commandBuilder: (_target, ctx) => {
        const script = writeMockScript(
          "impl-ok-manual",
          `
import * as fs from "node:fs";
import * as path from "node:path";
fs.writeFileSync(path.join(${JSON.stringify(ctx.root)}, "app.ts"), "export const ok = true;\\n");
`,
        );
        return { command: "bun", args: [script], displayCommand: "mock-impl-ok" };
      },
    });

    const impl = await executor.startRun({ root: repo, requirementId: "REQ-001", action: "implement" });
    await waitForRun(executor, impl.run.id);
    await new Promise((res) => setTimeout(res, 200));

    const runs = getRequirement(repo, "REQ-001").state.agentRuns ?? [];
    expect(runs.length).toBe(1);
    expect(runs[0]?.action).toBe("implement");
  }, { timeout: 15000 });

  test("fix skips intervening ask run for native_resume and handoff includes committed diff since baseline", async () => {
    const repo = makeGitRepo("ask-isolation-baseline");
    fs.mkdirSync(path.join(repo, "tests"), { recursive: true });
    fs.writeFileSync(path.join(repo, "tests", "unit.test.ts"), "test('ok', () => { expect(1).toBe(1); });\n");
    execFileSync("git", ["add", "tests/unit.test.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "add unit test"], { cwd: repo, stdio: "ignore" });

    await initProject(repo, { name: "AskIsolationBaseline", privacyMode: "local" });
    const harnesses = [makeHarness("codex", [{ id: "gpt-6-astra", tier: "sota" }])];
    const routing = buildInitialProjectRouting(harnesses);
    routing.autoReview = false;
    routing.autoHeal = false;
    await updateProjectConfig(repo, { routing });

    await createRequirement(repo, {
      goal: "Verify session scoping and committed baseline diff",
      criteria: [{ id: "AC-1", description: "ok", command: "echo ok", required: true }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design\nScoped sessions.", actor: "agent" });
    const snapBase = (await observeGitSnapshot(repo))!;
    await approveDesign(repo, "REQ-001", {
      baseline: {
        head: snapBase.head,
        fingerprint: snapBase.fingerprint,
        dirty: snapBase.dirty,
        capturedAt: snapBase.capturedAt,
      },
    });

    const seenSessions: Array<{ action: string; nativeSessionId?: string }> = [];
    const executor = new HubExecutor({
      initialHarnesses: harnesses,
      commandBuilder: (_target, ctx) => {
        seenSessions.push({ action: ctx.action, nativeSessionId: ctx.nativeSessionId });
        const threadId = ctx.action === "implement" ? "ses_impl_keep" : ctx.action === "ask" ? "ses_ask_readonly" : "ses_fix_next";
        const script = writeMockScript(
          `run-${ctx.action}`,
          `console.log(JSON.stringify({ type: "thread.started", thread_id: ${JSON.stringify(threadId)} }));\n`,
        );
        return { command: "bun", args: [script], displayCommand: `mock-${ctx.action}` };
      },
    });

    const impl = await executor.startRun({ root: repo, requirementId: "REQ-001", action: "implement" });
    await waitForRun(executor, impl.run.id);
    const ask = await executor.startRun({ root: repo, requirementId: "REQ-001", action: "ask", message: "Why?" });
    await waitForRun(executor, ask.run.id);
    const fix = await executor.startRun({ root: repo, requirementId: "REQ-001", action: "fix" });
    await waitForRun(executor, fix.run.id);

    expect(seenSessions).toEqual([
      { action: "implement", nativeSessionId: undefined },
      { action: "ask", nativeSessionId: undefined },
      { action: "fix", nativeSessionId: "ses_impl_keep" },
    ]);

    // Committed change after baseline should still appear in review handoff & tampering detection
    fs.writeFileSync(path.join(repo, "tests", "unit.test.ts"), "test.skip('ok', () => { expect(1).toBe(1); });\n");
    execFileSync("git", ["add", "tests/unit.test.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "skip test"], { cwd: repo, stdio: "ignore" });

    const reviewPacket = await synthesizeHandoffPacket(repo, "REQ-001", { action: "review" });
    expect(reviewPacket.markdown).toContain("tests/unit.test.ts");
    expect(reviewPacket.markdown).toContain("测试完整性提示");
  }, { timeout: 15000 });
});
