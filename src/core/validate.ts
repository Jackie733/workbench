import { normalizeAttachments } from "./attachments.ts";
import { WorkbenchError } from "./errors.ts";
import {
  ACCEPTANCE_SNAPSHOT_SCHEMA_VERSION,
  AGENT_ACTIONS,
  MAX_ACCEPTANCE_DIFF_BYTES,
  MAX_ACCEPTANCE_SNAPSHOT_BYTES,
  MAX_AGENT_RUNS,
  MAX_CRITERIA,
  MAX_DESIGN_BYTES,
  MAX_DISCUSSIONS,
  MAX_HANDOFF_BYTES,
  MAX_REASON_CHARS,
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOT_BATCHES,
  MAX_SCREENSHOTS_PER_BATCH,
  MAX_SPEC_BYTES,
  MAX_SNAPSHOT_VERIFICATIONS,
  MAX_TASKS,
  MAX_TIMELINE,
  MAX_TITLE_CHARS,
  OUTPUT_LANGUAGES,
  REVIEW_FINDING_SEVERITIES,
  REVIEW_VERDICTS,
  SCHEMA_VERSION,
  STAGES,
  TASK_STATUSES,
  TRACKS,
  type AcceptanceGitEvidence,
  type AcceptanceRecord,
  type AcceptanceSnapshot,
  type AcceptanceSnapshotReference,
  type AcceptanceVerificationEvidence,
  type AgentAction,
  type AgentRunRecord,
  type ApprovalRecord,
  type BaselineSnapshot,
  type ChangedFile,
  type CommitInfo,
  type Criterion,
  type CriterionCoverageItem,
  type CriterionCoverageState,
  type CriterionInput,
  type DeliveryRecord,
  type DiffEvidenceStatus,
  type DiffFilesScope,
  type DiscussionEntry,
  type EffectiveVerificationState,
  type HandoffNote,
  type OutputLanguage,
  type ProjectGitHubConfig,
  type ProjectMetadata,
  type RequirementGitHubIssueLink,
  type RequirementGitHubLink,
  type RequirementGitHubPrLink,
  type RequirementState,
  type ReviewDisposition,
  type ReviewFinding,
  type ReviewFindingSeverity,
  type ReviewReport,
  type ReviewVerdict,
  type ScreenshotBatch,
  type ScreenshotBatchStatus,
  type ScreenshotShot,
  type ScreenshotSkipReasonCode,
  type ScreenshotTrigger,
  type Stage,
  type TaskInput,
  type TaskItem,
  type TaskStatus,
  type TimelineEvent,
  type Track,
  type VerificationRecord,
} from "./types.ts";

const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
export const REQUIREMENT_ID_RE = /^REQ-\d{3,}$/;
const TOKEN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const SNAPSHOT_PATH_RE = /^snapshots\/acceptance-[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/;
const SCREENSHOT_SHOT_ID_RE = /^S-[A-Za-z0-9-]{1,64}$/;
const SCREENSHOT_BATCH_ID_RE = /^SB-[A-Za-z0-9-]{1,64}$/;
const SCREENSHOT_PATH_RE = /^screenshots\/shot-S-[A-Za-z0-9-]{1,64}\.png$/;
const SCREENSHOT_VIEWPORT_RE = /^\d{2,5}x\d{2,5}$/;
const GIT_REF_RE = /^[0-9a-f]{7,64}$/i;
const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const GIT_BRANCH_RE = /^(?![-.])(?!.*\.\.)(?!.*@\{)[A-Za-z0-9._/-]{1,128}(?<!\.lock)(?<![./])$/;
const DIFF_STATUSES: DiffEvidenceStatus[] = ["captured", "empty", "unavailable"];
const FILES_SCOPES: DiffFilesScope[] = ["baseline-relative", "worktree", "none"];
const EFFECTIVE_STATES: EffectiveVerificationState[] = ["passed", "failed", "stale", "unknown"];
const COVERAGE_STATES: CriterionCoverageState[] = ["passed", "failed", "stale", "unverified", "unavailable"];
const SCREENSHOT_TRIGGERS: ScreenshotTrigger[] = ["auto_submit", "manual"];
const SCREENSHOT_STATUSES: ScreenshotBatchStatus[] = ["captured", "partial", "skipped"];
const SCREENSHOT_SKIP_REASON_CODES: ScreenshotSkipReasonCode[] = [
  "browser_missing",
  "chrome_path_missing",
  "puppeteer_path_missing",
  "server_unavailable",
  "browser_launch_failed",
  "no_shots",
];

export function validateGitHubRepoSlug(repo: string): string {
  const trimmed = repo.trim();
  if (!GITHUB_REPO_RE.test(trimmed)) {
    throw new WorkbenchError("invalid_input", `无效的 GitHub 仓库标识（应为 owner/repo）: ${repo}`);
  }
  return trimmed;
}

export function validateGitBranchName(branch: string): string {
  const trimmed = branch.trim();
  if (!GIT_BRANCH_RE.test(trimmed) || trimmed.includes("//") || trimmed === "HEAD") {
    throw new WorkbenchError("invalid_input", `非法的 Git 分支名: ${branch}`);
  }
  return trimmed;
}

function isSafeHttpsUrl(raw: unknown, maxBytes = 1024): raw is string {
  if (!isSafeText(raw, maxBytes)) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isSafeText(value: unknown, maxBytes: number, allowEmpty = false): value is string {
  if (typeof value !== "string") return false;
  if (!allowEmpty && value.trim().length === 0) return false;
  if (Buffer.byteLength(value, "utf8") > maxBytes) return false;
  if (CONTROL_CHARS.test(value) || LONE_SURROGATE.test(value)) return false;
  return true;
}

export function isSafeInt(value: unknown, min = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

const FORBIDDEN_EXTENSION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function assertAllowedKeys(obj: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new WorkbenchError("corrupt_record", `${label} 包含未知字段: ${key}`);
    }
  }
}

/**
 * Validates object keys on versioned persisted records while allowing forward-compatible
 * optional extension fields under the same schemaVersion (e.g. written by an RSI branch).
 */
function assertSafeExtensionKeys(obj: Record<string, unknown>, label: string): void {
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_EXTENSION_KEYS.has(key) || !isSafeText(key, 128)) {
      throw new WorkbenchError("corrupt_record", `${label} 包含非法字段名`);
    }
  }
}

