import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  acceptRequirement,
  appendBugRegressionCriteria,
  appendProjectPlaybookLesson,
  approveDesign,
  authorizeFastTrack,
  createRequirement,
  getRequirement,
  initProject,
  propose,
  readProjectPlaybook,
  recordDesignReviewReport,
  reopenRequirement,
  requestChanges,
  revisePlan,
  updateProjectConfig,
} from "../../src/core/engine.ts";
import { observeGitSnapshot } from "../../src/core/git.ts";
import { runVerification } from "../../src/core/runner.ts";
import { getSandboxForRequirement, resolveCodeRoot } from "../../src/core/sandbox.ts";
import { buildExecutionPrompt, HubExecutor } from "../../src/hub/executor.ts";
import { synthesizeHandoffPacket } from "../../src/hub/handoff.ts";
import { appendRunLedger, computeTuningReport } from "../../src/hub/ledger.ts";
import { buildInitialProjectRouting } from "../../src/hub/routing.ts";
import type { HarnessInfo } from "../../src/hub/types.ts";
import { executeWorkbenchTool } from "../../src/mcp/tools.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";

const tempDirs: string[] = [];
const servers: WorkbenchServerHandle[] = [];
const origHubDir = process.env.WORKBENCH_HUB_DIR;
const origChromePath = process.env.WORKBENCH_CHROME_PATH;

function makeTempHub(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-fp3-hub-"));
  tempDirs.push(dir);
  process.env.WORKBENCH_HUB_DIR = dir;
  return dir;
}

