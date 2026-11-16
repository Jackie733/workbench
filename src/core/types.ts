export const SCHEMA_VERSION = 4 as const;
export const WORKBENCH_DIR = ".workbench" as const;

export const MAX_SPEC_BYTES = 128 * 1024;
export const MAX_DESIGN_BYTES = 256 * 1024;
export const MAX_STATE_BYTES = 512 * 1024;
export const MAX_EVIDENCE_BYTES = 512 * 1024;
export const MAX_CRITERIA = 32;
export const MAX_TASKS = 64;
export const MAX_TIMELINE = 500;
export const MAX_TITLE_CHARS = 120;
export const MAX_REASON_CHARS = 2000;

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

export interface ProjectMetadata {
  schemaVersion: typeof SCHEMA_VERSION;
  projectId: string;
  name: string;
  nextNumber: number;
  privacyMode: PrivacyMode;
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

export interface AcceptanceRecord {
  acceptedAt: number;
  specHash: string;
  codeSnapshotHash: string;
  verificationIds: string[];
  note?: string;
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

export type TimelineEventKind =
  | "created"
  | "spec_updated"
  | "design_proposed"
  | "approved"
  | "fast_tracked"
  | "changes_requested"
  | "tasks_updated"
  | "verified"
  | "submitted_for_acceptance"
  | "accepted"
  | "rejected"
  | "blocked"
  | "unblocked"
  | "cancelled"
  | "reopened";

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
  tasks: TaskItem[];
  baseline: BaselineSnapshot | null;
  verifications: VerificationRecord[];
  timeline: TimelineEvent[];
  lastFeedback: string | null;
  blockedFrom: Stage | null;
  blockedReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export type EffectiveVerificationState = "passed" | "failed" | "stale" | "unknown";

export interface EvaluatedVerification {
  record: VerificationRecord;
  effectiveState: EffectiveVerificationState;
  staleReason: string | null;
}

export type CriterionCoverageState = "passed" | "failed" | "stale" | "unverified";

export interface CriterionCoverageItem {
  criterion: Criterion;
  state: CriterionCoverageState;
  verificationIds: string[];
  reason: string | null;
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
}

export interface AcceptanceGate {
  ok: boolean;
  blockers: string[];
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
  | "accept"
  | "unblock"
  | "reopen";

export interface BannerAction {
  id: ActionId;
  label: string;
  disabledReason?: string;
}

export interface ActionBanner {
  headline: string;
  tone: "neutral" | "info" | "success" | "warning" | "danger";
  primaryAction: BannerAction | null;
  secondaryActions: BannerAction[];
}

export interface ValidityReport {
  approval: ApprovalStatus;
  verifications: EvaluatedVerification[];
  coverage: CriteriaCoverage;
  acceptanceGate: AcceptanceGate;
  banner: ActionBanner;
  needsDecision: boolean;
  decisionReason: string | null;
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
  blockedReason: string | null;
  progressText: string;
  createdAt: number;
  updatedAt: number;
}

export interface RequirementDetail {
  state: RequirementState;
  specMarkdown: string;
  designMarkdown: string;
  designHistoryVersions: number[];
  validity: ValidityReport;
}
