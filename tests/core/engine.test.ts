import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  acceptRequirement,
  approveDesign,
  authorizeFastTrack,
  cancelRequirement,
  createRequirement,
  getDesignHistoryVersion,
  getProjectStatus,
  getRequirement,
  getRequirementDiff,
  getVerificationEvidence,
  initProject,
  listRequirements,
  propose,
  recordVerification,
  reopenRequirement,
  requestChanges,
  setRequirementTier,
  spawnSubRequirements,
  updateProjectConfig,
  updateSpec,
} from "../../src/core/engine.ts";
import { detectTestTamperingSignals } from "../../src/core/validity.ts";
import { discoverProjectContext } from "../../src/core/context.ts";
import { WorkbenchError } from "../../src/core/errors.ts";
import { resolveSafePath } from "../../src/core/fs.ts";
import { sanitizeOutput } from "../../src/core/validate.ts";
import type { VerificationRecord } from "../../src/core/types.ts";

const tempDirs: string[] = [];

function makeTempProject(withGitDir = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-core-test-"));
  tempDirs.push(dir);
  if (withGitDir) {
    fs.mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".git", "info", "exclude"), "# default\n");
  }
  return dir;
}

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function makeVerification(
  id: string,
  specHash: string,
  codeSnapshotHash: string,
  criterionIds: string[],
  passed: boolean,
): VerificationRecord {
  const now = Date.now();
  return {
    id,
    command: passed ? "bun test" : "bun test --failing",
    cwd: ".",
    criterionIds,
    specHash,
    codeSnapshotHash,
    exitCode: passed ? 0 : 1,
    timedOut: false,
    durationMs: 42,
    startedAt: now - 42,
    endedAt: now,
    passed,
    outputPath: `evidence/verify-${id}.log`,
    outputPreview: passed ? "all tests passed" : "1 test failed",
    truncated: false,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("WB-01 core store and domain engine", () => {
  test("initializes local vs tracked privacy modes idempotently and rejects double init", async () => {
    const localRoot = makeTempProject(true);
    expect(getProjectStatus(localRoot).initialized).toBe(false);

    const meta = await initProject(localRoot, { name: "demo", privacyMode: "local" });
    expect(meta.schemaVersion).toBe(6);
    expect(meta.nextNumber).toBe(1);
    expect(getProjectStatus(localRoot).initialized).toBe(true);

    const exclude = fs.readFileSync(path.join(localRoot, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/.workbench/");

    await expect(initProject(localRoot)).rejects.toMatchObject({ code: "already_initialized" });

    const trackedRoot = makeTempProject(true);
    await initProject(trackedRoot, { privacyMode: "tracked" });
    const trackedExclude = fs.readFileSync(path.join(trackedRoot, ".git", "info", "exclude"), "utf8");
    expect(trackedExclude).not.toContain("/.workbench/");
  });

  test("creates requirement from single sentence goal, allocates sequential IDs under concurrency, and reads summaries", async () => {
    const root = makeTempProject();
    await initProject(root);

    const [r1, r2] = await Promise.all([
      createRequirement(root, { goal: "# 修复登录态刷新竞态\n并发请求时只刷新一次 token" }),
      createRequirement(root, { goal: "补充导出脚本日志" }),
    ]);

    const ids = [r1.state.id, r2.state.id].sort();
    expect(ids).toEqual(["REQ-001", "REQ-002"]);
    expect(r1.state.stage).toBe("planning");
    expect(r1.state.revision).toBe(1);

    const list = listRequirements(root);
    expect(list).toHaveLength(2);
    expect(list.some((item) => item.title === "修复登录态刷新竞态")).toBe(true);
    expect(fs.existsSync(path.join(root, ".workbench", "items", "REQ-001", "spec.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".workbench", "items", "REQ-001", "state.json"))).toBe(true);
  });

  test("enforces CAS expectedRevision conflict protection", async () => {
    const root = makeTempProject();
    await initProject(root);
    const created = await createRequirement(root, { goal: "实现导出命令" });
    expect(created.state.revision).toBe(1);

    const updated = await updateSpec(root, "REQ-001", {
      title: "实现导出 CLI",
      expectedRevision: 1,
    });
    expect(updated.state.revision).toBe(2);

    await expect(
      updateSpec(root, "REQ-001", { title: "覆盖标题", expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: "revision_conflict" });

    expect(getRequirement(root, "REQ-001").state.title).toBe("实现导出 CLI");
  });

  test("enforces Plan-First lifecycle, snapshots design history, and invalidates approval on drift", async () => {
    const root = makeTempProject();
    await initProject(root);
    await createRequirement(root, { goal: "支持多语言错误提示" });

    // Cannot approve before a design proposal exists
    await expect(approveDesign(root, "REQ-001")).rejects.toMatchObject({ code: "approval_required" });

    const proposed = await propose(root, "REQ-001", {
      specMarkdown: "支持中英文错误提示，按请求 locale 切换",
      criteria: [
        { id: "AC-1", description: "英文 locale 返回英文错误", required: true, command: "bun test" },
        { id: "AC-2", description: "文档更新", required: false },
      ],
      designMarkdown: "## 方案 v1\n增加 i18n 字典映射。",
    });

    expect(proposed.state.stage).toBe("planning");
    expect(proposed.state.designVersion).toBe(1);
    expect(proposed.designHistoryVersions).toEqual([1]);
    expect(proposed.validity.needsDecision).toBe(true);
    expect(getDesignHistoryVersion(root, "REQ-001", 1)).toContain("方案 v1");

    // Human requests changes -> stays in planning with lastFeedback, then v2 proposed
    const rejected = await requestChanges(root, "REQ-001", { feedback: "需要兼容 fallback 语言" });
    expect(rejected.state.stage).toBe("planning");
    expect(rejected.state.lastFeedback).toBe("需要兼容 fallback 语言");

    const v2 = await propose(root, "REQ-001", {
      designMarkdown: "## 方案 v2\n增加 i18n 字典映射与 fallback。",
    });
    expect(v2.state.designVersion).toBe(2);
    expect(v2.state.stage).toBe("planning");
    expect(v2.state.lastFeedback).toBeNull();
    expect(v2.designHistoryVersions).toEqual([1, 2]);

    // Human approves v2
    const approved = await approveDesign(root, "REQ-001", {
      baseline: { head: "abc1234", fingerprint: sha("base"), dirty: false, capturedAt: Date.now() },
    });
    expect(approved.state.stage).toBe("coding");
    expect(approved.validity.approval.valid).toBe(true);

    // Agent cannot unilaterally mutate spec or revert coding -> planning; human spec drift invalidates approval back to planning
    await expect(
      propose(root, "REQ-001", {
        specMarkdown: "支持中日英文错误提示",
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    expect(getRequirement(root, "REQ-001").state.stage).toBe("coding");

    const drifted = await propose(root, "REQ-001", {
      specMarkdown: "支持中日英文错误提示",
      actor: "human",
    });
    expect(drifted.state.stage).toBe("planning");
    expect(drifted.state.approval).toBeNull();
    expect(drifted.validity.approval.valid).toBe(false);
  });

  test("enforces Fast-Track authorization and criteria-tampering guardrail", async () => {
    const root = makeTempProject();
    await initProject(root);
    await createRequirement(root, {
      goal: "修复拼写错误",
      criteria: [{ id: "AC-1", description: "类型检查通过", required: true, command: "bun run typecheck" }],
    });

    const fast = await authorizeFastTrack(root, "REQ-001");
    expect(fast.state.track).toBe("fast_track");
    expect(fast.state.stage).toBe("coding");
    expect(fast.validity.approval.valid).toBe(true);

    // If agent tries to tamper with criteria during fast_track, it is rejected with invalid_transition (FLOW §1.5)
    await expect(
      propose(root, "REQ-001", {
        criteria: [{ id: "AC-1", description: "放宽条件", required: false }],
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    expect(getRequirement(root, "REQ-001").state.stage).toBe("coding");
    expect(getRequirement(root, "REQ-001").validity.approval.valid).toBe(true);

    // However, if a requirement started on fast_track with ZERO criteria, agent populating initial criteria preserves fast_track coding stage
    await createRequirement(root, { goal: "输出 hello 脚本" });
    await authorizeFastTrack(root, "REQ-002");
    const bootstrapped = await propose(root, "REQ-002", {
      criteria: [{ id: "AC-1", description: "输出 hello", required: true, command: "echo hello" }],
    });
    expect(bootstrapped.state.stage).toBe("coding");
    expect(bootstrapped.validity.approval.valid).toBe(true);
  });

  test("blocks verification before human approval", async () => {
    const root = makeTempProject();
    await initProject(root);
    const created = await createRequirement(root, {
      goal: "门禁测试",
      criteria: [{ id: "AC-1", description: "测试通过", required: true, command: "bun test" }],
    });
    const snap = sha("guard-snapshot");

    await expect(
      recordVerification(root, "REQ-001", {
        record: makeVerification("V-guard-1", created.state.specHash, snap, ["AC-1"], true),
        rawLog: "ok",
        currentCodeSnapshotHash: snap,
      }),
    ).rejects.toMatchObject({ code: "approval_required" });

    const proposed = await propose(root, "REQ-001", { designMarkdown: "# Design" });
    await expect(
      recordVerification(root, "REQ-001", {
        record: makeVerification("V-guard-2", proposed.state.specHash, snap, ["AC-1"], true),
        rawLog: "ok",
        currentCodeSnapshotHash: snap,
      }),
    ).rejects.toMatchObject({ code: "approval_required" });

    const approved = await approveDesign(root, "REQ-001");
    const recorded = await recordVerification(root, "REQ-001", {
      record: makeVerification("V-guard-3", approved.state.specHash, snap, ["AC-1"], true),
      rawLog: "ok",
      currentCodeSnapshotHash: snap,
    });
    expect(recorded.state.verifications).toHaveLength(1);
  });

  test("enforces verification truthfulness, stale detection, zero-criteria rejection, and acceptance gate", async () => {
    const root = makeTempProject();
    await initProject(root);
    await createRequirement(root, { goal: "重构配置解析" });

    // Fast-track with zero criteria -> 0/0 MUST be rejected at acceptance gate
    await authorizeFastTrack(root, "REQ-001");
    const snap1 = sha("snapshot-1");
    await expect(acceptRequirement(root, "REQ-001", { currentCodeSnapshotHash: snap1 })).rejects.toMatchObject({
      code: "acceptance_gate_failed",
    });

    // Add required criterion & re-authorize
    await updateSpec(root, "REQ-001", {
      criteria: [{ id: "AC-1", description: "单元测试通过", required: true, command: "bun test" }],
    });
    const active = await authorizeFastTrack(root, "REQ-001");

    // Failing verification cannot pass gate
    await recordVerification(root, "REQ-001", {
      record: makeVerification("V-1", active.state.specHash, snap1, ["AC-1"], false),
      rawLog: "failed log",
      currentCodeSnapshotHash: snap1,
    });
    await expect(acceptRequirement(root, "REQ-001", { currentCodeSnapshotHash: snap1 })).rejects.toMatchObject({
      code: "acceptance_gate_failed",
    });

    // Passing verification on snap1 passes gate on snap1
    await recordVerification(root, "REQ-001", {
      record: makeVerification("V-2", active.state.specHash, snap1, ["AC-1"], true),
      rawLog: "ok log",
      currentCodeSnapshotHash: snap1,
    });
    expect(getVerificationEvidence(root, "REQ-001", "V-2").log).toBe("ok log");

    // Code changes to snap2 -> V-2 becomes stale, gate fails!
    const snap2 = sha("snapshot-2");
    const detailStale = getRequirement(root, "REQ-001", { currentCodeSnapshotHash: snap2 });
    expect(detailStale.validity.verifications[1]?.effectiveState).toBe("stale");
    expect(detailStale.validity.acceptanceGate.ok).toBe(false);
    await expect(acceptRequirement(root, "REQ-001", { currentCodeSnapshotHash: snap2 })).rejects.toMatchObject({
      code: "acceptance_gate_failed",
    });

    // Missing snapshot (null) -> passed record renders as unknown and cannot accept
    const detailMissing = getRequirement(root, "REQ-001", { currentCodeSnapshotHash: null });
    expect(detailMissing.validity.verifications[1]?.effectiveState).toBe("unknown");
    await expect(acceptRequirement(root, "REQ-001", { currentCodeSnapshotHash: null })).rejects.toMatchObject({
      code: "acceptance_gate_failed",
    });

    // Re-run verification on snap2 + accept
    await requestChanges(root, "REQ-001", { feedback: "同步主干" });
    expect(getRequirement(root, "REQ-001").state.lastFeedback).toBe("同步主干");
    await recordVerification(root, "REQ-001", {
      record: makeVerification("V-3", active.state.specHash, snap2, ["AC-1"], true),
      rawLog: "ok log 2",
      currentCodeSnapshotHash: snap2,
    });

    const done = await acceptRequirement(root, "REQ-001", { currentCodeSnapshotHash: snap2, note: "LGTM" });
    expect(done.state.stage).toBe("done");
    expect(done.state.acceptance?.verificationIds).toEqual(["V-3"]);
  });

  test("handles cancel and reopen preserving history without reviving old approvals", async () => {
    const root = makeTempProject();
    await initProject(root);
    await createRequirement(root, {
      goal: "接入支付回调",
      criteria: [{ id: "AC-1", description: "验签通过", required: true }],
    });
    await authorizeFastTrack(root, "REQ-001");

    const cancelled = await cancelRequirement(root, "REQ-001", { reason: "需求变更取消" });
    expect(cancelled.state.stage).toBe("cancelled");
    await expect(setRequirementTier(root, "REQ-001", "sota")).rejects.toMatchObject({
      code: "invalid_transition",
    });

    const reopened = await reopenRequirement(root, "REQ-001", { reason: "重启需求" });
    expect(reopened.state.stage).toBe("planning");
    expect(reopened.state.approval).toBeNull();
    expect(reopened.state.acceptance).toBeNull();
    expect(reopened.state.timeline.some((e) => e.kind === "reopened")).toBe(true);
  });

  test("rejects path traversal, symlinks, and redacts credentials safely", () => {
    const root = makeTempProject();
    expect(() => resolveSafePath(root, "../escape")).toThrow(WorkbenchError);
    expect(() => resolveSafePath(root, "/abs/path")).toThrow(WorkbenchError);

    const targetFile = path.join(root, "real.txt");
    const linkFile = path.join(root, "link.txt");
    fs.writeFileSync(targetFile, "secret");
    fs.symlinkSync(targetFile, linkFile);
    expect(() => resolveSafePath(root, "link.txt")).toThrow(WorkbenchError);

    const sanitized = sanitizeOutput(
      "\x1b[32mok\x1b[0m Bearer secret-token-123 api_key=abc12345 sk-test1234567890 中文",
      60,
    );
    expect(sanitized.text).not.toContain("secret-token-123");
    expect(sanitized.text).not.toContain("abc12345");
    expect(sanitized.text).not.toContain("\x1b");
    expect(sanitized.truncated).toBe(true);
  });

  test("preserves forward-compatible extension fields under same schemaVersion and isolates corrupt records in listRequirements", async () => {
    const root = makeTempProject();
    await initProject(root);
    await createRequirement(root, { goal: "正常需求一" });
    await createRequirement(root, { goal: "正常需求二" });

    // Inject a future optional extension field into REQ-001/state.json and project.json.
    const state1Path = path.join(root, ".workbench", "items", "REQ-001", "state.json");
    const rawState1 = JSON.parse(fs.readFileSync(state1Path, "utf8")) as Record<string, unknown>;
    rawState1.futureBranchExtension = { enabled: true, tags: ["rsi"] };
    fs.writeFileSync(state1Path, JSON.stringify(rawState1, null, 2));

    const projectPath = path.join(root, ".workbench", "project.json");
    const rawProject = JSON.parse(fs.readFileSync(projectPath, "utf8")) as Record<string, unknown>;
    rawProject.futureProjectField = "vNext";
    fs.writeFileSync(projectPath, JSON.stringify(rawProject, null, 2));

    // Mutating REQ-001 must succeed and preserve the unknown extension field verbatim.
    await propose(root, "REQ-001", { designMarkdown: "# 设计", actor: "agent" });
    const afterState1 = JSON.parse(fs.readFileSync(state1Path, "utf8")) as Record<string, unknown>;
    expect(afterState1.futureBranchExtension).toEqual({ enabled: true, tags: ["rsi"] });

    // Prototype-pollution keys are still rejected.
    const state2Path = path.join(root, ".workbench", "items", "REQ-002", "state.json");
    const rawState2 = JSON.parse(fs.readFileSync(state2Path, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(state2Path, JSON.stringify({ ...rawState2, constructor: { polluted: true } }, null, 2));

    const corruptEntries: Array<{ id: string; code: string; message: string }> = [];
    const list = listRequirements(root, {
      scope: "all",
      onCorrupt: (entry) => corruptEntries.push(entry),
    });
    expect(list.map((r) => r.id)).toEqual(["REQ-001"]);
    expect(corruptEntries).toHaveLength(1);
    expect(corruptEntries[0]!.id).toBe("REQ-002");
    expect(corruptEntries[0]!.code).toBe("corrupt_record");
  });

  test("discoverProjectContext extracts arch doc headings, stack commands, and respects verification overrides", async () => {
    const dir = makeTempProject();
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Agent Rules\n\n## Boundaries\n\nKeep domain clean.\n");
    fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(dir, "docs", "DESIGN.md"), "# Architecture\n\n## Data Flow\n");
    fs.writeFileSync(path.join(dir, "bun.lock"), "");
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "sample", scripts: { typecheck: "tsc --noEmit", test: "bun test" } }),
    );

    const detected = discoverProjectContext(dir, null);
    expect(detected.archDocs.map((d) => d.path)).toEqual(["AGENTS.md", "docs/DESIGN.md"]);
    expect(detected.archDocs[0]!.headings).toEqual(["Agent Rules", "Boundaries"]);
    expect(detected.commandSource).toBe("package.json");
    expect(detected.fastCommand).toBe("bun run typecheck");
    expect(detected.fullCommand).toBe("bun test");

    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "sample", scripts: { typecheck: "tsc --noEmit", test: "bun run scripts/test.ts" } }),
    );
    expect(discoverProjectContext(dir, null).fullCommand).toBe("bun run test");

    await initProject(dir, { name: "Sample" });
    const updated = await updateProjectConfig(dir, {
      verification: {
        fastCommand: "cargo check",
        fullCommand: "cargo test --all",
        autoScreenshots: false,
      },
    });
    const configured = discoverProjectContext(dir, updated);
    expect(configured.commandSource).toBe("configured");
    expect(configured.fastCommand).toBe("cargo check");
    expect(configured.fullCommand).toBe("cargo test --all");
    expect(updated.verification?.autoScreenshots).toBe(false);
  });

  test("propose preserves approval on non-breaking refinements during coding but drops it on breaking edits", async () => {
    const dir = makeTempProject();
    await initProject(dir, { name: "Elastic Gate" });
    await createRequirement(dir, { goal: "实现弹性审批更新" });

    await propose(dir, "REQ-001", {
      designMarkdown: "# Design\n\nInitial plan.",
      criteria: [{ id: "AC-1", description: "passes core tests", command: "bun test", required: true }],
      actor: "agent",
    });
    const approved = await approveDesign(dir, "REQ-001");
    expect(approved.state.stage).toBe("coding");
    const approvedHash = approved.state.approval!.designHash;

    // Adding a criterion while preserving all required criteria and design keeps approval valid.
    const refined = await propose(dir, "REQ-001", {
      criteria: [
        { id: "AC-1", description: "passes core tests", command: "bun test", required: true },
        { id: "AC-2", description: "passes typecheck", command: "bun run typecheck", required: true },
      ],
      actor: "agent",
    });
    expect(refined.state.stage).toBe("coding");
    expect(refined.state.approval).not.toBeNull();

    // Agent attempting breaking edits (command mutation, design rewrite, or weakening required->optional) in coding
    // MUST be rejected with invalid_transition instead of unilaterally reverting coding -> planning (FLOW §1.5).
    await expect(
      propose(dir, "REQ-001", {
        criteria: [
          { id: "AC-1", description: "passes core tests", command: "echo ok", required: true },
          { id: "AC-2", description: "passes typecheck", command: "bun run typecheck", required: true },
        ],
        actor: "agent",
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });

    await expect(
      propose(dir, "REQ-001", {
        designMarkdown: "# Design\n\nRewritten in coding.",
        actor: "agent",
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });

    await expect(
      propose(dir, "REQ-001", {
        criteria: [
          { id: "AC-1", description: "passes core tests", command: "bun test", required: false },
          { id: "AC-2", description: "passes typecheck", command: "bun run typecheck", required: true },
        ],
        actor: "agent",
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });

    // Human-initiated breaking edit (actor: "human") cleanly invalidates approval back to planning.
    const humanBreaking = await propose(dir, "REQ-001", {
      criteria: [{ id: "AC-1", description: "passes core tests", command: "echo ok", required: false }],
      actor: "human",
    });
    expect(humanBreaking.state.stage).toBe("planning");
    expect(humanBreaking.state.approval).toBeNull();
  });

  test("authorizeFastTrack auto-populates AC-1 when project.verification.fastCommand is configured", async () => {
    const dir = makeTempProject();
    await initProject(dir, { name: "FastTrack Auto" });
    await updateProjectConfig(dir, { verification: { fastCommand: "npm run lint" } });
    await createRequirement(dir, { goal: "快速修复样式与类型" });

    const fast = await authorizeFastTrack(dir, "REQ-001");
    expect(fast.state.stage).toBe("coding");
    expect(fast.state.criteria).toEqual([
      {
        id: "AC-1",
        description: "项目快速基线验证通过",
        command: "npm run lint",
        required: true,
        systemInjected: true,
      },
    ]);
  });

  test("spawnSubRequirements links children via parentId and rejects cancelled parents", async () => {
    const dir = makeTempProject();
    await initProject(dir, { name: "Spawn SubReqs" });
    await createRequirement(dir, { goal: "整体系统重构架构方案" });
    await propose(dir, "REQ-001", {
      designMarkdown: [
        "# 整体方案",
        "",
        "## 认证模块拆分",
        "拆分并重构认证模块与路由校验。",
        "",
        "## 分层缓存实现",
        "增加分层缓存与失效清理逻辑。",
      ].join("\n"),
      criteria: [{ id: "AC-1", description: "pass", command: "bun test", required: true }],
      actor: "agent",
    });

    const spawned = await spawnSubRequirements(dir, "REQ-001");
    expect(spawned.created).toHaveLength(2);
    expect(spawned.created[0]!.state.parentId).toBe("REQ-001");
    expect(spawned.created[1]!.state.parentId).toBe("REQ-001");
    const parentDetail = getRequirement(dir, "REQ-001");
    expect(parentDetail.subRequirements?.map((r) => r.id).sort()).toEqual(["REQ-002", "REQ-003"]);

    await cancelRequirement(dir, "REQ-001", { reason: "不再拆分子需求" });
    await expect(spawnSubRequirements(dir, "REQ-001")).rejects.toThrow("已取消");
  });

  test("blocks agent design rewrites during coding after verifications pass while allowing non-breaking criteria additions", async () => {
    const dir = makeTempProject();
    await initProject(dir, { name: "NonBreaking Acceptance" });
    await createRequirement(dir, { goal: "待验收期锁定已批准方案并支持非破坏性补充条件" });

    await propose(dir, "REQ-001", {
      designMarkdown: "# Design\n\nInitial plan.",
      criteria: [{ id: "AC-1", description: "ok", command: "echo ok", required: true }],
      actor: "agent",
    });
    await approveDesign(dir, "REQ-001");
    const specHash = getRequirement(dir, "REQ-001").state.specHash;
    const snap1 = "a".repeat(64);
    await recordVerification(dir, "REQ-001", {
      record: makeVerification("V-100", specHash, snap1, ["AC-1"], true),
      rawLog: "ok\n",
      currentCodeSnapshotHash: snap1,
    });

    await expect(
      propose(dir, "REQ-001", {
        designMarkdown: "# Design\n\nInitial plan.\n\n## 交付说明\n已补充证据。",
        actor: "agent",
        currentCodeSnapshotHash: snap1,
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });

    const withExtraCheck = await propose(dir, "REQ-001", {
      criteria: [
        { id: "AC-1", description: "ok", command: "echo ok", required: true },
        { id: "AC-2", description: "交付说明已补充", required: false },
      ],
      actor: "agent",
      currentCodeSnapshotHash: snap1,
    });
    expect(withExtraCheck.state.stage).toBe("coding");
    expect(withExtraCheck.state.approval).not.toBeNull();
  });

  test("discoverProjectContext skips mutating --fix/--write scripts and prefers lint:check / test:local", () => {
    const dir = makeTempProject();
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "api-proxy",
        scripts: {
          lint: "eslint . --fix",
          "lint:check": "eslint .",
          test: "npm run lint -- --fix && npm run test:local",
          "test:local": "egg-bin test",
        },
      }),
    );
    const ctx = discoverProjectContext(dir);
    expect(ctx.fastCommand).toBe("npm run lint:check");
    expect(ctx.fullCommand).toBe("npm run test:local");
  });

  test("preserves approval when human relaxes criteria to optional, and allows overrideReason waiver (except 0/0)", async () => {
    const dir = makeTempProject();
    await initProject(dir, { name: "Human Sovereignty" });
    await createRequirement(dir, { goal: "外部验证豁免与人工放行" });
    await propose(dir, "REQ-001", {
      designMarkdown: "# Design\n\nScoped fix.",
      criteria: [
        { id: "AC-1", description: "lint", command: "echo ok", required: true },
        { id: "AC-2", description: "manual login e2e", required: true },
      ],
      actor: "agent",
    });
    await approveDesign(dir, "REQ-001");

    // Relaxing AC-2 to optional preserves approval & implementing stage
    const relaxed = await updateSpec(dir, "REQ-001", {
      criteria: [
        { id: "AC-1", description: "lint", command: "echo ok", required: true },
        { id: "AC-2", description: "manual login e2e", required: false },
      ],
    });
    expect(relaxed.state.stage).toBe("coding");
    expect(relaxed.validity.approval.valid).toBe(true);

    // Leave AC-1 unverified: plain accept fails, overrideReason succeeds cleanly
    const snap = sha("snapshot-waive");
    await expect(acceptRequirement(dir, "REQ-001", { currentCodeSnapshotHash: snap })).rejects.toMatchObject({
      code: "acceptance_gate_failed",
    });

    const waived = await acceptRequirement(dir, "REQ-001", {
      currentCodeSnapshotHash: snap,
      overrideReason: "已在测试环境人工确认并提交 PR",
    });
    expect(waived.state.stage).toBe("done");
    expect(waived.state.acceptance?.overrideReason).toBe("已在测试环境人工确认并提交 PR");
    expect(waived.state.acceptance?.reviewDisposition?.acceptedRisks?.length).toBeGreaterThanOrEqual(1);
    expect(waived.acceptanceSnapshot?.requiredPassed).toBe(0);

    // Even with overrideReason, 0/0 required criteria cannot be waived
    await createRequirement(dir, { goal: "无必需条件不可验收" });
    await authorizeFastTrack(dir, "REQ-002");
    await expect(
      acceptRequirement(dir, "REQ-002", {
        currentCodeSnapshotHash: snap,
        overrideReason: "试图跳过 0/0 约束",
      }),
    ).rejects.toMatchObject({ code: "acceptance_gate_failed" });
  });

  test("detectTestTamperingSignals flags deleted/skipped tests and dropped assertions, and surfaces via getRequirementDiff", async () => {
    expect(
      detectTestTamperingSignals(
        [{ path: "tests/foo.test.ts", status: "D", staged: false, unstaged: true }],
        "",
      ).length,
    ).toBeGreaterThan(0);

    expect(
      detectTestTamperingSignals(
        [{ path: "tests/foo.test.ts", status: "M", staged: false, unstaged: true }],
        [
          "diff --git a/tests/foo.test.ts b/tests/foo.test.ts",
          "+test.skip('flaky', () => {});",
        ].join("\n"),
      ).length,
    ).toBeGreaterThan(0);

    expect(
      detectTestTamperingSignals(
        [{ path: "tests/foo.test.ts", status: "M", staged: false, unstaged: true }],
        [
          "diff --git a/tests/foo.test.ts b/tests/foo.test.ts",
          "-  expect(res.ok).toBe(true);",
          "-  expect(res.status).toBe(200);",
        ].join("\n"),
      ).length,
    ).toBeGreaterThan(0);

    // Replacing assertions without dropping them should not flag
    expect(
      detectTestTamperingSignals(
        [{ path: "tests/foo.test.ts", status: "M", staged: false, unstaged: true }],
        [
          "diff --git a/tests/foo.test.ts b/tests/foo.test.ts",
          "-  expect(res.ok).toBe(true);",
          "+  expect(res.status).toBe(200);",
        ].join("\n"),
      ),
    ).toEqual([]);

    // Non-test file containing test.skip literal must not trigger false positive,
    // while per-file dropped assertions still trigger even if another test file adds assertions.
    expect(
      detectTestTamperingSignals(
        [{ path: "src/helper.ts", status: "M", staged: false, unstaged: true }],
        [
          "diff --git a/src/helper.ts b/src/helper.ts",
          "+const pattern = /test\\.skip\\(/;",
        ].join("\n"),
      ),
    ).toEqual([]);
    expect(
      detectTestTamperingSignals(
        [
          { path: "tests/a.test.ts", status: "M", staged: false, unstaged: true },
          { path: "tests/b.test.ts", status: "M", staged: false, unstaged: true },
        ],
        [
          "diff --git a/tests/a.test.ts b/tests/a.test.ts",
          "-  expect(a).toBe(1);",
          "-  expect(b).toBe(2);",
          "diff --git a/tests/b.test.ts b/tests/b.test.ts",
          "+  expect(c).toBe(3);",
        ].join("\n"),
      ).some((s) => s.includes("tests/a.test.ts")),
    ).toBe(true);

    // End-to-end via getRequirementDiff on a real git repo
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wb-core-tamper-"));
    tempDirs.push(repo);
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo, stdio: "ignore" });
    fs.mkdirSync(path.join(repo, "tests"), { recursive: true });
    fs.writeFileSync(path.join(repo, "tests/app.test.ts"), "test('works', () => { expect(1).toBe(1); });\n");
    execFileSync("git", ["add", "tests/app.test.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });

    await initProject(repo, { name: "TamperTest" });
    await createRequirement(repo, { goal: "Detect test tampering" });
    await authorizeFastTrack(repo, "REQ-001");

    // Agent disables a test using test.skip
    fs.writeFileSync(path.join(repo, "tests/app.test.ts"), "test.skip('works', () => { expect(1).toBe(1); });\n");
    const diffView = await getRequirementDiff(repo, "REQ-001");
    expect(diffView.testTamperingSignals?.length).toBeGreaterThan(0);
  });
});
