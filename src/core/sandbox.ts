import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteJson, canonicalRoot, readJsonStrict } from "./fs.ts";

export interface SandboxRecord {
  projectRoot: string;
  requirementId: string;
  worktreePath: string;
  branch: string;
  createdAt: number;
}

function resolveHubBaseDir(): string {
  const custom = process.env.WORKBENCH_HUB_DIR?.trim();
  return custom ? path.resolve(custom) : path.join(os.homedir(), ".workbench-hub");
}

export function sandboxRegistryPath(): string {
  return path.join(resolveHubBaseDir(), "evolution", "sandboxes.json");
}

export function sandboxKey(projectRoot: string, requirementId: string): string {
  return `${canonicalRoot(projectRoot)}::${requirementId}`;
}

export function readSandboxes(): Record<string, SandboxRecord> {
  const filePath = sandboxRegistryPath();
  if (!fs.existsSync(filePath)) return {};
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
        out[k] = rec as SandboxRecord;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function writeSandboxes(records: Record<string, SandboxRecord>): void {
  const filePath = sandboxRegistryPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  atomicWriteJson(filePath, records);
}

export function getSandboxForRequirement(projectRoot: string, requirementId: string): SandboxRecord | null {
  const key = sandboxKey(projectRoot, requirementId);
  const rec = readSandboxes()[key];
  if (!rec || !fs.existsSync(rec.worktreePath)) return null;
  return rec;
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
