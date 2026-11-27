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
  MAX_SCREENSHOTS_PER_BATCH,
  WORKBENCH_DIR,
  type ScreenshotBatch,
  type ScreenshotBatchStatus,
  type ScreenshotCaptureResult,
  type ScreenshotPhase,
  type ScreenshotShot,
  type ScreenshotSkipReasonCode,
  type ScreenshotTrigger,
} from "./types.ts";
import { assertRequirementId, isSafeText } from "./validate.ts";
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
  reasonCode?: ScreenshotSkipReasonCode | null;
  reasonParams?: Record<string, string>;
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
      reasonCode: "browser_missing",
    };
  }
  if (!fs.existsSync(chromePath)) {
    return {
      ok: false,
      chromePath,
      puppeteerPath: null,
      reason: `WORKBENCH_CHROME_PATH 指向的浏览器不存在：${chromePath}`,
      reasonCode: "chrome_path_missing",
      reasonParams: { path: chromePath },
    };
  }
  const explicitPuppeteer = process.env.WORKBENCH_PUPPETEER_PATH?.trim();
  if (explicitPuppeteer && !fs.existsSync(explicitPuppeteer)) {
    return {
      ok: false,
      chromePath,
      puppeteerPath: explicitPuppeteer,
      reason: `WORKBENCH_PUPPETEER_PATH 指向的 puppeteer-core 不存在：${explicitPuppeteer}`,
      reasonCode: "puppeteer_path_missing",
      reasonParams: { path: explicitPuppeteer },
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

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Returns true for repositories that are not Workbench itself (e.g. external business frontends). */
export function isExternalNonWorkbenchRepo(codeRoot: string): boolean {
  const pkgPath = path.join(codeRoot, "package.json");
  try {
    const stat = fs.lstatSync(pkgPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.trim().length > 0 && parsed.name.trim() !== "workbench";
  } catch {
    return false;
  }
}

/** The generic 8-shot matrix only makes sense for Workbench's own UI. */
export function isWorkbenchOwnRepo(codeRoot: string): boolean {
  return !isExternalNonWorkbenchRepo(codeRoot);
}

/** Gitignored staging directory where browser tests may drop scenario screenshots. */
export function screenshotStagingDir(root: string, id: string): string {
  const base = canonicalRoot(root);
  assertRequirementId(id);
  return path.join(base, WORKBENCH_DIR, "tmp", "screenshots", id);
}

export interface ScreenshotAttachShotInput {
  /** PNG file path; resolved against the current working directory, then the code root. */
  file?: string;
  bytes?: Buffer | Uint8Array;
  /** Base64 payload for HTTP/Web uploads; data URLs are accepted. */
  dataBase64?: string;
  /** Alias for dataBase64 accepted by HTTP/MCP clients. */
  base64?: string;
  label: string;
  description?: string;
  phase?: ScreenshotPhase;
  viewport?: string;
  theme?: "light" | "dark";
  urlPath?: string;
  /** Alias for urlPath. */
  url?: string;
  criterionIds?: string[];
  /** Alias for criterionIds. */
  criteria?: string[];
}

export interface AttachRequirementScreenshotsInput {
  shots: ScreenshotAttachShotInput[];
  trigger?: ScreenshotTrigger;
  actor?: "agent" | "human" | "system";
  currentCodeSnapshotHash?: string | null;
}

function parsePngDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_MAGIC) || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new WorkbenchError("invalid_input", "截图必须是合法的 PNG 文件（缺少 PNG 文件头或 IHDR 块）");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 99999 || height > 99999) {
    throw new WorkbenchError("invalid_input", `截图尺寸无效: ${width}x${height}`);
  }
  return { width, height };
}

function decodeBase64Screenshot(raw: string): Buffer {
  const payload = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
  if (!payload.trim() || !/^[A-Za-z0-9+/=\s]+$/.test(payload)) {
    throw new WorkbenchError("invalid_input", "截图 base64 内容无效");
  }
  return Buffer.from(payload, "base64");
}

