export const SCHEMA_VERSION = 4 as const;
export const WORKBENCH_DIR = ".workbench" as const;

/** Schema of the immutable acceptance artifact written at human acceptance (REQ-003). */
export const ACCEPTANCE_SNAPSHOT_SCHEMA_VERSION = 1 as const;
/** Frozen cap for the accepted diff, mirroring the live observer limit. */
export const MAX_ACCEPTANCE_DIFF_BYTES = 128 * 1024;
export const MAX_ACCEPTANCE_SNAPSHOT_BYTES = 1024 * 1024;
export const MAX_SNAPSHOT_VERIFICATIONS = 64;

export const MAX_SPEC_BYTES = 128 * 1024;
export const MAX_DESIGN_BYTES = 256 * 1024;
export const MAX_HANDOFF_BYTES = 128 * 1024;
export const MAX_STATE_BYTES = 512 * 1024;
export const MAX_EVIDENCE_BYTES = 512 * 1024;
export const MAX_CRITERIA = 32;
export const MAX_TASKS = 64;
export const MAX_TIMELINE = 500;
export const MAX_DISCUSSIONS = 200;
export const MAX_AGENT_RUNS = 30;
export const MAX_SCREENSHOT_BATCHES = 5;
export const MAX_SCREENSHOTS_PER_BATCH = 12;
export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
export const MAX_SCREENSHOT_TOTAL_MS = 90_000;
export const MAX_SCREENSHOT_NAV_MS = 15_000;
export const MAX_TITLE_CHARS = 120;
export const MAX_REASON_CHARS = 2000;

/** 附件能力限额（图片与普通文件共用） */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_ITEM = 8;
export const MAX_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_NAME_CHARS = 120;

/** 附件元数据：二进制独立落盘，此处只保存引用与摘要。 */
export interface AttachmentMeta {
  /** ATT-<timestamp36>-<rand6>，匹配 TOKEN_ID_RE */
  id: string;
  /** 清理后的原始文件名，仅用于展示 */
  name: string;
  /** 服务端按扩展名映射的 MIME，不信任客户端声明 */
  mimeType: string;
  size: number;
  sha256: string;
  addedAt: number;
}

export const AGENT_ACTIONS = ["ask", "design", "implement", "fix", "review"] as const;
export type AgentAction = (typeof AGENT_ACTIONS)[number];

