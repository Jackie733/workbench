import type React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { t, type UiLanguage } from "../i18n.ts";
import { Icon } from "./Icon.tsx";
import { AsyncButton } from "./ui/async-button.tsx";
import { Card } from "./ui/card.tsx";
import { Skeleton } from "./ui/skeleton.tsx";
import { Spinner } from "./ui/spinner.tsx";

export type WorkspaceLoadingVariant = "detail" | "workspace";

export interface WorkspaceLoadingStateProps {
  selectedId: string | null;
  language: UiLanguage;
  isError?: boolean;
  errorMessage?: string;
  onRetry?: () => Promise<unknown>;
  variant?: WorkspaceLoadingVariant;
}

const STEPPER_COUNT = 4;
const TAB_WIDTH_CLASSES = [
  "ws-skel-tab-1",
  "ws-skel-tab-2",
  "ws-skel-tab-3",
  "ws-skel-tab-4",
  "ws-skel-tab-5",
] as const;

export function WorkspaceLoadingState({
  selectedId,
  language,
  isError = false,
  errorMessage,
  onRetry,
  variant = "detail",
}: WorkspaceLoadingStateProps): React.ReactElement {
  const isWorkspaceBoot = variant === "workspace";
  const showRequirementId = !isWorkspaceBoot && Boolean(selectedId);

  if (isError) {
    return (
      <div
        className="workspace-loading workspace-loading-error"
        data-testid="workspace-load-error"
        role="alert"
      >
        <div className="ws-loading-overlay">
          <div className="ws-loading-card ws-loading-card-error" data-testid="workspace-load-error-card">
            <div className="ws-loading-error-icon" aria-hidden="true">
              <Icon icon={AlertTriangle} size={20} />
            </div>
            <p className="ws-loading-title">{t(language, "ws.loadFailedTitle")}</p>
            {showRequirementId ? (
              <span className="req-id ws-loading-req-id" data-testid="workspace-loading-id">
                {selectedId}
              </span>
            ) : null}
            {errorMessage ? (
              <p className="ws-loading-error-msg" data-testid="workspace-load-error-message">
                {errorMessage}
              </p>
            ) : null}
            {onRetry ? (
              <AsyncButton
                type="button"
                data-testid="workspace-retry-btn"
                variant="outline"
                size="sm"
                className="ws-loading-retry-btn"
                onAction={onRetry}
              >
                <Icon icon={RefreshCw} size={14} />
                <span>{t(language, "ws.loadRetry")}</span>
              </AsyncButton>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="workspace-loading"
      data-testid="workspace-loading"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="ws-loading-pinned" aria-hidden="true">
        <div className="ws-loading-stepper">
          {Array.from({ length: STEPPER_COUNT }, (_, idx) => (
            <div className="ws-loading-step-group" key={idx}>
              <span className="ws-loading-step-dot" />
              <Skeleton className="ws-skel-step-label" />
              {idx < STEPPER_COUNT - 1 ? <span className="ws-loading-step-line" /> : null}
            </div>
          ))}
        </div>

        <div className="ws-loading-head">
          <Skeleton className="ws-skel-req-id" />
          <Skeleton className="ws-skel-title" />
          <Skeleton className="ws-skel-badge" />
          <Skeleton className="ws-skel-action" />
        </div>

        <div className="ws-loading-banner">
          <div className="ws-loading-banner-row">
            <Skeleton className="ws-skel-banner-main" />
            <Skeleton className="ws-skel-banner-btn" />
          </div>
          <div className="ws-loading-banner-row">
            <Skeleton className="ws-skel-banner-sub" />
            <Skeleton className="ws-skel-banner-meta" />
          </div>
        </div>

        <div className="ws-loading-tabs">
          {TAB_WIDTH_CLASSES.map((cls) => (
            <Skeleton key={cls} className={`ws-skel-tab ${cls}`} />
          ))}
        </div>
      </div>

      <div className="ws-loading-body">
        <div className="ws-loading-cards" aria-hidden="true">
          <Card className="ws-loading-skel-card">
            <Skeleton className="ws-skel-card-heading" />
            <Skeleton className="ws-skel-line ws-skel-line-100" />
            <Skeleton className="ws-skel-line ws-skel-line-92" />
            <Skeleton className="ws-skel-line ws-skel-line-78" />
            <Skeleton className="ws-skel-line ws-skel-line-64" />
          </Card>

          <Card className="ws-loading-skel-card">
            <Skeleton className="ws-skel-card-heading ws-skel-card-heading-sm" />
            <Skeleton className="ws-skel-line ws-skel-line-100" />
            <Skeleton className="ws-skel-line ws-skel-line-92" />
            <Skeleton className="ws-skel-line ws-skel-line-78" />
          </Card>
        </div>

        <div className="ws-loading-overlay">
          <div className="ws-loading-card" data-testid="workspace-loading-card">
            <div className="ws-loading-orbit" aria-hidden="true">
              <Spinner
                aria-hidden="true"
                aria-label={undefined}
                role={undefined}
                className="ws-loading-spinner size-5"
              />
            </div>
            <p className="ws-loading-title">{t(language, isWorkspaceBoot ? "app.loading" : "ws.loading")}</p>
            <div className="ws-loading-meta">
              {showRequirementId ? (
                <span className="req-id ws-loading-req-id" data-testid="workspace-loading-id">
                  {selectedId}
                </span>
              ) : null}
              <span className="ws-loading-hint">
                {t(language, isWorkspaceBoot ? "app.loadingHint" : "ws.loadingHint")}
              </span>
            </div>
            <div className="ws-loading-bar" aria-hidden="true">
              <span className="ws-loading-bar-thumb" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
