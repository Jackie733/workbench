import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withCodeRootLock } from "./code_lock.ts";
import { getRequirement, recordVerification } from "./engine.ts";
import { WorkbenchError } from "./errors.ts";
import { atomicWriteJson, canonicalRoot, readJsonStrict, withNamedAdvisoryLock } from "./fs.ts";
import { observeGitSnapshot } from "./git.ts";
import { resolveCodeRoot } from "./sandbox.ts";
import { MAX_EVIDENCE_BYTES, type RequirementDetail, type VerificationRecord } from "./types.ts";
import { clipHeadTailUtf8, isSafeText, sanitizeOutput } from "./validate.ts";
import { isManualCriterion } from "./validity.ts";

const DEFAULT_TIMEOUT_MS = 600_000;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 1_800_000;
const PREVIEW_HEAD_BYTES = 1024;
const PREVIEW_TAIL_BYTES = 3072;

export interface RunVerificationInput {
  command: string;
  criterionIds: string[];
  timeoutMs?: number;
  /** Optional parent write lease ID when invoked inside an active coding run's post-gate. */
  lockLeaseId?: string;
  /** Optional progress callback invoked while waiting on shared heavy verification locks. */
  onProgress?: (line: string) => void;
}

export interface RunVerificationResult {
  detail: RequirementDetail;
  record: VerificationRecord;
  log: string;
  reused?: boolean;
}

interface CommandExecutionOutput {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  startedAt: number;
  endedAt: number;
  rawOutput: string;
  truncatedByBuffer: boolean;
}