function resolveScreenshotFilePath(raw: string, codeRoot: string): string {
  const candidates = path.isAbsolute(raw)
    ? [raw]
    : [path.resolve(process.cwd(), raw), path.resolve(codeRoot, raw)];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      throw new WorkbenchError("invalid_input", `截图文件不允许使用符号链接: ${raw}`);
    }
    if (!stat.isFile()) {
      throw new WorkbenchError("invalid_input", `截图路径必须是普通文件: ${raw}`);
    }
    if (stat.size > MAX_SCREENSHOT_BYTES) {
      throw new WorkbenchError("invalid_input", `截图文件超过单张 2MB 上限: ${raw}`);
    }
    return candidate;
  }
  throw new WorkbenchError("invalid_input", `截图文件不存在: ${raw}`);
}

function readAttachShotBytes(input: ScreenshotAttachShotInput, codeRoot: string): Buffer {
  let bytes: Buffer;
  if (input.bytes !== undefined) {
    bytes = Buffer.from(input.bytes);
  } else if (typeof input.dataBase64 === "string") {
    bytes = decodeBase64Screenshot(input.dataBase64);
  } else if (typeof input.base64 === "string") {
    bytes = decodeBase64Screenshot(input.base64);
  } else if (typeof input.file === "string" && input.file.trim()) {
    bytes = fs.readFileSync(resolveScreenshotFilePath(input.file.trim(), codeRoot));
  } else {
    throw new WorkbenchError("invalid_input", "每张截图必须提供 file、bytes 或 dataBase64 之一");
  }
  if (bytes.length === 0) {
    throw new WorkbenchError("invalid_input", "截图文件不能为空");
  }
  if (bytes.length > MAX_SCREENSHOT_BYTES) {
    throw new WorkbenchError("invalid_input", "截图超出单张 2MB 上限");
  }
  parsePngDimensions(bytes);
  return bytes;
}

function normalizeAttachShot(
  input: ScreenshotAttachShotInput,
  bytes: Buffer,
): Omit<ScreenshotShot, "id" | "path" | "sha256" | "sizeBytes"> {
  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (!label || !isSafeText(label, 300)) {
    throw new WorkbenchError("invalid_input", "每张截图都必须提供合法的场景标题 label（≤300 字节）");
  }
  if (input.description !== undefined && typeof input.description !== "string") {
    throw new WorkbenchError("invalid_input", "截图场景说明必须是字符串");
  }
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (description && (!isSafeText(description, 2000, true) || Array.from(description).length > 500)) {
    throw new WorkbenchError("invalid_input", "截图场景说明不能超过 500 字符或包含非法控制字符");
  }
  if (input.phase !== undefined && !["before", "after", "state"].includes(input.phase)) {
    throw new WorkbenchError("invalid_input", `无效的截图阶段: ${String(input.phase)}`);
  }
  if (input.theme !== undefined && input.theme !== "light" && input.theme !== "dark") {
    throw new WorkbenchError("invalid_input", `无效的截图主题: ${String(input.theme)}`);
  }
  if (input.viewport !== undefined && typeof input.viewport !== "string") {
    throw new WorkbenchError("invalid_input", "截图视口必须是 WxH 格式字符串");
  }
  if (input.urlPath !== undefined && typeof input.urlPath !== "string") {
    throw new WorkbenchError("invalid_input", "截图来源路径必须是字符串");
  }
  if (input.url !== undefined && typeof input.url !== "string") {
    throw new WorkbenchError("invalid_input", "截图来源路径别名 url 必须是字符串");
  }
  const dimensions = parsePngDimensions(bytes);
  const derivedViewport = `${dimensions.width}x${dimensions.height}`;
  const viewport = typeof input.viewport === "string" && input.viewport.trim()
    ? input.viewport.trim()
    : derivedViewport;
  if (!/^\d{1,5}x\d{1,5}$/.test(viewport)) {
    throw new WorkbenchError("invalid_input", `无效的截图视口: ${viewport}（应为 WxH）`);
  }
  const urlPath =
    typeof input.urlPath === "string" && input.urlPath.trim()
      ? input.urlPath.trim()
      : typeof input.url === "string" && input.url.trim()
        ? input.url.trim()
        : "/";
  if (!isSafeText(urlPath, 4096)) {
    throw new WorkbenchError("invalid_input", "截图来源路径无效或超过 4096 字节");
  }
  const normalizeCriterionIds = (value: unknown, field: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new WorkbenchError("invalid_input", `截图关联的验收条件 ID 必须是字符串数组（${field}）`);
    }
    return value.map((item) => item.trim()).filter(Boolean);
  };
  const criterionIds = Array.from(
    new Set([
      ...normalizeCriterionIds(input.criterionIds, "criterionIds"),
      ...normalizeCriterionIds(input.criteria, "criteria"),
    ]),
  );
  if (criterionIds.some((value) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value))) {
    throw new WorkbenchError("invalid_input", "截图关联的验收条件 ID 无效");
  }
  return {
    label,
    urlPath,
    viewport,
    theme: input.theme ?? "light",
    ...(description ? { description } : {}),
    ...(input.phase ? { phase: input.phase } : {}),
    ...(criterionIds.length > 0 ? { criterionIds } : {}),
  };
}

