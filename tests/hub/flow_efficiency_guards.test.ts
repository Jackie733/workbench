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
import { withNamedAdvisoryLock } from "../../src/core/fs.ts";
import { HubExecutor } from "../../src/hub/executor.ts";
import {
  classifyUnrelatedTimeoutFailure,
  normalizeReviewVerdictForManualCriteria,
} from "../../src/hub/post_run.ts";
import { buildInitialProjectRouting } from "../../src/hub/routing.ts";
import {
  clearModelCooldown,
  isModelCoolingDown,
  isQuotaPoolCoolingDown,
  recordModelRunOutcome,
} from "../../src/hub/telemetry.ts";
import type { HarnessInfo } from "../../src/hub/types.ts";

const tempDirs: string[] = [];
const origHubDir = process.env.WORKBENCH_HUB_DIR;
const origChromePath = process.env.WORKBENCH_CHROME_PATH;
const origMaxHeavy = process.env.WORKBENCH_AUTO_LOOP_MAX_HEAVY_VERIFIES;
const origLoopBudget = process.env.WORKBENCH_AUTO_LOOP_BUDGET_MS;
let activeHubDir = "";

function makeTempHub(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-eff-hub-"));
  tempDirs.push(dir);
  activeHubDir = dir;
  process.env.WORKBENCH_HUB_DIR = dir;
  return dir;
}

