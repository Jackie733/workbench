import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkbenchError } from "./errors.ts";
import { recordScreenshotBatch } from "./engine.ts";
import { canonicalRoot } from "./fs.ts";
import { observeGitSnapshot } from "./git.ts";
import { resolveCodeRoot } from "./sandbox.ts";
import { readRequirementBundle } from "./store.ts";
import {
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOT_NAV_MS,
  MAX_SCREENSHOT_TOTAL_MS,
  type ScreenshotBatch,
  type ScreenshotBatchStatus,
  type ScreenshotCaptureResult,
  type ScreenshotShot,
  type ScreenshotTrigger,
} from "./types.ts";
import { ensureServerForProject } from "../server/runtime.ts";

export interface ScreenshotMatrixEntry {
  key: string;
  label: string;
  view: "home" | "spec" | "changes";
  viewport: { width: number; height: number };
  theme: "light" | "dark";
  urlPath: string;
}

/** Default evidence matrix: home + requirement tabs across desktops, themes and a narrow viewport. */
export const SCREENSHOT_MATRIX: ScreenshotMatrixEntry[] = [
  {
    key: "home-desktop-light",
    label: "首页需求列表",
    view: "home",
    viewport: { width: 1440, height: 900 },
    theme: "light",
    urlPath: "/",
  },
  {
    key: "home-desktop-dark",
    label: "首页需求列表",
    view: "home",
    viewport: { width: 1440, height: 900 },
    theme: "dark",
    urlPath: "/",
  },
  {
    key: "spec-desktop-light",
    label: "需求详情 · 规范与方案",
    view: "spec",
    viewport: { width: 1440, height: 900 },
    theme: "light",
    urlPath: "/?tab=spec",
  },
  {
    key: "spec-desktop-dark",
    label: "需求详情 · 规范与方案",
    view: "spec",
    viewport: { width: 1440, height: 900 },
    theme: "dark",
    urlPath: "/?tab=spec",
  },
  {
    key: "changes-desktop-light",
    label: "需求详情 · 变更与验证",
    view: "changes",
    viewport: { width: 1440, height: 900 },
    theme: "light",
    urlPath: "/?tab=changes",
  },
  {
    key: "changes-desktop-dark",
    label: "需求详情 · 变更与验证",
    view: "changes",
    viewport: { width: 1440, height: 900 },
    theme: "dark",
    urlPath: "/?tab=changes",
  },
  {
    key: "changes-mobile-light",
    label: "需求详情 · 变更与验证",
    view: "changes",
    viewport: { width: 390, height: 844 },
    theme: "light",
    urlPath: "/?tab=changes",
  },
  {
    key: "home-mobile-light",
    label: "首页需求列表",
    view: "home",
    viewport: { width: 390, height: 844 },
    theme: "light",
    urlPath: "/",
  },
];

export interface ResolvedBrowserEnvironment {
  ok: boolean;
  chromePath: string | null;
  puppeteerPath: string | null;
  reason: string | null;
}

function newestChromiumFromPlaywright(): string | null {
  const cacheDir = path.join(os.homedir(), ".cache", "ms-playwright");
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(cacheDir);
  } catch {
    return null;
  }
  const versions = entries
    .map((entry) => /^chromium(_headless_shell)?-(\d+)$/.exec(entry))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => ({ dir: match[0], version: Number(match[2]), headlessShell: Boolean(match[1]) }))
    .sort((a, b) => b.version - a.version || Number(a.headlessShell) - Number(b.headlessShell));
  for (const candidate of versions) {
    const relatives = candidate.headlessShell
      ? ["chrome-headless-shell-linux64/chrome-headless-shell", "chrome-headless-shell-linux/chrome-headless-shell"]
      : ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"];
    for (const relative of relatives) {
      const full = path.join(cacheDir, candidate.dir, relative);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

function chromiumFromPathEnv(): string | null {
  const pathValue = process.env.PATH ?? "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const bin of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
      const full = path.join(dir, bin);
      try {
        if (fs.existsSync(full)) return full;
      } catch {
        // Ignore unreadable PATH entries.
      }
    }
  }
  return null;
}