/**
 * Registers requirement-specific scenario screenshots (CLI / MCP / HTTP / staged test output).
 * Unlike the generic matrix this works for any repository and never fills evidence with unrelated pages.
 */
export async function attachRequirementScreenshots(
  root: string,
  id: string,
  input: AttachRequirementScreenshotsInput,
): Promise<ScreenshotCaptureResult> {
  const base = canonicalRoot(root);
  const bundle = readRequirementBundle(base, id);
  const state = bundle.state;
  if (state.stage === "done" || state.stage === "cancelled") {
    throw new WorkbenchError("invalid_transition", `终态需求（${state.stage}）不能提交截图证据`);
  }
  if (state.stage !== "coding") {
    throw new WorkbenchError(
      "approval_required",
      `当前阶段（${state.stage}）不能提交截图证据；仅编码阶段允许提交场景截图`,
    );
  }
  if (!Array.isArray(input.shots) || input.shots.length === 0) {
    throw new WorkbenchError("invalid_input", "请至少提供一张场景截图");
  }
  if (input.shots.length > MAX_SCREENSHOTS_PER_BATCH) {
    throw new WorkbenchError("invalid_input", `单批截图不能超过 ${MAX_SCREENSHOTS_PER_BATCH} 张`);
  }

  const startedAt = Date.now();
  const codeRoot = resolveCodeRoot(base, id);
  const snapshot = await observeGitSnapshot(codeRoot);
  const codeSnapshotHash = snapshot?.fingerprint ?? state.specHash;
  const currentCodeSnapshotHash = input.currentCodeSnapshotHash ?? snapshot?.fingerprint ?? null;

  const shots: ScreenshotShot[] = [];
  const files: Array<{ shotId: string; bytes: Buffer }> = [];
  for (const item of input.shots) {
    const bytes = readAttachShotBytes(item, codeRoot);
    const meta = normalizeAttachShot(item, bytes);
    const sid = shotId();
    shots.push({
      id: sid,
      ...meta,
      path: `screenshots/shot-${sid}.png`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
    });
    files.push({ shotId: sid, bytes });
  }

  const batch: ScreenshotBatch = {
    id: batchId(),
    createdAt: Date.now(),
    trigger: input.trigger ?? "agent_attach",
    actor: input.actor ?? "agent",
    specHash: state.specHash,
    codeSnapshotHash,
    status: "captured",
    skipReason: null,
    source: "scenario",
    shots,
    durationMs: Math.max(0, Date.now() - startedAt),
  };
  await recordScreenshotBatch(base, id, { batch, files, currentCodeSnapshotHash });
  return { status: "captured", batchId: batch.id, reason: null, batch };
}

export interface StagedScreenshotCollection {
  attached: boolean;
  count: number;
  batch: ScreenshotBatch | null;
  result: ScreenshotCaptureResult | null;
  reason: string | null;
}

type StagedManifestEntry = Record<string, unknown>;

