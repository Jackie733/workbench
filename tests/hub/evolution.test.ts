import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  acceptRequirement,
  approveDesign,
  createRequirement,
  getRequirement,
  initProject,
  propose,
} from "../../src/core/engine.ts";
import { distillRequirementToPlaybook, readPlaybook } from "../../src/core/playbook.ts";
import { runVerification } from "../../src/core/runner.ts";
import { getSandboxForRequirement } from "../../src/core/sandbox.ts";
import {
  applySandboxToMain,
  createOrReuseWorktree,
  dismissPainPoint,
  promotePainPoint,
  readPainPoints,
  reportPainPoint,
} from "../../src/hub/evolution.ts";
import { HubExecutor } from "../../src/hub/executor.ts";
import { synthesizeHandoffPacket } from "../../src/hub/handoff.ts";
import { registerHubProject } from "../../src/hub/registry.ts";
import { buildPresetRouting, detectRateLimitOrQuotaError, resolveRouteCandidates } from "../../src/hub/routing.ts";
import { clearModelCooldown, isModelCoolingDown, recordModelRunOutcome, summarizeTelemetry } from "../../src/hub/telemetry.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";

const tempDirs: string[] = [];
const servers: WorkbenchServerHandle[] = [];
const origHubDir = process.env.WORKBENCH_HUB_DIR;
const origRsiDepth = process.env.WORKBENCH_RSI_DEPTH;
const CLI_ENTRY = path.resolve(import.meta.dir, "../../src/cli/index.ts");

function makeTempHub(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-evo-hub-"));
  tempDirs.push(dir);
  process.env.WORKBENCH_HUB_DIR = dir;
  return dir;
}

