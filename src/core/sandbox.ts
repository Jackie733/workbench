import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkbenchError } from "./errors.ts";
import { atomicWriteJson, canonicalRoot, readJsonStrict, withFileLockSync } from "./fs.ts";
import { assertRequirementId } from "./validate.ts";

export interface SandboxRecord {
  projectRoot: string;
  requirementId: string;
  worktreePath: string;
  branch: string;
  baseHead?: string;
  /** Latest codeSnapshotHash recorded right after a clean main-baseline sync in `done` stage. */
  lastCleanSyncFingerprint?: string;
  createdAt: number;
}

function resolveHubBaseDir(): string {
  const custom = process.env.WORKBENCH_HUB_DIR?.trim();
  return custom ? path.resolve(custom) : path.join(os.homedir(), ".workbench-hub");
}

export function sandboxRegistryPath(): string {
  return path.join(resolveHubBaseDir(), "evolution", "sandboxes.json");
}

export function sandboxLockPath(): string {
  return path.join(resolveHubBaseDir(), "evolution", ".sandboxes.lock");
}

export function sandboxKey(projectRoot: string, requirementId: string): string {
  assertRequirementId(requirementId);
  return `${canonicalRoot(projectRoot)}::${requirementId}`;
}

export function withSandboxLockSync<T>(fn: () => T): T {
  return withFileLockSync(sandboxLockPath(), fn);
}

export function readSandboxes(): Record<string, SandboxRecord> {
  const filePath = sandboxRegistryPath();
  try {
    const raw = readJsonStrict<Record<string, unknown>>(filePath, 256 * 1024);
    const out: Record<string, SandboxRecord> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!v || typeof v !== "object") continue;
      const rec = v as Partial<SandboxRecord>;
      if (
        typeof rec.projectRoot === "string" &&
        typeof rec.requirementId === "string" &&
        typeof rec.worktreePath === "string" &&
        typeof rec.branch === "string" &&
        typeof rec.createdAt === "number"
      ) {
        out[k] = {
          projectRoot: rec.projectRoot,
          requirementId: rec.requirementId,
          worktreePath: rec.worktreePath,
          branch: rec.branch,
          ...(typeof rec.baseHead === "string" ? { baseHead: rec.baseHead } : {}),
          ...(typeof rec.lastCleanSyncFingerprint === "string"
            ? { lastCleanSyncFingerprint: rec.lastCleanSyncFingerprint }
            : {}),
          createdAt: rec.createdAt,
        };
      }
    }
    return out;
  } catch (error) {
    if (error instanceof WorkbenchError && error.code === "not_found") {
      return {};
    }
    return {};
  }
}

export function writeSandboxes(records: Record<string, SandboxRecord>): void {
  const filePath = sandboxRegistryPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  atomicWriteJson(filePath, records);
}

function isValidWorktreeDir(dirPath: string): boolean {
  try {
    const stat = fs.lstatSync(dirPath);
    return !stat.isSymbolicLink() && stat.isDirectory();
  } catch {
    return false;
  }
}

export function getSandboxForRequirement(projectRoot: string, requirementId: string): SandboxRecord | null {
  assertRequirementId(requirementId);
  const key = sandboxKey(projectRoot, requirementId);
  const rec = readSandboxes()[key];
  if (!rec || !isValidWorktreeDir(rec.worktreePath)) return null;
  return rec;
}

export function listProjectSandboxes(projectRoot: string): SandboxRecord[] {
  const base = canonicalRoot(projectRoot);
  return Object.values(readSandboxes()).filter(
    (rec) => rec.projectRoot === base && isValidWorktreeDir(rec.worktreePath),
  );
}

/**
 * Resolves the main project root if cwd points inside an active RSI sandbox worktree.
 */
export function resolveWorkbenchRootFromCwd(cwd: string): string | null {
  let canonicalCwd: string;
  try {
    canonicalCwd = canonicalRoot(cwd);
  } catch {
    return null;
  }
  for (const rec of Object.values(readSandboxes())) {
    if (!isValidWorktreeDir(rec.worktreePath)) continue;
    let wt: string;
    try {
      wt = fs.realpathSync(rec.worktreePath);
    } catch {
      continue;
    }
    if (canonicalCwd === wt || canonicalCwd.startsWith(`${wt}${path.sep}`)) {
      try {
        return canonicalRoot(rec.projectRoot);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Resolves the effective Git / command execution directory for a requirement.
 * Returns the isolated RSI worktree path when an active sandbox exists; otherwise returns canonicalRoot(projectRoot).
 */
export function resolveCodeRoot(projectRoot: string, requirementId?: string): string {
  const base = canonicalRoot(projectRoot);
  if (!requirementId) return base;
  const sandbox = getSandboxForRequirement(base, requirementId);
  return sandbox ? sandbox.worktreePath : base;
}
