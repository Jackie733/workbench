import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  attachmentFileName,
  claimAttachments,
  formatAttachmentSize,
  normalizeAttachments,
  painPointAttachmentsDir,
} from "../core/attachments.ts";
import {
  createRequirement,
  getProjectStatus,
  getRequirement,
  initProject,
  linkRequirementGitHubIssue,
  recordRequirementGitHubSync,
  syncRequirementBaseline,
} from "../core/engine.ts";
import { extractMessageRef, WorkbenchError, type StructuredMessageRef } from "../core/errors.ts";
import { atomicWriteBuffer, atomicWriteFile, canonicalRoot, readBoundedText, resolveSafePath, withFileLockSync } from "../core/fs.ts";
import { fetchAndFastForwardBranch, observeGitSnapshot } from "../core/git.ts";
import {
  buildGitHubReasonMessageDetails,
  buildRequirementIssueBody,
  createGitHubIssue,
  inspectGitHubEnvironment,
  viewGitHubPr,
  type GitHubCommandDeps,
} from "../core/github.ts";
import {
  getSandboxForRequirement,
  readSandboxes,
  sandboxKey,
  withSandboxLockSync,
  writeSandboxes,
  type SandboxRecord,
} from "../core/sandbox.ts";
import { isProjectInitialized, readRequirementBundle } from "../core/store.ts";
import {
  MAX_EVIDENCE_BYTES,
  WORKBENCH_DIR,
  type AgentRunRecord,
  type AttachmentMeta,
  type CriterionInput,
  type RequirementDetail,
} from "../core/types.ts";
import { assertRequirementId, sanitizeOutput } from "../core/validate.ts";
import { isLocalNodeId, readHubConfig, registerHubProject, resolveHubDir } from "./registry.ts";

export const PAIN_POINT_SOURCES = [
  "ui_quick_report",
  "ui_error",
  "agent_friction",
  "post_run_dead_end",
  "cli_issue",
] as const;
export type PainPointSource = (typeof PAIN_POINT_SOURCES)[number];

export const PAIN_POINT_CATEGORIES = [
  "ui_anomaly",
  "cli_ergonomics",
  "harness_bug",
  "feature_gap",
] as const;
export type PainPointCategory = (typeof PAIN_POINT_CATEGORIES)[number];

export interface PainPointContext {
  nodeId?: string;
  projectRoot?: string;
  requirementId?: string;
  runId?: string;
  component?: string;
  domSelector?: string;
  viewport?: string;
  theme?: string;
  urlPath?: string;
}

export interface PainPointReportInput {
  source: PainPointSource;
  category: PainPointCategory;
  title: string;
  detail?: string;
  context?: PainPointContext;
  /** 暂存区附件 ID；认领到该痛点的 hub 附件目录。 */
  attachmentIds?: string[];
}

export interface EvolutionPainPoint {
  id: string;
  fingerprint: string;
  source: PainPointSource;
  category: PainPointCategory;
  title: string;
  detail: string;
  context: PainPointContext;
  occurrences: number;
  status: "open" | "promoted" | "dismissed";
  promotedReqId?: string;
  /** 可选附件元数据；二进制落盘于 hub 附件目录，JSONL 只存引用。 */
  attachments?: AttachmentMeta[];
  createdAt: number;
  updatedAt: number;
}

const MAX_INBOX_ENTRIES = 300;
const MAX_INBOX_BYTES = 2 * 1024 * 1024;

export function inboxFilePath(): string {
  return path.join(resolveHubDir(), "evolution", "inbox.jsonl");
}

function inboxLockPath(): string {
  return path.join(resolveHubDir(), "evolution", ".inbox.lock");
}

function worktreesBaseDir(): string {
  return path.join(resolveHubDir(), "evolution", "worktrees");
}

function normalizeComponentKey(context?: PainPointContext): string {
  const raw = context?.component ?? context?.domSelector ?? "";
  return raw.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
}

function computePainFingerprint(category: string, title: string, component: string): string {
  const norm = title.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 140);
  return createHash("sha256").update(`${category}::${norm}::${component}`, "utf8").digest("hex").slice(0, 24);
}

function sanitizeContext(ctx?: PainPointContext): PainPointContext {
  if (!ctx) return {};
  const cleanStr = (v: unknown, max: number) =>
    typeof v === "string" && v.trim() ? sanitizeOutput(v.trim(), max).text.trim() : undefined;
  const out: PainPointContext = {};
  const nodeId = cleanStr(ctx.nodeId, 64);
  const projectRoot = cleanStr(ctx.projectRoot, 512);
  const requirementId = cleanStr(ctx.requirementId, 32);
  const runId = cleanStr(ctx.runId, 64);
  const component = cleanStr(ctx.component, 160);
  const domSelector = cleanStr(ctx.domSelector, 240);
  const viewport = cleanStr(ctx.viewport, 64);
  const theme = cleanStr(ctx.theme, 32);
  const urlPath = cleanStr(ctx.urlPath, 240);
  if (nodeId) out.nodeId = nodeId;
  if (projectRoot) out.projectRoot = projectRoot;
  if (requirementId) out.requirementId = requirementId;
  if (runId) out.runId = runId;
  if (component) out.component = component;
  if (domSelector) out.domSelector = domSelector;
  if (viewport) out.viewport = viewport;
  if (theme) out.theme = theme;
  if (urlPath) out.urlPath = urlPath;
  return out;
}

export function readPainPoints(): EvolutionPainPoint[] {
  const filePath = inboxFilePath();
  let raw: string;
  try {
    raw = readBoundedText(filePath, MAX_INBOX_BYTES);
  } catch (error) {
    if (error instanceof WorkbenchError && error.code === "not_found") {
      return [];
    }
    throw error;
  }
  const list: EvolutionPainPoint[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<EvolutionPainPoint>;
      if (parsed && typeof parsed.id === "string" && typeof parsed.title === "string") {
        list.push(parsed as EvolutionPainPoint);
      }
    } catch {
      // Skip malformed line.
    }
  }
  const statusRank: Record<string, number> = { open: 0, promoted: 1, dismissed: 2 };
  return list.sort(
    (a, b) => (statusRank[a.status] ?? 3) - (statusRank[b.status] ?? 3) || b.updatedAt - a.updatedAt,
  );
}

