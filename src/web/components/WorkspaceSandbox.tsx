import { AlertTriangle, GitBranch, RefreshCw, Trash2, Wrench, XCircle } from "lucide-react";
import type { SandboxRecord } from "../../core/sandbox.ts";
import type { RequirementDetail, SandboxDriftInfo } from "../../core/types.ts";
import { api } from "../api.ts";
import { t } from "../i18n.ts";
import {
  dispatchSyncBaseWithAgent,
  guardRequirementRunLock,
  invalidateAllWorkbenchQueries,
  openRequirement,
  runBusy,
  syncSandboxBaseAction,
} from "../queries.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { CALLOUT_TONE_ICONS, Icon } from "./Icon.tsx";
import { AsyncButton } from "./ui/async-button.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Popover, PopoverDescription, PopoverPopup, PopoverTitle, PopoverTrigger } from "./ui/popover.tsx";

export function WorkspaceSandbox({ d, sandbox, drift, running }: {
  d: RequirementDetail;
  sandbox: SandboxRecord;
  drift?: SandboxDriftInfo | null;
  running: boolean;
}) {
  const language = useUiStore((s) => s.language);
  const busy = useUiStore((s) => s.busy);
  const showToastKey = useUiStore((s) => s.showToastKey);
  const { id, stage, designHash, github } = d.state;
  const cancelled = stage === "cancelled";
  const setupFailed = sandbox.setupStatus === "failed";
  const activeDrift = !cancelled && !(stage === "done" && github?.pr?.state === "merged") && drift && (
    drift.behindCount > 0 || drift.conflictFiles.length > 0 || Boolean(drift.siblingConflicts?.length)
  ) ? drift : null;
  const hasTrueConflict = Boolean(activeDrift?.conflictFiles.length);
  const siblingList = activeDrift?.siblingConflicts ?? [];
  const hasSiblingTrueConflict = siblingList.some((sibling) => sibling.conflictFiles.length > 0);
  const isAutoMergeable = !hasTrueConflict && activeDrift?.driftStatus === "auto_mergeable";
  const canAgentResolve = hasTrueConflict && (
    stage === "coding" || stage === "done" || (stage === "planning" && designHash !== "")
  );
  const disabled = busy || running;
  const separator = language === "en" ? ", " : "、";
  const sandboxLabel = t(language, "ws.sandboxStatus.label");
  const danger = setupFailed || hasTrueConflict || hasSiblingTrueConflict;
  const warning = cancelled || Boolean(activeDrift);
  const statusLabel = setupFailed
    ? t(language, "ws.sandboxStatus.setupFailed")
    : hasTrueConflict || hasSiblingTrueConflict
      ? t(language, "ws.sandboxStatus.conflict")
      : cancelled
        ? t(language, "ws.sandboxStatus.retained")
        : activeDrift && activeDrift.behindCount > 0
          ? t(language, "ws.sandboxStatus.behind", { count: activeDrift.behindCount })
          : activeDrift
            ? t(language, "ws.sandboxStatus.overlap")
            : sandboxLabel;

  async function handleSetup(action: "retry" | "ignore") {
    if (guardRequirementRunLock(id)) return;
    const res = await runBusy(() => api.retryOrIgnoreSandboxSetup(id, action));
    if (res) {
      await invalidateAllWorkbenchQueries();
      showToastKey(action === "retry" ? "sandbox.setupFailed.retriedToast" : "sandbox.setupFailed.ignoredToast");
    }
  }

  async function discardSandbox() {
    if (guardRequirementRunLock(id)) return;
    const res = await runBusy(() => api.discardSandbox(id));
    if (res) {
      await invalidateAllWorkbenchQueries();
      showToastKey("ws.discardSandboxDone");
    }
  }

  return (
    <Popover>
      <PopoverTrigger
        data-testid="sandbox-status-btn"
        title={statusLabel}
        aria-label={statusLabel === sandboxLabel ? sandboxLabel : `${sandboxLabel}: ${statusLabel}`}
        render={
          <Button
            size="xs"
            variant="outline"
            type="button"
            className={`ws-sandbox-trigger${danger ? " is-danger" : warning ? " is-warning" : ""}`}
          />
        }
      >
        <Icon icon={danger ? XCircle : warning ? AlertTriangle : GitBranch} size={14} />
        <span className="truncate">{statusLabel}</span>
      </PopoverTrigger>
      <PopoverPopup align="end" className="ws-popup-content w-96 max-w-(--available-width)">
        <PopoverTitle>{sandboxLabel}</PopoverTitle>
        {!activeDrift && !cancelled && (
          <PopoverDescription className="mt-1 wrap-anywhere">
            {t(language, "ws.sandboxTitle", { branch: sandbox.branch })}
          </PopoverDescription>
        )}
        {setupFailed && (
          <section className="mt-3" data-testid="sandbox-setup-failed-banner">
            <strong>{t(language, "sandbox.setupFailed.title")}</strong>
            {sandbox.setupError && (
              <p className="mt-1 wrap-anywhere text-muted-foreground">{sandbox.setupError}</p>
            )}
            <div className="ws-popup-actions">
              <AsyncButton
                size="xs"
                type="button"
                data-testid="sandbox-setup-retry-btn"
                disabled={disabled}
                onAction={() => handleSetup("retry")}
              >
                <Icon icon={RefreshCw} size={14} /> {t(language, "sandbox.setupFailed.retryBtn")}
              </AsyncButton>
              <AsyncButton
                size="xs"
                variant="outline"
                type="button"
                data-testid="sandbox-setup-ignore-btn"
                disabled={disabled}
                onAction={() => handleSetup("ignore")}
              >
                {t(language, "sandbox.setupFailed.ignoreBtn")}
              </AsyncButton>
            </div>
          </section>
        )}
        {activeDrift && (
          <section className="mt-3" data-testid="sandbox-drift-callout">
            <div className="flex flex-wrap items-center gap-1.5">
              <strong className="wrap-anywhere">
                {activeDrift.behindCount > 0
                  ? t(language, "ws.sandboxDrift.title", { branch: activeDrift.branch, count: activeDrift.behindCount })
                  : t(language, "ws.sandboxDrift.radarOnlyTitle", { branch: activeDrift.branch })}
              </strong>
              {hasTrueConflict && (
                <Badge variant="error">
                  <Icon icon={AlertTriangle} size={14} />
                  {t(language, "ws.sandboxDrift.conflictBadge", { count: activeDrift.conflictFiles.length })}
                </Badge>
              )}
              {isAutoMergeable && (
                <Badge variant="info">
                  <Icon icon={CALLOUT_TONE_ICONS.info} size={14} />
                  {t(language, "ws.sandboxDrift.autoMergeBadge", { count: activeDrift.overlapFiles.length })}
                </Badge>
              )}
            </div>
            {hasTrueConflict ? (
              <p className="mt-1 wrap-anywhere">
                {t(language, "ws.sandboxDrift.conflictDetail", { files: activeDrift.conflictFiles.join(separator) })}
              </p>
            ) : isAutoMergeable ? (
              <p className="mt-1 wrap-anywhere text-muted-foreground">
                {t(language, "ws.sandboxDrift.autoMergeDetail", { files: activeDrift.overlapFiles.join(separator) })}
              </p>
            ) : activeDrift.behindCount > 0 ? (
              <p className="mt-1 text-muted-foreground">{t(language, "ws.sandboxDrift.safeDetail")}</p>
            ) : null}
            {siblingList.length > 0 && (
              <div className="mt-2" data-testid="sibling-conflict-radar">
                <strong className={`flex items-center gap-1 ${hasSiblingTrueConflict ? "danger-text" : "muted"}`}>
                  <Icon icon={hasSiblingTrueConflict ? AlertTriangle : CALLOUT_TONE_ICONS.info} size={14} />
                  {t(language, "ws.sandboxDrift.siblingTitle")}
                </strong>
                <ul className="mt-1 grid gap-1">
                  {siblingList.map((sibling) => {
                    const hasConflict = sibling.conflictFiles.length > 0;
                    const files = hasConflict ? sibling.conflictFiles : sibling.overlapFiles;
                    return (
                      <li key={sibling.requirementId}>
                        <Badge
                          className="h-auto max-w-full whitespace-normal text-left sm:h-auto"
                          render={<button type="button" onClick={() => void openRequirement(sibling.requirementId)} />}
                          variant={hasConflict ? "error" : "secondary"}
                        >
                          <span className="wrap-anywhere">
                            {t(language, hasConflict ? "ws.sandboxDrift.siblingConflict" : "ws.sandboxDrift.siblingAuto", {
                              id: sibling.requirementId,
                              files: files.join(separator),
                            })}
                          </span>
                        </Badge>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {hasTrueConflict && !canAgentResolve && (
              <p className="mt-1 text-muted-foreground">{t(language, "ws.sandboxDrift.needDesignFirst")}</p>
            )}
            {(activeDrift.canAutoSync || canAgentResolve) && (
              <div className="ws-popup-actions">
                {activeDrift.canAutoSync && (
                  <AsyncButton
                    size="xs"
                    type="button"
                    data-testid="sync-sandbox-base-btn"
                    disabled={disabled}
                    onAction={() => syncSandboxBaseAction(id)}
                  >
                    <Icon icon={RefreshCw} size={14} /> {t(language, isAutoMergeable ? "ws.sandboxDrift.syncAutoMerge" : "ws.sandboxDrift.sync")}
                  </AsyncButton>
                )}
                {canAgentResolve && (
                  <AsyncButton
                    size="xs"
                    type="button"
                    data-testid="agent-sync-sandbox-btn"
                    disabled={disabled}
                    onAction={() => dispatchSyncBaseWithAgent(d, activeDrift)}
                  >
                    <Icon icon={Wrench} size={14} /> {t(language, stage === "planning"
                      ? "ws.sandboxDrift.approveAndSyncWithAgent"
                      : "ws.sandboxDrift.syncWithAgent")}
                  </AsyncButton>
                )}
              </div>
            )}
          </section>
        )}
        {cancelled && (
          <section className="mt-3" data-testid="cancelled-sandbox-callout">
            <strong className="wrap-anywhere">{t(language, "ws.cancelledSandboxTitle", { branch: sandbox.branch })}</strong>
            <p className="mt-1 text-muted-foreground">{t(language, "ws.cancelledSandboxDesc")}</p>
            <div className="ws-popup-actions">
              <AsyncButton
                size="xs"
                variant="outline"
                type="button"
                data-testid="discard-sandbox-btn"
                disabled={disabled}
                onAction={discardSandbox}
              >
                <Icon icon={Trash2} size={14} /> {t(language, "ws.discardSandboxBtn")}
              </AsyncButton>
            </div>
          </section>
        )}
      </PopoverPopup>
    </Popover>
  );
}