function makeGitRepo(name = "workbench"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wb-${name}-`));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "workbench", version: "5.0.0" }, null, 2));
  fs.mkdirSync(path.join(dir, "src/web"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/web/index.html"), "<!doctype html><html><body>hi</body></html>");
  fs.writeFileSync(path.join(dir, "src/web/styles.css"), "body { color: #111; }");
  fs.writeFileSync(path.join(dir, "src/web/app.tsx"), "console.log('v1');\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function runCli(root: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync("bun", ["run", CLI_ENTRY, "--root", root, "--json", ...args], {
    encoding: "utf8",
    env: process.env,
  });
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

afterEach(() => {
  while (servers.length > 0) servers.pop()!.stop();
  if (origHubDir === undefined) delete process.env.WORKBENCH_HUB_DIR;
  else process.env.WORKBENCH_HUB_DIR = origHubDir;
  if (origRsiDepth === undefined) delete process.env.WORKBENCH_RSI_DEPTH;
  else process.env.WORKBENCH_RSI_DEPTH = origRsiDepth;
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("Self-Evolving Agent & RSI closed loop", () => {
  test("Phase 0: fixes wb propose --note, read-only wb tasks, nativeSessionId 'string' filter, and timeout vs rateLimit", async () => {
    makeTempHub();
    const repo = makeGitRepo("phase0");
    await initProject(repo, { name: "Phase0", privacyMode: "local" });
    await createRequirement(repo, { goal: "Verify CLI and executor fixes" });

    // 1. wb propose forwards --note into handoffNote.keyDecisions
    const propRes = runCli(repo, [
      "propose",
      "REQ-001",
      "--design",
      "# Design\nUse safe parser.",
      "--note",
      "Decision: keep CLI pure",
    ]);
    expect(propRes.status).toBe(0);
    const afterProp = getRequirement(repo, "REQ-001");
    expect(afterProp.state.handoffNote?.keyDecisions).toContain("Decision: keep CLI pure");

    // 2. wb tasks REQ-001 without write args acts as read-only query (exit 0)
    const tasksQuery = runCli(repo, ["tasks", "REQ-001"]);
    expect(tasksQuery.status).toBe(0);
    const tasksData = JSON.parse(tasksQuery.stdout) as { id: string; tasks: unknown[] };
    expect(tasksData.id).toBe("REQ-001");
    expect(tasksData.tasks).toEqual([]);

    // 3. detectRateLimitOrQuotaError ignores handoff prose ("额度/限流") and checks tail errors
    const noisyPrefix = "关于模型额度与限流策略的说明\n".repeat(400) + "normal build failure: syntax error at line 5";
    expect(detectRateLimitOrQuotaError(noisyPrefix, 1)).toBe(false);
    expect(detectRateLimitOrQuotaError("error: 429 quota exceeded", 1)).toBe(true);

    // 4. Executor filters "session_id?: string" and treats timeout as timeout (not rateLimited)
    await approveDesign(repo, "REQ-001");
    const executor = new HubExecutor({
      initialHarnesses: [
        {
          id: "opencode",
          label: "OpenCode",
          subscription: "Go",
          installed: true,
          executable: "opencode",
          models: [{ id: "opencode/deepseek-v4.1-flash-free", tier: "fast", source: "detected" }],
          defaultModel: "opencode/deepseek-v4.1-flash-free",
          detectedAt: Date.now(),
        },
      ],
      commandBuilder: (_target, ctx) => {
        if (ctx.action === "ask") {
          return {
            command: "bash",
            args: ["-c", "echo 'interface Run { session_id?: string }'"],
            displayCommand: "mock-ts-type",
          };
        }
        return {
          command: "bash",
          args: ["-c", "echo '模型额度策略说明'; sleep 5"],
          displayCommand: "mock-timeout",
        };
      },
    });

    const finished = new Promise<void>((resolve) => {
      let count = 0;
      executor.subscribe((ev) => {
        if (ev.type === "agent.run.finished") {
          count += 1;
          if (count === 2) resolve();
        }
      });
    });

    await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "ask",
      harness: "opencode",
      model: "opencode/deepseek-v4.1-flash-free",
      message: "Check type",
    });

    // Wait briefly for first run to settle before starting timeout test
    await new Promise((r) => setTimeout(r, 250));
    await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "implement",
      harness: "opencode",
      model: "opencode/deepseek-v4.1-flash-free",
      timeoutMs: 120,
    });

    await finished;
    const afterRuns = getRequirement(repo, "REQ-001");
    expect(afterRuns.state.agentRuns?.[0]?.nativeSessionId).toBeUndefined();
    const timeoutRun = afterRuns.state.agentRuns?.[1];
    expect(timeoutRun?.status).toBe("failed");
    expect(timeoutRun?.rateLimited).toBe(false);
    expect(timeoutRun?.errorSummary).toContain("执行超时");
  });

  test("L1 & L2: distills Playbook into handoff.md and auto-cools down rate-limited models", async () => {
    makeTempHub();
    const repo = makeGitRepo("l1l2");
    await initProject(repo, { name: "L1L2", privacyMode: "local" });
    await createRequirement(repo, {
      goal: "Add helper",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", {
      designMarkdown: "# Design",
      handoffNote: {
        deadEnds: ["Do not use react-dom/server inside browser bundle"],
      },
      actor: "agent",
    });
    await approveDesign(repo, "REQ-001");
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });

    // Accept REQ-001 and distill to Playbook
    const detail = await acceptRequirement(repo, "REQ-001", {
      currentCodeSnapshotHash: getRequirement(repo, "REQ-001").state.verifications[0]!.codeSnapshotHash,
    });
    const distilled = await distillRequirementToPlaybook(repo, detail, {
      feedback: "Always run bun run typecheck before finishing",
    });
    expect(distilled.added).toBe(2);

    // Idempotent second distillation should add 0
    const again = await distillRequirementToPlaybook(repo, detail);
    expect(again.added).toBe(0);
    expect(readPlaybook(repo).rules.length).toBe(2);

    // New requirement inherits Playbook in handoff.md
    await createRequirement(repo, { goal: "Next feature" });
    const handoff = await synthesizeHandoffPacket(repo, "REQ-002", { action: "design" });
    expect(handoff.markdown).toContain("项目持久避坑与偏好法则（Playbook）");
    expect(handoff.markdown).toContain("Do not use react-dom/server");

    // L2 Telemetry & Cooldown routing
    recordModelRunOutcome({
      harness: "qodercn",
      model: "Qwen4-Max",
      action: "implement",
      status: "failed",
      durationMs: 2500,
      rateLimited: true,
    });
    expect(isModelCoolingDown("qodercn", "Qwen4-Max")).toBe(true);
    const routing = buildPresetRouting("balanced");
    const candidates = resolveRouteCandidates(routing, null, "implement");
    // Primary Qwen4-Max is cooling down, so healthy fallback moves to index 0
    expect(`${candidates[0]!.harness}::${candidates[0]!.model}`).not.toBe("qodercn::Qwen4-Max");
    expect(summarizeTelemetry().activeCooldowns.length).toBe(1);

    clearModelCooldown("qodercn", "Qwen4-Max");
    expect(isModelCoolingDown("qodercn", "Qwen4-Max")).toBe(false);
    const restored = resolveRouteCandidates(routing, null, "implement");
    expect(`${restored[0]!.harness}::${restored[0]!.model}`).toBe("qodercn::Qwen4-Max");
  });

  test("L3 & L4: deduplicates pain points, runs isolated Git Worktree sandbox, applies changes, and reloads web bundle", async () => {
    makeTempHub();
    const wbRepo = makeGitRepo("workbench");
    await initProject(wbRepo, { name: "workbench", privacyMode: "local" });
    registerHubProject(wbRepo);

    // 1. Report pain point via CLI + API deduplication
    const cliIssue = runCli(wbRepo, [
      "issue",
      "Topbar button misaligned on narrow viewport",
      "--category",
      "ui_anomaly",
      "--detail",
      "Observed at 390x844",
    ]);
    expect(cliIssue.status).toBe(0);

    const dup = reportPainPoint({
      source: "ui_quick_report",
      category: "ui_anomaly",
      title: "Topbar button misaligned on narrow viewport",
      detail: "Confirmed again",
    });
    expect(dup?.occurrences).toBe(2);
    expect(readPainPoints().length).toBe(1);

    // Guard: WORKBENCH_RSI_DEPTH=1 prevents automatic recursion
    process.env.WORKBENCH_RSI_DEPTH = "1";
    const suppressed = reportPainPoint({
      source: "post_run_dead_end",
      category: "cli_ergonomics",
      title: "Recursive issue should be skipped",
    });
    expect(suppressed).toBeNull();
    delete process.env.WORKBENCH_RSI_DEPTH;

    // 2. Promote pain point -> creates REQ-001 + isolated worktree sandbox
    const promoted = await promotePainPoint(dup!.id, { workbenchRoot: wbRepo, createSandbox: true });
    expect(promoted.requirement.state.id).toBe("REQ-001");
    expect(promoted.sandbox).not.toBeNull();
    const wtPath = promoted.sandbox!.worktreePath;
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(getSandboxForRequirement(wbRepo, "REQ-001")?.worktreePath).toBe(wtPath);

    // 3. Edit code inside sandbox ONLY; main repo stays completely untouched
    fs.writeFileSync(path.join(wtPath, "src/web/styles.css"), "body { color: #2563eb; }\n");
    fs.writeFileSync(path.join(wtPath, "src/web/new_helper.ts"), "export const fixed = true;\n");
    expect(fs.readFileSync(path.join(wbRepo, "src/web/styles.css"), "utf8")).toBe("body { color: #111; }");

    // 4. Verification runs inside worktree and records evidence in main .workbench
    await propose(wbRepo, "REQ-001", {
      designMarkdown: "# Fix CSS in sandbox",
      criteria: [
        {
          id: "AC-1",
          description: "Sandbox CSS contains #2563eb",
          required: true,
          command: "grep -q '#2563eb' src/web/styles.css",
        },
      ],
      actor: "agent",
    });
    await approveDesign(wbRepo, "REQ-001");
    const verRes = await runVerification(wbRepo, "REQ-001", {
      command: "grep -q '#2563eb' src/web/styles.css",
      criterionIds: ["AC-1"],
    });
    expect(verRes.record.passed).toBe(true);

    // 5. Server apply endpoint merges sandbox changes to main repo & reloads cachedWeb bundle!
    const server = await startWorkbenchServer({ root: wbRepo, port: 0, writeDiscovery: false, hubMode: true });
    servers.push(server);

    const beforeCss = await (await fetch(`${server.url}/styles.css`)).text();
    expect(beforeCss).toContain("#111");

    const applyResp = await fetch(`${server.url}/api/hub/evolution/apply/REQ-001`, { method: "POST" });
    expect(applyResp.status).toBe(200);
    const applyJson = (await applyResp.json()) as {
      appliedFiles: string[];
      touchesWeb: boolean;
      webReloaded: boolean;
    };
    expect(applyJson.touchesWeb).toBe(true);
    expect(applyJson.webReloaded).toBe(true);
    expect(applyJson.appliedFiles).toContain("src/web/styles.css");
    expect(applyJson.appliedFiles).toContain("src/web/new_helper.ts");

    // Main repo updated, sandbox cleaned up, and server serves updated CSS immediately!
    expect(fs.readFileSync(path.join(wbRepo, "src/web/styles.css"), "utf8")).toContain("#2563eb");
    expect(fs.existsSync(path.join(wbRepo, "src/web/new_helper.ts"))).toBe(true);
    expect(getSandboxForRequirement(wbRepo, "REQ-001")).toBeNull();
    const afterCss = await (await fetch(`${server.url}/styles.css`)).text();
    expect(afterCss).toContain("#2563eb");

    // Dismissing an extra pain point works cleanly
    const extra = reportPainPoint({ source: "ui_quick_report", category: "feature_gap", title: "Extra idea" });
    const dismissed = dismissPainPoint(extra!.id);
    expect(dismissed.status).toBe("dismissed");
  });
});
