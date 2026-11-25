import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getProjectStatus,
  getRequirement,
  prepareRequirementForConflictSync,
  recordRequirementGitHubSync,
  syncRequirementBaseline,
} from "./engine.ts";
import { WorkbenchError, type StructuredMessageRef } from "./errors.ts";
import { atomicWriteBuffer, atomicWriteFile, canonicalRoot, readBoundedText, resolveSafePath } from "./fs.ts";
import {
  captureWorkingTreeTreeOid,
  fetchAndFastForwardBranch,
  fetchRemoteBranch,
  getGitRemoteUrl,
  inspectMergeTreeConflict,
  observeGitSnapshot,
  resolveTargetMainRef,
} from "./git.ts";
import { viewGitHubPr, type GitHubCommandDeps } from "./github.ts";
import {
  getSandboxForRequirement,
  listProjectSandboxes,
  readSandboxes,
  sandboxKey,
  withSandboxLockSync,
  writeSandboxes,
  type SandboxRecord,
} from "./sandbox.ts";
import { isProjectInitialized, readRequirementBundle } from "./store.ts";
import {
  MAX_EVIDENCE_BYTES,
  WORKBENCH_DIR,
  type CascadeSyncItemResult,
  type MergeOrderEntry,
  type MergeOrderRecommendation,
  type RequirementDetail,
  type SandboxDriftInfo,
  type SandboxDriftStatus,
  type SiblingConflictInfo,
} from "./types.ts";
import { assertRequirementId } from "./validate.ts";

function resolveHubDataDir(): string {
  const custom = process.env.WORKBENCH_HUB_DIR?.trim();
  return custom ? path.resolve(custom) : path.join(os.homedir(), ".workbench-hub");
}

function worktreesBaseDir(): string {
  return path.join(resolveHubDataDir(), "worktrees");
}

/**
 * Mirrors .workbench/items/<REQ-ID> metadata files (and parent design.md when present) as regular files
 * into the worktree so tools inspecting cwd relative paths see fresh context without duplicating project.json.
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

  // Mirror parent requirement's design.md when this is a spawned sub-requirement so handoff references resolve inside the worktree.
  try {
    const bundle = readRequirementBundle(base, reqId);
    const parentId = bundle.state.parentId;
    if (parentId) {
      const parentDesignSrc = resolveSafePath(base, `${WORKBENCH_DIR}/items/${parentId}/design.md`);
      if (fs.existsSync(parentDesignSrc)) {
        const dstParentDir = resolveSafePath(wt, `${WORKBENCH_DIR}/items/${parentId}`);
        fs.mkdirSync(dstParentDir, { recursive: true });
        atomicWriteFile(
          resolveSafePath(wt, `${WORKBENCH_DIR}/items/${parentId}/design.md`),
          readBoundedText(parentDesignSrc, 512 * 1024),
        );
      }
    }
  } catch {
    // Best-effort parent mirror.
  }

  // Mirror attachments as binary copies so relative paths inside the worktree resolve.
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

  // Mirror latest 20 verification evidence files so read-only review inside sandbox can inspect logs.
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

export type { SandboxDriftInfo } from "./types.ts";

export interface CreateWorktreeOptions {
  branchPrefix?: "feat" | "fix";
  branchName?: string;
  stackedOnReqId?: string;
  baseRef?: string;
}

export async function createOrReuseWorktree(
  wbRoot: string,
  reqId: string,
  options: CreateWorktreeOptions = {},
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

  let startPoint = options.baseRef?.trim() || "";
  if (!startPoint && options.stackedOnReqId?.trim()) {
    const parentSb = getSandboxForRequirement(base, options.stackedOnReqId.trim());
    if (!parentSb) {
      throw new WorkbenchError("not_found", `堆叠基准需求 ${options.stackedOnReqId} 尚未开启 Worktree 沙箱`);
    }
    startPoint = parentSb.branch;
  }
  if (!startPoint) {
    const projectMeta = isProjectInitialized(base) ? getProjectStatus(base).project : null;
    const configuredBase = projectMeta?.github?.defaultBaseBranch ?? projectMeta?.gitee?.defaultBaseBranch;
    const targetMain = await resolveTargetMainRef(base, configuredBase);
    startPoint = targetMain?.oid ?? "HEAD";
  }

  let baseHeadOid = snap.head;
  try {
    baseHeadOid = execFileSync("git", ["-C", base, "rev-parse", "--verify", `${startPoint}^{commit}`], {
      encoding: "utf8",
    }).trim();
  } catch {
    startPoint = "HEAD";
  }

  const projHash = createHash("sha256").update(base, "utf8").digest("hex").slice(0, 8);
  const worktreePath = path.join(worktreesBaseDir(), projHash, reqId);
  const prefix = options.branchPrefix ?? "feat";
  const branch = options.branchName?.trim() || `${prefix}/${reqId.toLowerCase()}`;
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true, mode: 0o700 });
  if (fs.existsSync(worktreePath)) {
    try {
      execFileSync("git", ["-C", base, "worktree", "remove", "--force", worktreePath], { stdio: "ignore" });
    } catch {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  }

  execFileSync("git", ["-C", base, "worktree", "add", "-B", branch, worktreePath, startPoint], {
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
    baseHead: baseHeadOid,
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

function listDirtyPathsExcludingNodeModules(wt: string): string[] {
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
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i]!;
    const xy = entry.slice(0, 2);
    const filePath = entry.slice(3);
    let origPath = "";
    if (xy[0] === "R" || xy[0] === "C") {
      origPath = tokens[i + 1] ?? "";
      i += 1;
    }
    if (filePath && filePath !== "node_modules" && !filePath.startsWith("node_modules/")) {
      paths.push(filePath);
    }
    if (origPath && origPath !== "node_modules" && !origPath.startsWith("node_modules/")) {
      paths.push(origPath);
    }
  }
  return Array.from(new Set(paths));
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
 * main commits directly inside an isolated worktree.
 */
