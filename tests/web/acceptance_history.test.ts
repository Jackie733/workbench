import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
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
import { atomicWriteJson } from "../../src/core/fs.ts";
import { observeGitSnapshot } from "../../src/core/git.ts";
import { runVerification } from "../../src/core/runner.ts";
import type { RequirementDetail, RequirementDiffView, RequirementState } from "../../src/core/types.ts";
import { executeWorkbenchTool } from "../../src/mcp/tools.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";
import { describeEvidenceContext } from "../../src/web/state.ts";

const CHROME_PATH = "/home/jackie/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome";
const PUPPETEER_PATH = "/home/jackie/.bun/install/global/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js";
const HAS_BROWSER = fs.existsSync(CHROME_PATH) && fs.existsSync(PUPPETEER_PATH);
const CLI_ENTRY = path.resolve(import.meta.dir, "../../src/cli/index.ts");

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

function makeGitRepo(prefix = "wb-web-hist-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "index.ts"), "export const v = 1;\n");
  execFileSync("git", ["add", "index.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function makeTempHub(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-web-hist-hub-"));
  tempDirs.push(dir);
  process.env.WORKBENCH_HUB_DIR = dir;
  return dir;
}

beforeAll(async () => {
  if (!HAS_BROWSER) return;
  const mod = (await import(PUPPETEER_PATH)) as {
    default: { launch(opts: Record<string, unknown>): Promise<BrowserInstance> };
  };
  browser = await mod.default.launch({
    executablePath: CHROME_PATH,
    headless: true,
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

describe("REQ-003 AC-6: Web, API, CLI, and MCP historical evidence agreement", () => {
  test("API, CLI, MCP, and Web UI agree on accepted snapshot, legacy unavailable diff, and separate live comparison", async () => {
    makeTempHub();
    const repo = makeGitRepo();
    await initProject(repo, { name: "WebHistRepo", privacyMode: "local" });

    // REQ-001: accepted with frozen snapshot
    await createRequirement(repo, {
      goal: "Frozen snapshot UI check",
      criteria: [{ id: "AC-1", description: "passes check", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Frozen", actor: "agent" });
    const base1 = await observeGitSnapshot(repo);
    await approveDesign(repo, "REQ-001", { baseline: base1 });
    fs.writeFileSync(path.join(repo, "index.ts"), "export const v = 2;\nexport const acceptedMarker = 'yes';\n");
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const snap1 = await observeGitSnapshot(repo);
    await acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: snap1!.fingerprint });

    // REQ-002: simulate legacy done record (no snapshot artifact)
    await createRequirement(repo, {
      goal: "Legacy unavailable diff check",
      criteria: [{ id: "AC-1", description: "passes check", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-002", { designMarkdown: "# Legacy", actor: "agent" });
    await approveDesign(repo, "REQ-002", { baseline: snap1 });
    await runVerification(repo, "REQ-002", { command: "echo ok", criterionIds: ["AC-1"] });
    const done2 = await acceptRequirement(repo, "REQ-002", { currentCodeSnapshotHash: snap1!.fingerprint });
    const statePath2 = path.join(repo, ".workbench/items/REQ-002/state.json");
    const legacy2: RequirementState = {
      ...done2.state,
      acceptance: {
        acceptedAt: done2.state.acceptance!.acceptedAt,
        specHash: done2.state.acceptance!.specHash,
        codeSnapshotHash: done2.state.acceptance!.codeSnapshotHash,
        verificationIds: done2.state.acceptance!.verificationIds,
      },
    };
    atomicWriteJson(statePath2, legacy2);

    // Mutate workspace AFTER both acceptances
    fs.writeFileSync(path.join(repo, "index.ts"), "export const v = 999;\n");
    execFileSync("git", ["add", "index.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "post-acceptance commit"], { cwd: repo, stdio: "ignore" });
    fs.writeFileSync(path.join(repo, "post_acceptance_dirty.ts"), "export const liveOnly = true;\n");

    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false });
    servers.push(server);

    // 1. HTTP API agrees on accepted context vs legacy-unavailable vs ?live=1
    const apiDetail1 = (await (await fetch(`${server.url}/api/requirements/REQ-001`)).json()) as { detail: RequirementDetail };
    const apiDiff1 = (await (await fetch(`${server.url}/api/requirements/REQ-001/diff`)).json()) as RequirementDiffView;
    const apiLive1 = (await (await fetch(`${server.url}/api/requirements/REQ-001/diff?live=1`)).json()) as RequirementDiffView;
    expect(apiDetail1.detail.validity.evidenceContext).toBe("accepted");
    expect(apiDetail1.detail.validity.coverage.requiredPassed).toBe(1);
    expect(apiDiff1.context).toBe("accepted");
    expect(apiDiff1.observation?.diff).toContain("acceptedMarker");
    expect(apiDiff1.observation?.diff).not.toContain("post_acceptance_dirty.ts");
    expect(apiLive1.context).toBe("live");
    expect(apiLive1.observation?.diff).toContain("post_acceptance_dirty.ts");

    const apiDetail2 = (await (await fetch(`${server.url}/api/requirements/REQ-002`)).json()) as { detail: RequirementDetail };
    const apiDiff2 = (await (await fetch(`${server.url}/api/requirements/REQ-002/diff`)).json()) as RequirementDiffView;
    expect(apiDetail2.detail.validity.evidenceContext).toBe("legacy-unavailable");
    expect(apiDetail2.detail.validity.coverage.requiredPassed).toBe(1);
    expect(apiDiff2.context).toBe("legacy-unavailable");
    expect(apiDiff2.status).toBe("unavailable");
    expect(apiDiff2.observation).toBeNull();

    // 2. MCP wb_get agrees with API
    const mcp1 = (await executeWorkbenchTool(repo, "wb_get", { id: "REQ-001", includeDiff: true })) as {
      evidenceContext: string;
      gitChanges: { context: string; diff: string };
    };
    const mcp2 = (await executeWorkbenchTool(repo, "wb_get", { id: "REQ-002", includeDiff: true })) as {
      evidenceContext: string;
      gitChanges: { context: string; status: string; diff: string };
    };
    expect(mcp1.evidenceContext).toBe("accepted");
    expect(mcp1.gitChanges.context).toBe("accepted");
    expect(mcp1.gitChanges.diff).toContain("acceptedMarker");
    expect(mcp2.evidenceContext).toBe("legacy-unavailable");
    expect(mcp2.gitChanges.status).toBe("unavailable");
    expect(mcp2.gitChanges.diff).toBe("");

    // 3. CLI `wb get --diff` agrees with MCP and API
    const cliOut = spawnSync("bun", ["run", CLI_ENTRY, "--root", repo, "--json", "get", "REQ-001", "--diff"], {
      encoding: "utf8",
      env: process.env,
    });
    expect(cliOut.status).toBe(0);
    const cliJson = JSON.parse(cliOut.stdout) as { evidenceContext: string; gitChanges: { context: string; diff: string } };
    expect(cliJson.evidenceContext).toBe("accepted");
    expect(cliJson.gitChanges.context).toBe("accepted");
    expect(cliJson.gitChanges.diff).toContain("acceptedMarker");

    // 4. Shared Web presentation helper agrees across states
    const webDesc1 = describeEvidenceContext(apiDetail1.detail.validity, apiDiff1);
    expect(webDesc1.isHistorical).toBe(true);
    expect(webDesc1.title).toBe("已固化验收快照");
    expect(webDesc1.acceptedAtText).toBeTruthy();
    expect(webDesc1.scopeNote).toContain("不证明本需求独占");

    const webDesc2 = describeEvidenceContext(apiDetail2.detail.validity, apiDiff2);
    expect(webDesc2.isHistorical).toBe(true);
    expect(webDesc2.unavailableReason).toContain("历史验收记录");

    // 5. Real rendered Chromium browser verification (never skipped when Chromium is present)
    expect(HAS_BROWSER).toBe(true);
    const page = await browser!.newPage();
    try {
      await page.setViewport({ width: 1360, height: 860 });
      await page.goto(server.url, { waitUntil: "networkidle2" });
      await page.waitForSelector('[data-action="set-scope"][data-value="done"]', { timeout: 5000 });
      await page.click('[data-action="set-scope"][data-value="done"]');

      // Open REQ-001 (frozen snapshot)
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 5000 });
      await page.click('[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="evidence-provenance-banner"]', { timeout: 5000 });
      const bannerText1 = await page.evaluate(() => document.querySelector('[data-testid="evidence-provenance-banner"]')?.textContent ?? "");
      expect(bannerText1).toContain("已固化验收快照");
      expect(bannerText1).toContain("验收时间");

      // Switch to Changes & Verify tab -> shows frozen diff and separate live comparison
      await page.click('[data-testid="tab-changes"]');
      await page.waitForSelector('[data-testid="diff-context-badge"]', { timeout: 5000 });
      const diffHtml1 = await page.evaluate(() => document.body.innerText);
      expect(diffHtml1).toContain("acceptedMarker");
      expect(diffHtml1).not.toContain("post_acceptance_dirty.ts");

      await page.click('[data-testid="toggle-live-diff-btn"]');
      await page.waitForSelector('[data-testid="live-diff-comparison-card"]', { timeout: 5000 });
      await page.waitForFunction(
        () => (document.querySelector('[data-testid="live-diff-comparison-card"]')?.textContent ?? "").includes("post_acceptance_dirty.ts"),
        { timeout: 5000 },
      );

      // Open REQ-002 (legacy unavailable diff)
      await page.click('[data-testid="back-home-btn"]');
      await page.waitForSelector('[data-action="set-scope"][data-value="done"]', { timeout: 5000 });
      await page.click('[data-action="set-scope"][data-value="done"]');
      await page.waitForSelector('[data-testid="req-row-REQ-002"]', { timeout: 5000 });
      await page.click('[data-testid="req-row-REQ-002"]');
      await page.waitForSelector('[data-testid="tab-changes"]', { timeout: 5000 });
      await page.click('[data-testid="tab-changes"]');
      await page.waitForSelector('[data-testid="diff-unavailable-notice"]', { timeout: 5000 });
      const unavailText = await page.evaluate(() => document.querySelector('[data-testid="diff-unavailable-notice"]')?.textContent ?? "");
      expect(unavailText).toContain("历史代码差异不可用");
    } finally {
      await page.close();
    }
  }, { timeout: 30_000 });
});
