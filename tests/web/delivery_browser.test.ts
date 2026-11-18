import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  acceptRequirement,
  approveDesign,
  createRequirement,
  initProject,
  propose,
} from "../../src/core/engine.ts";
import { observeGitSnapshot } from "../../src/core/git.ts";
import { runVerification } from "../../src/core/runner.ts";
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

function makeGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-del-web-"));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-del-web-hub-"));
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
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

afterAll(async () => {
  await browser?.close();
});

describe("post-acceptance delivery wrap-up UI", () => {
  test("done requirement prompts for uncommitted changes, preselects accepted files in deliver modal, and commits via Web UI", async () => {
    makeTempHub();
    const repo = makeGitRepo();
    await initProject(repo, { name: "DeliverWebRepo", privacyMode: "local" });

    await createRequirement(repo, {
      goal: "Ship delivery flow",
      criteria: [{ id: "AC-1", description: "passes", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design", actor: "agent" });
    const base = await observeGitSnapshot(repo);
    await approveDesign(repo, "REQ-001", { baseline: base });

    fs.writeFileSync(path.join(repo, "app.ts"), "export const v = 2;\n");
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const accSnap = await observeGitSnapshot(repo);
    await acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: accSnap!.fingerprint });

    // Extra unrelated file added after acceptance
    fs.writeFileSync(path.join(repo, "scratch.ts"), "export const scratch = true;\n");

    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false });
    servers.push(server);

    expect(HAS_BROWSER).toBe(true);
    const page = await browser!.newPage();
    try {
      await page.setViewport({ width: 1360, height: 860 });
      await page.goto(server.url, { waitUntil: "networkidle2" });
      await page.waitForSelector('[data-action="set-scope"][data-value="done"]', { timeout: 5000 });
      await page.click('[data-action="set-scope"][data-value="done"]');
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 5000 });
      await page.click('[data-testid="req-row-REQ-001"]');

      await page.waitForSelector('[data-testid="open-deliver-btn"]', { timeout: 15000 });
      await page.waitForSelector('[data-testid="delivery-pending-hint"]', { timeout: 5000 });

      await page.click('[data-testid="open-deliver-btn"]');
      await page.waitForSelector('[data-testid="deliver-modal"]', { timeout: 5000 });

      const selectionState = await page.evaluate(() => ({
        appChecked: (document.querySelector('[data-testid="deliver-file-app.ts"]') as HTMLInputElement | null)?.checked,
        scratchChecked: (document.querySelector('[data-testid="deliver-file-scratch.ts"]') as HTMLInputElement | null)?.checked,
        modalText: document.querySelector('[data-testid="deliver-modal"]')?.textContent ?? "",
      }));
      expect(selectionState.appChecked).toBe(true);
      expect(selectionState.scratchChecked).toBe(false);
      expect(selectionState.modalText).toContain("本次验收");
      expect(selectionState.modalText).toContain("工作区其他");

      await page.click('[data-testid="submit-deliver-btn"]');
      await page.waitForSelector('[data-testid="delivery-summary-line"]', { timeout: 5000 });

      const summaryText = await page.evaluate(
        () => document.querySelector('[data-testid="delivery-summary-line"]')?.textContent ?? "",
      );
      expect(summaryText).toContain("已交付提交");
      expect(summaryText).toContain("1 个文件");

      // Confirm only app.ts was committed and scratch.ts remains untracked
      const committed = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], {
        cwd: repo,
        encoding: "utf8",
      }).trim();
      expect(committed).toBe("app.ts");
      const status = execFileSync("git", ["status", "--short"], { cwd: repo, encoding: "utf8" }).trim();
      expect(status).toBe("?? scratch.ts");
    } finally {
      await page.close();
    }
  }, { timeout: 30_000 });
});
