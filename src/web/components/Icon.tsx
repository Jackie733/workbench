import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Circle,
  CircleAlert,
  CircleDot,
  CircleOff,
  ClipboardCheck,
  Clock,
  FileEdit,
  Hammer,
  Info,
  OctagonAlert,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Undo2,
  Unlock,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import type {
  ActionId,
  CriterionCoverageState,
  EffectiveVerificationState,
  ReviewVerdict,
  Stage,
  TaskStatus,
} from "../../core/types.ts";

export function Icon({
  icon: Glyph,
  size = 16,
  strokeWidth = 2,
  className,
}: {
  icon: LucideIcon;
  size?: 14 | 16 | 20;
  strokeWidth?: number;
  className?: string;
}) {
  return (
    <Glyph
      size={size}
      strokeWidth={strokeWidth}
      aria-hidden="true"
      focusable="false"
      className={className ? `ui-icon ${className}` : "ui-icon"}
    />
  );
}

export const TASK_ICONS = {
  pending: Circle,
  in_progress: CircleDot,
  done: Check,
  blocked: CircleAlert,
} satisfies Record<TaskStatus, LucideIcon>;

export const COVERAGE_ICONS = {
  passed: Check,
  failed: X,
  stale: RefreshCw,
  unverified: Circle,
  unavailable: CircleAlert,
} satisfies Record<CriterionCoverageState, LucideIcon>;

export const STAGE_ICONS = {
  draft: FileEdit,
  designing: Sparkles,
  awaiting_approval: Clock,
  implementing: Hammer,
  awaiting_acceptance: ClipboardCheck,
  done: CheckCircle2,
  blocked: CircleAlert,
  cancelled: CircleOff,
} satisfies Record<Stage, LucideIcon>;

export const EVIDENCE_ICONS = {
  passed: Check,
  failed: X,
  stale: RefreshCw,
  unknown: CircleAlert,
} satisfies Record<EffectiveVerificationState, LucideIcon>;

export const VERDICT_ICONS = {
  pass: CheckCircle2,
  concern: AlertTriangle,
  block: OctagonAlert,
} satisfies Record<ReviewVerdict, LucideIcon>;

export const BANNER_ACTION_ICONS = {
  dispatch_design: Sparkles,
  authorize_fast_track: Zap,
  approve_and_implement: Check,
  approve_only: Check,
  request_changes: Undo2,
  dispatch_implement: Play,
  run_all_verifications: Play,
  dispatch_fix: Wrench,
  dispatch_review: Search,
  dispatch_fix_review: Wrench,
  sync_base: RefreshCw,
  accept: Check,
  unblock: Unlock,
  reopen: RotateCcw,
} satisfies Record<ActionId, LucideIcon>;

export const CALLOUT_TONE_ICONS = {
  info: Info,
  warning: AlertTriangle,
  danger: AlertTriangle,
  success: CheckCircle2,
} satisfies Record<"info" | "warning" | "danger" | "success", LucideIcon>;