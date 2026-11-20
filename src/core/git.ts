import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalRoot } from "./fs.ts";
import { WorkbenchError, type StructuredMessageRef } from "./errors.ts";
import { listProjectSandboxes } from "./sandbox.ts";
import { sanitizeOutput, validateGitBranchName } from "./validate.ts";
import {
  MAX_ACCEPTANCE_DIFF_BYTES,
  type BaselineSnapshot,
  type ChangedFile,
  type CommitInfo,
  type DiffEvidenceStatus,
  type GitObservation,
  type UiMessageParams,
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

function execGit(
  cwd: string,
  args: string[],
  timeoutMs = GIT_TIMEOUT_MS,
  stdinText?: string,
  env?: NodeJS.ProcessEnv,
): Promise<ExecResult> {
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
          ...(env ? { env } : {}),
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
      diffReasonKey: "core.diff.notGitRepo",
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
      diffReasonKey: "core.diff.baselineUnavailable",
      diffReasonParams: { head: sinceHead.slice(0, 12) },
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
  let diffReasonKey: string | undefined;
  let diffReasonParams: UiMessageParams | undefined;
  if (validBaseRef) {
    const diffRes = await execGit(base, ["diff", validBaseRef, "--", ".", ...EXCLUDE_PATHSPECS]);
    if (diffRes.code === 0) {
      const text = diffRes.stdout.toString("utf8");
      if (text) diffChunks.push(text);
    } else {
      diffReason = "基线相对 diff 生成失败，评审证据不完整";
      diffReasonKey = "core.diff.baselineDiffFailed";
    }
  } else if (snapshot.head) {
    const diffRes = await execGit(base, ["diff", "HEAD", "--", ".", ...EXCLUDE_PATHSPECS]);
    if (diffRes.code === 0) {
      const text = diffRes.stdout.toString("utf8");
      if (text) diffChunks.push(text);
    } else {
      diffReason = "工作区 diff 生成失败，评审证据不完整";
      diffReasonKey = "core.diff.worktreeDiffFailed";
    }
  } else {
    const cachedRes = await execGit(base, ["diff", "--cached", "--", ".", ...EXCLUDE_PATHSPECS]);
    if (cachedRes.code === 0) {
      const text = cachedRes.stdout.toString("utf8");
      if (text) diffChunks.push(text);
    } else {
      diffReason = "暂存区 diff 生成失败，评审证据不完整";
      diffReasonKey = "core.diff.cachedDiffFailed";
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
    ...(diffReasonKey ? { diffReasonKey } : {}),
    ...(diffReasonParams ? { diffReasonParams } : {}),
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
    throw new WorkbenchError("invalid_input", "请至少选择 1 个要提交的文件", {
      messageKey: "git.errCommitNoFiles",
    });
  }
  const addRes = await execGit(base, ["add", "--", ...files], 30_000);
  if (addRes.code !== 0) {
    const msg = addRes.stderr.toString("utf8").trim() || addRes.stdout.toString("utf8").trim();
    throw new WorkbenchError("execution_failed", `暂存文件失败: ${msg || "git add 返回非零"}`, {
      messageKey: msg ? "git.errStageFailedDetail" : "git.errStageFailed",
      ...(msg ? { messageParams: { detail: msg } } : {}),
    });
  }

  const commitRes = await execGit(base, ["commit", "--only", "-F", "-", "--", ...files], 30_000, commitMessage);
  if (commitRes.code !== 0) {
    const msg = commitRes.stderr.toString("utf8").trim() || commitRes.stdout.toString("utf8").trim();
    throw new WorkbenchError("execution_failed", `创建 Git 提交失败: ${msg || "git commit 返回非零"}`, {
      messageKey: msg ? "git.errCommitFailedDetail" : "git.errCommitFailed",
      ...(msg ? { messageParams: { detail: msg } } : {}),
    });
  }

  const headRes = await execGit(base, ["rev-parse", "HEAD"]);
  const shortRes = await execGit(base, ["rev-parse", "--short", "HEAD"]);
  const branchRes = await execGit(base, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const commitHash = headRes.code === 0 ? headRes.stdout.toString("utf8").trim() : "";
  const shortHash = shortRes.code === 0 ? shortRes.stdout.toString("utf8").trim() : commitHash.slice(0, 7);
  const rawBranch = branchRes.code === 0 ? branchRes.stdout.toString("utf8").trim() : "";
  const branch = rawBranch && rawBranch !== "HEAD" ? rawBranch : null;
  if (!commitHash) {
    throw new WorkbenchError("execution_failed", "提交已创建但无法读取提交哈希", {
      messageKey: "git.errCommitNoHash",
    });
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

const GIT_REF_RE = /^[0-9a-zA-Z._/-]{2,128}$/;

/** Counts commits reachable from headRef that are not in baseRef. */
export async function countCommitsBetween(root: string, baseRef: string, headRef = "HEAD"): Promise<number> {
  const base = canonicalRoot(root);
  if (!baseRef || baseRef.includes("..") || !GIT_REF_RE.test(baseRef)) return 0;
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
  if (!baseRef || baseRef.includes("..") || !GIT_REF_RE.test(baseRef)) return [];
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
    throw new WorkbenchError("revision_conflict", `本地分支 ${safeBranch} 已存在，请换用其他分支名或先切换过去`, {
      messageKey: "git.errBranchExists",
      messageParams: { branch: safeBranch },
    });
  }
  const createRes = await execGit(base, ["checkout", "-b", safeBranch], 15_000);
  if (createRes.code !== 0) {
    const msg = sanitizeOutput(createRes.stderr.toString("utf8").trim() || createRes.stdout.toString("utf8").trim(), 512).text;
    throw new WorkbenchError("execution_failed", `创建分支 ${safeBranch} 失败: ${msg || "git checkout -b 返回非零"}`, {
      messageKey: msg ? "git.errCreateBranchFailedDetail" : "git.errCreateBranchFailed",
      messageParams: msg ? { branch: safeBranch, detail: msg } : { branch: safeBranch },
    });
  }
  return safeBranch;
}

/** Pushes branchName to remote (defaults to origin) with upstream tracking. */
export async function pushBranchToRemote(
  root: string,
  branchName: string,
  remote = "origin",
  options: { forceWithLease?: boolean } = {},
): Promise<void> {
  const base = canonicalRoot(root);
  const safeBranch = validateGitBranchName(branchName);
  const args = options.forceWithLease
    ? ["push", "--force-with-lease", "-u", remote, safeBranch]
    : ["push", "-u", remote, safeBranch];
  const res = await execGit(base, args, 60_000);
  if (res.code !== 0) {
    const raw = res.stderr.toString("utf8").trim() || res.stdout.toString("utf8").trim();
    const msg = sanitizeOutput(raw, 800).text;
    throw new WorkbenchError("execution_failed", `推送分支 ${safeBranch} 至 ${remote} 失败: ${msg || "git push 返回非零"}`, {
      messageKey: msg ? "git.errPushFailedDetail" : "git.errPushFailed",
      messageParams: msg ? { branch: safeBranch, remote, detail: msg } : { branch: safeBranch, remote },
    });
  }
}

/** Fetches remote tracking ref `<remote>/<branchName>` without modifying any working tree. */
export async function fetchRemoteBranch(
  root: string,
  branchName: string,
  remote = "origin",
  timeoutMs = 15_000,
): Promise<{ ok: boolean; error?: string }> {
  const base = canonicalRoot(root);
  const safeBranch = validateGitBranchName(branchName);
  try {
    const remoteUrl = await getGitRemoteUrl(base, remote);
    if (!remoteUrl) return { ok: false, error: "no remote" };
    const res = await execGit(base, ["fetch", remote, safeBranch], timeoutMs);
    if (res.code !== 0) {
      return { ok: false, error: sanitizeOutput(res.stderr.toString("utf8").trim(), 400).text || "git fetch failed" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function revParseCommit(repoDir: string, ref: string): Promise<string | null> {
  try {
    const res = await execGit(repoDir, ["rev-parse", "--verify", `${ref}^{commit}`]);
    if (res.code !== 0) return null;
    const oid = res.stdout.toString("utf8").trim();
    return /^[0-9a-f]{7,64}$/i.test(oid) ? oid : null;
  } catch {
    return null;
  }
}

async function isAncestorCommit(repoDir: string, ancestor: string, descendant: string): Promise<boolean> {
  if (!ancestor || !descendant) return false;
  try {
    const res = await execGit(repoDir, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return res.code === 0;
  } catch {
    return false;
  }
}

export interface TargetMainRefInfo {
  baseBranch: string;
  refName: string;
  oid: string;
  localOid: string | null;
  remoteOid: string | null;
  remoteAheadCount: number;
}

/**
 * Resolves the freshest main integration target across local baseBranch (or HEAD) and origin/<baseBranch>,
 * allowing isolated worktrees to track origin/<baseBranch> even when the main checkout is dirty or on another branch.
 */
export async function resolveTargetMainRef(
  root: string,
  preferredBaseBranch?: string | null,
  remote = "origin",
): Promise<TargetMainRefInfo | null> {
  const base = canonicalRoot(root);
  const baseBranch = preferredBaseBranch?.trim() || (await resolveDefaultBaseBranch(base, remote)) || "main";
  const headOid = await revParseCommit(base, "HEAD");
  const localBranchOid = await revParseCommit(base, `refs/heads/${baseBranch}`);
  const remoteBranchOid = await revParseCommit(base, `refs/remotes/${remote}/${baseBranch}`);

  const localOid = localBranchOid ?? headOid;
  if (!localOid && !remoteBranchOid) return null;

  let refName = localBranchOid ? `refs/heads/${baseBranch}` : "HEAD";
  let oid = localOid ?? remoteBranchOid!;
  let remoteAheadCount = 0;

  if (remoteBranchOid && localOid && remoteBranchOid !== localOid) {
    remoteAheadCount = await countCommitsBetween(base, localOid, remoteBranchOid);
    if (remoteAheadCount > 0 && (await isAncestorCommit(base, localOid, remoteBranchOid))) {
      refName = `${remote}/${baseBranch}`;
      oid = remoteBranchOid;
    }
  } else if (remoteBranchOid && !localOid) {
    refName = `${remote}/${baseBranch}`;
    oid = remoteBranchOid;
  }

  return {
    baseBranch,
    refName,
    oid,
    localOid: localOid ?? null,
    remoteOid: remoteBranchOid ?? null,
    remoteAheadCount,
  };
}

/** Checks local remote-tracking ref for divergence (e.g. stale remote branch from an earlier PR attempt). */
export async function inspectRemoteBranchDivergence(
  root: string,
  branchName: string,
  remote = "origin",
): Promise<{ remoteBranchExists: boolean; behindRemoteCount: number; diverged: boolean }> {
  const base = canonicalRoot(root);
  try {
    const safeBranch = validateGitBranchName(branchName);
    const remoteOid = await revParseCommit(base, `refs/remotes/${remote}/${safeBranch}`);
    if (!remoteOid) {
      return { remoteBranchExists: false, behindRemoteCount: 0, diverged: false };
    }
    const localOid = (await revParseCommit(base, `refs/heads/${safeBranch}`)) ?? (await revParseCommit(base, "HEAD"));
    if (!localOid) {
      return { remoteBranchExists: true, behindRemoteCount: 0, diverged: false };
    }
    if (remoteOid === localOid) {
      return { remoteBranchExists: true, behindRemoteCount: 0, diverged: false };
    }
    const behindRemoteCount = await countCommitsBetween(base, localOid, remoteOid);
    const isFf = await isAncestorCommit(base, remoteOid, localOid);
    return {
      remoteBranchExists: true,
      behindRemoteCount,
      diverged: behindRemoteCount > 0 && !isFf,
    };
  } catch {
    return { remoteBranchExists: false, behindRemoteCount: 0, diverged: false };
  }
}

/**
 * Captures an in-memory Git tree OID for a worktree including uncommitted & untracked edits
 * (excluding .workbench, .omp/workbench, and node_modules) without mutating the real index or files.
 */
export async function captureWorkingTreeTreeOid(wtDir: string, headRef = "HEAD"): Promise<string> {
  const wt = canonicalRoot(wtDir);
  const statusRes = await execGit(wt, ["status", "--porcelain=v1", "-z", "-uall", "--", ".", ...EXCLUDE_PATHSPECS]);
  const entries = statusRes.code === 0 ? parsePorcelainZ(statusRes.stdout) : [];
  const dirtyPaths: string[] = [];
  for (const entry of entries) {
    if (!entry.path || entry.path === "node_modules" || entry.path.startsWith("node_modules/")) continue;
    dirtyPaths.push(entry.path);
    if (entry.origPath && entry.origPath !== "node_modules" && !entry.origPath.startsWith("node_modules/")) {
      dirtyPaths.push(entry.origPath);
    }
  }
  const uniquePaths = Array.from(new Set(dirtyPaths));
  if (uniquePaths.length === 0) {
    const headOid = await revParseCommit(wt, headRef);
    return headOid ?? headRef;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-git-idx-"));
  const tmpIndex = path.join(tmpDir, "index");
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    const readRes = await execGit(wt, ["read-tree", headRef], GIT_TIMEOUT_MS, undefined, env);
    if (readRes.code !== 0) {
      return (await revParseCommit(wt, headRef)) ?? headRef;
    }
    for (let i = 0; i < uniquePaths.length; i += 100) {
      const chunk = uniquePaths.slice(i, i + 100);
      await execGit(wt, ["add", "-A", "--", ...chunk], 30_000, undefined, env);
    }
    const treeRes = await execGit(wt, ["write-tree"], GIT_TIMEOUT_MS, undefined, env);
    if (treeRes.code === 0) {
      const treeOid = treeRes.stdout.toString("utf8").trim();
      if (/^[0-9a-f]{7,64}$/i.test(treeOid)) {
        const headOid = await revParseCommit(wt, headRef);
        const commitEnv: NodeJS.ProcessEnv = {
          ...process.env,
          GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "Workbench",
          GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "workbench@local",
          GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "Workbench",
          GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "workbench@local",
        };
        const commitArgs = headOid
          ? ["commit-tree", treeOid, "-p", headOid, "-m", "wb-wip-snapshot"]
          : ["commit-tree", treeOid, "-m", "wb-wip-snapshot"];
        const commitRes = await execGit(wt, commitArgs, GIT_TIMEOUT_MS, undefined, commitEnv);
        if (commitRes.code === 0) {
          const commitOid = commitRes.stdout.toString("utf8").trim();
          if (/^[0-9a-f]{7,64}$/i.test(commitOid)) return commitOid;
        }
      }
    }
    return (await revParseCommit(wt, headRef)) ?? headRef;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export interface MergeTreeConflictResult {
  clean: boolean;
  conflictFiles: string[];
  unavailable: boolean;
}

/**
 * Runs in-memory 3-way merge conflict detection via `git merge-tree --write-tree` (Git 2.38+)
 * without touching any working tree or index.
 */
export async function inspectMergeTreeConflict(
  repoDir: string,
  options: { baseRef?: string; leftRef: string; rightRef: string },
): Promise<MergeTreeConflictResult> {
  const base = canonicalRoot(repoDir);
  const args = [
    "merge-tree",
    "--write-tree",
    "--name-only",
    "-z",
    "--no-messages",
    ...(options.baseRef ? [`--merge-base=${options.baseRef}`] : []),
    options.leftRef,
    options.rightRef,
  ];
  try {
    const res = await execGit(base, args, 15_000);
    if (res.code === 0) {
      return { clean: true, conflictFiles: [], unavailable: false };
    }
    if (res.code === 1) {
      const tokens = res.stdout.toString("utf8").split("\0");
      // First NUL token is the resulting tree OID; subsequent non-empty tokens are conflicted filenames.
      const files = Array.from(
        new Set(
          tokens
            .slice(1)
            .map((s) => s.trim())
            .filter(
              (s) =>
                s.length > 0 &&
                s !== ".workbench" &&
                !s.startsWith(".workbench/") &&
                s !== ".omp/workbench" &&
                !s.startsWith(".omp/workbench/") &&
                s !== "node_modules" &&
                !s.startsWith("node_modules/"),
            ),
        ),
      ).sort();
      if (files.length === 0) {
        return { clean: true, conflictFiles: [], unavailable: false };
      }
      return { clean: false, conflictFiles: files, unavailable: false };
    }
    return { clean: false, conflictFiles: [], unavailable: true };
  } catch {
    return { clean: false, conflictFiles: [], unavailable: true };
  }
}

/** Extracts unmerged diff / conflict marker excerpts from a worktree when a merge is already in progress. */
export async function extractMergeConflictContext(wtDir: string, maxBytes = 6144): Promise<string> {
  const wt = canonicalRoot(wtDir);
  try {
    const res = await execGit(wt, ["diff", "--diff-filter=U", "--", ".", ...EXCLUDE_PATHSPECS]);
    if (res.code !== 0) return "";
    const text = res.stdout.toString("utf8").trim();
    if (!text) return "";
    return truncateUtf8(text, maxBytes).text;
  } catch {
    return "";
  }
}

/** Safely fetches and fast-forwards targetBranch in root only when root is clean and on targetBranch. */
export async function fetchAndFastForwardBranch(
  root: string,
  targetBranch: string,
  remote = "origin",
): Promise<{ updated: boolean; reason: string | null; reasonRef?: StructuredMessageRef }> {
  const base = canonicalRoot(root);
  const safeBranch = validateGitBranchName(targetBranch);
  const tree = await inspectWorkingTreeForDelivery(base);
  if (!tree.isGitRepo) {
    return {
      updated: false,
      reason: "主目录不是 Git 仓库",
      reasonRef: { key: "git.ff.notGitRepo" },
    };
  }
  if (tree.branch !== safeBranch) {
    const current = tree.branch ?? "HEAD";
    return {
      updated: false,
      reason: `主仓库当前位于分支 ${current}（非 ${safeBranch}），已保留主仓库现状`,
      reasonRef: { key: "git.ff.branchMismatch", params: { current, target: safeBranch } },
    };
  }
  if (tree.dirty) {
    return {
      updated: false,
      reason: "主仓库存在未提交改动，已跳过自动快进合并，请手工执行 git pull",
      reasonRef: { key: "git.ff.dirtyWorktree" },
    };
  }
  const fetchRes = await execGit(base, ["fetch", remote, safeBranch], 30_000);
  if (fetchRes.code !== 0) {
    const msg = sanitizeOutput(fetchRes.stderr.toString("utf8").trim(), 400).text;
    return {
      updated: false,
      reason: `git fetch 失败: ${msg || "未知错误"}`,
      reasonRef: msg ? { key: "git.ff.fetchFailedDetail", params: { detail: msg } } : { key: "git.ff.fetchFailed" },
    };
  }
  const ffRes = await execGit(base, ["merge", "--ff-only", `${remote}/${safeBranch}`], 20_000);
  if (ffRes.code !== 0) {
    const msg = sanitizeOutput(ffRes.stderr.toString("utf8").trim(), 400).text;
    return {
      updated: false,
      reason: `无法快进合并 ${remote}/${safeBranch}: ${msg || "存在分叉提交"}`,
      reasonRef: msg
        ? { key: "git.ff.mergeFailedDetail", params: { remote, branch: safeBranch, detail: msg } }
        : { key: "git.ff.mergeFailed", params: { remote, branch: safeBranch } },
    };
  }
  return { updated: true, reason: null };
}