function makeGitRepo(name = "repo"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wb-eff-${name}-`));
  tempDirs.push(dir);
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, ".gitignore"), ".env\n.env.*\n");
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

function writeScript(name: string, body: string): string {
  const p = path.join(activeHubDir || os.tmpdir(), `${name}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(p, body, "utf8");
  return p;
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
  if (origHubDir === undefined) delete process.env.WORKBENCH_HUB_DIR;
  else process.env.WORKBENCH_HUB_DIR = origHubDir;
  if (origChromePath === undefined) delete process.env.WORKBENCH_CHROME_PATH;
  else process.env.WORKBENCH_CHROME_PATH = origChromePath;
  if (origMaxHeavy === undefined) delete process.env.WORKBENCH_AUTO_LOOP_MAX_HEAVY_VERIFIES;
  else process.env.WORKBENCH_AUTO_LOOP_MAX_HEAVY_VERIFIES = origMaxHeavy;
  if (origLoopBudget === undefined) delete process.env.WORKBENCH_AUTO_LOOP_BUDGET_MS;
  else process.env.WORKBENCH_AUTO_LOOP_BUDGET_MS = origLoopBudget;
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("Flow-v2 efficiency, review normalization, quota-pool fallback, and loop guards", () => {
  test("blocks `wb verify --all` inside Hub-managed implement/fix runs while allowing outside", async () => {
    const repo = makeGitRepo("cli-verify-guard");
    await initProject(repo);
    await createRequirement(repo, {
      goal: "Guard wb verify --all inside coding runs",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Plan\nSimple.", actor: "agent" });
    await approveDesign(repo, "REQ-001");

    const cliEntry = path.resolve(import.meta.dir, "../../src/cli/index.ts");
    for (const action of ["implement", "fix"] as const) {
      const proc = Bun.spawnSync(["bun", "run", cliEntry, "verify", "REQ-001", "--all"], {
        cwd: repo,
        env: {
          ...process.env,
          WORKBENCH_ROOT: repo,
          WORKBENCH_REQ_ID: "REQ-001",
          WORKBENCH_HUB_PID: String(process.pid),
          WORKBENCH_RUN_ACTION: action,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode).not.toBe(0);
      const errOut = Buffer.from(proc.stderr).toString("utf8") + Buffer.from(proc.stdout).toString("utf8");
      expect(errOut).toContain("禁止手动执行 wb verify --all");
    }

    // Outside Hub-managed coding run (no WORKBENCH_HUB_PID), `wb verify --all` succeeds.
    const cleanEnv = { ...process.env };
    delete cleanEnv.WORKBENCH_HUB_PID;
    delete cleanEnv.WORKBENCH_RUN_ACTION;
    const okProc = Bun.spawnSync(["bun", "run", cliEntry, "verify", "REQ-001", "--all"], {
      cwd: repo,
      env: cleanEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(okProc.exitCode).toBe(0);
  }, 20_000);

  test("normalizeReviewVerdictForManualCriteria downgrades manual-only blocks while preserving real code blocks", () => {
    const criteria = [
      { id: "AC-1", description: "Typecheck passes", required: true, command: "bun run typecheck" },
      { id: "AC-2", description: "Manual UI signoff", required: true, kind: "manual" as const, steps: "Check modal" },
    ];

    // 1. Only manual unverified finding -> downgraded to low and verdict becomes pass
    const manualOnly = normalizeReviewVerdictForManualCriteria(
      {
        verdict: "block",
        summary: "必需的人工验收尚未完成",
        markdown: "body",
        findings: [
          {
            id: "F-1",
            severity: "high",
            title: "必需的人工验收尚未完成",
            criterionIds: ["AC-2"],
            suggestion: "人工勾选 AC-2",
          },
        ],
      },
      criteria,
    );
    expect(manualOnly.verdict).toBe("pass");
    expect(manualOnly.findings?.[0]?.severity).toBe("low");

    // 2. Manual finding + real high code finding -> stays block
    const withRealHigh = normalizeReviewVerdictForManualCriteria(
      {
        verdict: "block",
        summary: "有真实缺陷",
        markdown: "body",
        findings: [
          { id: "F-1", severity: "high", title: "XSS 风险", criterionIds: ["AC-1"] },
          { id: "F-2", severity: "high", title: "必需的人工核验未完成", criterionIds: ["AC-2"] },
        ],
      },
      criteria,
    );
    expect(withRealHigh.verdict).toBe("block");
    expect(withRealHigh.findings?.[0]?.severity).toBe("high");
    expect(withRealHigh.findings?.[1]?.severity).toBe("low");

    // 3. Manual finding + medium finding -> downgraded to concern
    const withMedium = normalizeReviewVerdictForManualCriteria(
      {
        verdict: "block",
        summary: "中等风险与人工未勾",
        markdown: "body",
        findings: [
          { id: "F-1", severity: "medium", title: "边界提示不足", criterionIds: ["AC-1"] },
          { id: "F-2", severity: "high", title: "Manual acceptance check not yet verified", criterionIds: ["AC-2"] },
        ],
      },
      criteria,
    );
    expect(withMedium.verdict).toBe("concern");
    expect(withMedium.findings?.[1]?.severity).toBe("low");
  });

  test("end-to-end HubExecutor auto-review normalizes manual-only block to pass and skips auto_review_fix", async () => {
    const repo = makeGitRepo("manual-review-norm");
    const harnesses = [
      makeHarness("opencode", [{ id: "opencode-go/deepseek-v4.1-flash", tier: "balanced" }]),
      makeHarness("codex", [{ id: "gpt-6.2-sol", tier: "sota" }]),
    ];
    const routing = buildInitialProjectRouting(harnesses);
    routing.defaultLead = {
      primary: { harness: "opencode", model: "opencode-go/deepseek-v4.1-flash" },
      fallbacks: [],
    };
    routing.reviewer = {
      primary: { harness: "codex", model: "gpt-6.2-sol" },
      fallbacks: [],
    };
    routing.autoReview = true;
    routing.autoHeal = true;

    await initProject(repo, { routing });
    await createRequirement(repo, {
      goal: "Auto review should ignore unverified manual AC",
      criteria: [
        { id: "AC-1", description: "app exists", required: true, command: "grep -q updated app.ts" },
        { id: "AC-2", description: "人工核验", required: true, kind: "manual", steps: "肉眼检查界面" },
      ],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Plan\nUpdate app.", actor: "agent" });
    await approveDesign(repo, "REQ-001");

    const seenActions: string[] = [];
    const exec = new HubExecutor({
      initialHarnesses: harnesses,
      commandBuilder: (_t, ctx) => {
        seenActions.push(ctx.action);
        if (ctx.action === "implement") {
          const s = writeScript(
            "manual-norm-impl",
            `import * as fs from "node:fs"; import * as path from "node:path"; fs.writeFileSync(path.join(${JSON.stringify(ctx.root)}, "app.ts"), "export const updated = true;\\n");`,
          );
          return { command: "bun", args: [s], displayCommand: "mock-impl" };
        }
        return {
          command: "bash",
          args: [
            "-c",
            `printf '%s\\n' '\`\`\`json' '{"verdict":"block","summary":"必需的人工验收尚未完成","findings":[{"id":"F-1","severity":"high","title":"必需的人工验收尚未完成","criterionIds":["AC-2"],"suggestion":"人类勾验收"}]}' '\`\`\`'`,
          ],
          displayCommand: "mock-review-manual-block",
        };
      },
    });

    await exec.startRun({ root: repo, requirementId: "REQ-001", action: "implement" });
    await waitUntil(() => {
      const runs = getRequirement(repo, "REQ-001").state.agentRuns ?? [];
      return runs.length >= 2 && runs.every((r) => r.status !== "running");
    }, 12_000, "implement + review");
    await new Promise((r) => setTimeout(r, 250));

    expect(seenActions).toEqual(["implement", "review"]);
    const detail = getRequirement(repo, "REQ-001");
    expect(detail.state.reviewReport?.verdict).toBe("pass");
    expect(detail.state.reviewReport?.findings?.[0]?.severity).toBe("low");
  }, 20_000);

  test("telemetry cools down entire quotaPool on rate limit and clears cleanly", () => {
    recordModelRunOutcome({
      harness: "codex",
      model: "gpt-6.2-sol",
      action: "review",
      status: "failed",
      durationMs: 500,
      rateLimited: true,
    });

    expect(isQuotaPoolCoolingDown("openai-codex")).toBe(true);
    expect(isModelCoolingDown("codex", "gpt-6.2-sol")).toBe(true);
    // Sibling model on same openai-codex quota pool must also cool down
    expect(isModelCoolingDown("codex", "gpt-6.2-astra")).toBe(true);
    // Different provider pool stays healthy
    expect(isModelCoolingDown("agy", "gemini-4-neon")).toBe(false);

    clearModelCooldown("codex", "gpt-6.2-sol");
    expect(isQuotaPoolCoolingDown("openai-codex")).toBe(false);
    expect(isModelCoolingDown("codex", "gpt-6.2-astra")).toBe(false);
  });

  test("multi-hop cross-pool auto-fallback skips same-pool sibling and escalates to needsHuman when all pools fail", async () => {
    const repo = makeGitRepo("multihop-fallback");
    const harnesses = [
      makeHarness("opencode", [{ id: "opencode-go/deepseek-v4.1-flash", tier: "balanced" }]),
      makeHarness("codex", [
        { id: "gpt-6.2-sol", tier: "sota" },
        { id: "gpt-6.2-astra", tier: "sota" },
      ]),
      makeHarness("agy", [{ id: "gemini-4-neon", tier: "sota" }]),
      makeHarness("qodercn", [{ id: "Kimi-K3.1-Pro", tier: "balanced" }]),
    ];
    const routing = buildInitialProjectRouting(harnesses);
    routing.defaultLead = {
      primary: { harness: "opencode", model: "opencode-go/deepseek-v4.1-flash" },
      fallbacks: [],
    };
    routing.reviewer = {
      primary: { harness: "codex", model: "gpt-6.2-sol" },
      fallbacks: [
        { harness: "codex", model: "gpt-6.2-astra" },
        { harness: "agy", model: "gemini-4-neon" },
        { harness: "qodercn", model: "Kimi-K3.1-Pro" },
      ],
    };
    routing.autoReview = false;
    routing.autoHeal = false;

    await initProject(repo, { routing });
    await createRequirement(repo, {
      goal: "Test cross-pool fallback",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Plan\nOk.", actor: "agent" });
    await approveDesign(repo, "REQ-001");

    const triedModels: string[] = [];
    const exec1 = new HubExecutor({
      initialHarnesses: harnesses,
      commandBuilder: (target) => {
        triedModels.push(`${target.harness}/${target.model}`);
        if (target.harness === "codex") {
          return {
            command: "bash",
            args: ["-c", 'echo "You’ve hit your usage limit" >&2; exit 1'],
            displayCommand: "mock-codex-limit",
          };
        }
        const agyLine = JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "text", text: '```json\n{"verdict":"pass","summary":"LGTM"}\n```' }],
          },
        });
        const s = writeScript("agy-pass", `console.log(${JSON.stringify(agyLine)});`);
        return {
          command: "bun",
          args: [s],
          displayCommand: "mock-agy-pass",
        };
      },
    });

    await exec1.startRun({ root: repo, requirementId: "REQ-001", action: "review", isAutoReview: true });
    await waitUntil(() => {
      const d = getRequirement(repo, "REQ-001");
      const runs = d.state.agentRuns ?? [];
      return Boolean(d.state.reviewReport) && runs.length >= 2 && runs.every((r) => r.status !== "running");
    }, 12_000, "cross-pool review fallback");
    await new Promise((r) => setTimeout(r, 200));

    // Must skip codex/gpt-6.2-astra and jump directly to agy/gemini-4-neon!
    expect(triedModels).toEqual(["codex/gpt-6.2-sol", "agy/gemini-4-neon"]);
    expect(getRequirement(repo, "REQ-001").state.reviewReport?.verdict).toBe("pass");

    // Now test all pools exhausted -> sets needsHuman (source: env_failure)
    clearModelCooldown();
    await createRequirement(repo, {
      goal: "All pools exhausted",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-002", { designMarkdown: "# Plan\nExhaust.", actor: "agent" });
    await approveDesign(repo, "REQ-002");

    const triedAll: string[] = [];
    const exec2 = new HubExecutor({
      initialHarnesses: harnesses,
      commandBuilder: (target) => {
        triedAll.push(`${target.harness}/${target.model}`);
        return {
          command: "bash",
          args: ["-c", 'echo "HTTP 429 quota exceeded" >&2; exit 1'],
          displayCommand: "mock-all-limit",
        };
      },
    });
    await exec2.startRun({ root: repo, requirementId: "REQ-002", action: "review", isAutoReview: true });
    await waitUntil(() => {
      const d = getRequirement(repo, "REQ-002");
      const runs = d.state.agentRuns ?? [];
      return runs.length >= 3 && runs.every((r) => r.status !== "running") && Boolean(d.state.needsHuman);
    }, 12_000, "all pools exhausted escalation");

    expect(triedAll).toEqual(["codex/gpt-6.2-sol", "agy/gemini-4-neon", "qodercn/Kimi-K3.1-Pro"]);
    expect(getRequirement(repo, "REQ-002").state.needsHuman?.source).toBe("env_failure");
  }, 25_000);

  test("auto-loop budget circuit-breaker halts excessive auto-heal cycles and escalates to needsHuman", async () => {
    process.env.WORKBENCH_AUTO_LOOP_MAX_HEAVY_VERIFIES = "1";
    const repo = makeGitRepo("loop-budget");
    const harnesses = [makeHarness("opencode", [{ id: "opencode-go/deepseek-v4.1-flash", tier: "balanced" }])];
    const routing = buildInitialProjectRouting(harnesses);
    routing.defaultLead = {
      primary: { harness: "opencode", model: "opencode-go/deepseek-v4.1-flash" },
      fallbacks: [],
    };
    routing.autoReview = false;
    routing.autoHeal = true;

    await initProject(repo, { routing });
    await createRequirement(repo, {
      goal: "Circuit breaker on heavy verify cap",
      criteria: [
        {
          id: "AC-1",
          description: "heavy test fails",
          required: true,
          command: "false && bun run test",
        },
      ],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Plan\nHeavy.", actor: "agent" });
    await approveDesign(repo, "REQ-001");

    const actions: string[] = [];
    const exec = new HubExecutor({
      initialHarnesses: harnesses,
      commandBuilder: (_t, ctx) => {
        actions.push(ctx.action);
        const s = writeScript(
          "budget-impl",
          `import * as fs from "node:fs"; import * as path from "node:path"; fs.writeFileSync(path.join(${JSON.stringify(ctx.root)}, "app.ts"), "export const x = 2;\\n");`,
        );
        return { command: "bun", args: [s], displayCommand: "mock-impl" };
      },
    });

    await exec.startRun({ root: repo, requirementId: "REQ-001", action: "implement" });
    await waitUntil(() => Boolean(getRequirement(repo, "REQ-001").state.needsHuman), 12_000, "budget breaker");
    await new Promise((r) => setTimeout(r, 200));

    expect(actions).toEqual(["implement"]);
    const detail = getRequirement(repo, "REQ-001");
    expect(detail.state.needsHuman?.source).toBe("auto_heal_exhausted");
    expect(detail.state.needsHuman?.reason).toContain("全量验证次数已达上限");
  }, 20_000);

  test("classifyUnrelatedTimeoutFailure distinguishes untouched timeout flakes from real or touched failures", () => {
    const timeoutOnlyLog = `
=== Failed Test File Outputs ===

--- tests/core/delivery.test.ts (exit 1) ---
bun test v1.4.4
tests/core/delivery.test.ts:
(fail) post-acceptance Git delivery wrap-up [5009.49ms]
  ^ this test timed out after 5000ms.
`;
    expect(classifyUnrelatedTimeoutFailure(timeoutOnlyLog, ["src/web/components/AttachmentGallery.tsx"])).toEqual({
      unrelatedTimeoutOnly: true,
      failedFiles: ["tests/core/delivery.test.ts"],
    });

    // Touched test file -> NOT unrelated
    expect(classifyUnrelatedTimeoutFailure(timeoutOnlyLog, ["tests/core/delivery.test.ts"])).toEqual({
      unrelatedTimeoutOnly: false,
      failedFiles: [],
    });

    // Assertion failure -> NOT timeout-only
    const assertionLog = `
=== Failed Test File Outputs ===

--- tests/hub/node_bridge.test.ts (exit 1) ---
error: expect(received).toContain(expected)
Expected substring: "active task"
`;
    expect(classifyUnrelatedTimeoutFailure(assertionLog, ["src/web/App.tsx"])).toEqual({
      unrelatedTimeoutOnly: false,
      failedFiles: [],
    });
  });

  test("withNamedAdvisoryLock emits onWait with holder requirementId when queued", async () => {
    const lockPath = path.join(activeHubDir, "locks", "verify-heavy.lock");
    const waitEvents: Array<{ waitedMs: number; holder: Record<string, string> | null }> = [];

    const first = withNamedAdvisoryLock(
      lockPath,
      async () => {
        await new Promise((r) => setTimeout(r, 450));
      },
      { holderMeta: { requirementId: "REQ-024", command: "bun run test" } },
    );
    await new Promise((r) => setTimeout(r, 40));
    const second = withNamedAdvisoryLock(
      lockPath,
      async () => {},
      {
        holderMeta: { requirementId: "REQ-025", command: "bun run test" },
        onWait: (info) => waitEvents.push(info),
        waitNotifyIntervalMs: 5_000,
      },
    );

    await Promise.all([first, second]);
    expect(waitEvents.length).toBeGreaterThanOrEqual(1);
    expect(waitEvents[0]?.holder?.requirementId).toBe("REQ-024");
  });
});
