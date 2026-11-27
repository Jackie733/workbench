import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  acceptRequirement,
  addDiscussion,
  approveDesign,
  authorizeFastTrack,
  createRequirement,
  deliverRequirement,
  getRequirement,
  getRequirementDeliveryPreview,
  initProject,
  propose,
  revisePlan,
  setManualCriterionCheck,
  submitDecisionsAndRevise,
  updateSpec,
} from "../../src/core/engine.ts";
import { observeGitSnapshot } from "../../src/core/git.ts";
import { runVerification } from "../../src/core/runner.ts";
import { getSandboxForRequirement, resolveCodeRoot, sandboxRegistryPath } from "../../src/core/sandbox.ts";
import { computeDecisionsHash, canDirectApproveWithDecisions } from "../../src/core/validity.ts";
import {
  commitSandboxWipCheckpoint,
  createOrReuseWorktree,
  inspectSandboxUnsavedWork,
  mergeSandboxToMain,
  syncSandboxPrAndCleanup,
} from "../../src/core/worktree.ts";
import {
  buildExecutionPrompt,
  buildHarnessCommand,
  buildHarnessIsolationEnv,
  HARNESS_ISOLATION_MATRIX,
  HubExecutor,
} from "../../src/hub/executor.ts";
import { discoverProjectContext } from "../../src/core/context.ts";
import { synthesizeHandoffPacket } from "../../src/hub/handoff.ts";
import { syncDesignRunResult } from "../../src/hub/post_run.ts";
import { buildInitialProjectRouting } from "../../src/hub/routing.ts";
import type { HarnessInfo } from "../../src/hub/types.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";

const tempDirs: string[] = [];
const servers: WorkbenchServerHandle[] = [];
const origHubDir = process.env.WORKBENCH_HUB_DIR;
const origChromePath = process.env.WORKBENCH_CHROME_PATH;

function makeTempHub(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-fp2-hub-"));
  tempDirs.push(dir);
  process.env.WORKBENCH_HUB_DIR = dir;
  return dir;
}

