import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalRoot } from "./fs.ts";
import { WorkbenchError } from "./errors.ts";
import { listProjectSandboxes } from "./sandbox.ts";
import { sanitizeOutput, validateGitBranchName } from "./validate.ts";
import {
  MAX_ACCEPTANCE_DIFF_BYTES,
  type BaselineSnapshot,
  type ChangedFile,
  type CommitInfo,
  type DiffEvidenceStatus,
  type GitObservation,
} from "./types.ts";

export type { BaselineSnapshot, ChangedFile, CommitInfo, GitObservation } from "./types.ts";

const GIT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_DIFF_BYTES = MAX_ACCEPTANCE_DIFF_BYTES;
const MAX_HASHED_FILES = 2000;
const MAX_SINGLE_FILE_HASH_BYTES = 2 * 1024 * 1024;
const EXCLUDE_PATHSPECS = [":(exclude).workbench", ":(exclude).omp/workbench"];

interface ExecResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

function execGit(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS, stdinText?: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(cwd)) {
      reject(Object.assign(new Error(`cwd no longer exists: ${cwd}`), { code: "ENOENT" }));
      return;
    }
    try {
      const child = execFile(
        "git",
        args,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          encoding: "buffer",
        },
        (error, stdout, stderr) => {
          if (error && typeof (error as NodeJS.ErrnoException).code === "string") {
            reject(error);
            return;
          }
          const exitCode =
            error && typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code: number }).code ?? 1)
              : 0;
          resolve({
            code: exitCode,
            stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ""),
            stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? ""),
          });
        },
      );
      if (stdinText !== undefined) {
        child.stdin?.end(stdinText, "utf8");
      }
    } catch (err) {
      reject(err);
    }
  });
}

function parsePorcelainZ(buf: Buffer): Array<{ xy: string; path: string; origPath?: string }> {
  const entries: Array<{ xy: string; path: string; origPath?: string }> = [];
  const raw = buf.toString("utf8");
  const tokens = raw.split("\0");
  let i = 0;
  while (i < tokens.length) {
    const entry = tokens[i]!;
    i += 1;
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (!filePath) continue;
    if (xy[0] === "R" || xy[0] === "C") {
      const origPath = tokens[i] ?? "";
      i += 1;
      entries.push({ xy, path: filePath, origPath });
    } else {
      entries.push({ xy, path: filePath });
    }
  }
  return entries;
}

function hashWorkingEntry(base: string, relPath: string): string {
  const full = path.join(base, relPath);
  try {
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) {
      return `symlink:${fs.readlinkSync(full)}`;
    }
    if (stat.isDirectory()) {
      return "dir";
    }
    if (!stat.isFile()) {
      return "other";
    }
    if (stat.size > MAX_SINGLE_FILE_HASH_BYTES) {
      return `large:${stat.size}:${stat.mtimeMs}`;
    }
    const bytes = fs.readFileSync(full);
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    return "missing";
  }
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

/** Files whose patch body the existing renderer deliberately omits (binary payloads, oversized untracked files). */
export function detectOmittedDiffContent(diff: string): { binaryFiles: string[]; omittedFiles: string[] } {
  const binary = new Set<string>();
  const omitted = new Set<string>();
  let currentFile = "";
  for (const line of diff.split("\n")) {
    const gitHeader = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
    if (gitHeader) {
      currentFile = gitHeader[2]!;
      continue;
    }
    if (/^\+\[untracked file \d+ bytes omitted\]$/.test(line) && currentFile) {
      omitted.add(currentFile);
      continue;
    }
    const binaryHeader = /^Binary files (?:\/dev\/null|a\/(\S+)) and (?:\/dev\/null|b\/(\S+)) differ$/.exec(line);
    if (binaryHeader) {
      binary.add(binaryHeader[1] ?? binaryHeader[2] ?? currentFile);
    }
  }
  return { binaryFiles: [...binary].filter(Boolean).sort(), omittedFiles: [...omitted].sort() };
}