function writePainPoints(list: EvolutionPainPoint[]): void {
  const filePath = inboxFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  // Display order groups by status; retention must stay recency-based so a recent
  // promoted/dismissed entry is never evicted ahead of an older open one.
  const bounded = [...list].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_INBOX_ENTRIES);
  const body = bounded.map((item) => JSON.stringify(item)).join("\n") + (bounded.length > 0 ? "\n" : "");
  atomicWriteFile(filePath, body);
}

export function reportPainPoint(input: PainPointReportInput): EvolutionPainPoint | null {
  if (
    process.env.WORKBENCH_RSI_DEPTH === "1" &&
    input.source !== "ui_quick_report" &&
    input.source !== "cli_issue"
  ) {
    return null;
  }

  const title = sanitizeOutput(input.title, 512).text.trim().replace(/\s+/g, " ").slice(0, 160);
  if (!title) {
    throw new WorkbenchError("invalid_input", "痛点标题不能为空");
  }
  const detail = sanitizeOutput((input.detail ?? "").trim(), 4000).text.trim();
  const context = sanitizeContext(input.context);
  const componentKey = normalizeComponentKey(context);
  const fingerprint = computePainFingerprint(input.category, title, componentKey);

  return withFileLockSync(inboxLockPath(), () => {
    const now = Date.now();
    const list = readPainPoints();

    const existingIdx = list.findIndex((p) => p.fingerprint === fingerprint && p.status === "open");
    if (existingIdx >= 0) {
      const prev = list[existingIdx]!;
      const prevAttachments = normalizeAttachments(prev.attachments) ?? [];
      const added =
        input.attachmentIds && input.attachmentIds.length > 0
          ? claimAttachments(input.attachmentIds, painPointAttachmentsDir(prev.id), prevAttachments)
          : [];
      const mergedAttachments = [...prevAttachments];
      for (const meta of added) {
        if (!mergedAttachments.some((m) => m.id === meta.id)) mergedAttachments.push(meta);
      }
      const mergedDetail =
        detail && !prev.detail.includes(detail.slice(0, 80))
          ? `${prev.detail}${prev.detail ? "\n\n---\n" : ""}${detail}`.slice(0, 4000)
          : prev.detail;
      const updated: EvolutionPainPoint = {
        ...prev,
        occurrences: prev.occurrences + 1,
        detail: mergedDetail,
        context: { ...prev.context, ...context },
        ...(mergedAttachments.length > 0 ? { attachments: mergedAttachments } : {}),
        updatedAt: now,
      };
      list[existingIdx] = updated;
      writePainPoints(list);
      return updated;
    }

    const id = `EVO-${now}-${randomUUID().slice(0, 6)}`;
    const attachments =
      input.attachmentIds && input.attachmentIds.length > 0
        ? claimAttachments(input.attachmentIds, painPointAttachmentsDir(id))
        : [];
    const created: EvolutionPainPoint = {
      id,
      fingerprint,
      source: input.source,
      category: input.category,
      title,
      detail: detail || title,
      context,
      occurrences: 1,
      status: "open",
      ...(attachments.length > 0 ? { attachments } : {}),
      createdAt: now,
      updatedAt: now,
    };
    list.unshift(created);
    writePainPoints(list);
    return created;
  });
}

export function dismissPainPoint(id: string): EvolutionPainPoint {
  return withFileLockSync(inboxLockPath(), () => {
    const list = readPainPoints();
    const idx = list.findIndex((p) => p.id === id);
    if (idx === -1) {
      throw new WorkbenchError("not_found", `未找到痛点记录: ${id}`);
    }
    const updated: EvolutionPainPoint = { ...list[idx]!, status: "dismissed", updatedAt: Date.now() };
    list[idx] = updated;
    writePainPoints(list);
    return updated;
  });
}

export function resolveWorkbenchRepoRoot(fallbackRoot?: string): string {
  const packageRoot = path.resolve(import.meta.dir, "../..");
  const isWorkbenchDir = (dir: string): boolean => {
    try {
      const pkgPath = path.join(dir, "package.json");
      if (!fs.existsSync(pkgPath)) return false;
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { name?: string };
      return pkg.name === "workbench";
    } catch {
      return false;
    }
  };

  if (fallbackRoot && isWorkbenchDir(fallbackRoot)) return canonicalRoot(fallbackRoot);
  const cfg = readHubConfig();
  for (const proj of cfg.projects) {
    if (!isLocalNodeId(proj.nodeId)) continue;
    if (isWorkbenchDir(proj.root)) return canonicalRoot(proj.root);
  }
  if (isWorkbenchDir(packageRoot)) return canonicalRoot(packageRoot);
  return canonicalRoot(fallbackRoot ?? packageRoot);
}

