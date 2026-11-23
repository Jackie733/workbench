import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  acceptRequirement,
  addDiscussion,
  approveDesign,
  createRequirement,
  getRequirement,
  initProject,
  propose,
  recordReviewReport,
  requestChanges,
  updateTasks,
} from "../../src/core/engine.ts";
import { observeGitSnapshot } from "../../src/core/git.ts";
import { buildRequirementPrBody } from "../../src/core/github.ts";
import { distillRequirementToPlaybook, readPlaybook } from "../../src/core/playbook.ts";
import { runVerification } from "../../src/core/runner.ts";
import {
  applySandboxToMain,
  createOrReuseWorktree,
  inspectRsiSandboxDrift,
  reconcileRsiSandboxBaseline,
  syncRequirementMirrorToSandbox,
  syncRsiSandboxBase,
} from "../../src/hub/evolution.ts";
import { buildExecutionPrompt, HubExecutor } from "../../src/hub/executor.ts";
import { synthesizeHandoffPacket } from "../../src/hub/handoff.ts";
import { buildPresetRouting } from "../../src/hub/routing.ts";

const tempDirs: string[] = [];
const origHubDir = process.env.WORKBENCH_HUB_DIR;
const origRsiDepth = process.env.WORKBENCH_RSI_DEPTH;

function makeTempHub(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-rev-hub-"));
  tempDirs.push(dir);
  process.env.WORKBENCH_HUB_DIR = dir;
  return dir;
}

