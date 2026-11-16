import { WorkbenchError } from "./errors.ts";
import {
  AGENT_ACTIONS,
  MAX_AGENT_RUNS,
  MAX_CRITERIA,
  MAX_DESIGN_BYTES,
  MAX_DISCUSSIONS,
  MAX_HANDOFF_BYTES,
  MAX_REASON_CHARS,
  MAX_SPEC_BYTES,
  MAX_TASKS,
  MAX_TIMELINE,
  MAX_TITLE_CHARS,
  REVIEW_VERDICTS,
  SCHEMA_VERSION,
  STAGES,
  TASK_STATUSES,
  TRACKS,
  type AcceptanceRecord,
  type AgentAction,
  type AgentRunRecord,
  type ApprovalRecord,
  type BaselineSnapshot,
  type Criterion,
  type CriterionInput,
  type DiscussionEntry,
  type HandoffNote,
  type ProjectMetadata,
  type RequirementState,
  type ReviewReport,
  type ReviewVerdict,
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

function assertAllowedKeys(obj: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new WorkbenchError("corrupt_record", `${label} 包含未知字段: ${key}`);
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

export function validateProjectMetadata(raw: unknown): ProjectMetadata {
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "project.json 必须是对象");
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw new WorkbenchError("unsupported_schema", `不支持的 project.json 版本: ${String(raw.schemaVersion)}`);
  }
  assertAllowedKeys(
    raw,
    ["schemaVersion", "projectId", "name", "nextNumber", "privacyMode", "createdAt", "updatedAt"],
    "project.json",
  );
  if (
    typeof raw.projectId !== "string" ||
    !TOKEN_ID_RE.test(raw.projectId) ||
    !isSafeText(raw.name, 200) ||
    !isSafeInt(raw.nextNumber, 1) ||
    (raw.privacyMode !== "local" && raw.privacyMode !== "tracked") ||
    !isSafeInt(raw.createdAt, 0) ||
    !isSafeInt(raw.updatedAt, 0)
  ) {
    throw new WorkbenchError("corrupt_record", "project.json 字段不合法");
  }
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

function validateAcceptance(raw: unknown): AcceptanceRecord | null {
  if (raw === null) return null;
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "acceptance 字段无效");
  assertAllowedKeys(raw, ["acceptedAt", "specHash", "codeSnapshotHash", "verificationIds", "note"], "acceptance");
  if (
    !isSafeInt(raw.acceptedAt, 0) ||
    typeof raw.specHash !== "string" ||
    !SHA256_RE.test(raw.specHash) ||
    typeof raw.codeSnapshotHash !== "string" ||
    !SHA256_RE.test(raw.codeSnapshotHash) ||
    !Array.isArray(raw.verificationIds) ||
    raw.verificationIds.some((id) => typeof id !== "string" || !TOKEN_ID_RE.test(id))
  ) {
    throw new WorkbenchError("corrupt_record", "acceptance 记录损坏");
  }
  return raw as unknown as AcceptanceRecord;
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
    typeof raw.reviewedSpecHash !== "string" ||
    !SHA256_RE.test(raw.reviewedSpecHash) ||
    typeof raw.reviewedCodeSnapshotHash !== "string" ||
    !SHA256_RE.test(raw.reviewedCodeSnapshotHash) ||
    !isSafeInt(raw.reviewedAt, 0)
  ) {
    throw new WorkbenchError("corrupt_record", "reviewReport 记录损坏");
  }
  return raw as unknown as ReviewReport;
}

export function validateRequirementState(raw: unknown, expectedId?: string): RequirementState {
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "state.json 必须是对象");
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw new WorkbenchError("unsupported_schema", `不支持的 state.json 版本: ${String(raw.schemaVersion)}`);
  }
  assertAllowedKeys(
    raw,
    [
      "schemaVersion",
      "id",
      "title",
      "stage",
      "track",
      "revision",
      "specHash",
      "designVersion",
      "designHash",
      "criteria",
      "approval",
      "acceptance",
      "tasks",
      "baseline",
      "verifications",
      "timeline",
      "lastFeedback",
      "blockedFrom",
      "blockedReason",
      "handoffNote",
      "discussions",
      "agentRuns",
      "reviewReport",
      "createdAt",
      "updatedAt",
    ],
    "state.json",
  );
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
  validateBaseline(raw.baseline);
  validateHandoffNote(raw.handoffNote);
  validateReviewReport(raw.reviewReport);
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

export function validateMarkdownContent(content: string, kind: "spec" | "design" | "handoff", allowEmpty: boolean): string {
  const maxBytes = kind === "spec" ? MAX_SPEC_BYTES : kind === "design" ? MAX_DESIGN_BYTES : MAX_HANDOFF_BYTES;
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