/** Parses `git diff --name-status -z` output: status, then one (or two for R/C) NUL-terminated paths. */
function parseNameStatusZ(buf: Buffer): Array<{ status: string; path: string }> {
  const tokens = buf.toString("utf8").split("\0");
  const out: Array<{ status: string; path: string }> = [];
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i] ?? "";
    i += 1;
    if (!status) continue;
    const code = status[0]!;
    if (code === "R" || code === "C") {
      const newPath = tokens[i + 1] ?? "";
      i += 2;
      if (newPath) out.push({ status: code, path: newPath });
      continue;
    }
    const filePath = tokens[i] ?? "";
    i += 1;
    if (filePath) out.push({ status: code, path: filePath });
  }
  return out;
}

function formatUntrackedDiff(base: string, relPath: string): string {
  const full = path.join(base, relPath);
  try {
    const stat = fs.lstatSync(full);
    if (!stat.isFile() || stat.isSymbolicLink()) return "";
    if (stat.size > 64 * 1024) {
      return `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1 @@\n+[untracked file ${stat.size} bytes omitted]\n`;
    }
    const bytes = fs.readFileSync(full);
    if (bytes.includes(0)) {
      return `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\nBinary files /dev/null and b/${relPath} differ\n`;
    }
    const content = bytes.toString("utf8");
    const lines = content.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const body = lines.map((line) => `+${line}`).join("\n");
    return `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${Math.max(1, lines.length)} @@\n${body}\n`;
  } catch {
    return "";
  }
}

