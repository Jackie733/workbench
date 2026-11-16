import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalRoot } from "./fs.ts";
import type { BaselineSnapshot } from "./types.ts";

const GIT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_DIFF_BYTES = 128 * 1024;
const MAX_HASHED_FILES = 2000;
const MAX_SINGLE_FILE_HASH_BYTES = 2 * 1024 * 1024;
const EXCLUDE_PATHSPECS = [":(exclude).workbench", ":(exclude).omp/workbench"];

export interface ChangedFile {
  path: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  at: number;
  subject: string;
}

export interface GitObservation {
  isGitRepo: boolean;
  head: string;
  fingerprint: string | null;
  dirty: boolean;
  files: ChangedFile[];
  diff: string;
  diffTruncated: boolean;
  commits: CommitInfo[];
}

interface ExecResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

function execGit(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
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

  const headRes = await execGit(base, ["rev-parse", "--verify", "HEAD"]);
  const head = headRes.code === 0 ? headRes.stdout.toString("utf8").trim() : "";

  const statusRes = await execGit(base, ["status", "--porcelain=v1", "-z", "-uall", "--", ".", ...EXCLUDE_PATHSPECS]);
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
  const snapshot = await observeGitSnapshot(base);
  if (!snapshot) {
    return {
      isGitRepo: false,
      head: "",
      fingerprint: null,
      dirty: false,
      files: [],
      diff: "",
      diffTruncated: false,
      commits: [],
    };
  }

  const maxDiffBytes = options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
  const statusRes = await execGit(base, ["status", "--porcelain=v1", "-z", "-uall", "--", ".", ...EXCLUDE_PATHSPECS]);
  const entries = statusRes.code === 0 ? parsePorcelainZ(statusRes.stdout) : [];
  entries.sort((a, b) => a.path.localeCompare(b.path));

  const files: ChangedFile[] = entries.map((entry) => ({
    path: entry.path,
    status: entry.xy === "??" ? "??" : entry.xy.trim() || "M",
    staged: entry.xy[0] !== " " && entry.xy[0] !== "?",
    unstaged: entry.xy[1] !== " ",
  }));

  const sinceHead = options.sinceHead && /^[0-9a-f]{7,64}$/i.test(options.sinceHead) ? options.sinceHead : null;
  let validBaseRef: string | null = null;
  if (sinceHead) {
    const verify = await execGit(base, ["rev-parse", "--verify", `${sinceHead}^{commit}`]);
    if (verify.code === 0) validBaseRef = verify.stdout.toString("utf8").trim();
  }

  let diffChunks: string[] = [];
  if (validBaseRef) {
    const diffRes = await execGit(base, ["diff", validBaseRef, "--", ".", ...EXCLUDE_PATHSPECS]);
    if (diffRes.code === 0) {
      const text = diffRes.stdout.toString("utf8");
      if (text) diffChunks.push(text);
    }
  } else if (snapshot.head) {
    const diffRes = await execGit(base, ["diff", "HEAD", "--", ".", ...EXCLUDE_PATHSPECS]);
    if (diffRes.code === 0) {
      const text = diffRes.stdout.toString("utf8");
      if (text) diffChunks.push(text);
    }
  } else {
    const cachedRes = await execGit(base, ["diff", "--cached", "--", ".", ...EXCLUDE_PATHSPECS]);
    if (cachedRes.code === 0) {
      const text = cachedRes.stdout.toString("utf8");
      if (text) diffChunks.push(text);
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

  return {
    isGitRepo: true,
    head: snapshot.head,
    fingerprint: snapshot.fingerprint,
    dirty: snapshot.dirty,
    files,
    diff: boundedDiff.text,
    diffTruncated: boundedDiff.truncated,
    commits,
  };
}
