import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  approveDesign,
  authorizeFastTrack,
  createRequirement,
  getRequirement,
  initProject,
  propose,
  readProjectPlaybook,
  recordDesignReviewReport,
  recordReviewReport,
  updateProjectConfig,
} from "../../src/core/engine.ts";
import { observeGitSnapshot } from "../../src/core/git.ts";
import { runVerification } from "../../src/core/runner.ts";
import { createOrReuseWorktree } from "../../src/core/worktree.ts";
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

function makeGitRepo(prefix = "wb-fp3-web-"): string {
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-fp3-web-hub-"));
  tempDirs.push(dir);
  process.env.WORKBENCH_HUB_DIR = dir;
  return dir;
}

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
      args: ["-c", "echo mock-agent-ok"],
      displayCommand: "mock-agent",
    }),
  });
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

describe("Flow Phase 3 real Chromium E2E (WB-21 – WB-24)", () => {
  test("WB-21 & WB-22 UI: create Bug via modal with Bug badge, non-blocking block design review card, and direct approval", async () => {
    makeTempHub();
    const repo = makeGitRepo("wb-fp3-wb2122-");
    await initProject(repo, {
      name: "Fp3BugDesignRepo",
      privacyMode: "local",
      routing: { ...buildInitialProjectRouting(), autoReview: false, autoHeal: false },
    });

    // REQ-001: planning requirement with a `block` heterogeneous design review (must NOT block approval!)
    await createRequirement(repo, { goal: "重构配置加载器" });
    const prop = await propose(repo, "REQ-001", {
      designMarkdown: "# 配置加载方案 v1",
      criteria: [{ id: "AC-1", description: "单测通过", required: true, command: "echo ok" }],
    });
    await recordDesignReviewReport(repo, "REQ-001", {
      reviewerHarness: "codex",
      reviewerModel: "codex-auto-review",
      verdict: "block",
      summary: "建议增加配置校验回退路径",
      markdown: "## 评审详情\n建议增加回退路径。",
      findings: [{ id: "DF-1", severity: "high", title: "缺少回退配置" }],
      reviewedSpecHash: prop.state.specHash,
      reviewedDesignHash: prop.state.designHash,
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

      // 1. Open REQ-001 and verify non-blocking `design-review-card` with block verdict + revise button
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 10_000 });
      await page.click('[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="design-review-card"]', { timeout: 10_000 });
      await page.waitForSelector('[data-testid="revise-from-design-review-btn"]', { timeout: 5_000 });
      await page.waitForSelector('[data-testid="dispatch-design-review-btn"]', { timeout: 5_000 });

      // Approve directly with ZERO override modal despite design review returning `block`!
      const approveDisabled = await page.evaluate(
        () => (document.querySelector('[data-testid="action-approve_only"]') as HTMLButtonElement | null)?.disabled ?? true,
      );
      expect(approveDisabled).toBe(false);
      await page.click('[data-testid="action-approve_only"]');
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="design-review-card"]'),
        { timeout: 10_000 },
      );
      expect(getRequirement(repo, "REQ-001").state.stage).toBe("coding");

      // 2. Open New Requirement modal -> toggle `Bug` kind -> verify bug button labels -> save Bug only
      await page.waitForSelector('[data-testid="new-req-btn"]', { timeout: 10_000 });
      await page.click('[data-testid="new-req-btn"]');
      await page.waitForSelector('[data-testid="new-req-kind-bug"]', { timeout: 5_000 });
      await page.click('[data-testid="new-req-kind-bug"]');
      await page.type('#new-req-goal', "修复空列表渲染白屏 Bug");
      const labels = await page.evaluate(() => ({
        saveText: document.querySelector('[data-testid="save-draft-btn"]')?.textContent ?? "",
        startText: document.querySelector('[data-testid="create-and-dispatch-btn"]')?.textContent ?? "",
      }));
      expect(labels.saveText).toContain("仅登记 Bug");
      expect(labels.startText).toContain("创建并开始修复");

      await page.click('[data-testid="save-draft-btn"]');
      await page.waitForSelector('[data-testid="bug-kind-badge"]', { timeout: 10_000 });
      await page.waitForSelector('[data-testid="req-bug-badge-REQ-002"]', { timeout: 10_000 });
      expect(getRequirement(repo, "REQ-002").state.kind).toBe("bug");
      expect(getRequirement(repo, "REQ-002").state.stage).toBe("planning");

      expect(runtimeErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 45_000);

  test("WB-23 & WB-24 UI: fast_track baseline-only honest signal, 4-element acceptance panel, accept+remember+deliver, and review block playbook button", async () => {
    makeTempHub();
    const repo = makeGitRepo("wb-fp3-wb2324-");
    await initProject(repo, {
      name: "Fp3AcceptPlaybookRepo",
      privacyMode: "local",
      routing: { ...buildInitialProjectRouting(), autoReview: false, autoHeal: false },
    });
    await updateProjectConfig(repo, { verification: { fastCommand: "echo fast-ok" } });

    // REQ-001: fast_track with system-injected generic baseline only -> ready for acceptance
    await createRequirement(repo, { goal: "微调页脚文案" });
    await authorizeFastTrack(repo, "REQ-001", { baseline: await observeGitSnapshot(repo) });
    fs.writeFileSync(path.join(repo, "app.ts"), "export const v = 2;\n");
    await runVerification(repo, "REQ-001", { command: "echo fast-ok", criterionIds: ["AC-1"] });

    // REQ-002: coding item with a `block` code review report -> shows "记住这条项目经验" button on review card
    await createRequirement(repo, {
      goal: "新增缓存层",
      criteria: [{ id: "AC-1", description: "单测通过", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-002", { designMarkdown: "# Cache design" });
    await approveDesign(repo, "REQ-002", { baseline: await observeGitSnapshot(repo) });
    await runVerification(repo, "REQ-002", { command: "echo ok", criterionIds: ["AC-1"] });
    const snap2 = await observeGitSnapshot(repo);
    const d2 = getRequirement(repo, "REQ-002");
    await recordReviewReport(repo, "REQ-002", {
      reviewerHarness: "codex",
      reviewerModel: "codex-auto-review",
      verdict: "block",
      summary: "缓存键必须带版本号前缀防止旧格式反序列化崩溃",
      markdown: "## 审查阻塞\n请为缓存键增加版本号前缀。",
      reviewedSpecHash: d2.state.specHash,
      reviewedCodeSnapshotHash: snap2!.fingerprint,
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

      // 1. Open REQ-002 -> click `review-remember-lesson-btn` -> appends to .workbench/playbook.md without dirtying Git
      await page.waitForSelector('[data-testid="req-row-REQ-002"]', { timeout: 10_000 });
      await page.click('[data-testid="req-row-REQ-002"]');
      await page.waitForSelector('[data-testid="review-remember-lesson-btn"]', { timeout: 10_000 });
      await page.click('[data-testid="review-remember-lesson-btn"]');
      await page.waitForFunction(
        () => true,
        { timeout: 1_000 },
      );
      // Poll briefly for async POST /api/project/playbook/lessons to finish
      for (let i = 0; i < 40; i += 1) {
        if (readProjectPlaybook(repo).lessons.length >= 1) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(readProjectPlaybook(repo).markdown).toContain("缓存键必须带版本号前缀");

      // 2. Open REQ-001 -> verify 4-element acceptance summary panel & fast_track honest baseline warning
      await page.click('[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="acceptance-summary-panel"]', { timeout: 10_000 });
      await page.waitForSelector('[data-testid="acceptance-credibility-card"]', { timeout: 5_000 });
      await page.waitForSelector('[data-testid="fast-track-baseline-warning"]', { timeout: 5_000 });
      await page.waitForSelector('[data-testid="acceptance-diff-card"]', { timeout: 5_000 });
      await page.waitForSelector('[data-testid="acceptance-exit-actions"]', { timeout: 5_000 });
      // Non-UI item hides screenshots card cleanly (zero noise)
      const hasShotsCard = await page.evaluate(() => Boolean(document.querySelector('[data-testid="acceptance-screenshots-card"]')));
      expect(hasShotsCard).toBe(false);

      // Type acceptance note, check "remember lesson" + "open deliver after accept", click accept!
      await page.type('[data-testid="accept-summary-note"]', "页脚年份统一从统一常量读取");
      await page.click('[data-testid="accept-remember-lesson"]');
      await page.click('[data-testid="accept-and-deliver-checkbox"]');
      await page.click('[data-testid="acceptance-exit-accept-btn"]');

      // Deliver modal opens automatically after acceptance AND playbook captured the lesson!
      await page.waitForSelector('[data-testid="deliver-modal"]', { timeout: 10_000 });
      expect(getRequirement(repo, "REQ-001").state.stage).toBe("done");
      expect(readProjectPlaybook(repo).markdown).toContain("页脚年份统一从统一常量读取");

      expect(runtimeErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 45_000);

  test("WB-13 & WB-14 regression: stale block modal enforces overrideReason & failed setupScript banner works", async () => {
    makeTempHub();
    const repo = makeGitRepo("wb-fp3-reg-");
    await initProject(repo, {
      name: "Fp3RegUiRepo",
      privacyMode: "local",
      routing: { ...buildInitialProjectRouting(), autoReview: false, autoHeal: false },
    });

    // REQ-001: block review becomes stale after code change & re-verify -> accept_override MUST require reason
    await createRequirement(repo, {
      goal: "Stale block override guard",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Plan 1" });
    await approveDesign(repo, "REQ-001", { baseline: await observeGitSnapshot(repo) });
    fs.writeFileSync(path.join(repo, "app.ts"), "export const v = 2;\n");
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const snap1 = await observeGitSnapshot(repo);
    const d1 = getRequirement(repo, "REQ-001");
    await recordReviewReport(repo, "REQ-001", {
      reviewerHarness: "codex",
      reviewerModel: "codex-auto-review",
      verdict: "block",
      summary: "旧版存在空指针风险",
      markdown: "## Block",
      reviewedSpecHash: d1.state.specHash,
      reviewedCodeSnapshotHash: snap1!.fingerprint,
    });
    // Edit code and re-verify -> review is now stale!
    fs.writeFileSync(path.join(repo, "app.ts"), "export const v = 3;\n");
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });

    // REQ-002: failed setupScript sandbox -> shows setup-failed banner in UI
    await updateProjectConfig(repo, { worktree: { enabled: true, setupScript: "exit 1" } });
    await createRequirement(repo, {
      goal: "Setup failure banner",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-002", { designMarkdown: "# Plan 2" });
    await expect(createOrReuseWorktree(repo, "REQ-002")).rejects.toThrow();

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

      // 1. REQ-001 stale block -> accept opens accept-override-modal with disabled confirm button until reason typed
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 10_000 });
      await page.click('[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="acceptance-exit-accept-btn"]', { timeout: 10_000 });
      await page.click('[data-testid="acceptance-exit-accept-btn"]');
      await page.waitForSelector('[data-testid="accept-override-modal"]', { timeout: 5_000 });

      const disabledWhenEmpty = await page.evaluate(
        () => (document.querySelector('[data-testid="confirm-accept-override-btn"]') as HTMLButtonElement | null)?.disabled ?? false,
      );
      expect(disabledWhenEmpty).toBe(true);

      await page.type('[data-testid="accept-override-reason"]', "已在 v=3 修复空指针并通过验证");
      await page.waitForFunction(
        () => !(document.querySelector('[data-testid="confirm-accept-override-btn"]') as HTMLButtonElement | null)?.disabled,
        { timeout: 5_000 },
      );
      await page.click('[data-testid="confirm-accept-override-btn"]');
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="accept-override-modal"]'),
        { timeout: 10_000 },
      );
      expect(getRequirement(repo, "REQ-001").state.stage).toBe("done");
      expect(getRequirement(repo, "REQ-001").state.acceptance?.overrideReason).toBe("已在 v=3 修复空指针并通过验证");

      // 2. REQ-002 failed setupScript banner -> ignore dismisses banner
      await page.click('[data-testid="req-row-REQ-002"]');
      await page.waitForSelector('[data-testid="sandbox-setup-failed-banner"]', { timeout: 10_000 });
      await page.click('[data-testid="sandbox-setup-ignore-btn"]');
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="sandbox-setup-failed-banner"]'),
        { timeout: 10_000 },
      );

      expect(runtimeErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 45_000);
});