/** Captures a fast, deterministic workspace snapshot excluding .workbench/ metadata. */
export async function observeGitSnapshot(root: string): Promise<BaselineSnapshot | null> {
  const base = canonicalRoot(root);
  let inside: ExecResult;
  try {
    inside = await execGit(base, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return null;
  }
  if (inside.code !== 0 || inside.stdout.toString("utf8").trim() !== "true") {
    return null;
  }

  let headRes: ExecResult;
  let statusRes: ExecResult;
  try {
    headRes = await execGit(base, ["rev-parse", "--verify", "HEAD"]);
    statusRes = await execGit(base, ["status", "--porcelain=v1", "-z", "-uall", "--", ".", ...EXCLUDE_PATHSPECS]);
  } catch {
    return null;
  }
  const head = headRes.code === 0 ? headRes.stdout.toString("utf8").trim() : "";
  const entries = statusRes.code === 0 ? parsePorcelainZ(statusRes.stdout) : [];
  entries.sort((a, b) => a.path.localeCompare(b.path));

  const hash = createHash("sha256");
  hash.update(`head:${head}\n`);
  for (let i = 0; i < Math.min(entries.length, MAX_HASHED_FILES); i++) {
    const entry = entries[i]!;
    const contentHash = entry.xy[1] === "D" || entry.xy[0] === "D" ? "deleted" : hashWorkingEntry(base, entry.path);
    hash.update(`${entry.xy}:${entry.path}:${contentHash}\n`);
  }
  if (entries.length > MAX_HASHED_FILES) {
    hash.update(`truncated:${entries.length}`);
  }

  return {
    head,
    fingerprint: hash.digest("hex"),
    dirty: entries.length > 0,
    capturedAt: Date.now(),
  };
}

/** Collects current git snapshot, changed files, commits since baseline, and unified diff. */
export async function observeGitChanges(
  root: string,
  options: { sinceHead?: string | null; maxDiffBytes?: number } = {},
): Promise<GitObservation> {
  const base = canonicalRoot(root);
  const capturedAt = Date.now();
  const maxDiffBytes = options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
  const empty = (
    overrides: Partial<GitObservation>,
  ): GitObservation => ({
    isGitRepo: true,
    head: "",
    fingerprint: null,
    dirty: false,
    files: [],
    filesScope: "none",
    diff: "",
    diffBytes: 0,
    diffTruncated: false,
    diffStatus: "unavailable",
    diffReason: null,
    binaryFiles: [],
    omittedFiles: [],
    baselineRequested: options.sinceHead ?? null,
    baselineHead: null,
    baselineAvailable: false,
    commits: [],
    capturedAt,
    ...overrides,
  });

  const snapshot = await observeGitSnapshot(base);
  if (!snapshot) {
    return empty({
      isGitRepo: false,
      diffReason: "代码根目录不是 Git 仓库，无法采集评审 Diff",
    });
  }

  const statusRes = await execGit(base, ["status", "--porcelain=v1", "-z", "-uall", "--", ".", ...EXCLUDE_PATHSPECS]);
  const entries = statusRes.code === 0 ? parsePorcelainZ(statusRes.stdout) : [];
  entries.sort((a, b) => a.path.localeCompare(b.path));

  const sinceHead = options.sinceHead && /^[0-9a-f]{7,64}$/i.test(options.sinceHead) ? options.sinceHead : null;
  let validBaseRef: string | null = null;
  if (sinceHead) {
    const verify = await execGit(base, ["rev-parse", "--verify", `${sinceHead}^{commit}`]);
    if (verify.code === 0) validBaseRef = verify.stdout.toString("utf8").trim();
  }

  if (sinceHead && !validBaseRef) {
    return empty({
      head: snapshot.head,
      fingerprint: snapshot.fingerprint,
      dirty: snapshot.dirty,
      diffReason: `验收基线 ${sinceHead.slice(0, 12)} 在当前仓库中不可用，无法生成基线相对 Diff`,
    });
  }

  const files = new Map<string, ChangedFile>();
  if (validBaseRef) {
    const nameRes = await execGit(base, [
      "diff",
      "--name-status",
      "-z",
      validBaseRef,
      "--",
      ".",
      ...EXCLUDE_PATHSPECS,
    ]);
    if (nameRes.code === 0) {
      for (const entry of parseNameStatusZ(nameRes.stdout)) {
        files.set(entry.path, { path: entry.path, status: entry.status, staged: false, unstaged: false });
      }
    }
  }
  for (const entry of entries) {
    const staged = entry.xy[0] !== " " && entry.xy[0] !== "?";
    const unstaged = entry.xy[1] !== " ";
    const existing = files.get(entry.path);
    if (existing) {
      files.set(entry.path, { ...existing, staged, unstaged });
    } else {
      files.set(entry.path, {
        path: entry.path,
        status: entry.xy === "??" ? "??" : entry.xy.trim() || "M",
        staged,
        unstaged,
      });
    }
  }
  const fileList = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));

  let diffChunks: string[] = [];
  let diffReason: string | null = null;
  if (validBaseRef) {
    const diffRes = await execGit(base, ["diff", validBaseRef, "--", ".", ...EXCLUDE_PATHSPECS]);
    if (diffRes.code === 0) {
      const text = diffRes.stdout.toString("utf8");
      if (text) diffChunks.push(text);
    } else {
      diffReason = "基线相对 diff 生成失败，评审证据不完整";
    }
  } else if (snapshot.head) {
    const diffRes = await execGit(base, ["diff", "HEAD", "--", ".", ...EXCLUDE_PATHSPECS]);
    if (diffRes.code === 0) {
      const text = diffRes.stdout.toString("utf8");
      if (text) diffChunks.push(text);
    } else {
      diffReason = "工作区 diff 生成失败，评审证据不完整";
    }
  } else {
    const cachedRes = await execGit(base, ["diff", "--cached", "--", ".", ...EXCLUDE_PATHSPECS]);
    if (cachedRes.code === 0) {
      const text = cachedRes.stdout.toString("utf8");
      if (text) diffChunks.push(text);
    } else {
      diffReason = "暂存区 diff 生成失败，评审证据不完整";
    }
  }

  for (const entry of entries) {
    if (entry.xy === "??") {
      const patch = formatUntrackedDiff(base, entry.path);
      if (patch) diffChunks.push(patch);
    }
  }

  const combinedDiff = diffChunks.join(diffChunks.length > 1 ? "\n" : "");
  const boundedDiff = truncateUtf8(combinedDiff, maxDiffBytes);
  const omitted = detectOmittedDiffContent(boundedDiff.text);

  // If sinceHead was provided and differs from HEAD, include commit history since baseline.
  const commits: CommitInfo[] = [];
  if (validBaseRef && snapshot.head && validBaseRef !== snapshot.head) {
    const logRes = await execGit(base, [
      "log",
      "--format=%H%x00%h%x00%an%x00%ct%x00%s",
      "-n",
      "30",
      `${validBaseRef}..HEAD`,
    ]);
    if (logRes.code === 0) {
      for (const line of logRes.stdout.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        const [hash = "", shortHash = "", author = "", ts = "0", ...subjectParts] = line.split("\0");
        commits.push({
          hash,
          shortHash,
          author,
          at: Number(ts) * 1000,
          subject: subjectParts.join("\0"),
        });
      }
    }
  }

  const diffText = diffReason ? "" : boundedDiff.text;
  const diffStatus: DiffEvidenceStatus = diffReason ? "unavailable" : diffText ? "captured" : "empty";

  return {
    isGitRepo: true,
    head: snapshot.head,
    fingerprint: snapshot.fingerprint,
    dirty: snapshot.dirty,
    files: fileList,
    filesScope: validBaseRef ? "baseline-relative" : "worktree",
    diff: diffText,
    diffBytes: Buffer.byteLength(diffText, "utf8"),
    diffTruncated: diffStatus === "captured" ? boundedDiff.truncated : false,
    diffStatus,
    diffReason,
    binaryFiles: diffStatus === "captured" ? omitted.binaryFiles : [],
    omittedFiles: diffStatus === "captured" ? omitted.omittedFiles : [],
    baselineRequested: sinceHead,
    baselineHead: validBaseRef,
    baselineAvailable: sinceHead ? validBaseRef !== null : true,
    commits,
    capturedAt,
  };
}