export function assertRequirementId(id: string): string {
  if (typeof id !== "string" || !REQUIREMENT_ID_RE.test(id)) {
    throw new WorkbenchError("invalid_input", `无效的需求编号: ${String(id)}`);
  }
  return id;
}

/** Derives a clean single-line title from raw goal markdown if the user omitted a title. */
export function deriveTitleFromGoal(goal: string): string {
  const firstNonEmpty =
    goal
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find((line) => line.length > 0) ?? "";
  if (!firstNonEmpty) {
    throw new WorkbenchError("invalid_input", "需求目标不能为空");
  }
  const chars = Array.from(firstNonEmpty);
  return chars.length <= 60 ? firstNonEmpty : `${chars.slice(0, 57).join("").trimEnd()}...`;
}

export function normalizeTitle(title: string): string {
  const clean = title.replace(/\s+/g, " ").trim();
  if (!clean) {
    throw new WorkbenchError("invalid_input", "需求标题不能为空");
  }
  const chars = Array.from(clean);
  if (chars.length > MAX_TITLE_CHARS || CONTROL_CHARS.test(clean) || LONE_SURROGATE.test(clean)) {
    throw new WorkbenchError("invalid_input", `需求标题无效或超过 ${MAX_TITLE_CHARS} 字符`);
  }
  return clean;
}

export function normalizeReason(reason: string, label = "原因"): string {
  const clean = reason.trim();
  if (!clean) {
    throw new WorkbenchError("invalid_input", `${label}不能为空`);
  }
  if (Array.from(clean).length > MAX_REASON_CHARS || CONTROL_CHARS.test(clean) || LONE_SURROGATE.test(clean)) {
    throw new WorkbenchError("invalid_input", `${label}无效或超过 ${MAX_REASON_CHARS} 字符`);
  }
  return clean;
}

export function normalizeCriteria(inputs: CriterionInput[]): Criterion[] {
  if (!Array.isArray(inputs) || inputs.length > MAX_CRITERIA) {
    throw new WorkbenchError("invalid_input", `验收条件数量不能超过 ${MAX_CRITERIA} 条`);
  }
  const usedIds = new Set<string>();
  const result: Criterion[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const raw = inputs[i];
    if (!isRecord(raw) || !isSafeText(raw.description, 1000)) {
      throw new WorkbenchError("invalid_input", `第 ${i + 1} 条验收条件描述无效`);
    }
    let id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `AC-${i + 1}`;
    if (!TOKEN_ID_RE.test(id)) {
      throw new WorkbenchError("invalid_input", `验收条件 ID 格式无效: ${id}`);
    }
    if (usedIds.has(id)) {
      throw new WorkbenchError("invalid_input", `验收条件 ID 重复: ${id}`);
    }
    usedIds.add(id);
    const item: Criterion = {
      id,
      description: raw.description.trim(),
      required: raw.required === undefined ? true : Boolean(raw.required),
    };
    if (typeof raw.command === "string" && raw.command.trim().length > 0) {
      if (!isSafeText(raw.command, 512)) {
        throw new WorkbenchError("invalid_input", `验收条件 ${id} 的验证命令无效或过长`);
      }
      item.command = raw.command.trim();
    }
    result.push(item);
  }
  return result;
}

export function normalizeTasks(inputs: TaskInput[], existing: TaskItem[], now: number): TaskItem[] {
  if (!Array.isArray(inputs) || inputs.length > MAX_TASKS) {
    throw new WorkbenchError("invalid_input", `实施任务数量不能超过 ${MAX_TASKS} 条`);
  }
  let nextNum = 1;
  for (const prev of existing) {
    const match = /^T-(\d+)$/.exec(prev.id);
    if (match) nextNum = Math.max(nextNum, Number(match[1]) + 1);
  }
  const existingMap = new Map(existing.map((t) => [t.id, t]));
  const usedIds = new Set<string>();
  const out: TaskItem[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const raw = inputs[i];
    if (!isRecord(raw) || !isSafeText(raw.title, 500)) {
      throw new WorkbenchError("invalid_input", `第 ${i + 1} 条任务标题无效`);
    }
    if (!TASK_STATUSES.includes(raw.status as TaskStatus)) {
      throw new WorkbenchError("invalid_input", `任务状态无效: ${String(raw.status)}`);
    }
    let id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : "";
    if (!id) {
      while (usedIds.has(`T-${nextNum}`) || existingMap.has(`T-${nextNum}`)) nextNum++;
      id = `T-${nextNum++}`;
    } else if (!TOKEN_ID_RE.test(id)) {
      throw new WorkbenchError("invalid_input", `任务 ID 无效: ${id}`);
    }
    if (usedIds.has(id)) {
      throw new WorkbenchError("invalid_input", `任务 ID 重复: ${id}`);
    }
    usedIds.add(id);
    const prev = existingMap.get(id);
    const note = typeof raw.note === "string" && raw.note.trim() ? raw.note.trim() : undefined;
    if (note && !isSafeText(note, 1000)) {
      throw new WorkbenchError("invalid_input", `任务 ${id} 的备注无效或过长`);
    }
    const unchanged =
      prev && prev.title === raw.title.trim() && prev.status === raw.status && prev.note === note;
    out.push({
      id,
      title: raw.title.trim(),
      status: raw.status as TaskStatus,
      ...(note ? { note } : {}),
      updatedAt: unchanged ? prev.updatedAt : now,
    });
  }
  return out;
}

function validateProjectGitHubConfig(raw: unknown): ProjectGitHubConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "project.json github 配置必须是对象");
  assertAllowedKeys(raw, ["repo", "autoCreateIssue", "autoSyncIssue", "defaultBaseBranch"], "project.github");
  if (raw.repo !== undefined && (typeof raw.repo !== "string" || !GITHUB_REPO_RE.test(raw.repo.trim()))) {
    throw new WorkbenchError("corrupt_record", "project.github.repo 格式不合法");
  }
  if (raw.autoCreateIssue !== undefined && typeof raw.autoCreateIssue !== "boolean") {
    throw new WorkbenchError("corrupt_record", "project.github.autoCreateIssue 必须是布尔值");
  }
  if (raw.autoSyncIssue !== undefined && typeof raw.autoSyncIssue !== "boolean") {
    throw new WorkbenchError("corrupt_record", "project.github.autoSyncIssue 必须是布尔值");
  }
  if (
    raw.defaultBaseBranch !== undefined &&
    (typeof raw.defaultBaseBranch !== "string" || !GIT_BRANCH_RE.test(raw.defaultBaseBranch.trim()) || raw.defaultBaseBranch.includes("//"))
  ) {
    throw new WorkbenchError("corrupt_record", "project.github.defaultBaseBranch 格式不合法");
  }
  return raw as unknown as ProjectGitHubConfig;
}

