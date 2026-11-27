import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
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
  setRequirementNeedsHuman,
  updateSpec,
} from "../../src/core/engine.ts";
import { observeGitSnapshot } from "../../src/core/git.ts";
import { runVerification } from "../../src/core/runner.ts";
import { getSandboxForRequirement, resolveCodeRoot } from "../../src/core/sandbox.ts";
import { commitSandboxWipCheckpoint, createOrReuseWorktree } from "../../src/core/worktree.ts";
import { HubExecutor } from "../../src/hub/executor.ts";
import { buildInitialProjectRouting } from "../../src/hub/routing.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";
import { resolveTestBrowser } from "./browser_env.ts";

const browserEnv = resolveTestBrowser();
const HAS_BROWSER = browserEnv !== null;

interface BrowserPage {
  on(event: string, listener: (...args: any[]) => void): void;
  setViewport(vp: { width: number; height: number }): Promise<void>;
  goto(url: string, opts?: { waitUntil?: string }): Promise<unknown>;
  waitForSelector(sel: string, opts?: { timeout?: number }): Promise<unknown>;
  waitForFunction(fn: string | ((...args: unknown[]) => boolean), opts?: { timeout?: number }, ...args: unknown[]): Promise<unknown>;
  click(sel: string): Promise<void>;
  type(sel: string, text: string): Promise<void>;
  evaluate<T>(fn: (...args: any[]) => T, ...args: any[]): Promise<T>;
  close(): Promise<void>;
}

