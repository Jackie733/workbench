import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { replayIdleTimeouts } from "../../scripts/replay-idle-timeout.ts";
import { acquireCodeRootLock } from "../../src/core/code_lock.ts";
import {
  acceptRequirement,
  approveDesign,
  createRequirement,
  getRequirement,
  initProject,
  propose,
  recordReviewReport,
  updateProjectConfig,
} from "../../src/core/engine.ts";
import { observeGitSnapshot } from "../../src/core/git.ts";
import { runAllVerifications, runVerification } from "../../src/core/runner.ts";
import { getSandboxForRequirement, resolveCodeRoot } from "../../src/core/sandbox.ts";
import {
  commitSandboxWipCheckpoint,
  createOrReuseWorktree,
  retryOrIgnoreSandboxSetup,
  syncSandboxBase,
} from "../../src/core/worktree.ts";
import { HubExecutor } from "../../src/hub/executor.ts";
import { synthesizeHandoffPacket } from "../../src/hub/handoff.ts";
import { buildInitialProjectRouting } from "../../src/hub/routing.ts";
import type { HarnessInfo } from "../../src/hub/types.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";

const tempDirs: string[] = [];
const servers: WorkbenchServerHandle[] = [];
const origHubDir = process.env.WORKBENCH_HUB_DIR;
const origChromePath = process.env.WORKBENCH_CHROME_PATH;
let activeHubDir = "";

function makeTempHub(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-fp1-hub-"));
  tempDirs.push(dir);
  activeHubDir = dir;
  process.env.WORKBENCH_HUB_DIR = dir;
  return dir;
}

function makeGitRepo(name = "repo"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wb-fp1-${name}-`));
  tempDirs.push(dir);
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, ".gitignore"), ".env\n.env.*\n");
  fs.writeFileSync(path.join(dir, "app.ts"), "export const v = 1;\n");
  fs.writeFileSync(path.join(dir, "other.ts"), "export const other = 1;\n");
  execFileSync("git", ["add", ".gitignore", "app.ts", "other.ts"], { cwd: dir, stdio: "ignore" });
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

function writeScript(name: string, body: string): string {
  const p = path.join(activeHubDir || os.tmpdir(), `${name}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(p, body, "utf8");
  return p;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 12000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function apiJson(url: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const resp = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await resp.json()) as Record<string, unknown>;
  return { status: resp.status, body };
}

beforeEach(() => {
  makeTempHub();
  process.env.WORKBENCH_CHROME_PATH = "/nonexistent-chrome-for-test";
});