export function validateProjectMetadata(raw: unknown): ProjectMetadata {
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "project.json 必须是对象");
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw new WorkbenchError("unsupported_schema", `不支持的 project.json 版本: ${String(raw.schemaVersion)}`);
  }
  assertSafeExtensionKeys(raw, "project.json");
  if (
    typeof raw.projectId !== "string" ||
    !TOKEN_ID_RE.test(raw.projectId) ||
    !isSafeText(raw.name, 200) ||
    !isSafeInt(raw.nextNumber, 1) ||
    (raw.privacyMode !== "local" && raw.privacyMode !== "tracked") ||
    (raw.outputLanguage !== undefined && !OUTPUT_LANGUAGES.includes(raw.outputLanguage as OutputLanguage)) ||
    !isSafeInt(raw.createdAt, 0) ||
    !isSafeInt(raw.updatedAt, 0)
  ) {
    throw new WorkbenchError("corrupt_record", "project.json 字段不合法");
  }
  validateProjectGitHubConfig(raw.github);
  return raw as unknown as ProjectMetadata;
}

function validateApproval(raw: unknown): ApprovalRecord | null {
  if (raw === null) return null;
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "approval 字段无效");
  assertAllowedKeys(
    raw,
    ["approvedAt", "track", "specHash", "designVersion", "designHash", "baselineHead", "baselineFingerprint", "note"],
    "approval",
  );
  if (
    !isSafeInt(raw.approvedAt, 0) ||
    !TRACKS.includes(raw.track as Track) ||
    typeof raw.specHash !== "string" ||
    !SHA256_RE.test(raw.specHash) ||
    !isSafeInt(raw.designVersion, 0) ||
    typeof raw.designHash !== "string" ||
    (raw.designHash !== "" && !SHA256_RE.test(raw.designHash)) ||
    (raw.baselineHead !== null && typeof raw.baselineHead !== "string") ||
    (raw.baselineFingerprint !== null && typeof raw.baselineFingerprint !== "string")
  ) {
    throw new WorkbenchError("corrupt_record", "approval 记录损坏");
  }
  return raw as unknown as ApprovalRecord;
}

function validateAcceptanceSnapshotReference(raw: unknown): AcceptanceSnapshotReference | null | undefined {
  if (raw === null || raw === undefined) return raw === null ? null : undefined;
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "acceptance.snapshot 引用字段无效");
  assertAllowedKeys(
    raw,
    ["id", "path", "schemaVersion", "capturedAt", "contentDigest", "sizeBytes"],
    "acceptance.snapshot",
  );
  if (
    typeof raw.id !== "string" ||
    !TOKEN_ID_RE.test(raw.id) ||
    typeof raw.path !== "string" ||
    !SNAPSHOT_PATH_RE.test(raw.path) ||
    raw.schemaVersion !== ACCEPTANCE_SNAPSHOT_SCHEMA_VERSION ||
    !isSafeInt(raw.capturedAt, 0) ||
    typeof raw.contentDigest !== "string" ||
    !SHA256_RE.test(raw.contentDigest) ||
    !isSafeInt(raw.sizeBytes, 0)
  ) {
    throw new WorkbenchError("corrupt_record", "acceptance.snapshot 引用记录损坏");
  }
  if (raw.path !== `snapshots/acceptance-${raw.id}.json`) {
    throw new WorkbenchError("corrupt_record", "acceptance.snapshot 引用路径越出需求存储范围");
  }
  return raw as unknown as AcceptanceSnapshotReference;
}

function validateReviewDisposition(raw: unknown): ReviewDisposition | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "acceptance.reviewDisposition 字段无效");
  assertAllowedKeys(raw, ["reviewId", "verdict", "effectiveState", "acceptedRisks"], "acceptance.reviewDisposition");
  if (
    (raw.reviewId !== undefined && (typeof raw.reviewId !== "string" || !TOKEN_ID_RE.test(raw.reviewId))) ||
    (raw.verdict !== undefined && !REVIEW_VERDICTS.includes(raw.verdict as ReviewVerdict)) ||
    !["current", "stale", "missing"].includes(String(raw.effectiveState)) ||
    (raw.acceptedRisks !== undefined &&
      (!Array.isArray(raw.acceptedRisks) ||
        raw.acceptedRisks.length > 50 ||
        raw.acceptedRisks.some((r) => !isSafeText(r, 1000))))
  ) {
    throw new WorkbenchError("corrupt_record", "acceptance.reviewDisposition 记录损坏");
  }
  return raw as unknown as ReviewDisposition;
}

function validateAcceptance(raw: unknown): AcceptanceRecord | null {
  if (raw === null) return null;
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "acceptance 字段无效");
  assertAllowedKeys(
    raw,
    ["acceptedAt", "specHash", "codeSnapshotHash", "verificationIds", "note", "overrideReason", "reviewDisposition", "snapshot"],
    "acceptance",
  );
  if (
    !isSafeInt(raw.acceptedAt, 0) ||
    typeof raw.specHash !== "string" ||
    !SHA256_RE.test(raw.specHash) ||
    typeof raw.codeSnapshotHash !== "string" ||
    !SHA256_RE.test(raw.codeSnapshotHash) ||
    !Array.isArray(raw.verificationIds) ||
    raw.verificationIds.some((id) => typeof id !== "string" || !TOKEN_ID_RE.test(id)) ||
    (raw.note !== undefined && !isSafeText(raw.note, MAX_REASON_CHARS, true)) ||
    (raw.overrideReason !== undefined && !isSafeText(raw.overrideReason, MAX_REASON_CHARS, true))
  ) {
    throw new WorkbenchError("corrupt_record", "acceptance 记录损坏");
  }
  validateReviewDisposition(raw.reviewDisposition);
  validateAcceptanceSnapshotReference(raw.snapshot);
  return raw as unknown as AcceptanceRecord;
}

