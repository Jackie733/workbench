export const SCHEMA_VERSION = 6 as const;
export const WORKBENCH_DIR = ".workbench" as const;

/** Schema of the immutable acceptance artifact written at human acceptance (REQ-003). */
export const ACCEPTANCE_SNAPSHOT_SCHEMA_VERSION = 1 as const;
/** Frozen cap for the accepted diff, mirroring the live observer limit. */
export const MAX_ACCEPTANCE_DIFF_BYTES = 512 * 1024;
export const MAX_ACCEPTANCE_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export const MAX_SNAPSHOT_VERIFICATIONS = 64;

export const MAX_SPEC_BYTES = 128 * 1024;
export const MAX_DESIGN_BYTES = 256 * 1024;
export const MAX_HANDOFF_BYTES = 128 * 1024;
export const MAX_STATE_BYTES = 512 * 1024;
export const MAX_EVIDENCE_BYTES = 512 * 1024;
export const MAX_CRITERIA = 32;
export const MAX_TIMELINE = 500;
export const MAX_DISCUSSIONS = 200;
export const MAX_AGENT_RUNS = 100;
export const MAX_RUN_LOG_BYTES = 4 * 1024 * 1024;
export const MAX_RUN_TRACE_BYTES = 8 * 1024 * 1024;
export const MAX_TOOL_INPUT_BYTES = 16 * 1024;
export const MAX_TOOL_OUTPUT_BYTES = 32 * 1024;
export const MAX_TRACE_TEXT_BYTES = 64 * 1024;
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
  "planning",
  "coding",
  "done",
  "cancelled",
] as const;

export type Stage = (typeof STAGES)[number];

export const TRACKS = ["plan_first", "fast_track"] as const;
export type Track = (typeof TRACKS)[number];

export const REQUIREMENT_TIERS = ["standard", "sota"] as const;
export type RequirementTier = (typeof REQUIREMENT_TIERS)[number];

export type PrivacyMode = "local" | "tracked";

export const OUTPUT_LANGUAGES = ["zh-CN", "en", "auto"] as const;
export type OutputLanguage = (typeof OUTPUT_LANGUAGES)[number];

export const GIT_REMOTE_PROVIDERS = ["github", "gitee"] as const;
export type GitRemoteProvider = (typeof GIT_REMOTE_PROVIDERS)[number];