function executeShellCommand(cwd: string, command: string, timeoutMs: number): Promise<CommandExecutionOutput> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const isWin = process.platform === "win32";
    const shell = isWin ? "cmd.exe" : "bash";
    const shellArgs = isWin ? ["/d", "/s", "/c", command] : ["-lc", command];

    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    // Never leak a parent agent's WORKBENCH_ROOT/WORKBENCH_REQ_ID/RUN_ACTION/RSI depth into verification test children.
    delete childEnv.WORKBENCH_ROOT;
    delete childEnv.WORKBENCH_REQ_ID;
    delete childEnv.WORKBENCH_RUN_ACTION;
    delete childEnv.WORKBENCH_RSI_DEPTH;
    delete childEnv.WORKBENCH_HUB_PID;
    delete childEnv.WORKBENCH_OUTPUT_LANGUAGE;

    const child = spawn(shell, shellArgs, {
      cwd,
      detached: !isWin,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });

    const chunks: Buffer[] = [];
    let collectedBytes = 0;
    let truncatedByBuffer = false;
    let timedOut = false;
    let settled = false;

    const appendChunk = (chunk: Buffer) => {
      if (collectedBytes >= MAX_EVIDENCE_BYTES) {
        truncatedByBuffer = true;
        return;
      }
      const remaining = MAX_EVIDENCE_BYTES - collectedBytes;
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        collectedBytes += remaining;
        truncatedByBuffer = true;
      } else {
        chunks.push(chunk);
        collectedBytes += chunk.length;
      }
    };

    child.stdout?.on("data", appendChunk);
    child.stderr?.on("data", appendChunk);

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (!isWin && child.pid) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        // Process already exited.
      }
    }, timeoutMs);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new WorkbenchError("execution_failed", `启动验证命令失败: ${err.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const endedAt = Date.now();
      resolve({
        exitCode: timedOut ? null : code,
        timedOut,
        durationMs: Math.max(0, endedAt - startedAt),
        startedAt,
        endedAt,
        rawOutput: Buffer.concat(chunks).toString("utf8"),
        truncatedByBuffer,
      });
    });
  });
}

function isHeavyVerificationSegment(segment: string): boolean {
  const parts = segment.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  const bin = parts[0]!;
  const sub = parts[1];
  const rest = parts.slice(2);
  if (bin === "bun" && sub === "test") {
    const hasSpecificTarget = rest.some(
      (token) =>
        !token.startsWith("-") &&
        (/\.(?:test|spec)\.(?:ts|tsx|js|jsx|mts|cts)$/.test(token) || token.includes("/")),
    );
    return !hasSpecificTarget;
  }
  if (
    (bin === "bun" || bin === "npm" || bin === "pnpm" || bin === "yarn") &&
    (sub === "test" || (sub === "run" && parts[2] === "test"))
  ) {
    return true;
  }
  if (bin === "playwright" && sub === "test") {
    return rest.every((token) => token.startsWith("-"));
  }
  return false;
}

export function isHeavyVerificationCommand(command: string): boolean {
  return command
    .split(/&&|\|\||;/)
    .some((segment) => isHeavyVerificationSegment(segment));
}

function isUnderTempRoot(codeRoot: string): boolean {
  try {
    const tmpBase = fs.realpathSync(os.tmpdir());
    return codeRoot === tmpBase || codeRoot.startsWith(`${tmpBase}${path.sep}`);
  } catch {
    return false;
  }
}

function resolveHubDataDir(): string {
  const custom = process.env.WORKBENCH_HUB_DIR?.trim();
  return custom ? path.resolve(custom) : path.join(os.homedir(), ".workbench-hub");
}

function resolveHeavyVerifyLockPath(): string {
  return path.join(resolveHubDataDir(), "locks", "verify-heavy.lock");
}

const VERIFY_CACHE_TTL_MS = 7 * 24 * 60 * 60_000;

interface VerifyCacheEntry {
  command: string;
  codeSnapshotHash: string;
  durationMs: number;
  rawLog: string;
  outputPreview: string;
  truncated: boolean;
  cachedAt: number;
}

function isVerifyCacheEnabled(codeRoot: string): boolean {
  if (process.env.WORKBENCH_DISABLE_VERIFY_CACHE === "1") return false;
  return !isUnderTempRoot(codeRoot) || Boolean(process.env.WORKBENCH_HUB_DIR?.trim());
}

function resolveVerifyCachePath(command: string, codeSnapshotHash: string): string {
  const key = createHash("sha256").update(`${command}\0${codeSnapshotHash}`, "utf8").digest("hex");
  return path.join(resolveHubDataDir(), "verify-cache", `${key}.json`);
}

function readVerifyCache(command: string, codeSnapshotHash: string): VerifyCacheEntry | null {
  try {
    const filePath = resolveVerifyCachePath(command, codeSnapshotHash);
    if (!fs.existsSync(filePath)) return null;
    const entry = readJsonStrict<VerifyCacheEntry>(filePath, MAX_EVIDENCE_BYTES + 16 * 1024);
    if (
      entry.command !== command ||
      entry.codeSnapshotHash !== codeSnapshotHash ||
      typeof entry.rawLog !== "string" ||
      typeof entry.cachedAt !== "number" ||
      Date.now() - entry.cachedAt > VERIFY_CACHE_TTL_MS
    ) {
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

function writeVerifyCache(entry: VerifyCacheEntry): void {
  try {
    const filePath = resolveVerifyCachePath(entry.command, entry.codeSnapshotHash);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    atomicWriteJson(filePath, entry, 0o600);
  } catch {
    // Cache write is strictly best-effort.
  }
}

/** Runs a real verification command in the project root, snapshots git state, and records immutable evidence. */
export async function runVerification(
  root: string,
  id: string,
  input: RunVerificationInput,
): Promise<RunVerificationResult> {
  const base = canonicalRoot(root);
  if (!isSafeText(input.command, 2048)) {
    throw new WorkbenchError("invalid_input", "验证命令不能为空或包含非法控制字符");
  }
  const command = input.command.trim();
  const criterionIds = Array.from(new Set(input.criterionIds ?? []));

  const preDetail = getRequirement(base, id);
  if (preDetail.state.stage === "done" || preDetail.state.stage === "cancelled") {
    throw new WorkbenchError("invalid_transition", `终态需求（${preDetail.state.stage}）不能执行验证`);
  }
  const criteriaById = new Map(preDetail.state.criteria.map((c) => [c.id, c]));
  for (const cid of criterionIds) {
    const criterion = criteriaById.get(cid);
    if (!criterion) {
      throw new WorkbenchError("invalid_input", `验收条件 ID 不存在: ${cid}`);
    }
    if (isManualCriterion(criterion)) {
      throw new WorkbenchError("invalid_input", `验收条件 ${cid} 为人工核验项，必须由人类在工作台手动勾选，禁止通过自动命令验证`);
    }
  }

  const codeRoot = resolveCodeRoot(base, id);
  const rawTimeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(rawTimeout) || rawTimeout < MIN_TIMEOUT_MS || rawTimeout > MAX_TIMEOUT_MS) {
    throw new WorkbenchError(
      "invalid_input",
      `超时时间必须在 ${MIN_TIMEOUT_MS}ms 与 ${MAX_TIMEOUT_MS}ms 之间`,
    );
  }

  return withCodeRootLock(
    codeRoot,
    "write",
    { kind: "verify", requirementId: id },
    async () => {
      const preSnapshot = await observeGitSnapshot(codeRoot);
      if (!preSnapshot) {
        throw new WorkbenchError("execution_failed", "项目目录不是 Git 仓库，无法绑定代码快照指纹");
      }

      const useHeavyLock =
        process.env.WORKBENCH_DISABLE_VERIFY_LOCK !== "1" &&
        !isUnderTempRoot(codeRoot) &&
        isHeavyVerificationCommand(command);
      const execResult = useHeavyLock
        ? await withNamedAdvisoryLock(
            resolveHeavyVerifyLockPath(),
            () => executeShellCommand(codeRoot, command, Math.floor(rawTimeout)),
            {
              waitTimeoutMs: MAX_TIMEOUT_MS,
              staleMs: MAX_TIMEOUT_MS + 60_000,
              pollMs: 250,
              busyMessage: "另一个全量验证正在执行且排队等待超时，请稍后重试",
              holderMeta: { requirementId: id, command },
              onWait: (info) => {
                const holderLabel = info.holder?.requirementId
                  ? `${info.holder.requirementId}${info.holder.command ? ` (${info.holder.command})` : ""}`
                  : "其他任务";
                const sec = Math.max(1, Math.round(info.waitedMs / 1000));
                input.onProgress?.(
                  `[workbench] 正在排队等待全局全量验证锁（当前占用：${holderLabel}，已等待 ${sec}s）...\n`,
                );
              },
            },
          )
        : await executeShellCommand(codeRoot, command, Math.floor(rawTimeout));
      const postSnapshot = await observeGitSnapshot(codeRoot);
      if (!postSnapshot) {
        throw new WorkbenchError("execution_failed", "命令执行后无法读取 Git 代码快照");
      }

      const fullSanitized = sanitizeOutput(execResult.rawOutput, MAX_EVIDENCE_BYTES);
      const previewSanitized = clipHeadTailUtf8(fullSanitized.text, PREVIEW_HEAD_BYTES, PREVIEW_TAIL_BYTES);
      const verificationId = `V-${execResult.endedAt}-${randomUUID().slice(0, 8)}`;
      const passed = !execResult.timedOut && execResult.exitCode === 0;

      const record: VerificationRecord = {
        id: verificationId,
        command,
        cwd: ".",
        criterionIds,
        specHash: preDetail.state.specHash,
        codeSnapshotHash: postSnapshot.fingerprint,
        exitCode: execResult.exitCode,
        timedOut: execResult.timedOut,
        durationMs: execResult.durationMs,
        startedAt: execResult.startedAt,
        endedAt: execResult.endedAt,
        passed,
        outputPath: `evidence/verify-${verificationId}.log`,
        outputPreview: previewSanitized.text,
        truncated: execResult.truncatedByBuffer || fullSanitized.truncated,
      };

      const detail = await recordVerification(base, id, {
        record,
        rawLog: fullSanitized.text,
        currentCodeSnapshotHash: postSnapshot.fingerprint,
      });

      if (passed && isVerifyCacheEnabled(codeRoot)) {
        writeVerifyCache({
          command,
          codeSnapshotHash: postSnapshot.fingerprint,
          durationMs: execResult.durationMs,
          rawLog: fullSanitized.text,
          outputPreview: previewSanitized.text,
          truncated: record.truncated,
          cachedAt: execResult.endedAt,
        });
      }

      return { detail, record, log: fullSanitized.text };
    },
    { parentLeaseId: input.lockLeaseId },
  );
}

function isSubsumedBunTestCommand(cmd: string, codeRoot: string): boolean {
  const parts = cmd.trim().split(/\s+/);
  if (parts.length < 3 || parts[0] !== "bun" || parts[1] !== "test") return false;
  for (const token of parts.slice(2)) {
    if (token.startsWith("-") || /[|&;<>()$`\\*?{}[\]]/.test(token)) return false;
    if (path.isAbsolute(token) || token.startsWith("..")) return false;
    if (!/^[A-Za-z0-9_./-]+\.test\.(?:ts|tsx|js|jsx|mts|cts)$/.test(token)) return false;
    if (!fs.existsSync(path.join(codeRoot, token))) return false;
  }
  return true;
}