function validateDelivery(raw: unknown): DeliveryRecord | null | undefined {
  if (raw === undefined || raw === null) return raw === null ? null : undefined;
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "delivery 字段无效");
  assertAllowedKeys(
    raw,
    ["deliveredAt", "commitHash", "shortHash", "commitMessage", "files", "branch", "prNumber", "prUrl", "note"],
    "delivery",
  );
  const hasPr = typeof raw.prNumber === "number";
  if (
    !isSafeInt(raw.deliveredAt, 0) ||
    typeof raw.commitHash !== "string" ||
    !GIT_REF_RE.test(raw.commitHash) ||
    typeof raw.shortHash !== "string" ||
    !isSafeText(raw.shortHash, 64) ||
    !isSafeText(raw.commitMessage, 4000) ||
    !Array.isArray(raw.files) ||
    (!hasPr && raw.files.length === 0) ||
    raw.files.length > 5000 ||
    raw.files.some((f) => typeof f !== "string" || !isSafeText(f, 4096) || f.startsWith("/") || f.split("/").includes("..")) ||
    (raw.branch !== null && !isSafeText(raw.branch, 256)) ||
    (raw.prNumber !== undefined && !isSafeInt(raw.prNumber, 1)) ||
    (raw.prUrl !== undefined && !isSafeHttpsUrl(raw.prUrl)) ||
    (raw.note !== undefined && !isSafeText(raw.note, MAX_REASON_CHARS, true))
  ) {
    throw new WorkbenchError("corrupt_record", "delivery 记录损坏");
  }
  return raw as unknown as DeliveryRecord;
}

function validateBaseline(raw: unknown): BaselineSnapshot | null {
  if (raw === null) return null;
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "baseline 字段无效");
  assertAllowedKeys(raw, ["head", "fingerprint", "dirty", "capturedAt"], "baseline");
  if (
    typeof raw.head !== "string" ||
    typeof raw.fingerprint !== "string" ||
    !SHA256_RE.test(raw.fingerprint) ||
    typeof raw.dirty !== "boolean" ||
    !isSafeInt(raw.capturedAt, 0)
  ) {
    throw new WorkbenchError("corrupt_record", "baseline 记录损坏");
  }
  return raw as unknown as BaselineSnapshot;
}

export function validateVerificationRecord(raw: unknown): VerificationRecord {
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "verification 记录必须是对象");
  assertAllowedKeys(
    raw,
    [
      "id",
      "command",
      "cwd",
      "criterionIds",
      "specHash",
      "codeSnapshotHash",
      "exitCode",
      "timedOut",
      "durationMs",
      "startedAt",
      "endedAt",
      "passed",
      "outputPath",
      "outputPreview",
      "truncated",
    ],
    "verification",
  );
  if (
    typeof raw.id !== "string" ||
    !TOKEN_ID_RE.test(raw.id) ||
    !isSafeText(raw.command, 2048) ||
    typeof raw.cwd !== "string" ||
    !Array.isArray(raw.criterionIds) ||
    raw.criterionIds.some((id) => typeof id !== "string" || !TOKEN_ID_RE.test(id)) ||
    typeof raw.specHash !== "string" ||
    !SHA256_RE.test(raw.specHash) ||
    typeof raw.codeSnapshotHash !== "string" ||
    !SHA256_RE.test(raw.codeSnapshotHash) ||
    (raw.exitCode !== null && !Number.isSafeInteger(raw.exitCode)) ||
    typeof raw.timedOut !== "boolean" ||
    !isSafeInt(raw.durationMs, 0) ||
    !isSafeInt(raw.startedAt, 0) ||
    !isSafeInt(raw.endedAt, 0) ||
    typeof raw.passed !== "boolean" ||
    typeof raw.outputPath !== "string" ||
    typeof raw.outputPreview !== "string" ||
    typeof raw.truncated !== "boolean"
  ) {
    throw new WorkbenchError("corrupt_record", "verification 记录字段不合法");
  }
  return raw as unknown as VerificationRecord;
}

function validateCriterionEntry(raw: unknown, label: string): Criterion {
  if (!isRecord(raw) || typeof raw.id !== "string" || !TOKEN_ID_RE.test(raw.id) || !isSafeText(raw.description, 1000) || typeof raw.required !== "boolean") {
    throw new WorkbenchError("corrupt_record", `${label} 中的验收条件损坏`);
  }
  const command = raw.command;
  if (command !== undefined && (typeof command !== "string" || !isSafeText(command, 512))) {
    throw new WorkbenchError("corrupt_record", `${label} 中的验收条件命令损坏`);
  }
  return raw as unknown as Criterion;
}

function validateChangedFileEntry(raw: unknown, label: string): ChangedFile {
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", `${label} 的文件记录无效`);
  assertAllowedKeys(raw, ["path", "status", "staged", "unstaged"], `${label}.files`);
  if (
    !isSafeText(raw.path, 4096) ||
    raw.path.startsWith("/") ||
    raw.path.split("/").includes("..") ||
    !isSafeText(raw.status, 8) ||
    typeof raw.staged !== "boolean" ||
    typeof raw.unstaged !== "boolean"
  ) {
    throw new WorkbenchError("corrupt_record", `${label} 的文件记录损坏`);
  }
  return raw as unknown as ChangedFile;
}

function validateCommitInfoEntry(raw: unknown, label: string): CommitInfo {
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", `${label} 的提交记录无效`);
  assertAllowedKeys(raw, ["hash", "shortHash", "author", "at", "subject"], `${label}.commits`);
  if (
    typeof raw.hash !== "string" ||
    !GIT_REF_RE.test(raw.hash) ||
    typeof raw.shortHash !== "string" ||
    !isSafeText(raw.author, 400, true) ||
    !isSafeInt(raw.at, 0) ||
    !isSafeText(raw.subject, 2000, true)
  ) {
    throw new WorkbenchError("corrupt_record", `${label} 的提交记录损坏`);
  }
  return raw as unknown as CommitInfo;
}