export const HARNESS_IDS = ["codex", "qodercn", "opencode", "agy", "omp"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra", "auto"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const ROUTING_ROLES = ["defaultLead", "sotaLead", "reviewer"] as const;
export type RoutingRole = (typeof ROUTING_ROLES)[number];

export interface ModelTarget {
  harness: HarnessId;
  model: string;
  reasoningEffort?: ReasoningEffort;
}

export interface RoleRouteRule {
  primary: ModelTarget;
  fallbacks: ModelTarget[];
}

export interface RoutingConfig {
  /** Standard workhorse lead running ask/design/implement/fix end-to-end. */
  defaultLead: RoleRouteRule;
  /** Flagship SOTA lead running complex/escalated tasks end-to-end (human-triggered only). */
  sotaLead: RoleRouteRule;
  /** Independent heterogeneous reviewer for blind review after verification passes. */
  reviewer: RoleRouteRule;
  /** Automatically dispatch cross-model blind review after coding verification passes (defaults to true). */
  autoReview?: boolean;
  /** Automatically resume same session to fix failing verification commands after implement/fix exit 0 (defaults to true). */
  autoHeal?: boolean;
}

export const DEFAULT_PROJECT_ROUTING: RoutingConfig = {
  defaultLead: {
    primary: { harness: "qodercn", model: "Qwen4-Max" },
    fallbacks: [
      { harness: "codex", model: "gpt-6.1-terra" },
      { harness: "opencode", model: "opencode/deepseek-v4.1-flash-free" },
    ],
  },
  sotaLead: {
    primary: { harness: "codex", model: "gpt-6.2-astra", reasoningEffort: "high" },
    fallbacks: [
      { harness: "agy", model: "claude-opus-5-5", reasoningEffort: "high" },
      { harness: "agy", model: "gemini-4-hydrogen", reasoningEffort: "high" },
    ],
  },
  reviewer: {
    primary: { harness: "agy", model: "gemini-4-argon" },
    fallbacks: [
      { harness: "codex", model: "codex-auto-review" },
      { harness: "qodercn", model: "Qwen4-Max" },
    ],
  },
  autoReview: true,
  autoHeal: true,
};

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

export interface ProjectVerificationConfig {
  fastCommand?: string;
  fullCommand?: string;
  autoScreenshots?: boolean;
}

export interface ProjectMetadata {
  schemaVersion: typeof SCHEMA_VERSION;
  projectId: string;
  name: string;
  nextNumber: number;
  privacyMode: PrivacyMode;
  outputLanguage?: OutputLanguage;
  routing?: RoutingConfig;
  github?: ProjectGitHubConfig;
  gitee?: ProjectGiteeConfig;
  verification?: ProjectVerificationConfig;
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
  diffReasonKey?: string;
  diffReasonParams?: UiMessageParams;
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

export type SandboxDriftStatus = "up_to_date" | "clean_behind" | "auto_mergeable" | "true_conflict";

export interface SiblingConflictInfo {
  requirementId: string;
  title: string;
  branch: string;
  stage: Stage;
  conflictFiles: string[];
  overlapFiles: string[];
  autoMergeable: boolean;
}

export interface SandboxDriftInfo {
  requirementId: string;
  branch: string;
  baseBranch?: string;
  baseHead: string;
  mainHead: string;
  targetRef?: string;
  remoteAheadCount?: number;
  behindCount: number;
  aheadCount: number;
  mainDirty: boolean;
  driftStatus: SandboxDriftStatus;
  overlapFiles: string[];
  conflictFiles: string[];
  canAutoSync: boolean;
  siblingConflicts?: SiblingConflictInfo[];
}

export interface MergeOrderEntry {
  requirementId: string;
  title: string;
  stage: Stage;
  branch: string;
  aheadCount: number;
  behindCount: number;
  driftStatus: SandboxDriftStatus;
  conflictFiles: string[];
  overlapFiles: string[];
  touchedFilesCount: number;
  conflictsWithSiblings: string[];
  autoMergeableSiblings: string[];
  pr?: RequirementGitHubPrLink | null;
  reason: "clean_leaf" | "auto_mergeable" | "sibling_conflict" | "main_conflict";
}

export interface MergeOrderRecommendation {
  generatedAt: number;
  baseBranch: string;
  mainHead: string;
  ordered: MergeOrderEntry[];
}

export interface CascadeSyncItemResult {
  requirementId: string;
  status: "synced" | "up_to_date" | "conflict" | "error";
  behindCount: number;
  driftStatus?: SandboxDriftStatus;
  conflictFiles?: string[];
  error?: string;
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
  remoteBranchExists?: boolean;
  remoteBranchDiverged?: boolean;
  sandboxDrift?: SandboxDriftInfo | null;
}

export type TimelineEventKind =
  | "created"
  | "spec_updated"
  | "design_proposed"
  | "approved"
  | "fast_tracked"
  | "changes_requested"
  | "tier_changed"
  | "verified"
  | "screenshots_captured"
  | "accepted"
  | "delivered"
  | "rejected"
  | "cancelled"
  | "reopened"
  | "discussed"
  | "attachment_added"
  | "attachment_removed"
  | "review_submitted"
  | "github_issue_linked"
  | "github_issue_synced"
  | "github_pr_created"
  | "github_pr_synced"
  | "sandbox_synced"
  | "sub_requirements_spawned"
  | "agent_run_started"
  | "agent_run_finished"
  | "agent_handoff";

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

export type RunBillingMode = "subscription" | "api" | "free";
export type RunCostSource = "reported" | "estimated" | "free" | "unknown";
export type RunHandoffMode = "first_run" | "native_resume" | "fresh_handoff";
export type RunDispatchReason =
  | "user"
  | "route_primary"
  | "session_affinity"
  | "manual_fallback"
  | "auto_fallback"
  | "auto_heal"
  | "auto_review"
  | "sota_escalate"
  | "conflict_resolve"
  | "refine"
  | "ask";
export type RunToolCategory =
  | "read"
  | "write"
  | "bash"
  | "search"
  | "mcp"
  | "wb_cli"
  | "subagent"
  | "web"
  | "other";

export interface RunTokenUsage {
  inputTokens: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface RunCostSummary {
  apiCostUsd: number;
  equivalentCostUsd: number;
  billingMode: RunBillingMode;
  costSource: RunCostSource;
  quotaPool: string;
  currency: "USD";
}

export interface HandoffSectionMetric {
  key: string;
  label: string;
  priority: number;
  rawBytes: number;
  finalBytes: number;
  estTokens: number;
  truncated: boolean;
}

export interface RunContextSnapshot {
  schemaVersion: 1;
  runId: string;
  requirementId: string;
  action: AgentAction;
  capturedAt: number;
  handoffMode: RunHandoffMode;
  parentRunId?: string;
  resumedSessionId?: string;
  dispatchReason: RunDispatchReason;
  selectedTarget: { harness: string; model: string; reasoningEffort?: string };
  routeCandidates: Array<{ harness: string; model: string; reasoningEffort?: string; skippedReason?: string }>;
  specHashBefore: string;
  codeSnapshotHashBefore: string | null;
  handoffTotalBytes: number;
  handoffBudgetBytes: number;
  handoffEstTokens: number;
  promptBytes: number;
  promptEstTokens: number;
  sections: HandoffSectionMetric[];
  truncatedSections: string[];
  handoffMarkdown: string;
  promptText: string;
}

export type RunTraceEvent =
  | {
      seq: number;
      ts: number;
      type: "run.init";
      action: AgentAction;
      harness: string;
      model: string;
      effectiveModel?: string;
      modelFallback?: boolean;
      reasoningEffort?: string;
      quotaPool: string;
      billingMode: RunBillingMode;
      dispatchReason: RunDispatchReason;
      handoffMode: RunHandoffMode;
      parentRunId?: string;
      resumedSessionId?: string;
      structuredJson: boolean;
    }
  | {
      seq: number;
      ts: number;
      type: "handoff.snapshot";
      handoffMode: RunHandoffMode;
      contextPath: string;
      handoffTotalBytes: number;
      handoffBudgetBytes: number;
      handoffEstTokens: number;
      promptBytes: number;
      promptEstTokens: number;
      sections: HandoffSectionMetric[];
      truncatedSections: string[];
    }
  | {
      seq: number;
      ts: number;
      type: "turn.start";
      turnIndex: number;
    }
  | {
      seq: number;
      ts: number;
      type: "turn.end";
      turnIndex: number;
      durationMs?: number;
      contextTokens?: number;
      usage?: RunTokenUsage;
      costUsd?: number;
    }
  | {
      seq: number;
      ts: number;
      type: "thinking";
      turnIndex: number;
      text: string;
      truncated?: boolean;
    }
  | {
      seq: number;
      ts: number;
      type: "tool.start";
      turnIndex: number;
      callId: string;
      parentCallId?: string;
      toolName: string;
      category: RunToolCategory;
      summary: string;
      inputText?: string;
      inputTruncated?: boolean;
      filesTouched?: string[];
      wbCommand?: string;
    }
  | {
      seq: number;
      ts: number;
      type: "tool.end";
      turnIndex: number;
      callId: string;
      parentCallId?: string;
      toolName: string;
      category: RunToolCategory;
      summary: string;
      output?: string;
      outputBytes?: number;
      outputTruncated?: boolean;
      isError?: boolean;
      exitCode?: number | null;
      durationMs?: number;
      filesTouched?: string[];
      wbCommand?: string;
    }
  | {
      seq: number;
      ts: number;
      type: "context.compaction";
      turnIndex: number;
      mode: "explicit" | "inferred";
      beforeTokens?: number;
      afterTokens?: number;
      reclaimedTokens?: number;
      summary?: string;
    }
  | {
      seq: number;
      ts: number;
      type: "assistant.message";
      turnIndex: number;
      text: string;
      truncated?: boolean;
    }
  | {
      seq: number;
      ts: number;
      type: "raw.line";
      stream: "stdout" | "stderr" | "system";
      text: string;
    }
  | {
      seq: number;
      ts: number;
      type: "run.error";
      message: string;
      code?: string;
    }
  | {
      seq: number;
      ts: number;
      type: "trace.truncated";
      maxBytes: number;
    }
  | {
      seq: number;
      ts: number;
      type: "run.end";
      status: "succeeded" | "failed" | "cancelled";
      exitCode: number | null;
      durationMs: number;
      llmDurationMs?: number;
      toolDurationMs?: number;
      ttftMs?: number;
      turnsCount: number;
      toolCallsCount: number;
      toolErrorCount: number;
      compactionCount: number;
      peakContextTokens?: number;
      contextWindow?: number;
      usage?: RunTokenUsage;
      cost?: RunCostSummary;
      specChanged?: boolean;
      codeChanged?: boolean;
      errorSummary?: string;
    };

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
  hubPid?: number;
  status: "running" | "succeeded" | "failed" | "cancelled";
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  durationMs: number;
  rateLimited?: boolean;
  errorSummary?: string;
  logPath: string;
  quotaPool?: string;
  billingMode?: RunBillingMode;
  dispatchReason?: RunDispatchReason;
  handoffMode?: RunHandoffMode;
  parentRunId?: string;
  usage?: RunTokenUsage;
  cost?: RunCostSummary;
  turnsCount?: number;
  toolCallsCount?: number;
  toolErrorCount?: number;
  compactionCount?: number;
  peakContextTokens?: number;
  contextWindow?: number;
  llmDurationMs?: number;
  toolDurationMs?: number;
  ttftMs?: number;
  specChanged?: boolean;
  codeChanged?: boolean;
  tracePath?: string;
  contextPath?: string;
  traceTruncated?: boolean;
  healthWarnings?: string[];
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
  runId?: string;
}

export interface RequirementState {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  parentId?: string;
  title: string;
  stage: Stage;
  track: Track;
  tier: RequirementTier;
  revision: number;
  specHash: string;
  designVersion: number;
  designHash: string;
  criteria: Criterion[];
  approval: ApprovalRecord | null;
  acceptance: AcceptanceRecord | null;
  delivery?: DeliveryRecord | null;
  baseline: BaselineSnapshot | null;
  verifications: VerificationRecord[];
  timeline: TimelineEvent[];
  lastFeedback: string | null;
  cancelReason?: string | null;
  /** Explicit marker for UI-facing requirements. */
  uiRelated?: boolean;
  /** Bounded screenshot evidence batches, newest last; at most MAX_SCREENSHOT_BATCHES. */
  screenshotBatches?: ScreenshotBatch[];
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
  reasonParams?: UiMessageParams;
  acceptedAt: number | null;
  snapshotId: string | null;
  snapshotCapturedAt: number | null;
  scopeNote: string | null;
  scopeNoteKey?: string;
  observation: GitObservation | null;
  /** Deterministic advisory signals when diff deletes test files, skips tests, or removes assertions. */
  testTamperingSignals?: string[];
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
  | "escalate_sota"
  | "dispatch_review"
  | "dispatch_fix_review"
  | "sync_base"
  | "accept"
  | "accept_override"
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
  parentId?: string;
  title: string;
  stage: Stage;
  track: Track;
  tier: RequirementTier;
  revision: number;
  designVersion: number;
  criteriaCount: number;
  requiredTotal: number;
  requiredPassed: number;
  needsDecision: boolean;
  decisionReason: string | null;
  decisionReasonKey?: string;
  decisionReasonParams?: UiMessageParams;
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
  /** Child requirements spawned from this requirement (populated on detail reads). */
  subRequirements?: RequirementSummary[];
}