interface BrowserInstance {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

const tempDirs: string[] = [];
const servers: WorkbenchServerHandle[] = [];
const origHubEnv = process.env.WORKBENCH_HUB_DIR;
let browser: BrowserInstance | null = null;

function makeGitRepo(prefix = "wb-fp2-web-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

function makeTempHub(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-fp2-web-hub-"));
  tempDirs.push(dir);
  process.env.WORKBENCH_HUB_DIR = dir;
  return dir;
}

beforeAll(async () => {
  if (!browserEnv) return;
  const mod = (await import(browserEnv.puppeteerPath)) as {
    default: { launch(opts: Record<string, unknown>): Promise<BrowserInstance> };
  };
  browser = await mod.default.launch({
    executablePath: browserEnv.chromePath,
    headless: browserEnv.headless,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
}, 15_000);

afterEach(() => {
  while (servers.length > 0) servers.pop()!.stop();
  if (origHubEnv === undefined) delete process.env.WORKBENCH_HUB_DIR;
  else process.env.WORKBENCH_HUB_DIR = origHubEnv;
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

afterAll(async () => {
  await browser?.close();
});

function makeMockExecutor(): HubExecutor {
  return new HubExecutor({
    initialHarnesses: [
      {
        id: "codex",
        label: "Codex",
        subscription: "Test",
        installed: true,
        executable: "codex",
        models: [{ id: "gpt-5-mini", tier: "balanced", source: "detected" }],
        defaultModel: "gpt-5-mini",
        detectedAt: Date.now(),
      },
    ],
    commandBuilder: () => ({
      command: "bash",
      args: ["-c", "echo mock-agent-done"],
      displayCommand: "mock-agent",
    }),
  });
}

describe("Flow Phase 2 real Chromium E2E (WB-18, WB-19, WB-20)", () => {
  test("WB-18 UI: pinned originalGoal, inline decision card double exits, adopted decisions, and manual criterion checkoff + auto-stale", async () => {
    makeTempHub();
    const repo = makeGitRepo("wb-fp2-wb18-");
    await initProject(repo, {
      name: "Fp2Wb18Repo",
      privacyMode: "local",
      routing: { ...buildInitialProjectRouting(), autoReview: false, autoHeal: false },
    });

    await createRequirement(repo, { goal: "原始目标：导出报表支持自定义列与格式" });
    await updateSpec(repo, "REQ-001", {
      specMarkdown: "# 导出报表详细规范\n\n支持导出 CSV 与 XLSX，同时保持表头排序可配置。",
    });
    await propose(repo, "REQ-001", {
      designMarkdown: "# 导出方案 v1\n\n待确认导出默认格式。",
      criteria: [
        { id: "AC-1", description: "核心单测通过", required: true, command: "echo ok" },
        { id: "AC-2", description: "人工核验页面导出交互", required: true, kind: "manual", steps: "点击导出按钮并确认文件无乱码" },
      ],
      decisions: [
        {
          id: "D-1",
          question: "默认导出格式？",
          options: [
            { id: "csv", label: "CSV（轻量）", recommended: true },
            { id: "xlsx", label: "XLSX（富格式）" },
          ],
        },
      ],
    });
    await addDiscussion(repo, "REQ-001", {
      actor: "human",
      mode: "refine",
      anchor: "design.md > 导出方案 v1",
      message: "请补充空数据导出处理说明",
    });

    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, executor: makeMockExecutor() });
    servers.push(server);

    expect(HAS_BROWSER).toBe(true);
    const page = await browser!.newPage();
    const runtimeErrors: string[] = [];
    page.on("pageerror", (err: Error) => runtimeErrors.push(`pageerror: ${err.message}`));
    page.on("console", (msg: { type(): string; text(): string }) => {
      if (msg.type() === "error") runtimeErrors.push(`console.error: ${msg.text()}`);
    });

    try {
      await page.setViewport({ width: 1360, height: 900 });
      await page.goto(server.url, { waitUntil: "networkidle2" });
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 10_000 });
      await page.click('[data-testid="req-row-REQ-001"]');

      // 1. Pinned immutable originalGoal card above spec.md
      await page.waitForSelector('[data-testid="original-goal-card"]', { timeout: 10_000 });
      const goalText = await page.evaluate(
        () => document.querySelector('[data-testid="original-goal-text"]')?.textContent?.trim() ?? "",
      );
      expect(goalText).toBe("原始目标：导出报表支持自定义列与格式");

      // 2. Non-modal inline decision card: initially unanswered -> direct-approve disabled
      await page.waitForSelector('[data-testid="decision-card"]', { timeout: 10_000 });
      const initialDisabled = await page.evaluate(
        () => (document.querySelector('[data-testid="decision-direct-approve-btn"]') as HTMLButtonElement | null)?.disabled ?? false,
      );
      expect(initialDisabled).toBe(true);

      // Typing a custom answer keeps direct-approve disabled!
      await page.type('[data-testid="decision-custom-D-1"]', "先导出 JSON 再转换");
      await page.waitForFunction(
        () =>
          (document.querySelector('[data-testid="decision-direct-approve-btn"]') as HTMLButtonElement | null)?.disabled === true &&
          (document.querySelector('[data-testid="decision-revise-btn"]') as HTMLButtonElement | null)?.disabled === false,
        { timeout: 5_000 },
      );

      // Selecting preset option clears custom input and enables direct-approve!
      await page.click('[data-testid="decision-option-D-1-csv"]');
      await page.waitForFunction(
        () => (document.querySelector('[data-testid="decision-direct-approve-btn"]') as HTMLButtonElement | null)?.disabled === false,
        { timeout: 5_000 },
      );

      // Click Exit 1 ("采纳选择并直接批准进入编码") -> enters coding & shows adopted-decisions-card
      await page.click('[data-testid="decision-direct-approve-btn"]');
      await page.waitForSelector('[data-testid="adopted-decisions-card"]', { timeout: 10_000 });
      const adoptedText = await page.evaluate(
        () => document.querySelector('[data-testid="adopted-decisions-card"]')?.textContent ?? "",
      );
      expect(adoptedText).toContain("CSV（轻量）");
      expect(getRequirement(repo, "REQ-001").state.stage).toBe("coding");

      // 3. Manual criterion AC-2 checkoff toggle in UI
      await page.waitForSelector('[data-testid="manual-check-AC-2"]', { timeout: 10_000 });
      await page.click('[data-testid="manual-check-AC-2"]');
      await page.waitForFunction(
        () => (document.querySelector('[data-testid="manual-check-AC-2"]')?.textContent ?? "").includes("已核验"),
        { timeout: 10_000 },
      );

      // Modifying sandbox code invalidates manual checkoff automatically after reload
      const wt = resolveCodeRoot(repo, "REQ-001");
      fs.writeFileSync(path.join(wt, "app.ts"), "export const v = 2;\n");
      await page.goto(server.url, { waitUntil: "networkidle2" });
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 10_000 });
      await page.click('[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="manual-check-AC-2"]', { timeout: 10_000 });
      const afterEditBtnText = await page.evaluate(
        () => document.querySelector('[data-testid="manual-check-AC-2"]')?.textContent ?? "",
      );
      expect(afterEditBtnText).toContain("标记已核验");

      expect(runtimeErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 45_000);

  test("WB-19 & WB-20 UI: needsHuman danger banner, revisePlan + resetSandbox checkbox, 1-click local squash merge, and safe cancel discard", async () => {
    makeTempHub();
    const repo = makeGitRepo("wb-fp2-wb1920-");
    await initProject(repo, { name: "Fp2Wb1920Repo", privacyMode: "local" });

    // REQ-001: coding in sandbox with dirty edit + needsHuman escalation
    await createRequirement(repo, {
      goal: "实现本地一键压缩合入",
      criteria: [{ id: "AC-1", description: "passes", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Plan 1" });
    await createOrReuseWorktree(repo, "REQ-001");
    const wt1 = resolveCodeRoot(repo, "REQ-001");
    await approveDesign(repo, "REQ-001", { baseline: await observeGitSnapshot(wt1) });
    fs.writeFileSync(path.join(wt1, "app.ts"), "export const v = 77;\n");
    await setRequirementNeedsHuman(repo, "REQ-001", {
      source: "auto_heal_exhausted",
      reason: "自动自愈达到上限仍未通过",
      at: Date.now(),
    });

    // REQ-002: cancelled sandbox with unsaved edits -> shows retained sandbox callout + discard button
    await createRequirement(repo, {
      goal: "测试取消保留沙箱",
      criteria: [{ id: "AC-1", description: "passes", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-002", { designMarkdown: "# Plan 2" });
    await createOrReuseWorktree(repo, "REQ-002");
    const wt2 = resolveCodeRoot(repo, "REQ-002");
    await approveDesign(repo, "REQ-002", { baseline: await observeGitSnapshot(wt2) });
    fs.writeFileSync(path.join(wt2, "app.ts"), "export const v = 88;\n");

    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, executor: makeMockExecutor() });
    servers.push(server);

    // Cancel REQ-002 via API so sandbox is safely retained
    await fetch(`${server.url}/api/requirements/REQ-002/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "暂缓开发" }),
    });

    expect(HAS_BROWSER).toBe(true);
    const page = await browser!.newPage();
    const runtimeErrors: string[] = [];
    page.on("pageerror", (err: Error) => runtimeErrors.push(`pageerror: ${err.message}`));
    page.on("console", (msg: { type(): string; text(): string }) => {
      if (msg.type() === "error") runtimeErrors.push(`console.error: ${msg.text()}`);
    });

    try {
      await page.setViewport({ width: 1360, height: 900 });
      await page.goto(server.url, { waitUntil: "networkidle2" });
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 10_000 });
      await page.click('[data-testid="req-row-REQ-001"]');

      // 1. Verify needsHuman danger banner shows both escalate_sota and revise_plan directly
      await page.waitForSelector('[data-testid="action-escalate_sota"]', { timeout: 10_000 });
      await page.waitForSelector('[data-testid="action-revise_plan"]', { timeout: 10_000 });

      // 2. Click revise_plan -> submit modal -> transitions to planning
      await page.click('[data-testid="action-revise_plan"]');
      await page.waitForSelector('[data-testid="revise-plan-reason"]', { timeout: 5_000 });
      await page.type('[data-testid="revise-plan-reason"]', "调整模块划分，清空旧改动重写");
      await page.click('[data-testid="confirm-revise-plan-btn"]');

      await page.waitForFunction(
        () => !document.querySelector('[data-testid="action-revise_plan"]'),
        { timeout: 10_000 },
      );
      expect(getRequirement(repo, "REQ-001").state.stage).toBe("planning");

      // Agent submits revised plan v2 -> banner now shows reset-sandbox checkbox + approve_only
      await propose(repo, "REQ-001", {
        designMarkdown: "# Plan v2",
        criteria: [{ id: "AC-1", description: "passes", required: true, command: "echo ok" }],
      });
      await page.goto(server.url, { waitUntil: "networkidle2" });
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 10_000 });
      await page.click('[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="action-approve_only"]', { timeout: 10_000 });
      await page.click('[data-testid="action-approve_only"]');
      await page.waitForSelector('[data-testid="approve-reset-sandbox-checkbox"]', { timeout: 5_000 });
      await page.click('[data-testid="approve-reset-sandbox-checkbox"]');
      await page.click('[data-testid="confirm-workspace-approval-btn"]');
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="approve-reset-sandbox-checkbox"]'),
        { timeout: 10_000 },
      );
      expect(fs.readFileSync(path.join(wt1, "app.ts"), "utf8")).toBe("export const v = 1;\n");

      // 3. Make 2 WIP commits in REQ-001 sandbox, verify & accept, then 1-click local squash merge via UI!
      fs.writeFileSync(path.join(wt1, "app.ts"), "export const v = 10;\n");
      await commitSandboxWipCheckpoint(repo, "REQ-001", { action: "implement", runId: "RUN-W1", status: "succeeded" });
      fs.writeFileSync(path.join(wt1, "feature.ts"), "export const done = true;\n");
      await commitSandboxWipCheckpoint(repo, "REQ-001", { action: "fix", runId: "RUN-W2", status: "succeeded" });
      await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
      const snap1 = await observeGitSnapshot(wt1);
      await acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: snap1!.fingerprint });

      await page.goto(server.url, { waitUntil: "networkidle2" });
      await page.waitForSelector('[data-action="set-scope"][data-value="done"]', { timeout: 10_000 });
      await page.click('[data-action="set-scope"][data-value="done"]');
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 10_000 });
      await page.click('[data-testid="req-row-REQ-001"]');

      await page.waitForSelector('[data-testid="merge-local-btn"]', { timeout: 10_000 });
      await page.click('[data-testid="merge-local-btn"]');
      await page.waitForSelector('[data-testid="deliver-modal"]', { timeout: 5_000 });
      await page.waitForSelector('[data-testid="deliver-wip-squash-hint"]', { timeout: 5_000 });
      const prefilledMsg = await page.evaluate(
        () => (document.querySelector('[data-testid="deliver-commit-message"]') as HTMLTextAreaElement | null)?.value ?? "",
      );
      expect(prefilledMsg).toContain("feat(req-001):");
      expect(prefilledMsg).toContain("\n\nChanged files");

      await page.click('[data-testid="submit-deliver-btn"]');
      await page.waitForSelector('[data-testid="delivery-summary-line"]', { timeout: 10_000 });
      expect(fs.readFileSync(path.join(repo, "feature.ts"), "utf8")).toBe("export const done = true;\n");
      expect(getSandboxForRequirement(repo, "REQ-001")).toBeNull();

      // 4. Open cancelled REQ-002 -> verify retained sandbox callout + click discard-sandbox-btn
      await page.click('[data-action="set-scope"][data-value="all"]');
      await page.waitForSelector('[data-testid="req-row-REQ-002"]', { timeout: 10_000 });
      await page.click('[data-testid="req-row-REQ-002"]');
      await page.waitForSelector('[data-testid="sandbox-status-btn"]', { timeout: 10_000 });
      await page.click('[data-testid="sandbox-status-btn"]');
      await page.waitForSelector('[data-testid="cancelled-sandbox-callout"]', { timeout: 10_000 });
      await page.click('[data-testid="discard-sandbox-btn"]');
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="cancelled-sandbox-callout"]'),
        { timeout: 10_000 },
      );
      expect(getSandboxForRequirement(repo, "REQ-002")).toBeNull();

      expect(runtimeErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 50_000);

  test("WB-18 regression: custom decision input + direct click on decision-revise-btn succeeds without 409", async () => {
    const repo = makeGitRepo("wb-fp2-revise-");
    await initProject(repo, {
      name: "Fp2ReviseRaceRepo",
      privacyMode: "local",
      routing: { ...buildInitialProjectRouting(), autoReview: false, autoHeal: false },
    });
    await createRequirement(repo, { goal: "测试自定义决策直接点击提交修订" });
    await propose(repo, "REQ-001", {
      designMarkdown: "# 方案 v1",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
      decisions: [
        {
          id: "D-1",
          question: "选择持久化格式？",
          options: [
            { id: "json", label: "JSON", recommended: true },
            { id: "yaml", label: "YAML" },
          ],
        },
      ],
    });
    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, executor: makeMockExecutor() });
    servers.push(server);

    expect(HAS_BROWSER).toBe(true);
    const page = await browser!.newPage();
    const runtimeErrors: string[] = [];
    page.on("pageerror", (err: Error) => runtimeErrors.push(`pageerror: ${err.message}`));
    page.on("console", (msg: { type(): string; text(): string }) => {
      if (msg.type() === "error") runtimeErrors.push(`console.error: ${msg.text()}`);
    });

    try {
      await page.setViewport({ width: 1360, height: 900 });
      await page.goto(server.url, { waitUntil: "networkidle2" });
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 10_000 });
      await page.click('[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="decision-custom-D-1"]', { timeout: 10_000 });

      // Type custom text and IMMEDIATELY click decision-revise-btn without blurring first
      await page.type('[data-testid="decision-custom-D-1"]', "使用 TOML 配置");
      await page.click('[data-testid="decision-revise-btn"]');

      await page.waitForFunction(
        () => {
          const st = document.body.innerText;
          return st.includes("使用 TOML 配置") || st.includes("修订");
        },
        { timeout: 10_000 },
      );
      for (let i = 0; i < 40; i += 1) {
        if ((getRequirement(repo, "REQ-001").state.lastFeedback ?? "").includes("使用 TOML 配置")) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(getRequirement(repo, "REQ-001").state.lastFeedback ?? "").toContain("使用 TOML 配置");
      expect(runtimeErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 45_000);
});
