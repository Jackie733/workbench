import type { LucideIcon } from "lucide-react";
import { Check, Circle, CircleAlert, CircleDot, RefreshCw, X } from "lucide-react";
import type { CriterionCoverageState, TaskStatus } from "../../core/types.ts";

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
} satisfies Record<CriterionCoverageState, LucideIcon>;