export function validateAcceptanceGitEvidence(raw: unknown): AcceptanceGitEvidence {
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "acceptance git 证据必须是对象");
  assertAllowedKeys(
    raw,
    [
      "diffStatus",
      "reason",
      "isGitRepo",
      "baselineRequested",
      "baselineHead",
      "baselineAvailable",
      "observedHead",
      "fingerprint",
      "dirty",
      "files",
      "filesScope",
      "commits",
      "diff",
      "diffBytes",
      "diffTruncated",
      "maxDiffBytes",
      "binaryFiles",
      "omittedFiles",
      "capturedAt",
    ],
    "acceptance.git",
  );
  if (
    !DIFF_STATUSES.includes(raw.diffStatus as DiffEvidenceStatus) ||
    (raw.reason !== null && !isSafeText(raw.reason, 2000)) ||
    typeof raw.isGitRepo !== "boolean" ||
    (raw.baselineRequested !== null && (typeof raw.baselineRequested !== "string" || !GIT_REF_RE.test(raw.baselineRequested))) ||
    (raw.baselineHead !== null && (typeof raw.baselineHead !== "string" || !GIT_REF_RE.test(raw.baselineHead))) ||
    typeof raw.baselineAvailable !== "boolean" ||
    typeof raw.observedHead !== "string" ||
    (raw.fingerprint !== null && (typeof raw.fingerprint !== "string" || !SHA256_RE.test(raw.fingerprint))) ||
    typeof raw.dirty !== "boolean" ||
    !FILES_SCOPES.includes(raw.filesScope as DiffFilesScope) ||
    !Array.isArray(raw.files) ||
    raw.files.length > 5000 ||
    !Array.isArray(raw.commits) ||
    raw.commits.length > 100 ||
    !isSafeText(raw.diff, MAX_ACCEPTANCE_DIFF_BYTES, true) ||
    !isSafeInt(raw.diffBytes, 0) ||
    typeof raw.diffTruncated !== "boolean" ||
    !isSafeInt(raw.maxDiffBytes, 1) ||
    !Array.isArray(raw.binaryFiles) ||
    !Array.isArray(raw.omittedFiles) ||
    raw.binaryFiles.some((p) => typeof p !== "string" || !isSafeText(p, 4096)) ||
    raw.omittedFiles.some((p) => typeof p !== "string" || !isSafeText(p, 4096)) ||
    !isSafeInt(raw.capturedAt, 0)
  ) {
    throw new WorkbenchError("corrupt_record", "acceptance git 证据损坏");
  }
  for (const file of raw.files) validateChangedFileEntry(file, "acceptance.git");
  for (const commit of raw.commits) validateCommitInfoEntry(commit, "acceptance.git");
  if (raw.diffStatus === "captured" && raw.diffBytes !== Buffer.byteLength(String(raw.diff), "utf8")) {
    throw new WorkbenchError("corrupt_record", "acceptance git 证据的 diff 字节数与内容不一致");
  }
  return raw as unknown as AcceptanceGitEvidence;
}

export function validateAcceptanceVerificationEvidence(raw: unknown): AcceptanceVerificationEvidence {
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "acceptance 验证证据必须是对象");
  assertAllowedKeys(raw, ["record", "effectiveState", "staleReason", "selectedForAcceptance"], "acceptance.verification");
  if (
    !EFFECTIVE_STATES.includes(raw.effectiveState as EffectiveVerificationState) ||
    (raw.staleReason !== null && !isSafeText(raw.staleReason, 2000)) ||
    typeof raw.selectedForAcceptance !== "boolean"
  ) {
    throw new WorkbenchError("corrupt_record", "acceptance 验证证据损坏");
  }
  return {
    record: validateVerificationRecord(raw.record),
    effectiveState: raw.effectiveState as EffectiveVerificationState,
    staleReason: (raw.staleReason ?? null) as string | null,
    selectedForAcceptance: raw.selectedForAcceptance,
  };
}

export function validateScreenshotShot(raw: unknown): ScreenshotShot {
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "截图记录必须是对象");
  assertAllowedKeys(raw, ["id", "label", "urlPath", "viewport", "theme", "path", "sha256", "sizeBytes"], "screenshot");
  if (
    typeof raw.id !== "string" ||
    !SCREENSHOT_SHOT_ID_RE.test(raw.id) ||
    !isSafeText(raw.label, 300) ||
    !isSafeText(raw.urlPath, 4096) ||
    !SCREENSHOT_VIEWPORT_RE.test(String(raw.viewport)) ||
    (raw.theme !== "light" && raw.theme !== "dark") ||
    typeof raw.path !== "string" ||
    !SCREENSHOT_PATH_RE.test(raw.path) ||
    raw.path !== `screenshots/shot-${raw.id}.png` ||
    typeof raw.sha256 !== "string" ||
    !SHA256_RE.test(raw.sha256) ||
    !isSafeInt(raw.sizeBytes, 0) ||
    raw.sizeBytes > MAX_SCREENSHOT_BYTES
  ) {
    throw new WorkbenchError("corrupt_record", "截图记录字段损坏");
  }
  return raw as unknown as ScreenshotShot;
}

export function validateScreenshotBatch(raw: unknown): ScreenshotBatch {
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "截图批次必须是对象");
  assertAllowedKeys(
    raw,
    [
      "id",
      "createdAt",
      "trigger",
      "actor",
      "specHash",
      "codeSnapshotHash",
      "status",
      "skipReason",
      "reasonCode",
      "shots",
      "durationMs",
    ],
    "screenshotBatch",
  );
  if (
    raw.reasonCode !== undefined &&
    raw.reasonCode !== null &&
    !SCREENSHOT_SKIP_REASON_CODES.includes(raw.reasonCode as ScreenshotSkipReasonCode)
  ) {
    throw new WorkbenchError("corrupt_record", "截图跳过原因码无效");
  }
  if (
    typeof raw.id !== "string" ||
    !SCREENSHOT_BATCH_ID_RE.test(raw.id) ||
    !isSafeInt(raw.createdAt, 0) ||
    !SCREENSHOT_TRIGGERS.includes(raw.trigger as ScreenshotTrigger) ||
    (raw.actor !== "agent" && raw.actor !== "human" && raw.actor !== "system") ||
    typeof raw.specHash !== "string" ||
    !SHA256_RE.test(raw.specHash) ||
    typeof raw.codeSnapshotHash !== "string" ||
    !SHA256_RE.test(raw.codeSnapshotHash) ||
    !SCREENSHOT_STATUSES.includes(raw.status as ScreenshotBatchStatus) ||
    (raw.skipReason !== null && !isSafeText(raw.skipReason, 4000, true)) ||
    !Array.isArray(raw.shots) ||
    raw.shots.length > MAX_SCREENSHOTS_PER_BATCH ||
    (raw.status === "captured" && raw.shots.length === 0) ||
    !isSafeInt(raw.durationMs, 0)
  ) {
    throw new WorkbenchError("corrupt_record", "截图批次字段损坏");
  }
  const seen = new Set<string>();
  for (const shot of raw.shots) {
    const validated = validateScreenshotShot(shot);
    if (seen.has(validated.id)) {
      throw new WorkbenchError("corrupt_record", "截图批次包含重复的截图 ID");
    }
    seen.add(validated.id);
  }
  return raw as unknown as ScreenshotBatch;
}

