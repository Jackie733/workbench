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
  updateTasks,
} from "../../src/core/engine.ts";
import { observeGitSnapshot } from "../../src/core/git.ts";
import { runVerification } from "../../src/core/runner.ts";
import { createOrReuseWorktree } from "../../src/hub/evolution.ts";
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
    await updateTasks(repo, "REQ-001", {
      tasks: [{ title: "done", status: "done" }],
      readyForAcceptance: true,
      currentCodeSnapshotHash: snap1.fingerprint,
    });
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
      await clickReady(page, '.modal-actions .btn:not(.primary)');

      // 3. Open REQ-002 -> auto_mergeable callout shows one-click auto-merge button + sibling radar -> click sync!
      await clickReady(page, '[data-testid="req-row-REQ-002"]');
      await page.waitForSelector('[data-testid="sandbox-drift-callout"]', { timeout: 5000 });
      await page.waitForSelector('[data-testid="sibling-conflict-radar"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="sync-sandbox-base-btn"]');
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="sync-sandbox-base-btn"]'),
        { timeout: 5000 },
      );

      // 4. Open done REQ-001 -> reopen modal defaults to preserveApproval (implementing), or click agent-sync-sandbox-btn directly!
      await clickReady(page, '[data-testid="back-home-btn"]');
      await clickReady(page, '[data-action="set-scope"][data-value="all"]');
      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="action-reopen"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="action-reopen"]');
      await page.waitForSelector('[data-testid="reopen-keep-approval-option"]', { timeout: 5000 });
      const keepChecked = await page.evaluate(() => {
        const input = document.querySelector('[data-testid="reopen-keep-approval-option"] input') as HTMLInputElement | null;
        return Boolean(input?.checked);
      });
      expect(keepChecked).toBe(true);
      await clickReady(page, '.modal-actions .btn:not(.primary)');

      // Click "Let Agent sync main & resolve conflicts" directly from `done` stage!
      await clickReady(page, '[data-testid="agent-sync-sandbox-btn"]');
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const runs = getRequirement(repo, "REQ-001").state.agentRuns ?? [];
        if (runs.length > 0 && runs[0]!.status !== "running") break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const req1After = getRequirement(repo, "REQ-001").state;
      expect(req1After.stage).toBe("implementing");
      expect(req1After.approval).not.toBeNull();
      expect(req1After.lastFeedback).toBeNull();
      expect(dispatched).toEqual([{ action: "fix", reqId: "REQ-001" }]);
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);
});