function makeGitRepo(name = "repo"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wb-fp3-${name}-`));
  tempDirs.push(dir);
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, ".gitignore"), ".env\n");
  fs.writeFileSync(path.join(dir, "app.ts"), "export const v = 1;\n");
  execFileSync("git", ["add", ".gitignore", "app.ts"], { cwd: dir, stdio: "ignore" });
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

async function apiJson(url: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const resp = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await resp.json()) as Record<string, unknown>;
  return { status: resp.status, body };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 12_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
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

describe("Flow Phase 3 (WB-21 – WB-24)", () => {
  test("WB-21: kind=bug single-session closure, append-only regression criteria, auto-review decoupling, pause & convert to plan_first", async () => {
    const repo = makeGitRepo("wb21");
    const routing = {
      ...buildInitialProjectRouting(),
      defaultLead: { primary: { harness: "qodercn" as const, model: "Qwen4-Max" }, fallbacks: [] },
      sotaLead: { primary: { harness: "codex" as const, model: "gpt-6.1-sol" }, fallbacks: [] },
      reviewer: { primary: { harness: "codex" as const, model: "codex-auto-review" }, fallbacks: [] },
      autoReview: true,
      autoHeal: false,
    };
    await initProject(repo, { name: "Wb21Repo", privacyMode: "local", routing });
    await updateProjectConfig(repo, { verification: { fastCommand: "echo baseline-ok" } });

    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, hubMode: false });
    servers.push(server);

    // 1. Create Bug (record only) vs Create & start immediately
    const recBug = await apiJson(`${server.url}/api/requirements`, {
      method: "POST",
      body: JSON.stringify({ goal: "修复导出 CSV 含逗号字段错位 Bug", kind: "bug" }),
    });
    expect(recBug.status).toBe(201);
    const req1 = getRequirement(repo, "REQ-001");
    expect(req1.state.kind).toBe("bug");
    expect(req1.state.stage).toBe("planning");
    expect(req1.validity.banner.primaryAction?.id).toBe("authorize_fast_track");
    expect(req1.validity.banner.primaryAction?.labelKey).toBe("core.action.startBugFix");

    // Authorize bug fix via fast-track -> enters coding directly with default sandbox & baseline AC-1
    const authRes = await apiJson(`${server.url}/api/requirements/REQ-001/fast-track`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(authRes.status).toBe(200);
    expect(getRequirement(repo, "REQ-001").state.stage).toBe("coding");
    expect(getSandboxForRequirement(repo, "REQ-001")).not.toBeNull();
    // Only generic baseline AC-1 so far -> baselineOnlyWarning is true!
    expect(getRequirement(repo, "REQ-001").validity.baselineOnlyWarning).toBe(true);

    // 2. Append-only regression test criteria in coding: succeeds WITHOUT invalidating approval
    const appendRes = await apiJson(`${server.url}/api/requirements/REQ-001/bug-criteria`, {
      method: "POST",
      body: JSON.stringify({
        criteria: [{ id: "AC-2", description: "CSV 含逗号回归测试通过", required: true, command: "echo regression-ok" }],
      }),
    });
    expect(appendRes.status).toBe(200);
    const afterAppend = getRequirement(repo, "REQ-001");
    expect(afterAppend.state.stage).toBe("coding");
    expect(afterAppend.validity.approval.valid).toBe(true);
    expect(afterAppend.state.criteria.map((c) => c.id)).toEqual(["AC-1", "AC-2"]);
    // Now has dedicated regression test -> baselineOnlyWarning flips to false!
    expect(afterAppend.validity.baselineOnlyWarning).toBe(false);

    // Forbid deleting or weakening existing criteria via propose / appendBugRegressionCriteria
    await expect(
      propose(repo, "REQ-001", {
        criteria: [{ id: "AC-2", description: "CSV 含逗号回归测试通过", required: true, command: "echo regression-ok" }],
        actor: "agent",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      appendBugRegressionCriteria(repo, "REQ-001", {
        criteria: [{ id: "AC-1", description: "try overwrite", required: false, command: "echo nope" }],
        actor: "agent",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    // Bug prompt includes single-session closure + workbench-pause instructions
    const bugHandoff = await synthesizeHandoffPacket(repo, "REQ-001", { action: "implement" });
    const bugPrompt = buildExecutionPrompt(afterAppend, bugHandoff.markdown, {
      root: repo,
      requirementId: "REQ-001",
      action: "implement",
    });
    expect(bugPrompt).toContain("复现定位");
    expect(bugPrompt).toContain("workbench-pause");

    // 3. Auto-review decoupling: Bug (track=fast_track) DOES auto-trigger heterogeneous review; feature fast_track does NOT!
    const dispatchedActions: string[] = [];
    const executor = new HubExecutor({
      initialHarnesses: [
        makeHarness("qodercn", [{ id: "Qwen4-Max", tier: "balanced" }]),
        makeHarness("codex", [{ id: "codex-auto-review", tier: "review" }, { id: "gpt-6.1-sol", tier: "sota" }]),
      ],
      commandBuilder: (target, ctx) => {
        dispatchedActions.push(`${ctx.action}@${target.harness}:${ctx.root}`);
        if (ctx.action === "review") {
          return {
            command: "bash",
            args: [
              "-c",
              'printf \'%s\\n\' \'```json\' \'{"verdict":"pass","summary":"回归测试充分，修复干净","findings":[]}\' \'```\'',
            ],
            displayCommand: "mock-bug-review",
          };
        }
        return {
          command: "bash",
          args: ["-c", `printf 'export const v = 2;\\n' > app.ts && echo fixed`],
          displayCommand: "mock-bug-impl",
        };
      },
    });

    await executor.startRun({ root: repo, requirementId: "REQ-001", action: "implement" });
    await waitUntil(() => Boolean(getRequirement(repo, "REQ-001").state.reviewReport), 12_000, "bug auto-review");
    const reviewedBug = getRequirement(repo, "REQ-001");
    expect(reviewedBug.state.reviewReport?.verdict).toBe("pass");
    expect(reviewedBug.state.reviewReport?.reviewerHarness).toBe("codex");

    // Compare with regular feature + fast_track: must NOT auto-trigger review
    const featFt = await createRequirement(repo, {
      goal: "调整按钮文案",
      kind: "feature",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok", systemInjected: true }],
    });
    await authorizeFastTrack(repo, featFt.state.id, { baseline: await observeGitSnapshot(repo) });
    await executor.startRun({ root: repo, requirementId: featFt.state.id, action: "implement" });
    await waitUntil(
      () => getRequirement(repo, featFt.state.id).state.agentRuns?.some((r) => r.status === "succeeded") ?? false,
      10_000,
      "feature fast_track implement",
    );
    await new Promise((r) => setTimeout(r, 250));
    expect(getRequirement(repo, featFt.state.id).state.reviewReport ?? null).toBeNull();

    // 4. Bug pause via `workbench-pause` block -> sets needsHuman.source="bug_pause" without mutating stage;
    // then human can supply info (stay coding) OR convert to plan_first (preserves kind="bug")!
    const createdAndStarted = await apiJson(`${server.url}/api/requirements`, {
      method: "POST",
      body: JSON.stringify({
        goal: "偶现并发死锁 Bug",
        kind: "bug",
        startImmediately: true,
        createSandbox: false,
      }),
    });
    expect(createdAndStarted.status).toBe(201);
    const bug3Id = (createdAndStarted.body.detail as { state: { id: string } }).state.id;
    expect(getRequirement(repo, bug3Id).state.stage).toBe("coding");

    const pauseExec = new HubExecutor({
      initialHarnesses: [makeHarness("qodercn", [{ id: "Qwen4-Max", tier: "balanced" }])],
      commandBuilder: () => ({
        command: "bash",
        args: [
          "-c",
          'printf \'%s\\n\' \'```workbench-pause\' \'{"reason":"本地无法复现且疑似涉及公共存储契约调整"}\' \'```\'',
        ],
        displayCommand: "mock-bug-pause",
      }),
    });
    await pauseExec.startRun({ root: repo, requirementId: bug3Id, action: "implement" });
    await waitUntil(() => getRequirement(repo, bug3Id).state.needsHuman?.source === "bug_pause", 10_000, "bug_pause");
    const pausedBug = getRequirement(repo, bug3Id);
    expect(pausedBug.state.stage).toBe("coding"); // Agent NEVER mutated stage!
    expect(pausedBug.validity.needsDecision).toBe(true);
    expect(pausedBug.validity.decisionReasonKey).toBe("core.decision.bugPaused");

    // Path A: human supplies extra info -> clears needsHuman and stays in coding
    await requestChanges(repo, bug3Id, { feedback: "复现条件：并发写入 5 个请求即可触发" });
    const resumedBug = getRequirement(repo, bug3Id);
    expect(resumedBug.state.stage).toBe("coding");
    expect(resumedBug.state.needsHuman).toBeNull();

    // Path B: human converts Bug to standard plan flow -> stage=planning, track=plan_first, kind STILL "bug"!
    await revisePlan(repo, bug3Id, { reason: "涉及公共存储契约变更，转为常规方案流程" });
    const converted = getRequirement(repo, bug3Id);
    expect(converted.state.stage).toBe("planning");
    expect(converted.state.track).toBe("plan_first");
    expect(converted.state.kind).toBe("bug");
  }, 30_000);

  test("WB-22: on-demand & SOTA auto heterogeneous design review, stale tracking, non-blocking block verdict, and isolation from coding review", async () => {
    const repo = makeGitRepo("wb22");
    const routing = {
      ...buildInitialProjectRouting(),
      defaultLead: { primary: { harness: "qodercn" as const, model: "Qwen4-Max" }, fallbacks: [] },
      sotaLead: { primary: { harness: "qodercn" as const, model: "DeepSeek-V4-Pro" }, fallbacks: [] },
      reviewer: { primary: { harness: "codex" as const, model: "codex-auto-review" }, fallbacks: [] },
      autoReview: true,
      autoHeal: false,
    };
    await initProject(repo, { name: "Wb22Repo", privacyMode: "local", routing });

    const executor = new HubExecutor({
      initialHarnesses: [
        makeHarness("qodercn", [{ id: "Qwen4-Max", tier: "balanced" }, { id: "DeepSeek-V4-Pro", tier: "sota" }]),
        makeHarness("codex", [{ id: "codex-auto-review", tier: "review" }]),
      ],
      commandBuilder: (_target, ctx) => {
        if (ctx.action === "design") {
          const designFile = path.join(repo, ".workbench/items", ctx.prompt.includes("REQ-001") ? "REQ-001" : "REQ-002", "design.md");
          const md = `# 方案 v1\n\n\`\`\`workbench-criteria\n[{"id":"AC-1","description":"ok","required":true,"command":"echo ok"}]\n\`\`\`\n`;
          return {
            command: "bash",
            args: ["-c", `cat <<'EOF' > ${JSON.stringify(designFile)}\n${md}\nEOF\necho design-done`],
            displayCommand: "mock-design",
          };
        }
        return {
          command: "bash",
          args: [
            "-c",
            'printf \'%s\\n\' \'```json\' \'{"verdict":"block","summary":"建议拆分持久化接口以降低耦合","findings":[{"id":"DF-1","severity":"high","title":"模块边界不清","suggestion":"拆出独立 Store 层"}]}\' \'```\'',
          ],
          displayCommand: "mock-design-review-block",
        };
      },
    });

    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, hubMode: false, executor });
    servers.push(server);

    // 1. SOTA requirement automatically triggers heterogeneous design review after `design` succeeds
    await createRequirement(repo, { goal: "设计分布式任务调度核心架构", tier: "sota" });
    await executor.startRun({ root: repo, requirementId: "REQ-001", action: "design" });
    await waitUntil(() => Boolean(getRequirement(repo, "REQ-001").state.designReviewReport), 12_000, "sota auto design review");
    const sotaReviewed = getRequirement(repo, "REQ-001");
    expect(sotaReviewed.state.designReviewReport?.verdict).toBe("block");
    expect(sotaReviewed.state.designReviewReport?.reviewerHarness).toBe("codex");
    expect(sotaReviewed.validity.designReviewValidity?.effectiveState).toBe("current");
    // Strictly isolated from coding reviewReport!
    expect(sotaReviewed.state.reviewReport ?? null).toBeNull();
    expect(sotaReviewed.validity.reviewValidity.effectiveState).toBe("missing");

    // 2. Non-blocking approval: even with designReviewReport.verdict === "block", approveDesign succeeds with ZERO overrideReason!
    const baseSnap = await observeGitSnapshot(repo);
    await approveDesign(repo, "REQ-001", { baseline: baseSnap });
    expect(getRequirement(repo, "REQ-001").state.stage).toBe("coding");

    // After coding & verification, acceptRequirement ALSO succeeds with ZERO overrideReason (designReview block NEVER leaks into coding review gate!)
    fs.writeFileSync(path.join(repo, "app.ts"), "export const v = 2;\n");
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const accSnap = await observeGitSnapshot(repo);
    const accepted = await acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: accSnap!.fingerprint });
    expect(accepted.state.stage).toBe("done");

    // 3. Regular standard plan_first does NOT auto-trigger design review; human triggers on-demand via POST /design-review
    await createRequirement(repo, { goal: "新增列表筛选条件", tier: "standard" });
    await executor.startRun({ root: repo, requirementId: "REQ-002", action: "design" });
    await waitUntil(() => getRequirement(repo, "REQ-002").state.designVersion >= 1, 10_000, "standard design");
    await new Promise((r) => setTimeout(r, 250));
    expect(getRequirement(repo, "REQ-002").state.designReviewReport ?? null).toBeNull();

    const triggerRes = await apiJson(`${server.url}/api/requirements/REQ-002/design-review`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(triggerRes.status).toBe(202);
    await waitUntil(() => Boolean(getRequirement(repo, "REQ-002").state.designReviewReport), 10_000, "on-demand design review");
    expect(getRequirement(repo, "REQ-002").validity.designReviewValidity?.effectiveState).toBe("current");

    // 4. Updating design marks designReviewValidity as STALE automatically
    await propose(repo, "REQ-002", {
      designMarkdown: "# 方案 v2（已根据评审拆分边界）",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    expect(getRequirement(repo, "REQ-002").validity.designReviewValidity?.effectiveState).toBe("stale");
  }, 30_000);

  test("WB-23 & WB-24: playbook lesson capture (zero git/snapshot pollution + instant handoff injection), tuning report with unknown telemetry, and docs link integrity", async () => {
    const hubDir = makeTempHub();
    const repo = makeGitRepo("wb24");
    await initProject(repo, { name: "Wb24Repo", privacyMode: "local" });
    await updateProjectConfig(repo, { verification: { fastCommand: "echo fast-ok" } });
    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, hubMode: false });
    servers.push(server);

    // Create fast_track requirement with only generic baseline -> WB-23 baselineOnlyWarning === true
    await createRequirement(repo, { goal: "更新页脚版权年份" });
    await authorizeFastTrack(repo, "REQ-001", { baseline: await observeGitSnapshot(repo) });
    expect(getRequirement(repo, "REQ-001").validity.baselineOnlyWarning).toBe(true);

    // 1. Capture code snapshot before playbook edits -> playbook must NEVER dirty Git or alter code snapshot!
    const snapBefore = await observeGitSnapshot(repo);
    const gitStatusBefore = execFileSync("git", ["status", "--short"], { cwd: repo, encoding: "utf8" });

    // Request changes with rememberLesson=true -> appends to .workbench/playbook.md
    const rcRes = await apiJson(`${server.url}/api/requirements/REQ-001/request-changes`, {
      method: "POST",
      body: JSON.stringify({
        feedback: "所有外部 API 调用必须设置超时上限，避免挂起",
        rememberLesson: true,
      }),
    });
    expect(rcRes.status).toBe(200);

    // Verify & accept with rememberLesson=true
    fs.writeFileSync(path.join(repo, "app.ts"), "export const v = 2;\n");
    await runVerification(repo, "REQ-001", { command: "echo fast-ok", criterionIds: ["AC-1"] });
    const accSnap = await observeGitSnapshot(repo);
    const accRes = await apiJson(`${server.url}/api/requirements/REQ-001/accept`, {
      method: "POST",
      body: JSON.stringify({
        note: "前端禁止引入 node:crypto 等核心服务端模块到浏览器包",
        rememberLesson: true,
      }),
    });
    expect(accRes.status).toBe(200);

    // Append review_block lesson directly via API + deduplication check
    const pbRes1 = await apiJson(`${server.url}/api/project/playbook/lessons`, {
      method: "POST",
      body: JSON.stringify({
        lesson: "修改验证快照指纹算法时必须保留末尾换行一致",
        source: "review_block",
        requirementId: "REQ-001",
      }),
    });
    expect(pbRes1.status).toBe(201);
    const pbResDup = await apiJson(`${server.url}/api/project/playbook/lessons`, {
      method: "POST",
      body: JSON.stringify({
        lesson: "修改验证快照指纹算法时必须保留末尾换行一致",
        source: "review_block",
        requirementId: "REQ-001",
      }),
    });
    expect(pbResDup.status).toBe(200);
    expect(pbResDup.body.added).toBe(false);

    const pb = readProjectPlaybook(repo);
    expect(pb.lessons.length).toBe(3);
    expect(pb.markdown).toContain("所有外部 API 调用必须设置超时上限");
    expect(pb.markdown).toContain("前端禁止引入 node:crypto");
    expect(pb.markdown).toContain("修改验证快照指纹算法时必须保留末尾换行一致");

    // Verify .workbench/playbook.md never dirtied Git or changed code snapshot
    const snapAfterPlaybookOnly = await observeGitSnapshot(repo);
    expect(snapAfterPlaybookOnly?.fingerprint).toBe(accSnap?.fingerprint);
    expect(gitStatusBefore).toBe("");
    expect(
      execFileSync("git", ["status", "--short"], { cwd: repo, encoding: "utf8" })
        .split("\n")
        .filter((l) => l.includes("playbook.md")),
    ).toEqual([]);

    // Verify immediate injection into next non-review handoff, and omission during blind review!
    await createRequirement(repo, { goal: "新需求验证 Playbook 自动注入" });
    const implHandoff = await synthesizeHandoffPacket(repo, "REQ-002", { action: "design" });
    expect(implHandoff.markdown).toContain("项目经验法则");
    expect(implHandoff.markdown).toContain("所有外部 API 调用必须设置超时上限");
    const reviewHandoff = await synthesizeHandoffPacket(repo, "REQ-002", { action: "review" });
    expect(reviewHandoff.markdown).not.toContain("项目经验法则");

    // 2. Tuning report (`computeTuningReport` + `scripts/tuning-report.ts --json`):
    // Reopen REQ-001 once so reopenRateAfterAccept is measurable, and create a Bug item with missing token telemetry
    await reopenRequirement(repo, "REQ-001", { reason: "补充边界检查" });
    await createRequirement(repo, { goal: "修复空指针 Bug", kind: "bug" });

    appendRunLedger(
      {
        schemaVersion: 1,
        runId: "RUN-T1",
        projectRoot: repo,
        nodeId: "local",
        requirementId: "REQ-001",
        action: "implement",
        harness: "qodercn",
        model: "Qwen4-Max",
        quotaPool: "qoder-cn",
        billingMode: "subscription",
        status: "succeeded",
        startedAt: Date.now() - 2000,
        endedAt: Date.now() - 1000,
        durationMs: 1000,
        usage: {
          inputTokens: 1000,
          uncachedInputTokens: 600,
          cacheReadTokens: 400,
          cacheWriteTokens: 0,
          outputTokens: 200,
          reasoningTokens: 0,
          totalTokens: 1200,
        },
        apiCostUsd: 0,
        equivalentCostUsd: 0.01,
        costSource: "estimated",
        turnsCount: 2,
        toolCallsCount: 3,
        toolErrorCount: 0,
        compactionCount: 0,
      },
    );
    // Run with MISSING token usage -> MUST be counted in unknownTokenRuns & observableTokensTotal === null for that harness!
    appendRunLedger(
      {
        schemaVersion: 1,
        runId: "RUN-T2",
        projectRoot: repo,
        nodeId: "local",
        requirementId: "REQ-003",
        action: "implement",
        harness: "opencode",
        model: "opencode/deepseek-v4.1-flash-free",
        quotaPool: "opencode-free",
        billingMode: "free",
        status: "succeeded",
        startedAt: Date.now() - 1000,
        endedAt: Date.now(),
        durationMs: 1000,
        apiCostUsd: 0,
        equivalentCostUsd: 0,
        costSource: "free",
        turnsCount: 1,
        toolCallsCount: 1,
        toolErrorCount: 0,
        compactionCount: 0,
      },
    );

    const tuning = computeTuningReport({ roots: [repo], hubDir });
    expect(tuning.byTrack.map((b) => b.key)).toEqual(["plan_first", "fast_track", "bug"]);
    const ftBucket = tuning.byTrack.find((b) => b.key === "fast_track")!;
    expect(ftBucket.everAcceptedCount).toBe(1);
    expect(ftBucket.reopenedAfterAcceptCount).toBe(1);
    expect(ftBucket.reopenRateAfterAccept).toBe(1);
    expect(ftBucket.observableTokensTotal).toBe(1200);

    const bugBucket = tuning.byTrack.find((b) => b.key === "bug")!;
    expect(bugBucket.inProgressCount).toBe(1);
    expect(bugBucket.unknownTokenRuns).toBe(1);
    expect(bugBucket.observableTokensTotal).toBeNull(); // Explicitly unknown, NEVER 0!

    const opencodeStats = tuning.byHarness.find((h) => h.key === "opencode")!;
    expect(opencodeStats.unknownTokenRuns).toBe(1);
    expect(opencodeStats.observableTokensTotal).toBeNull();

    // CLI script runs cleanly and outputs valid JSON
    const scriptOut = execFileSync("bun", ["run", "scripts/tuning-report.ts", "--json", repo], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env, WORKBENCH_HUB_DIR: hubDir },
      encoding: "utf8",
    });
    const parsedScript = JSON.parse(scriptOut) as { totals: { requirements: number } };
    expect(parsedScript.totals.requirements).toBe(3);

    // 3. Docs consistency & link integrity check across docs/*.md
    const docsDir = path.resolve(import.meta.dir, "../../docs");
    const docFiles = fs.readdirSync(docsDir).filter((f) => f.endsWith(".md"));
    const brokenLinks: string[] = [];
    for (const file of docFiles) {
      const full = path.join(docsDir, file);
      const md = fs.readFileSync(full, "utf8");
      for (const match of md.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/g)) {
        const target = match[1]!.trim();
        if (!target || /^https?:\/\//i.test(target) || target.startsWith("mailto:")) continue;
        const resolved = path.resolve(docsDir, target);
        if (!fs.existsSync(resolved)) {
          brokenLinks.push(`${file} -> ${target}`);
        }
      }
    }
    expect(brokenLinks).toEqual([]);
    const designDoc = fs.readFileSync(path.join(docsDir, "DESIGN.md"), "utf8");
    expect(designDoc).not.toContain("sota_first");
    expect(designDoc).not.toContain("quota_saver");
    const contractDoc = fs.readFileSync(path.join(docsDir, "DOMAIN_CONTRACT.md"), "utf8");
    expect(contractDoc).toContain("designReviewReport");
    expect(contractDoc).toContain("playbook.md");
    expect(contractDoc).not.toContain("schemaVersion: 4");
  }, 20_000);

  test("regression guards: Bug workbench-pause preempts autoHeal, inline criteria respects append-only guard, wb_propose/wb_get support manual & decisions", async () => {
    const repo = makeGitRepo("fp3-reg");
    const harnesses = [
      makeHarness("qodercn", [{ id: "Qwen4-Max", tier: "balanced" }]),
      makeHarness("codex", [{ id: "gpt-6.1-sol", tier: "sota" }]),
    ];
    const routing = buildInitialProjectRouting(harnesses);
    routing.autoReview = false;
    routing.autoHeal = true;
    routing.defaultLead = { primary: { harness: "qodercn", model: "Qwen4-Max" }, fallbacks: [] };
    await initProject(repo, { name: "Fp3RegRepo", privacyMode: "local", routing });

    // 1. wb_propose supports kind="manual", steps, and decisions; wb_get exposes new fields
    await createRequirement(repo, { goal: "Manual + decision via MCP" });
    const mcpProp = (await executeWorkbenchTool(repo, "wb_propose", {
      id: "REQ-001",
      design: "# Design\nWith manual check and decision card.",
      criteria: [
        { id: "AC-1", description: "Auto test", required: true, command: "echo ok" },
        { id: "AC-2", description: "Manual UI check", required: true, kind: "manual", steps: "Inspect modal" },
      ],
      decisions: [
        {
          id: "D-1",
          question: "Pick storage?",
          options: [
            { id: "json", label: "JSON", recommended: true },
            { id: "sqlite", label: "SQLite" },
          ],
        },
      ],
    })) as { stage: string };
    expect(mcpProp.stage).toBe("planning");
    const mcpGot = (await executeWorkbenchTool(repo, "wb_get", { id: "REQ-001" })) as {
      kind: string;
      originalGoal: string;
      pendingDecisions: Array<{ id: string }>;
    };
    expect(mcpGot.kind).toBe("feature");
    expect(mcpGot.originalGoal).toBe("Manual + decision via MCP");
    expect(mcpGot.pendingDecisions).toHaveLength(1);

    // 2. Bug inline workbench-criteria cannot bypass append-only guard in coding
    await createRequirement(repo, {
      goal: "Bug pause + append-only",
      kind: "bug",
      criteria: [{ id: "AC-1", description: "Failing repro", required: true, command: "false" }],
    });
    await authorizeFastTrack(repo, "REQ-002", { baseline: await observeGitSnapshot(repo) });
    await expect(
      propose(repo, "REQ-002", {
        designMarkdown:
          '# Bug\n```workbench-criteria\n[{"id":"AC-2","description":"only new","command":"echo ok","required":true}]\n```',
        actor: "agent",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    // 3. Bug workbench-pause preempts runCodingPostGate & autoHeal even when AC-1 fails
    const pauseScript = path.join(process.env.WORKBENCH_HUB_DIR!, "bug-pause.mjs");
    fs.writeFileSync(
      pauseScript,
      `console.log('Reproduced bug, requires public API change.\\n\`\`\`workbench-pause\\n{"reason":"Requires breaking API schema change"}\\n\`\`\`');\n`,
    );
    const bugExec = new HubExecutor({
      initialHarnesses: harnesses,
      commandBuilder: () => ({ command: "bun", args: [pauseScript], displayCommand: "mock-bug-pause" }),
    });
    await bugExec.startRun({ root: repo, requirementId: "REQ-002", action: "implement" });
    await waitUntil(
      () => {
        const d = getRequirement(repo, "REQ-002");
        return Boolean(d.state.needsHuman) && (d.state.agentRuns ?? []).every((r) => r.status !== "running");
      },
      10_000,
      "bug_pause escalation without autoHeal",
    );
    await new Promise((r) => setTimeout(r, 200));
    const bugDetail = getRequirement(repo, "REQ-002");
    expect(bugDetail.state.agentRuns).toHaveLength(1); // No autoHeal fix run launched!
    expect(bugDetail.state.needsHuman?.source).toBe("bug_pause");
    expect(bugDetail.state.needsHuman?.reason).toContain("Requires breaking API schema change");
  }, 20_000);
});
