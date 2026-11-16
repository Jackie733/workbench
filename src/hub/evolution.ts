import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequirement, initProject, propose } from "../core/engine.ts";
import { WorkbenchError } from "../core/errors.ts";
import { atomicWriteFile, canonicalRoot } from "../core/fs.ts";
import { observeGitSnapshot } from "../core/git.ts";
import {
  getSandboxForRequirement,
  readSandboxes,
  sandboxKey,
  writeSandboxes,
  type SandboxRecord,
} from "../core/sandbox.ts";
import { isProjectInitialized } from "../core/store.ts";
import type { AgentRunRecord, RequirementDetail } from "../core/types.ts";
import { readHubConfig, resolveHubDir } from "./registry.ts";

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
  projectRoot?: string;
  requirementId?: string;
  runId?: string;
  domSelector?: string;
  viewport?: string;
  theme?: string;
  urlPath?: string;
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
  createdAt: number;
  updatedAt: number;
}

const MAX_INBOX_ENTRIES = 300;

export function inboxFilePath(): string {
  return path.join(resolveHubDir(), "evolution", "inbox.jsonl");
}

function worktreesBaseDir(): string {
  return path.join(resolveHubDir(), "evolution", "worktrees");
}

function computePainFingerprint(category: string, title: string): string {
  const norm = title.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 140);
  return createHash("sha256").update(`${category}::${norm}`, "utf8").digest("hex").slice(0, 24);
}