/**
 * Resolves the repository base snapshot plus per-requirement snapshots for active RSI sandboxes.
 * Avoids extra git spawns when no active sandbox exists for the project.
 */
export async function resolveProjectRequirementSnapshots(root: string): Promise<{
  baseSnapshot: BaselineSnapshot | null;
  byReqId: Map<string, string | null>;
}> {
  const base = canonicalRoot(root);
  const baseSnapshot = await observeGitSnapshot(base);
  const sandboxes = listProjectSandboxes(base);
  const byReqId = new Map<string, string | null>();
  if (sandboxes.length > 0) {
    await Promise.all(
      sandboxes.map(async (sb) => {
        const snap = await observeGitSnapshot(sb.worktreePath);
        byReqId.set(sb.requirementId, snap?.fingerprint ?? null);
      }),
    );
  }
  return { baseSnapshot, byReqId };
}

/** Reads current branch, HEAD, and uncommitted files (excluding .workbench metadata) for delivery wrap-up. */
export async function inspectWorkingTreeForDelivery(root: string): Promise<{
  isGitRepo: boolean;
  branch: string | null;
  head: string | null;
  dirty: boolean;
  files: ChangedFile[];
}> {
  const base = canonicalRoot(root);
  const snapshot = await observeGitSnapshot(base);
  if (!snapshot) {
    return { isGitRepo: false, branch: null, head: null, dirty: false, files: [] };
  }
  let branch: string | null = null;
  if (snapshot.head) {
    const branchRes = await execGit(base, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branchRes.code === 0) {
      const name = branchRes.stdout.toString("utf8").trim();
      if (name && name !== "HEAD") branch = name;
    }
  }
  const statusRes = await execGit(base, ["status", "--porcelain=v1", "-z", "-uall", "--", ".", ...EXCLUDE_PATHSPECS]);
  const entries = statusRes.code === 0 ? parsePorcelainZ(statusRes.stdout) : [];
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const files: ChangedFile[] = entries.map((entry) => ({
    path: entry.path,
    status: entry.xy === "??" ? "??" : entry.xy.trim() || "M",
    staged: entry.xy[0] !== " " && entry.xy[0] !== "?",
    unstaged: entry.xy[1] !== " ",
  }));
  return {
    isGitRepo: true,
    branch,
    head: snapshot.head || null,
    dirty: files.length > 0,
    files,
  };
}