function resolvePuppeteerModule(): string | null {
  const explicit = process.env.WORKBENCH_PUPPETEER_PATH?.trim();
  if (explicit) return explicit;
  const globalPath = path.join(
    os.homedir(),
    ".bun",
    "install",
    "global",
    "node_modules",
    "puppeteer-core",
    "lib",
    "puppeteer",
    "puppeteer-core.js",
  );
  if (fs.existsSync(globalPath)) return globalPath;
  try {
    return Bun.resolveSync("puppeteer-core", path.resolve(import.meta.dir, "../.."));
  } catch {
    return null;
  }
}

/** Resolves Chromium and puppeteer-core without adding dependencies; explicit env paths are authoritative. */
export function resolveBrowserEnvironment(): ResolvedBrowserEnvironment {
  const explicitChrome = process.env.WORKBENCH_CHROME_PATH?.trim();
  const chromePath = explicitChrome || newestChromiumFromPlaywright() || chromiumFromPathEnv();
  if (!chromePath) {
    return {
      ok: false,
      chromePath: null,
      puppeteerPath: null,
      reason:
        "未找到 Chromium/Chrome 浏览器，已跳过截图。可安装 Playwright Chromium，或设置 WORKBENCH_CHROME_PATH 指向 Chrome 可执行文件。",
    };
  }
  if (!fs.existsSync(chromePath)) {
    return {
      ok: false,
      chromePath,
      puppeteerPath: null,
      reason: `WORKBENCH_CHROME_PATH 指向的浏览器不存在：${chromePath}`,
    };
  }
  const explicitPuppeteer = process.env.WORKBENCH_PUPPETEER_PATH?.trim();
  if (explicitPuppeteer && !fs.existsSync(explicitPuppeteer)) {
    return {
      ok: false,
      chromePath,
      puppeteerPath: explicitPuppeteer,
      reason: `WORKBENCH_PUPPETEER_PATH 指向的 puppeteer-core 不存在：${explicitPuppeteer}`,
    };
  }
  const puppeteerPath = resolvePuppeteerModule();
  return { ok: true, chromePath, puppeteerPath, reason: null };
}