export function readPainPoints(): EvolutionPainPoint[] {
  const filePath = inboxFilePath();
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
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
  return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

function writePainPoints(list: EvolutionPainPoint[]): void {
  const filePath = inboxFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const bounded = list.slice(0, MAX_INBOX_ENTRIES);
  const body = bounded.map((item) => JSON.stringify(item)).join("\n") + (bounded.length > 0 ? "\n" : "");
  atomicWriteFile(filePath, body);
}

export function reportPainPoint(input: {
  source: PainPointSource;
  category: PainPointCategory;
  title: string;
  detail?: string;
  context?: PainPointContext;
}): EvolutionPainPoint | null {
  if (
    process.env.WORKBENCH_RSI_DEPTH === "1" &&
    input.source !== "ui_quick_report" &&
    input.source !== "cli_issue"
  ) {
    return null;
  }

  const title = input.title.trim().replace(/\s+/g, " ").slice(0, 160);
  if (!title) {
    throw new WorkbenchError("invalid_input", "痛点标题不能为空");
  }
  const detail = (input.detail ?? "").trim().slice(0, 4000);
  const fingerprint = computePainFingerprint(input.category, title);
  const now = Date.now();
  const list = readPainPoints();

  const existingIdx = list.findIndex((p) => p.fingerprint === fingerprint && p.status === "open");
  if (existingIdx >= 0) {
    const prev = list[existingIdx]!;
    const mergedDetail =
      detail && !prev.detail.includes(detail.slice(0, 80))
        ? `${prev.detail}${prev.detail ? "\n\n---\n" : ""}${detail}`.slice(0, 4000)
        : prev.detail;
    const updated: EvolutionPainPoint = {
      ...prev,
      occurrences: prev.occurrences + 1,
      detail: mergedDetail,
      context: { ...prev.context, ...(input.context ?? {}) },
      updatedAt: now,
    };
    list[existingIdx] = updated;
    writePainPoints(list);
    return updated;
  }

  const created: EvolutionPainPoint = {
    id: `EVO-${now}-${randomUUID().slice(0, 6)}`,
    fingerprint,
    source: input.source,
    category: input.category,
    title,
    detail: detail || title,
    context: input.context ?? {},
    occurrences: 1,
    status: "open",
    createdAt: now,
    updatedAt: now,
  };
  list.unshift(created);
  writePainPoints(list);
  return created;
}

export function dismissPainPoint(id: string): EvolutionPainPoint {
  const list = readPainPoints();
  const idx = list.findIndex((p) => p.id === id);
  if (idx === -1) {
    throw new WorkbenchError("not_found", `未找到痛点记录: ${id}`);
  }
  const updated: EvolutionPainPoint = { ...list[idx]!, status: "dismissed", updatedAt: Date.now() };
  list[idx] = updated;
  writePainPoints(list);
  return updated;
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

  const cfg = readHubConfig();
  for (const proj of cfg.projects) {
    if (isWorkbenchDir(proj.root)) return canonicalRoot(proj.root);
  }
  if (isWorkbenchDir(packageRoot)) return canonicalRoot(packageRoot);
  if (fallbackRoot && isWorkbenchDir(fallbackRoot)) return canonicalRoot(fallbackRoot);
  return canonicalRoot(fallbackRoot ?? packageRoot);
}

export function inspectFinishedRunForPainPoints(input: {
  root: string;
  requirementId: string;
  run: AgentRunRecord;
  detail: RequirementDetail;
  rawLog: string;
}): EvolutionPainPoint[] {
  if (process.env.WORKBENCH_RSI_DEPTH === "1") return [];
  const recorded: EvolutionPainPoint[] = [];

  // 1. Sniff workbench/CLI/MCP deadEnds logged by the agent
  for (const deadEnd of input.detail.state.handoffNote?.deadEnds ?? []) {
    if (/\b(wb|workbench|cli|mcp|propose|verify|tasks)\b/i.test(deadEnd)) {
      const item = reportPainPoint({
        source: "post_run_dead_end",
        category: "cli_ergonomics",
        title: `工具契约死胡同: ${deadEnd.slice(0, 90)}`,
        detail: `来源需求: ${input.requirementId}\n运行 ID: ${input.run.id} (${input.run.harness}/${input.run.model})\n\nDead-End 记录:\n${deadEnd}`,
        context: {
          projectRoot: input.root,
          requirementId: input.requirementId,
          runId: input.run.id,
        },
      });
      if (item) recorded.push(item);
    }
  }

  // 2. Sniff repeated wb CLI invalid_input friction
  const cliErrors = input.rawLog.match(/错误 \[(?:invalid_input|invalid_transition)\]:[^\n]+/g) ?? [];
  if (cliErrors.length >= 2) {
    const uniqueErrors = Array.from(new Set(cliErrors)).slice(0, 5);
    const item = reportPainPoint({
      source: "agent_friction",
      category: "cli_ergonomics",
      title: `Agent 多次触发 wb CLI 参数错误 (${uniqueErrors[0]!.slice(0, 60)})`,
      detail: `来源需求: ${input.requirementId}\n运行 ID: ${input.run.id}\n命中报错:\n${uniqueErrors.map((e) => `- ${e}`).join("\n")}`,
      context: {
        projectRoot: input.root,
        requirementId: input.requirementId,
        runId: input.run.id,
      },
    });
    if (item) recorded.push(item);
  }

  return recorded;
}

export async function createOrReuseWorktree(
  wbRoot: string,
  reqId: string,
): Promise<SandboxRecord> {
  const base = canonicalRoot(wbRoot);
  const existing = getSandboxForRequirement(base, reqId);
  if (existing) return existing;

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

  const record: SandboxRecord = {
    projectRoot: base,
    requirementId: reqId,
    worktreePath,
    branch,
    createdAt: Date.now(),
  };
  const all = readSandboxes();
  all[sandboxKey(base, reqId)] = record;
  writeSandboxes(all);
  return record;
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
  const base = canonicalRoot(wbRoot);
  const sandbox = getSandboxForRequirement(base, reqId);
  if (!sandbox) {
    throw new WorkbenchError("not_found", `未找到需求 ${reqId} 的活跃 Worktree 沙箱`);
  }

  const wt = sandbox.worktreePath;
  const mainSnap = await observeGitSnapshot(base);
  const baseRef = mainSnap?.head || "HEAD";

  // Collect modified/added tracked files (both committed on branch and uncommitted)
  const diffTracked = execFileSync(
    "git",
    ["-C", wt, "diff", "--name-only", "--diff-filter=ACMRT", baseRef, "--", ".", ":(exclude).workbench"],
    { encoding: "utf8" },
  )
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const untracked = execFileSync(
    "git",
    ["-C", wt, "ls-files", "--others", "--exclude-standard", "--", ".", ":(exclude).workbench"],
    { encoding: "utf8" },
  )
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => Boolean(s) && s !== "node_modules" && !s.startsWith("node_modules/"));

  const deleted = execFileSync(
    "git",
    ["-C", wt, "diff", "--name-only", "--diff-filter=D", baseRef, "--", ".", ":(exclude).workbench"],
    { encoding: "utf8" },
  )
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const appliedFiles = Array.from(new Set([...diffTracked, ...untracked]));
  for (const rel of appliedFiles) {
    const src = path.join(wt, rel);
    const dest = path.join(base, rel);
    if (fs.existsSync(src) && fs.statSync(src).isFile()) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }
  for (const rel of deleted) {
    const dest = path.join(base, rel);
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { force: true });
    }
  }

  // Cleanup worktree and sandbox registry
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

  const all = readSandboxes();
  delete all[sandboxKey(base, reqId)];
  writeSandboxes(all);

  const allTouched = [...appliedFiles, ...deleted];
  const touchesWeb = allTouched.some((f) => f.startsWith("src/web/"));
  const touchesBackend = allTouched.some(
    (f) => f.startsWith("src/server/") || f.startsWith("src/hub/") || f.startsWith("src/core/"),
  );
  return { appliedFiles, deletedFiles: deleted, touchesWeb, touchesBackend };
}