/** Stages and commits ONLY the specified files using --only so unrelated staged changes are not swept in. */
export async function commitFilesInGit(
  root: string,
  files: string[],
  commitMessage: string,
): Promise<{ commitHash: string; shortHash: string; branch: string | null }> {
  const base = canonicalRoot(root);
  if (files.length === 0) {
    throw new WorkbenchError("invalid_input", "请至少选择 1 个要提交的文件");
  }
  const addRes = await execGit(base, ["add", "--", ...files], 30_000);
  if (addRes.code !== 0) {
    const msg = addRes.stderr.toString("utf8").trim() || addRes.stdout.toString("utf8").trim();
    throw new WorkbenchError("execution_failed", `暂存文件失败: ${msg || "git add 返回非零"}`);
  }

  const commitRes = await execGit(base, ["commit", "--only", "-F", "-", "--", ...files], 30_000, commitMessage);
  if (commitRes.code !== 0) {
    const msg = commitRes.stderr.toString("utf8").trim() || commitRes.stdout.toString("utf8").trim();
    throw new WorkbenchError("execution_failed", `创建 Git 提交失败: ${msg || "git commit 返回非零"}`);
  }

  const headRes = await execGit(base, ["rev-parse", "HEAD"]);
  const shortRes = await execGit(base, ["rev-parse", "--short", "HEAD"]);
  const branchRes = await execGit(base, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const commitHash = headRes.code === 0 ? headRes.stdout.toString("utf8").trim() : "";
  const shortHash = shortRes.code === 0 ? shortRes.stdout.toString("utf8").trim() : commitHash.slice(0, 7);
  const rawBranch = branchRes.code === 0 ? branchRes.stdout.toString("utf8").trim() : "";
  const branch = rawBranch && rawBranch !== "HEAD" ? rawBranch : null;
  if (!commitHash) {
    throw new WorkbenchError("execution_failed", "提交已创建但无法读取提交哈希");
  }
  return { commitHash, shortHash, branch };
}

/** Reads current HEAD commit hash, short hash, subject, and branch name. */
export async function getHeadCommitInfo(root: string): Promise<{
  commitHash: string;
  shortHash: string;
  subject: string;
  branch: string | null;
} | null> {
  const base = canonicalRoot(root);
  const headRes = await execGit(base, ["rev-parse", "--verify", "HEAD"]);
  if (headRes.code !== 0) return null;
  const commitHash = headRes.stdout.toString("utf8").trim();
  const shortRes = await execGit(base, ["rev-parse", "--short", "HEAD"]);
  const subjRes = await execGit(base, ["log", "-1", "--format=%s", "HEAD"]);
  const branchRes = await execGit(base, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const shortHash = shortRes.code === 0 ? shortRes.stdout.toString("utf8").trim() : commitHash.slice(0, 7);
  const subject = subjRes.code === 0 ? subjRes.stdout.toString("utf8").trim() : "";
  const rawBranch = branchRes.code === 0 ? branchRes.stdout.toString("utf8").trim() : "";
  return {
    commitHash,
    shortHash,
    subject,
    branch: rawBranch && rawBranch !== "HEAD" ? rawBranch : null,
  };
}

/** Reads the configured URL of a Git remote (defaults to origin), or null if unavailable. */
export async function getGitRemoteUrl(root: string, remote = "origin"): Promise<string | null> {
  const base = canonicalRoot(root);
  try {
    const res = await execGit(base, ["remote", "get-url", remote]);
    if (res.code !== 0) return null;
    const url = res.stdout.toString("utf8").trim();
    return url || null;
  } catch {
    return null;
  }
}

/** Resolves the repository's default base branch from origin/HEAD or common branch names. */
export async function resolveDefaultBaseBranch(root: string, remote = "origin"): Promise<string | null> {
  const base = canonicalRoot(root);
  try {
    const sym = await execGit(base, ["symbolic-ref", `refs/remotes/${remote}/HEAD`]);
    if (sym.code === 0) {
      const ref = sym.stdout.toString("utf8").trim();
      const prefix = `refs/remotes/${remote}/`;
      if (ref.startsWith(prefix)) {
        const name = ref.slice(prefix.length).trim();
        if (name) return name;
      }
    }
    for (const candidate of ["main", "master"]) {
      const remoteRef = await execGit(base, ["rev-parse", "--verify", `refs/remotes/${remote}/${candidate}`]);
      if (remoteRef.code === 0) return candidate;
    }
    for (const candidate of ["main", "master"]) {
      const localRef = await execGit(base, ["rev-parse", "--verify", `refs/heads/${candidate}`]);
      if (localRef.code === 0) return candidate;
    }
    const cur = await execGit(base, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (cur.code === 0) {
      const name = cur.stdout.toString("utf8").trim();
      if (name && name !== "HEAD") return name;
    }
  } catch {
    // Ignore git inspection failures.
  }
  return null;
}

/** Counts commits reachable from headRef that are not in baseRef. */
export async function countCommitsBetween(root: string, baseRef: string, headRef = "HEAD"): Promise<number> {
  const base = canonicalRoot(root);
  if (!baseRef || !/^[0-9a-fA-Z._/-]{2,128}$/.test(baseRef)) return 0;
  try {
    const res = await execGit(base, ["rev-list", "--count", `${baseRef}..${headRef}`]);
    if (res.code !== 0) return 0;
    const count = Number(res.stdout.toString("utf8").trim());
    return Number.isSafeInteger(count) && count >= 0 ? count : 0;
  } catch {
    return 0;
  }
}

/** Lists non-workbench files changed between baseRef and headRef. */
export async function listCommittedFilesBetween(root: string, baseRef: string, headRef = "HEAD"): Promise<string[]> {
  const base = canonicalRoot(root);
  if (!baseRef || !/^[0-9a-fA-Z._/-]{2,128}$/.test(baseRef)) return [];
  try {
    const res = await execGit(base, [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      `${baseRef}..${headRef}`,
      "--",
      ".",
      ...EXCLUDE_PATHSPECS,
    ]);
    if (res.code !== 0) return [];
    return res.stdout.toString("utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

/** Creates and checks out a feature branch at current HEAD, or switches to it if already at HEAD. */
export async function createFeatureBranchAtHead(root: string, branchName: string): Promise<string> {
  const base = canonicalRoot(root);
  const safeBranch = validateGitBranchName(branchName);
  const curRes = await execGit(base, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const curBranch = curRes.code === 0 ? curRes.stdout.toString("utf8").trim() : "";
  if (curBranch === safeBranch) return safeBranch;

  const exists = await execGit(base, ["rev-parse", "--verify", `refs/heads/${safeBranch}`]);
  if (exists.code === 0) {
    throw new WorkbenchError("revision_conflict", `本地分支 ${safeBranch} 已存在，请换用其他分支名或先切换过去`);
  }
  const createRes = await execGit(base, ["checkout", "-b", safeBranch], 15_000);
  if (createRes.code !== 0) {
    const msg = sanitizeOutput(createRes.stderr.toString("utf8").trim() || createRes.stdout.toString("utf8").trim(), 512).text;
    throw new WorkbenchError("execution_failed", `创建分支 ${safeBranch} 失败: ${msg || "git checkout -b 返回非零"}`);
  }
  return safeBranch;
}

/** Pushes branchName to remote (defaults to origin) with upstream tracking. */
export async function pushBranchToRemote(root: string, branchName: string, remote = "origin"): Promise<void> {
  const base = canonicalRoot(root);
  const safeBranch = validateGitBranchName(branchName);
  const res = await execGit(base, ["push", "-u", remote, safeBranch], 60_000);
  if (res.code !== 0) {
    const raw = res.stderr.toString("utf8").trim() || res.stdout.toString("utf8").trim();
    const msg = sanitizeOutput(raw, 800).text;
    throw new WorkbenchError("execution_failed", `推送分支 ${safeBranch} 至 ${remote} 失败: ${msg || "git push 返回非零"}`);
  }
}

/** Safely fetches and fast-forwards targetBranch in root only when root is clean and on targetBranch. */
export async function fetchAndFastForwardBranch(
  root: string,
  targetBranch: string,
  remote = "origin",
): Promise<{ updated: boolean; reason: string | null }> {
  const base = canonicalRoot(root);
  const safeBranch = validateGitBranchName(targetBranch);
  const tree = await inspectWorkingTreeForDelivery(base);
  if (!tree.isGitRepo) {
    return { updated: false, reason: "主目录不是 Git 仓库" };
  }
  if (tree.branch !== safeBranch) {
    return { updated: false, reason: `主仓库当前位于分支 ${tree.branch ?? "HEAD"}（非 ${safeBranch}），已保留主仓库现状` };
  }
  if (tree.dirty) {
    return { updated: false, reason: "主仓库存在未提交改动，已跳过自动快进合并，请手工执行 git pull" };
  }
  const fetchRes = await execGit(base, ["fetch", remote, safeBranch], 30_000);
  if (fetchRes.code !== 0) {
    const msg = sanitizeOutput(fetchRes.stderr.toString("utf8").trim(), 400).text;
    return { updated: false, reason: `git fetch 失败: ${msg || "未知错误"}` };
  }
  const ffRes = await execGit(base, ["merge", "--ff-only", `${remote}/${safeBranch}`], 20_000);
  if (ffRes.code !== 0) {
    const msg = sanitizeOutput(ffRes.stderr.toString("utf8").trim(), 400).text;
    return { updated: false, reason: `无法快进合并 ${remote}/${safeBranch}: ${msg || "存在分叉提交"}` };
  }
  return { updated: true, reason: null };
}
