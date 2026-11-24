import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
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
  recordReviewReport,
  updateTasks,
} from "../../src/core/engine.ts";
import { observeGitSnapshot } from "../../src/core/git.ts";
import { runVerification } from "../../src/core/runner.ts";
import { createOrReuseWorktree, inspectRsiSandboxDrift } from "../../src/hub/evolution.ts";
import { HubExecutor } from "../../src/hub/executor.ts";
import { registerHubProject } from "../../src/hub/registry.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";
import { resolveTestBrowser } from "./browser_env.ts";

const browserEnv = resolveTestBrowser();
const HAS_BROWSER = browserEnv !== null;

interface BrowserPage {
  setViewport(vp: { width: number; height: number }): Promise<void>;
  goto(url: string, opts?: { waitUntil?: string }): Promise<unknown>;
  waitForSelector(sel: string, opts?: { timeout?: number }): Promise<unknown>;
  waitForFunction(fn: string | ((...args: unknown[]) => boolean), opts?: { timeout?: number }, ...args: unknown[]): Promise<unknown>;
  click(sel: string): Promise<void>;
  type(sel: string, text: string): Promise<void>;
  evaluate<T>(fn: (...args: any[]) => T, ...args: any[]): Promise<T>;
  on(event: string, cb: (...args: any[]) => void): void;
  close(): Promise<void>;
}

interface BrowserInstance {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

const tempDirs: string[] = [];
const servers: WorkbenchServerHandle[] = [];
const origHubDir = process.env.WORKBENCH_HUB_DIR;
let browser: BrowserInstance | null = null;

function makeGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-rev-web-"));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "app.ts"), "export const v = 1;\n");
  execFileSync("git", ["add", "app.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function makeTempHub(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-rev-web-hub-"));
  tempDirs.push(dir);
  process.env.WORKBENCH_HUB_DIR = dir;
  return dir;
}

async function clickReady(page: BrowserPage, selector: string): Promise<void> {
  await page.waitForSelector(selector, { timeout: 5000 });
  await page.evaluate((sel: string) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) throw new Error(`Missing element: ${sel}`);
    el.click();
  }, selector);
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
});