export function validateScreenshotBatches(raw: unknown): ScreenshotBatch[] {
  if (!Array.isArray(raw) || raw.length > MAX_SCREENSHOT_BATCHES) {
    throw new WorkbenchError("corrupt_record", `截图批次数量不能超过 ${MAX_SCREENSHOT_BATCHES} 批`);
  }
  const seen = new Set<string>();
  const out = raw.map((item) => validateScreenshotBatch(item));
  for (const batch of out) {
    if (seen.has(batch.id)) {
      throw new WorkbenchError("corrupt_record", "截图批次 ID 重复");
    }
    seen.add(batch.id);
  }
  return out;
}

/** Validates one frozen acceptance artifact; guarantees the stored bytes can be trusted as history. */
export function validateAcceptanceSnapshot(raw: unknown, expectedRequirementId?: string): AcceptanceSnapshot {
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "验收快照必须是对象");
  assertSafeExtensionKeys(raw, "验收快照");
  if (
    raw.schemaVersion !== ACCEPTANCE_SNAPSHOT_SCHEMA_VERSION ||
    typeof raw.id !== "string" ||
    !TOKEN_ID_RE.test(raw.id) ||
    typeof raw.requirementId !== "string" ||
    !REQUIREMENT_ID_RE.test(raw.requirementId) ||
    (expectedRequirementId && raw.requirementId !== expectedRequirementId) ||
    !isSafeInt(raw.capturedAt, 0) ||
    !isSafeInt(raw.acceptedAt, 0) ||
    typeof raw.specHash !== "string" ||
    !SHA256_RE.test(raw.specHash) ||
    (raw.designHash !== "" && (typeof raw.designHash !== "string" || !SHA256_RE.test(raw.designHash))) ||
    typeof raw.codeSnapshotHash !== "string" ||
    !SHA256_RE.test(raw.codeSnapshotHash) ||
    (raw.codeRootKind !== "project" && raw.codeRootKind !== "sandbox") ||
    !Array.isArray(raw.criteria) ||
    raw.criteria.length > MAX_CRITERIA ||
    !Array.isArray(raw.coverage) ||
    !isSafeInt(raw.requiredTotal, 0) ||
    !isSafeInt(raw.requiredPassed, 0) ||
    !Array.isArray(raw.verifications) ||
    raw.verifications.length > MAX_SNAPSHOT_VERIFICATIONS ||
    !isSafeInt(raw.omittedVerificationCount, 0)
  ) {
    throw new WorkbenchError("corrupt_record", "验收快照字段损坏");
  }
  for (const criterion of raw.criteria) validateCriterionEntry(criterion, "验收快照");
  for (const item of raw.coverage) {
    if (!isRecord(item)) throw new WorkbenchError("corrupt_record", "验收快照覆盖记录损坏");
    assertAllowedKeys(item, ["criterion", "state", "verificationIds", "reason"], "验收快照.coverage");
    if (
      !COVERAGE_STATES.includes(item.state as CriterionCoverageState) ||
      (item.reason !== null && !isSafeText(item.reason, 2000)) ||
      !Array.isArray(item.verificationIds) ||
      item.verificationIds.some((id) => typeof id !== "string" || !TOKEN_ID_RE.test(id))
    ) {
      throw new WorkbenchError("corrupt_record", "验收快照覆盖记录损坏");
    }
    validateCriterionEntry(item.criterion, "验收快照.coverage");
  }
  for (const verification of raw.verifications) validateAcceptanceVerificationEvidence(verification);
  validateAcceptanceGitEvidence(raw.git);
  if (raw.screenshots !== undefined) validateScreenshotBatches(raw.screenshots);
  if (typeof raw.contentDigest !== "string" || !SHA256_RE.test(raw.contentDigest)) {
    throw new WorkbenchError("corrupt_record", "验收快照缺少有效内容摘要");
  }
  return raw as unknown as AcceptanceSnapshot;
}

function validateHandoffNote(raw: unknown): HandoffNote | null {
  if (raw === null || raw === undefined) return null;

  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "handoffNote 字段无效");
  assertAllowedKeys(raw, ["updatedAt", "keyDecisions", "deadEnds", "nextSteps"], "handoffNote");
  const isStrList = (v: unknown) =>
    Array.isArray(v) && v.length <= 32 && v.every((item) => isSafeText(item, 1000));
  if (!isSafeInt(raw.updatedAt, 0) || !isStrList(raw.keyDecisions) || !isStrList(raw.deadEnds) || !isStrList(raw.nextSteps)) {
    throw new WorkbenchError("corrupt_record", "handoffNote 记录损坏");
  }
  return raw as unknown as HandoffNote;
}

function validateDiscussionEntry(raw: unknown): DiscussionEntry {
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "discussion 字段无效");
  assertAllowedKeys(
    raw,
    ["id", "at", "actor", "mode", "anchor", "harness", "model", "message", "resolved"],
    "discussion",
  );
  if (
    typeof raw.id !== "string" ||
    !TOKEN_ID_RE.test(raw.id) ||
    !isSafeInt(raw.at, 0) ||
    (raw.actor !== "human" && raw.actor !== "agent") ||
    (raw.mode !== "ask" && raw.mode !== "refine") ||
    !isSafeText(raw.message, 32 * 1024)
  ) {
    throw new WorkbenchError("corrupt_record", "discussion 记录损坏");
  }
  return raw as unknown as DiscussionEntry;
}