function makeGitRepo(name = "workbench"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wb-rev-${name}-`));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "workbench", version: "5.0.0" }, null, 2));
  fs.writeFileSync(path.join(dir, "app.ts"), "export const v = 1;\n");
  fs.writeFileSync(path.join(dir, "other.ts"), "export const other = 1;\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

beforeEach(() => {
  delete process.env.WORKBENCH_RSI_DEPTH;
});

afterEach(() => {
  if (origHubDir === undefined) delete process.env.WORKBENCH_HUB_DIR;
  else process.env.WORKBENCH_HUB_DIR = origHubDir;
  if (origRsiDepth === undefined) delete process.env.WORKBENCH_RSI_DEPTH;
  else process.env.WORKBENCH_RSI_DEPTH = origRsiDepth;
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("Review-aware workflow, priority handoff, session capture, and sandbox sync", () => {
  test("drives action banner across missing/block/concern/stale/pass and requires overrideReason on block", async () => {
    makeTempHub();
    const repo = makeGitRepo("banner");
    await initProject(repo, { name: "BannerTest", privacyMode: "local" });
    await createRequirement(repo, {
      goal: "Test review-aware banners",
      criteria: [{ id: "AC-1", description: "passes", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design\nSimple.", actor: "agent" });
    await approveDesign(repo, "REQ-001");
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const ready = await updateTasks(repo, "REQ-001", {
      tasks: [{ title: "done", status: "done" }],
      readyForAcceptance: true,
      currentCodeSnapshotHash: (await observeGitSnapshot(repo))!.fingerprint,
    });

    // 1. Missing review -> info banner recommending review while keeping accept available
    expect(ready.validity.reviewValidity.effectiveState).toBe("missing");
    expect(ready.validity.banner.tone).toBe("info");
    expect(ready.validity.banner.primaryAction?.id).toBe("dispatch_review");
    expect(ready.validity.banner.secondaryActions.some((a) => a.id === "accept")).toBe(true);

    const snapHash = (await observeGitSnapshot(repo))!.fingerprint;

    // 2. Blocking review with structured findings -> danger banner with dispatch_fix_review
    const blocked = await recordReviewReport(repo, "REQ-001", {
      reviewerHarness: "codex",
      reviewerModel: "gpt-6.2-sol",
      verdict: "block",
      summary: "跨标签页并发丢失收藏",
      markdown: "完整审查细节",
      findings: [
        {
          id: "F-1",
          severity: "high",
          title: "并发写会覆盖",
          criterionIds: ["AC-1"],
          files: ["app.ts:1"],
          suggestion: "改为逐键写入",
        },
        {
          id: "F-2",
          severity: "medium",
          title: "缺少边界单测",
          suggestion: "补充测试",
        },
      ],
      reviewedSpecHash: ready.state.specHash,
      reviewedCodeSnapshotHash: snapHash,
    });
    expect(blocked.validity.reviewValidity.effectiveState).toBe("current");
    expect(blocked.validity.banner.tone).toBe("danger");
    expect(blocked.validity.decisionReason).toBe("审查建议阻塞");
    expect(blocked.validity.banner.headline).toContain("高 1 / 中 1");
    expect(blocked.validity.banner.primaryAction?.id).toBe("dispatch_fix_review");

    // 3. Cannot accept over current block review without overrideReason
    await expect(acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: snapHash })).rejects.toMatchObject({
      code: "acceptance_gate_failed",
    });

    // 4. Concern review -> warning banner with dispatch_fix_review & accept override option
    const concern = await recordReviewReport(repo, "REQ-001", {
      reviewerHarness: "codex",
      reviewerModel: "gpt-6.2-sol",
      verdict: "concern",
      summary: "缺少一处非关键边界断言",
      markdown: "完整细节",
      reviewedSpecHash: ready.state.specHash,
      reviewedCodeSnapshotHash: snapHash,
    });
    expect(concern.validity.banner.tone).toBe("warning");
    expect(concern.validity.banner.primaryAction?.id).toBe("dispatch_fix_review");
    expect(concern.validity.banner.secondaryActions.some((a) => a.id === "accept")).toBe(true);

    // 5. Code edit + re-verify makes previous review stale -> primary becomes dispatch_review
    fs.writeFileSync(path.join(repo, "app.ts"), "export const v = 2;\n");
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const snapHash2 = (await observeGitSnapshot(repo))!.fingerprint;
    const staleDetail = getRequirement(repo, "REQ-001", { currentCodeSnapshotHash: snapHash2 });
    expect(staleDetail.validity.reviewValidity.effectiveState).toBe("stale");
    expect(staleDetail.validity.banner.tone).toBe("warning");
    expect(staleDetail.validity.banner.primaryAction?.id).toBe("dispatch_review");

    // 6. Passing review -> green success banner with accept primary action
    const passed = await recordReviewReport(repo, "REQ-001", {
      reviewerHarness: "codex",
      reviewerModel: "gpt-6.2-sol",
      verdict: "pass",
      summary: "所有检查通过",
      markdown: "LGTM",
      reviewedSpecHash: staleDetail.state.specHash,
      reviewedCodeSnapshotHash: snapHash2,
    });
    expect(passed.validity.banner.tone).toBe("success");
    expect(passed.validity.banner.primaryAction?.id).toBe("accept");

    // 7. Re-record block and accept WITH explicit overrideReason -> stored in acceptance & PR body
    await recordReviewReport(repo, "REQ-001", {
      reviewerHarness: "codex",
      reviewerModel: "gpt-6.2-sol",
      verdict: "block",
      summary: "仅剩测试环境差异",
      markdown: "详情",
      findings: [{ id: "F-9", severity: "high", title: "环境差异" }],
      reviewedSpecHash: staleDetail.state.specHash,
      reviewedCodeSnapshotHash: snapHash2,
    });
    const accepted = await acceptRequirement(repo, "REQ-001", {
      currentCodeSnapshotHash: snapHash2,
      overrideReason: "已在真实目标机人工验证通过",
      acceptedRisks: ["[high] F-9: 环境差异"],
    });
    expect(accepted.state.stage).toBe("done");
    expect(accepted.state.acceptance?.overrideReason).toBe("已在真实目标机人工验证通过");
    expect(accepted.state.acceptance?.reviewDisposition?.verdict).toBe("block");
    const prBody = buildRequirementPrBody(accepted);
    expect(prBody).toContain("人工风险放行说明");
    expect(prBody).toContain("已在真实目标机人工验证通过");
    expect(prBody).toContain("F-9");
  });

  test("priority-budgeted handoff preserves review findings, human feedback, and failures even with huge spec/design/diff", async () => {
    makeTempHub();
    const repo = makeGitRepo("handoff-budget");
    await initProject(repo, { name: "BudgetRepo", privacyMode: "local" });
    const hugeSpec = "# 规范\n" + "需求背景与详细规格段落。\n".repeat(900);
    const hugeDesign = "# 技术方案\n" + "架构与实现细节说明。\n".repeat(900);
    await createRequirement(repo, {
      goal: "Budgeted handoff test",
      criteria: [{ id: "AC-1", description: "must pass", required: true, command: "exit 1" }],
    });
    await propose(repo, "REQ-001", {
      specMarkdown: hugeSpec,
      designMarkdown: hugeDesign,
      handoffNote: { deadEnds: ["CRITICAL_DEAD_END_DO_NOT_REPEAT"] },
      actor: "agent",
    });
    await approveDesign(repo, "REQ-001");
    await runVerification(repo, "REQ-001", { command: "echo CRITICAL_FAILURE_TRACE && exit 1", criterionIds: ["AC-1"] });
    const snapHash = (await observeGitSnapshot(repo))!.fingerprint;
    await recordReviewReport(repo, "REQ-001", {
      reviewerHarness: "codex",
      reviewerModel: "gpt-6.2-sol",
      verdict: "block",
      summary: "CRITICAL_REVIEW_BLOCK_SUMMARY",
      markdown: "Detailed review body",
      findings: [{ id: "F-1", severity: "high", title: "CRITICAL_REVIEW_FINDING", suggestion: "Fix now" }],
      reviewedSpecHash: getRequirement(repo, "REQ-001").state.specHash,
      reviewedCodeSnapshotHash: snapHash,
    });
    await requestChanges(repo, "REQ-001", { feedback: "CRITICAL_HUMAN_FEEDBACK" });
    await addDiscussion(repo, "REQ-001", { actor: "human", mode: "refine", message: "CRITICAL_UNRESOLVED_NOTE" });

    // Create a large git diff too
    fs.writeFileSync(path.join(repo, "app.ts"), "export const x = 'diff';\n".repeat(500));

    const packet = await synthesizeHandoffPacket(repo, "REQ-001", {
      action: "fix",
      humanInstruction: "CRITICAL_HUMAN_INSTRUCTION",
    });

    expect(Buffer.byteLength(packet.markdown, "utf8")).toBeLessThanOrEqual(24 * 1024);
    expect(packet.markdown).toContain("CRITICAL_REVIEW_BLOCK_SUMMARY");
    expect(packet.markdown).toContain("CRITICAL_REVIEW_FINDING");
    expect(packet.markdown).toContain("CRITICAL_HUMAN_FEEDBACK");
    expect(packet.markdown).toContain("CRITICAL_HUMAN_INSTRUCTION");
    expect(packet.markdown).toContain("CRITICAL_UNRESOLVED_NOTE");
    expect(packet.markdown).toContain("CRITICAL_FAILURE_TRACE");
    expect(packet.markdown).toContain("CRITICAL_DEAD_END_DO_NOT_REPEAT");
    expect(packet.markdown).toContain(".workbench/items/REQ-001/spec.md");
    expect(packet.markdown).toContain(".workbench/items/REQ-001/design.md");

    const fixPrompt = buildExecutionPrompt(packet.detail, packet.markdown, {
      root: repo,
      requirementId: "REQ-001",
      action: "fix",
    });
    expect(fixPrompt).toContain("Code Review");
    // When review is stale and fresh human feedback exists, human steering precedes stale review history
    expect(packet.markdown.indexOf("人类最新指令与未解决批注（当前最高优先级）")).toBeLessThan(
      packet.markdown.indexOf("历史跨模型 Code Review"),
    );
    expect(fixPrompt).toContain("历史 Code Review 意见已过期仅供参考");
  });

  test("executor parses structured findings, ignores non-header session_id lines, and auto-triggers review on submit", async () => {
    makeTempHub();
    const repo = makeGitRepo("exec-review");
    await initProject(repo, { name: "ExecReview", privacyMode: "local" });
    await createRequirement(repo, {
      goal: "Auto review test",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design\nClean.", actor: "agent" });
    await approveDesign(repo, "REQ-001");
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });

    const seenActions: string[] = [];
    const cliScript = `
      const action = process.env.TEST_ACTION;
      if (action === "implement") {
        console.log("src/hub/executor.ts:829: nativeSessionId: canResumeSameHarness");
        console.log("session id: 01a1e74e-98bb-7503-97dd-e8709f8e5022");
        const { updateTasks } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../../src/core/engine.ts"))});
        const { observeGitSnapshot } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../../src/core/git.ts"))});
        const snap = await observeGitSnapshot(process.cwd());
        await updateTasks(process.cwd(), "REQ-001", {
          tasks: [{ title: "implemented", status: "done" }],
          readyForAcceptance: true,
          currentCodeSnapshotHash: snap.fingerprint,
        });
      } else if (action === "review") {
        console.log('Review findings:\\n\`\`\`json\\n{"verdict":"concern","summary":"需补充边界检查","findings":[{"id":"F-1","severity":"medium","title":"缺少空值保护","criterionIds":["AC-1"],"files":["app.ts:1"],"suggestion":"增加判空"}]}\\n\`\`\`');
      }
    `;
    const helperDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-rev-helper-"));
    tempDirs.push(helperDir);
    const scriptPath = path.join(helperDir, "mock_agent.ts");
    fs.writeFileSync(scriptPath, cliScript);

    const executor = new HubExecutor({
      initialHarnesses: [
        {
          id: "codex",
          label: "Codex",
          subscription: "Plus",
          installed: true,
          executable: "codex",
          models: [
            { id: "codex-auto-review", tier: "review", source: "detected" },
            { id: "gpt-6.2-sol", tier: "sota", source: "detected" },
          ],
          defaultModel: "gpt-6.2-sol",
          detectedAt: Date.now(),
        },
      ],
      getHubPreferences: () => ({ routing: { ...buildPresetRouting("balanced"), autoReview: true } }),
      commandBuilder: (_target, ctx) => {
        seenActions.push(ctx.action);
        return {
          command: "env",
          args: [`TEST_ACTION=${ctx.action}`, "bun", "run", scriptPath],
          displayCommand: `mock-${ctx.action}`,
        };
      },
    });

    const reviewFinished = new Promise<void>((resolve) => {
      executor.subscribe((ev) => {
        if (ev.type === "agent.run.finished" && ev.action === "review") {
          resolve();
        }
      });
    });

    await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "implement",
      harness: "codex",
      model: "gpt-6.2-sol",
    });

    await reviewFinished;
    // Wait briefly for post-review state write
    await new Promise((r) => setTimeout(r, 80));

    expect(seenActions).toEqual(["implement", "review"]);
    const detail = getRequirement(repo, "REQ-001", {
      currentCodeSnapshotHash: (await observeGitSnapshot(repo))!.fingerprint,
    });
    expect(detail.state.agentRuns?.[0]?.nativeSessionId).toBe("01a1e74e-98bb-7503-97dd-e8709f8e5022");
    expect(detail.state.reviewReport?.verdict).toBe("concern");
    expect(detail.state.reviewReport?.findings).toHaveLength(1);
    expect(detail.state.reviewReport?.findings?.[0]).toMatchObject({
      id: "F-1",
      severity: "medium",
      title: "缺少空值保护",
      criterionIds: ["AC-1"],
      files: ["app.ts:1"],
      suggestion: "增加判空",
    });
  });

  test("filters conversational noise from Playbook and safely syncs non-conflicting sandbox drift", async () => {
    makeTempHub();
    const repo = makeGitRepo("sandbox-sync");
    await initProject(repo, { name: "workbench", privacyMode: "local" });
    await createRequirement(repo, {
      goal: "Test playbook filter and sandbox sync",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design\nOk.", actor: "agent" });
    await approveDesign(repo, "REQ-001");
    await addDiscussion(repo, "REQ-001", { actor: "human", mode: "refine", message: "接纳，请你更新方案", resolved: true });
    await addDiscussion(repo, "REQ-001", {
      actor: "human",
      mode: "refine",
      message: "所有文件路径必须校验 canonicalRoot",
      resolved: true,
    });
    await requestChanges(repo, "REQ-001", { feedback: "审查结论：阻止验收。请修复问题" });
    const d1 = getRequirement(repo, "REQ-001");
    await distillRequirementToPlaybook(repo, d1);
    const pb = readPlaybook(repo);
    expect(pb.markdown).toContain("canonicalRoot");
    expect(pb.markdown).not.toContain("接纳，请你更新方案");
    expect(pb.markdown).not.toContain("审查结论：阻止验收");

    // Create sandbox at C1
    const sb = await createOrReuseWorktree(repo, "REQ-001");
    const wt = sb.worktreePath;
    // WIP edit in sandbox on app.ts
    fs.writeFileSync(path.join(wt, "app.ts"), "export const v = 99;\n");

    // Advance main on other.ts (no overlap)
    fs.writeFileSync(path.join(repo, "other.ts"), "export const other = 2;\n");
    execFileSync("git", ["add", "other.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "main updates other.ts"], { cwd: repo, stdio: "ignore" });

    const drift1 = await inspectRsiSandboxDrift(repo, "REQ-001");
    expect(drift1?.behindCount).toBe(1);
    expect(drift1?.conflictFiles).toEqual([]);
    expect(drift1?.canAutoSync).toBe(true);

    // Auto sync updates other.ts in sandbox while preserving WIP app.ts
    const syncRes = await syncRsiSandboxBase(repo, "REQ-001");
    expect(syncRes.synced).toBe(true);
    expect(syncRes.drift.behindCount).toBe(0);
    expect(fs.readFileSync(path.join(wt, "app.ts"), "utf8")).toBe("export const v = 99;\n");
    expect(fs.readFileSync(path.join(wt, "other.ts"), "utf8")).toBe("export const other = 2;\n");

    // Now advance main on app.ts (overlapping conflict!)
    fs.writeFileSync(path.join(repo, "app.ts"), "export const v = 2;\n");
    execFileSync("git", ["add", "app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "main conflicts app.ts"], { cwd: repo, stdio: "ignore" });

    const drift2 = await inspectRsiSandboxDrift(repo, "REQ-001");
    expect(drift2?.behindCount).toBe(1);
    expect(drift2?.conflictFiles).toEqual(["app.ts"]);
    expect(drift2?.canAutoSync).toBe(false);

    const blockedSync = await syncRsiSandboxBase(repo, "REQ-001");
    expect(blockedSync.synced).toBe(false);
    expect(blockedSync.conflictFiles).toEqual(["app.ts"]);
    // WIP preserved!
    expect(fs.readFileSync(path.join(wt, "app.ts"), "utf8")).toBe("export const v = 99;\n");

    // On clean non-conflicting case (revert conflict file in wt, keep new file), verify applySandboxToMain works after sync
    fs.writeFileSync(path.join(wt, "new_feature.ts"), "export const feat = true;\n");
    execFileSync("git", ["checkout", "--", "app.ts"], { cwd: wt, stdio: "ignore" });
    const syncClean = await syncRsiSandboxBase(repo, "REQ-001");
    expect(syncClean.synced).toBe(true);
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const wtSnap = (await observeGitSnapshot(wt))!;
    await acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: wtSnap.fingerprint });
    const applied = await applySandboxToMain(repo, "REQ-001");
    expect(applied.appliedFiles).toEqual(["new_feature.ts"]);
    expect(fs.readFileSync(path.join(repo, "new_feature.ts"), "utf8")).toBe("export const feat = true;\n");
    expect(fs.readFileSync(path.join(repo, "app.ts"), "utf8")).toBe("export const v = 2;\n");
  });

  test("reconcileRsiSandboxBaseline advances sandbox.baseHead and state.baseline.head only after merging main commits", async () => {
    makeTempHub();
    const repo = makeGitRepo("reconcile-base");
    await initProject(repo, { name: "workbench", privacyMode: "local" });
    const initHead = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const initSnap = (await observeGitSnapshot(repo))!;

    await createRequirement(repo, {
      goal: "Reconcile baseline after manual merge",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design\nMerge safe.", actor: "agent" });
    await approveDesign(repo, "REQ-001", {
      baseline: { head: initHead, fingerprint: initSnap.fingerprint, dirty: false, capturedAt: Date.now() },
    });

    const sb = await createOrReuseWorktree(repo, "REQ-001");
    const wt = sb.worktreePath;

    // 1. Advance sandbox with its own commit (NOT merged with main) -> reconcile must be a no-op
    fs.writeFileSync(path.join(wt, "app.ts"), "export const v = 10;\n");
    execFileSync("git", ["add", "app.ts"], { cwd: wt, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "sandbox work"], { cwd: wt, stdio: "ignore" });

    // Advance main concurrently on other.ts & app.ts
    fs.writeFileSync(path.join(repo, "other.ts"), "export const mainSide = true;\n");
    execFileSync("git", ["add", "other.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "main side commit"], { cwd: repo, stdio: "ignore" });
    const mainHead = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    const noMergeReconcile = await reconcileRsiSandboxBaseline(repo, "REQ-001");
    expect(noMergeReconcile).toBeNull();
    expect(getRequirement(repo, "REQ-001").state.baseline?.head).toBe(initHead);

    // 2. Agent merges main inside sandbox worktree, runs verify, and submits awaiting_acceptance
    execFileSync("git", ["merge", "--no-edit", mainHead], { cwd: wt, stdio: "ignore" });
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const wtSnapReady = (await observeGitSnapshot(wt))!;
    await updateTasks(repo, "REQ-001", {
      tasks: [{ title: "merged & verified", status: "done" }],
      readyForAcceptance: true,
      currentCodeSnapshotHash: wtSnapReady.fingerprint,
    });

    const reconciled = await reconcileRsiSandboxBaseline(repo, "REQ-001");
    expect(reconciled).not.toBeNull();
    // Preserves awaiting_acceptance stage when verification already covers post-merge snapshot
    expect(reconciled!.state.stage).toBe("awaiting_acceptance");
    expect(reconciled!.state.baseline?.head).toBe(mainHead);

    const postDrift = await inspectRsiSandboxDrift(repo, "REQ-001");
    expect(postDrift?.baseHead).toBe(mainHead);
    expect(postDrift?.behindCount).toBe(0);
    expect(postDrift?.conflictFiles).toEqual([]);
  });

  test("syncRsiSandboxBase ignores worktree node_modules symlink when aheadCount > 0 and mirrors evidence files", async () => {
    makeTempHub();
    const repo = makeGitRepo("sync-node-modules");
    await initProject(repo, { name: "workbench", privacyMode: "local" });
    fs.mkdirSync(path.join(repo, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(repo, "node_modules", "marker.txt"), "dep");

    await createRequirement(repo, {
      goal: "Sync worktree with node_modules symlink and mirror evidence",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design\nClean.", actor: "agent" });
    await approveDesign(repo, "REQ-001");

    const sb = await createOrReuseWorktree(repo, "REQ-001");
    const wt = sb.worktreePath;
    expect(fs.existsSync(path.join(wt, "node_modules"))).toBe(true);

    // Advance sandbox branch with its own commit (aheadCount = 1)
    fs.writeFileSync(path.join(wt, "app.ts"), "export const v = 20;\n");
    execFileSync("git", ["add", "app.ts"], { cwd: wt, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "sandbox commit"], { cwd: wt, stdio: "ignore" });

    // Advance main on a non-conflicting file (behindCount = 1)
    fs.writeFileSync(path.join(repo, "other.ts"), "export const other = 2;\n");
    execFileSync("git", ["add", "other.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "main commit"], { cwd: repo, stdio: "ignore" });

    const syncRes = await syncRsiSandboxBase(repo, "REQ-001");
    expect(syncRes.synced).toBe(true);
    expect(syncRes.drift.behindCount).toBe(0);
    expect(fs.readFileSync(path.join(wt, "other.ts"), "utf8")).toBe("export const other = 2;\n");

    const verified = await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    syncRequirementMirrorToSandbox(repo, "REQ-001", wt);
    const mirroredLog = path.join(wt, ".workbench", "items", "REQ-001", verified.record.outputPath);
    const mirroredMeta = mirroredLog.replace(/\.log$/, ".json");
    expect(fs.existsSync(mirroredLog)).toBe(true);
    expect(fs.existsSync(mirroredMeta)).toBe(true);
  });

  test("Phase 2: tracks reviewHistory/round, enforces delta re-review convergence, downgrades low-only concern, and caps auto-review rounds", async () => {
    makeTempHub();
    const repo = makeGitRepo("review-converge");
    await initProject(repo, { name: "ReviewConverge", privacyMode: "local" });
    await createRequirement(repo, {
      goal: "验证审查历史与增量收敛机制",
      criteria: [{ id: "AC-1", description: "passes", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design\nConverge.", actor: "agent" });
    await approveDesign(repo, "REQ-001");
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const snap1 = (await observeGitSnapshot(repo))!;
    await updateTasks(repo, "REQ-001", {
      tasks: [{ title: "done", status: "done" }],
      readyForAcceptance: true,
      currentCodeSnapshotHash: snap1.fingerprint,
    });

    // Round 1 review: full mode
    const r1 = await recordReviewReport(repo, "REQ-001", {
      reviewerHarness: "codex",
      reviewerModel: "gpt-6.2-sol",
      verdict: "concern",
      summary: "首轮发现一处样式收缩规则缺失",
      markdown: "F-1 details",
      findings: [{ id: "F-1", severity: "medium", title: "收缩规则缺失", files: ["app.ts:1"] }],
      reviewedSpecHash: getRequirement(repo, "REQ-001").state.specHash,
      reviewedCodeSnapshotHash: snap1.fingerprint,
      changedFiles: ["app.ts"],
    });
    expect(r1.state.reviewReport?.round).toBe(1);
    expect(r1.state.reviewReport?.reviewMode).toBe("full");
    expect(r1.state.reviewHistory).toHaveLength(1);
    expect(r1.validity.banner.primaryAction?.id).toBe("dispatch_fix_review");

    // Round 2 handoff & prompt enter delta convergence mode
    fs.writeFileSync(path.join(repo, "app.ts"), "export const v = 2;\n");
    fs.writeFileSync(path.join(repo, "other.ts"), "export const other = 2;\n");
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const snap2 = (await observeGitSnapshot(repo))!;

    const reviewHandoff = await synthesizeHandoffPacket(repo, "REQ-001", { action: "review" });
    expect(reviewHandoff.markdown).toContain("第 2 轮 · 增量收敛模式");
    expect(reviewHandoff.markdown).toContain("收缩规则缺失");
    expect(reviewHandoff.markdown).toContain("other.ts");
    const reviewPrompt = buildExecutionPrompt(reviewHandoff.detail, reviewHandoff.markdown, {
      root: repo,
      requirementId: "REQ-001",
      action: "review",
    });
    expect(reviewPrompt).toContain("第 2 轮 · 增量收敛模式");

    // Round 2 non-blocking concern (no high finding) flips banner primaryAction to accept
    const r2 = await recordReviewReport(repo, "REQ-001", {
      reviewerHarness: "codex",
      reviewerModel: "gpt-6.2-sol",
      verdict: "concern",
      summary: "历史问题已修，仅剩非阻塞建议",
      markdown: "F-2 details",
      findings: [{ id: "F-2", severity: "medium", title: "极端超长文案可优化" }],
      reviewedSpecHash: r1.state.specHash,
      reviewedCodeSnapshotHash: snap2.fingerprint,
    });
    expect(r2.state.reviewReport?.round).toBe(2);
    expect(r2.state.reviewReport?.reviewMode).toBe("delta");
    expect(r2.state.reviewHistory).toHaveLength(2);
    expect(r2.validity.banner.primaryAction?.id).toBe("accept");

    // Executor: low-only concern downgrades to pass, and maxAutoReviewRounds: 1 prevents 2nd auto review
    const routing = buildPresetRouting("balanced");
    routing.autoReview = true;
    routing.maxAutoReviewRounds = 1;
    const ranActions: string[] = [];
    const executor = new HubExecutor({
      initialHarnesses: [
        {
          id: "codex",
          label: "Codex",
          subscription: "Plus",
          installed: true,
          executable: "codex",
          models: [
            { id: "codex-auto-review", tier: "review", source: "detected" },
            { id: "gpt-6.2-sol", tier: "sota", source: "detected" },
          ],
          defaultModel: "gpt-6.2-sol",
          detectedAt: Date.now(),
        },
      ],
      getHubPreferences: () => ({ routing }),
      commandBuilder: (_target, ctx) => {
        ranActions.push(ctx.action);
        if (ctx.action === "review") {
          return {
            command: "bash",
            args: [
              "-c",
              `printf '%s\\n' '\`\`\`json' '{"verdict":"concern","summary":"仅剩低优先级注释建议","findings":[{"id":"F-LOW","severity":"low","title":"可补充注释"}]}' '\`\`\`'`,
            ],
            displayCommand: "mock-review-low",
          };
        }
        return { command: "bash", args: ["-c", "echo ok"], displayCommand: "mock-fix" };
      },
    });

    await createRequirement(repo, {
      goal: "测试低优先级自动转通过及轮次上限",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-002", { designMarkdown: "# Design\nCap test.", actor: "agent" });
    await approveDesign(repo, "REQ-002");
    await runVerification(repo, "REQ-002", { command: "echo ok", criterionIds: ["AC-1"] });
    const req2Snap = (await observeGitSnapshot(repo))!;
    await updateTasks(repo, "REQ-002", {
      tasks: [{ title: "done", status: "done" }],
      readyForAcceptance: true,
      currentCodeSnapshotHash: req2Snap.fingerprint,
    });

    const waitReview = new Promise<void>((resolve) => {
      const unsub = executor.subscribe((ev) => {
        if (ev.type === "agent.run.finished" && ev.action === "review") {
          unsub();
          resolve();
        }
      });
    });
    await executor.startRun({ root: repo, requirementId: "REQ-002", action: "review", isAutoReview: true });
    await waitReview;
    await new Promise((r) => setTimeout(r, 80));

    const req2Detail = getRequirement(repo, "REQ-002", { currentCodeSnapshotHash: req2Snap.fingerprint });
    expect(req2Detail.state.reviewReport?.verdict).toBe("pass");
    expect(req2Detail.state.reviewReport?.findings?.[0]?.severity).toBe("low");

    // Subsequent fix submit with maxAutoReviewRounds=1 must NOT trigger a 2nd auto review
    fs.writeFileSync(path.join(repo, "app.ts"), "export const v = 3;\n");
    await runVerification(repo, "REQ-002", { command: "echo ok", criterionIds: ["AC-1"] });
    const req2Snap2 = (await observeGitSnapshot(repo))!;
    await updateTasks(repo, "REQ-002", {
      tasks: [{ title: "done", status: "done" }],
      readyForAcceptance: true,
      currentCodeSnapshotHash: req2Snap2.fingerprint,
    });
    const waitFix = new Promise<void>((resolve) => {
      const unsub = executor.subscribe((ev) => {
        if (ev.type === "agent.run.finished" && ev.action === "fix") {
          unsub();
          resolve();
        }
      });
    });
    await executor.startRun({ root: repo, requirementId: "REQ-002", action: "fix" });
    await waitFix;
    await new Promise((r) => setTimeout(r, 120));
    expect(ranActions).toEqual(["review", "fix"]);
  }, { timeout: 15000 });
});