afterEach(() => {
  while (servers.length > 0) servers.pop()!.stop();
  if (origHubDir === undefined) delete process.env.WORKBENCH_HUB_DIR;
  else process.env.WORKBENCH_HUB_DIR = origHubDir;
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

afterAll(async () => {
  if (browser) await browser.close();
});

describe.skipIf(!HAS_BROWSER)("Real browser review triage, fix dispatch, override acceptance, and per-action runner isolation", () => {
  test("surfaces review blockers with one-click fix, stage-aware feedback modal, override reason modal, and isolated review routing", async () => {
    makeTempHub();
    const repo = makeGitRepo();
    await initProject(repo, { name: "ReviewWeb", privacyMode: "local" });
    registerHubProject(repo);
    await createRequirement(repo, {
      goal: "Verify UI review triage",
      criteria: [{ id: "AC-1", description: "passes echo", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design\nKeep safe.", actor: "agent" });
    await approveDesign(repo, "REQ-001");
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const snap = (await observeGitSnapshot(repo))!;
    await updateTasks(repo, "REQ-001", {
      tasks: [{ title: "implemented", status: "done" }],
      readyForAcceptance: true,
      currentCodeSnapshotHash: snap.fingerprint,
    });
    await recordReviewReport(repo, "REQ-001", {
      reviewerHarness: "codex",
      reviewerModel: "gpt-6.2-sol",
      verdict: "block",
      summary: "错误提示未随语言切换",
      markdown: "- **高｜错误未本地化**",
      findings: [
        {
          id: "F-1",
          severity: "high",
          title: "错误提示仍固定中文",
          criterionIds: ["AC-1"],
          files: ["app.ts:1"],
          suggestion: "保存消息键并按语言渲染",
        },
        {
          id: "F-2",
          severity: "low",
          title: "可补充注释",
          suggestion: "补一句注释",
        },
      ],
      reviewedSpecHash: getRequirement(repo, "REQ-001").state.specHash,
      reviewedCodeSnapshotHash: snap.fingerprint,
    });

    const dispatched: Array<{ action: string; harness: string; model: string; prompt: string }> = [];
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
        {
          id: "qodercn",
          label: "QoderCN",
          subscription: "Qoder",
          installed: true,
          executable: "qodercn",
          models: [{ id: "DeepSeek-Flash", tier: "fast", source: "detected" }],
          defaultModel: "DeepSeek-Flash",
          detectedAt: Date.now(),
        },
      ],
      commandBuilder: (target, ctx) => {
        dispatched.push({ action: ctx.action, harness: target.harness, model: target.model, prompt: ctx.prompt });
        return {
          command: "bash",
          args: ["-c", "echo 'fixed ok'"],
          displayCommand: `mock-${ctx.action}`,
        };
      },
    });

    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, hubMode: true, executor });
    servers.push(server);

    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));

    try {
      await page.setViewport({ width: 1360, height: 900 });
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="req-decision-badge-REQ-001"]', { timeout: 5000 });
      const decisionText = await page.evaluate(
        () => document.querySelector('[data-testid="req-decision-badge-REQ-001"]')?.textContent ?? "",
      );
      expect(decisionText).toContain("审查建议阻塞");

      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="action-dispatch_fix_review"]', { timeout: 5000 });

      // 1. Banner & Review Card show blocker state and findings
      const bannerClass = await page.evaluate(() => document.querySelector('[data-testid="action-banner"]')?.className ?? "");
      expect(bannerClass).toContain("danger");
      await page.waitForSelector('[data-testid="review-findings-list"]', { timeout: 5000 });
      const fixBtnLabel = await page.evaluate(() => document.querySelector('[data-testid="review-fix-btn"]')?.textContent ?? "");
      expect(fixBtnLabel).toContain("按选中的 1 项修复");

      // 2. Clicking accept opens override modal requiring reason
      await clickReady(page, '[data-testid="action-accept"]');
      await page.waitForSelector('[data-testid="accept-override-modal"]', { timeout: 5000 });
      const disabledInitially = await page.evaluate(
        () => (document.querySelector('[data-testid="confirm-accept-override-btn"]') as HTMLButtonElement).disabled,
      );
      expect(disabledInitially).toBe(true);
      await clickReady(page, '[data-testid="accept-override-modal"] [data-slot="dialog-footer"] [data-slot="button"]:not([data-testid])');
      await page.waitForFunction(() => !document.querySelector('[data-testid="accept-override-modal"]'), { timeout: 5000 });

      // 3. Feedback modal in awaiting_acceptance displays fix mode & one-click fill review button
      await clickReady(page, '[data-testid="action-request_changes"]');
      await page.waitForSelector('[data-testid="feedback-modal"]', { timeout: 5000 });
      const fbHeading = await page.evaluate(() => document.querySelector('[data-testid="feedback-modal"] [data-slot="dialog-title"]')?.textContent ?? "");
      expect(fbHeading).toContain("打回修改");
      await clickReady(page, '[data-testid="feedback-fill-review-btn"]');
      const prefilled = await page.evaluate(() => (document.querySelector("#feedback-input") as HTMLTextAreaElement).value);
      expect(prefilled).toContain("错误提示未随语言切换");
      await clickReady(page, '[data-testid="feedback-modal"] [data-slot="dialog-footer"] [data-slot="button"]:not([data-testid])');
      await page.waitForFunction(() => !document.querySelector('[data-testid="feedback-modal"]'), { timeout: 5000 });

      // 4. Select qodercn/DeepSeek-Flash for fix, then click run-review-btn -> review MUST NOT use qodercn/DeepSeek-Flash!
      await clickReady(page, '[data-testid="banner-runner-select-trigger"]');
      await page.waitForSelector('[data-slot="command-item"]', { timeout: 5000 });
      const picked = await page.evaluate(() => {
        const item = Array.from(document.querySelectorAll('[data-slot="command-item"]')).find((el) =>
          (el.textContent ?? "").includes("DeepSeek-Flash"),
        ) as HTMLElement | undefined;
        if (!item) return false;
        item.click();
        return true;
      });
      expect(picked).toBe(true);
      await page.waitForFunction(
        () => (document.querySelector('[data-testid="banner-runner-select-trigger"]')?.textContent ?? "").includes("DeepSeek-Flash"),
        { timeout: 5000 },
      );

      await clickReady(page, '[data-testid="run-review-btn"]');
      const deadline1 = Date.now() + 8000;
      while (Date.now() < deadline1) {
        const runs = getRequirement(repo, "REQ-001").state.agentRuns ?? [];
        if (runs.length >= 1 && runs[0]!.status !== "running") break;
        await new Promise((r) => setTimeout(r, 25));
      }
      await page.waitForFunction(
        () =>
          !document.querySelector('[data-testid="live-agent-banner"]') &&
          Boolean(document.querySelector('[data-testid="review-fix-btn"]')) &&
          !(document.querySelector('[data-testid="review-fix-btn"]') as HTMLButtonElement).disabled,
        { timeout: 5000 },
      );
      expect(dispatched[0]?.action).toBe("review");
      expect(dispatched[0]?.harness).toBe("codex");
      expect(dispatched[0]?.model).toBe("codex-auto-review");

      // 5. Clicking review-fix-btn moves awaiting_acceptance -> implementing (preserving approval!) and dispatches "fix" (NOT "design")
      await clickReady(page, '[data-testid="review-fix-btn"]');
      const deadline2 = Date.now() + 8000;
      while (Date.now() < deadline2) {
        const runs = getRequirement(repo, "REQ-001").state.agentRuns ?? [];
        if (runs.length >= 2 && runs[1]!.status !== "running") break;
        await new Promise((r) => setTimeout(r, 25));
      }
      await page.waitForFunction(
        () =>
          Boolean(document.querySelector('[data-testid="ws-stage-badge"]')?.textContent?.includes("实施中")) &&
          !document.querySelector('[data-testid="live-agent-banner"]'),
        { timeout: 5000 },
      );

      const fixRun = dispatched.find((d) => d.action === "fix");
      expect(fixRun).toBeDefined();
      expect(dispatched.some((d) => d.action === "design")).toBe(false);
      expect(fixRun!.harness).toBe("qodercn");
      expect(fixRun!.model).toBe("DeepSeek-Flash");
      expect(fixRun!.prompt).toContain("错误提示仍固定中文");

      const afterFixState = getRequirement(repo, "REQ-001").state;
      expect(afterFixState.approval).not.toBeNull();
      expect(afterFixState.stage).toBe("implementing");

      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("审查运行中首页决策盒与侧栏待拍板计数实时移除，运行结束后恢复", async () => {
    makeTempHub();
    const repo = makeGitRepo();
    await initProject(repo, { name: "HomeRunningDecision", privacyMode: "local" });
    registerHubProject(repo);
    await createRequirement(repo, {
      goal: "Agent 运行中不应显示待拍板",
      criteria: [{ id: "AC-1", description: "echo ok 通过", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design\n等待跨模型审查。", actor: "agent" });
    await approveDesign(repo, "REQ-001");
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const snap = (await observeGitSnapshot(repo))!;
    await updateTasks(repo, "REQ-001", {
      tasks: [{ title: "实现完成", status: "done" }],
      readyForAcceptance: true,
      currentCodeSnapshotHash: snap.fingerprint,
    });

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
      commandBuilder: () => ({ command: "bash", args: ["-c", "sleep 30"], displayCommand: "mock-review-sleep" }),
    });
    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, hubMode: true, executor });
    servers.push(server);

    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));
    let runId: string | null = null;

    try {
      await page.setViewport({ width: 1360, height: 900 });
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="req-decision-badge-REQ-001"]', { timeout: 5000 });
      const initial = await page.evaluate(() => ({
        decisionPills: document.querySelectorAll(".stat-pill.warn").length,
        sidebarBadge: Boolean(document.querySelector(".sb-item .sb-badge.warn")),
      }));
      expect(initial.decisionPills).toBe(1);
      expect(initial.sidebarBadge).toBe(true);

      const started = await executor.startRun({ root: repo, requirementId: "REQ-001", action: "review" });
      runId = started.run.id;

      await page.waitForFunction(
        () =>
          !document.querySelector('[data-testid="req-decision-badge-REQ-001"]') &&
          !document.querySelector(".sb-item .sb-badge.warn") &&
          document.querySelectorAll(".stat-pill.warn").length === 0 &&
          (document.querySelector('[data-testid="req-row-REQ-001"] .req-sub')?.textContent ?? "").includes("执行中"),
        { timeout: 5000 },
      );

      expect(executor.cancelRun(runId)).toBe(true);
      runId = null;
      await page.waitForSelector('[data-testid="req-decision-badge-REQ-001"]', { timeout: 5000 });
      expect(pageErrors).toEqual([]);
    } finally {
      if (runId) executor.cancelRun(runId);
      await page.close();
    }
  }, 30_000);

  test("drawer model selector applies to runRefineFromDrawer and unmerged done requirements surface actionable sandbox drift", async () => {
    makeTempHub();
    const repo = makeGitRepo();
    await initProject(repo, { name: "DrawerAndDrift", privacyMode: "local" });
    registerHubProject(repo);

    // REQ-001: delivered (done) requirement whose sandbox has behind/conflicting commits on main
    await createRequirement(repo, {
      goal: "Done req should not show sandbox drift callout",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design\nDone req.", actor: "agent" });
    await approveDesign(repo, "REQ-001");
    const sb = await createOrReuseWorktree(repo, "REQ-001");
    fs.writeFileSync(path.join(sb.worktreePath, "app.ts"), "export const v = 99;\n");
    fs.writeFileSync(path.join(repo, "app.ts"), "export const v = 2;\n");
    execFileSync("git", ["add", "app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "main conflicts after squash"], { cwd: repo, stdio: "ignore" });
    const driftCheck = await inspectRsiSandboxDrift(repo, "REQ-001");
    expect(driftCheck?.conflictFiles).toEqual(["app.ts"]);

    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const wtSnap = (await observeGitSnapshot(sb.worktreePath))!;
    await updateTasks(repo, "REQ-001", {
      tasks: [{ title: "done", status: "done" }],
      readyForAcceptance: true,
      currentCodeSnapshotHash: wtSnap.fingerprint,
    });
    await acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: wtSnap.fingerprint });

    // REQ-002: awaiting_approval requirement for testing RightDrawer refine runner override
    await createRequirement(repo, {
      goal: "Drawer refine model override test",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-002", { designMarkdown: "# Design\nInitial draft.", actor: "agent" });

    const dispatched: Array<{ action: string; harness: string; model: string }> = [];
    const executor = new HubExecutor({
      initialHarnesses: [
        {
          id: "codex",
          label: "Codex",
          subscription: "Plus",
          installed: true,
          executable: "codex",
          models: [{ id: "gpt-6.2-sol", tier: "sota", source: "detected" }],
          defaultModel: "gpt-6.2-sol",
          detectedAt: Date.now(),
        },
        {
          id: "qodercn",
          label: "QoderCN",
          subscription: "Qoder",
          installed: true,
          executable: "qodercn",
          models: [{ id: "DeepSeek-Flash", tier: "fast", source: "detected" }],
          defaultModel: "DeepSeek-Flash",
          detectedAt: Date.now(),
        },
      ],
      commandBuilder: (target, ctx) => {
        dispatched.push({ action: ctx.action, harness: target.harness, model: target.model });
        return { command: "bash", args: ["-c", "echo 'ok'"], displayCommand: `mock-${ctx.action}` };
      },
    });

    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, hubMode: true, executor });
    servers.push(server);

    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));

    try {
      await page.setViewport({ width: 1360, height: 900 });
      await page.goto(server.url, { waitUntil: "networkidle0" });

      // 1. Switch scope to "all" so done REQ-001 appears, open it, and verify unmerged done sandbox still shows drift callout & resolve button
      await clickReady(page, '[data-action="set-scope"][data-value="all"]');
      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="action-banner"]', { timeout: 5000 });
      await page.waitForFunction(
        () => (document.querySelector('[data-testid="ws-stage-badge"]')?.textContent ?? "").includes("已完成"),
        { timeout: 5000 },
      );
      const hasDriftCallout = await page.evaluate(() => Boolean(document.querySelector('[data-testid="sandbox-drift-callout"]')));
      const hasResolveBtn = await page.evaluate(() => Boolean(document.querySelector('[data-testid="agent-sync-sandbox-btn"]')));
      expect(hasDriftCallout).toBe(true);
      expect(hasResolveBtn).toBe(true);

      // 2. Navigate back to home, open REQ-002, open RightDrawer, switch drawer-runner-select -> run-refine-btn
      await clickReady(page, '[data-testid="back-home-btn"]');
      await clickReady(page, '[data-testid="req-row-REQ-002"]');
      await page.waitForSelector('[data-testid="toggle-drawer-btn"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="toggle-drawer-btn"]');
      await page.waitForSelector('[data-testid="drawer-runner-select-trigger"]', { timeout: 5000 });

      await clickReady(page, '[data-testid="drawer-runner-select-trigger"]');
      await page.waitForSelector('[data-slot="command-item"]', { timeout: 5000 });
      const picked = await page.evaluate(() => {
        const item = Array.from(document.querySelectorAll('[data-slot="command-item"]')).find((el) =>
          (el.textContent ?? "").includes("DeepSeek-Flash"),
        ) as HTMLElement | undefined;
        if (!item) return false;
        item.click();
        return true;
      });
      expect(picked).toBe(true);
      await page.waitForFunction(
        () => (document.querySelector('[data-testid="drawer-runner-select-trigger"]')?.textContent ?? "").includes("DeepSeek-Flash"),
        { timeout: 5000 },
      );

      await page.type("#discuss-input", "补充边界校验章节");
      await clickReady(page, '[data-testid="run-refine-btn"]');

      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const runs = getRequirement(repo, "REQ-002").state.agentRuns ?? [];
        if (runs.length >= 1 && runs[0]!.status !== "running") break;
        await new Promise((r) => setTimeout(r, 25));
      }

      expect(dispatched).toEqual([{ action: "design", harness: "qodercn", model: "DeepSeek-Flash" }]);
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("stage-aware RightDrawer routes refine to fix in implementing stage and disables refine in done stage", async () => {
    makeTempHub();
    const repo = makeGitRepo();
    await initProject(repo, { name: "StageDrawer", privacyMode: "local" });
    registerHubProject(repo);

    await createRequirement(repo, {
      goal: "Done req readonly drawer check",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design\nDone.", actor: "agent" });
    await approveDesign(repo, "REQ-001");
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const snap = (await observeGitSnapshot(repo))!;
    await updateTasks(repo, "REQ-001", {
      tasks: [{ title: "done", status: "done" }],
      readyForAcceptance: true,
      currentCodeSnapshotHash: snap.fingerprint,
    });
    await acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: snap.fingerprint });

    await createRequirement(repo, {
      goal: "Implementing req dispatches fix from drawer",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-002", { designMarkdown: "# Design\nReady.", actor: "agent" });
    await approveDesign(repo, "REQ-002");

    const dispatched: Array<{ action: string; harness: string; model: string }> = [];
    const executor = new HubExecutor({
      initialHarnesses: [
        {
          id: "codex",
          label: "Codex",
          subscription: "Plus",
          installed: true,
          executable: "codex",
          models: [{ id: "gpt-6.2-sol", tier: "sota", source: "detected" }],
          defaultModel: "gpt-6.2-sol",
          detectedAt: Date.now(),
        },
      ],
      commandBuilder: (target, ctx) => {
        dispatched.push({ action: ctx.action, harness: target.harness, model: target.model });
        return { command: "bash", args: ["-c", "echo 'ok'"], displayCommand: `mock-${ctx.action}` };
      },
    });

    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, hubMode: true, executor });
    servers.push(server);

    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));

    try {
      await page.setViewport({ width: 1360, height: 900 });
      await page.goto(server.url, { waitUntil: "networkidle0" });

      // 1. In done REQ-001, RightDrawer run-refine-btn must be disabled (readonly stage)
      await clickReady(page, '[data-action="set-scope"][data-value="all"]');
      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="toggle-drawer-btn"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="toggle-drawer-btn"]');
      await page.waitForSelector('[data-testid="run-refine-btn"]', { timeout: 5000 });
      const doneRefineDisabled = await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="run-refine-btn"]') as HTMLButtonElement | null;
        return Boolean(btn?.disabled);
      });
      expect(doneRefineDisabled).toBe(true);

      // 2. In implementing REQ-002, RightDrawer run-refine-btn dispatches action = "fix"
      await clickReady(page, '[data-testid="back-home-btn"]');
      await clickReady(page, '[data-testid="req-row-REQ-002"]');
      await page.waitForSelector('#discuss-input', { timeout: 5000 });
      await page.type("#discuss-input", "增加参数判空防御");
      await clickReady(page, '[data-testid="run-refine-btn"]');

      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const runs = getRequirement(repo, "REQ-002").state.agentRuns ?? [];
        if (runs.length >= 1 && runs[0]!.status !== "running") break;
        await new Promise((r) => setTimeout(r, 25));
      }

      expect(dispatched).toEqual([{ action: "fix", harness: "codex", model: "gpt-6.2-sol" }]);
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("Phase 2: displays review round badge, prior round history, and converts remaining findings to follow-up pain points", async () => {
    makeTempHub();
    const repo = makeGitRepo();
    await initProject(repo, { name: "ReviewRoundsWeb", privacyMode: "local" });
    registerHubProject(repo);
    await createRequirement(repo, {
      goal: "Verify multi-round review UI convergence",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design\nClean.", actor: "agent" });
    await approveDesign(repo, "REQ-001");
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const snap = (await observeGitSnapshot(repo))!;
    await updateTasks(repo, "REQ-001", {
      tasks: [{ title: "done", status: "done" }],
      readyForAcceptance: true,
      currentCodeSnapshotHash: snap.fingerprint,
    });

    const specHash = getRequirement(repo, "REQ-001").state.specHash;
    await recordReviewReport(repo, "REQ-001", {
      reviewerHarness: "codex",
      reviewerModel: "gpt-6.2-sol",
      verdict: "concern",
      summary: "第1轮样式缺陷",
      markdown: "round 1",
      findings: [{ id: "F-1", severity: "medium", title: "按钮收缩失效" }],
      reviewedSpecHash: specHash,
      reviewedCodeSnapshotHash: snap.fingerprint,
    });
    fs.writeFileSync(path.join(repo, "app.ts"), "export const fixed = 2;\n", "utf8");
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const snap2 = (await observeGitSnapshot(repo))!;
    await updateTasks(repo, "REQ-001", {
      tasks: [{ title: "done", status: "done" }],
      readyForAcceptance: true,
      currentCodeSnapshotHash: snap2.fingerprint,
    });
    await recordReviewReport(repo, "REQ-001", {
      reviewerHarness: "codex",
      reviewerModel: "gpt-6.2-sol",
      verdict: "concern",
      summary: "第2轮仅剩极端窄屏建议",
      markdown: "round 2",
      findings: [{ id: "F-2", severity: "medium", title: "极长模型名在窄抽屉裁切" }],
      reviewedSpecHash: specHash,
      reviewedCodeSnapshotHash: snap2.fingerprint,
    });

    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, hubMode: true });
    servers.push(server);
    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));

    try {
      await page.setViewport({ width: 1360, height: 900 });
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="review-round-badge"]', { timeout: 10000 });

      const roundBadgeText = await page.evaluate(
        () => document.querySelector('[data-testid="review-round-badge"]')?.textContent ?? "",
      );
      expect(roundBadgeText).toContain("第 2 轮");
      expect(roundBadgeText).toContain("增量复审");

      const primaryBtnText = await page.evaluate(
        () => document.querySelector('[data-testid="action-accept"]')?.textContent ?? "",
      );
      expect(primaryBtnText).toContain("确认关注点并验收通过");

      const hasHistory = await page.evaluate(
        () => Boolean(document.querySelector('[data-testid="review-history-details"]')),
      );
      expect(hasHistory).toBe(true);

      await clickReady(page, '[data-testid="review-to-pain-point-btn"]');
      await page.waitForFunction(
        () => (document.body.textContent ?? "").includes("已将残余审查项记入自进化痛点收集箱"),
        { timeout: 8000 },
      );

      const evoRes = (await (await fetch(`${server.url}/api/hub/evolution`)).json()) as {
        painPoints: Array<{ title: string }>;
      };
      expect(evoRes.painPoints.some((p) => p.title.includes("[后续跟进 REQ-001]"))).toBe(true);
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);
});