export function validateAgentRunRecord(raw: unknown): AgentRunRecord {
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "agentRun 记录必须是对象");
  assertAllowedKeys(
    raw,
    [
      "id",
      "action",
      "harness",
      "model",
      "effectiveModel",
      "modelFallback",
      "reasoningEffort",
      "nativeSessionId",
      "status",
      "startedAt",
      "endedAt",
      "exitCode",
      "durationMs",
      "rateLimited",
      "errorSummary",
      "logPath",
    ],
    "agentRun",
  );
  if (
    typeof raw.id !== "string" ||
    !TOKEN_ID_RE.test(raw.id) ||
    !AGENT_ACTIONS.includes(raw.action as AgentAction) ||
    !isSafeText(raw.harness, 64) ||
    !isSafeText(raw.model, 200) ||
    (raw.effectiveModel !== undefined && !isSafeText(raw.effectiveModel, 200)) ||
    (raw.modelFallback !== undefined && typeof raw.modelFallback !== "boolean") ||
    !["running", "succeeded", "failed", "cancelled"].includes(String(raw.status)) ||
    !isSafeInt(raw.startedAt, 0) ||
    (raw.endedAt !== null && !isSafeInt(raw.endedAt, 0)) ||
    (raw.exitCode !== null && !Number.isSafeInteger(raw.exitCode)) ||
    !isSafeInt(raw.durationMs, 0) ||
    typeof raw.logPath !== "string"
  ) {
    throw new WorkbenchError("corrupt_record", "agentRun 记录损坏");
  }
  return raw as unknown as AgentRunRecord;
}

function validateReviewFinding(raw: unknown): ReviewFinding {
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "reviewReport.findings 项无效");
  assertAllowedKeys(raw, ["id", "severity", "title", "detail", "criterionIds", "files", "suggestion"], "reviewReport.finding");
  if (
    typeof raw.id !== "string" ||
    !TOKEN_ID_RE.test(raw.id) ||
    !REVIEW_FINDING_SEVERITIES.includes(raw.severity as ReviewFindingSeverity) ||
    !isSafeText(raw.title, 400) ||
    (raw.detail !== undefined && !isSafeText(raw.detail, 2000, true)) ||
    (raw.suggestion !== undefined && !isSafeText(raw.suggestion, 1500, true)) ||
    (raw.criterionIds !== undefined &&
      (!Array.isArray(raw.criterionIds) ||
        raw.criterionIds.length > 32 ||
        raw.criterionIds.some((cid) => typeof cid !== "string" || !TOKEN_ID_RE.test(cid)))) ||
    (raw.files !== undefined &&
      (!Array.isArray(raw.files) ||
        raw.files.length > 32 ||
        raw.files.some((f) => !isSafeText(f, 512))))
  ) {
    throw new WorkbenchError("corrupt_record", "reviewReport.findings 记录损坏");
  }
  return raw as unknown as ReviewFinding;
}

function validateReviewReport(raw: unknown): ReviewReport | null {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "reviewReport 字段无效");
  assertAllowedKeys(
    raw,
    [
      "id",
      "reviewerHarness",
      "reviewerModel",
      "verdict",
      "summary",
      "markdown",
      "findings",
      "reviewedSpecHash",
      "reviewedCodeSnapshotHash",
      "reviewedAt",
    ],
    "reviewReport",
  );
  if (
    typeof raw.id !== "string" ||
    !TOKEN_ID_RE.test(raw.id) ||
    !isSafeText(raw.reviewerHarness, 64) ||
    !isSafeText(raw.reviewerModel, 200) ||
    !REVIEW_VERDICTS.includes(raw.verdict as ReviewVerdict) ||
    !isSafeText(raw.summary, 2000) ||
    !isSafeText(raw.markdown, 64 * 1024) ||
    (raw.findings !== undefined && (!Array.isArray(raw.findings) || raw.findings.length > 50)) ||
    typeof raw.reviewedSpecHash !== "string" ||
    !SHA256_RE.test(raw.reviewedSpecHash) ||
    typeof raw.reviewedCodeSnapshotHash !== "string" ||
    !SHA256_RE.test(raw.reviewedCodeSnapshotHash) ||
    !isSafeInt(raw.reviewedAt, 0)
  ) {
    throw new WorkbenchError("corrupt_record", "reviewReport 记录损坏");
  }
  if (Array.isArray(raw.findings)) {
    for (const f of raw.findings) validateReviewFinding(f);
  }
  return raw as unknown as ReviewReport;
}

function validateRequirementGitHubIssue(raw: unknown): RequirementGitHubIssueLink | null | undefined {
  if (raw === undefined || raw === null) return raw === null ? null : undefined;
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "github.issue 字段无效");
  assertAllowedKeys(raw, ["number", "url", "title", "state", "lastSyncedStage", "lastSyncedAt"], "github.issue");
  if (
    !isSafeInt(raw.number, 1) ||
    !isSafeHttpsUrl(raw.url) ||
    !isSafeText(raw.title, 400) ||
    (raw.state !== "open" && raw.state !== "closed") ||
    (raw.lastSyncedStage !== undefined && !STAGES.includes(raw.lastSyncedStage as Stage)) ||
    !isSafeInt(raw.lastSyncedAt, 0)
  ) {
    throw new WorkbenchError("corrupt_record", "github.issue 记录损坏");
  }
  return raw as unknown as RequirementGitHubIssueLink;
}

function validateRequirementGitHubPr(raw: unknown): RequirementGitHubPrLink | null | undefined {
  if (raw === undefined || raw === null) return raw === null ? null : undefined;
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "github.pr 字段无效");
  assertAllowedKeys(
    raw,
    ["number", "url", "title", "headBranch", "baseBranch", "state", "mergedAt", "lastSyncedAt"],
    "github.pr",
  );
  if (
    !isSafeInt(raw.number, 1) ||
    !isSafeHttpsUrl(raw.url) ||
    !isSafeText(raw.title, 400) ||
    !isSafeText(raw.headBranch, 256) ||
    !isSafeText(raw.baseBranch, 256) ||
    (raw.state !== "open" && raw.state !== "merged" && raw.state !== "closed") ||
    (raw.mergedAt !== undefined && raw.mergedAt !== null && !isSafeInt(raw.mergedAt, 0)) ||
    !isSafeInt(raw.lastSyncedAt, 0)
  ) {
    throw new WorkbenchError("corrupt_record", "github.pr 记录损坏");
  }
  return raw as unknown as RequirementGitHubPrLink;
}

