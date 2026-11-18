import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { getRequirement, recordVerification } from "./engine.ts";
import { WorkbenchError } from "./errors.ts";
import { canonicalRoot } from "./fs.ts";
import { observeGitSnapshot } from "./git.ts";
import { resolveCodeRoot } from "./sandbox.ts";
import { MAX_EVIDENCE_BYTES, type RequirementDetail, type VerificationRecord } from "./types.ts";
import { isSafeText, sanitizeOutput } from "./validate.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 300_000;
const PREVIEW_MAX_BYTES = 4096;

export interface RunVerificationInput {
  command: string;
  criterionIds: string[];
  timeoutMs?: number;
}

export interface RunVerificationResult {
  detail: RequirementDetail;
  record: VerificationRecord;
  log: string;
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
    // Never leak a parent agent's WORKBENCH_ROOT/WORKBENCH_REQ_ID into verification test children.
    delete childEnv.WORKBENCH_ROOT;
    delete childEnv.WORKBENCH_REQ_ID;

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
  const validCriteria = new Set(preDetail.state.criteria.map((c) => c.id));
  for (const cid of criterionIds) {
    if (!validCriteria.has(cid)) {
      throw new WorkbenchError("invalid_input", `验收条件 ID 不存在: ${cid}`);
    }
  }

  const codeRoot = resolveCodeRoot(base, id);
  const preSnapshot = await observeGitSnapshot(codeRoot);
  if (!preSnapshot) {
    throw new WorkbenchError("execution_failed", "项目目录不是 Git 仓库，无法绑定代码快照指纹");
  }

  const rawTimeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(rawTimeout) || rawTimeout < MIN_TIMEOUT_MS || rawTimeout > MAX_TIMEOUT_MS) {
    throw new WorkbenchError(
      "invalid_input",
      `超时时间必须在 ${MIN_TIMEOUT_MS}ms 与 ${MAX_TIMEOUT_MS}ms 之间`,
    );
  }

  const execResult = await executeShellCommand(codeRoot, command, Math.floor(rawTimeout));
  const postSnapshot = await observeGitSnapshot(codeRoot);
  if (!postSnapshot) {
    throw new WorkbenchError("execution_failed", "命令执行后无法读取 Git 代码快照");
  }

  const fullSanitized = sanitizeOutput(execResult.rawOutput, MAX_EVIDENCE_BYTES);
  const previewSanitized = sanitizeOutput(fullSanitized.text, PREVIEW_MAX_BYTES);
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

  return { detail, record, log: fullSanitized.text };
}

/** Runs all distinct verification commands configured on a requirement's acceptance criteria. */
export async function runAllVerifications(
  root: string,
  id: string,
  options: { timeoutMs?: number } = {},
): Promise<{ detail: RequirementDetail; runs: RunVerificationResult[] }> {
  const base = canonicalRoot(root);
  const current = getRequirement(base, id);
  const groups = new Map<string, string[]>();

  for (const criterion of current.state.criteria) {
    if (!criterion.command || !criterion.command.trim()) continue;
    const cmd = criterion.command.trim();
    const list = groups.get(cmd) ?? [];
    list.push(criterion.id);
    groups.set(cmd, list);
  }

  if (groups.size === 0) {
    throw new WorkbenchError("invalid_input", "当前需求尚未给验收条件配置自动验证命令");
  }

  const runs: RunVerificationResult[] = [];
  let latestDetail = current;
  for (const [command, criterionIds] of groups.entries()) {
    const result = await runVerification(base, id, {
      command,
      criterionIds,
      timeoutMs: options.timeoutMs,
    });
    runs.push(result);
    latestDetail = result.detail;
  }

  return { detail: latestDetail, runs };
}