interface BrowserPageLike {
  setViewport(vp: { width: number; height: number }): Promise<void>;
  setDefaultNavigationTimeout?(timeout: number): void;
  setDefaultTimeout?(timeout: number): void;
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  reload?(opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  waitForSelector(sel: string, opts?: { timeout?: number }): Promise<unknown>;
  click(sel: string): Promise<void>;
  evaluate<T>(fn: (...args: any[]) => T, ...args: any[]): Promise<T>;
  screenshot(opts?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

interface BrowserLike {
  newPage(): Promise<BrowserPageLike>;
  close(): Promise<void>;
}

function toPngBuffer(raw: unknown): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  if (typeof raw === "string") return Buffer.from(raw, "base64");
  throw new Error("截图引擎返回了无法识别的图像数据");
}

function shotId(): string {
  return `S-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function batchId(): string {
  return `SB-${Date.now()}-${randomUUID().slice(0, 6)}`;
}

async function persistSkippedBatch(
  root: string,
  id: string,
  input: {
    trigger: ScreenshotTrigger;
    actor: "agent" | "human" | "system";
    specHash: string;
    codeSnapshotHash: string;
    reason: string;
    startedAt: number;
    currentCodeSnapshotHash: string | null;
  },
): Promise<ScreenshotCaptureResult> {
  const batch: ScreenshotBatch = {
    id: batchId(),
    createdAt: Date.now(),
    trigger: input.trigger,
    actor: input.actor,
    specHash: input.specHash,
    codeSnapshotHash: input.codeSnapshotHash,
    status: "skipped",
    skipReason: input.reason,
    shots: [],
    durationMs: Math.max(0, Date.now() - input.startedAt),
  };
  await recordScreenshotBatch(root, id, {
    batch,
    currentCodeSnapshotHash: input.currentCodeSnapshotHash,
  });
  return { status: "skipped", batchId: batch.id, reason: input.reason, batch };
}

async function applyTheme(page: BrowserPageLike, theme: "light" | "dark", baseUrl: string, timeout: number): Promise<void> {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout });
  await page.evaluate((nextTheme: string) => {
    localStorage.setItem("wb-theme", nextTheme);
    document.documentElement.setAttribute("data-theme", nextTheme);
  }, theme);
}

async function navigateToView(
  page: BrowserPageLike,
  baseUrl: string,
  requirementId: string,
  entry: ScreenshotMatrixEntry,
  timeout: number,
): Promise<void> {
  if (entry.theme === "dark" || entry.theme === "light") {
    await applyTheme(page, entry.theme, baseUrl, timeout);
  }
  await page.goto(baseUrl, { waitUntil: "networkidle0", timeout });
  if (entry.view === "home") {
    await page.waitForSelector('[data-testid="home-view"]', { timeout });
    return;
  }
  await page.waitForSelector(`[data-testid="req-card-${requirementId}"]`, { timeout });
  await page.evaluate((selector: string) => {
    const target = document.querySelector(selector) as HTMLElement | null;
    target?.click();
  }, `[data-testid="req-card-${requirementId}"]`);
  await page.waitForSelector('[data-testid="workspace-detail"]', { timeout });
  if (entry.view === "spec") {
    await page.waitForSelector('[data-testid="tab-spec"]', { timeout });
    await page.evaluate(() => {
      const target = document.querySelector('[data-testid="tab-spec"]') as HTMLElement | null;
      target?.click();
    });
    await page.waitForSelector('[data-testid="tab-spec"].active', { timeout });
    return;
  }
  await page.waitForSelector('[data-testid="tab-changes"]', { timeout });
  await page.evaluate(() => {
    const target = document.querySelector('[data-testid="tab-changes"]') as HTMLElement | null;
    target?.click();
  });
  await page.waitForSelector('[data-testid="tab-changes"].active', { timeout });
  await page.waitForSelector('[data-testid="screenshot-section"]', { timeout });
}

/**
 * Captures the default UI evidence matrix for a requirement. Browser/service failures degrade to a
 * persisted `skipped` batch and never throw unless the requirement stage itself disallows capture.
 */
export async function captureRequirementScreenshots(
  root: string,
  id: string,
  input: {
    trigger: ScreenshotTrigger;
    actor?: "agent" | "human" | "system";
    label?: string;
    currentCodeSnapshotHash?: string | null;
  },
): Promise<ScreenshotCaptureResult> {
  const base = canonicalRoot(root);
  const bundle = readRequirementBundle(base, id);
  const state = bundle.state;
  if (state.stage === "done" || state.stage === "cancelled") {
    throw new WorkbenchError("invalid_transition", `终态需求（${state.stage}）不能采集截图证据`);
  }
  if (state.stage !== "implementing" && state.stage !== "awaiting_acceptance") {
    throw new WorkbenchError(
      "approval_required",
      `当前阶段（${state.stage}）不能采集截图证据；仅实施阶段或待验收阶段允许采集`,
    );
  }

  const startedAt = Date.now();
  const actor = input.actor ?? "agent";
  const codeRoot = resolveCodeRoot(base, id);
  const snapshot = await observeGitSnapshot(codeRoot);
  const codeSnapshotHash = snapshot?.fingerprint ?? state.specHash;
  const currentCodeSnapshotHash = input.currentCodeSnapshotHash ?? snapshot?.fingerprint ?? null;

  const environment = resolveBrowserEnvironment();
  if (!environment.ok) {
    return persistSkippedBatch(base, id, {
      trigger: input.trigger,
      actor,
      specHash: state.specHash,
      codeSnapshotHash,
      reason: environment.reason ?? "浏览器环境不可用",
      startedAt,
      currentCodeSnapshotHash,
    });
  }

  let serverUrl: string;
  let ownedServer: { url: string; stop(): void } | null = null;
  try {
    if (codeRoot !== base) {
      // RSI sandboxes keep code in the worktree while workbench data stays in the main project.
      // Serve the sandbox UI against the main data root so the captured pages show this requirement.
      const { startWorkbenchServer } = await import("../server/index.ts");
      ownedServer = await startWorkbenchServer({
        root: base,
        port: 0,
        hostname: "127.0.0.1",
        webDir: path.join(codeRoot, "src", "web"),
        writeDiscovery: false,
      });
      serverUrl = ownedServer.url;
    } else {
      const server = await ensureServerForProject(codeRoot);
      serverUrl = server.url;
    }
  } catch (error) {
    const reason = `启动或复用本地 Web 服务失败，已跳过截图：${error instanceof Error ? error.message : String(error)}`;
    return persistSkippedBatch(base, id, {
      trigger: input.trigger,
      actor,
      specHash: state.specHash,
      codeSnapshotHash,
      reason,
      startedAt,
      currentCodeSnapshotHash,
    });
  }

  let browser: BrowserLike | null = null;
  let page: BrowserPageLike | null = null;
  const shots: ScreenshotShot[] = [];
  const pngs: Array<{ shotId: string; bytes: Buffer }> = [];
  const skipReasons: string[] = [];

  try {
    const modulePath = environment.puppeteerPath ?? "puppeteer-core";
    const imported = (await import(modulePath)) as {
      default?: { launch(opts: Record<string, unknown>): Promise<BrowserLike> };
      launch?(opts: Record<string, unknown>): Promise<BrowserLike>;
    };
    const puppeteer = imported.default ?? imported;
    if (!puppeteer || typeof puppeteer.launch !== "function") {
      throw new Error("puppeteer-core 模块缺少 launch 接口");
    }
    browser = await puppeteer.launch({
      executablePath: environment.chromePath,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    page = await browser.newPage();
    page.setDefaultNavigationTimeout?.(MAX_SCREENSHOT_NAV_MS);
    page.setDefaultTimeout?.(MAX_SCREENSHOT_NAV_MS);

    for (const entry of SCREENSHOT_MATRIX) {
      if (Date.now() - startedAt > MAX_SCREENSHOT_TOTAL_MS) {
        skipReasons.push(`采集总时长超过 ${MAX_SCREENSHOT_TOTAL_MS / 1000}s，剩余页面已跳过`);
        break;
      }
      try {
        await page.setViewport(entry.viewport);
        await navigateToView(page, serverUrl, id, entry, MAX_SCREENSHOT_NAV_MS);
        const raw = await page.screenshot({ type: "png" });
        const bytes = toPngBuffer(raw);
        if (bytes.length > MAX_SCREENSHOT_BYTES) {
          skipReasons.push(`${entry.label}（${entry.viewport.width}x${entry.viewport.height}/${entry.theme}）超过单张 2MB 上限`);
          continue;
        }
        const sid = shotId();
        const viewport = `${entry.viewport.width}x${entry.viewport.height}`;
        shots.push({
          id: sid,
          label: input.label ? `${input.label} · ${entry.label}` : entry.label,
          urlPath: entry.urlPath,
          viewport,
          theme: entry.theme,
          path: `screenshots/shot-${sid}.png`,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          sizeBytes: bytes.length,
        });
        pngs.push({ shotId: sid, bytes });
      } catch (error) {
        skipReasons.push(
          `${entry.label}（${entry.viewport.width}x${entry.viewport.height}/${entry.theme}）采集失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  } catch (error) {
    skipReasons.push(
      `启动无头浏览器失败，已跳过截图：${error instanceof Error ? error.message : String(error)}。可安装 Playwright Chromium 或设置 WORKBENCH_CHROME_PATH。`,
    );
  } finally {
    try {
      if (page) await page.close();
    } catch {
      // Ignore page close errors.
    }
    try {
      if (browser) await browser.close();
    } catch {
      // Ignore browser close errors.
    }
    try {
      ownedServer?.stop();
    } catch {
      // Ignore temporary server shutdown errors.
    }
  }

  if (shots.length === 0) {
    const reason = skipReasons.join("；") || "未采集到任何截图";
    return persistSkippedBatch(base, id, {
      trigger: input.trigger,
      actor,
      specHash: state.specHash,
      codeSnapshotHash,
      reason,
      startedAt,
      currentCodeSnapshotHash,
    });
  }

  const status: ScreenshotBatchStatus = skipReasons.length > 0 ? "partial" : "captured";
  const reason = skipReasons.length > 0 ? skipReasons.join("；") : null;
  const batch: ScreenshotBatch = {
    id: batchId(),
    createdAt: Date.now(),
    trigger: input.trigger,
    actor,
    specHash: state.specHash,
    codeSnapshotHash,
    status,
    skipReason: reason,
    shots,
    durationMs: Math.max(0, Date.now() - startedAt),
  };
  await recordScreenshotBatch(base, id, {
    batch,
    files: pngs,
    currentCodeSnapshotHash,
  });
  return { status, batchId: batch.id, reason, batch };
}