export async function promotePainPoint(
  painId: string,
  options: {
    workbenchRoot?: string;
    createSandbox?: boolean;
  } = {},
): Promise<{
  painPoint: EvolutionPainPoint;
  requirement: RequirementDetail;
  workbenchRoot: string;
  sandbox: SandboxRecord | null;
}> {
  const list = readPainPoints();
  const idx = list.findIndex((p) => p.id === painId);
  if (idx === -1) {
    throw new WorkbenchError("not_found", `未找到痛点记录: ${painId}`);
  }
  const pain = list[idx]!;
  const wbRoot = resolveWorkbenchRepoRoot(options.workbenchRoot);

  if (!isProjectInitialized(wbRoot)) {
    await initProject(wbRoot, { name: path.basename(wbRoot) || "workbench", privacyMode: "local" });
  }

  const ctxLines = [
    `- 来源分类：\`${pain.source}\` / \`${pain.category}\`（累计发生 ${pain.occurrences} 次）`,
    pain.context.projectRoot ? `- 触发项目：\`${pain.context.projectRoot}\`` : "",
    pain.context.requirementId ? `- 关联需求：\`${pain.context.requirementId}\`` : "",
    pain.context.domSelector ? `- 页面元素锚点：\`${pain.context.domSelector}\`` : "",
    pain.context.viewport ? `- 视口与主题：\`${pain.context.viewport}\` (${pain.context.theme ?? "default"})` : "",
  ].filter(Boolean);

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
  ].join("\n");

  const snap = await observeGitSnapshot(wbRoot);
  let detail = await createRequirement(wbRoot, {
    title: `[RSI] ${pain.title}`.slice(0, 115),
    goal: specGoal,
    criteria: [
      { id: "AC-1", description: "TypeScript 类型检查通过", required: true, command: "bun run typecheck" },
      { id: "AC-2", description: "全量测试回归通过", required: true, command: "bun test" },
    ],
    track: "plan_first",
    currentCodeSnapshotHash: snap?.fingerprint ?? null,
  });

  if (pain.category === "ui_anomaly") {
    detail = await propose(wbRoot, detail.state.id, {
      criteria: [
        { id: "AC-1", description: "TypeScript 类型检查通过", required: true, command: "bun run typecheck" },
        {
          id: "AC-2",
          description: "Web UI 浏览器 E2E 与图标契约测试通过",
          required: true,
          command: "bun test tests/web/icons.test.tsx tests/web/e2e_browser.test.ts",
        },
        { id: "AC-3", description: "全量测试回归通过", required: true, command: "bun test" },
      ],
      actor: "human",
      summary: "预设 UI 自进化验证标准",
      currentCodeSnapshotHash: snap?.fingerprint ?? null,
    });
  }

  let sandbox: SandboxRecord | null = null;
  if (options.createSandbox !== false && snap?.head) {
    sandbox = await createOrReuseWorktree(wbRoot, detail.state.id);
  }

  const updated: EvolutionPainPoint = {
    ...pain,
    status: "promoted",
    promotedReqId: detail.state.id,
    updatedAt: Date.now(),
  };
  list[idx] = updated;
  writePainPoints(list);

  return { painPoint: updated, requirement: detail, workbenchRoot: wbRoot, sandbox };
}