function resolveStagedFile(stagingDir: string, rawFile: string): string {
  const resolved = path.resolve(stagingDir, rawFile);
  const relative = path.relative(stagingDir, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new WorkbenchError("invalid_input", `截图清单引用了 staging 目录之外的文件: ${rawFile}`);
  }
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new WorkbenchError("invalid_input", `截图清单文件必须是普通文件: ${rawFile}`);
  }
  // Lexical containment is not enough: a symlinked subdirectory can point outside the staging root.
  // Resolve both sides before reading/deleting so the collected file always lives inside staging.
  let realStaging: string;
  let realResolved: string;
  try {
    realStaging = fs.realpathSync(stagingDir);
    realResolved = fs.realpathSync(resolved);
  } catch {
    throw new WorkbenchError("invalid_input", `截图清单文件不存在或无法访问: ${rawFile}`);
  }
  const realRelative = path.relative(realStaging, realResolved);
  if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new WorkbenchError("invalid_input", `截图清单引用了 staging 目录之外的文件: ${rawFile}`);
  }
  return resolved;
}

function stagedShotFromEntry(stagingDir: string, entry: StagedManifestEntry): ScreenshotAttachShotInput {
  const file = typeof entry.file === "string" ? entry.file : "";
  if (!file.trim()) {
    throw new WorkbenchError("invalid_input", "截图清单每项必须包含 file 路径");
  }
  if (entry.label !== undefined && typeof entry.label !== "string") {
    throw new WorkbenchError("invalid_input", "截图清单每项的 label 必须是字符串");
  }
  const label =
    typeof entry.label === "string" && entry.label.trim()
      ? entry.label.trim()
      : path.basename(file).replace(/\.png$/i, "");
  return {
    file: resolveStagedFile(stagingDir, file),
    label,
    // Pass explicitly supplied metadata through unchanged so the shared validator rejects invalid
    // values instead of silently dropping them and falling back to defaults.
    ...(entry.description !== undefined ? { description: entry.description as string } : {}),
    ...(entry.phase !== undefined ? { phase: entry.phase as ScreenshotPhase } : {}),
    ...(entry.viewport !== undefined ? { viewport: entry.viewport as string } : {}),
    ...(entry.theme !== undefined ? { theme: entry.theme as "light" | "dark" } : {}),
    ...(entry.urlPath !== undefined
      ? { urlPath: entry.urlPath as string }
      : entry.url !== undefined
        ? { url: entry.url as string }
        : {}),
    ...(entry.criterionIds !== undefined
      ? { criterionIds: entry.criterionIds as string[] }
      : entry.criteria !== undefined
        ? { criteria: entry.criteria as string[] }
        : {}),
  };
}

/**
 * Collects scenario screenshots staged by browser tests. A `manifest.json` may describe labels and
 * phases; otherwise every top-level PNG becomes one shot. Staging lives under gitignored .workbench/.
 */