function validateRequirementGitHubLink(raw: unknown): RequirementGitHubLink | null | undefined {
  if (raw === undefined || raw === null) return raw === null ? null : undefined;
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "state.github 字段无效");
  assertAllowedKeys(raw, ["repo", "issue", "pr"], "state.github");
  if (typeof raw.repo !== "string" || !GITHUB_REPO_RE.test(raw.repo)) {
    throw new WorkbenchError("corrupt_record", "state.github.repo 格式损坏");
  }
  validateRequirementGitHubIssue(raw.issue);
  validateRequirementGitHubPr(raw.pr);
  return raw as unknown as RequirementGitHubLink;
}

export function validateRequirementState(raw: unknown, expectedId?: string): RequirementState {
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "state.json 必须是对象");
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw new WorkbenchError("unsupported_schema", `不支持的 state.json 版本: ${String(raw.schemaVersion)}`);
  }
  assertSafeExtensionKeys(raw, "state.json");
  if (
    typeof raw.id !== "string" ||
    !REQUIREMENT_ID_RE.test(raw.id) ||
    (expectedId && raw.id !== expectedId) ||
    !isSafeText(raw.title, 400) ||
    !STAGES.includes(raw.stage as Stage) ||
    !TRACKS.includes(raw.track as Track) ||
    !isSafeInt(raw.revision, 1) ||
    typeof raw.specHash !== "string" ||
    !SHA256_RE.test(raw.specHash) ||
    !isSafeInt(raw.designVersion, 0) ||
    typeof raw.designHash !== "string" ||
    (raw.designHash !== "" && !SHA256_RE.test(raw.designHash)) ||
    !Array.isArray(raw.criteria) ||
    !Array.isArray(raw.tasks) ||
    !Array.isArray(raw.verifications) ||
    !Array.isArray(raw.timeline) ||
    raw.timeline.length > MAX_TIMELINE ||
    (raw.discussions !== undefined && (!Array.isArray(raw.discussions) || raw.discussions.length > MAX_DISCUSSIONS)) ||
    (raw.agentRuns !== undefined && (!Array.isArray(raw.agentRuns) || raw.agentRuns.length > MAX_AGENT_RUNS)) ||
    (raw.lastFeedback !== null && !isSafeText(raw.lastFeedback, 8000, true)) ||
    (raw.blockedFrom !== null && !STAGES.includes(raw.blockedFrom as Stage)) ||
    (raw.blockedReason !== null && !isSafeText(raw.blockedReason, 8000, true)) ||
    (raw.uiRelated !== undefined && typeof raw.uiRelated !== "boolean") ||
    !isSafeInt(raw.createdAt, 0) ||
    !isSafeInt(raw.updatedAt, 0)
  ) {
    throw new WorkbenchError("corrupt_record", "state.json 字段校验失败");
  }
  for (const c of raw.criteria) {
    if (
      !isRecord(c) ||
      typeof c.id !== "string" ||
      !TOKEN_ID_RE.test(c.id) ||
      !isSafeText(c.description, 1000) ||
      typeof c.required !== "boolean"
    ) {
      throw new WorkbenchError("corrupt_record", "criteria 记录损坏");
    }
  }
  for (const t of raw.tasks) {
    if (
      !isRecord(t) ||
      typeof t.id !== "string" ||
      !TOKEN_ID_RE.test(t.id) ||
      !isSafeText(t.title, 500) ||
      !TASK_STATUSES.includes(t.status as TaskStatus) ||
      !isSafeInt(t.updatedAt, 0)
    ) {
      throw new WorkbenchError("corrupt_record", "tasks 记录损坏");
    }
  }
  validateApproval(raw.approval);
  validateAcceptance(raw.acceptance);
  validateDelivery(raw.delivery);
  validateBaseline(raw.baseline);
  validateHandoffNote(raw.handoffNote);
  validateReviewReport(raw.reviewReport);
  validateRequirementGitHubLink(raw.github);
  if (raw.screenshotBatches !== undefined) validateScreenshotBatches(raw.screenshotBatches);
  normalizeAttachments(raw.attachments);
  if (Array.isArray(raw.discussions)) {
    for (const d of raw.discussions) validateDiscussionEntry(d);
  }
  if (Array.isArray(raw.agentRuns)) {
    for (const r of raw.agentRuns) validateAgentRunRecord(r);
  }
  for (const v of raw.verifications) validateVerificationRecord(v);
  for (const ev of raw.timeline as TimelineEvent[]) {
    if (!isRecord(ev) || typeof ev.id !== "string" || !isSafeInt(ev.at, 0) || typeof ev.summary !== "string") {
      throw new WorkbenchError("corrupt_record", "timeline 记录损坏");
    }
  }
  return raw as unknown as RequirementState;
}

export function validateMarkdownContent(
  content: string,
  kind: "spec" | "design" | "handoff" | "playbook",
  allowEmpty: boolean,
): string {
  const maxBytes =
    kind === "spec"
      ? MAX_SPEC_BYTES
      : kind === "design"
        ? MAX_DESIGN_BYTES
        : kind === "playbook"
          ? 16 * 1024
          : MAX_HANDOFF_BYTES;
  if (!isSafeText(content, maxBytes, allowEmpty)) {
    throw new WorkbenchError("invalid_input", `${kind}.md 内容无效或超出 ${maxBytes} 字节上限`);
  }
  return content;
}

/** Strips ANSI sequences, redacts common credentials, and truncates safely by UTF-8 byte limit. */
export function sanitizeOutput(raw: string, maxBytes: number): { text: string; truncated: boolean } {
  const cleaned = raw
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[PRIVATE KEY REDACTED]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
    .replace(/\b((?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*)[^\s,;'"`]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})/g, "[CREDENTIAL REDACTED]");

  const bytes = Buffer.from(cleaned, "utf8");
  if (bytes.length <= maxBytes) {
    return { text: cleaned, truncated: false };
  }
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) {
    end--;
  }
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}