export async function reconcileSandboxBaseline(
  wbRoot: string,
  reqId: string,
): Promise<RequirementDetail | null> {
  assertRequirementId(reqId);
  const base = canonicalRoot(wbRoot);
  const sandbox = getSandboxForRequirement(base, reqId);
  if (!sandbox || !fs.existsSync(sandbox.worktreePath)) return null;
  const wt = canonicalRoot(sandbox.worktreePath);
  if (hasInProgressMergeOrRebase(wt)) return null;

  const projectMeta = isProjectInitialized(base) ? getProjectStatus(base).project : null;
  const configuredBase = projectMeta?.github?.defaultBaseBranch ?? projectMeta?.gitee?.defaultBaseBranch;
  const targetMain = await resolveTargetMainRef(base, configuredBase);

  let mainHead = targetMain?.oid ?? "";
  let wtHead = "";
  try {
    if (!mainHead) {
      mainHead = execFileSync("git", ["-C", base, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    }
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

function listWorktreeTouchedFiles(wt: string, sinceRef: string): Set<string> {
  return new Set<string>([
    ...splitNullStrings(
      execFileSync("git", [
        "-C", wt, "diff", "--name-only", "-z", "--no-renames", sinceRef,
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
}

function readStashTip(wt: string): string {
  try {
    return execFileSync("git", ["-C", wt, "rev-parse", "--verify", "refs/stash"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** Inspects whether an isolated worktree has fallen behind main, has hunk-level conflicts, or overlaps with sibling worktrees. */
export async function inspectSandboxDrift(
  wbRoot: string,
  reqId: string,
  options: { includeSiblings?: boolean; fetchRemote?: boolean } = {},
): Promise<SandboxDriftInfo | null> {
  assertRequirementId(reqId);
  const base = canonicalRoot(wbRoot);
  const sandbox = getSandboxForRequirement(base, reqId);
  if (!sandbox || !fs.existsSync(sandbox.worktreePath)) return null;
  const wt = canonicalRoot(sandbox.worktreePath);

  const projectMeta = isProjectInitialized(base) ? getProjectStatus(base).project : null;
  const configuredBase = projectMeta?.github?.defaultBaseBranch ?? projectMeta?.gitee?.defaultBaseBranch;

  if (options.fetchRemote) {
    const remoteUrl = await getGitRemoteUrl(base);
    if (remoteUrl) {
      const preTarget = await resolveTargetMainRef(base, configuredBase);
      if (preTarget?.baseBranch) {
        await fetchRemoteBranch(base, preTarget.baseBranch);
      }
    }
  }

  const targetMain = await resolveTargetMainRef(base, configuredBase);
  let mainHead = targetMain?.oid ?? "";
  let wtHead = "";
  try {
    if (!mainHead) {
      mainHead = execFileSync("git", ["-C", base, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    }
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

  const wtFiles = listWorktreeTouchedFiles(wt, effectiveBase);
  const mainFiles = new Set<string>(
    splitNullStrings(
      execFileSync("git", [
        "-C", base, "diff", "--name-only", "-z", "--no-renames", effectiveBase, mainHead,
        "--", ".", ":(exclude).workbench", ":(exclude).omp/workbench",
      ]),
    ),
  );

  const mainDirty =
    execFileSync("git", ["-C", base, "status", "--porcelain", "--", ".", ":(exclude).workbench", ":(exclude).omp/workbench"], {
      encoding: "utf8",
    }).trim().length > 0;

  const overlapFiles = Array.from(wtFiles).filter((f) => mainFiles.has(f)).sort();
  let driftStatus: SandboxDriftStatus = "up_to_date";
  let conflictFiles: string[] = [];
  let cachedWtTree: string | null = null;

  const getWtTree = async () => {
    if (!cachedWtTree) {
      cachedWtTree = await captureWorkingTreeTreeOid(wt, wtHead);
    }
    return cachedWtTree;
  };

  if (behindCount === 0) {
    driftStatus = "up_to_date";
    conflictFiles = [];
  } else if (overlapFiles.length === 0) {
    driftStatus = "clean_behind";
    conflictFiles = [];
  } else {
    const wtTree = await getWtTree();
    const mt = await inspectMergeTreeConflict(base, {
      baseRef: effectiveBase,
      leftRef: mainHead,
      rightRef: wtTree,
    });
    if (!mt.unavailable) {
      if (mt.clean) {
        driftStatus = "auto_mergeable";
        conflictFiles = [];
      } else {
        driftStatus = "true_conflict";
        conflictFiles = mt.conflictFiles.length > 0 ? mt.conflictFiles : overlapFiles;
      }
    } else {
      driftStatus = "true_conflict";
      conflictFiles = overlapFiles;
    }
  }

  let siblingConflicts: SiblingConflictInfo[] | undefined;
  if (options.includeSiblings !== false) {
    const siblings = listProjectSandboxes(base).filter((sb) => sb.requirementId !== reqId);
    if (siblings.length > 0) {
      const detected: SiblingConflictInfo[] = [];
      for (const sib of siblings) {
        try {
          const sibDetail = getRequirement(base, sib.requirementId);
          if (sibDetail.state.stage === "cancelled") continue;
          if (sibDetail.state.stage === "done" && sibDetail.state.github?.pr?.state === "merged") continue;
          const sibWt = canonicalRoot(sib.worktreePath);
          const sibHead = execFileSync("git", ["-C", sibWt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
          const sibBase = resolveEffectiveSandboxBaseRef(base, sibWt, sib, mainHead) || sibHead;
          const sibFiles = listWorktreeTouchedFiles(sibWt, sibBase);
          const sibOverlap = Array.from(wtFiles).filter((f) => sibFiles.has(f)).sort();
          if (sibOverlap.length === 0) continue;

          let commonBase = effectiveBase;
          try {
            const mb = execFileSync("git", ["-C", base, "merge-base", wtHead, sibHead], {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
            }).trim();
            if (/^[0-9a-f]{7,64}$/i.test(mb)) commonBase = mb;
          } catch {
            // Fallback to effectiveBase.
          }
          const wtTree = await getWtTree();
          const sibTree = await captureWorkingTreeTreeOid(sibWt, sibHead);
          const sibMt = await inspectMergeTreeConflict(base, {
            baseRef: commonBase,
            leftRef: wtTree,
            rightRef: sibTree,
          });
          const sibConflicts = sibMt.unavailable
            ? sibOverlap
            : sibMt.clean
              ? []
              : sibMt.conflictFiles.length > 0
                ? sibMt.conflictFiles
                : sibOverlap;
          detected.push({
            requirementId: sib.requirementId,
            title: sibDetail.state.title,
            branch: sib.branch,
            stage: sibDetail.state.stage,
            conflictFiles: sibConflicts,
            overlapFiles: sibOverlap,
            autoMergeable: !sibMt.unavailable && sibMt.clean,
          });
        } catch {
          // Skip inaccessible sibling sandbox.
        }
      }
      if (detected.length > 0) {
        siblingConflicts = detected;
      }
    }
  }

  return {
    requirementId: reqId,
    branch: sandbox.branch,
    baseBranch: targetMain?.baseBranch ?? configuredBase ?? "main",
    baseHead: effectiveBase,
    mainHead,
    targetRef: targetMain?.refName,
    remoteAheadCount: targetMain?.remoteAheadCount ?? 0,
    behindCount,
    aheadCount,
    mainDirty,
    driftStatus,
    overlapFiles,
    conflictFiles,
    canAutoSync: behindCount > 0 && conflictFiles.length === 0,
    ...(siblingConflicts ? { siblingConflicts } : {}),
  };
}

/**
 * Safely fast-forwards/merges an isolated worktree to the latest main target
 * when there are no hunk-level conflicts (clean_behind or auto_mergeable),
 * preserving uncommitted WIP edits via 2-way read-tree or temporary stash/pop.
 */
export async function syncSandboxBase(
  wbRoot: string,
  reqId: string,
  options: { fetchRemote?: boolean } = {},
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
  const drift = await inspectSandboxDrift(base, reqId, {
    includeSiblings: false,
    fetchRemote: options.fetchRemote !== false,
  });
  if (!drift) {
    throw new WorkbenchError("execution_failed", "无法检查沙箱基线状态");
  }
  if (drift.behindCount === 0) {
    const wtSnap = await observeGitSnapshot(wt);
    const detail = getRequirement(base, reqId, { currentCodeSnapshotHash: wtSnap?.fingerprint ?? null });
    return { synced: true, upToDate: true, conflictFiles: [], drift, detail };
  }
  if (drift.conflictFiles.length > 0 || !drift.canAutoSync) {
    const wtSnap = await observeGitSnapshot(wt);
    const detail = getRequirement(base, reqId, { currentCodeSnapshotHash: wtSnap?.fingerprint ?? null });
    return { synced: false, upToDate: false, conflictFiles: drift.conflictFiles, drift, detail };
  }

  const wtHead = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirtyPaths = listDirtyPathsExcludingNodeModules(wt);
  const wtDirty = dirtyPaths.length > 0;

  if (drift.aheadCount === 0 && drift.overlapFiles.length === 0) {
    execFileSync("git", ["-C", wt, "read-tree", "-m", "-u", wtHead, drift.mainHead], { stdio: "pipe" });
    execFileSync("git", ["-C", wt, "reset", "--soft", drift.mainHead], { stdio: "pipe" });
  } else {
    let createdStash = false;
    if (wtDirty) {
      const beforeStash = readStashTip(wt);
      execFileSync(
        "git",
        ["-C", wt, "stash", "push", "-u", "-m", `wb-sync-wip-${reqId}`, "--", ...dirtyPaths],
        { stdio: "pipe" },
      );
      const afterStash = readStashTip(wt);
      createdStash = Boolean(afterStash && afterStash !== beforeStash);
    }

    try {
      if (drift.aheadCount === 0) {
        execFileSync("git", ["-C", wt, "merge", "--ff-only", drift.mainHead], { stdio: "pipe" });
      } else {
        execFileSync("git", ["-C", wt, "merge", "--no-edit", drift.mainHead], { stdio: "pipe" });
      }
    } catch {
      try {
        execFileSync("git", ["-C", wt, "merge", "--abort"], { stdio: "ignore" });
      } catch {
        // Ignore abort cleanup error.
      }
      if (createdStash) {
        try {
          execFileSync("git", ["-C", wt, "stash", "pop"], { stdio: "ignore" });
        } catch {
          // Leave stash intact if pop fails.
        }
      }
      throw new WorkbenchError("revision_conflict", "合并主干时产生 Git 冲突，请派发 Agent 处理冲突");
    }

    if (createdStash) {
      try {
        execFileSync("git", ["-C", wt, "stash", "pop"], { stdio: "pipe" });
      } catch {
        throw new WorkbenchError("revision_conflict", "主干已合并，但恢复工作区暂存改动时发生冲突，请派发 Agent 处理冲突");
      }
    }
  }

  const preDetail = getRequirement(base, reqId);
  const isDone = preDetail.state.stage === "done";
  const snapAfter = await observeGitSnapshot(wt);

  withSandboxLockSync(() => {
    const all = readSandboxes();
    const key = sandboxKey(base, reqId);
    if (all[key]) {
      all[key] = {
        ...all[key]!,
        baseHead: drift.mainHead,
        ...(isDone && snapAfter?.fingerprint
          ? { lastCleanSyncFingerprint: snapAfter.fingerprint }
          : { lastCleanSyncFingerprint: undefined }),
      };
      writeSandboxes(all);
    }
  });

  const autoMergeHint = drift.driftStatus === "auto_mergeable" ? "（含同文件自动三路合并）" : "";
  const detail = await syncRequirementBaseline(base, reqId, {
    baselineHead: drift.mainHead,
    baselineFingerprint: snapAfter?.fingerprint ?? "0".repeat(64),
    dirty: snapAfter?.dirty ?? false,
    preserveStage: isDone,
    eventKind: "sandbox_synced",
    summary: isDone
      ? `已完成需求在无冲突状态下同步主干至 ${drift.mainHead.slice(0, 7)}（落后 ${drift.behindCount} 个提交已合并${autoMergeHint}，可直接交付 PR）`
      : `沙箱基线已自动同步至主干 ${drift.mainHead.slice(0, 7)}（落后 ${drift.behindCount} 个提交已合并${autoMergeHint}，请复跑验证）`,
    currentCodeSnapshotHash: snapAfter?.fingerprint ?? null,
  });
  syncRequirementMirrorToSandbox(base, reqId, wt);
  const nextDrift =
    (await inspectSandboxDrift(base, reqId, { includeSiblings: true, fetchRemote: false })) ?? {
      ...drift,
      behindCount: 0,
      baseHead: drift.mainHead,
      driftStatus: "up_to_date" as const,
      overlapFiles: [],
      conflictFiles: [],
      canAutoSync: false,
    };
  return { synced: true, upToDate: false, conflictFiles: [], drift: nextDrift, detail };
}

/**
 * Computes an optimal merge order across active sandboxes in a project using pairwise `git merge-tree`
 * so parallel PRs minimize cascading merge conflicts.
 */
export async function recommendSandboxMergeOrder(
  wbRoot: string,
  options: { fetchRemote?: boolean } = {},
): Promise<MergeOrderRecommendation> {
  const base = canonicalRoot(wbRoot);
  const projectMeta = isProjectInitialized(base) ? getProjectStatus(base).project : null;
  const configuredBase = projectMeta?.github?.defaultBaseBranch ?? projectMeta?.gitee?.defaultBaseBranch;
  if (options.fetchRemote) {
    const remoteUrl = await getGitRemoteUrl(base);
    if (remoteUrl) {
      const pre = await resolveTargetMainRef(base, configuredBase);
      if (pre?.baseBranch) await fetchRemoteBranch(base, pre.baseBranch);
    }
  }
  const targetMain = await resolveTargetMainRef(base, configuredBase);
  const mainHead = targetMain?.oid ?? "";
  const baseBranch = targetMain?.baseBranch ?? configuredBase ?? "main";

  const sandboxes = listProjectSandboxes(base);
  interface Candidate {
    sb: SandboxRecord;
    detail: RequirementDetail;
    drift: SandboxDriftInfo;
    wtFiles: Set<string>;
    wtTree: string;
    wtHead: string;
  }
  const candidates: Candidate[] = [];
  for (const sb of sandboxes) {
    try {
      const detail = getRequirement(base, sb.requirementId);
      if (detail.state.stage === "cancelled") continue;
      if (detail.state.stage === "done" && detail.state.github?.pr?.state === "merged") continue;
      const drift = await inspectSandboxDrift(base, sb.requirementId, { includeSiblings: false, fetchRemote: false });
      if (!drift) continue;
      const wt = canonicalRoot(sb.worktreePath);
      const wtHead = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const wtFiles = listWorktreeTouchedFiles(wt, drift.baseHead);
      const wtTree = await captureWorkingTreeTreeOid(wt, wtHead);
      candidates.push({ sb, detail, drift, wtFiles, wtTree, wtHead });
    } catch {
      // Ignore stale or unreadable sandbox entries.
    }
  }

  const pairConflicts = new Map<string, Set<string>>();
  const pairAutoMerge = new Map<string, Set<string>>();
  for (const c of candidates) {
    pairConflicts.set(c.sb.requirementId, new Set());
    pairAutoMerge.set(c.sb.requirementId, new Set());
  }

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]!;
      const b = candidates[j]!;
      const overlap = Array.from(a.wtFiles).filter((f) => b.wtFiles.has(f));
      if (overlap.length === 0) continue;
      let commonBase = a.drift.baseHead;
      try {
        const mb = execFileSync("git", ["-C", base, "merge-base", a.wtHead, b.wtHead], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (/^[0-9a-f]{7,64}$/i.test(mb)) commonBase = mb;
      } catch {
        // Use baseHead fallback.
      }
      const mt = await inspectMergeTreeConflict(base, {
        baseRef: commonBase,
        leftRef: a.wtTree,
        rightRef: b.wtTree,
      });
      if (!mt.unavailable && mt.clean) {
        pairAutoMerge.get(a.sb.requirementId)!.add(b.sb.requirementId);
        pairAutoMerge.get(b.sb.requirementId)!.add(a.sb.requirementId);
      } else {
        pairConflicts.get(a.sb.requirementId)!.add(b.sb.requirementId);
        pairConflicts.get(b.sb.requirementId)!.add(a.sb.requirementId);
      }
    }
  }

  const stageRank = (s: string) => (s === "done" ? 0 : s === "coding" ? 1 : 2);

  const entries: MergeOrderEntry[] = candidates.map((c) => {
    const conflictsWith = Array.from(pairConflicts.get(c.sb.requirementId) ?? []).sort();
    const autoWith = Array.from(pairAutoMerge.get(c.sb.requirementId) ?? []).sort();
    const reason: MergeOrderEntry["reason"] =
      c.drift.conflictFiles.length > 0
        ? "main_conflict"
        : conflictsWith.length > 0
          ? "sibling_conflict"
          : c.drift.driftStatus === "auto_mergeable" || autoWith.length > 0
            ? "auto_mergeable"
            : "clean_leaf";
    return {
      requirementId: c.sb.requirementId,
      title: c.detail.state.title,
      stage: c.detail.state.stage,
      branch: c.sb.branch,
      aheadCount: c.drift.aheadCount,
      behindCount: c.drift.behindCount,
      driftStatus: c.drift.driftStatus,
      conflictFiles: c.drift.conflictFiles,
      overlapFiles: c.drift.overlapFiles,
      touchedFilesCount: c.wtFiles.size,
      conflictsWithSiblings: conflictsWith,
      autoMergeableSiblings: autoWith,
      pr: c.detail.state.github?.pr ?? null,
      reason,
    };
  });

  entries.sort((a, b) => {
    const aHasMainConflict = a.conflictFiles.length > 0 ? 1 : 0;
    const bHasMainConflict = b.conflictFiles.length > 0 ? 1 : 0;
    if (aHasMainConflict !== bHasMainConflict) return aHasMainConflict - bHasMainConflict;
    const stageDiff = stageRank(a.stage) - stageRank(b.stage);
    if (stageDiff !== 0) return stageDiff;
    if (a.conflictsWithSiblings.length !== b.conflictsWithSiblings.length) {
      return a.conflictsWithSiblings.length - b.conflictsWithSiblings.length;
    }
    if (a.touchedFilesCount !== b.touchedFilesCount) {
      return a.touchedFilesCount - b.touchedFilesCount;
    }
    return a.requirementId.localeCompare(b.requirementId);
  });

  return {
    generatedAt: Date.now(),
    baseBranch,
    mainHead,
    ordered: entries,
  };
}

/**
 * Automatically cascade-syncs remaining non-conflicting sandboxes after one sandbox is merged/applied to main.
 * Conflicting sandboxes are reported in the returned results without mutating their working trees.
 */
export async function cascadeSyncProjectSandboxes(
  wbRoot: string,
  mergedReqId?: string,
): Promise<CascadeSyncItemResult[]> {
  const base = canonicalRoot(wbRoot);
  const siblings = listProjectSandboxes(base).filter((sb) => sb.requirementId !== mergedReqId);
  const results: CascadeSyncItemResult[] = [];
  for (const sb of siblings) {
    try {
      const detail = getRequirement(base, sb.requirementId);
      if (detail.state.stage === "cancelled") continue;
      if (detail.state.stage === "done" && detail.state.github?.pr?.state === "merged") continue;
      const drift = await inspectSandboxDrift(base, sb.requirementId, { includeSiblings: false, fetchRemote: false });
      if (!drift) continue;
      if (drift.behindCount === 0) {
        results.push({ requirementId: sb.requirementId, status: "up_to_date", behindCount: 0, driftStatus: drift.driftStatus });
        continue;
      }
      if (!drift.canAutoSync) {
        results.push({
          requirementId: sb.requirementId,
          status: "conflict",
          behindCount: drift.behindCount,
          driftStatus: drift.driftStatus,
          conflictFiles: drift.conflictFiles,
        });
        continue;
      }
      const synced = await syncSandboxBase(base, sb.requirementId, { fetchRemote: false });
      results.push({
        requirementId: sb.requirementId,
        status: synced.synced ? "synced" : "conflict",
        behindCount: drift.behindCount,
        driftStatus: drift.driftStatus,
        ...(synced.conflictFiles.length > 0 ? { conflictFiles: synced.conflictFiles } : {}),
      });
    } catch (err) {
      results.push({
        requirementId: sb.requirementId,
        status: "error",
        behindCount: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

/** Transitions a requirement (`done`) into `coding` for Agent conflict resolution without losing approval. */
export async function prepareSandboxConflictResolution(
  wbRoot: string,
  reqId: string,
): Promise<RequirementDetail> {
  assertRequirementId(reqId);
  const base = canonicalRoot(wbRoot);
  const sandbox = getSandboxForRequirement(base, reqId);
  const codeRoot = sandbox ? sandbox.worktreePath : base;
  const snap = await observeGitSnapshot(codeRoot);
  const detail = await prepareRequirementForConflictSync(base, reqId, {
    currentCodeSnapshotHash: snap?.fingerprint ?? null,
  });
  if (sandbox) {
    syncRequirementMirrorToSandbox(base, reqId, sandbox.worktreePath);
  }
  return detail;
}

export async function applySandboxToMain(
  wbRoot: string,
  reqId: string,
): Promise<{
  appliedFiles: string[];
  deletedFiles: string[];
  touchesWeb: boolean;
  touchesBackend: boolean;
  cascadeResults: CascadeSyncItemResult[];
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
  const matchesAcceptance = detail.state.acceptance.codeSnapshotHash === wtSnap?.fingerprint;
  const matchesCleanSync = Boolean(
    sandbox.lastCleanSyncFingerprint && sandbox.lastCleanSyncFingerprint === wtSnap?.fingerprint,
  );
  if (!wtSnap || (!matchesAcceptance && !matchesCleanSync)) {
    throw new WorkbenchError(
      "acceptance_gate_failed",
      `需求 ${reqId} 的沙箱代码在验收后发生了变更，请重新打开需求验证并验收后再应用`,
    );
  }

  const mainSnap = await observeGitSnapshot(base);
  let baseRef = resolveEffectiveSandboxBaseRef(base, wt, sandbox, mainSnap?.head ?? null);
  if (!baseRef) {
    if (!mainSnap?.head) {
      throw new WorkbenchError("execution_failed", "无法确定主仓库与沙箱的分叉基准提交");
    }
    baseRef = mainSnap.head;
  }

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
  const cascadeResults = await cascadeSyncProjectSandboxes(base, reqId);

  const allTouched = [...appliedFiles, ...deleted];
  const touchesWeb = allTouched.some((f) => f.startsWith("src/web/"));
  const touchesBackend = allTouched.some(
    (f) => f.startsWith("src/server/") || f.startsWith("src/hub/") || f.startsWith("src/core/"),
  );
  return { appliedFiles, deletedFiles: deleted, touchesWeb, touchesBackend, cascadeResults };
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
 * Checks the linked GitHub PR status for a sandbox requirement.
 * When merged (or force-cleaned after close), safely fast-forwards the clean base branch
 * and cleans up the isolated worktree + branch.
 */
export async function syncSandboxPrAndCleanup(
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
  cascadeResults?: CascadeSyncItemResult[];
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

  let cascadeResults: CascadeSyncItemResult[] | undefined;
  if (isMerged) {
    await fetchRemoteBranch(base, latestPr.baseBranch || "main", "origin");
    cascadeResults = await cascadeSyncProjectSandboxes(base, reqId);
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
    mainSyncReasonRef,
    touchesWeb,
    touchesBackend,
    ...(cascadeResults ? { cascadeResults } : {}),
  };
}