/** Runs distinct verification commands configured on a requirement's acceptance criteria (required criteria by default). */
export async function runAllVerifications(
  root: string,
  id: string,
  options: {
    timeoutMs?: number;
    force?: boolean;
    includeOptional?: boolean;
    failFast?: boolean;
    lockLeaseId?: string;
    onProgress?: (line: string) => void;
  } = {},
): Promise<{ detail: RequirementDetail; runs: RunVerificationResult[] }> {
  const base = canonicalRoot(root);
  const current = getRequirement(base, id);
  const codeRoot = resolveCodeRoot(base, id);
  const groups = new Map<string, string[]>();

  const collectCriteria = (includeOptional: boolean) => {
    for (const criterion of current.state.criteria) {
      if (!criterion.command || !criterion.command.trim()) continue;
      if (!includeOptional && !criterion.required) continue;
      const cmd = criterion.command.trim();
      const list = groups.get(cmd) ?? [];
      list.push(criterion.id);
      groups.set(cmd, list);
    }
  };

  collectCriteria(options.includeOptional === true);
  if (groups.size === 0 && options.includeOptional !== true) {
    collectCriteria(true);
  }

  if (groups.size === 0) {
    throw new WorkbenchError("invalid_input", "当前需求尚未给验收条件配置自动验证命令");
  }

  // When exact full-suite `bun test` or `bun run test` is scheduled, merge pure file-subset `bun test <files>` ACs into it.
  const fullCmdKey = groups.has("bun run test") ? "bun run test" : groups.has("bun test") ? "bun test" : null;
  const fullBunIds = fullCmdKey ? groups.get(fullCmdKey) : undefined;
  if (fullBunIds && fullCmdKey) {
    for (const [cmd, cids] of Array.from(groups.entries())) {
      if (cmd === fullCmdKey) continue;
      if (isSubsumedBunTestCommand(cmd, codeRoot)) {
        for (const cid of cids) {
          if (!fullBunIds.includes(cid)) fullBunIds.push(cid);
        }
        groups.delete(cmd);
      }
    }
  }

  // Run fast commands (typecheck, targeted tests) before heavy full-suite commands so failFast catches errors quickly.
  const orderedGroups = Array.from(groups.entries()).sort(([cmdA], [cmdB]) => {
    const heavyA = isHeavyVerificationCommand(cmdA) ? 1 : 0;
    const heavyB = isHeavyVerificationCommand(cmdB) ? 1 : 0;
    return heavyA - heavyB;
  });

  return withCodeRootLock(
    codeRoot,
    "write",
    { kind: "verify_all", requirementId: id },
    async (lease) => {
      let currentSnap = options.force === true ? null : await observeGitSnapshot(codeRoot);
      const runs: RunVerificationResult[] = [];
      let latestDetail = current;

      for (const [command, criterionIds] of orderedGroups) {
        if (options.force !== true && currentSnap) {
          const existing = [...latestDetail.state.verifications].reverse().find(
            (v) =>
              v.passed &&
              v.command === command &&
              v.specHash === latestDetail.state.specHash &&
              v.codeSnapshotHash === currentSnap!.fingerprint &&
              criterionIds.every((cid) => v.criterionIds.includes(cid)),
          );
          if (existing) {
            runs.push({ detail: latestDetail, record: existing, log: "", reused: true });
            continue;
          }

          if (isVerifyCacheEnabled(codeRoot)) {
            const cached = readVerifyCache(command, currentSnap.fingerprint);
            if (cached) {
              const now = Date.now();
              const verificationId = `V-${now}-${randomUUID().slice(0, 8)}`;
              const rawWithNote = sanitizeOutput(
                `[workbench] 命中同快照跨需求验证缓存 (${currentSnap.fingerprint.slice(0, 12)})\n${cached.rawLog}`,
                MAX_EVIDENCE_BYTES,
              );
              const preview = clipHeadTailUtf8(rawWithNote.text, PREVIEW_HEAD_BYTES, PREVIEW_TAIL_BYTES);
              const record: VerificationRecord = {
                id: verificationId,
                command,
                cwd: ".",
                criterionIds,
                specHash: latestDetail.state.specHash,
                codeSnapshotHash: currentSnap.fingerprint,
                exitCode: 0,
                timedOut: false,
                durationMs: cached.durationMs,
                startedAt: now,
                endedAt: now,
                passed: true,
                outputPath: `evidence/verify-${verificationId}.log`,
                outputPreview: preview.text,
                truncated: cached.truncated || rawWithNote.truncated,
              };
              latestDetail = await recordVerification(base, id, {
                record,
                rawLog: rawWithNote.text,
                currentCodeSnapshotHash: currentSnap.fingerprint,
              });
              runs.push({ detail: latestDetail, record, log: rawWithNote.text, reused: true });
              continue;
            }
          }
        }
        const result = await runVerification(base, id, {
          command,
          criterionIds,
          timeoutMs: options.timeoutMs,
          lockLeaseId: lease.id,
          onProgress: options.onProgress,
        });
        runs.push(result);
        latestDetail = result.detail;
        if (options.force !== true) {
          currentSnap = await observeGitSnapshot(codeRoot);
        }
        if (options.failFast === true && !result.record.passed) {
          break;
        }
      }

      return { detail: latestDetail, runs };
    },
    { parentLeaseId: options.lockLeaseId },
  );
}