export const REVIEW_VERDICTS = ["pass", "concern", "block"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const STAGES = [
  "draft",
  "designing",
  "awaiting_approval",
  "implementing",
  "awaiting_acceptance",
  "done",
  "blocked",
  "cancelled",
] as const;

export type Stage = (typeof STAGES)[number];

export const TRACKS = ["plan_first", "fast_track"] as const;
export type Track = (typeof TRACKS)[number];

export const TASK_STATUSES = ["pending", "in_progress", "done", "blocked"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type PrivacyMode = "local" | "tracked";

export const OUTPUT_LANGUAGES = ["zh-CN", "en", "auto"] as const;
export type OutputLanguage = (typeof OUTPUT_LANGUAGES)[number];

export const GIT_REMOTE_PROVIDERS = ["github", "gitee"] as const;
export type GitRemoteProvider = (typeof GIT_REMOTE_PROVIDERS)[number];

export interface ProjectGitHubConfig {
  repo?: string;
  autoCreateIssue?: boolean;
  autoSyncIssue?: boolean;
  defaultBaseBranch?: string;
}

export interface ProjectGiteeConfig {
  /** Gitee repository slug (owner/repo); auto-detected from origin remote when omitted. */
  repo?: string;
  /** Gitee enterprise path (e.g. openstring) used to list enterprise issues without a repository binding. */
  enterprise?: string;
  /** Default PR target branch (e.g. master). */
  defaultBaseBranch?: string;
}

export interface ProjectMetadata {
  schemaVersion: typeof SCHEMA_VERSION;
  projectId: string;
  name: string;
  nextNumber: number;
  privacyMode: PrivacyMode;
  outputLanguage?: OutputLanguage;
  github?: ProjectGitHubConfig;
  gitee?: ProjectGiteeConfig;
  createdAt: number;
  updatedAt: number;
}

export interface Criterion {
  id: string;
  description: string;
  required: boolean;
  command?: string;
}

export interface CriterionInput {
  id?: string;
  description: string;
  required?: boolean;
  command?: string;
}

export interface ApprovalRecord {
  approvedAt: number;
  track: Track;
  specHash: string;
  designVersion: number;
  designHash: string;
  baselineHead: string | null;
  baselineFingerprint: string | null;
  note?: string;
}

export interface ReviewDisposition {
  reviewId?: string;
  verdict?: ReviewVerdict;
  effectiveState: "current" | "stale" | "missing";
  acceptedRisks?: string[];
}

export interface AcceptanceRecord {
  acceptedAt: number;
  specHash: string;
  codeSnapshotHash: string;
  verificationIds: string[];
  note?: string;
  /** Optional human reason when accepting over a blocking/concern/stale/unreviewed state. */
  overrideReason?: string;
  /** Snapshot of review status and accepted risk items at acceptance time. */
  reviewDisposition?: ReviewDisposition;
  /** Reference to the immutable evidence artifact captured at acceptance; absent on legacy records. */
  snapshot?: AcceptanceSnapshotReference | null;
}

export interface TaskItem {
  id: string;
  title: string;
  status: TaskStatus;
  note?: string;
  updatedAt: number;
}

export interface TaskInput {
  id?: string;
  title: string;
  status: TaskStatus;
  note?: string;
}

export interface BaselineSnapshot {
  head: string;
  fingerprint: string;
  dirty: boolean;
  capturedAt: number;
}

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

export type DiffEvidenceStatus = "captured" | "empty" | "unavailable";

export type DiffFilesScope = "baseline-relative" | "worktree" | "none";

export interface GitObservation {
  isGitRepo: boolean;
  head: string;
  fingerprint: string | null;
  dirty: boolean;
  files: ChangedFile[];
  filesScope: DiffFilesScope;
  diff: string;
  diffBytes: number;
  diffTruncated: boolean;
  diffStatus: DiffEvidenceStatus;
  diffReason: string | null;
  binaryFiles: string[];
  omittedFiles: string[];
  baselineRequested: string | null;
  baselineHead: string | null;
  baselineAvailable: boolean;
  commits: CommitInfo[];
  capturedAt: number;
}

export interface VerificationRecord {
  id: string;
  command: string;
  cwd: string;
  criterionIds: string[];
  specHash: string;
  codeSnapshotHash: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  startedAt: number;
  endedAt: number;
  passed: boolean;
  outputPath: string;
  outputPreview: string;
  truncated: boolean;
}

export interface AcceptanceGitEvidence {
  diffStatus: DiffEvidenceStatus;
  reason: string | null;
  isGitRepo: boolean;
  baselineRequested: string | null;
  baselineHead: string | null;
  baselineAvailable: boolean;
  observedHead: string;
  fingerprint: string | null;
  dirty: boolean;
  files: ChangedFile[];
  filesScope: DiffFilesScope;
  commits: CommitInfo[];
  diff: string;
  diffBytes: number;
  diffTruncated: boolean;
  maxDiffBytes: number;
  binaryFiles: string[];
  omittedFiles: string[];
  capturedAt: number;
}

export interface AcceptanceVerificationEvidence {
  record: VerificationRecord;
  effectiveState: EffectiveVerificationState;
  staleReason: string | null;
  selectedForAcceptance: boolean;
}

/** Immutable record of exactly what a human reviewed at acceptance time. */
export interface AcceptanceSnapshot {
  schemaVersion: typeof ACCEPTANCE_SNAPSHOT_SCHEMA_VERSION;
  id: string;
  requirementId: string;
  capturedAt: number;
  acceptedAt: number;
  specHash: string;
  designHash: string;
  codeSnapshotHash: string;
  codeRootKind: "project" | "sandbox";
  criteria: Criterion[];
  coverage: CriterionCoverageItem[];
  requiredTotal: number;
  requiredPassed: number;
  verifications: AcceptanceVerificationEvidence[];
  omittedVerificationCount: number;
  git: AcceptanceGitEvidence;
  /** Frozen screenshot metadata captured for this requirement; image bytes stay in screenshots/. */
  screenshots?: ScreenshotBatch[];
  contentDigest: string;
}

export interface AcceptanceSnapshotReference {
  id: string;
  path: string;
  schemaVersion: typeof ACCEPTANCE_SNAPSHOT_SCHEMA_VERSION;
  capturedAt: number;
  contentDigest: string;
  sizeBytes: number;
}

/** Git commit record created during the post-acceptance delivery / wrap-up stage. */
export interface DeliveryRecord {
  deliveredAt: number;
  commitHash: string;
  shortHash: string;
  commitMessage: string;
  files: string[];
  branch: string | null;
  prNumber?: number;
  prUrl?: string;
  note?: string;
}

export interface DeliveryCandidateFile {
  path: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
  inAcceptedSnapshot: boolean;
}

export interface DeliveryPreview {
  requirementId: string;
  stage: Stage;
  isGitRepo: boolean;
  codeRootKind: "project" | "sandbox";
  branch: string | null;
  head: string | null;
  dirty: boolean;
  sandboxActive: boolean;
  aheadCommitsCount: number;
  canCommit: boolean;
  canCreatePr: boolean;
  remoteProvider: GitRemoteProvider | null;
  baseBranch: string | null;
  githubRepo: string | null;
  githubReady: boolean;
  githubReason: string | null;
  reason: string | null;
  suggestedMessage: string;
  suggestedBranch: string;
  candidates: DeliveryCandidateFile[];
  acceptedSnapshotFileCount: number;
  delivered: DeliveryRecord | null;
  githubPr: RequirementGitHubPrLink | null;
}

export type TimelineEventKind =
  | "created"
  | "spec_updated"
  | "design_proposed"
  | "approved"
  | "fast_tracked"
  | "changes_requested"
  | "tasks_updated"
  | "verified"
  | "screenshots_captured"
  | "submitted_for_acceptance"
  | "accepted"
  | "delivered"
  | "rejected"
  | "blocked"
  | "unblocked"
  | "cancelled"
  | "reopened"
  | "discussed"
  | "attachment_added"
  | "attachment_removed"
  | "review_submitted"
  | "github_issue_linked"
  | "github_issue_synced"
  | "github_pr_created"
  | "github_pr_synced";

export interface RequirementGitHubIssueLink {
  /** GitHub uses positive integer numbers (e.g. 42); Gitee uses alphanumeric ident (e.g. "I8ABCD"). */
  number: number | string;
  url: string;
  title: string;
  state: "open" | "progressing" | "closed" | "rejected";
  issueType?: string;
  programName?: string;
  lastSyncedStage?: Stage;
  lastSyncedAt: number;
}

export interface RequirementGitHubPrLink {
  number: number;
  url: string;
  title: string;
  headBranch: string;
  baseBranch: string;
  state: "open" | "merged" | "closed";
  mergedAt?: number | null;
  lastSyncedAt: number;
}

export interface RequirementGitHubLink {
  provider?: GitRemoteProvider;
  repo: string;
  enterprise?: string;
  issue?: RequirementGitHubIssueLink | null;
  pr?: RequirementGitHubPrLink | null;
}

export interface HandoffNote {
  updatedAt: number;
  keyDecisions: string[];
  deadEnds: string[];
  nextSteps: string[];
}

export interface DiscussionEntry {
  id: string;
  at: number;
  actor: "human" | "agent";
  mode: "ask" | "refine";
  anchor?: string;
  harness?: string;
  model?: string;
  message: string;
  resolved?: boolean;
}

export interface AgentRunRecord {
  id: string;
  action: AgentAction;
  harness: string;
  model: string;
  /** Model the CLI reported for the session, when it differs from the requested model. */
  effectiveModel?: string;
  /** True when the CLI silently downgraded the requested model (e.g. requested model -> auto). */
  modelFallback?: boolean;
  reasoningEffort?: string;
  nativeSessionId?: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  durationMs: number;
  rateLimited?: boolean;
  errorSummary?: string;
  logPath: string;
}

export const REVIEW_FINDING_SEVERITIES = ["high", "medium", "low"] as const;
export type ReviewFindingSeverity = (typeof REVIEW_FINDING_SEVERITIES)[number];

export interface ReviewFinding {
  id: string;
  severity: ReviewFindingSeverity;
  title: string;
  detail?: string;
  criterionIds?: string[];
  files?: string[];
  suggestion?: string;
}

export interface ReviewReport {
  id: string;
  reviewerHarness: string;
  reviewerModel: string;
  verdict: ReviewVerdict;
  summary: string;
  markdown: string;
  findings?: ReviewFinding[];
  reviewedSpecHash: string;
  reviewedCodeSnapshotHash: string;
  reviewedAt: number;
}

export type ScreenshotTrigger = "auto_submit" | "manual";
export type ScreenshotBatchStatus = "captured" | "partial" | "skipped";

/** Stable reason codes for workbench-generated screenshot skips; UI localizes them. */
export type ScreenshotSkipReasonCode =
  | "browser_missing"
  | "chrome_path_missing"
  | "puppeteer_path_missing"
  | "server_unavailable"
  | "browser_launch_failed"
  | "no_shots";

export interface ScreenshotShot {
  /** Stable shot ID such as S-<ts>-<uuid8>. */
  id: string;
  label: string;
  urlPath: string;
  viewport: string;
  theme: "light" | "dark";
  /** Requirement-relative PNG path such as screenshots/shot-<id>.png. */
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface ScreenshotBatch {
  id: string;
  createdAt: number;
  trigger: ScreenshotTrigger;
  actor: "agent" | "human" | "system";
  specHash: string;
  codeSnapshotHash: string;
  status: ScreenshotBatchStatus;
  skipReason: string | null;
  /** Present for skips produced by the workbench itself; historical raw reason stays readable. */
  reasonCode?: ScreenshotSkipReasonCode | null;
  shots: ScreenshotShot[];
  durationMs: number;
}

export interface ScreenshotCaptureResult {
  status: ScreenshotBatchStatus;
  batchId: string | null;
  reason: string | null;
  reasonCode?: ScreenshotSkipReasonCode | null;
  reasonParams?: Record<string, string> | null;
  batch: ScreenshotBatch | null;
}

export interface TimelineEvent {
  id: string;
  at: number;
  kind: TimelineEventKind;
  actor: "human" | "agent" | "system";
  summary: string;
  detail?: string;
}

export interface RequirementState {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  title: string;
  stage: Stage;
  track: Track;
  revision: number;
  specHash: string;
  designVersion: number;
  designHash: string;
  criteria: Criterion[];
  approval: ApprovalRecord | null;
  acceptance: AcceptanceRecord | null;
  delivery?: DeliveryRecord | null;
  tasks: TaskItem[];
  baseline: BaselineSnapshot | null;
  verifications: VerificationRecord[];
  timeline: TimelineEvent[];
  lastFeedback: string | null;
  blockedFrom: Stage | null;
  blockedReason: string | null;
  /** Explicit marker for UI-facing requirements; also used by source-driven pain point promotion. */
  uiRelated?: boolean;
  /** Bounded screenshot evidence batches, newest last; at most MAX_SCREENSHOT_BATCHES. */
  screenshotBatches?: ScreenshotBatch[];
  handoffNote?: HandoffNote | null;
  discussions?: DiscussionEntry[];
  agentRuns?: AgentRunRecord[];
  reviewReport?: ReviewReport | null;
  github?: RequirementGitHubLink | null;
  /** 可选附件元数据；旧数据无该字段时行为不变。 */
  attachments?: AttachmentMeta[];
  createdAt: number;
  updatedAt: number;
}

export type EffectiveVerificationState = "passed" | "failed" | "stale" | "unknown";

export interface EvaluatedVerification {
  record: VerificationRecord;
  effectiveState: EffectiveVerificationState;
  staleReason: string | null;
  staleReasonKey?: string;
  staleReasonParams?: UiMessageParams;
}

export type CriterionCoverageState = "passed" | "failed" | "stale" | "unverified" | "unavailable";

export interface CriterionCoverageItem {
  criterion: Criterion;
  state: CriterionCoverageState;
  verificationIds: string[];
  reason: string | null;
  reasonKey?: string;
  reasonParams?: UiMessageParams;
}

export interface CriteriaCoverage {
  items: CriterionCoverageItem[];
  requiredTotal: number;
  requiredPassed: number;
  optionalTotal: number;
  optionalPassed: number;
}

export interface ApprovalStatus {
  valid: boolean;
  reason: string | null;
  reasonKey?: string;
}

export interface AcceptanceGate {
  ok: boolean;
  blockers: string[];
  blockerRefs?: UiMessageRef[];
}

export type EvidenceContext = "live" | "accepted" | "legacy-unavailable";

export type AcceptanceArtifactStatus = "none" | "available" | "missing" | "corrupt";

export type CoverageSource = "live" | "snapshot" | "acceptance-hashes" | "unavailable";

/** Where the displayed verification/diff evidence came from, and how it was recovered. */
/** Optional UI message reference so clients can localize stable states while old fields stay readable. */
export interface UiMessageRef {
  key: string;
  params?: UiMessageParams;
}
export type UiMessageParamValue = string | number | UiMessageRef;
export type UiMessageParams = Record<string, UiMessageParamValue>;

export interface EvidenceProvenance {
  context: EvidenceContext;
  coverageSource: CoverageSource;
  artifactStatus: AcceptanceArtifactStatus;
  reason: string | null;
  reasonKey?: string;
  reasonParams?: UiMessageParams;
  coverageReasonKey?: string;
  coverageReasonParams?: UiMessageParams;
  scopeNoteKey?: string;
  acceptedAt: number | null;
  snapshotId: string | null;
  snapshotPath: string | null;
  snapshotCapturedAt: number | null;
  specHash: string | null;
  codeSnapshotHash: string | null;
  verificationIds: string[];
  diffStatus: DiffEvidenceStatus | null;
  diffBytes: number;
  diffTruncated: boolean;
  fileCount: number;
  commitCount: number;
  baselineHead: string | null;
  observedHead: string | null;
  scopeNote: string | null;
}

export interface RequirementDiffView {
  context: EvidenceContext;
  status: DiffEvidenceStatus;
  reason: string | null;
  reasonKey?: string;
  acceptedAt: number | null;
  snapshotId: string | null;
  snapshotCapturedAt: number | null;
  scopeNote: string | null;
  scopeNoteKey?: string;
  observation: GitObservation | null;
}

export type ActionId =
  | "dispatch_design"
  | "authorize_fast_track"
  | "approve_and_implement"
  | "approve_only"
  | "request_changes"
  | "dispatch_implement"
  | "run_all_verifications"
  | "dispatch_fix"
  | "dispatch_review"
  | "dispatch_fix_review"
  | "sync_base"
  | "accept"
  | "unblock"
  | "reopen";

export interface BannerAction {
  id: ActionId;
  label: string;
  labelKey?: string;
  labelParams?: UiMessageParams;
  disabledReason?: string;
}

export interface ActionBanner {
  headline: string;
  headlineKey?: string;
  headlineParams?: UiMessageParams;
  tone: "neutral" | "info" | "success" | "warning" | "danger";
  primaryAction: BannerAction | null;
  secondaryActions: BannerAction[];
}

export interface ReviewValidity {
  effectiveState: "current" | "stale" | "missing";
  reason: string | null;
  reasonKey?: string;
}

export interface ValidityReport {
  approval: ApprovalStatus;
  verifications: EvaluatedVerification[];
  coverage: CriteriaCoverage;
  acceptanceGate: AcceptanceGate;
  reviewValidity: ReviewValidity;
  banner: ActionBanner;
  needsDecision: boolean;
  decisionReason: string | null;
  decisionReasonKey?: string;
  decisionReasonParams?: UiMessageParams;
  evidenceContext: EvidenceContext;
  provenance: EvidenceProvenance;
}

export interface RequirementSummary {
  id: string;
  title: string;
  stage: Stage;
  track: Track;
  revision: number;
  designVersion: number;
  criteriaCount: number;
  requiredTotal: number;
  requiredPassed: number;
  tasksTotal: number;
  tasksDone: number;
  needsDecision: boolean;
  decisionReason: string | null;
  decisionReasonKey?: string;
  decisionReasonParams?: UiMessageParams;
  blockedReason: string | null;
  progressText: string;
  progressKey?: string;
  progressParams?: UiMessageParams;
  github?: RequirementGitHubLink | null;
  createdAt: number;
  updatedAt: number;
}

export interface RequirementDetail {
  state: RequirementState;
  specMarkdown: string;
  designMarkdown: string;
  handoffMarkdown: string;
  designHistoryVersions: number[];
  validity: ValidityReport;
  /** Frozen acceptance artifact when available; lets the UI render immutable screenshot history. */
  acceptanceSnapshot?: AcceptanceSnapshot | null;
}
