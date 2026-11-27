import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  authorizeFastTrack,
  createRequirement,
  initProject,
  recordScreenshotBatch,
  recordVerification,
} from "../../src/core/engine.ts";
import { observeGitSnapshot } from "../../src/core/git.ts";
import {
  attachRequirementScreenshots,
  captureRequirementScreenshots,
  SCREENSHOT_MATRIX,
} from "../../src/core/screenshots.ts";
import { readRequirementBundle } from "../../src/core/store.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";
import type { ScreenshotShot, VerificationRecord } from "../../src/core/types.ts";
import { resolveTestBrowser } from "./browser_env.ts";

const browserEnv = resolveTestBrowser();
const HAS_BROWSER = browserEnv !== null;

interface BrowserPage {
  setViewport(vp: { width: number; height: number }): Promise<void>;
  goto(url: string, opts?: { waitUntil?: string }): Promise<unknown>;
  waitForSelector(sel: string, opts?: { timeout?: number }): Promise<unknown>;
  waitForFunction(fn: (...args: any[]) => unknown, opts?: { timeout?: number }, ...args: any[]): Promise<unknown>;
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
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lw7sNwAAAABJRU5ErkJggg==",
  "base64",
);
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
    process.env.WORKBENCH_CHROME_PATH = browserEnv!.chromePath;
    process.env.WORKBENCH_PUPPETEER_PATH = browserEnv!.puppeteerPath;
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

  test("REQ-018: shows scenario evidence separately from generic inspection, phase badges, lightbox notes and upload flow", async () => {
    process.env.WORKBENCH_CHROME_PATH = browserEnv!.chromePath;
    process.env.WORKBENCH_PUPPETEER_PATH = browserEnv!.puppeteerPath;
    delete process.env.WORKBENCH_RSI_DEPTH;
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-shot-scenario-hub-"));
    tempDirs.push(hubDir);
    process.env.WORKBENCH_HUB_DIR = hubDir;

    const root = initGitRepo();
    await initProject(root);
    const server = await startWorkbenchServer({ root, port: 0 });
    servers.push(server);

    const snapshot = await observeGitSnapshot(root);
    if (!snapshot) throw new Error("missing snapshot");
    const created = await createRequirement(root, {
      goal: "场景截图与通用巡检区分展示",
      criteria: [{ id: "AC-1", description: "命令通过", required: true, command: "echo ok" }],
      track: "fast_track",
      uiRelated: true,
      currentCodeSnapshotHash: snapshot.fingerprint,
    });
    const id = created.state.id;
    await authorizeFastTrack(root, id, { baseline: snapshot, currentCodeSnapshotHash: snapshot.fingerprint });

    const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-shot-scenario-files-"));
    tempDirs.push(filesDir);
    const beforePath = path.join(filesDir, "before.png");
    const afterPath = path.join(filesDir, "after.png");
    fs.writeFileSync(beforePath, PNG_BYTES);
    fs.writeFileSync(afterPath, PNG_BYTES);
    const scenario = await attachRequirementScreenshots(root, id, {
      shots: [
        {
          file: beforePath,
          label: "改动前布局",
          description: "旧的固定导航布局",
          phase: "before",
          criterionIds: ["AC-1"],
        },
        { file: afterPath, label: "改动后结果", description: "新的场景证据展示", phase: "after" },
      ],
    });
    expect(scenario.status).toBe("captured");

    const matrixShot: ScreenshotShot = {
      id: `S-${Date.now()}-matrix1`,
      label: "首页固定巡检",
      urlPath: "/",
      viewport: "1440x900",
      theme: "light",
      path: `screenshots/shot-S-${Date.now()}-matrix1.png`,
      sha256: createHash("sha256").update(PNG_BYTES).digest("hex"),
      sizeBytes: PNG_BYTES.length,
    };
    matrixShot.path = `screenshots/shot-${matrixShot.id}.png`;
    await recordScreenshotBatch(root, id, {
      batch: {
        id: `SB-${Date.now()}-matrix`,
        createdAt: Date.now(),
        trigger: "manual",
        actor: "human",
        specHash: readRequirementBundle(root, id).state.specHash,
        codeSnapshotHash: snapshot.fingerprint,
        status: "captured",
        skipReason: null,
        source: "matrix",
        shots: [matrixShot],
        durationMs: 5,
      },
      files: [{ shotId: matrixShot.id, bytes: PNG_BYTES }],
      currentCodeSnapshotHash: snapshot.fingerprint,
    });

    const page = await browser!.newPage();
    try {
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await page.waitForSelector(`[data-testid="req-card-${id}"]`, { timeout: 5000 });
      await page.click(`[data-testid="req-card-${id}"]`);
      await page.waitForSelector('[data-testid="workspace-detail"]', { timeout: 5000 });
      await page.click('[data-testid="tab-changes"]');
      await page.waitForSelector('[data-testid="screenshot-section"]', { timeout: 5000 });
      await page.waitForSelector(`[data-testid="screenshot-source-badge-${scenario.batch!.id}"]`, {
        timeout: 5000,
      });

      const sourceBadges = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid^="screenshot-source-badge-"]')).map((el) =>
          el.textContent?.trim() ?? "",
        ),
      );
      expect(sourceBadges[0]).toContain("需求场景截图");
      expect(sourceBadges.some((text) => text.includes("通用页面巡检"))).toBe(true);
      const matrixNote = await page.evaluate(
        () =>
          document.querySelector('[data-testid^="screenshot-matrix-note-"]')?.textContent?.trim() ?? "",
      );
      expect(matrixNote).toContain("不代表本次需求改动");

      const phaseBadges = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid^="screenshot-phase-"]')).map((el) =>
          el.textContent?.trim() ?? "",
        ),
      );
      expect(phaseBadges).toContain("改动前");
      expect(phaseBadges).toContain("改动后");

      const firstScenarioShot = scenario.batch!.shots[0]!;
      await page.click(`[data-testid="shot-${firstScenarioShot.id}"]`);
      await page.waitForSelector('[data-testid="screenshot-lightbox"]', { timeout: 5000 });
      const lightboxMeta = await page.evaluate(() => ({
        description:
          document.querySelector('[data-testid="screenshot-lightbox-description"]')?.textContent?.trim() ?? "",
        criteria:
          document.querySelector('[data-testid="screenshot-lightbox-criteria"]')?.textContent?.trim() ?? "",
        source:
          document.querySelector('[data-testid="screenshot-lightbox-source"]')?.textContent?.trim() ?? "",
      }));
      expect(lightboxMeta.description).toContain("旧的固定导航布局");
      expect(lightboxMeta.criteria).toContain("AC-1");
      expect(lightboxMeta.source).toContain("需求场景截图");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector('[data-testid="screenshot-lightbox"]'), {
        timeout: 5000,
      });

      // Local PNG补录 flows through the hidden file input and the attach API.
      const base64 = PNG_BYTES.toString("base64");
      await page.evaluate(
        (encoded: string, name: string) => {
          const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
          const file = new File([bytes], name, { type: "image/png" });
          const transfer = new DataTransfer();
          transfer.items.add(file);
          const input = document.querySelector('[data-testid="screenshot-upload-input"]') as HTMLInputElement | null;
          if (!input) throw new Error("missing screenshot upload input");
          input.files = transfer.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        },
        base64,
        "uploaded-after.png",
      );
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll(".screenshot-thumb-label")).some((el) =>
            (el.textContent ?? "").includes("uploaded-after"),
          ),
        { timeout: 8000 },
      );
      const toastText = await page.evaluate(
        () => document.querySelector('[data-slot="toast-root"]')?.textContent ?? "",
      );
      expect(toastText).toContain("已保存 1 张需求场景截图");
    } finally {
      await page.close();
    }
  }, 120_000);
});