afterEach(() => {
  while (servers.length > 0) servers.pop()!.stop();
  if (origHubDir === undefined) delete process.env.WORKBENCH_HUB_DIR;
  else process.env.WORKBENCH_HUB_DIR = origHubDir;
  if (origChromePath === undefined) delete process.env.WORKBENCH_CHROME_PATH;
  else process.env.WORKBENCH_CHROME_PATH = origChromePath;
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("Flow Phase 1 (WB-13 – WB-16)", () => {
  test("WB-13: default worktree isolation on approve/fast-track, opt-out, .worktreeinclude security, and setupScript retry/ignore", async () => {
    const repo = makeGitRepo("wt-default");
    await initProject(repo, { name: "WtDefault", privacyMode: "local" });
    fs.writeFileSync(path.join(repo, ".worktreeinclude"), ".env.local\nsecret_unignored.txt\n");
    fs.writeFileSync(path.join(repo, ".env.local"), "API_KEY=local-secret\n");
    fs.writeFileSync(path.join(repo, ".env.custom"), "CUSTOM=1\n");
    fs.writeFileSync(path.join(repo, "secret_unignored.txt"), "SHOULD_NOT_COPY\n");

    const marker = path.join(repo, ".allow-setup");
    await updateProjectConfig(repo, {
      worktree: {
        copyFiles: [".env.custom"],
        setupScript: `test -f ${JSON.stringify(marker)}`,
      },
    });

    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, hubMode: false });
    servers.push(server);

    // Create REQ-001 and propose
    await createRequirement(repo, {
      goal: "Default worktree test",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Plan\nIsolated.", actor: "agent" });

    // setupScript fails initially -> blocks approve with setupFailed metadata while retaining worktree
    const failApprove = await apiJson(`${server.url}/api/requirements/REQ-001/approve`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(failApprove.status).toBe(500);
    const sbAfterFail = getSandboxForRequirement(repo, "REQ-001");
    expect(sbAfterFail).not.toBeNull();
    expect(sbAfterFail!.setupStatus).toBe("failed");
    // Only gitignored files copied; unignored file must NOT be copied
    expect(fs.existsSync(path.join(sbAfterFail!.worktreePath, ".env.local"))).toBe(true);
    expect(fs.existsSync(path.join(sbAfterFail!.worktreePath, ".env.custom"))).toBe(true);
    expect(fs.existsSync(path.join(sbAfterFail!.worktreePath, "secret_unignored.txt"))).toBe(false);

    // Retry succeeds once marker exists
    fs.writeFileSync(marker, "ok");
    const retryRes = await apiJson(`${server.url}/api/requirements/REQ-001/sandbox/setup`, {
      method: "POST",
      body: JSON.stringify({ action: "retry" }),
    });
    expect(retryRes.status).toBe(200);
    expect(getSandboxForRequirement(repo, "REQ-001")?.setupStatus).toBe("ok");

    // Approve now reuses the ready sandbox
    const okApprove = await apiJson(`${server.url}/api/requirements/REQ-001/approve`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(okApprove.status).toBe(200);
    expect(okApprove.body.sandbox).toBeTruthy();

    // WIP checkpoint in sandbox NEVER commits gitignored .env files
    const wt = resolveCodeRoot(repo, "REQ-001");
    fs.writeFileSync(path.join(wt, "app.ts"), "export const v = 2;\n");
    const wip = await commitSandboxWipCheckpoint(repo, "REQ-001", { action: "implement", runId: "RUN-TEST1", status: "succeeded" });
    expect(wip.committed).toBe(true);
    expect(wip.files).toEqual(["app.ts"]);
    const committedFiles = execFileSync("git", ["-C", wt, "show", "--name-only", "--format=", "HEAD"], { encoding: "utf8" })
      .trim()
      .split("\n");
    expect(committedFiles).toEqual(["app.ts"]);

    // Fast-track also creates default worktree (and setup failure can be ignored via retryOrIgnoreSandboxSetup)
    fs.rmSync(marker, { force: true });
    await createRequirement(repo, { goal: "Fast-track default sandbox" });
    const ftFail = await apiJson(`${server.url}/api/requirements/REQ-002/fast-track`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(ftFail.status).toBe(500);
    const ignored = await retryOrIgnoreSandboxSetup(repo, "REQ-002", "ignore");
    expect(ignored.setupStatus).toBe("skipped");

    // Explicit opt-out (`createSandbox: false`) stays on main workspace
    await createRequirement(repo, { goal: "Opt out sandbox" });
    const optOut = await apiJson(`${server.url}/api/requirements/REQ-003/fast-track`, {
      method: "POST",
      body: JSON.stringify({ createSandbox: false }),
    });
    expect(optOut.status).toBe(200);
    expect(getSandboxForRequirement(repo, "REQ-003")).toBeNull();
  }, 20_000);

  test("WB-13: content-tree fingerprint preserves verification and verify-cache across WIP commits; RWLock enforces standard read/write semantics", async () => {
    const repo = makeGitRepo("tree-fp-rwlock");
    await initProject(repo, { name: "TreeFp", privacyMode: "local" });
    const countFile = path.join(repo, ".verify-count");
    const cmd = `bun -e 'const fs=require("fs");const f=${JSON.stringify(countFile)};fs.writeFileSync(f,String((fs.existsSync(f)?Number(fs.readFileSync(f,"utf8")):0)+1));'`;
    await createRequirement(repo, {
      goal: "Verify survives WIP commit",
      criteria: [{ id: "AC-1", description: "count", required: true, command: cmd }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design\nTree OID.", actor: "agent" });
    await approveDesign(repo, "REQ-001");
    const sb = await createOrReuseWorktree(repo, "REQ-001");
    const wt = sb.worktreePath;

    // Modify file, run verify BEFORE WIP commit
    fs.writeFileSync(path.join(wt, "app.ts"), "export const v = 42;\n");
    const snapBeforeWip = (await observeGitSnapshot(wt))!;
    const ver1 = await runAllVerifications(repo, "REQ-001");
    expect(ver1.runs[0]!.record.passed).toBe(true);
    expect(fs.readFileSync(countFile, "utf8")).toBe("1");

    // Commit WIP -> HEAD advances, but content-tree fingerprint stays IDENTICAL!
    const wip = await commitSandboxWipCheckpoint(repo, "REQ-001", { action: "implement", runId: "RUN-WIP1", status: "succeeded" });
    expect(wip.committed).toBe(true);
    const snapAfterWip = (await observeGitSnapshot(wt))!;
    expect(snapAfterWip.head).not.toBe(snapBeforeWip.head);
    expect(snapAfterWip.fingerprint).toBe(snapBeforeWip.fingerprint);

    // Verification remains PASSED (not stale) and runAllVerifications reuses it without re-running!
    const detailAfterWip = getRequirement(repo, "REQ-001", { currentCodeSnapshotHash: snapAfterWip.fingerprint });
    expect(detailAfterWip.validity.acceptanceGate.ok).toBe(true);
    const ver2 = await runAllVerifications(repo, "REQ-001");
    expect(ver2.runs[0]!.reused).toBe(true);
    expect(fs.readFileSync(countFile, "utf8")).toBe("1");

    // RWLock semantics on same codeRoot
    const r1 = acquireCodeRootLock(wt, "read", { kind: "ask", requirementId: "REQ-001" });
    const r2 = acquireCodeRootLock(wt, "read", { kind: "review", requirementId: "REQ-001" });
    expect(() => acquireCodeRootLock(wt, "write", { kind: "implement", requirementId: "REQ-001" })).toThrow();
    r1.release();
    r2.release();

    const w1 = acquireCodeRootLock(wt, "write", { kind: "implement", requirementId: "REQ-001" });
    expect(() => acquireCodeRootLock(wt, "write", { kind: "fix", requirementId: "REQ-002" })).toThrow();
    expect(() => acquireCodeRootLock(wt, "read", { kind: "review", requirementId: "REQ-001" })).toThrow();
    // Re-entrant child lease under parentLeaseId succeeds (used by WIP commit & post-verify)
    const child = acquireCodeRootLock(wt, "write", { kind: "verify", requirementId: "REQ-001" }, { parentLeaseId: w1.id });
    child.release();
    // Different codeRoot acquires write lock concurrently
    const wOther = acquireCodeRootLock(repo, "write", { kind: "implement", requirementId: "REQ-002" });
    wOther.release();
    w1.release();
  }, 20_000);

  test("WB-13 + WB-14 + WB-15: capped 1-round block auto-remediation, incremental re-review with same-model resume, stale block guard, and fresh escape hatch", async () => {
    const repo = makeGitRepo("block-loop-increv");
    await initProject(repo, { name: "BlockLoop", privacyMode: "local" });
    const harnesses = [
      makeHarness("codex", [{ id: "gpt-6-astra", tier: "sota" }]),
      makeHarness("qodercn", [
        { id: "Qwen4-Max", tier: "balanced" },
        { id: "DeepSeek-Flash", tier: "fast" },
      ]),
    ];
    const routing = buildInitialProjectRouting(harnesses);
    routing.autoReview = true;
    routing.autoHeal = true;
    routing.defaultLead = { primary: { harness: "codex", model: "gpt-6-astra" }, fallbacks: [] };
    routing.reviewer = { primary: { harness: "qodercn", model: "Qwen4-Max" }, fallbacks: [{ harness: "qodercn", model: "DeepSeek-Flash" }] };
    await updateProjectConfig(repo, { routing });

    await createRequirement(repo, {
      goal: "Test block loop and incremental re-review",
      criteria: [
        { id: "AC-1", description: "auto check", required: true, command: "grep -q feature app.ts" },
        { id: "AC-2", description: "manual visual review", required: true },
      ],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Plan\nFeature.", actor: "agent" });
    const sb = await createOrReuseWorktree(repo, "REQ-001");
    const wt = sb.worktreePath;
    const baseSnap = (await observeGitSnapshot(wt))!;
    await approveDesign(repo, "REQ-001", { baseline: baseSnap });

    const seenCalls: Array<{
      action: string;
      harness: string;
      model: string;
      nativeSessionId?: string;
      allowResumeOnReview?: boolean;
      prompt: string;
    }> = [];
    let reviewCount = 0;

    const executor = new HubExecutor({
      initialHarnesses: harnesses,
      commandBuilder: (target, ctx) => {
        seenCalls.push({
          action: ctx.action,
          harness: target.harness,
          model: target.model,
          nativeSessionId: ctx.nativeSessionId,
          allowResumeOnReview: ctx.allowResumeOnReview,
          prompt: ctx.prompt,
        });
        if (ctx.action === "implement") {
          const s = writeScript(
            "fp1-impl",
            `
import * as fs from "node:fs";
import * as path from "node:path";
console.log(JSON.stringify({ type: "thread.started", thread_id: "ses_impl_1" }));
fs.writeFileSync(path.join(${JSON.stringify(ctx.root)}, "app.ts"), "export const feature = 1;\\n");
`,
          );
          return { command: "bun", args: [s], displayCommand: "mock-impl" };
        }
        if (ctx.action === "fix") {
          const s = writeScript(
            "fp1-fix",
            `
import * as fs from "node:fs";
import * as path from "node:path";
fs.writeFileSync(path.join(${JSON.stringify(ctx.root)}, "app.ts"), "export const feature = 2; // fixed block\\n");
`,
          );
          return { command: "bun", args: [s], displayCommand: "mock-fix" };
        }
        reviewCount += 1;
        const verdictPayload =
          reviewCount === 1
            ? { verdict: "block", summary: "初次阻塞问题", findings: [{ id: "F-1", severity: "high", title: "缺少边界处理" }] }
            : { verdict: "block", summary: "复审仍阻塞（应停下交人）", findings: [{ id: "F-2", severity: "high", title: "仍有缺陷" }] };
        const s = writeScript(
          `fp1-rev-${reviewCount}`,
          `
console.log("session_id: ses_rev_qoder_1");
console.log(${JSON.stringify("```json\n" + JSON.stringify(verdictPayload) + "\n```")});
`,
        );
        return { command: "bun", args: [s], displayCommand: `mock-rev-${reviewCount}` };
      },
    });

    await executor.startRun({ root: repo, requirementId: "REQ-001", action: "implement" });
    // Even with manual AC-2 unchecked, automated AC-1 pass triggers review -> block -> 1 fix -> 1 re-review -> STOP!
    await waitUntil(
      () => {
        const runs = getRequirement(repo, "REQ-001").state.agentRuns ?? [];
        return runs.length >= 4 && runs.every((r) => r.status !== "running");
      },
      12000,
      "4 runs (implement -> review -> fix -> re-review)",
    );
    await new Promise((r) => setTimeout(r, 250));

    const runs = getRequirement(repo, "REQ-001").state.agentRuns ?? [];
    expect(runs.map((r) => r.action)).toEqual(["implement", "review", "fix", "review"]);
    expect(runs[2]?.dispatchReason).toBe("auto_review_fix");
    expect(runs[3]?.dispatchReason).toBe("auto_re_review");
    expect(runs[0]?.wipCommitHash).toMatch(/^[0-9a-f]{40}$/);
    expect(runs[2]?.wipCommitHash).toMatch(/^[0-9a-f]{40}$/);
    expect(runs[2]?.wipCommitHash).not.toBe(runs[0]?.wipCommitHash);

    // WB-15: 2nd review (index 3) resumed the same reviewer session AND received incremental diff!
    expect(seenCalls[3]?.nativeSessionId).toBe("ses_rev_qoder_1");
    expect(seenCalls[3]?.allowResumeOnReview).toBe(true);
    expect(seenCalls[3]?.prompt).toContain("本轮复审增量范围");
    expect(seenCalls[3]?.prompt).toContain("fixed block");

    // WB-15 escape hatch: manual forceFreshSession ("独立重审") starts fresh without nativeSessionId
    await executor.startRun({ root: repo, requirementId: "REQ-001", action: "review", forceFreshSession: true });
    await waitUntil(
      () => {
        const cur = getRequirement(repo, "REQ-001").state.agentRuns ?? [];
        return cur.length >= 5 && cur.every((r) => r.status !== "running");
      },
      10000,
      "5th run independent re-review",
    );
    expect(seenCalls[4]?.nativeSessionId).toBeUndefined();
    expect(seenCalls[4]?.allowResumeOnReview).toBe(false);

    // WB-15 fallback: switching reviewer model degrades to fresh_handoff
    await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "review",
      harness: "qodercn",
      model: "DeepSeek-Flash",
    });
    await waitUntil(
      () => {
        const cur = getRequirement(repo, "REQ-001").state.agentRuns ?? [];
        return cur.length >= 6 && cur.every((r) => r.status !== "running");
      },
      10000,
      "6th run switched model review",
    );
    expect(seenCalls[5]?.nativeSessionId).toBeUndefined();

    // WB-15 fallback: after merging main (syncSandboxBase), incremental re-review degrades to full diff + fresh_handoff
    fs.writeFileSync(path.join(repo, "other.ts"), "export const other = 99;\n");
    execFileSync("git", ["add", "other.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "main advances"], { cwd: repo, stdio: "ignore" });
    await syncSandboxBase(repo, "REQ-001", { fetchRemote: false });

    await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "review",
      harness: "qodercn",
      model: "DeepSeek-Flash",
    });
    await waitUntil(
      () => {
        const cur = getRequirement(repo, "REQ-001").state.agentRuns ?? [];
        return cur.length >= 7 && cur.every((r) => r.status !== "running");
      },
      10000,
      "7th run post-sync review",
    );
    expect(seenCalls[6]?.nativeSessionId).toBeUndefined();
    expect(seenCalls[6]?.prompt).not.toContain("本轮复审增量范围");

    // WB-14 stale block guard: after code edit + re-verify, previous block becomes stale -> accept without overrideReason MUST fail!
    await createRequirement(repo, {
      goal: "Stale block guard test",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-002", { designMarkdown: "# Plan\nStale block.", actor: "agent" });
    await approveDesign(repo, "REQ-002");
    await runVerification(repo, "REQ-002", { command: "echo ok", criterionIds: ["AC-1"] });
    const snap1 = (await observeGitSnapshot(repo))!;
    await recordReviewReport(repo, "REQ-002", {
      reviewerHarness: "qodercn",
      reviewerModel: "Qwen4-Max",
      verdict: "block",
      summary: "存在严重缺陷",
      markdown: "细节",
      reviewedSpecHash: getRequirement(repo, "REQ-002").state.specHash,
      reviewedCodeSnapshotHash: snap1.fingerprint,
    });
    // Edit code & re-verify -> review is now stale
    fs.writeFileSync(path.join(repo, "app.ts"), "export const v = 999;\n");
    await runVerification(repo, "REQ-002", { command: "echo ok", criterionIds: ["AC-1"] });
    const snap2 = (await observeGitSnapshot(repo))!;
    const staleReq2 = getRequirement(repo, "REQ-002", { currentCodeSnapshotHash: snap2.fingerprint });
    expect(staleReq2.validity.reviewValidity.effectiveState).toBe("stale");
    expect(staleReq2.validity.banner.tone).toBe("danger");
    await expect(
      acceptRequirement(repo, "REQ-002", { currentCodeSnapshotHash: snap2.fingerprint }),
    ).rejects.toMatchObject({ code: "acceptance_gate_failed" });
    // With explicit overrideReason -> succeeds
    const accepted = await acceptRequirement(repo, "REQ-002", {
      currentCodeSnapshotHash: snap2.fingerprint,
      overrideReason: "人工复核已确认修复，无需复审",
    });
    expect(accepted.state.stage).toBe("done");
  }, 25_000);

  test("WB-16: cache-friendly handoff ordering, Anti-Loop 2nd fix fresh_handoff, env failure triage (exit 127), zero-change guard, and idle replay", async () => {
    const repo = makeGitRepo("wb16");
    fs.writeFileSync(path.join(repo, "AGENTS.md"), "# Agent Rules\n");
    fs.writeFileSync(path.join(repo, "docs_design.md"), "# Design\n");
    await initProject(repo, { name: "Wb16Test", privacyMode: "local" });
    const harnesses = [
      makeHarness("codex", [{ id: "gpt-6-astra", tier: "sota" }]),
      makeHarness("qodercn", [{ id: "Qwen4-Max", tier: "balanced" }]),
    ];
    const routing = buildInitialProjectRouting(harnesses);
    routing.autoReview = true;
    routing.autoHeal = true;
    routing.defaultLead = { primary: { harness: "codex", model: "gpt-6-astra" }, fallbacks: [{ harness: "qodercn", model: "Qwen4-Max" }] };
    await updateProjectConfig(repo, { routing });

    // 1. Prompt cache-friendly ordering: static `contract` precedes dynamic `failures` & `steering`,
    // and targetHarness omits duplicate AGENTS.md reference.
    await createRequirement(repo, {
      goal: "Cache friendly handoff",
      criteria: [{ id: "AC-1", description: "fails", required: true, command: "exit 1" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Plan\nCache order.", actor: "agent" });
    await approveDesign(repo, "REQ-001");
    await runVerification(repo, "REQ-001", { command: "echo BOOM && exit 1", criterionIds: ["AC-1"] });
    const pkt = await synthesizeHandoffPacket(repo, "REQ-001", {
      action: "fix",
      humanInstruction: "LATEST_DYNAMIC_STEERING",
      targetHarness: "codex",
    });
    expect(pkt.markdown).not.toContain("`AGENTS.md`");
    expect(pkt.markdown.indexOf("## 权威文件指引与验收条件")).toBeLessThan(pkt.markdown.indexOf("## 失败与运行现场"));
    expect(pkt.markdown.indexOf("## 失败与运行现场")).toBeLessThan(pkt.markdown.indexOf("## 待处理反馈与审查意见"));

    // 2. Anti-Loop: 1st auto-heal resumes session, 2nd auto-heal forces fresh_handoff!
    const healSessions: Array<{ action: string; nativeSessionId?: string }> = [];
    const healExec = new HubExecutor({
      initialHarnesses: harnesses,
      commandBuilder: (_t, ctx) => {
        healSessions.push({ action: ctx.action, nativeSessionId: ctx.nativeSessionId });
        const s = writeScript(
          `anti-loop-${healSessions.length}`,
          `
import * as fs from "node:fs";
import * as path from "node:path";
console.log(JSON.stringify({ type: "thread.started", thread_id: "ses_loop_1" }));
fs.writeFileSync(path.join(${JSON.stringify(ctx.root)}, "app.ts"), "export const attempt = ${healSessions.length};\\n");
`,
        );
        return { command: "bun", args: [s], displayCommand: "mock-loop" };
      },
    });
    await healExec.startRun({ root: repo, requirementId: "REQ-001", action: "implement" });
    await waitUntil(
      () => {
        const r = getRequirement(repo, "REQ-001").state.agentRuns ?? [];
        return r.length >= 3 && r.every((x) => x.status !== "running");
      },
      12000,
      "implement + 2 auto-heal attempts",
    );
    expect(healSessions.map((c) => c.action)).toEqual(["implement", "fix", "fix"]);
    expect(healSessions[1]?.nativeSessionId).toBe("ses_loop_1");
    expect(healSessions[2]?.nativeSessionId).toBeUndefined();

    // 3. Environment failure triage: exit 127 (command not found) MUST NOT trigger auto-heal!
    await createRequirement(repo, {
      goal: "Missing binary triage",
      criteria: [{ id: "AC-1", description: "missing tool", required: true, command: "nonexistent_wb_binary_xyz_999" }],
    });
    await propose(repo, "REQ-002", { designMarkdown: "# Plan\nEnv triage.", actor: "agent" });
    await approveDesign(repo, "REQ-002");
    const envExec = new HubExecutor({
      initialHarnesses: harnesses,
      commandBuilder: (_t, ctx) => {
        const s = writeScript(
          "env-impl",
          `
import * as fs from "node:fs";
import * as path from "node:path";
fs.writeFileSync(path.join(${JSON.stringify(ctx.root)}, "app.ts"), "export const envTest = 1;\\n");
`,
        );
        return { command: "bun", args: [s], displayCommand: "mock-env-impl" };
      },
    });
    await envExec.startRun({ root: repo, requirementId: "REQ-002", action: "implement" });
    await waitUntil(() => (getRequirement(repo, "REQ-002").state.agentRuns ?? []).every((r) => r.status !== "running"), 8000, "env impl");
    await new Promise((r) => setTimeout(r, 250));
    const req2Runs = getRequirement(repo, "REQ-002").state.agentRuns ?? [];
    expect(req2Runs).toHaveLength(1);
    const req2Snap = (await observeGitSnapshot(repo))!;
    const req2Detail = getRequirement(repo, "REQ-002", { currentCodeSnapshotHash: req2Snap.fingerprint });
    expect(req2Detail.validity.needsDecision).toBe(true);
    expect(req2Detail.validity.decisionReason).toBe("验证环境异常");

    // 4. Zero-change hard guard: implement exits 0 with 0 changes relative to baseline -> blocks auto-review and flags needsDecision
    await createRequirement(repo, {
      goal: "Zero change guard",
      criteria: [{ id: "AC-1", description: "always ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-003", { designMarkdown: "# Plan\nZero change.", actor: "agent" });
    const req3Base = (await observeGitSnapshot(repo))!;
    await approveDesign(repo, "REQ-003", { baseline: req3Base });
    const zeroExec = new HubExecutor({
      initialHarnesses: harnesses,
      commandBuilder: () => ({ command: "bash", args: ["-c", "echo nothing changed"], displayCommand: "mock-noop" }),
    });
    await zeroExec.startRun({ root: repo, requirementId: "REQ-003", action: "implement" });
    await waitUntil(() => (getRequirement(repo, "REQ-003").state.agentRuns ?? []).every((r) => r.status !== "running"), 8000, "zero impl");
    await new Promise((r) => setTimeout(r, 200));
    const req3Detail = getRequirement(repo, "REQ-003", { currentCodeSnapshotHash: req3Base.fingerprint });
    expect(req3Detail.state.agentRuns).toHaveLength(1);
    expect(req3Detail.state.agentRuns?.[0]?.noCodeChange).toBe(true);
    expect(req3Detail.validity.needsDecision).toBe(true);
    expect(req3Detail.validity.decisionReason).toBe("未产出代码改动");

    // 5. Idle timeout replay script accurately evaluates historical runs
    const replayDir = path.join(repo, ".workbench", "items", "REQ-999", "runs");
    fs.mkdirSync(replayDir, { recursive: true });
    // Succeeded run with 400s gap -> false positive at 300s, clean at 600s
    fs.writeFileSync(
      path.join(replayDir, "run-RUN-OK.json"),
      JSON.stringify({ id: "RUN-OK", action: "implement", status: "succeeded", startedAt: 1000, endedAt: 401000, durationMs: 400000 }),
    );
    fs.writeFileSync(
      path.join(replayDir, "run-RUN-OK.events.jsonl"),
      `${JSON.stringify({ ts: 1000, type: "run.init" })}\n${JSON.stringify({ ts: 401000, type: "assistant.delta" })}\n`,
    );
    // Timed-out run with 900s gap -> detected 600s earlier at 300s threshold
    fs.writeFileSync(
      path.join(replayDir, "run-RUN-HANG.json"),
      JSON.stringify({
        id: "RUN-HANG",
        action: "implement",
        status: "failed",
        startedAt: 1000,
        endedAt: 901000,
        durationMs: 900000,
        errorSummary: "执行超时（连续 900s 无输出）",
      }),
    );
    fs.writeFileSync(
      path.join(replayDir, "run-RUN-HANG.events.jsonl"),
      `${JSON.stringify({ ts: 1000, type: "run.init" })}\n${JSON.stringify({ ts: 901000, type: "assistant.delta" })}\n`,
    );
    // Insufficient log sample (missing events file)
    fs.writeFileSync(
      path.join(replayDir, "run-RUN-NOLOG.json"),
      JSON.stringify({ id: "RUN-NOLOG", action: "implement", status: "succeeded", startedAt: 1000, endedAt: 2000, durationMs: 1000 }),
    );
    const replay = replayIdleTimeouts(repo, { thresholdSeconds: [300, 600], actions: ["implement"] });
    const t300 = replay.thresholds.find((t) => t.thresholdSeconds === 300)!;
    const t600 = replay.thresholds.find((t) => t.thresholdSeconds === 600)!;
    expect(replay.insufficientLogRuns).toBeGreaterThanOrEqual(1);
    expect(t300.falsePositiveSucceeded).toBeGreaterThanOrEqual(1);
    expect(t300.hungRunsDetectedEarlier).toBe(1);
    expect(t300.totalTimeSavedMs).toBe(600_000);
    expect(t600.falsePositiveSucceeded).toBe(0);
    expect(t600.hungRunsDetectedEarlier).toBe(1);
    expect(t600.totalTimeSavedMs).toBe(300_000);
  }, 25_000);

  test("WB-13 + WB-14 + WB-16: clean sandbox auto-fast-forwards before first implement, 429 commits WIP and relays via fresh_handoff, and block-fix caps test rescue at 1", async () => {
    const repo = makeGitRepo("ff-429-rescue");
    await initProject(repo, { name: "Ff429Rescue", privacyMode: "local" });
    const harnesses = [
      makeHarness("codex", [{ id: "gpt-6-astra", tier: "sota" }]),
      makeHarness("qodercn", [{ id: "Qwen4-Max", tier: "balanced" }]),
    ];
    const routing = buildInitialProjectRouting(harnesses);
    routing.autoReview = false;
    routing.autoHeal = true;
    routing.defaultLead = {
      primary: { harness: "codex", model: "gpt-6-astra" },
      fallbacks: [{ harness: "qodercn", model: "Qwen4-Max" }],
    };
    await updateProjectConfig(repo, { routing });

    // 1. Clean sandbox fast-forwards to latest main before first implement + mid-run 429 commits WIP & relays via fresh_handoff
    await createRequirement(repo, {
      goal: "Fast-forward before first implement and 429 WIP relay",
      criteria: [{ id: "AC-1", description: "passes", required: true, command: "grep -q relayed app.ts" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Plan\nFF + 429.", actor: "agent" });
    const sb = await createOrReuseWorktree(repo, "REQ-001");
    await approveDesign(repo, "REQ-001", { baseline: await observeGitSnapshot(sb.worktreePath) });

    // Advance main BEFORE first implement runs
    fs.writeFileSync(path.join(repo, "main_advance.ts"), "export const fresh = true;\n");
    execFileSync("git", ["add", "main_advance.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "main advanced before implement"], { cwd: repo, stdio: "ignore" });

    const relayCalls: Array<{ harness: string; nativeSessionId?: string; sawMainAdvance: boolean }> = [];
    const relayExec = new HubExecutor({
      initialHarnesses: harnesses,
      commandBuilder: (target, ctx) => {
        relayCalls.push({
          harness: target.harness,
          nativeSessionId: ctx.nativeSessionId,
          sawMainAdvance: fs.existsSync(path.join(ctx.root, "main_advance.ts")),
        });
        if (target.harness === "codex") {
          const s = writeScript(
            "rl-429",
            `
import * as fs from "node:fs";
import * as path from "node:path";
console.log(JSON.stringify({ type: "thread.started", thread_id: "ses_429_1" }));
fs.writeFileSync(path.join(${JSON.stringify(ctx.root)}, "app.ts"), "export const partial = true;\\n");
console.error("HTTP 429 Too Many Requests: rate limit exceeded");
process.exit(1);
`,
          );
          return { command: "bun", args: [s], displayCommand: "mock-429" };
        }
        const s = writeScript(
          "rl-fallback",
          `
import * as fs from "node:fs";
import * as path from "node:path";
const prev = fs.readFileSync(path.join(${JSON.stringify(ctx.root)}, "app.ts"), "utf8");
fs.writeFileSync(path.join(${JSON.stringify(ctx.root)}, "app.ts"), prev + "export const relayed = true;\\n");
`,
        );
        return { command: "bun", args: [s], displayCommand: "mock-fallback-ok" };
      },
    });
    await relayExec.startRun({ root: repo, requirementId: "REQ-001", action: "implement" });
    await waitUntil(
      () => {
        const r = getRequirement(repo, "REQ-001").state.agentRuns ?? [];
        return r.length >= 2 && r.every((x) => x.status !== "running");
      },
      12000,
      "429 fallback relay",
    );
    expect(relayCalls[0]?.sawMainAdvance).toBe(true);
    expect(relayCalls.map((c) => c.harness)).toEqual(["codex", "qodercn"]);
    expect(relayCalls[1]?.nativeSessionId).toBeUndefined();
    const runs1 = getRequirement(repo, "REQ-001").state.agentRuns ?? [];
    expect(runs1[0]?.status).toBe("failed");
    expect(runs1[0]?.rateLimited).toBe(true);
    // Interrupted 429 run committed WIP checkpoint!
    expect(runs1[0]?.wipCommitHash).toMatch(/^[0-9a-f]{40}$/);
    expect(runs1[1]?.status).toBe("succeeded");
    expect(runs1[1]?.handoffMode).toBe("fresh_handoff");

    // 2. WB-14: block-fix that breaks tests gets at most 1 auto-heal rescue, then stops immediately
    routing.autoReview = true;
    routing.reviewer = { primary: { harness: "qodercn", model: "Qwen4-Max" }, fallbacks: [] };
    await updateProjectConfig(repo, { routing });

    await createRequirement(repo, {
      goal: "Block fix caps rescue at 1",
      criteria: [{ id: "AC-1", description: "passes", required: true, command: "grep -q good app.ts" }],
    });
    await propose(repo, "REQ-002", { designMarkdown: "# Plan\nCap rescue.", actor: "agent" });
    await approveDesign(repo, "REQ-002");

    const capActions: string[] = [];
    const capExec = new HubExecutor({
      initialHarnesses: harnesses,
      commandBuilder: (_t, ctx) => {
        capActions.push(ctx.action);
        if (ctx.action === "implement") {
          const s = writeScript(
            "cap-impl",
            `
import * as fs from "node:fs";
import * as path from "node:path";
fs.writeFileSync(path.join(${JSON.stringify(ctx.root)}, "app.ts"), "export const good = 1;\\n");
`,
          );
          return { command: "bun", args: [s], displayCommand: "mock-cap-impl" };
        }
        if (ctx.action === "review") {
          return {
            command: "bash",
            args: ["-c", `printf '%s\\n' '\`\`\`json' '{"verdict":"block","summary":"需要修复","findings":[{"id":"F-1","severity":"high","title":"bug"}]}' '\`\`\`'`],
            displayCommand: "mock-cap-review",
          };
        }
        // Every fix breaks AC-1 so verify keeps failing
        const s = writeScript(
          `cap-fix-${capActions.length}`,
          `
import * as fs from "node:fs";
import * as path from "node:path";
fs.writeFileSync(path.join(${JSON.stringify(ctx.root)}, "app.ts"), "export const broken = ${capActions.length};\\n");
`,
        );
        return { command: "bun", args: [s], displayCommand: "mock-cap-fix-broken" };
      },
    });
    await capExec.startRun({ root: repo, requirementId: "REQ-002", action: "implement" });
    await waitUntil(
      () => {
        const r = getRequirement(repo, "REQ-002").state.agentRuns ?? [];
        return r.length >= 4 && r.every((x) => x.status !== "running");
      },
      12000,
      "implement + review + block-fix + 1 rescue",
    );
    await new Promise((r) => setTimeout(r, 250));
    // Must stop at exactly 4 runs: implement -> review(block) -> fix(auto_review_fix) -> fix(1 rescue), NOT a 2nd rescue!
    expect(capActions).toEqual(["implement", "review", "fix", "fix"]);
  }, 25_000);

  test("regression guards: failed setupScript blocks re-approve, reviewFormatRescue preserves cycle cap, worktree-off degrades re-review, Git identity & copy-secret guards hold", async () => {
    // 1. setupScript failure blocks second POST /approve until retry/ignore resolves it
    const repo = makeGitRepo("reg-guards");
    await initProject(repo, { name: "RegGuards", privacyMode: "local" });
    await updateProjectConfig(repo, { worktree: { enabled: true, setupScript: "exit 1" } });
    await createRequirement(repo, {
      goal: "Test failed setup gating",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Plan\nSetup gate.", actor: "agent" });
    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, hubMode: false });
    servers.push(server);

    const app1 = await apiJson(`${server.url}/api/requirements/REQ-001/approve`, { method: "POST", body: "{}" });
    expect(app1.status).toBe(500);
    expect(((app1.body.error as Record<string, unknown>)?.details as Record<string, unknown>)?.setupFailed).toBe(true);
    // Second approve attempt MUST still reject instead of silently bypassing failed setupScript!
    const app2 = await apiJson(`${server.url}/api/requirements/REQ-001/approve`, { method: "POST", body: "{}" });
    expect(app2.status).toBe(500);
    expect(((app2.body.error as Record<string, unknown>)?.details as Record<string, unknown>)?.setupFailed).toBe(true);
    expect(getRequirement(repo, "REQ-001").state.stage).toBe("planning");

    // Ignore setup failure -> approve succeeds
    const ign = await apiJson(`${server.url}/api/requirements/REQ-001/sandbox/setup`, {
      method: "POST",
      body: JSON.stringify({ action: "ignore" }),
    });
    expect(ign.status).toBe(200);
    const app3 = await apiJson(`${server.url}/api/requirements/REQ-001/approve`, { method: "POST", body: "{}" });
    expect(app3.status).toBe(200);
    expect(getRequirement(repo, "REQ-001").state.stage).toBe("coding");

    // 2. WIP commit preserves repo git config user.name/email
    const wt1 = resolveCodeRoot(repo, "REQ-001");
    fs.writeFileSync(path.join(wt1, "app.ts"), "export const v = 99;\n");
    const wip = await commitSandboxWipCheckpoint(repo, "REQ-001", { action: "implement", runId: "RUN-ID", status: "succeeded" });
    expect(wip.committed).toBe(true);
    const author = execFileSync("git", ["-C", wt1, "log", "-1", "--format=%an <%ae>"], { encoding: "utf8" }).trim();
    expect(author).toBe("Test <test@example.com>");

    // 3. reviewFormatRescue preserves reviewFixCycle=1 so block does NOT trigger a 2nd fix round
    const harnesses = [
      makeHarness("codex", [{ id: "gpt-6-astra", tier: "sota" }]),
      makeHarness("qodercn", [{ id: "Qwen4-Max", tier: "balanced" }]),
    ];
    const routing = buildInitialProjectRouting(harnesses);
    routing.autoReview = true;
    routing.autoHeal = true;
    routing.defaultLead = { primary: { harness: "qodercn", model: "Qwen4-Max" }, fallbacks: [] };
    routing.reviewer = { primary: { harness: "codex", model: "gpt-6-astra" }, fallbacks: [] };
    await updateProjectConfig(repo, { routing, worktree: { enabled: false } });

    await createRequirement(repo, {
      goal: "Format rescue preserves cycle cap",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-002", { designMarkdown: "# Plan\nCycle cap.", actor: "agent" });
    await approveDesign(repo, "REQ-002");

    let reviewCalls = 0;
    let fixCalls = 0;
    const rescueCtxs: Array<{ action: string; nativeSessionId?: string; inc?: string | null }> = [];
    const exec = new HubExecutor({
      initialHarnesses: harnesses,
      commandBuilder: (_t, ctx) => {
        rescueCtxs.push({
          action: ctx.action,
          nativeSessionId: ctx.nativeSessionId,
          inc: ctx.prompt.includes("本轮复审增量范围") ? "inc" : null,
        });
        if (ctx.action === "implement") {
          const s = writeScript(
            "cap-r-impl",
            `import * as fs from "node:fs"; import * as path from "node:path"; fs.writeFileSync(path.join(${JSON.stringify(ctx.root)}, "app.ts"), "export const v = 2;\\n");`,
          );
          return { command: "bun", args: [s], displayCommand: "mock-impl" };
        }
        if (ctx.action === "fix") {
          fixCalls += 1;
          const s = writeScript(
            `cap-r-fix-${fixCalls}`,
            `import * as fs from "node:fs"; import * as path from "node:path"; fs.writeFileSync(path.join(${JSON.stringify(ctx.root)}, "app.ts"), "export const v = ${fixCalls + 2};\\n");`,
          );
          return { command: "bun", args: [s], displayCommand: "mock-fix" };
        }
        reviewCalls += 1;
        if (reviewCalls === 1) {
          return {
            command: "bash",
            args: [
              "-c",
              `printf '%s\\n' '{"type":"thread.started","thread_id":"ses_rev_rescue_1"}' '\`\`\`json' '{"verdict":"block","summary":"first block"}' '\`\`\`'`,
            ],
            displayCommand: "mock-rev-1",
          };
        }
        if (reviewCalls === 2) {
          // Missing JSON fence -> triggers reviewFormatRescue
          return {
            command: "bash",
            args: ["-c", `printf '%s\\n' '{"type":"thread.started","thread_id":"ses_rev_rescue_2"}' 'I reviewed the code and found more issues, detailed analysis exceeds 80 chars for format rescue trigger.'`],
            displayCommand: "mock-rev-2-nojson",
          };
        }
        // Rescued format still returns block -> MUST stop at cycle 1, NOT start fix #2!
        return {
          command: "bash",
          args: ["-c", `printf '%s\\n' '\`\`\`json' '{"verdict":"block","summary":"still blocked"}' '\`\`\`'`],
          displayCommand: "mock-rev-rescue",
        };
      },
    });
    await exec.startRun({ root: repo, requirementId: "REQ-002", action: "implement" });
    await waitUntil(
      () => {
        const d = getRequirement(repo, "REQ-002");
        const runs = d.state.agentRuns ?? [];
        return Boolean(d.state.needsHuman) && runs.length >= 5 && runs.every((r) => r.status !== "running");
      },
      12_000,
      "format rescue loop stop",
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(fixCalls).toBe(1);
    expect(reviewCalls).toBe(3);
    // Worktree is disabled -> round-2 review (call index 2) must degrade to fresh_handoff (no nativeSessionId, no incremental diff)
    expect(rescueCtxs[2]?.nativeSessionId).toBeUndefined();
    expect(rescueCtxs[2]?.inc).toBeNull();
    expect(getRequirement(repo, "REQ-002").state.needsHuman?.source).toBe("review_loop_exhausted");
  }, 25_000);
});
