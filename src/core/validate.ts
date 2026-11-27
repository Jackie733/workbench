import { normalizeAttachments } from "./attachments.ts";
import { WorkbenchError } from "./errors.ts";
import {
  ACCEPTANCE_SNAPSHOT_SCHEMA_VERSION,
  AGENT_ACTIONS,
  GIT_REMOTE_PROVIDERS,
  HARNESS_IDS,
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
  MAX_TIMELINE,
  MAX_TITLE_CHARS,
  OUTPUT_LANGUAGES,
  REASONING_EFFORTS,
  REQUIREMENT_KINDS,
  REQUIREMENT_TIERS,
  REVIEW_FINDING_SEVERITIES,
  REVIEW_VERDICTS,
  ROUTING_ROLES,
  SCHEMA_VERSION,
  STAGES,
  TRACKS,
  type AcceptanceGitEvidence,
  type AcceptanceRecord,
  type AcceptanceSnapshot,
  type AcceptanceSnapshotReference,
  type AcceptanceVerificationEvidence,
  type AdoptedDecision,
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
  type CriterionKind,
  type DecisionItem,
  type DecisionOption,
  type DeliveryRecord,
  type DesignReviewReport,
  type DiffEvidenceStatus,
  type DiffFilesScope,
  type DiscussionEntry,
  type EffectiveVerificationState,
  type GitRemoteProvider,
  type HarnessId,
  type ManualCriterionCheck,
  type ModelTarget,
  type NeedsHumanSource,
  type NeedsHumanState,
  type OutputLanguage,
  type ProjectGiteeConfig,
  type ProjectGitHubConfig,
  type ProjectMetadata,
  type ProjectVerificationConfig,
  type ProjectWorktreeConfig,
  type ReasoningEffort,
  type RequirementGitHubIssueLink,
  type RequirementGitHubLink,
  type RequirementGitHubPrLink,
  type RequirementKind,
  type RequirementState,
  type RequirementTier,
  type ReviewDisposition,
  type ReviewFinding,
  type ReviewFindingSeverity,
  type ReviewReport,
  type ReviewVerdict,
  type RoleRouteRule,
  type RoutingConfig,
  type RoutingRole,
  type RunBillingMode,
  type RunCostSource,
  type RunCostSummary,
  type RunDispatchReason,
  type RunHandoffMode,
  type RunTokenUsage,
  type ScreenshotBatch,
  type ScreenshotBatchStatus,
  type ScreenshotPhase,
  type ScreenshotShot,
  type ScreenshotSkipReasonCode,
  type ScreenshotSource,
  type ScreenshotTrigger,
  type Stage,
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
const SCREENSHOT_VIEWPORT_RE = /^\d{1,5}x\d{1,5}$/;
const GIT_REF_RE = /^[0-9a-f]{7,64}$/i;
const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const GITEE_ENTERPRISE_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const GITEE_ISSUE_IDENT_RE = /^[A-Za-z0-9]{4,16}$/;
const GIT_BRANCH_RE = /^(?![-.])(?!.*\.\.)(?!.*@\{)[A-Za-z0-9._/-]{1,128}(?<!\.lock)(?<![./])$/;
const DIFF_STATUSES: DiffEvidenceStatus[] = ["captured", "empty", "unavailable"];
const FILES_SCOPES: DiffFilesScope[] = ["baseline-relative", "worktree", "none"];
const EFFECTIVE_STATES: EffectiveVerificationState[] = ["passed", "failed", "stale", "unknown"];
const COVERAGE_STATES: CriterionCoverageState[] = ["passed", "failed", "stale", "unverified", "unavailable"];
const SCREENSHOT_TRIGGERS: ScreenshotTrigger[] = ["auto_submit", "manual", "agent_attach", "auto_collect"];
const SCREENSHOT_STATUSES: ScreenshotBatchStatus[] = ["captured", "partial", "skipped"];
const SCREENSHOT_SOURCES: ScreenshotSource[] = ["scenario", "matrix"];
const SCREENSHOT_PHASES: ScreenshotPhase[] = ["before", "after", "state"];
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
    throw new WorkbenchError("invalid_input", `无效的 GitHub 仓库标识（应为 owner/repo）: ${repo}`, {
      messageKey: "github.errInvalidRepo",
      messageParams: { repo },
    });
  }
  return trimmed;
}

export function validateGiteeRepoSlug(repo: string): string {
  const trimmed = repo.trim();
  if (!GITHUB_REPO_RE.test(trimmed)) {
    throw new WorkbenchError("invalid_input", `无效的 Gitee 仓库标识（应为 owner/repo）: ${repo}`, {
      messageKey: "gitee.errInvalidRepo",
      messageParams: { repo },
    });
  }
  return trimmed;
}

export function validateGiteeEnterpriseSlug(enterprise: string): string {
  const trimmed = enterprise.trim();
  if (!GITEE_ENTERPRISE_RE.test(trimmed)) {
    throw new WorkbenchError("invalid_input", `无效的 Gitee 企业空间标识: ${enterprise}`, {
      messageKey: "gitee.errInvalidEnterprise",
      messageParams: { enterprise },
    });
  }
  return trimmed;
}