export function inspectFinishedRunForPainPoints(input: {
  root: string;
  requirementId: string;
  run: AgentRunRecord;
  detail: RequirementDetail;
  rawLog: string;
  timedOut?: boolean;
  timeoutReason?: "idle" | "max_duration" | null;
  isRsiSandbox?: boolean;
  nodeId?: string;
  onReport?: (entry: PainPointReportInput) => EvolutionPainPoint | null;
}): EvolutionPainPoint[] {
  if (process.env.WORKBENCH_RSI_DEPTH === "1" || input.isRsiSandbox) return [];
  const recorded: EvolutionPainPoint[] = [];
  const emitPain = input.onReport ?? reportPainPoint;
  const baseContext = (component: string): PainPointContext => ({
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    projectRoot: input.root,
    requirementId: input.requirementId,
    runId: input.run.id,
    component,
  });

  // 1. Sniff workbench/CLI/MCP deadEnds logged by the agent
  for (const deadEnd of input.detail.state.handoffNote?.deadEnds ?? []) {
    if (/\b(wb|workbench|cli|mcp|propose|verify|tasks)\b/i.test(deadEnd)) {
      const item = emitPain({
        source: "post_run_dead_end",
        category: "cli_ergonomics",
        title: `工具契约死胡同: ${deadEnd.slice(0, 90)}`,
        detail: `来源需求: ${input.requirementId}\n运行 ID: ${input.run.id} (${input.run.harness}/${input.run.model})\n\nDead-End 记录:\n${deadEnd}`,
        context: baseContext("cli/mcp"),
      });
      if (item) recorded.push(item);
    }
  }

  // 2. Sniff repeated wb CLI invalid_input/invalid_transition friction (human stderr + --json stderr)
  const humanErrors = input.rawLog.match(/错误 \[(?:invalid_input|invalid_transition)\]:[^\n]+/g) ?? [];
  const jsonErrors = input.rawLog.match(/"code":\s*"(?:invalid_input|invalid_transition)"/g) ?? [];
  const totalCliErrors = humanErrors.length + jsonErrors.length;
  if (totalCliErrors >= 2) {
    const uniqueErrors = Array.from(new Set(humanErrors.length > 0 ? humanErrors : jsonErrors)).slice(0, 5);
    const item = emitPain({
      source: "agent_friction",
      category: "cli_ergonomics",
      title: `Agent 多次触发 wb CLI 参数错误 (${uniqueErrors[0]!.slice(0, 60)})`,
      detail: `来源需求: ${input.requirementId}\n运行 ID: ${input.run.id}\n命中报错 (${totalCliErrors} 次):\n${uniqueErrors.map((e) => `- ${e}`).join("\n")}`,
      context: baseContext("wb-cli"),
    });
    if (item) recorded.push(item);
  }

  // 3. Sniff timeouts (inactivity stalls) & abnormal process crashes.
  // Reaching the protective max-duration ceiling on very long tasks is expected, not a harness bug.
  const isTimedOut = Boolean(input.timedOut);
  const isIdleTimeout = isTimedOut && input.timeoutReason !== "max_duration";
  const tail = input.rawLog.slice(-4096);
  const isCrash =
    input.run.status === "failed" &&
    !isTimedOut &&
    !input.run.rateLimited &&
    (input.run.exitCode === null ||
      input.run.exitCode >= 128 ||
      /\[spawn error\]|segmentation fault|\bsigsegv\b|\bsigabrt\b|\bpanic:|unhandled/i.test(tail));

  if (isIdleTimeout) {
    const item = emitPain({
      source: "agent_friction",
      category: "harness_bug",
      title: `Harness 执行超时: ${input.run.harness}/${input.run.model} (${input.run.action})`,
      detail: `来源需求: ${input.requirementId}\n运行 ID: ${input.run.id}\n耗时: ${input.run.durationMs}ms\n尾部日志:\n${tail.slice(-1000)}`,
      context: baseContext(`${input.run.harness}/${input.run.action}`),
    });
    if (item) recorded.push(item);
  } else if (isCrash) {
    const item = emitPain({
      source: "agent_friction",
      category: "harness_bug",
      title: `Harness 异常崩溃: ${input.run.harness}/${input.run.model} (exit ${input.run.exitCode ?? "signal"})`,
      detail: `来源需求: ${input.requirementId}\n运行 ID: ${input.run.id}\n退出码: ${input.run.exitCode ?? "signal"}\n尾部日志:\n${tail.slice(-1200)}`,
      context: baseContext(`${input.run.harness}/${input.run.action}`),
    });
    if (item) recorded.push(item);
  }

  return recorded;
}

/**
 * Mirrors .workbench/items/<REQ-ID> metadata files & playbook.md as regular files into the worktree
 * so tools inspecting cwd relative paths see fresh context without duplicating project.json.
 */
export function syncRequirementMirrorToSandbox(
  wbRoot: string,
  reqId: string,
  worktreePath?: string,
): void {
  assertRequirementId(reqId);
  const base = canonicalRoot(wbRoot);
  if (!isProjectInitialized(base)) return;
  const wtRaw = worktreePath ?? getSandboxForRequirement(base, reqId)?.worktreePath;
  if (!wtRaw || !fs.existsSync(wtRaw)) return;
  const wt = canonicalRoot(wtRaw);

  const srcItemDir = resolveSafePath(base, `${WORKBENCH_DIR}/items/${reqId}`);
  const dstItemDir = resolveSafePath(wt, `${WORKBENCH_DIR}/items/${reqId}`);
  fs.mkdirSync(dstItemDir, { recursive: true });

  for (const name of ["spec.md", "design.md", "handoff.md", "state.json"]) {
    const srcFile = path.join(srcItemDir, name);
    if (fs.existsSync(srcFile)) {
      const content = readBoundedText(srcFile, 512 * 1024);
      atomicWriteFile(resolveSafePath(wt, `${WORKBENCH_DIR}/items/${reqId}/${name}`), content);
    }
  }

  // 附件目录按二进制直拷，保证 worktree 内相对路径可读。
  const srcAttachments = path.join(srcItemDir, "attachments");
  if (fs.existsSync(srcAttachments) && fs.lstatSync(srcAttachments).isDirectory()) {
    const dstAttachments = resolveSafePath(wt, `${WORKBENCH_DIR}/items/${reqId}/attachments`);
    fs.mkdirSync(dstAttachments, { recursive: true });
    for (const entry of fs.readdirSync(srcAttachments, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const srcFile = path.join(srcAttachments, entry.name);
      const stat = fs.lstatSync(srcFile);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      atomicWriteBuffer(path.join(dstAttachments, entry.name), fs.readFileSync(srcFile), stat.mode & 0o777);
    }
  }

  const srcPlaybook = resolveSafePath(base, `${WORKBENCH_DIR}/playbook.md`);
  if (fs.existsSync(srcPlaybook)) {
    atomicWriteFile(resolveSafePath(wt, `${WORKBENCH_DIR}/playbook.md`), readBoundedText(srcPlaybook, 16 * 1024));
  }

  // 验证证据按最新 20 个规则文件镜像，保证沙箱内只读审查可直接核验既有运行日志。
  const srcEvidence = path.join(srcItemDir, "evidence");
  if (fs.existsSync(srcEvidence) && fs.lstatSync(srcEvidence).isDirectory()) {
    const dstEvidence = resolveSafePath(wt, `${WORKBENCH_DIR}/items/${reqId}/evidence`);
    fs.mkdirSync(dstEvidence, { recursive: true });
    const recentEvidence: Array<{ name: string; srcFile: string; mtimeMs: number; mode: number }> = [];
    for (const entry of fs.readdirSync(srcEvidence, { withFileTypes: true })) {
      if (!entry.isFile() || (!entry.name.endsWith(".json") && !entry.name.endsWith(".log"))) continue;
      const srcFile = path.join(srcEvidence, entry.name);
      const stat = fs.lstatSync(srcFile);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      recentEvidence.push({ name: entry.name, srcFile, mtimeMs: stat.mtimeMs, mode: stat.mode & 0o777 });
    }
    recentEvidence.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const ev of recentEvidence.slice(0, 20)) {
      const buf = fs.readFileSync(ev.srcFile);
      const bounded = buf.length > MAX_EVIDENCE_BYTES ? buf.subarray(0, MAX_EVIDENCE_BYTES) : buf;
      atomicWriteBuffer(resolveSafePath(wt, `${WORKBENCH_DIR}/items/${reqId}/evidence/${ev.name}`), bounded, ev.mode);
    }
  }
}

