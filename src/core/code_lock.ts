import { randomUUID } from "node:crypto";
import { WorkbenchError } from "./errors.ts";
import { canonicalRoot } from "./fs.ts";

export type CodeRootLockMode = "read" | "write";

export interface CodeRootLockOwner {
  kind: string;
  requirementId?: string;
  runId?: string;
}

export interface CodeRootLockLease {
  id: string;
  codeRoot: string;
  mode: CodeRootLockMode;
  owner: CodeRootLockOwner;
  release(): void;
}

interface ActiveLeaseRecord {
  id: string;
  mode: CodeRootLockMode;
  owner: CodeRootLockOwner;
  acquiredAt: number;
}

interface RootLockBucket {
  readers: Map<string, ActiveLeaseRecord>;
  writer: ActiveLeaseRecord | null;
}

const rootBuckets = new Map<string, RootLockBucket>();

function formatOwner(owner: CodeRootLockOwner): string {
  const parts = [owner.requirementId, owner.kind].filter(Boolean);
  return parts.length > 0 ? parts.join(" / ") : "unknown";
}

function getOrCreateBucket(canonicalDir: string): RootLockBucket {
  let bucket = rootBuckets.get(canonicalDir);
  if (!bucket) {
    bucket = { readers: new Map(), writer: null };
    rootBuckets.set(canonicalDir, bucket);
  }
  return bucket;
}

function cleanupBucketIfEmpty(canonicalDir: string): void {
  const bucket = rootBuckets.get(canonicalDir);
  if (bucket && !bucket.writer && bucket.readers.size === 0) {
    rootBuckets.delete(canonicalDir);
  }
}

/**
 * Acquires a standard read-write lock scoped to a canonical `codeRoot`.
 * - Multiple concurrent readers (`ask`, `review`) are allowed on the same `codeRoot`.
 * - Writers (`implement`, `fix`, `verify`, `wip`) require exclusive access (no active readers or writers).
 * - If `options.parentLeaseId` matches the active write lease on the same `codeRoot`, returns a no-op re-entrant lease
 *   so post-run WIP checkpoint and auto-verification can run safely under the owning job's exclusive lock.
 */
export function acquireCodeRootLock(
  codeRoot: string,
  mode: CodeRootLockMode,
  owner: CodeRootLockOwner,
  options: { parentLeaseId?: string } = {},
): CodeRootLockLease {
  const canonicalDir = canonicalRoot(codeRoot);
  const bucket = getOrCreateBucket(canonicalDir);

  if (options.parentLeaseId && bucket.writer && bucket.writer.id === options.parentLeaseId) {
    return {
      id: bucket.writer.id,
      codeRoot: canonicalDir,
      mode,
      owner,
      release() {
        // Re-entrant child lease: lifecycle managed by parent lease.
      },
    };
  }

  if (mode === "read") {
    if (bucket.writer) {
      throw new WorkbenchError(
        "revision_conflict",
        `目录 ${canonicalDir} 当前正被写任务（${formatOwner(bucket.writer.owner)}）占用，请等待其完成后再执行只读任务`,
      );
    }
    const id = `CRL-${randomUUID().slice(0, 12)}`;
    const record: ActiveLeaseRecord = { id, mode: "read", owner, acquiredAt: Date.now() };
    bucket.readers.set(id, record);
    let released = false;
    return {
      id,
      codeRoot: canonicalDir,
      mode: "read",
      owner,
      release() {
        if (released) return;
        released = true;
        bucket.readers.delete(id);
        cleanupBucketIfEmpty(canonicalDir);
      },
    };
  }

  if (bucket.writer) {
    throw new WorkbenchError(
      "revision_conflict",
      `目录 ${canonicalDir} 当前正被写任务（${formatOwner(bucket.writer.owner)}）占用，禁止并发写入同一工作区`,
    );
  }
  if (bucket.readers.size > 0) {
    const readerDesc = Array.from(bucket.readers.values())
      .map((r) => formatOwner(r.owner))
      .slice(0, 3)
      .join("、");
    throw new WorkbenchError(
      "revision_conflict",
      `目录 ${canonicalDir} 当前有只读任务（${readerDesc}）正在执行，请等待其完成后再写入`,
    );
  }

  const id = `CRL-${randomUUID().slice(0, 12)}`;
  const record: ActiveLeaseRecord = { id, mode: "write", owner, acquiredAt: Date.now() };
  bucket.writer = record;
  let released = false;
  return {
    id,
    codeRoot: canonicalDir,
    mode: "write",
    owner,
    release() {
      if (released) return;
      released = true;
      if (bucket.writer?.id === id) {
        bucket.writer = null;
      }
      cleanupBucketIfEmpty(canonicalDir);
    },
  };
}

export async function withCodeRootLock<T>(
  codeRoot: string,
  mode: CodeRootLockMode,
  owner: CodeRootLockOwner,
  fn: (lease: CodeRootLockLease) => Promise<T> | T,
  options: { parentLeaseId?: string } = {},
): Promise<T> {
  const lease = acquireCodeRootLock(codeRoot, mode, owner, options);
  try {
    return await fn(lease);
  } finally {
    lease.release();
  }
}

/** Inspects active locks on a canonical `codeRoot` (primarily for diagnostics and tests). */
export function inspectCodeRootLocks(codeRoot: string): {
  writer: CodeRootLockOwner | null;
  readers: CodeRootLockOwner[];
} {
  const canonicalDir = canonicalRoot(codeRoot);
  const bucket = rootBuckets.get(canonicalDir);
  if (!bucket) return { writer: null, readers: [] };
  return {
    writer: bucket.writer ? { ...bucket.writer.owner } : null,
    readers: Array.from(bucket.readers.values()).map((r) => ({ ...r.owner })),
  };
}
