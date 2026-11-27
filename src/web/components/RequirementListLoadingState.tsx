import type React from "react";
import { t, type UiLanguage } from "../i18n.ts";
import { Skeleton } from "./ui/skeleton.tsx";

export interface RequirementListLoadingStateProps {
  language: UiLanguage;
  rows?: number;
}

const DEFAULT_ROWS = 6;

export function RequirementListLoadingState({
  language,
  rows = DEFAULT_ROWS,
}: RequirementListLoadingStateProps): React.ReactElement {
  const rowCount = Math.max(0, Math.floor(rows));
  return (
    <div
      className="req-list req-list-loading"
      data-testid="req-list-loading"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="sr-only">{t(language, "home.listLoading")}</span>
      <div aria-hidden="true">
        {Array.from({ length: rowCount }, (_, index) => (
          <div className="req-row req-row-skeleton" data-testid="req-row-skeleton" key={index}>
            <div className="sb-req-item-body">
              <div className="sb-req-item-head">
                <Skeleton className="req-skel-id" />
                <Skeleton className="req-skel-time" />
              </div>
              <Skeleton className="req-skel-title" />
              <Skeleton className="req-skel-title req-skel-title-short" />
              <div className="req-skel-sub">
                <Skeleton className="req-skel-badge" />
                <Skeleton className="req-skel-badge req-skel-badge-wide" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
