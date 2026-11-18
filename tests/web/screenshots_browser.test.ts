import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  authorizeFastTrack,
  createRequirement,
  initProject,
  recordVerification,
} from "../../src/core/engine.ts";
import { observeGitSnapshot } from "../../src/core/git.ts";
import { captureRequirementScreenshots, resolveBrowserEnvironment, SCREENSHOT_MATRIX } from "../../src/core/screenshots.ts";
import { readRequirementBundle } from "../../src/core/store.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";
import type { VerificationRecord } from "../../src/core/types.ts";

const browserEnv = resolveBrowserEnvironment();
const HAS_BROWSER = browserEnv.ok;

interface BrowserPage {
  setViewport(vp: { width: number; height: number }): Promise<void>;
  goto(url: string, opts?: { waitUntil?: string }): Promise<unknown>;
  waitForSelector(sel: string, opts?: { timeout?: number }): Promise<unknown>;
  click(sel: string): Promise<void>;
  evaluate<T>(fn: (...args: any[]) => T, ...args: any[]): Promise<T>;
  keyboard: { press(key: string): Promise<void> };
  close(): Promise<void>;
}

interface BrowserInstance {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

const tempDirs: string[] = [];
const servers: WorkbenchServerHandle[] = [];
const origHubDir = process.env.WORKBENCH_HUB_DIR;
const origRsiDepth = process.env.WORKBENCH_RSI_DEPTH;
let browser: BrowserInstance | null = null;

function initGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-shot-browser-"));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "index.ts"), "export const v = 1;\n");
  execFileSync("git", ["add", "index.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function makeVerification(id: string, specHash: string, codeSnapshotHash: string): VerificationRecord {
  const now = Date.now();
  return {
    id,
    command: "echo ok",
    cwd: ".",
    criterionIds: ["AC-1"],
    specHash,
    codeSnapshotHash,
    exitCode: 0,
    timedOut: false,
    durationMs: 10,
    startedAt: now - 10,
    endedAt: now,
    passed: true,
    outputPath: `evidence/verify-${id}.log`,
    outputPreview: "ok",
    truncated: false,
  };
}

beforeAll(async () => {
  if (!HAS_BROWSER) return;
  const mod = (await import(browserEnv.puppeteerPath!)) as {
    default: { launch(opts: Record<string, unknown>): Promise<BrowserInstance> };
  };
  browser = await mod.default.launch({
    executablePath: browserEnv.chromePath!,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
}, 15_000);

afterEach(() => {
  while (servers.length > 0) servers.pop()!.stop();
  if (origHubDir === undefined) delete process.env.WORKBENCH_HUB_DIR;
  else process.env.WORKBENCH_HUB_DIR = origHubDir;
  if (origRsiDepth === undefined) delete process.env.WORKBENCH_RSI_DEPTH;
  else process.env.WORKBENCH_RSI_DEPTH = origRsiDepth;
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

afterAll(async () => {
  if (browser) {
    await Promise.race([browser.close(), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
}, 15_000);

const suite = HAS_BROWSER ? describe : describe.skip;

suite("REQ-011 real browser screenshot evidence", () => {
  test("AC-6: captures the default matrix, persists PNGs and shows thumbnails plus lightbox", async () => {
    process.env.WORKBENCH_CHROME_PATH = browserEnv.chromePath!;
    process.env.WORKBENCH_PUPPETEER_PATH = browserEnv.puppeteerPath!;
    delete process.env.WORKBENCH_RSI_DEPTH;
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-shot-browser-hub-"));
    tempDirs.push(hubDir);
    process.env.WORKBENCH_HUB_DIR = hubDir;

    const root = initGitRepo();
    await initProject(root);
    const server = await startWorkbenchServer({ root, port: 0 });
    servers.push(server);

    const snapshot = await observeGitSnapshot(root);
    if (!snapshot) throw new Error("missing snapshot");
    const created = await createRequirement(root, {
      goal: "真实浏览器截图矩阵测试",
      criteria: [{ id: "AC-1", description: "命令通过", required: true, command: "echo ok" }],
      track: "fast_track",
      uiRelated: true,
      currentCodeSnapshotHash: snapshot.fingerprint,
    });
    const id = created.state.id;
    await authorizeFastTrack(root, id, { baseline: snapshot, currentCodeSnapshotHash: snapshot.fingerprint });
    await recordVerification(root, id, {
      record: makeVerification("V-1", created.state.specHash, snapshot.fingerprint),
      rawLog: "ok",
      currentCodeSnapshotHash: snapshot.fingerprint,
    });

    const capture = await captureRequirementScreenshots(root, id, {
      trigger: "manual",
      actor: "human",
      label: "验收截图",
      currentCodeSnapshotHash: snapshot.fingerprint,
    });
    expect(capture.status).toBe("captured");
    expect(capture.batch?.shots).toHaveLength(SCREENSHOT_MATRIX.length);

    const itemDir = path.join(root, ".workbench", "items", id);
    for (const shot of capture.batch!.shots) {
      const filePath = path.join(itemDir, shot.path);
      expect(fs.existsSync(filePath)).toBe(true);
      const bytes = fs.readFileSync(filePath);
      expect(bytes.length).toBe(shot.sizeBytes);
      expect(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    }
    expect(readRequirementBundle(root, id).state.screenshotBatches).toHaveLength(1);

    const page = await browser!.newPage();
    try {
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await page.waitForSelector(`[data-testid="req-card-${id}"]`, { timeout: 5000 });
      await page.click(`[data-testid="req-card-${id}"]`);
      await page.waitForSelector('[data-testid="workspace-detail"]', { timeout: 5000 });
      await page.click('[data-testid="tab-changes"]');
      await page.waitForSelector('[data-testid="screenshot-section"]', { timeout: 5000 });
      const firstShot = capture.batch!.shots[0]!;
      await page.waitForSelector(`[data-testid="shot-${firstShot.id}"]`, { timeout: 5000 });
      const fingerprintBadge = await page.evaluate(
        () => document.querySelector('[data-testid="screenshot-fingerprint-badge"]')?.textContent?.trim() ?? "",
      );
      expect(fingerprintBadge).toContain("与当前代码一致");

      await page.click(`[data-testid="shot-${firstShot.id}"]`);
      await page.waitForSelector('[data-testid="screenshot-lightbox"]', { timeout: 5000 });
      const imageLoaded = await page.evaluate(
        () => ((document.querySelector('[data-testid="screenshot-lightbox-image"]') as HTMLImageElement | null)?.naturalWidth ?? 0) > 0,
      );
      expect(imageLoaded).toBe(true);
      await page.keyboard.press("ArrowRight");
      await page.waitForSelector('[data-testid="screenshot-lightbox-next"]', { timeout: 5000 });
      await page.keyboard.press("Escape");
    } finally {
      await page.close();
    }
  }, 120_000);
});