export function validateGiteeIssueIdent(ident: string): string {
  const trimmed = ident.trim().replace(/^#/, "");
  if (!GITEE_ISSUE_IDENT_RE.test(trimmed)) {
    throw new WorkbenchError("invalid_input", `无效的 Gitee 工作项编号: ${ident}`, {
      messageKey: "gitee.errInvalidIssueIdent",
      messageParams: { ident },
    });
  }
  return trimmed.toUpperCase();
}

export function validateGitBranchName(branch: string): string {
  const trimmed = branch.trim();
  if (!GIT_BRANCH_RE.test(trimmed) || trimmed.includes("//") || trimmed === "HEAD") {
    throw new WorkbenchError("invalid_input", `非法的 Git 分支名: ${branch}`, {
      messageKey: "git.errInvalidBranch",
      messageParams: { branch },
    });
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

/**
 * Validates object keys on persisted records while allowing forward-compatible
 * optional extension fields (never allowing prototype-pollution keys).
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
    const raw = inputs[i] as unknown as Record<string, unknown>;
    if (!isRecord(raw) || !isSafeText(raw.description, 1000)) {
      throw new WorkbenchError("invalid_input", `第 ${i + 1} 条验收条件描述无效`);
    }
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `AC-${i + 1}`;
    if (!TOKEN_ID_RE.test(id)) {
      throw new WorkbenchError("invalid_input", `验收条件 ID 格式无效: ${id}`);
    }
    if (usedIds.has(id)) {
      throw new WorkbenchError("invalid_input", `验收条件 ID 重复: ${id}`);
    }
    usedIds.add(id);
    const rawKind =
      raw.kind === "manual" || raw.type === "manual" || raw.manual === true
        ? "manual"
        : raw.kind === "command" || raw.type === "command"
          ? "command"
          : undefined;
    const item: Criterion = {
      id,
      description: raw.description.trim(),
      required: raw.required === undefined ? true : Boolean(raw.required),
      ...(rawKind ? { kind: rawKind as CriterionKind } : {}),
    };
    if (rawKind !== "manual" && typeof raw.command === "string" && raw.command.trim().length > 0) {
      if (!isSafeText(raw.command, 512)) {
        throw new WorkbenchError("invalid_input", `验收条件 ${id} 的验证命令无效或过长`);
      }
      item.command = raw.command.trim();
    }
    if (typeof raw.steps === "string" && raw.steps.trim().length > 0) {
      if (!isSafeText(raw.steps, 1000)) {
        throw new WorkbenchError("invalid_input", `验收条件 ${id} 的人工检查步骤无效或过长`);
      }
      item.steps = raw.steps.trim();
      if (!item.kind && !item.command) {
        item.kind = "manual";
      }
    }
    if (raw.systemInjected === true) {
      item.systemInjected = true;
    }
    result.push(item);
  }
  return result;
}

const MAX_DECISION_ITEMS = 12;

export function normalizeDecisionItems(inputs: unknown): DecisionItem[] {
  if (!Array.isArray(inputs) || inputs.length > MAX_DECISION_ITEMS) {
    throw new WorkbenchError("invalid_input", `待拍板决策数量不能超过 ${MAX_DECISION_ITEMS} 项`);
  }
  const usedIds = new Set<string>();
  const result: DecisionItem[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const raw = inputs[i];
    if (!isRecord(raw) || !isSafeText(raw.question, 600)) {
      throw new WorkbenchError("invalid_input", `第 ${i + 1} 项决策问题无效`);
    }
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `D-${i + 1}`;
    if (!TOKEN_ID_RE.test(id)) {
      throw new WorkbenchError("invalid_input", `决策 ID 格式无效: ${id}`);
    }
    if (usedIds.has(id)) {
      throw new WorkbenchError("invalid_input", `决策 ID 重复: ${id}`);
    }
    usedIds.add(id);

    if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > 4) {
      throw new WorkbenchError("invalid_input", `决策 ${id} 必须提供 2 到 4 个选项`);
    }
    const usedOptIds = new Set<string>();
    const options: DecisionOption[] = [];
    for (let j = 0; j < raw.options.length; j++) {
      const opt = raw.options[j];
      if (!isRecord(opt) || !isSafeText(opt.label, 300)) {
        throw new WorkbenchError("invalid_input", `决策 ${id} 第 ${j + 1} 个选项标题无效`);
      }
      const optId = typeof opt.id === "string" && opt.id.trim() ? opt.id.trim() : `opt-${j + 1}`;
      if (!TOKEN_ID_RE.test(optId) || usedOptIds.has(optId)) {
        throw new WorkbenchError("invalid_input", `决策 ${id} 选项 ID 无效或重复: ${optId}`);
      }
      usedOptIds.add(optId);
      const option: DecisionOption = {
        id: optId,
        label: opt.label.trim(),
        ...(typeof opt.description === "string" && opt.description.trim()
          ? { description: sanitizeOutput(opt.description.trim(), 500).text.trim() }
          : {}),
        ...(opt.recommended === true ? { recommended: true } : {}),
      };
      options.push(option);
    }

    const selectedOptionId =
      typeof raw.selectedOptionId === "string" && raw.selectedOptionId.trim() && usedOptIds.has(raw.selectedOptionId.trim())
        ? raw.selectedOptionId.trim()
        : null;
    const customAnswer =
      typeof raw.customAnswer === "string" && raw.customAnswer.trim()
        ? sanitizeOutput(raw.customAnswer.trim(), 1000).text.trim()
        : null;
    result.push({
      id,
      question: raw.question.trim(),
      ...(typeof raw.context === "string" && raw.context.trim()
        ? { context: sanitizeOutput(raw.context.trim(), 600).text.trim() }
        : {}),
      options,
      ...(selectedOptionId ? { selectedOptionId } : {}),
      ...(customAnswer ? { customAnswer } : {}),
      ...(isSafeInt(raw.decidedAt, 0) ? { decidedAt: raw.decidedAt } : {}),
    });
  }
  return result;
}

function validateProjectGitHubConfig(raw: unknown): ProjectGitHubConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "project.json github 配置必须是对象");
  assertSafeExtensionKeys(raw, "project.github");
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

function validateProjectGiteeConfig(raw: unknown): ProjectGiteeConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "project.json gitee 配置必须是对象");
  assertSafeExtensionKeys(raw, "project.gitee");
  if (raw.repo !== undefined && (typeof raw.repo !== "string" || !GITHUB_REPO_RE.test(raw.repo.trim()))) {
    throw new WorkbenchError("corrupt_record", "project.gitee.repo 格式不合法");
  }
  if (raw.enterprise !== undefined && (typeof raw.enterprise !== "string" || !GITEE_ENTERPRISE_RE.test(raw.enterprise.trim()))) {
    throw new WorkbenchError("corrupt_record", "project.gitee.enterprise 格式不合法");
  }
  if (
    raw.defaultBaseBranch !== undefined &&
    (typeof raw.defaultBaseBranch !== "string" || !GIT_BRANCH_RE.test(raw.defaultBaseBranch.trim()) || raw.defaultBaseBranch.includes("//"))
  ) {
    throw new WorkbenchError("corrupt_record", "project.gitee.defaultBaseBranch 格式不合法");
  }
  return raw as unknown as ProjectGiteeConfig;
}

function validateProjectVerificationConfig(raw: unknown): ProjectVerificationConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "project.json verification 配置必须是对象");
  assertSafeExtensionKeys(raw, "project.verification");
  if (raw.fastCommand !== undefined && !isSafeText(raw.fastCommand, 512, true)) {
    throw new WorkbenchError("corrupt_record", "project.verification.fastCommand 格式不合法");
  }
  if (raw.fullCommand !== undefined && !isSafeText(raw.fullCommand, 512, true)) {
    throw new WorkbenchError("corrupt_record", "project.verification.fullCommand 格式不合法");
  }
  if (raw.autoScreenshots !== undefined && typeof raw.autoScreenshots !== "boolean") {
    throw new WorkbenchError("corrupt_record", "project.verification.autoScreenshots 必须是布尔值");
  }
  return raw as unknown as ProjectVerificationConfig;
}

function validateProjectWorktreeConfig(raw: unknown): ProjectWorktreeConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "project.json worktree 配置必须是对象");
  assertSafeExtensionKeys(raw, "project.worktree");
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    throw new WorkbenchError("corrupt_record", "project.worktree.enabled 必须是布尔值");
  }
  if (raw.copyFiles !== undefined) {
    if (
      !Array.isArray(raw.copyFiles) ||
      raw.copyFiles.length > 64 ||
      raw.copyFiles.some((f) => !isSafeText(f, 256))
    ) {
      throw new WorkbenchError("corrupt_record", "project.worktree.copyFiles 格式不合法");
    }
  }
  if (raw.setupScript !== undefined && !isSafeText(raw.setupScript, 2048, true)) {
    throw new WorkbenchError("corrupt_record", "project.worktree.setupScript 格式不合法");
  }
  return raw as unknown as ProjectWorktreeConfig;
}

function validateModelTarget(raw: unknown, label: string): ModelTarget {
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", `${label} 必须是对象`);
  assertSafeExtensionKeys(raw, label);
  const rawHarness = typeof raw.harness === "string" ? raw.harness.trim() : "";
  const rawModel = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!(HARNESS_IDS as readonly string[]).includes(rawHarness)) {
    throw new WorkbenchError("corrupt_record", `${label}.harness 格式不合法: ${String(raw.harness)}`);
  }
  if (!isSafeText(rawModel, 200)) {
    throw new WorkbenchError("corrupt_record", `${label}.model 格式不合法`);
  }
  if (
    raw.reasoningEffort !== undefined &&
    (typeof raw.reasoningEffort !== "string" || !(REASONING_EFFORTS as readonly string[]).includes(raw.reasoningEffort))
  ) {
    throw new WorkbenchError("corrupt_record", `${label}.reasoningEffort 格式不合法`);
  }
  return {
    harness: rawHarness as HarnessId,
    model: rawModel,
    ...(raw.reasoningEffort !== undefined ? { reasoningEffort: raw.reasoningEffort as ReasoningEffort } : {}),
  };
}

export function validateProjectRoutingConfig(raw: unknown): RoutingConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "project.json routing 配置必须是对象");
  assertSafeExtensionKeys(raw, "project.routing");
  const rules = {} as Record<RoutingRole, RoleRouteRule>;
  for (const role of ROUTING_ROLES) {
    const rule = raw[role];
    if (!isRecord(rule)) {
      throw new WorkbenchError("corrupt_record", `project.routing.${role} 必须是对象`);
    }
    assertSafeExtensionKeys(rule, `project.routing.${role}`);
    const primary = validateModelTarget(rule.primary, `project.routing.${role}.primary`);
    if (!Array.isArray(rule.fallbacks) || rule.fallbacks.length > 6) {
      throw new WorkbenchError("corrupt_record", `project.routing.${role}.fallbacks 格式不合法`);
    }
    const fallbacks = rule.fallbacks.map((item, idx) =>
      validateModelTarget(item, `project.routing.${role}.fallbacks[${idx}]`),
    );
    rules[role] = { primary, fallbacks };
  }
  if (raw.autoReview !== undefined && typeof raw.autoReview !== "boolean") {
    throw new WorkbenchError("corrupt_record", "project.routing.autoReview 必须是布尔值");
  }
  if (raw.autoHeal !== undefined && typeof raw.autoHeal !== "boolean") {
    throw new WorkbenchError("corrupt_record", "project.routing.autoHeal 必须是布尔值");
  }
  return {
    defaultLead: rules.defaultLead,
    sotaLead: rules.sotaLead,
    reviewer: rules.reviewer,
    ...(raw.autoReview !== undefined ? { autoReview: raw.autoReview } : {}),
    ...(raw.autoHeal !== undefined ? { autoHeal: raw.autoHeal } : {}),
  };
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
  const routing = validateProjectRoutingConfig(raw.routing);
  validateProjectGitHubConfig(raw.github);
  validateProjectGiteeConfig(raw.gitee);
  validateProjectVerificationConfig(raw.verification);
  validateProjectWorktreeConfig(raw.worktree);
  const meta = raw as unknown as ProjectMetadata;
  return routing ? { ...meta, routing } : meta;
}

function validateApproval(raw: unknown): ApprovalRecord | null {
  if (raw === null) return null;
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "approval 字段无效");
  assertSafeExtensionKeys(raw, "approval");
  if (
    !isSafeInt(raw.approvedAt, 0) ||
    !TRACKS.includes(raw.track as Track) ||
    typeof raw.specHash !== "string" ||
    !SHA256_RE.test(raw.specHash) ||
    !isSafeInt(raw.designVersion, 0) ||
    typeof raw.designHash !== "string" ||
    (raw.designHash !== "" && !SHA256_RE.test(raw.designHash)) ||
    (raw.decisionsHash !== undefined &&
      (typeof raw.decisionsHash !== "string" || (raw.decisionsHash !== "" && !SHA256_RE.test(raw.decisionsHash)))) ||
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
  assertSafeExtensionKeys(raw, "acceptance.snapshot");
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
  assertSafeExtensionKeys(raw, "acceptance.reviewDisposition");
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
  assertSafeExtensionKeys(raw, "acceptance");
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
  assertSafeExtensionKeys(raw, "delivery");
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
  assertSafeExtensionKeys(raw, "baseline");
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
  assertSafeExtensionKeys(raw, "verification");
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
  if (raw.kind !== undefined && raw.kind !== "command" && raw.kind !== "manual") {
    throw new WorkbenchError("corrupt_record", `${label} 中的验收条件类型损坏`);
  }
  const command = raw.command;
  if (command !== undefined && (typeof command !== "string" || !isSafeText(command, 512))) {
    throw new WorkbenchError("corrupt_record", `${label} 中的验收条件命令损坏`);
  }
  const steps = raw.steps;
  if (steps !== undefined && (typeof steps !== "string" || !isSafeText(steps, 1000, true))) {
    throw new WorkbenchError("corrupt_record", `${label} 中的验收条件人工检查步骤损坏`);
  }
  if (raw.systemInjected !== undefined && typeof raw.systemInjected !== "boolean") {
    throw new WorkbenchError("corrupt_record", `${label} 中的验收条件标记损坏`);
  }
  return raw as unknown as Criterion;
}

const NEEDS_HUMAN_SOURCES: readonly NeedsHumanSource[] = [
  "auto_heal_exhausted",
  "review_loop_exhausted",
  "agent_paused",
  "bug_pause",
  "env_failure",
];

function validateManualChecks(raw: unknown): ManualCriterionCheck[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_CRITERIA) {
    throw new WorkbenchError("corrupt_record", "manualChecks 记录损坏");
  }
  for (const item of raw) {
    if (
      !isRecord(item) ||
      typeof item.criterionId !== "string" ||
      !TOKEN_ID_RE.test(item.criterionId) ||
      typeof item.checked !== "boolean" ||
      !isSafeInt(item.checkedAt, 0) ||
      typeof item.specHash !== "string" ||
      !SHA256_RE.test(item.specHash) ||
      typeof item.codeSnapshotHash !== "string" ||
      !SHA256_RE.test(item.codeSnapshotHash) ||
      (item.note !== undefined && !isSafeText(item.note, 1000, true))
    ) {
      throw new WorkbenchError("corrupt_record", "manualChecks 条目损坏");
    }
    assertSafeExtensionKeys(item, "manualChecks");
  }
  return raw as unknown as ManualCriterionCheck[];
}

function validatePendingDecisions(raw: unknown): DecisionItem[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_DECISION_ITEMS) {
    throw new WorkbenchError("corrupt_record", "pendingDecisions 记录损坏");
  }
  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== "string" || !TOKEN_ID_RE.test(item.id) || !isSafeText(item.question, 600)) {
      throw new WorkbenchError("corrupt_record", "pendingDecisions 条目损坏");
    }
    assertSafeExtensionKeys(item, "pendingDecisions");
    if (
      (item.context !== undefined && !isSafeText(item.context, 800, true)) ||
      !Array.isArray(item.options) ||
      item.options.length < 2 ||
      item.options.length > 4 ||
      (item.selectedOptionId !== undefined && item.selectedOptionId !== null && (typeof item.selectedOptionId !== "string" || !TOKEN_ID_RE.test(item.selectedOptionId))) ||
      (item.customAnswer !== undefined && item.customAnswer !== null && !isSafeText(item.customAnswer, 1200, true)) ||
      (item.decidedAt !== undefined && item.decidedAt !== null && !isSafeInt(item.decidedAt, 0))
    ) {
      throw new WorkbenchError("corrupt_record", "pendingDecisions 字段损坏");
    }
    for (const opt of item.options) {
      if (
        !isRecord(opt) ||
        typeof opt.id !== "string" ||
        !TOKEN_ID_RE.test(opt.id) ||
        !isSafeText(opt.label, 300) ||
        (opt.description !== undefined && !isSafeText(opt.description, 600, true)) ||
        (opt.recommended !== undefined && typeof opt.recommended !== "boolean")
      ) {
        throw new WorkbenchError("corrupt_record", "pendingDecisions.options 条目损坏");
      }
      assertSafeExtensionKeys(opt, "pendingDecisions.options");
    }
  }
  return raw as unknown as DecisionItem[];
}

function validateAdoptedDecisions(raw: unknown): AdoptedDecision[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > 64) {
    throw new WorkbenchError("corrupt_record", "humanDecisions 记录损坏");
  }
  for (const item of raw) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      !TOKEN_ID_RE.test(item.id) ||
      !isSafeText(item.question, 600) ||
      !isSafeText(item.answer, 1200) ||
      (item.optionId !== undefined && (typeof item.optionId !== "string" || !TOKEN_ID_RE.test(item.optionId))) ||
      (item.optionLabel !== undefined && !isSafeText(item.optionLabel, 300, true)) ||
      !isSafeInt(item.adoptedAt, 0)
    ) {
      throw new WorkbenchError("corrupt_record", "humanDecisions 条目损坏");
    }
    assertSafeExtensionKeys(item, "humanDecisions");
  }
  return raw as unknown as AdoptedDecision[];
}

function validateNeedsHuman(raw: unknown): NeedsHumanState | null | undefined {
  if (raw === undefined || raw === null) return raw === null ? null : undefined;
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "needsHuman 字段无效");
  assertSafeExtensionKeys(raw, "needsHuman");
  if (
    !isSafeText(raw.reason, 1200) ||
    (raw.reasonKey !== undefined && !isSafeText(raw.reasonKey, 128)) ||
    !NEEDS_HUMAN_SOURCES.includes(raw.source as NeedsHumanSource) ||
    !isSafeInt(raw.at, 0)
  ) {
    throw new WorkbenchError("corrupt_record", "needsHuman 记录损坏");
  }
  return raw as unknown as NeedsHumanState;
}

function validateChangedFileEntry(raw: unknown, label: string): ChangedFile {
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", `${label} 的文件记录无效`);
  assertSafeExtensionKeys(raw, `${label}.files`);
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
  assertSafeExtensionKeys(raw, `${label}.commits`);
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
  assertSafeExtensionKeys(raw, "acceptance.git");
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
  assertSafeExtensionKeys(raw, "acceptance.verification");
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
  assertSafeExtensionKeys(raw, "screenshot");
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
  if (raw.description !== undefined) {
    if (
      typeof raw.description !== "string" ||
      !isSafeText(raw.description, 2000, true) ||
      Array.from(raw.description).length > 500
    ) {
      throw new WorkbenchError("corrupt_record", "截图场景说明无效或超过 500 字符");
    }
  }
  if (raw.phase !== undefined && !SCREENSHOT_PHASES.includes(raw.phase as ScreenshotPhase)) {
    throw new WorkbenchError("corrupt_record", "截图阶段标记无效");
  }
  if (raw.criterionIds !== undefined) {
    if (
      !Array.isArray(raw.criterionIds) ||
      raw.criterionIds.length > MAX_CRITERIA ||
      raw.criterionIds.some((item) => typeof item !== "string" || !TOKEN_ID_RE.test(item))
    ) {
      throw new WorkbenchError("corrupt_record", "截图关联验收条件无效");
    }
  }
  return raw as unknown as ScreenshotShot;
}

export function validateScreenshotBatch(raw: unknown): ScreenshotBatch {
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "截图批次必须是对象");
  assertSafeExtensionKeys(raw, "screenshotBatch");
  if (
    raw.reasonCode !== undefined &&
    raw.reasonCode !== null &&
    !SCREENSHOT_SKIP_REASON_CODES.includes(raw.reasonCode as ScreenshotSkipReasonCode)
  ) {
    throw new WorkbenchError("corrupt_record", "截图跳过原因码无效");
  }
  if (raw.source !== undefined && !SCREENSHOT_SOURCES.includes(raw.source as ScreenshotSource)) {
    throw new WorkbenchError("corrupt_record", "截图批次来源无效");
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
    assertSafeExtensionKeys(item, "验收快照.coverage");
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

const DISCUSSION_KINDS = ["chat", "annotation", "refine_summary"] as const;
const RUN_HANDOFF_MODES: readonly RunHandoffMode[] = ["first_run", "native_resume", "fresh_handoff"];

function validateDiscussionEntry(raw: unknown): DiscussionEntry {
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "discussion 字段无效");
  assertSafeExtensionKeys(raw, "discussion");
  if (
    typeof raw.id !== "string" ||
    !TOKEN_ID_RE.test(raw.id) ||
    !isSafeInt(raw.at, 0) ||
    (raw.actor !== "human" && raw.actor !== "agent") ||
    (raw.mode !== "ask" && raw.mode !== "refine") ||
    !isSafeText(raw.message, 32 * 1024) ||
    (raw.kind !== undefined &&
      (typeof raw.kind !== "string" || !(DISCUSSION_KINDS as readonly string[]).includes(raw.kind))) ||
    (raw.resolved !== undefined && typeof raw.resolved !== "boolean") ||
    (raw.adopted !== undefined && typeof raw.adopted !== "boolean") ||
    (raw.runId !== undefined && (typeof raw.runId !== "string" || raw.runId.length > 80)) ||
    (raw.durationMs !== undefined && !isFiniteNonNeg(raw.durationMs)) ||
    (raw.toolCallsCount !== undefined && !isSafeInt(raw.toolCallsCount, 0)) ||
    (raw.handoffMode !== undefined &&
      (typeof raw.handoffMode !== "string" || !RUN_HANDOFF_MODES.includes(raw.handoffMode as RunHandoffMode)))
  ) {
    throw new WorkbenchError("corrupt_record", "discussion 记录损坏");
  }
  return raw as unknown as DiscussionEntry;
}

const RUN_BILLING_MODES: readonly RunBillingMode[] = ["subscription", "api", "free"];
const RUN_COST_SOURCES: readonly RunCostSource[] = ["reported", "estimated", "free", "unknown"];
const RUN_DISPATCH_REASONS: readonly RunDispatchReason[] = [
  "user",
  "route_primary",
  "session_affinity",
  "manual_fallback",
  "auto_fallback",
  "auto_heal",
  "auto_review",
  "auto_review_fix",
  "auto_re_review",
  "auto_design_review",
  "design_review",
  "sota_escalate",
  "conflict_resolve",
  "refine",
  "ask",
];

function isFiniteNonNeg(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function validateRunTokenUsage(raw: unknown): RunTokenUsage {
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "agentRun.usage 必须是对象");
  assertSafeExtensionKeys(raw, "agentRun.usage");
  if (
    !isSafeInt(raw.inputTokens, 0) ||
    !isSafeInt(raw.uncachedInputTokens, 0) ||
    !isSafeInt(raw.cacheReadTokens, 0) ||
    !isSafeInt(raw.cacheWriteTokens, 0) ||
    !isSafeInt(raw.outputTokens, 0) ||
    !isSafeInt(raw.reasoningTokens, 0) ||
    !isSafeInt(raw.totalTokens, 0)
  ) {
    throw new WorkbenchError("corrupt_record", "agentRun.usage 数值损坏");
  }
  return raw as unknown as RunTokenUsage;
}

function validateRunCostSummary(raw: unknown): RunCostSummary {
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "agentRun.cost 必须是对象");
  assertSafeExtensionKeys(raw, "agentRun.cost");
  if (
    !isFiniteNonNeg(raw.apiCostUsd) ||
    !isFiniteNonNeg(raw.equivalentCostUsd) ||
    !RUN_BILLING_MODES.includes(raw.billingMode as RunBillingMode) ||
    !RUN_COST_SOURCES.includes(raw.costSource as RunCostSource) ||
    !isSafeText(raw.quotaPool, 128) ||
    raw.currency !== "USD"
  ) {
    throw new WorkbenchError("corrupt_record", "agentRun.cost 数值或枚举损坏");
  }
  return raw as unknown as RunCostSummary;
}

export function validateAgentRunRecord(raw: unknown): AgentRunRecord {
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "agentRun 记录必须是对象");
  assertSafeExtensionKeys(raw, "agentRun");
  if (
    typeof raw.id !== "string" ||
    !TOKEN_ID_RE.test(raw.id) ||
    !AGENT_ACTIONS.includes(raw.action as AgentAction) ||
    !isSafeText(raw.harness, 64) ||
    !isSafeText(raw.model, 200) ||
    (raw.effectiveModel !== undefined && !isSafeText(raw.effectiveModel, 200)) ||
    (raw.modelFallback !== undefined && typeof raw.modelFallback !== "boolean") ||
    (raw.hubPid !== undefined && !isSafeInt(raw.hubPid, 1)) ||
    !["running", "succeeded", "failed", "cancelled"].includes(String(raw.status)) ||
    !isSafeInt(raw.startedAt, 0) ||
    (raw.endedAt !== null && !isSafeInt(raw.endedAt, 0)) ||
    (raw.exitCode !== null && !Number.isSafeInteger(raw.exitCode)) ||
    !isSafeInt(raw.durationMs, 0) ||
    typeof raw.logPath !== "string" ||
    (raw.quotaPool !== undefined && !isSafeText(raw.quotaPool, 128)) ||
    (raw.billingMode !== undefined && !RUN_BILLING_MODES.includes(raw.billingMode as RunBillingMode)) ||
    (raw.dispatchReason !== undefined && !RUN_DISPATCH_REASONS.includes(raw.dispatchReason as RunDispatchReason)) ||
    (raw.handoffMode !== undefined && !RUN_HANDOFF_MODES.includes(raw.handoffMode as RunHandoffMode)) ||
    (raw.parentRunId !== undefined && (typeof raw.parentRunId !== "string" || !TOKEN_ID_RE.test(raw.parentRunId))) ||
    (raw.turnsCount !== undefined && !isSafeInt(raw.turnsCount, 0)) ||
    (raw.toolCallsCount !== undefined && !isSafeInt(raw.toolCallsCount, 0)) ||
    (raw.toolErrorCount !== undefined && !isSafeInt(raw.toolErrorCount, 0)) ||
    (raw.compactionCount !== undefined && !isSafeInt(raw.compactionCount, 0)) ||
    (raw.peakContextTokens !== undefined && !isSafeInt(raw.peakContextTokens, 0)) ||
    (raw.contextWindow !== undefined && !isSafeInt(raw.contextWindow, 0)) ||
    (raw.llmDurationMs !== undefined && !isSafeInt(raw.llmDurationMs, 0)) ||
    (raw.toolDurationMs !== undefined && !isSafeInt(raw.toolDurationMs, 0)) ||
    (raw.ttftMs !== undefined && !isSafeInt(raw.ttftMs, 0)) ||
    (raw.specChanged !== undefined && typeof raw.specChanged !== "boolean") ||
    (raw.specHashAfter !== undefined && !isSafeText(raw.specHashAfter, 128)) ||
    (raw.codeChanged !== undefined && typeof raw.codeChanged !== "boolean") ||
    (raw.noCodeChange !== undefined && typeof raw.noCodeChange !== "boolean") ||
    (raw.wipCommitHash !== undefined && (typeof raw.wipCommitHash !== "string" || !GIT_REF_RE.test(raw.wipCommitHash))) ||
    (raw.tracePath !== undefined && !isSafeText(raw.tracePath, 260, true)) ||
    (raw.contextPath !== undefined && !isSafeText(raw.contextPath, 260, true)) ||
    (raw.traceTruncated !== undefined && typeof raw.traceTruncated !== "boolean") ||
    (raw.healthWarnings !== undefined &&
      (!Array.isArray(raw.healthWarnings) ||
        raw.healthWarnings.length > 20 ||
        raw.healthWarnings.some((w) => !isSafeText(w, 300))))
  ) {
    throw new WorkbenchError("corrupt_record", "agentRun 记录损坏");
  }
  if (raw.usage !== undefined) validateRunTokenUsage(raw.usage);
  if (raw.cost !== undefined) validateRunCostSummary(raw.cost);
  return raw as unknown as AgentRunRecord;
}

function validateReviewFinding(raw: unknown): ReviewFinding {
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "reviewReport.findings 项无效");
  assertSafeExtensionKeys(raw, "reviewReport.finding");
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
  assertSafeExtensionKeys(raw, "reviewReport");
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
    (raw.reviewedCommit !== undefined && (typeof raw.reviewedCommit !== "string" || !GIT_REF_RE.test(raw.reviewedCommit))) ||
    (raw.reviewerSessionId !== undefined && !isSafeText(raw.reviewerSessionId, 256)) ||
    !isSafeInt(raw.reviewedAt, 0)
  ) {
    throw new WorkbenchError("corrupt_record", "reviewReport 记录损坏");
  }
  if (Array.isArray(raw.findings)) {
    for (const f of raw.findings) validateReviewFinding(f);
  }
  return raw as unknown as ReviewReport;
}

function validateDesignReviewReport(raw: unknown): DesignReviewReport | null {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "designReviewReport 字段无效");
  assertSafeExtensionKeys(raw, "designReviewReport");
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
    typeof raw.reviewedDesignHash !== "string" ||
    !SHA256_RE.test(raw.reviewedDesignHash) ||
    !isSafeInt(raw.reviewedAt, 0)
  ) {
    throw new WorkbenchError("corrupt_record", "designReviewReport 记录损坏");
  }
  if (Array.isArray(raw.findings)) {
    for (const f of raw.findings) validateReviewFinding(f);
  }
  return raw as unknown as DesignReviewReport;
}

function validateRequirementGitHubIssue(raw: unknown): RequirementGitHubIssueLink | null | undefined {
  if (raw === undefined || raw === null) return raw === null ? null : undefined;
  if (!isRecord(raw)) throw new WorkbenchError("corrupt_record", "github.issue 字段无效");
  assertSafeExtensionKeys(raw, "github.issue");
  const validNumber =
    isSafeInt(raw.number, 1) || (typeof raw.number === "string" && GITEE_ISSUE_IDENT_RE.test(raw.number));
  if (
    !validNumber ||
    !isSafeHttpsUrl(raw.url) ||
    !isSafeText(raw.title, 400) ||
    (raw.state !== "open" && raw.state !== "progressing" && raw.state !== "closed" && raw.state !== "rejected") ||
    (raw.issueType !== undefined && !isSafeText(raw.issueType, 100, true)) ||
    (raw.programName !== undefined && !isSafeText(raw.programName, 200, true)) ||
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
  assertSafeExtensionKeys(raw, "github.pr");
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
  assertSafeExtensionKeys(raw, "state.github");
  if (raw.provider !== undefined && !GIT_REMOTE_PROVIDERS.includes(raw.provider as GitRemoteProvider)) {
    throw new WorkbenchError("corrupt_record", "state.github.provider 格式损坏");
  }
  if (raw.enterprise !== undefined && (typeof raw.enterprise !== "string" || !GITEE_ENTERPRISE_RE.test(raw.enterprise))) {
    throw new WorkbenchError("corrupt_record", "state.github.enterprise 格式损坏");
  }
  const allowEmptyRepo = raw.provider === "gitee" && typeof raw.enterprise === "string" && raw.enterprise.length > 0;
  if (typeof raw.repo !== "string" || (raw.repo === "" ? !allowEmptyRepo : !GITHUB_REPO_RE.test(raw.repo))) {
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
    (raw.parentId !== undefined && (typeof raw.parentId !== "string" || !REQUIREMENT_ID_RE.test(raw.parentId) || raw.parentId === raw.id)) ||
    !isSafeText(raw.title, 400) ||
    (raw.originalGoal !== undefined && !isSafeText(raw.originalGoal, MAX_SPEC_BYTES, true)) ||
    !STAGES.includes(raw.stage as Stage) ||
    !TRACKS.includes(raw.track as Track) ||
    (raw.kind !== undefined && !REQUIREMENT_KINDS.includes(raw.kind as RequirementKind)) ||
    !REQUIREMENT_TIERS.includes(raw.tier as RequirementTier) ||
    !isSafeInt(raw.revision, 1) ||
    typeof raw.specHash !== "string" ||
    !SHA256_RE.test(raw.specHash) ||
    !isSafeInt(raw.designVersion, 0) ||
    typeof raw.designHash !== "string" ||
    (raw.designHash !== "" && !SHA256_RE.test(raw.designHash)) ||
    !Array.isArray(raw.criteria) ||
    !Array.isArray(raw.verifications) ||
    !Array.isArray(raw.timeline) ||
    raw.timeline.length > MAX_TIMELINE ||
    (raw.discussions !== undefined && (!Array.isArray(raw.discussions) || raw.discussions.length > MAX_DISCUSSIONS)) ||
    (raw.agentRuns !== undefined && (!Array.isArray(raw.agentRuns) || raw.agentRuns.length > MAX_AGENT_RUNS)) ||
    (raw.lastFeedback !== null && !isSafeText(raw.lastFeedback, 8000, true)) ||
    (raw.cancelReason !== undefined && raw.cancelReason !== null && !isSafeText(raw.cancelReason, 8000, true)) ||
    (raw.uiRelated !== undefined && typeof raw.uiRelated !== "boolean") ||
    (raw.revisedFromCoding !== undefined && typeof raw.revisedFromCoding !== "boolean") ||
    !isSafeInt(raw.createdAt, 0) ||
    !isSafeInt(raw.updatedAt, 0)
  ) {
    throw new WorkbenchError("corrupt_record", "state.json 字段校验失败");
  }
  for (const c of raw.criteria) {
    validateCriterionEntry(c, "state.json");
  }
  validateManualChecks(raw.manualChecks);
  validatePendingDecisions(raw.pendingDecisions);
  validateAdoptedDecisions(raw.humanDecisions);
  validateNeedsHuman(raw.needsHuman);
  validateApproval(raw.approval);
  validateAcceptance(raw.acceptance);
  validateDelivery(raw.delivery);
  validateBaseline(raw.baseline);
  validateReviewReport(raw.reviewReport);
  validateDesignReviewReport(raw.designReviewReport);
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
    if (
      !isRecord(ev) ||
      typeof ev.id !== "string" ||
      !isSafeInt(ev.at, 0) ||
      typeof ev.summary !== "string" ||
      (ev.runId !== undefined && (typeof ev.runId !== "string" || !TOKEN_ID_RE.test(ev.runId)))
    ) {
      throw new WorkbenchError("corrupt_record", "timeline 记录损坏");
    }
  }
  return raw as unknown as RequirementState;
}

export function validateMarkdownContent(
  content: string,
  kind: "spec" | "design" | "handoff",
  allowEmpty: boolean,
): string {
  const maxBytes =
    kind === "spec"
      ? MAX_SPEC_BYTES
      : kind === "design"
        ? MAX_DESIGN_BYTES
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
    .replace(/\b((?:api[_-]?key|access[_-]?token|token|password|secret|authorization)\s*[:=]\s*)[^\s,;'"`&]+/gi, "$1[REDACTED]")
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

function sliceUtf8Head(buf: Buffer, maxBytes: number): string {
  if (buf.length <= maxBytes) return buf.toString("utf8");
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end--;
  }
  return buf.subarray(0, end).toString("utf8");
}

function sliceUtf8Tail(buf: Buffer, maxBytes: number): string {
  if (buf.length <= maxBytes) return buf.toString("utf8");
  let start = Math.max(0, buf.length - maxBytes);
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) {
    start++;
  }
  return buf.subarray(start).toString("utf8");
}

/**
 * Redacts ANSI/credentials and clips oversized text using head + tail preservation
 * so both error headers and trailing summaries survive truncation.
 */
export function clipHeadTailUtf8(
  raw: string,
  headBytes: number,
  tailBytes: number,
): { text: string; bytes: number; truncated: boolean } {
  const cleaned = sanitizeOutput(raw, Number.MAX_SAFE_INTEGER).text;
  const buf = Buffer.from(cleaned, "utf8");
  const totalBytes = buf.length;
  const maxBytes = headBytes + tailBytes;
  if (totalBytes <= maxBytes) {
    return { text: cleaned, bytes: totalBytes, truncated: false };
  }
  const omitted = Math.max(0, totalBytes - maxBytes);
  const head = sliceUtf8Head(buf, headBytes).trimEnd();
  const tail = sliceUtf8Tail(buf, tailBytes).trimStart();
  const sep = `\n\n… [已截断中间 ${omitted} 字节，保留头 ${headBytes}B + 尾 ${tailBytes}B] …\n\n`;
  return {
    text: `${head}${sep}${tail}`,
    bytes: totalBytes,
    truncated: true,
  };
}
