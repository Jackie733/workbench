import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverProjectContext } from "../../src/core/context.ts";
import {
  approveDesign,
  authorizeFastTrack,
  createRequirement,
  extractInlineCriteriaFromDesign,
  getRequirement,
  initProject,
  propose,
  setRequirementTier,
} from "../../src/core/engine.ts";
import { runAllVerifications, runVerification } from "../../src/core/runner.ts";
import { SCHEMA_VERSION } from "../../src/core/types.ts";
import { detectTestTamperingSignals } from "../../src/core/validity.ts";
import { buildInitialProjectRouting, resolveRouteCandidates } from "../../src/hub/routing.ts";
import { extractTraceHandoffSummary, synthesizeHandoffPacket } from "../../src/hub/handoff.ts";
import { buildHarnessCommand } from "../../src/hub/harness_cmd.ts";
import { syncDesignRunResult } from "../../src/hub/post_run.ts";
import type { HarnessInfo, RoutingConfig } from "../../src/hub/types.ts";
import { startWorkbenchServer } from "../../src/server/index.ts";
import { resolveEffectiveRouting } from "../../src/web/queries.ts";
import { activeRunnerChoice } from "../../src/web/state.ts";
import { checkDeployment } from "../../scripts/check-deployment.ts";
import { migrateProjectToV6 } from "../../scripts/migrate-v6.ts";

const tempDirs: string[] = [];

function mkTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function mkTempGitRepo(prefix: string): string {
  const dir = mkTempDir(prefix);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "index.ts"), "export const ok = true;\n");
  execFileSync("git", ["add", "index.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Workbench v6 architecture convergence", () => {
  it("supports 4-stage lifecycle, derived states, and human tier toggling", async () => {
    const root = mkTempDir("wb-v6-lifecycle-");
    await initProject(root, { name: "v6-demo", privacyMode: "local" });

    const created = await createRequirement(root, { goal: "Implement v6 convergence" });
    expect(created.state.schemaVersion).toBe(SCHEMA_VERSION);
    expect(created.state.stage).toBe("planning");
    expect(created.state.tier).toBe("standard");

    const proposed = await propose(root, created.state.id, {
      designMarkdown: "# Design\n\nMinimal 4-stage plan.",
      criteria: [{ id: "AC-1", description: "passes", required: true, command: "echo ok" }],
    });
    expect(proposed.state.stage).toBe("planning");
    expect(proposed.validity.banner.primaryAction?.id).toBe("approve_and_implement");

    const approved = await approveDesign(root, created.state.id, {
      expectedRevision: proposed.state.revision,
    });
    expect(approved.state.stage).toBe("coding");

    const escalated = await setRequirementTier(root, created.state.id, "sota", {
      expectedRevision: approved.state.revision,
      reason: "complex bug",
    });
    expect(escalated.state.tier).toBe("sota");
  });

  it("enforces zero global fallback and keeps standard tier isolated from sotaLead", () => {
    const harnesses: HarnessInfo[] = [
      {
        id: "codex",
        label: "Codex",
        installed: true,
        executable: "codex",
        subscription: "ChatGPT Plus",
        models: [
          { id: "gpt-5.4", tier: "sota", source: "detected" },
          { id: "gpt-5.4-mini", tier: "fast", source: "detected" },
        ],
        defaultModel: "gpt-5.4",
        detectedAt: Date.now(),
      },
      {
        id: "qodercn",
        label: "QoderCN",
        installed: true,
        executable: "qodercn",
        subscription: "QoderCN",
        models: [
          { id: "Qwen4-Max", tier: "balanced", source: "detected" },
          { id: "DeepSeek-V4-Pro", tier: "sota", source: "detected" },
        ],
        defaultModel: "Qwen4-Max",
        detectedAt: Date.now(),
      },
    ];

    const initial = buildInitialProjectRouting(harnesses);
    expect(initial.defaultLead.primary.model).toBeTruthy();
    expect(initial.sotaLead.primary.model).toBeTruthy();
    expect(initial.reviewer.primary.model).toBeTruthy();

    const custom: RoutingConfig = {
      defaultLead: {
        primary: { harness: "qodercn", model: "Qwen4-Max" },
        fallbacks: [{ harness: "codex", model: "gpt-5.4-mini" }],
      },
      sotaLead: {
        primary: { harness: "codex", model: "gpt-5.4" },
        fallbacks: [{ harness: "qodercn", model: "DeepSeek-V4-Pro" }],
      },
      reviewer: {
        primary: { harness: "codex", model: "gpt-5.4" },
        fallbacks: [],
      },
      autoReview: true,
      autoHeal: true,
    };

    const standardCandidates = resolveRouteCandidates(custom, harnesses, "fix", "standard");
    expect(standardCandidates.map((c) => `${c.harness}/${c.model}`)).toEqual([
      "qodercn/Qwen4-Max",
      "codex/gpt-5.4-mini",
    ]);
    expect(standardCandidates.some((c) => c.model === "gpt-5.4")).toBe(false);

    const sotaCandidates = resolveRouteCandidates(custom, harnesses, "fix", "sota");
    expect(sotaCandidates[0]).toEqual({ harness: "codex", model: "gpt-5.4" });

    const reviewCandidates = resolveRouteCandidates(custom, harnesses, "review", "standard");
    expect(reviewCandidates[0]).toEqual({ harness: "codex", model: "gpt-5.4" });
  });

  it("extracts inline workbench-criteria blocks and skips duplicate propose()", async () => {
    const md = [
      "# Design",
      "",
      "```workbench-criteria",
      JSON.stringify([
        { id: "AC-1", description: "Typecheck passes", required: true, command: "bun run typecheck" },
      ]),
      "```",
    ].join("\n");
    const extracted = extractInlineCriteriaFromDesign(md);
    expect(extracted).toHaveLength(1);
    expect(extracted![0]!.id).toBe("AC-1");

    const root = mkTempDir("wb-v6-inline-");
    await initProject(root, { name: "inline-demo", privacyMode: "local" });
    const req = await createRequirement(root, { goal: "Inline criteria sync" });
    const reqDir = path.join(root, ".workbench", "items", req.state.id);
    fs.writeFileSync(path.join(reqDir, "design.md"), md, "utf8");

    const projectContext = discoverProjectContext(root, null);
    const diskReq = getRequirement(root, req.state.id);
    const synced = await syncDesignRunResult({
      base: root,
      codeRoot: root,
      id: req.state.id,
      latestReq: diskReq,
      preSpecMarkdown: req.specMarkdown,
      preDesignMarkdown: req.designMarkdown,
      codeChanged: false,
      projectContext,
      snapshotFingerprint: null,
      appendNote: () => {},
    });
    expect(synced.state.designVersion).toBe(1);
    const afterFirst = getRequirement(root, req.state.id);
    expect(afterFirst.state.designVersion).toBe(1);
    expect(afterFirst.state.criteria.some((c) => c.id === "AC-1")).toBe(true);

    // Calling syncDesignRunResult again when designVersion already advanced should NOT duplicate propose()
    const secondSync = await syncDesignRunResult({
      base: root,
      codeRoot: root,
      id: req.state.id,
      latestReq: afterFirst,
      preSpecMarkdown: afterFirst.specMarkdown,
      preDesignMarkdown: afterFirst.designMarkdown,
      codeChanged: false,
      projectContext,
      snapshotFingerprint: null,
      appendNote: () => {},
    });
    expect(secondSync.state.designVersion).toBe(1);
    expect(getRequirement(root, req.state.id).state.designVersion).toBe(1);
  });

  it("clips runner outputPreview head+tail and runs fast commands before heavy with failFast", async () => {
    const root = mkTempGitRepo("wb-v6-runner-");
    await initProject(root, { name: "runner-demo", privacyMode: "local" });
    const req = await createRequirement(root, { goal: "Runner improvements" });
    await authorizeFastTrack(root, req.state.id, { expectedRevision: req.state.revision });

    const longOut = await runVerification(root, req.state.id, {
      command: `node -e "console.log('HEAD_MARKER'); console.log('x'.repeat(6000)); console.log('TAIL_ERROR_MARKER'); process.exit(1)"`,
      criterionIds: [],
    });
    expect(longOut.record.passed).toBe(false);
    expect(longOut.record.outputPreview).toContain("HEAD_MARKER");
    expect(longOut.record.outputPreview).toContain("TAIL_ERROR_MARKER");

    await propose(root, req.state.id, {
      designMarkdown: "# Design",
      criteria: [
        { id: "AC-HEAVY", description: "heavy test", required: true, command: "bun test && echo heavy" },
        { id: "AC-FAST", description: "fast typecheck", required: true, command: "echo typecheck_fail && exit 1" },
      ],
    });

    const fastFail = await runAllVerifications(root, req.state.id, { failFast: true });
    expect(fastFail.runs).toHaveLength(1);
    expect(fastFail.runs[0]!.record.command).toContain("typecheck_fail");
    expect(fastFail.runs[0]!.record.passed).toBe(false);
  });

  it("detects multi-language test tampering signals including net removed assertions", () => {
    const pyDiff = [
      "diff --git a/tests/test_auth.py b/tests/test_auth.py",
      "--- a/tests/test_auth.py",
      "+++ b/tests/test_auth.py",
      "@@ -1,5 +1,2 @@",
      "-assert user.is_admin",
      "-assert token.valid",
      "+@pytest.mark.skip",
    ].join("\n");
    const pySignals = detectTestTamperingSignals(
      [{ path: "tests/test_auth.py", status: "M", staged: false, unstaged: true }],
      pyDiff,
    );
    expect(pySignals.length).toBeGreaterThanOrEqual(1);
    expect(pySignals.some((s) => s.includes("test_auth.py"))).toBe(true);

    const goDiff = [
      "diff --git a/pkg/auth_test.go b/pkg/auth_test.go",
      "--- a/pkg/auth_test.go",
      "+++ b/pkg/auth_test.go",
      "@@ -10,4 +10,2 @@",
      "-t.Fatal(err)",
      "-assert.Equal(t, a, b)",
      '+t.Skip("todo")',
    ].join("\n");
    const goSignals = detectTestTamperingSignals(
      [{ path: "pkg/auth_test.go", status: "M", staged: false, unstaged: true }],
      goDiff,
    );
    expect(goSignals.some((s) => s.includes("auth_test.go"))).toBe(true);
  });

  it("extracts previous trace summary and deduplicates feedback in handoff", async () => {
    const root = mkTempDir("wb-v6-handoff-");
    await initProject(root, { name: "handoff-demo", privacyMode: "local" });
    const req = await createRequirement(root, { goal: "Trace handoff" });
    const runsDir = path.join(root, ".workbench", "items", req.state.id, "runs");
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(
      path.join(runsDir, "run-r1.json"),
      JSON.stringify({
        id: "r1",
        action: "implement",
        harness: "codex",
        model: "gpt-5.4",
        status: "failed",
        startedAt: 1000,
        endedAt: 2000,
        exitCode: 1,
        durationMs: 1000,
        logPath: "runs/run-r1.log",
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(runsDir, "run-r1.events.jsonl"),
      [
        JSON.stringify({ seq: 1, ts: 1000, type: "tool.end", toolName: "edit_file", summary: "edited src/a.ts", filesTouched: ["src/a.ts"] }),
        JSON.stringify({ seq: 2, ts: 2000, type: "tool.end", toolName: "bash", summary: "bun test", isError: true }),
      ].join("\n") + "\n",
      "utf8",
    );

    const summary = extractTraceHandoffSummary(root, req.state.id, "r1");
    expect(summary).toContain("src/a.ts");
    expect(summary).toContain("bun test");

    const { markdown: md } = await synthesizeHandoffPacket(root, req.state.id, {
      action: "fix",
      humanInstruction: "Fix the failing assertion",
    });
    expect(md).toContain("Fix the failing assertion");
  });

  it("migrates a v4 fixture project to v6 cleanly (dry-run and write)", () => {
    const root = mkTempDir("wb-v6-migrate-");
    const wbDir = path.join(root, ".workbench");
    const reqDir = path.join(wbDir, "items", "REQ-001");
    fs.mkdirSync(reqDir, { recursive: true });
    fs.writeFileSync(
      path.join(wbDir, "project.json"),
      JSON.stringify({
        schemaVersion: 4,
        projectId: "proj-1",
        name: "legacy-proj",
        nextNumber: 2,
        privacyMode: "local",
        createdAt: 1000,
        updatedAt: 1000,
      }),
    );
    fs.writeFileSync(path.join(reqDir, "spec.md"), "# Legacy Spec\n");
    fs.writeFileSync(path.join(reqDir, "design.md"), "# Legacy Design\n");
    fs.writeFileSync(
      path.join(reqDir, "state.json"),
      JSON.stringify({
        schemaVersion: 4,
        id: "REQ-001",
        title: "Legacy Req",
        stage: "implementing",
        track: "plan_first",
        revision: 3,
        specHash: "a".repeat(64),
        designVersion: 1,
        designHash: "b".repeat(64),
        criteria: [{ id: "AC-1", description: "ok", required: true }],
        approval: {
          track: "plan_first",
          specHash: "a".repeat(64),
          designVersion: 1,
          designHash: "b".repeat(64),
          baselineHead: null,
          baselineFingerprint: null,
          approvedAt: 2000,
        },
        acceptance: null,
        delivery: null,
        tasks: [{ id: "T-1", title: "old task", status: "done" }],
        baseline: null,
        verifications: [],
        timeline: [],
        lastFeedback: null,
        blockedFrom: null,
        blockedReason: null,
        handoffNote: { updatedAt: 1000, keyDecisions: ["x"], deadEnds: [], nextSteps: [] },
        createdAt: 1000,
        updatedAt: 2000,
      }),
    );

    const dryRes = migrateProjectToV6(root, { dryRun: true });
    expect(dryRes.errors).toEqual([]);
    expect(dryRes.projectMigrated).toBe(true);
    expect(dryRes.itemsMigrated).toEqual(["REQ-001"]);
    expect(JSON.parse(fs.readFileSync(path.join(wbDir, "project.json"), "utf8")).schemaVersion).toBe(4);

    const realRes = migrateProjectToV6(root, { dryRun: false });
    expect(realRes.errors).toEqual([]);
    const migratedProj = JSON.parse(fs.readFileSync(path.join(wbDir, "project.json"), "utf8"));
    expect(migratedProj.schemaVersion).toBe(6);
    expect(migratedProj.routing.defaultLead.primary.model).toBeTruthy();

    const detail = getRequirement(root, "REQ-001");
    expect(detail.state.schemaVersion).toBe(6);
    expect(detail.state.stage).toBe("coding");
    expect(detail.state.tier).toBe("standard");
  });

  it("isolates blind review by default across all harnesses while allowing explicit reviewFormatRescue resume", () => {
    // Ordinary blind review must NEVER resume a prior session even if nativeSessionId is passed.
    const blindCodex = buildHarnessCommand(
      { harness: "codex", model: "codex-auto-review" },
      { root: "/tmp/repo", action: "review", prompt: "blind review", nativeSessionId: "sess-impl-1", harnesses: [] },
    );
    expect(blindCodex.args).not.toContain("resume");
    expect(blindCodex.args).not.toContain("sess-impl-1");

    const blindOpencode = buildHarnessCommand(
      { harness: "opencode", model: "opencode/deepseek-v4.1-flash-free" },
      { root: "/tmp/repo", action: "review", prompt: "blind review", nativeSessionId: "sess-impl-1", harnesses: [] },
    );
    expect(blindOpencode.args).not.toContain("--session");

    const blindAgy = buildHarnessCommand(
      { harness: "agy", model: "gemini-4-argon" },
      { root: "/tmp/repo", action: "review", prompt: "blind review", nativeSessionId: "sess-impl-1", harnesses: [] },
    );
    expect(blindAgy.args).not.toContain("--conversation");

    // Explicit reviewFormatRescue resumes the reviewer's own session with read-only safety flags.
    const codexRescue = buildHarnessCommand(
      { harness: "codex", model: "codex-auto-review" },
      {
        root: "/tmp/repo",
        action: "review",
        prompt: "output JSON only",
        nativeSessionId: "sess-rev-1",
        allowResumeOnReview: true,
        harnesses: [],
      },
    );
    expect(codexRescue.args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(codexRescue.args).toContain("sess-rev-1");
    expect(codexRescue.args).toContain('sandbox_mode="read-only"');
    expect(codexRescue.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");

    const qoderRescue = buildHarnessCommand(
      { harness: "qodercn", model: "Qwen4-Max" },
      {
        root: "/tmp/repo",
        action: "review",
        prompt: "output JSON only",
        nativeSessionId: "q-rev-1",
        allowResumeOnReview: true,
        harnesses: [],
      },
    );
    expect(qoderRescue.args).toContain("-r");
    expect(qoderRescue.args).toContain("q-rev-1");
    expect(qoderRescue.args).toContain("--permission-mode");
    expect(qoderRescue.args).toContain("auto");
    expect(qoderRescue.args).not.toContain("--dangerously-skip-permissions");
  });

  it("enforces zero global routing fallback and tier-aware runner resolution on frontend helpers", () => {
    const routing: RoutingConfig = {
      defaultLead: { primary: { harness: "qodercn", model: "Qwen4-Max" }, fallbacks: [] },
      sotaLead: { primary: { harness: "codex", model: "gpt-6.2-astra", reasoningEffort: "high" }, fallbacks: [] },
      reviewer: { primary: { harness: "agy", model: "gemini-4-argon" }, fallbacks: [] },
    };

    // Uninitialized / unconfigured project never falls back to any global routing
    expect(resolveEffectiveRouting(null)).toBeNull();
    expect(resolveEffectiveRouting({ initialized: true, root: "/tmp/p", project: null, routing: null } as never)).toBeNull();
    expect(
      resolveEffectiveRouting({ initialized: true, root: "/tmp/p", project: { routing }, routing, git: { isGitRepo: false } } as never),
    ).toEqual(routing);

    // Tier-aware selection for standard vs sota requirements
    expect(activeRunnerChoice("", routing, "implement", "", "standard")).toEqual({
      harness: "qodercn",
      model: "Qwen4-Max",
    });
    expect(activeRunnerChoice("", routing, "implement", "", "sota")).toEqual({
      harness: "codex",
      model: "gpt-6.2-astra",
      effort: "high",
    });
  });

  it("passes check-deployment against a live v6 Hub server and 5-tool MCP server", async () => {
    const root = mkTempGitRepo("wb-v6-deploy-");
    await initProject(root, { name: "deploy-demo", privacyMode: "local" });
    const server = await startWorkbenchServer({ root, port: 0, hubMode: true, writeDiscovery: false });
    try {
      const ok = await checkDeployment(["--url", server.url, "--root", root]);
      expect(ok).toBe(true);
    } finally {
      server.stop();
    }
  });
});