export async function collectStagedScreenshots(
  root: string,
  id: string,
  options: { stagingDir?: string; currentCodeSnapshotHash?: string | null } = {},
): Promise<StagedScreenshotCollection> {
  const base = canonicalRoot(root);
  const stagingDir = options.stagingDir ?? screenshotStagingDir(base, id);
  let entries: fs.Dirent[];
  try {
    const stagingStat = fs.lstatSync(stagingDir);
    if (stagingStat.isSymbolicLink() || !stagingStat.isDirectory()) {
      throw new WorkbenchError("invalid_input", "截图 staging 路径必须是普通目录");
    }
    entries = fs.readdirSync(stagingDir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof WorkbenchError) throw error;
    return { attached: false, count: 0, batch: null, result: null, reason: null };
  }
  const consumed: string[] = [];
  const manifestEntry = entries.find((entry) => entry.isFile() && entry.name === "manifest.json");
  let shots: ScreenshotAttachShotInput[] = [];
  if (manifestEntry) {
    const manifestPath = path.join(stagingDir, manifestEntry.name);
    const stat = fs.lstatSync(manifestPath);
    if (stat.isSymbolicLink() || stat.size > 512 * 1024) {
      throw new WorkbenchError("invalid_input", "截图清单无效或超过 512KB");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      throw new WorkbenchError("invalid_input", "截图清单不是合法的 JSON");
    }
    const rawEntries = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { shots?: unknown }).shots)
        ? (parsed as { shots: unknown[] }).shots
        : null;
    if (!rawEntries) {
      throw new WorkbenchError("invalid_input", "截图清单必须是数组或包含 shots 数组的对象");
    }
    shots = rawEntries.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new WorkbenchError("invalid_input", "截图清单每项必须是对象");
      }
      return stagedShotFromEntry(stagingDir, entry as StagedManifestEntry);
    });
    consumed.push(manifestPath);
  } else {
    const pngs = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png"))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    shots = pngs.map((name) => ({
      file: path.join(stagingDir, name),
      label: name.replace(/\.png$/i, ""),
    }));
  }
  if (shots.length === 0) {
    return { attached: false, count: 0, batch: null, result: null, reason: null };
  }
  for (const shot of shots) {
    if (shot.file) consumed.push(path.resolve(shot.file));
  }
  const result = await attachRequirementScreenshots(base, id, {
    shots,
    trigger: "auto_collect",
    actor: "system",
    ...(options.currentCodeSnapshotHash !== undefined
      ? { currentCodeSnapshotHash: options.currentCodeSnapshotHash }
      : {}),
  });
  for (const file of new Set(consumed)) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // Cleanup is best-effort; metadata is already authoritative.
    }
  }
  try {
    if (fs.readdirSync(stagingDir).length === 0) fs.rmdirSync(stagingDir);
  } catch {
    // Leave a non-empty or concurrently reused staging directory untouched.
  }
  return {
    attached: true,
    count: result.batch?.shots.length ?? 0,
    batch: result.batch,
    result,
    reason: null,
  };
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
    reasonCode?: ScreenshotSkipReasonCode | null;
    reasonParams?: Record<string, string>;
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
    reasonCode: input.reasonCode ?? null,
    source: "matrix",
    shots: [],
    durationMs: Math.max(0, Date.now() - input.startedAt),
  };
  await recordScreenshotBatch(root, id, {
    batch,
    currentCodeSnapshotHash: input.currentCodeSnapshotHash,
  });
  return {
    status: "skipped",
    batchId: batch.id,
    reason: input.reason,
    reasonCode: input.reasonCode ?? null,
    reasonParams: input.reasonParams ?? null,
    batch,
  };
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
    await page.waitForSelector('[data-testid="tab-spec"]:is([aria-selected="true"], [data-active], .active)', { timeout });
    return;
  }
  await page.waitForSelector('[data-testid="tab-changes"]', { timeout });
  await page.evaluate(() => {
    const target = document.querySelector('[data-testid="tab-changes"]') as HTMLElement | null;
    target?.click();
  });
  await page.waitForSelector('[data-testid="tab-changes"]:is([aria-selected="true"], [data-active], .active)', { timeout });
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
  if (state.stage !== "coding") {
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

  if (isExternalNonWorkbenchRepo(codeRoot)) {
    return persistSkippedBatch(base, id, {
      trigger: input.trigger,
      actor,
      specHash: state.specHash,
      codeSnapshotHash,
      reason: "内置自动截图仅适用于 Workbench 自身界面；外部业务项目请直接通过附件上传或粘贴截图作为验收证据。",
      reasonCode: "no_shots",
      startedAt,
      currentCodeSnapshotHash,
    });
  }

  const environment = resolveBrowserEnvironment();
  if (!environment.ok) {
    return persistSkippedBatch(base, id, {
      trigger: input.trigger,
      actor,
      specHash: state.specHash,
      codeSnapshotHash,
      reason: environment.reason ?? "浏览器环境不可用",
      reasonCode: environment.reasonCode ?? null,
      reasonParams: environment.reasonParams,
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
      reasonCode: "server_unavailable",
      startedAt,
      currentCodeSnapshotHash,
    });
  }

  let browser: BrowserLike | null = null;
  let page: BrowserPageLike | null = null;
  const shots: ScreenshotShot[] = [];
  const pngs: Array<{ shotId: string; bytes: Buffer }> = [];
  const skipReasons: string[] = [];
  let fatalSkipCode: ScreenshotSkipReasonCode | null = null;

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
    fatalSkipCode = "browser_launch_failed";
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
      reasonCode: fatalSkipCode ?? "no_shots",
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
    source: "matrix",
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
