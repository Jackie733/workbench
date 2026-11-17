import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
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
  listRequirements,
  propose,
} from "../../src/core/engine.ts";
import { resolveProjectRequirementSnapshots } from "../../src/core/git.ts";
import { distillRequirementToPlaybook, MAX_PLAYBOOK_BYTES, readPlaybook, writePlaybook } from "../../src/core/playbook.ts";
import { runVerification } from "../../src/core/runner.ts";
import { getSandboxForRequirement, resolveWorkbenchRootFromCwd } from "../../src/core/sandbox.ts";
import {
  applySandboxToMain,
  createOrReuseWorktree,
  dismissPainPoint,
  inspectFinishedRunForPainPoints,
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

    // Accept REQ-001 (with refined human discussion) and distill to Playbook
    await addDiscussion(repo, "REQ-001", {
      actor: "human",
      mode: "refine",
      anchor: "design.md#安全",
      message: "所有外部输入路径必须经过 resolveSafePath 校验 (sk-secret1234567890abcdef)",
      resolved: true,
    });
    const detail = await acceptRequirement(repo, "REQ-001", {
      currentCodeSnapshotHash: getRequirement(repo, "REQ-001").state.verifications[0]!.codeSnapshotHash,
    });
    const distilled = await distillRequirementToPlaybook(repo, detail, {
      feedback: "Always run bun run typecheck before finishing",
    });
    expect(distilled.added).toBe(3);
    expect(distilled.markdown).toContain("resolveSafePath");
    expect(distilled.markdown).not.toContain("sk-secret1234567890abcdef");
    expect(distilled.markdown).toContain("[CREDENTIAL REDACTED]");

    // Idempotent second distillation should add 0
    const again = await distillRequirementToPlaybook(repo, detail);
    expect(again.added).toBe(0);
    expect(readPlaybook(repo).rules.length).toBe(3);

    // writePlaybook enforces MAX_PLAYBOOK_BYTES including trailing newline
    const maxBody = "a".repeat(MAX_PLAYBOOK_BYTES);
    await expect(writePlaybook(repo, maxBody)).rejects.toThrow("上限");
    const exactFit = "b".repeat(MAX_PLAYBOOK_BYTES - 1);
    await writePlaybook(repo, exactFit);
    expect(Buffer.byteLength(readPlaybook(repo).markdown, "utf8")).toBe(MAX_PLAYBOOK_BYTES);

    // Restore Playbook with long CJK rules and verify handoff.md keeps section within 1200 UTF-8 bytes
    const cjkRules = Array.from({ length: 12 }, (_, idx) => `- [规则${idx}] ${"中文经验法则避免踩坑".repeat(12)}`).join("\n");
    await writePlaybook(repo, cjkRules);

    // New requirement inherits Playbook in handoff.md
    await createRequirement(repo, { goal: "Next feature" });
    const handoff = await synthesizeHandoffPacket(repo, "REQ-002", { action: "design" });
    expect(handoff.markdown).toContain("项目持久避坑与偏好法则（Playbook）");
    const pbSection = handoff.markdown.split("## 0. 项目持久避坑与偏好法则（Playbook）")[1]?.split("\n## 1.")[0] ?? "";
    expect(Buffer.byteLength(pbSection, "utf8")).toBeLessThanOrEqual(1260);

    // Restore ASCII rule check too
    await writePlaybook(repo, "- Do not use react-dom/server inside browser bundle\n");
    const handoff2 = await synthesizeHandoffPacket(repo, "REQ-002", { action: "design" });
    expect(handoff2.markdown).toContain("Do not use react-dom/server");

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
      detail: "\x1b[31mConfirmed again Bearer secret-token-value\x1b[0m",
    });
    expect(dup?.occurrences).toBe(2);
    expect(dup?.detail).not.toContain("\x1b[31m");
    expect(dup?.detail).not.toContain("secret-token-value");
    expect(readPainPoints().length).toBe(1);

    // Distinct component / domSelector creates a distinct pain point fingerprint
    const diffComp = reportPainPoint({
      source: "ui_quick_report",
      category: "ui_anomaly",
      title: "Topbar button misaligned on narrow viewport",
      context: { domSelector: ".sidebar-btn" },
    });
    expect(diffComp?.id).not.toBe(dup?.id);
    expect(diffComp?.occurrences).toBe(1);

    // Post-run sniffer detects timeouts, crashes, and --json CLI errors (and skips RSI sandbox)
    const sampleDetail = getRequirement(wbRepo, (await createRequirement(wbRepo, { goal: "dummy" })).state.id);
    const sniffed = inspectFinishedRunForPainPoints({
      root: wbRepo,
      requirementId: sampleDetail.state.id,
      run: {
        id: "RUN-1",
        action: "implement",
        harness: "codex",
        model: "gpt-6",
        status: "failed",
        startedAt: 1,
        endedAt: 2,
        exitCode: 139,
        durationMs: 1000,
        logPath: "runs/RUN-1.log",
      },
      detail: sampleDetail,
      rawLog: '{"code": "invalid_input"}\n{"code": "invalid_input"}\nSegmentation fault',
      timedOut: true,
    });
    expect(sniffed.some((p) => p.category === "cli_ergonomics")).toBe(true);
    expect(sniffed.some((p) => p.category === "harness_bug" && p.title.includes("超时"))).toBe(true);
    const suppressedByRsi = inspectFinishedRunForPainPoints({
      root: wbRepo,
      requirementId: sampleDetail.state.id,
      run: {
        id: "RUN-2",
        action: "fix",
        harness: "codex",
        model: "gpt-6",
        status: "failed",
        startedAt: 1,
        endedAt: 2,
        exitCode: 139,
        durationMs: 1000,
        logPath: "runs/RUN-2.log",
      },
      detail: sampleDetail,
      rawLog: "Segmentation fault",
      isRsiSandbox: true,
    });
    expect(suppressedByRsi).toEqual([]);

    // Guard: WORKBENCH_RSI_DEPTH=1 prevents automatic recursion
    process.env.WORKBENCH_RSI_DEPTH = "1";
    const suppressed = reportPainPoint({
      source: "post_run_dead_end",
      category: "cli_ergonomics",
      title: "Recursive issue should be skipped",
    });
    expect(suppressed).toBeNull();
    delete process.env.WORKBENCH_RSI_DEPTH;

    // 2. Promote pain point -> creates REQ-002 (stays in draft, never skips design!) + isolated worktree sandbox
    const promoted = await promotePainPoint(dup!.id, { workbenchRoot: wbRepo, createSandbox: true });
    const reqId = promoted.requirement.state.id;
    expect(promoted.requirement.state.stage).toBe("draft");
    expect(promoted.workbenchProjectId).toBeTruthy();
    expect(promoted.sandbox).not.toBeNull();
    // Re-promoting already promoted pain point is rejected
    await expect(promotePainPoint(dup!.id, { workbenchRoot: wbRepo })).rejects.toThrow("已转化");
    const wtPath = promoted.sandbox!.worktreePath;
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(getSandboxForRequirement(wbRepo, reqId)?.worktreePath).toBe(wtPath);
    expect(resolveWorkbenchRootFromCwd(wtPath)).toBe(fs.realpathSync(wbRepo));
    expect(fs.existsSync(path.join(wtPath, ".workbench/items", reqId, "spec.md"))).toBe(true);

    // Advance main repo concurrently on a DIFFERENT file -> must not be deleted by sandbox apply!
    fs.writeFileSync(path.join(wbRepo, "main_only_file.ts"), "export const keepMe = 1;\n");
    execFileSync("git", ["add", "main_only_file.ts"], { cwd: wbRepo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "main advanced"], { cwd: wbRepo, stdio: "ignore" });

    // 3. Edit code inside sandbox ONLY; main repo stays completely untouched
    fs.writeFileSync(path.join(wtPath, "src/web/styles.css"), "body { color: #2563eb; }\n");
    fs.writeFileSync(path.join(wtPath, "src/web/new_helper.ts"), "export const fixed = true;\n");
    expect(fs.readFileSync(path.join(wbRepo, "src/web/styles.css"), "utf8")).toBe("body { color: #111; }");

    // 4. Verification runs inside worktree and records evidence in main .workbench
    await propose(wbRepo, reqId, {
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
    await approveDesign(wbRepo, reqId);
    const verRes = await runVerification(wbRepo, reqId, {
      command: "grep -q '#2563eb' src/web/styles.css",
      criterionIds: ["AC-1"],
    });
    expect(verRes.record.passed).toBe(true);

    // listRequirements with per-requirement snapshots does NOT falsely report sandbox as stale!
    const { baseSnapshot, byReqId } = await resolveProjectRequirementSnapshots(wbRepo);
    const listed = listRequirements(wbRepo, {
      scope: "active",
      currentCodeSnapshotHash: baseSnapshot?.fingerprint ?? null,
      codeSnapshotsById: byReqId,
    });
    const sandboxSummary = listed.find((i) => i.id === reqId);
    expect(sandboxSummary?.requiredPassed).toBe(1);
    expect(sandboxSummary?.requiredTotal).toBe(1);

    // 5. Server apply endpoint enforces human acceptance gate BEFORE merging & reloading cachedWeb!
    const server = await startWorkbenchServer({ root: wbRepo, port: 0, writeDiscovery: false, hubMode: true });
    servers.push(server);

    const beforeCss = await (await fetch(`${server.url}/styles.css`)).text();
    expect(beforeCss).toContain("#111");

    // Unaccepted apply MUST fail with 409!
    const prematureResp = await fetch(`${server.url}/api/hub/evolution/apply/${reqId}`, { method: "POST" });
    expect(prematureResp.status).toBe(409);

    // Now accept via API (uses sandbox code snapshot)
    const acceptResp = await fetch(`${server.url}/api/requirements/${reqId}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(acceptResp.status).toBe(200);

    const applyResp = await fetch(`${server.url}/api/hub/evolution/apply/${reqId}`, { method: "POST" });
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

    // Main repo updated, concurrently added main_only_file.ts preserved, sandbox cleaned up, server serves updated CSS!
    expect(fs.readFileSync(path.join(wbRepo, "src/web/styles.css"), "utf8")).toContain("#2563eb");
    expect(fs.existsSync(path.join(wbRepo, "src/web/new_helper.ts"))).toBe(true);
    expect(fs.existsSync(path.join(wbRepo, "main_only_file.ts"))).toBe(true);
    expect(getSandboxForRequirement(wbRepo, reqId)).toBeNull();
    const afterCss = await (await fetch(`${server.url}/styles.css`)).text();
    expect(afterCss).toContain("#2563eb");

    // 6. Security: reject symlink escape inside sandbox during applySandboxToMain
    const secReq = await createRequirement(wbRepo, {
      goal: "Test symlink guard",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    const secId = secReq.state.id;
    const secWt = await createOrReuseWorktree(wbRepo, secId);
    fs.symlinkSync("/etc/passwd", path.join(secWt.worktreePath, "src/web/evil_symlink"));
    await propose(wbRepo, secId, { designMarkdown: "# Symlink test", actor: "agent" });
    await approveDesign(wbRepo, secId);
    await runVerification(wbRepo, secId, { command: "echo ok", criterionIds: ["AC-1"] });
    await acceptRequirement(wbRepo, secId, {
      currentCodeSnapshotHash: getRequirement(wbRepo, secId).state.verifications[0]!.codeSnapshotHash,
    });
    await expect(applySandboxToMain(wbRepo, secId)).rejects.toThrow("符号链接");

    // Dismissing an extra pain point works cleanly
    const extra = reportPainPoint({ source: "ui_quick_report", category: "feature_gap", title: "Extra idea" });
    const dismissed = dismissPainPoint(extra!.id);
    expect(dismissed.status).toBe("dismissed");
  });
});