export async function createOrReuseWorktree(
  wbRoot: string,
  reqId: string,
): Promise<SandboxRecord> {
  assertRequirementId(reqId);
  const base = canonicalRoot(wbRoot);
  const existing = getSandboxForRequirement(base, reqId);
  if (existing) {
    syncRequirementMirrorToSandbox(base, reqId, existing.worktreePath);
    return existing;
  }

  const snap = await observeGitSnapshot(base);
  if (!snap || !snap.head) {
    throw new WorkbenchError("execution_failed", "目标仓库尚未初始化 Git 提交，无法创建 Worktree 沙箱");
  }

  const worktreePath = path.join(worktreesBaseDir(), reqId);
  const branch = `rsi/${reqId}`;
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true, mode: 0o700 });
  if (fs.existsSync(worktreePath)) {
    try {
      execFileSync("git", ["-C", base, "worktree", "remove", "--force", worktreePath], { stdio: "ignore" });
    } catch {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  }

  execFileSync("git", ["-C", base, "worktree", "add", "-B", branch, worktreePath, "HEAD"], {
    stdio: "pipe",
  });

  const mainNodeModules = path.join(base, "node_modules");
  const wtNodeModules = path.join(worktreePath, "node_modules");
  if (fs.existsSync(mainNodeModules) && !fs.existsSync(wtNodeModules)) {
    fs.symlinkSync(mainNodeModules, wtNodeModules, "dir");
  }

  syncRequirementMirrorToSandbox(base, reqId, worktreePath);

  const record: SandboxRecord = {
    projectRoot: base,
    requirementId: reqId,
    worktreePath,
    branch,
    baseHead: snap.head,
    createdAt: Date.now(),
  };
  withSandboxLockSync(() => {
    const all = readSandboxes();
    all[sandboxKey(base, reqId)] = record;
    writeSandboxes(all);
  });
  return record;
}

function splitNullStrings(buf: Buffer): string[] {
  return buf.toString("utf8").split("\0").filter(Boolean);
}

function hasDirtyWorktreeExcludingNodeModules(wt: string): boolean {
  const raw = execFileSync("git", [
    "-C",
    wt,
    "status",
    "--porcelain=v1",
    "-z",
    "-uall",
    "--",
    ".",
    ":(exclude).workbench",
    ":(exclude).omp/workbench",
  ]);
  const tokens = splitNullStrings(raw);
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i]!;
    const xy = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (xy[0] === "R" || xy[0] === "C") {
      i += 1;
    }
    if (!filePath || filePath === "node_modules" || filePath.startsWith("node_modules/")) {
      continue;
    }
    return true;
  }
  return false;
}

