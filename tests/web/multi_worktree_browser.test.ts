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
} from "../../src/core/engine.ts";
import { observeGitSnapshot } from "../../src/core/git.ts";
import { runVerification } from "../../src/core/runner.ts";
import { createOrReuseWorktree } from "../../src/core/worktree.ts";
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-mwt-web-"));
  tempDirs.push(dir);
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  const lines = Array.from({ length: 30 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join("\n") + "\n";
  fs.writeFileSync(path.join(dir, "shared.ts"), lines);
  fs.writeFileSync(path.join(dir, "leaf.ts"), "export const leaf = 0;\n");
  execFileSync("git", ["add", "shared.ts", "leaf.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function makeTempHub(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-mwt-web-hub-"));
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

describe.skipIf(!HAS_BROWSER)("Real browser multi-worktree merge order, sibling radar, done-stage conflict sync, and reopen", () => {
  test("renders merge order panel, sibling radar, auto-merge sync, done conflict resolution, and preserve-approval reopen", async () => {
    makeTempHub();
    const repo = makeGitRepo();
    await initProject(repo, { name: "MultiWorktreeWeb", privacyMode: "local" });
    registerHubProject(repo);

    // REQ-001: done requirement with true conflict on line 1 of shared.ts
    await createRequirement(repo, {
      goal: "Done requirement with conflict",
      title: "Conflicting done feature",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design\nLine 1 edit.", actor: "agent" });
    await approveDesign(repo, "REQ-001");
    const sb1 = await createOrReuseWorktree(repo, "REQ-001", { branchPrefix: "feat" });
    fs.writeFileSync(
      path.join(sb1.worktreePath, "shared.ts"),
      fs.readFileSync(path.join(sb1.worktreePath, "shared.ts"), "utf8").replace("export const line1 = 1;", "export const line1 = 101;"),
    );
    execFileSync("git", ["add", "shared.ts"], { cwd: sb1.worktreePath, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "req1 line1"], { cwd: sb1.worktreePath, stdio: "ignore" });
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const snap1 = (await observeGitSnapshot(sb1.worktreePath))!;
    await acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: snap1.fingerprint });

    // REQ-002: active requirement with auto-mergeable edit on line 30 of shared.ts + sibling overlap on shared.ts
    await createRequirement(repo, {
      goal: "Active requirement editing line 30",
      title: "Auto-mergeable active feature",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-002", { designMarkdown: "# Design\nLine 30 edit.", actor: "agent" });
    await approveDesign(repo, "REQ-002");
    const sb2 = await createOrReuseWorktree(repo, "REQ-002", { branchPrefix: "feat" });
    fs.writeFileSync(
      path.join(sb2.worktreePath, "shared.ts"),
      fs.readFileSync(path.join(sb2.worktreePath, "shared.ts"), "utf8").replace("export const line30 = 30;", "export const line30 = 300;"),
    );
    execFileSync("git", ["add", "shared.ts"], { cwd: sb2.worktreePath, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "req2 line30"], { cwd: sb2.worktreePath, stdio: "ignore" });

    // Advance main on line 1 (conflicts with REQ-001, auto-mergeable with REQ-002!)
    fs.writeFileSync(
      path.join(repo, "shared.ts"),
      fs.readFileSync(path.join(repo, "shared.ts"), "utf8").replace("export const line1 = 1;", "export const line1 = 999;"),
    );
    execFileSync("git", ["add", "shared.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "main edits line1"], { cwd: repo, stdio: "ignore" });

    const dispatched: Array<{ action: string; reqId: string }> = [];
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
      commandBuilder: (_target, ctx) => {
        dispatched.push({ action: ctx.action, reqId: ctx.requirementId });
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

      // 1. Unified sidebar exposes Sandbox Merge filter toolbar & inline merge-order strip without duplicating cards
      await page.waitForSelector('[data-testid="sandbox-toolbar"]', { timeout: 5000 });
      // REQ-015 审查修复：沙箱筛选按钮需要覆盖基础 .btn 的 flex-shrink: 0，保持可收缩且单行。
      const sandboxFilterMetrics = await page.evaluate(() => {
        const button = document.querySelector('[data-testid="scope-sandboxes-btn"]') as HTMLElement | null;
        const style = button ? getComputedStyle(button) : null;
        return {
          flexShrink: style?.flexShrink ?? "",
          minWidth: style?.minWidth ?? "",
          height: button?.getBoundingClientRect().height ?? -1,
          singleLine: button ? button.scrollWidth <= button.clientWidth + 1 : false,
        };
      });
      expect(sandboxFilterMetrics.flexShrink).toBe("1");
      expect(sandboxFilterMetrics.minWidth).toBe("0px");
      expect(sandboxFilterMetrics.height).toBeLessThanOrEqual(29);
      expect(sandboxFilterMetrics.singleLine).toBe(true);
      expect(await page.evaluate(() => document.querySelectorAll('[data-testid="req-row-REQ-002"]').length)).toBe(1);
      await clickReady(page, '[data-testid="scope-sandboxes-btn"]');
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll('[data-testid="req-list"] .req-row')).map((el) =>
            el.getAttribute("data-testid"),
          ).length === 2,
        { timeout: 5000 },
      );
      const orderedIds = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid="req-list"] .req-row')).map((el) =>
          el.getAttribute("data-testid"),
        ),
      );
      expect(orderedIds).toEqual(["req-row-REQ-002", "req-row-REQ-001"]);
      expect(
        await page.evaluate(() => document.querySelector('[data-testid="merge-order-rank-REQ-002"]')?.textContent?.trim()),
      ).toBe("#1");
      await clickReady(page, '[data-testid="scope-sandboxes-btn"]');

      // 2. New Requirement modal exposes Worktree sandbox checkbox & stack selector
      await clickReady(page, '[data-testid="new-req-btn"]');
      await page.waitForSelector('[data-testid="new-req-create-sandbox"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="new-req-create-sandbox"]');
      await page.waitForSelector('[data-testid="new-req-stack-select"]', { timeout: 5000 });
      // REQ-015 审查修复：窄屏下分叉基准标签保持单行，下拉框使用剩余空间且不超出行宽。
      await page.setViewport({ width: 390, height: 844 });
      await Bun.sleep(150);
      const narrowStackRow = await page.evaluate(() => {
        const select = document.querySelector('[data-testid="new-req-stack-select"]') as HTMLElement | null;
        const row = select?.parentElement as HTMLElement | null;
        const label = row?.querySelector(".new-req-stack-label") as HTMLElement | null;
        const selectRect = select?.getBoundingClientRect();
        const rowRect = row?.getBoundingClientRect();
        const labelRect = label?.getBoundingClientRect();
        const selectStyle = select ? getComputedStyle(select) : null;
        const labelStyle = label ? getComputedStyle(label) : null;
        return {
          rowOverflow: row ? row.scrollWidth - row.clientWidth : -1,
          selectLeft: selectRect?.left ?? -1,
          selectRight: selectRect?.right ?? -1,
          rowRight: rowRect?.right ?? -1,
          labelRight: labelRect?.right ?? -1,
          labelHeight: labelRect?.height ?? -1,
          selectHeight: selectRect?.height ?? -1,
          labelWhiteSpace: labelStyle?.whiteSpace ?? "",
          labelSingleLine: label ? label.scrollWidth <= label.clientWidth + 1 : false,
          selectMinWidth: selectStyle?.minWidth ?? "",
          selectFlexShrink: selectStyle?.flexShrink ?? "",
        };
      });
      expect(narrowStackRow.rowOverflow).toBeLessThanOrEqual(1);
      expect(narrowStackRow.selectRight).toBeLessThanOrEqual(narrowStackRow.rowRight + 1);
      expect(narrowStackRow.selectLeft).toBeGreaterThanOrEqual(narrowStackRow.labelRight - 1);
      expect(narrowStackRow.labelWhiteSpace).toBe("nowrap");
      expect(narrowStackRow.labelSingleLine).toBe(true);
      expect(narrowStackRow.labelHeight).toBeLessThanOrEqual(29);
      expect(narrowStackRow.selectHeight).toBeLessThanOrEqual(29);
      expect(narrowStackRow.selectMinWidth).toBe("0px");
      expect(narrowStackRow.selectFlexShrink).toBe("1");
      await page.setViewport({ width: 1360, height: 900 });
      await Bun.sleep(150);
      await clickReady(page, '[data-slot="dialog-footer"] [data-slot="button"]:not([data-testid])');

      // 3. Open REQ-002 -> auto_mergeable callout shows one-click auto-merge button + sibling radar -> click sync!
      await clickReady(page, '[data-testid="req-row-REQ-002"]');
      const tabsTop = () => page.evaluate(() => document.querySelector('[data-testid="workspace-tabs"]')?.getBoundingClientRect().top);
      await page.waitForSelector('[data-testid="sandbox-status-btn"]');
      const beforeRadar = await tabsTop();
      await clickReady(page, '[data-testid="sandbox-status-btn"]');
      await page.waitForSelector('[data-testid="sandbox-drift-callout"]', { timeout: 5000 });
      await page.waitForSelector('[data-testid="sibling-conflict-radar"]', { timeout: 5000 });
      expect(await tabsTop()).toBe(beforeRadar);
      await clickReady(page, '[data-testid="sync-sandbox-base-btn"]');
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="sync-sandbox-base-btn"]'),
        { timeout: 15000 },
      );

      // 4. Open done REQ-001 -> reopen modal defaults to preserveApproval (implementing), or click agent-sync-sandbox-btn directly!
      await clickReady(page, '[data-testid="back-home-btn"]');
      await clickReady(page, '[data-action="set-scope"][data-value="all"]');
      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="action-reopen"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="action-reopen"]');
      await page.waitForSelector('[data-testid="reopen-keep-approval-option"]', { timeout: 5000 });
      const keepChecked = await page.evaluate(() => {
        const option = document.querySelector('[data-testid="reopen-keep-approval-option"]');
        const input = option?.querySelector("input") as HTMLInputElement | null;
        const radio = option?.querySelector('[role="radio"]') as HTMLElement | null;
        return Boolean(input?.checked || radio?.getAttribute("aria-checked") === "true");
      });
      expect(keepChecked).toBe(true);
      await clickReady(page, '[data-slot="dialog-footer"] [data-slot="button"]:not([data-testid])');

      // Click "Let Agent sync main & resolve conflicts" directly from `done` stage!
      await clickReady(page, '[data-testid="sandbox-status-btn"]');
      await clickReady(page, '[data-testid="agent-sync-sandbox-btn"]');
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const runs = getRequirement(repo, "REQ-001").state.agentRuns ?? [];
        if (runs.length > 0 && runs[0]!.status !== "running") break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const req1After = getRequirement(repo, "REQ-001").state;
      expect(req1After.stage).toBe("coding");
      expect(req1After.approval).not.toBeNull();
      expect(req1After.lastFeedback).toBeNull();
      expect(dispatched).toEqual([{ action: "fix", reqId: "REQ-001" }]);
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
});