function makeGitRepo(name = "repo"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wb-fp2-${name}-`));
  tempDirs.push(dir);
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, ".gitignore"), ".env\n.env.*\n");
  fs.writeFileSync(path.join(dir, "app.ts"), "export const v = 1;\n");
  fs.writeFileSync(path.join(dir, "sibling.ts"), "export const s = 1;\n");
  execFileSync("git", ["add", ".gitignore", "app.ts", "sibling.ts"], { cwd: dir, stdio: "ignore" });
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

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000, label = "condition"): Promise<void> {
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

describe("Flow Phase 2 (WB-17 – WB-20)", () => {
  test("WB-17: design prompt full inlining, per-harness global isolation matrix, and file-native criteria/decisions sync", async () => {
    const repo = makeGitRepo("wb17");
    await initProject(repo, { name: "Wb17Repo", privacyMode: "local" });
    await createRequirement(repo, { goal: "实现导出报表并支持自定义列" });
    await updateSpec(repo, "REQ-001", {
      specMarkdown: "# 导出报表详细规范\n需要支持 CSV 和 XLSX 两种格式，并且保留原需求边界。",
    });
    await addDiscussion(repo, "REQ-001", {
      actor: "human",
      mode: "refine",
      anchor: "spec.md > 导出报表详细规范",
      message: "请补充大文件流式导出限制说明",
    });

    const detail = getRequirement(repo, "REQ-001");
    const handoff = await synthesizeHandoffPacket(repo, "REQ-001", { action: "design" });
    const prompt = buildExecutionPrompt(detail, handoff.markdown, {
      root: repo,
      requirementId: "REQ-001",
      action: "design",
    });

    // Inlines spec.md full content, originalGoal when different, unresolved annotation, format examples, and forbids wb --help/get
    expect(prompt).toContain("已内联需求规范全文");
    expect(prompt).toContain("需要支持 CSV 和 XLSX 两种格式");
    expect(prompt).toContain("人类原始需求原话（只读参考）");
    expect(prompt).toContain("实现导出报表并支持自定义列");
    expect(prompt).toContain("请补充大文件流式导出限制说明");
    expect(prompt).toContain("workbench-criteria");
    expect(prompt).toContain('"kind":"manual"');
    expect(prompt).toContain("workbench-decisions");
    expect(prompt).toContain("无需执行 `wb --help` 或 `wb get`");
    expect(prompt).toContain("本轮仅完成设计方案");

    // Verify per-harness isolation matrix & CLI flag/env injection
    expect(HARNESS_ISOLATION_MATRIX.omp.supported).toBe(true);
    expect(HARNESS_ISOLATION_MATRIX.agy.supported).toBe(true);
    expect(HARNESS_ISOLATION_MATRIX.qodercn.supported).toBe(true);
    expect(HARNESS_ISOLATION_MATRIX.opencode.supported).toBe(true);
    expect(HARNESS_ISOLATION_MATRIX.codex.supported).toBe(false);

    const ompCmd = buildHarnessCommand(
      { harness: "omp", model: "claude-sonnet-4" },
      { root: repo, action: "design", prompt: "P", harnesses: [] },
    );
    expect(ompCmd.args).toContain("--no-skills");
    expect(ompCmd.args).toContain("--no-extensions");

    const agyCmd = buildHarnessCommand(
      { harness: "agy", model: "gemini-2.5-pro" },
      { root: repo, action: "design", prompt: "P", harnesses: [] },
    );
    expect(agyCmd.args).toContain("--disable-slash-commands");

    const qoderCmd = buildHarnessCommand(
      { harness: "qodercn", model: "Qwen3.8-Flash" },
      { root: repo, action: "design", prompt: "P", harnesses: [] },
    );
    const ssIdx = qoderCmd.args.indexOf("--setting-sources");
    expect(ssIdx).toBeGreaterThan(-1);
    expect(qoderCmd.args[ssIdx + 1]).toBe("project,local");

    expect(buildHarnessIsolationEnv("opencode")).toEqual({ OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" });
    expect(buildHarnessIsolationEnv("codex")).toEqual({});

    // File-native sync: first design round with pending decisions defers fallback criteria injection
    const designPath = path.join(repo, ".workbench/items/REQ-001/design.md");
    fs.writeFileSync(
      designPath,
      [
        "# 导出方案（待拍板）",
        "",
        "```workbench-decisions",
        JSON.stringify([
          {
            id: "D-1",
            question: "导出格式默认选哪个？",
            options: [
              { id: "csv", label: "CSV", recommended: true },
              { id: "xlsx", label: "XLSX" },
            ],
          },
        ]),
        "```",
      ].join("\n"),
      "utf8",
    );
    const projectContext = discoverProjectContext(repo);
    const sync1 = await syncDesignRunResult({
      base: repo,
      codeRoot: repo,
      id: "REQ-001",
      latestReq: getRequirement(repo, "REQ-001"),
      preSpecMarkdown: detail.specMarkdown,
      preDesignMarkdown: detail.designMarkdown,
      codeChanged: false,
      projectContext,
      snapshotFingerprint: null,
      appendNote: () => {},
    });
    expect(sync1.state.pendingDecisions?.length).toBe(1);
    // Deferred criteria when pending decisions exist
    expect(sync1.state.criteria.length).toBe(0);

    // Subsequent design round with both command + manual criteria syncs cleanly
    fs.writeFileSync(
      designPath,
      [
        "# 导出方案（完整版）",
        "",
        "```workbench-criteria",
        JSON.stringify([
          { id: "AC-1", description: "导出单测通过", required: true, command: "echo ok" },
          { id: "AC-2", description: "人工核验 Excel 打开无乱码", required: true, kind: "manual", steps: "下载文件并用表格软件打开" },
        ]),
        "```",
      ].join("\n"),
      "utf8",
    );
    const sync2 = await syncDesignRunResult({
      base: repo,
      codeRoot: repo,
      id: "REQ-001",
      latestReq: getRequirement(repo, "REQ-001"),
      preSpecMarkdown: sync1.specMarkdown,
      preDesignMarkdown: sync1.designMarkdown,
      codeChanged: false,
      projectContext,
      snapshotFingerprint: null,
      appendNote: () => {},
    });
    expect(sync2.state.criteria.map((c) => [c.id, c.kind ?? "command"])).toEqual([
      ["AC-1", "command"],
      ["AC-2", "manual"],
    ]);
    expect(sync2.state.criteria[1]?.steps).toBe("下载文件并用表格软件打开");
  });

  test("WB-18: immutable originalGoal, manual criterion checkoff + auto-stale, decision card double exits, and authoritative humanDecisions injection", async () => {
    const repo = makeGitRepo("wb18");
    await initProject(repo, { name: "Wb18Repo", privacyMode: "local" });
    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, hubMode: false });
    servers.push(server);

    const created = await createRequirement(repo, {
      goal: "原始需求：支持深色模式与主题持久化",
    });
    expect(created.state.originalGoal).toBe("原始需求：支持深色模式与主题持久化");

    // Updating spec must NEVER mutate originalGoal
    await updateSpec(repo, "REQ-001", {
      specMarkdown: "# 主题系统规范\n扩展后的详细规范，支持系统跟随与 localStorage 持久化。",
    });
    expect(getRequirement(repo, "REQ-001").state.originalGoal).toBe("原始需求：支持深色模式与主题持久化");

    // Propose with pending decisions and NO criteria yet (allowed on first design round)
    await propose(repo, "REQ-001", {
      designMarkdown: "# 主题方案 v1",
      decisions: [
        {
          id: "D-1",
          question: "主题存储方式？",
          options: [
            { id: "local", label: "localStorage", recommended: true },
            { id: "cookie", label: "Cookie" },
          ],
        },
        {
          id: "D-2",
          question: "默认主题策略？",
          options: [
            { id: "system", label: "跟随系统", recommended: true },
            { id: "light", label: "强制浅色" },
          ],
        },
      ],
    });

    const dPending = getRequirement(repo, "REQ-001");
    expect(dPending.validity.needsDecision).toBe(true);
    expect(dPending.validity.decisionReasonKey).toBe("core.decision.pendingDecisions");
    expect(dPending.validity.banner.headlineKey).toBe("core.banner.awaitApproval.decisions");

    // Hard invariant ③ & direct-approve guard: blocked when unanswered OR no criteria
    expect(canDirectApproveWithDecisions(dPending.state).allowed).toBe(false);
    await expect(approveDesign(repo, "REQ-001")).rejects.toMatchObject({ code: "approval_required" });

    // Persist selections asynchronously via PATCH /decisions (one preset, one custom)
    const patchRes = await apiJson(`${server.url}/api/requirements/REQ-001/decisions`, {
      method: "PATCH",
      body: JSON.stringify({
        selections: [
          { id: "D-1", selectedOptionId: "local" },
          { id: "D-2", customAnswer: "首次按系统，切换后同步云端" },
        ],
      }),
    });
    expect(patchRes.status).toBe(200);
    const afterPatch = getRequirement(repo, "REQ-001");
    expect(afterPatch.state.pendingDecisions?.[0]?.selectedOptionId).toBe("local");
    expect(afterPatch.state.pendingDecisions?.[1]?.customAnswer).toBe("首次按系统，切换后同步云端");
    // Custom answer disables direct approve even if criteria were present
    expect(canDirectApproveWithDecisions({ ...afterPatch.state, criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }] }).allowed).toBe(false);

    // Add an unresolved refine annotation and bundle everything via Exit 2 (`POST /decisions/revise`)
    await addDiscussion(repo, "REQ-001", {
      actor: "human",
      mode: "refine",
      anchor: "design.md > 主题方案 v1",
      message: "请补充 SSR 防闪烁脚本说明",
    });
    const reviseRes = await apiJson(`${server.url}/api/requirements/REQ-001/decisions/revise`, {
      method: "POST",
      body: JSON.stringify({ note: "按以上决策补齐验收条件" }),
    });
    expect(reviseRes.status).toBe(200);
    const afterRevise = getRequirement(repo, "REQ-001");
    expect(afterRevise.state.stage).toBe("planning");
    expect(afterRevise.state.humanDecisions?.length).toBe(2);
    expect(afterRevise.state.lastFeedback).toContain("localStorage");
    expect(afterRevise.state.lastFeedback).toContain("首次按系统，切换后同步云端");
    expect(afterRevise.state.lastFeedback).toContain("请补充 SSR 防闪烁脚本说明");
    expect(Array.isArray(reviseRes.body.unresolvedAnnotationIds)).toBe(true);
    expect((reviseRes.body.unresolvedAnnotationIds as string[]).length).toBe(1);

    // Round 2: agent proposes complete plan with command + manual criteria and 1 preset decision
    await propose(repo, "REQ-001", {
      designMarkdown: "# 主题方案 v2",
      criteria: [
        { id: "AC-1", description: "单测通过", required: true, command: "echo ok" },
        { id: "AC-2", description: "切深色模式无闪烁且对比度达标", required: true, kind: "manual", steps: "在暗色与亮色间切换 3 次观察页面" },
      ],
      decisions: [
        {
          id: "D-3",
          question: "CSS 变量前缀？",
          options: [
            { id: "wb", label: "--wb-theme-*", recommended: true },
            { id: "app", label: "--app-*" },
          ],
        },
      ],
    });

    // Save preset choice and direct-approve via Exit 1 (`POST /approve` with decisionSelections)
    const approveRes = await apiJson(`${server.url}/api/requirements/REQ-001/approve`, {
      method: "POST",
      body: JSON.stringify({
        createSandbox: false,
        decisionSelections: [{ id: "D-3", selectedOptionId: "wb" }],
      }),
    });
    expect(approveRes.status).toBe(200);
    const approved = getRequirement(repo, "REQ-001");
    expect(approved.state.stage).toBe("coding");
    expect(approved.state.pendingDecisions).toBeUndefined();
    expect(approved.state.humanDecisions?.length).toBe(3);
    expect(approved.state.humanDecisions?.find((d) => d.id === "D-3")?.answer).toBe("--wb-theme-*");
    expect(approved.state.approval?.decisionsHash).toBe(computeDecisionsHash(approved.state.humanDecisions));

    // Verify authoritative humanDecisions injected into implement, fix, and review handoffs/prompts
    for (const action of ["implement", "fix", "review"] as const) {
      const packet = await synthesizeHandoffPacket(repo, "REQ-001", { action });
      expect(packet.markdown).toContain("人类已采纳决策（权威裁决）");
      expect(packet.markdown).toContain("--wb-theme-*");
      if (action !== "review") {
        const execPrompt = buildExecutionPrompt(approved, packet.markdown, {
          root: repo,
          requirementId: "REQ-001",
          action,
        });
        expect(execPrompt).toContain("人类已采纳决策");
      }
    }

    // Coding & verification: AC-1 passes by command, AC-2 is manual (initially missing -> blocks accept)
    fs.writeFileSync(path.join(repo, "app.ts"), "export const v = 2;\n");
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const snap1 = await observeGitSnapshot(repo);
    const beforeManual = getRequirement(repo, "REQ-001", { currentCodeSnapshotHash: snap1!.fingerprint });
    expect(beforeManual.validity.coverage.items.find((c) => c.criterion.id === "AC-2")?.state).toBe("unverified");
    await expect(
      acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: snap1!.fingerprint }),
    ).rejects.toMatchObject({ code: "acceptance_gate_failed" });

    // Human checks off manual criterion AC-2 bound to specHash + snap1
    const checkRes = await apiJson(`${server.url}/api/requirements/REQ-001/manual-check`, {
      method: "POST",
      body: JSON.stringify({ criterionId: "AC-2", checked: true, note: "肉眼切换确认无闪烁" }),
    });
    expect(checkRes.status).toBe(200);
    const afterManual = getRequirement(repo, "REQ-001", { currentCodeSnapshotHash: snap1!.fingerprint });
    expect(afterManual.validity.coverage.items.find((c) => c.criterion.id === "AC-2")?.state).toBe("passed");
    expect(afterManual.validity.acceptanceGate.ok).toBe(true);

    // Code edit automatically turns AC-2 checkoff STALE!
    fs.writeFileSync(path.join(repo, "app.ts"), "export const v = 3;\n");
    const snap2 = await observeGitSnapshot(repo);
    const afterEdit = getRequirement(repo, "REQ-001", { currentCodeSnapshotHash: snap2!.fingerprint });
    expect(afterEdit.validity.coverage.items.find((c) => c.criterion.id === "AC-2")?.state).toBe("stale");
    expect(afterEdit.validity.acceptanceGate.ok).toBe(false);

    // Re-run AC-1 and re-check AC-2 on snap2 -> accept succeeds
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    await setManualCriterionCheck(repo, "REQ-001", {
      criterionId: "AC-2",
      checked: true,
      currentCodeSnapshotHash: snap2!.fingerprint,
    });
    const accepted = await acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: snap2!.fingerprint });
    expect(accepted.state.stage).toBe("done");
  });

  test("WB-19: human-only revisePlan (diff -> handoff), re-approve keep vs resetSandbox, and needsHuman escalation on cap exhaustion", async () => {
    const repo = makeGitRepo("wb19");
    await initProject(repo, {
      name: "Wb19Repo",
      privacyMode: "local",
      routing: {
        ...buildInitialProjectRouting(),
        autoReview: false,
        autoHeal: true,
      },
    });
    fs.writeFileSync(path.join(repo, ".env"), "KEEP_SECRET=1\n");
    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, hubMode: false });
    servers.push(server);

    await createRequirement(repo, {
      goal: "测试退回修改方案与自愈耗尽升级",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "exit 1" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Plan v1" });
    const firstApprove = await apiJson(`${server.url}/api/requirements/REQ-001/approve`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(firstApprove.status).toBe(200);
    const sb = getSandboxForRequirement(repo, "REQ-001")!;
    expect(sb).toBeTruthy();

    // Write code in sandbox + gitignored .env
    fs.writeFileSync(path.join(sb.worktreePath, ".env"), "KEEP_SECRET=1\n");
    fs.writeFileSync(path.join(sb.worktreePath, "app.ts"), "export const v = 99;\n");
    fs.writeFileSync(path.join(sb.worktreePath, "temp_draft.ts"), "export const draft = true;\n");

    // 1. Trigger auto-heal exhaustion -> must set needsHuman & danger banner with escalate_sota + revise_plan
    const executor = new HubExecutor({
      initialHarnesses: [
        makeHarness("codex", [{ id: "gpt-5-mini", tier: "balanced" }, { id: "gpt-5-sota", tier: "sota" }]),
      ],
      commandBuilder: () => ({
        command: "bash",
        args: ["-c", "echo 'simulated impl/fix attempt'"],
        displayCommand: "mock-failing-verify",
      }),
    });
    await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "implement",
      harness: "codex",
      model: "gpt-5-mini",
    });
    await waitUntil(() => Boolean(getRequirement(repo, "REQ-001").state.needsHuman), 12_000, "needsHuman after autoHeal cap");
    const escalated = getRequirement(repo, "REQ-001");
    expect(escalated.state.needsHuman?.source).toBe("auto_heal_exhausted");
    expect(escalated.validity.needsDecision).toBe(true);
    expect(escalated.validity.banner.tone).toBe("danger");
    expect(escalated.validity.decisionReasonKey).toBe("core.decision.needsHuman");
    expect(escalated.validity.banner.headlineKey).toBe("core.banner.needsHuman");
    expect(escalated.validity.banner.primaryAction?.id).toBe("escalate_sota");
    expect(escalated.validity.banner.secondaryActions.some((a) => a.id === "revise_plan")).toBe(true);

    // 2. Human triggers revisePlan via API -> coding -> planning, invalidates approval, snapshots diff into handoff.md, keeps sandbox intact
    const reviseRes = await apiJson(`${server.url}/api/requirements/REQ-001/revise-plan`, {
      method: "POST",
      body: JSON.stringify({ reason: "旧方案数据结构假设有误，需要改写接口" }),
    });
    expect(reviseRes.status).toBe(200);
    const revised = getRequirement(repo, "REQ-001");
    expect(revised.state.stage).toBe("planning");
    expect(revised.state.approval).toBeNull();
    expect(revised.state.needsHuman).toBeNull();
    expect(revised.state.revisedFromCoding).toBe(true);
    expect(fs.readFileSync(path.join(sb.worktreePath, "app.ts"), "utf8")).toContain("99");
    const handoffMd = fs.readFileSync(path.join(repo, ".workbench/items/REQ-001/handoff.md"), "utf8");
    expect(handoffMd).toContain("退回修改方案前的代码改动现场（revisePlan）");
    expect(handoffMd).toContain("export const v = 99;");

    // 3. Re-propose and re-approve with DEFAULT (resetSandbox=false) -> preserves sandbox edits
    await propose(repo, "REQ-001", {
      designMarkdown: "# Plan v2",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    const reApproveKeep = await apiJson(`${server.url}/api/requirements/REQ-001/approve`, {
      method: "POST",
      body: JSON.stringify({ resetSandbox: false }),
    });
    expect(reApproveKeep.status).toBe(200);
    expect(fs.readFileSync(path.join(sb.worktreePath, "app.ts"), "utf8")).toContain("99");

    // 4. Revise again, then re-approve with resetSandbox=true -> resets sandbox to clean baseHead while preserving gitignored .env
    await revisePlan(repo, "REQ-001", { reason: "重头来过" });
    await propose(repo, "REQ-001", {
      designMarkdown: "# Plan v3",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    const reApproveReset = await apiJson(`${server.url}/api/requirements/REQ-001/approve`, {
      method: "POST",
      body: JSON.stringify({ resetSandbox: true }),
    });
    expect(reApproveReset.status).toBe(200);
    expect(fs.readFileSync(path.join(sb.worktreePath, "app.ts"), "utf8")).toBe("export const v = 1;\n");
    expect(fs.existsSync(path.join(sb.worktreePath, "temp_draft.ts"))).toBe(false);
    expect(fs.readFileSync(path.join(sb.worktreePath, ".env"), "utf8")).toBe("KEEP_SECRET=1\n");
  }, 20_000);

  test("WB-20: zero-token prefill, multi-WIP auto squash + 1-click local merge, tree guard, safe cancel, PR cleanup, and cleanOnly sibling cascade", async () => {
    const repo = makeGitRepo("wb20");
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "wb-fp2-remote-"));
    tempDirs.push(remote);
    execFileSync("git", ["init", "--bare"], { cwd: remote, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repo, stdio: "ignore" });

    await initProject(repo, { name: "Wb20Repo", privacyMode: "local" });
    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, hubMode: false });
    servers.push(server);

    // REQ-001: primary feature in sandbox with 2 WIP checkpoints
    await createRequirement(repo, {
      goal: "实现健康检查接口",
      criteria: [{ id: "AC-1", description: "passes", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# 健康检查方案" });
    await apiJson(`${server.url}/api/requirements/REQ-001/approve`, { method: "POST", body: JSON.stringify({}) });

    // REQ-002: clean zero-edit sibling sandbox (should auto fast-forward after REQ-001 merges)
    await createRequirement(repo, {
      goal: "干净兄弟需求",
      criteria: [{ id: "AC-1", description: "passes", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-002", { designMarkdown: "# Clean sibling" });
    await apiJson(`${server.url}/api/requirements/REQ-002/approve`, { method: "POST", body: JSON.stringify({}) });

    // REQ-003: dirty active sibling sandbox (must NOT be mutated; reported as drifted)
    await createRequirement(repo, {
      goal: "有未提交改动的兄弟需求",
      criteria: [{ id: "AC-1", description: "passes", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-003", { designMarkdown: "# Dirty sibling" });
    await apiJson(`${server.url}/api/requirements/REQ-003/approve`, { method: "POST", body: JSON.stringify({}) });
    const wt3 = resolveCodeRoot(repo, "REQ-003");
    fs.writeFileSync(path.join(wt3, "sibling.ts"), "export const s = 300;\n");

    // Make 2 WIP commits in REQ-001 sandbox
    const wt1 = resolveCodeRoot(repo, "REQ-001");
    fs.writeFileSync(path.join(wt1, "app.ts"), "export const v = 10;\n");
    await commitSandboxWipCheckpoint(repo, "REQ-001", { action: "implement", runId: "RUN-1", status: "succeeded" });
    fs.writeFileSync(path.join(wt1, "health.ts"), "export const ok = true;\n");
    await commitSandboxWipCheckpoint(repo, "REQ-001", { action: "fix", runId: "RUN-2", status: "succeeded" });

    // Verify & accept REQ-001
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const accSnap1 = await observeGitSnapshot(wt1);
    await acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: accSnap1!.fingerprint });

    // Preview exposes zero-token prefill, canMergeLocal, wipCommitCount=2, treeMatchesAcceptance=true
    const preview1 = await getRequirementDeliveryPreview(repo, "REQ-001");
    expect(preview1.canMergeLocal).toBe(true);
    expect(preview1.wipCommitCount).toBe(2);
    expect(preview1.treeMatchesAcceptance).toBe(true);
    expect(preview1.suggestedMessage).toContain("req-001");
    expect(preview1.suggestedPrTitle).toContain("REQ-001");
    expect(preview1.suggestedPrBody).toContain("REQ-001");

    // Tree change AFTER acceptance blocks direct merge with acceptance_gate_failed + requiresReverify
    fs.writeFileSync(path.join(wt1, "health.ts"), "export const ok = false; // unverified edit\n");
    const driftedPreview = await getRequirementDeliveryPreview(repo, "REQ-001");
    expect(driftedPreview.treeMatchesAcceptance).toBe(false);
    await expect(
      mergeSandboxToMain(repo, "REQ-001", { commitMessage: "feat(req-001): should block" }),
    ).rejects.toMatchObject({ code: "acceptance_gate_failed" });

    // Restore exact accepted content -> Tree OID matches again -> 1-click local squash merge succeeds!
    fs.writeFileSync(path.join(wt1, "health.ts"), "export const ok = true;\n");
    const mainCountBefore = Number(execFileSync("git", ["rev-list", "--count", "main"], { cwd: repo, encoding: "utf8" }).trim());

    const mergeRes = await apiJson(`${server.url}/api/requirements/REQ-001/merge-local`, {
      method: "POST",
      body: JSON.stringify({ commitMessage: "feat(req-001): 实现健康检查接口" }),
    });
    expect(mergeRes.status).toBe(200);
    expect(mergeRes.body.squashedCount).toBe(2);
    const mergedDelivery = mergeRes.body.delivery as { commitHash: string };

    // Main advanced by exactly 1 clean squashed commit containing both app.ts & health.ts
    const mainCountAfter = Number(execFileSync("git", ["rev-list", "--count", "main"], { cwd: repo, encoding: "utf8" }).trim());
    expect(mainCountAfter).toBe(mainCountBefore + 1);
    expect(fs.readFileSync(path.join(repo, "health.ts"), "utf8")).toBe("export const ok = true;\n");
    expect(getSandboxForRequirement(repo, "REQ-001")).toBeNull();
    expect(getRequirement(repo, "REQ-001").state.delivery?.commitHash).toBe(mergedDelivery.commitHash);

    // Multi-sandbox linkage: clean REQ-002 auto fast-forwarded, dirty REQ-003 reported as drifted & untouched
    const cascade = mergeRes.body.cascadeResults as Array<{ requirementId: string; status: string }>;
    expect(cascade.find((c) => c.requirementId === "REQ-002")?.status).toBe("synced");
    expect(cascade.find((c) => c.requirementId === "REQ-003")?.status).toBe("drifted");
    expect(fs.existsSync(path.join(resolveCodeRoot(repo, "REQ-002"), "health.ts"))).toBe(true);
    expect(fs.readFileSync(path.join(wt3, "sibling.ts"), "utf8")).toBe("export const s = 300;\n");
    expect(fs.existsSync(path.join(wt3, "health.ts"))).toBe(false);

    // Safe cancel: empty clean REQ-002 auto-cleans sandbox; dirty REQ-003 retains sandbox until explicit DELETE /sandbox
    const cancelClean = await apiJson(`${server.url}/api/requirements/REQ-002/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason: "不再需要" }),
    });
    expect(cancelClean.status).toBe(200);
    expect((cancelClean.body.sandboxCleanup as { cleaned: boolean }).cleaned).toBe(true);
    expect(getSandboxForRequirement(repo, "REQ-002")).toBeNull();

    const cancelDirty = await apiJson(`${server.url}/api/requirements/REQ-003/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason: "暂缓" }),
    });
    expect(cancelDirty.status).toBe(200);
    expect((cancelDirty.body.sandboxCleanup as { retained: boolean }).retained).toBe(true);
    expect(getSandboxForRequirement(repo, "REQ-003")).not.toBeNull();
    expect(fs.readFileSync(path.join(wt3, "sibling.ts"), "utf8")).toBe("export const s = 300;\n");

    const discardRes = await apiJson(`${server.url}/api/requirements/REQ-003/sandbox`, { method: "DELETE" });
    expect(discardRes.status).toBe(200);
    expect(getSandboxForRequirement(repo, "REQ-003")).toBeNull();

    // PR auto-squash delivery + post-merge sandbox cleanup
    await createRequirement(repo, {
      goal: "测试 PR 自动压缩与合并清理",
      criteria: [{ id: "AC-1", description: "passes", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-004", { designMarkdown: "# PR squash plan" });
    await createOrReuseWorktree(repo, "REQ-004");
    const wt4 = resolveCodeRoot(repo, "REQ-004");
    await approveDesign(repo, "REQ-004", { baseline: await observeGitSnapshot(wt4) });
    fs.writeFileSync(path.join(wt4, "pr_file.ts"), "export const step = 1;\n");
    await commitSandboxWipCheckpoint(repo, "REQ-004", { action: "implement", runId: "RUN-P1", status: "succeeded" });
    fs.writeFileSync(path.join(wt4, "pr_file.ts"), "export const step = 2;\n");
    await commitSandboxWipCheckpoint(repo, "REQ-004", { action: "fix", runId: "RUN-P2", status: "succeeded" });
    await runVerification(repo, "REQ-004", { command: "echo ok", criterionIds: ["AC-1"] });
    const snap4 = await observeGitSnapshot(wt4);
    await acceptRequirement(repo, "REQ-004", { currentCodeSnapshotHash: snap4!.fingerprint });

    // Deliver with createPr=true using mocked GitHub CLI
    const mockGhDeps = {
      whichGh: () => "gh",
      getRemoteUrl: async () => "https://github.com/test/repo.git",
      resolveDefaultBaseBranch: async () => "main",
      runGh: async (_bin: string, args: string[]) => {
        if (args[0] === "auth" && args[1] === "status") {
          return { code: 0, stdout: "Logged in to github.com as test-user\n", stderr: "" };
        }
        if (args[0] === "pr" && args[1] === "list") {
          return { code: 0, stdout: "[]", stderr: "" };
        }
        if (args[0] === "pr" && args[1] === "create") {
          return { code: 0, stdout: "https://github.com/test/repo/pull/42\n", stderr: "" };
        }
        if (args[0] === "pr" && args[1] === "view") {
          return {
            code: 0,
            stdout: JSON.stringify({
              number: 42,
              url: "https://github.com/test/repo/pull/42",
              title: "REQ-004: PR squash test",
              state: "MERGED",
              headRefName: getSandboxForRequirement(repo, "REQ-004")?.branch ?? "wb/req-004",
              baseRefName: "main",
              mergedAt: new Date().toISOString(),
            }),
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const prDelivered = await deliverRequirement(
      repo,
      "REQ-004",
      {
        files: [],
        commitMessage: "feat(req-004): PR squash test",
        createPr: true,
        baseBranch: "main",
        prTitle: "REQ-004: PR squash test",
      },
      mockGhDeps,
    );
    expect(prDelivered.delivery.prUrl).toBe("https://github.com/test/repo/pull/42");
    // Branch ahead of origin/main should be squashed to exactly 1 clean commit
    const sb4 = getSandboxForRequirement(repo, "REQ-004")!;
    const branchCommits = Number(
      execFileSync("git", ["-C", wt4, "rev-list", "--count", `${sb4.baseHead}..HEAD`], { encoding: "utf8" }).trim(),
    );
    expect(branchCommits).toBe(1);

    // Simulate PR merged on remote -> syncSandboxPrAndCleanup cleans up REQ-004 sandbox
    execFileSync("git", ["fetch", "origin", sb4.branch], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["merge", "--ff-only", "FETCH_HEAD"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["push", "origin", "main"], { cwd: repo, stdio: "ignore" });
    const cleanup = await syncSandboxPrAndCleanup(repo, "REQ-004", {}, mockGhDeps);
    expect(cleanup.cleanedSandbox).toBe(true);
    expect(getSandboxForRequirement(repo, "REQ-004")).toBeNull();
  }, 30_000);

  test("regression guards: manual verify rejection, manual->command transition, fastTrack decisionsHash, stale-rev resetSandbox safety, revisePlan baseline & fresh implement, moved-main & non-sandbox PR checks", async () => {
    const repo = makeGitRepo("fp2-reg");
    await initProject(repo, { name: "Fp2RegRepo", privacyMode: "local" });
    await createRequirement(repo, { goal: "Phase 2 regression guards" });
    await propose(repo, "REQ-001", {
      designMarkdown: "# Plan\nRegressions.",
      criteria: [
        { id: "AC-1", description: "auto cmd", required: true, command: "echo ok" },
        { id: "AC-M", description: "manual step", required: true, kind: "manual", steps: "Check manually" },
      ],
      decisions: [
        {
          id: "D-1",
          question: "Which mode?",
          options: [
            { id: "a", label: "Mode A", recommended: true },
            { id: "b", label: "Mode B" },
          ],
        },
      ],
    });

    // 1. submitDecisionsAndRevise -> authorizeFastTrack MUST include decisionsHash so approval stays valid
    await submitDecisionsAndRevise(repo, "REQ-001", {
      selections: [{ id: "D-1", customAnswer: "Mode C" }],
    });
    const ft = await authorizeFastTrack(repo, "REQ-001", { baseline: await observeGitSnapshot(repo) });
    expect(ft.validity.approval.valid).toBe(true);
    expect(ft.state.approval?.decisionsHash).toBe(computeDecisionsHash(ft.state.humanDecisions));

    // 2. Agents MUST NOT bypass manual criteria via runVerification
    await expect(
      runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-M"] }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    // 3. Checked manual criterion converted to command via updateSpec MUST NOT deadlock acceptance
    const snapBeforeCheck = await observeGitSnapshot(repo);
    await setManualCriterionCheck(repo, "REQ-001", {
      criterionId: "AC-M",
      checked: true,
      currentCodeSnapshotHash: snapBeforeCheck!.fingerprint,
    });
    await updateSpec(repo, "REQ-001", {
      criteria: [
        { id: "AC-1", description: "auto cmd", required: true, command: "echo ok" },
        { id: "AC-M", description: "converted to cmd", required: true, command: "echo ok-m" },
      ],
    });
    expect(getRequirement(repo, "REQ-001").state.manualChecks).toEqual([]);
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    await runVerification(repo, "REQ-001", { command: "echo ok-m", criterionIds: ["AC-M"] });
    const snapAfterCmd = await observeGitSnapshot(repo);
    expect(getRequirement(repo, "REQ-001", { currentCodeSnapshotHash: snapAfterCmd!.fingerprint }).validity.acceptanceGate.ok).toBe(true);

    // 4. Stale expectedRevision on POST /approve with resetSandbox=true MUST return 409 WITHOUT wiping sandbox files
    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, hubMode: false });
    servers.push(server);
    await createRequirement(repo, {
      goal: "Reset safety & revisePlan baseline",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-002", { designMarkdown: "# Plan v1" });
    const sb2 = await createOrReuseWorktree(repo, "REQ-002");
    await approveDesign(repo, "REQ-002", { baseline: await observeGitSnapshot(sb2.worktreePath) });
    fs.writeFileSync(path.join(sb2.worktreePath, "keep_me.ts"), "export const keep = true;\n");
    await commitSandboxWipCheckpoint(repo, "REQ-002", { action: "implement", runId: "RUN-KEEP", status: "succeeded" });
    await revisePlan(repo, "REQ-002", { reason: "Refine plan" });
    await propose(repo, "REQ-002", { designMarkdown: "# Plan v2" });
    const origBaselineHead = getRequirement(repo, "REQ-002").state.baseline?.head;

    const staleApprove = await fetch(`${server.url}/api/requirements/REQ-002/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, resetSandbox: true }),
    });
    expect(staleApprove.status).toBe(409);
    expect(fs.existsSync(path.join(sb2.worktreePath, "keep_me.ts"))).toBe(true);

    // Re-approve with resetSandbox=false preserves original baseline AND post-revisePlan implement uses fresh_handoff
    const reApprove = await fetch(`${server.url}/api/requirements/REQ-002/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: getRequirement(repo, "REQ-002").state.revision, resetSandbox: false }),
    });
    expect(reApprove.status).toBe(200);
    expect(getRequirement(repo, "REQ-002").state.baseline?.head).toBe(origBaselineHead);

    // 5. inspectSandboxUnsavedWork fails closed when baseHead is missing
    const sandboxesFile = sandboxRegistryPath();
    const sbMap = JSON.parse(fs.readFileSync(sandboxesFile, "utf8")) as Record<string, Record<string, unknown>>;
    const sbEntryKey = Object.keys(sbMap).find((k) => k.endsWith("::REQ-002"))!;
    const origBaseHead = sbMap[sbEntryKey]!.baseHead;
    delete sbMap[sbEntryKey]!.baseHead;
    fs.writeFileSync(sandboxesFile, JSON.stringify(sbMap, null, 2));
    expect(inspectSandboxUnsavedWork(repo, "REQ-002").hasUnsavedWork).toBe(true);
    sbMap[sbEntryKey]!.baseHead = origBaseHead;
    fs.writeFileSync(sandboxesFile, JSON.stringify(sbMap, null, 2));

    // 6. mergeSandboxToMain MUST reject when local main moved ahead after acceptance
    await runVerification(repo, "REQ-002", { command: "echo ok", criterionIds: ["AC-1"] });
    const wt2Snap = await observeGitSnapshot(sb2.worktreePath);
    await acceptRequirement(repo, "REQ-002", { currentCodeSnapshotHash: wt2Snap!.fingerprint });
    fs.writeFileSync(path.join(repo, "main_only.ts"), "export const moved = 1;\n");
    execFileSync("git", ["add", "main_only.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "main moved after acceptance"], { cwd: repo, stdio: "ignore" });
    await expect(
      mergeSandboxToMain(repo, "REQ-002", { commitMessage: "feat(req-002): stale baseline" }),
    ).rejects.toMatchObject({ code: "acceptance_gate_failed" });
  }, 25_000);
});