function isGitAncestor(repoDir: string, ancestor: string, descendant: string): boolean {
  if (!ancestor || !descendant) return false;
  try {
    execFileSync("git", ["-C", repoDir, "merge-base", "--is-ancestor", ancestor, descendant], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function hasInProgressMergeOrRebase(wt: string): boolean {
  for (const marker of ["MERGE_HEAD", "rebase-merge", "rebase-apply"]) {
    try {
      const p = execFileSync("git", ["-C", wt, "rev-parse", "--git-path", marker], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const abs = path.isAbsolute(p) ? p : path.resolve(wt, p);
      if (fs.existsSync(abs)) return true;
    } catch {
      // Ignore marker check errors on bare/unavailable git paths.
    }
  }
  return false;
}

function resolveEffectiveSandboxBaseRef(base: string, wt: string, sandbox: SandboxRecord, mainHead?: string | null): string {
  let baseRef = sandbox.baseHead ?? "";
  let resolvedMainHead = mainHead ?? "";
  if (!resolvedMainHead) {
    try {
      resolvedMainHead = execFileSync("git", ["-C", base, "rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      resolvedMainHead = "";
    }
  }
  try {
    if (resolvedMainHead) {
      const mergeBase = execFileSync("git", ["-C", wt, "merge-base", resolvedMainHead, sandbox.branch], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (mergeBase && /^[0-9a-f]{7,64}$/i.test(mergeBase)) {
        if (!baseRef) {
          baseRef = mergeBase;
        } else if (mergeBase !== baseRef && isGitAncestor(base, baseRef, mergeBase)) {
          baseRef = mergeBase;
        }
      }
    }
  } catch {
    if (!baseRef) {
      try {
        baseRef = execFileSync("git", ["-C", base, "merge-base", "HEAD", sandbox.branch], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        baseRef = "";
      }
    }
  }
  return baseRef;
}

/**
 * Reconciles `sandbox.baseHead` and `state.baseline.head` when the agent merges or rebases
 * main commits directly inside an isolated RSI worktree.
 */
export async function reconcileRsiSandboxBaseline(
  wbRoot: string,
  reqId: string,
): Promise<RequirementDetail | null> {
  assertRequirementId(reqId);
  const base = canonicalRoot(wbRoot);
  const sandbox = getSandboxForRequirement(base, reqId);
  if (!sandbox || !fs.existsSync(sandbox.worktreePath)) return null;
  const wt = canonicalRoot(sandbox.worktreePath);
  if (hasInProgressMergeOrRebase(wt)) return null;

  let mainHead = "";
  let wtHead = "";
  try {
    mainHead = execFileSync("git", ["-C", base, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    wtHead = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }

  const effectiveBase = resolveEffectiveSandboxBaseRef(base, wt, sandbox, mainHead);
  if (!effectiveBase) return null;
  if (!isGitAncestor(base, effectiveBase, mainHead) || !isGitAncestor(wt, effectiveBase, wtHead)) {
    return null;
  }

  const detail = getRequirement(base, reqId);
  const sandboxNeedsUpdate =
    sandbox.baseHead !== effectiveBase && (!sandbox.baseHead || isGitAncestor(base, sandbox.baseHead, effectiveBase));
  const canSyncState = detail.state.stage !== "done" && detail.state.stage !== "cancelled";
  const stateBaseHead = detail.state.baseline?.head ?? null;
  const stateNeedsUpdate =
    canSyncState &&
    stateBaseHead !== effectiveBase &&
    (stateBaseHead ? isGitAncestor(base, stateBaseHead, effectiveBase) : sandboxNeedsUpdate);

  if (!sandboxNeedsUpdate && !stateNeedsUpdate) return null;

  if (sandboxNeedsUpdate) {
    withSandboxLockSync(() => {
      const all = readSandboxes();
      const key = sandboxKey(base, reqId);
      if (all[key]) {
        all[key] = { ...all[key]!, baseHead: effectiveBase };
        writeSandboxes(all);
      }
    });
  }

  if (stateNeedsUpdate) {
    const snapAfter = await observeGitSnapshot(wt);
    const updated = await syncRequirementBaseline(base, reqId, {
      baselineHead: effectiveBase,
      baselineFingerprint: snapAfter?.fingerprint ?? "0".repeat(64),
      dirty: snapAfter?.dirty ?? false,
      preserveStage: true,
      summary: `检测到沙箱分支已合并主干提交，基线自动推进至 ${effectiveBase.slice(0, 7)}`,
      currentCodeSnapshotHash: snapAfter?.fingerprint ?? null,
    });
    syncRequirementMirrorToSandbox(base, reqId, wt);
    return updated;
  }

  return detail;
}

export interface SandboxDriftInfo {
  requirementId: string;
  branch: string;
  baseHead: string;
  mainHead: string;
  behindCount: number;
  aheadCount: number;
  mainDirty: boolean;
  conflictFiles: string[];
  canAutoSync: boolean;
}

/** Inspects whether an isolated RSI worktree has fallen behind main or has overlapping modified files. */
export async function inspectRsiSandboxDrift(wbRoot: string, reqId: string): Promise<SandboxDriftInfo | null> {
  assertRequirementId(reqId);
  const base = canonicalRoot(wbRoot);
  const sandbox = getSandboxForRequirement(base, reqId);
  if (!sandbox || !fs.existsSync(sandbox.worktreePath)) return null;
  const wt = canonicalRoot(sandbox.worktreePath);

  let mainHead = "";
  let wtHead = "";
  try {
    mainHead = execFileSync("git", ["-C", base, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    wtHead = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }

  const effectiveBase = resolveEffectiveSandboxBaseRef(base, wt, sandbox, mainHead) || wtHead;
  let behindCount = 0;
  let aheadCount = 0;
  try {
    behindCount = Number(
      execFileSync("git", ["-C", base, "rev-list", "--count", `${effectiveBase}..${mainHead}`], {
        encoding: "utf8",
      }).trim(),
    ) || 0;
  } catch {
    behindCount = 0;
  }
  try {
    aheadCount = Number(
      execFileSync("git", ["-C", wt, "rev-list", "--count", `${effectiveBase}..HEAD`], {
        encoding: "utf8",
      }).trim(),
    ) || 0;
  } catch {
    aheadCount = 0;
  }

  const wtFiles = new Set<string>([
    ...splitNullStrings(
      execFileSync("git", [
        "-C", wt, "diff", "--name-only", "-z", "--no-renames", effectiveBase,
        "--", ".", ":(exclude).workbench", ":(exclude).omp/workbench",
      ]),
    ),
    ...splitNullStrings(
      execFileSync("git", [
        "-C", wt, "ls-files", "--others", "-z", "--exclude-standard",
        "--", ".", ":(exclude).workbench", ":(exclude).omp/workbench",
      ]),
    ).filter((s) => s !== "node_modules" && !s.startsWith("node_modules/")),
  ]);

  const mainFiles = new Set<string>([
    ...splitNullStrings(
      execFileSync("git", [
        "-C", base, "diff", "--name-only", "-z", "--no-renames", effectiveBase,
        "--", ".", ":(exclude).workbench", ":(exclude).omp/workbench",
      ]),
    ),
    ...splitNullStrings(
      execFileSync("git", [
        "-C", base, "ls-files", "--others", "-z", "--exclude-standard",
        "--", ".", ":(exclude).workbench", ":(exclude).omp/workbench",
      ]),
    ),
  ]);

  const mainDirty =
    execFileSync("git", ["-C", base, "status", "--porcelain", "--", ".", ":(exclude).workbench", ":(exclude).omp/workbench"], {
      encoding: "utf8",
    }).trim().length > 0;

  const conflictFiles = Array.from(wtFiles).filter((f) => mainFiles.has(f)).sort();
  return {
    requirementId: reqId,
    branch: sandbox.branch,
    baseHead: effectiveBase,
    mainHead,
    behindCount,
    aheadCount,
    mainDirty,
    conflictFiles,
    canAutoSync: behindCount > 0 && conflictFiles.length === 0,
  };
}

/**
 * Safely fast-forwards/merges an isolated RSI sandbox worktree to current main HEAD
 * when there are no overlapping file conflicts, preserving all uncommitted WIP edits.
 */
export async function syncRsiSandboxBase(
  wbRoot: string,
  reqId: string,
): Promise<{
  synced: boolean;
  upToDate: boolean;
  conflictFiles: string[];
  drift: SandboxDriftInfo;
  detail: RequirementDetail;
}> {
  assertRequirementId(reqId);
  const base = canonicalRoot(wbRoot);
  const sandbox = getSandboxForRequirement(base, reqId);
  if (!sandbox || !fs.existsSync(sandbox.worktreePath)) {
    throw new WorkbenchError("not_found", `未找到需求 ${reqId} 的活跃 Worktree 沙箱`);
  }
  const wt = canonicalRoot(sandbox.worktreePath);
  const drift = await inspectRsiSandboxDrift(base, reqId);
  if (!drift) {
    throw new WorkbenchError("execution_failed", "无法检查沙箱基线状态");
  }
  if (drift.behindCount === 0) {
    const wtSnap = await observeGitSnapshot(wt);
    const detail = getRequirement(base, reqId, { currentCodeSnapshotHash: wtSnap?.fingerprint ?? null });
    return { synced: true, upToDate: true, conflictFiles: [], drift, detail };
  }
  if (drift.conflictFiles.length > 0) {
    const wtSnap = await observeGitSnapshot(wt);
    const detail = getRequirement(base, reqId, { currentCodeSnapshotHash: wtSnap?.fingerprint ?? null });
    return { synced: false, upToDate: false, conflictFiles: drift.conflictFiles, drift, detail };
  }

  const wtHead = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (drift.aheadCount === 0) {
    // Two-way read-tree merge preserves all uncommitted WIP edits & untracked files while updating base files.
    execFileSync("git", ["-C", wt, "read-tree", "-m", "-u", wtHead, drift.mainHead], { stdio: "pipe" });
    execFileSync("git", ["-C", wt, "reset", "--soft", drift.mainHead], { stdio: "pipe" });
  } else {
    const wtDirty = hasDirtyWorktreeExcludingNodeModules(wt);
    if (wtDirty) {
      throw new WorkbenchError(
        "revision_conflict",
        "沙箱分支已有独立提交且存在未提交改动，请先提交或使用 Agent 协助合并主干",
      );
    }
    try {
      execFileSync("git", ["-C", wt, "merge", "--no-edit", drift.mainHead], { stdio: "pipe" });
    } catch {
      try {
        execFileSync("git", ["-C", wt, "merge", "--abort"], { stdio: "ignore" });
      } catch {
        // Ignore abort cleanup error.
      }
      throw new WorkbenchError("revision_conflict", "合并主干时产生 Git 冲突，请派发 Agent 处理冲突");
    }
  }

  withSandboxLockSync(() => {
    const all = readSandboxes();
    const key = sandboxKey(base, reqId);
    if (all[key]) {
      all[key] = { ...all[key]!, baseHead: drift.mainHead };
      writeSandboxes(all);
    }
  });

  const snapAfter = await observeGitSnapshot(wt);
  const detail = await syncRequirementBaseline(base, reqId, {
    baselineHead: drift.mainHead,
    baselineFingerprint: snapAfter?.fingerprint ?? "0".repeat(64),
    dirty: snapAfter?.dirty ?? false,
    summary: `沙箱基线已自动同步至主干 ${drift.mainHead.slice(0, 7)}（落后 ${drift.behindCount} 个提交已合并，请复跑验证）`,
    currentCodeSnapshotHash: snapAfter?.fingerprint ?? null,
  });
  syncRequirementMirrorToSandbox(base, reqId, wt);
  const nextDrift = (await inspectRsiSandboxDrift(base, reqId)) ?? { ...drift, behindCount: 0, baseHead: drift.mainHead, canAutoSync: false };
  return { synced: true, upToDate: false, conflictFiles: [], drift: nextDrift, detail };
}

export async function applySandboxToMain(
  wbRoot: string,
  reqId: string,
): Promise<{
  appliedFiles: string[];
  deletedFiles: string[];
  touchesWeb: boolean;
  touchesBackend: boolean;
}> {
  assertRequirementId(reqId);
  const base = canonicalRoot(wbRoot);
  const sandbox = getSandboxForRequirement(base, reqId);
  if (!sandbox) {
    throw new WorkbenchError("not_found", `未找到需求 ${reqId} 的活跃 Worktree 沙箱`);
  }

  const wt = canonicalRoot(sandbox.worktreePath);
  const wtSnap = await observeGitSnapshot(wt);
  const detail = getRequirement(base, reqId, { currentCodeSnapshotHash: wtSnap?.fingerprint ?? null });
  if (detail.state.stage !== "done" || !detail.state.acceptance) {
    throw new WorkbenchError(
      "acceptance_gate_failed",
      `需求 ${reqId} 尚未完成人工最终验收（当前阶段：${detail.state.stage}），禁止应用沙箱改动`,
    );
  }
  if (!wtSnap || detail.state.acceptance.codeSnapshotHash !== wtSnap.fingerprint) {
    throw new WorkbenchError(
      "acceptance_gate_failed",
      `需求 ${reqId} 的沙箱代码在验收后发生了变更，请重新打开需求验证并验收后再应用`,
    );
  }

  // Determine the fork commit against main HEAD (never diff against sandbox's own branch HEAD)
  const mainSnap = await observeGitSnapshot(base);
  let baseRef = resolveEffectiveSandboxBaseRef(base, wt, sandbox, mainSnap?.head ?? null);
  if (!baseRef) {
    if (!mainSnap?.head) {
      throw new WorkbenchError("execution_failed", "无法确定主仓库与沙箱的分叉基准提交");
    }
    baseRef = mainSnap.head;
  }

  // Collect modified/added/untracked/deleted files inside sandbox relative to baseRef (--no-renames + -z)
  const diffTracked = splitNullStrings(
    execFileSync("git", [
      "-C", wt, "diff", "--name-only", "-z", "--no-renames", "--diff-filter=ACMT", baseRef,
      "--", ".", ":(exclude).workbench", ":(exclude).omp/workbench",
    ]),
  );

  const untracked = splitNullStrings(
    execFileSync("git", [
      "-C", wt, "ls-files", "--others", "-z", "--exclude-standard",
      "--", ".", ":(exclude).workbench", ":(exclude).omp/workbench",
    ]),
  ).filter((s) => s !== "node_modules" && !s.startsWith("node_modules/"));

  const deleted = splitNullStrings(
    execFileSync("git", [
      "-C", wt, "diff", "--name-only", "-z", "--no-renames", "--diff-filter=D", baseRef,
      "--", ".", ":(exclude).workbench", ":(exclude).omp/workbench",
    ]),
  );

  const appliedFiles = Array.from(new Set([...diffTracked, ...untracked]));

  // Validate all source and destination paths against path traversal and symlinks BEFORE writing
  const copyPlan: Array<{ rel: string; dest: string; bytes: Buffer; mode: number }> = [];
  for (const rel of appliedFiles) {
    const safeSrc = resolveSafePath(wt, rel);
    const srcStat = fs.lstatSync(safeSrc);
    if (srcStat.isSymbolicLink()) {
      throw new WorkbenchError("symlink_not_allowed", `禁止通过沙箱应用符号链接文件: ${rel}`);
    }
    if (!srcStat.isFile()) continue;
    const safeDest = resolveSafePath(base, rel);
    copyPlan.push({
      rel,
      dest: safeDest,
      bytes: fs.readFileSync(safeSrc),
      mode: srcStat.mode & 0o777,
    });
  }

  const deletePlan: Array<{ rel: string; dest: string }> = [];
  for (const rel of deleted) {
    const safeDest = resolveSafePath(base, rel);
    if (fs.existsSync(safeDest)) {
      const destStat = fs.lstatSync(safeDest);
      if (destStat.isSymbolicLink()) {
        throw new WorkbenchError("symlink_not_allowed", `拒绝删除主仓库中的符号链接: ${rel}`);
      }
      if (destStat.isFile()) {
        deletePlan.push({ rel, dest: safeDest });
      }
    }
  }

  // Guard against silently clobbering files modified concurrently on main since baseRef
  const mainTouched = new Set<string>();
  const mainDiff = splitNullStrings(
    execFileSync("git", [
      "-C", base, "diff", "--name-only", "-z", "--no-renames", baseRef,
      "--", ".", ":(exclude).workbench", ":(exclude).omp/workbench",
    ]),
  );
  for (const f of mainDiff) mainTouched.add(f);
  const mainUntracked = splitNullStrings(
    execFileSync("git", [
      "-C", base, "ls-files", "--others", "-z", "--exclude-standard",
      "--", ".", ":(exclude).workbench", ":(exclude).omp/workbench",
    ]),
  );
  for (const f of mainUntracked) mainTouched.add(f);
  const conflicts = [...appliedFiles, ...deleted].filter((f) => mainTouched.has(f));
  if (conflicts.length > 0) {
    throw new WorkbenchError(
      "revision_conflict",
      `主仓库在沙箱分叉后也修改了相同文件，请手工处理冲突: ${conflicts.slice(0, 10).join(", ")}`,
    );
  }

  for (const item of copyPlan) {
    atomicWriteBuffer(item.dest, item.bytes, item.mode);
  }
  for (const item of deletePlan) {
    fs.rmSync(item.dest, { force: true });
  }

  cleanupSandboxWorktree(base, reqId, sandbox);

  const allTouched = [...appliedFiles, ...deleted];
  const touchesWeb = allTouched.some((f) => f.startsWith("src/web/"));
  const touchesBackend = allTouched.some(
    (f) => f.startsWith("src/server/") || f.startsWith("src/hub/") || f.startsWith("src/core/"),
  );
  return { appliedFiles, deletedFiles: deleted, touchesWeb, touchesBackend };
}

function cleanupSandboxWorktree(base: string, reqId: string, sandbox: SandboxRecord): void {
  const wt = fs.existsSync(sandbox.worktreePath) ? canonicalRoot(sandbox.worktreePath) : sandbox.worktreePath;
  try {
    execFileSync("git", ["-C", base, "worktree", "remove", "--force", wt], { stdio: "ignore" });
  } catch {
    fs.rmSync(wt, { recursive: true, force: true });
  }
  try {
    execFileSync("git", ["-C", base, "branch", "-D", sandbox.branch], { stdio: "ignore" });
  } catch {
    // Ignore branch cleanup errors.
  }

  withSandboxLockSync(() => {
    const all = readSandboxes();
    delete all[sandboxKey(base, reqId)];
    writeSandboxes(all);
  });
}

/**
 * Checks the linked GitHub PR status for an RSI sandbox requirement.
 * When merged (or force-cleaned after close), safely fast-forwards the clean base branch
 * and cleans up the isolated worktree + rsi/<REQ-ID> branch.
 */
export async function syncRsiSandboxPrAndCleanup(
  wbRoot: string,
  reqId: string,
  options: { forceCleanup?: boolean } = {},
  deps?: GitHubCommandDeps,
): Promise<{
  detail: RequirementDetail;
  pr: NonNullable<NonNullable<RequirementDetail["state"]["github"]>["pr"]>;
  cleanedSandbox: boolean;
  mainUpdated: boolean;
  mainSyncReason: string | null;
  mainSyncReasonRef?: StructuredMessageRef | null;
  touchesWeb: boolean;
  touchesBackend: boolean;
}> {
  assertRequirementId(reqId);
  const base = canonicalRoot(wbRoot);
  const current = getRequirement(base, reqId);
  const repo = current.state.github?.repo;
  const existingPr = current.state.github?.pr;
  if (!repo || !existingPr) {
    throw new WorkbenchError("not_found", `需求 ${reqId} 尚未创建关联的 GitHub PR`);
  }

  const latestPr = await viewGitHubPr({ root: base, repo, prNumber: existingPr.number }, deps);
  const isMerged = latestPr.state === "merged";
  const shouldCleanup = isMerged || (latestPr.state === "closed" && options.forceCleanup === true);

  let mainUpdated = false;
  let mainSyncReason: string | null = null;
  let mainSyncReasonRef: StructuredMessageRef | null = null;
  let cleanedSandbox = false;

  if (isMerged) {
    const ff = await fetchAndFastForwardBranch(base, latestPr.baseBranch || "main", "origin");
    mainUpdated = ff.updated;
    mainSyncReason = ff.reason;
    mainSyncReasonRef = ff.reasonRef ?? null;
  }

  const sandbox = getSandboxForRequirement(base, reqId);
  if (shouldCleanup && sandbox) {
    cleanupSandboxWorktree(base, reqId, sandbox);
    cleanedSandbox = true;
  }

  const snapAfter = await observeGitSnapshot(cleanedSandbox ? base : (sandbox?.worktreePath ?? base));
  const detail = await recordRequirementGitHubSync(base, reqId, {
    prPatch: latestPr,
    ...(isMerged && current.state.github?.issue ? { issuePatch: { state: "closed" } } : {}),
    eventKind: "github_pr_synced",
    summary: isMerged
      ? `GitHub PR #${latestPr.number} 已合并${cleanedSandbox ? "，已清理隔离沙箱" : ""}`
      : `同步 GitHub PR #${latestPr.number} 状态：${latestPr.state}`,
    detail: mainSyncReason ?? latestPr.url,
    currentCodeSnapshotHash: snapAfter?.fingerprint ?? null,
  });

  const touchedFiles =
    current.state.delivery?.files ??
    readRequirementBundle(base, reqId).acceptanceSnapshot?.git.files.map((f) => f.path) ??
    [];
  const touchesWeb = touchedFiles.some((f) => f.startsWith("src/web/"));
  const touchesBackend = touchedFiles.some(
    (f) =>
      f.startsWith("src/server/") ||
      f.startsWith("src/hub/") ||
      f.startsWith("src/core/") ||
      f.startsWith("src/cli/") ||
      f.startsWith("src/mcp/"),
  );

  return {
    detail,
    pr: latestPr,
    cleanedSandbox,
    mainUpdated,
    mainSyncReason,
    ...(mainSyncReasonRef ? { mainSyncReasonRef } : {}),
    touchesWeb,
    touchesBackend,
  };
}

export async function promotePainPoint(
  painId: string,
  options: {
    workbenchRoot?: string;
    createSandbox?: boolean;
    createGitHubIssue?: boolean;
  } = {},
  deps?: GitHubCommandDeps,
): Promise<{
  painPoint: EvolutionPainPoint;
  requirement: RequirementDetail;
  workbenchRoot: string;
  workbenchProjectId: string;
  sandbox: SandboxRecord | null;
  githubIssueWarning?: string;
  githubIssueWarningRef?: StructuredMessageRef;
}> {
  const initialList = readPainPoints();
  const initialIdx = initialList.findIndex((p) => p.id === painId);
  if (initialIdx === -1) {
    throw new WorkbenchError("not_found", `未找到痛点记录: ${painId}`);
  }
  const pain = initialList[initialIdx]!;
  if (pain.status === "promoted") {
    throw new WorkbenchError("invalid_transition", `痛点 ${painId} 已转化为需求 ${pain.promotedReqId ?? ""}`);
  }

  const wbRoot = resolveWorkbenchRepoRoot(options.workbenchRoot);

  if (!isProjectInitialized(wbRoot)) {
    await initProject(wbRoot, { name: path.basename(wbRoot) || "workbench", privacyMode: "local" });
  }
  const { project: registered } = registerHubProject(wbRoot, { activate: false });

  const ctxLines = [
    `- 来源分类：\`${pain.source}\` / \`${pain.category}\`（累计发生 ${pain.occurrences} 次）`,
    pain.context.nodeId ? `- 来源节点：\`${pain.context.nodeId}\`` : "",
    pain.context.projectRoot ? `- 触发项目：\`${pain.context.projectRoot}\`` : "",
    pain.context.requirementId ? `- 关联需求：\`${pain.context.requirementId}\`` : "",
    pain.context.domSelector ? `- 页面元素锚点：\`${pain.context.domSelector}\`` : "",
    pain.context.viewport ? `- 视口与主题：\`${pain.context.viewport}\` (${pain.context.theme ?? "default"})` : "",
  ].filter(Boolean);

  const painAttachments = normalizeAttachments(pain.attachments) ?? [];
  const attachmentLines =
    painAttachments.length > 0
      ? [
          "",
          "## 附件清单",
          ...painAttachments.map(
            (meta) =>
              `- ${meta.name}（${meta.mimeType}，${formatAttachmentSize(meta.size)}）：attachments/${attachmentFileName(meta)}`,
          ),
        ]
      : [];

  const specGoal = [
    `# [RSI 自进化修复] ${pain.title}`,
    "",
    "## 问题现场与上下文",
    ...ctxLines,
    "",
    "## 详细描述",
    pain.detail,
    "",
    "## 预期效果",
    "修复上述工作台问题，补充针对性回归测试，并确保类型检查与全量测试通过。",
    ...attachmentLines,
  ].join("\n");

  const criteria: CriterionInput[] =
    pain.category === "ui_anomaly"
      ? [
          { id: "AC-1", description: "TypeScript 类型检查通过", required: true, command: "bun run typecheck" },
          {
            id: "AC-2",
            description: "Web UI 浏览器 E2E 与图标契约测试通过",
            required: true,
            command: "bun test tests/web/icons.test.tsx tests/web/e2e_browser.test.ts",
          },
          { id: "AC-3", description: "全量测试回归通过", required: true, command: "bun test" },
        ]
      : [
          { id: "AC-1", description: "TypeScript 类型检查通过", required: true, command: "bun run typecheck" },
          { id: "AC-2", description: "全量测试回归通过", required: true, command: "bun test" },
        ];

  const snap = await observeGitSnapshot(wbRoot);
  const uiRelated =
    pain.source === "ui_quick_report" || pain.source === "ui_error" || pain.category === "ui_anomaly";
  let detail = await createRequirement(wbRoot, {
    title: `[RSI] ${pain.title}`.slice(0, 115),
    goal: specGoal,
    criteria,
    track: "plan_first",
    uiRelated,
    currentCodeSnapshotHash: snap?.fingerprint ?? null,
    ...(painAttachments.length > 0
      ? { attachmentSource: { dir: painPointAttachmentsDir(pain.id), metas: painAttachments } }
      : {}),
  });

  let githubIssueWarning: string | undefined;
  let githubIssueWarningRef: StructuredMessageRef | undefined;
  const projectMeta = getProjectStatus(wbRoot).project;
  const shouldCreateIssue =
    options.createGitHubIssue === true ||
    (options.createGitHubIssue !== false && projectMeta?.github?.autoCreateIssue === true);
  if (shouldCreateIssue) {
    try {
      const ghEnv = await inspectGitHubEnvironment(wbRoot, projectMeta?.github, deps);
      if (!ghEnv.ready || !ghEnv.repo) {
        githubIssueWarning = ghEnv.reason ?? "GitHub CLI 环境未就绪，已跳过同步创建 Issue";
        githubIssueWarningRef = { key: buildGitHubReasonMessageDetails(ghEnv).messageKey };
      } else {
        const issue = await createGitHubIssue(
          {
            root: wbRoot,
            repo: ghEnv.repo,
            title: `[RSI ${detail.state.id}] ${pain.title}`,
            body: buildRequirementIssueBody(detail),
            labels: ["workbench-rsi", pain.category],
          },
          deps,
        );
        detail = await linkRequirementGitHubIssue(wbRoot, detail.state.id, {
          repo: ghEnv.repo,
          issue,
          summary: `从痛点创建并关联 GitHub Issue #${issue.number}`,
          currentCodeSnapshotHash: snap?.fingerprint ?? null,
        });
      }
    } catch (err) {
      githubIssueWarning = err instanceof Error ? err.message : String(err);
      githubIssueWarningRef = extractMessageRef(err) ?? undefined;
    }
  }

  let sandbox: SandboxRecord | null = null;
  if (options.createSandbox !== false && snap?.head) {
    sandbox = await createOrReuseWorktree(wbRoot, detail.state.id);
  }

  const updated = withFileLockSync(inboxLockPath(), () => {
    const currentList = readPainPoints();
    const curIdx = currentList.findIndex((p) => p.id === painId);
    if (curIdx === -1) {
      throw new WorkbenchError("not_found", `未找到痛点记录: ${painId}`);
    }
    const nextItem: EvolutionPainPoint = {
      ...currentList[curIdx]!,
      status: "promoted",
      promotedReqId: detail.state.id,
      updatedAt: Date.now(),
    };
    currentList[curIdx] = nextItem;
    writePainPoints(currentList);
    return nextItem;
  });

  return {
    painPoint: updated,
    requirement: detail,
    workbenchRoot: wbRoot,
    workbenchProjectId: registered.id,
    sandbox,
    ...(githubIssueWarning ? { githubIssueWarning } : {}),
    ...(githubIssueWarningRef ? { githubIssueWarningRef } : {}),
  };
}
