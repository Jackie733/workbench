import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUp,
  BarChart3,
  Bug,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Columns2,
  Ellipsis,
  Eye,
  EyeOff,
  FileDiff,
  FileEdit,
  FileText,
  GitBranch,
  GitCommit,
  GitFork,
  GitMerge,
  GitPullRequest,
  History,
  Link2,
  Lock,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  Undo2,
  Upload,
  Wrench,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import type {
  AgentRunRecord,
  BannerAction,
  DecisionItem,
  RequirementDetail,
  ReviewReport,
  ScreenshotBatch,
  ScreenshotPhase,
  ScreenshotShot,
  ScreenshotSkipReasonCode,
  Stage,
} from "../../core/types.ts";
import { canDirectApproveWithDecisions } from "../state.ts";
import { api, requirementAttachmentUrl, screenshotUrl } from "../api.ts";
import {
  describeClientError,
  formatAgentStatusLabel,
  formatPrStateLabel,
  prStateRef,
  resolveWarningParam,
  t,
  translateRef,
  type MessageKey,
} from "../i18n.ts";
import {
  captureUiScreenshots,
  cancelRun,
  dispatchDesignReview,
  dispatchFixFromReview,
  executeVerify,
  guardRequirementRunLock,
  handleBannerAction,
  invalidateAllWorkbenchQueries,
  isRequirementNotFoundError,
  notifyCascadeSyncResults,
  openHandoff,
  openRequirement,
  queryClient,
  queryKeys,
  rememberProjectLesson,
  reviseDecisionsAndDispatch,
  reviseFromDesignReview,
  runBusy,
  setRequirementTierAction,
  toggleVerificationLog,
  triggerActiveRun,
  useDeliveryQuery,
  useDiffQuery,
  useHubStateQuery,
  useProjectQuery,
  useRequirementQuery,
  uploadScenarioScreenshots,
} from "../queries.ts";
import { parseUnifiedDiff, renderDiffLinesHtml, renderSimpleLineDiff } from "../render.ts";
import {
  collectModelOptions,
  COVERAGE_META,
  defaultActionForRequirement,
  describeEvidenceContext,
  EVIDENCE_META,
  findActiveAskRun,
  findLockingRequirementRun,
  formatDateTime,
  getPendingRefineAnnotations,
  isManualChecklistCriterion,
  STAGE_META,
  VERDICT_META,
  type DiffViewMode,
} from "../state.ts";
import { useDraftStore } from "../stores/draftStore.ts";
import { useStreamStore } from "../stores/streamStore.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { AttachmentGallery } from "./AttachmentGallery.tsx";
import { WorkspaceLoadingState } from "./WorkspaceLoadingState.tsx";
import { WorkspaceSandbox } from "./WorkspaceSandbox.tsx";
import { AttachmentPicker } from "./AttachmentPicker.tsx";
import {
  BANNER_ACTION_ICONS,
  CALLOUT_TONE_ICONS,
  COVERAGE_ICONS,
  EVIDENCE_ICONS,
  Icon,
  STAGE_ICONS,
  VERDICT_ICONS,
} from "./Icon.tsx";
import { LiveTimer, MarkdownView, ModalShell, RunnerSelect } from "./Primitives.tsx";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert.tsx";
import { AsyncButton } from "./ui/async-button.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Card } from "./ui/card.tsx";
import { Checkbox } from "./ui/checkbox.tsx";
import { DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "./ui/dialog.tsx";
import { Input } from "./ui/input.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group.tsx";
import { Label } from "./ui/label.tsx";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "./ui/menu.tsx";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "./ui/popover.tsx";
import { RadioGroupPrimitive, RadioPrimitive } from "./ui/radio-group.tsx";
import { SegmentedControl, SegmentedControlItem } from "./ui/segmented-control.tsx";
import { Tabs, TabsList, TabsTab } from "./ui/tabs.tsx";
import { Textarea } from "./ui/textarea.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip.tsx";

function mapTone(tone: string) {
  if (tone === "danger") return "error" as const;
  if (tone === "neutral") return "secondary" as const;
  return tone as "info" | "success" | "warning" | "error" | "secondary";
}

function StageStepper({ d, running }: { d: RequirementDetail; running: boolean }) {
  const language = useUiStore((s) => s.language);
  const stage = d.state.stage;
  const delivered = Boolean(d.state.delivery);
  const steps = [
    { key: "planning", label: STAGE_META.planning.labels[language] },
    { key: "coding", label: STAGE_META.coding.labels[language] },
    { key: "done", label: t(language, "ws.step.accept") },
    { key: "delivered", label: t(language, "ws.step.deliver") },
  ];
  const order: Record<Stage, number> = {
    planning: 0,
    coding: 1,
    done: delivered ? 3 : 3,
    cancelled: 0,
  };
  const idx = order[stage];

  return (
    <div className="stepper" data-testid="stage-stepper">
      {steps.map((st, i) => {
        const cls =
          stage === "done"
            ? delivered
              ? "done"
              : i < 3
                ? "done"
                : "active"
            : i < idx
              ? "done"
              : i === idx
                ? running
                  ? "active step-running"
                  : "active"
                : "";
        return (
          <div key={st.key} style={{ display: "contents" }}>
            {i > 0 && <div className="step-line" />}
            <div className={`step-item ${cls}`}>
              <span className="step-dot" />
              <span>{st.label}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function latestOutputLine(log: string): string {
  let end = log.length;
  while (end > 0) {
    const start = log.lastIndexOf("\n", end - 1) + 1;
    const line = log.slice(start, end).trim();
    if (line && !line.startsWith("$ ")) return line.slice(0, 140);
    end = start - 1;
  }
  return "";
}

function WorkspaceTitle({ title }: { title: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    const heading = ref.current;
    if (!heading) return;
    const measure = () => setTruncated(heading.scrollWidth > heading.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(heading);
    return () => observer.disconnect();
  }, [title]);

  return (
    <Tooltip>
      <TooltipTrigger disabled={!truncated} render={<h1 ref={ref} className="ws-title truncate" tabIndex={truncated ? 0 : undefined} />}>
        {title}
      </TooltipTrigger>
      <TooltipPopup role="tooltip" side="bottom" align="start" className="max-w-[min(36rem,90vw)] [overflow-wrap:anywhere]">
        {title}
      </TooltipPopup>
    </Tooltip>
  );
}

type ConfirmApproval = (label: string, action: (resetSandbox: boolean) => Promise<void>) => Promise<void> | void;

function ApprovalConfirmation({
  label, canResetSandbox, dirtyBaseline, disabled, onClose, onApprove,
}: {
  label: string;
  canResetSandbox: boolean;
  dirtyBaseline: boolean;
  disabled: boolean;
  onClose: () => void;
  onApprove: (resetSandbox: boolean) => Promise<void>;
}) {
  const language = useUiStore((s) => s.language);
  const [reset, setReset] = useState(false);

  return (
    <ModalShell onClose={onClose} testId="workspace-approval-modal" hasExplicitTitle>
      <DialogHeader>
        <DialogTitle>{label}</DialogTitle>
        {dirtyBaseline && (
          <DialogDescription data-testid="dirty-baseline-hint">{t(language, "ws.dirtyHint")}</DialogDescription>
        )}
      </DialogHeader>
      {canResetSandbox && (
        <DialogPanel>
          <Label className="flex items-center gap-2 text-sm">
            <Checkbox
              data-testid="approve-reset-sandbox-checkbox"
              checked={reset}
              disabled={disabled}
              onCheckedChange={(checked) => setReset(Boolean(checked))}
            />
            {t(language, "ws.resetSandboxCheckbox")}
          </Label>
        </DialogPanel>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>{t(language, "common.cancel")}</Button>
        <AsyncButton
          type="button"
          data-testid="confirm-workspace-approval-btn"
          disabled={disabled}
          onAction={async () => {
            await onApprove(canResetSandbox && reset);
            onClose();
          }}
        >
          {t(language, "common.confirm")}
        </AsyncButton>
      </DialogFooter>
    </ModalShell>
  );
}

function LiveAgentRows({ run, headline }: { run: AgentRunRecord; headline: string }) {
  const language = useUiStore((s) => s.language);
  const setDrawerTab = useUiStore((s) => s.setDrawerTab);
  const setDrawerOpen = useUiStore((s) => s.setDrawerOpen);
  const selectedId = useUiStore((s) => s.selectedId);
  const latestOutput = useStreamStore((s) => latestOutputLine(s.liveRunLogs[run.id] ?? ""));

  const actionLabels: Record<string, string> = {
    design: t(language, "live.action.design"),
    implement: t(language, "live.action.implement"),
    fix: t(language, "live.action.fix"),
    review: t(language, "live.action.review"),
    ask: t(language, "live.action.ask"),
  };
  const latestLine = latestOutput || t(language, "live.waiting");
  const heading = t(language, "live.heading", { action: actionLabels[run.action] ?? run.action });
  const model = `${run.harness}/${run.effectiveModel ?? run.model}`;
  const modelHint = run.modelFallback && run.effectiveModel
    ? `${run.harness}/${run.model} · ${t(language, "live.fallback", { model: run.effectiveModel })}`
    : model;

  return (
    <>
      <div className="ws-execution-row" data-testid="live-agent-banner">
        <div className="ws-live-heading">
          <span className="pulse-dot" aria-hidden="true" />
          <strong className="truncate" title={heading}>{heading}</strong>
        </div>
        <div className="ws-inline-actions">
          <LiveTimer startedAt={run.startedAt} />
          <Button
            size="xs"
            variant="outline"
            type="button"
            data-testid="open-console-tab-btn"
            aria-label={t(language, "live.viewTerminal")}
            title={t(language, "live.viewTerminal")}
            onClick={() => {
              setDrawerOpen(true);
              setDrawerTab("console");
            }}
          >
            <Icon icon={Terminal} size={14} /> <span className="ws-compact-label">{t(language, "live.viewTerminal")}</span>
          </Button>
          <Button
            size="xs"
            variant="destructive"
            type="button"
            data-testid="workspace-stop-run-btn"
            onClick={() => selectedId && void cancelRun(selectedId, run.id)}
          >
            <Icon icon={Square} size={14} /> {t(language, "live.stop")}
          </Button>
        </div>
      </div>
      <div className="ws-execution-row ws-live-context">
        <Badge variant={run.modelFallback ? "warning" : "info"} title={modelHint}>
          <span className="truncate">{run.modelFallback ? t(language, "live.fallback", { model }) : model}</span>
        </Badge>
        <code className="ws-live-preview truncate" data-testid="live-banner-preview" title={latestLine}>{latestLine}</code>
        <span className="ws-live-stage truncate" title={headline}>{headline}</span>
        <span className="ws-lock-summary" data-testid="run-lock-hint" role="status" title={t(language, "ws.runLockHint")}>
          <Icon icon={Lock} size={14} /> {t(language, "ws.runLockShort")}
        </span>
      </div>
    </>
  );
}

function buildSpawnDrafts(d: RequirementDetail): Array<{ title: string; goal: string }> {
  const md = d.designMarkdown.trim();
  if (!md) return [{ title: "", goal: "" }];
  const skipRe = /^(?:总体思路|背景|概述|目标|验收|验证|目录|风险|回滚|overview|background|verification|testing|risks?)$/i;
  const out: Array<{ title: string; goal: string }> = [];
  let curTitle: string | null = null;
  let curLines: string[] = [];
  let inFence = false;
  const flush = () => {
    if (!curTitle) return;
    const clean = curTitle.replace(/^\d+(?:\.\d+)*[.)、\s]+/, "").trim() || curTitle;
    if (!skipRe.test(clean)) {
      const body = curLines.join("\n").trim();
      out.push({ title: clean.slice(0, 100), goal: body ? body.slice(0, 1200) : clean });
    }
    curTitle = null;
    curLines = [];
  };
  for (const line of md.split(/\r?\n/)) {
    if (line.trim().startsWith("```")) inFence = !inFence;
    if (!inFence) {
      const m = /^##\s+(.+?)\s*#*$/.exec(line.trim());
      if (m) {
        flush();
        curTitle = m[1]!.trim();
        continue;
      }
    }
    if (curTitle) curLines.push(line);
  }
  flush();
  return out.length > 0 ? out.slice(0, 12) : [{ title: "", goal: "" }];
}

function ManualChecksChecklistCard({
  d,
  runLocked,
  testId = "manual-checks-card",
  compact = false,
}: {
  d: RequirementDetail;
  runLocked: boolean;
  testId?: string;
  compact?: boolean;
}) {
  const language = useUiStore((st) => st.language);
  const busy = useUiStore((st) => st.busy);
  const showToastKey = useUiStore((st) => st.showToastKey);
  const s = d.state;
  const items = d.validity.coverage.items.filter((item) => isManualChecklistCriterion(item.criterion));
  const latestShotBatch =
    s.screenshotBatches && s.screenshotBatches.length > 0
      ? s.screenshotBatches[s.screenshotBatches.length - 1]
      : null;
  if (items.length === 0) return null;

  return (
    <Card
      className={compact ? "p-3 border-border/70 bg-background/50" : "p-4 mb-3.5"}
      data-testid={testId}
    >
      <div className="flex flex-wrap items-start justify-between gap-2 mb-2.5">
        <div className="min-w-0">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
            <Icon icon={BANNER_ACTION_ICONS.focus_manual_checks} size={14} />{" "}
            {t(language, "accept.manualChecksTitle")}
          </h3>
          <p className="text-xs text-muted-foreground mt-1 mb-0">{t(language, "accept.manualChecksHint")}</p>
        </div>
        {latestShotBatch && latestShotBatch.shots.length > 0 && (
          <span className="text-[11px] text-muted-foreground">
            {t(language, "accept.manualChecksViewScreenshots")} ·{" "}
            {t(language, "accept.screenshotsCount", { count: latestShotBatch.shots.length })}
          </span>
        )}
      </div>

      <div className="space-y-2">
        {items.map((item) => {
          const passed = item.state === "passed";
          const stateLabel = passed
            ? t(language, "spec.manualVerified")
            : item.state === "stale"
              ? t(language, "accept.manualStateStale")
              : item.state === "unverified"
                ? t(language, "accept.manualStateUnverified")
                : COVERAGE_META[item.state].labels[language];
          const stateTone =
            passed
              ? "success"
              : item.state === "stale" || item.state === "unavailable"
                ? "warning"
                : item.state === "failed"
                  ? "error"
                  : "secondary";
          return (
            <div
              key={item.criterion.id}
              className="rounded-lg border border-border/70 bg-card/60 p-2.5"
              data-testid={`${testId}-row-${item.criterion.id}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-xs font-medium">
                    <span className="req-id">{item.criterion.id}</span>
                    <Badge variant="secondary" size="sm">
                      {item.criterion.required ? t(language, "common.required") : t(language, "common.reference")}
                    </Badge>
                    <Badge variant={stateTone} size="sm">
                      <Icon icon={COVERAGE_ICONS[item.state]} size={14} /> {stateLabel}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1 [overflow-wrap:anywhere]">
                    {item.criterion.description}
                  </div>
                  {item.criterion.steps?.trim() && (
                    <div className="text-xs mt-1.5 [overflow-wrap:anywhere]">
                      <strong>{t(language, "spec.manualStepsLabel")}</strong>
                      <span className="whitespace-pre-wrap">{item.criterion.steps}</span>
                    </div>
                  )}
                  {(item.reason || item.reasonKey) && (
                    <div className="text-[11px] text-warning mt-1 [overflow-wrap:anywhere]">
                      {translateRef(language, item.reasonKey, item.reason ?? "", item.reasonParams)}
                    </div>
                  )}
                </div>
                {s.stage === "coding" && (
                  <AsyncButton
                    size="xs"
                    variant={passed ? "default" : "outline"}
                    type="button"
                    data-testid={`${testId}-toggle-${item.criterion.id}`}
                    aria-pressed={passed}
                    disabled={busy || runLocked}
                    onAction={async () => {
                      if (guardRequirementRunLock(s.id)) return;
                      const out = await runBusy(() =>
                        api.setManualCheck(s.id, {
                          criterionId: item.criterion.id,
                          checked: !passed,
                          expectedRevision: s.revision,
                        }),
                      );
                      if (out) {
                        await invalidateAllWorkbenchQueries();
                        showToastKey("spec.manualCheckSaved");
                      }
                    }}
                  >
                    <Icon icon={Check} size={14} />{" "}
                    {passed ? t(language, "spec.manualVerified") : t(language, "spec.manualMarkVerified")}
                  </AsyncButton>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {latestShotBatch && latestShotBatch.shots.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-2.5">
          {latestShotBatch.shots.slice(0, 4).map((shot) => (
            <a
              key={shot.id}
              href={screenshotUrl(s.id, shot.id)}
              target="_blank"
              rel="noreferrer"
              className="block"
              title={shot.label}
            >
              <img
                src={screenshotUrl(s.id, shot.id)}
                alt={shot.label}
                className="h-14 w-24 rounded border object-cover"
              />
            </a>
          ))}
        </div>
      )}
    </Card>
  );
}

function AcceptanceSummaryPanel({
  d,
  busy,
  runLocked,
  onOpenDiff,
}: {
  d: RequirementDetail;
  busy: boolean;
  runLocked: boolean;
  onOpenDiff: () => void;
}) {
  const language = useUiStore((st) => st.language);
  const activeProjectId = useUiStore((st) => st.activeProjectId);
  const { data: diffData } = useDiffQuery(activeProjectId, d.state.id, true, false);
  const [openDeliverAfter, setOpenDeliverAfter] = useState(false);
  const [acceptNote, setAcceptNote] = useState("");
  const [rememberLesson, setRememberLesson] = useState(false);
  const s = d.state;
  const cov = d.validity.coverage;
  const rev = s.reviewReport;
  const revState = d.validity.reviewValidity.effectiveState;
  const tamperingSignals = diffData?.testTamperingSignals ?? [];
  const fileCount = diffData?.observation?.files.length ?? 0;
  const latestScenarioBatch = latestScenarioScreenshotBatch(
    s.screenshotBatches,
    d.validity.provenance.codeSnapshotHash,
  );
  const latestShotBatch =
    latestScenarioBatch ??
    (s.screenshotBatches && s.screenshotBatches.length > 0
      ? s.screenshotBatches[s.screenshotBatches.length - 1]
      : null);
  const showScreenshots = Boolean(s.uiRelated || (latestShotBatch && latestShotBatch.shots.length > 0));
  const manualItems = cov.items.filter((item) => isManualChecklistCriterion(item.criterion));
  const manualPending = d.validity.manualCheckPending ?? null;
  const manualPendingHint = manualPending
    ? t(language, "accept.manualChecksPendingHint", {
        count: manualPending.pendingItems.length,
        ids: manualPending.pendingIds.join(", "),
      })
    : null;

  const reviewLabel =
    rev && revState === "current"
      ? rev.verdict === "pass"
        ? t(language, "accept.reviewPassed")
        : rev.verdict === "block"
          ? t(language, "accept.reviewBlock")
          : t(language, "accept.reviewConcern")
      : revState === "stale"
        ? t(language, "accept.reviewStale")
        : t(language, "accept.reviewMissing");

  return (
    <Card className="p-3.5 mb-3.5 border-primary/30 bg-card" data-testid="acceptance-summary-panel">
      <div className="flex items-center justify-between gap-2 mb-2.5 flex-wrap">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          <Icon icon={ShieldCheck} size={14} /> {t(language, "accept.panelTitle")}
        </h3>
      </div>

      <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
        <div className="rounded-lg border bg-background/70 p-2.5 space-y-1.5" data-testid="acceptance-credibility-card">
          <div className="text-xs font-semibold">{t(language, "accept.credibilityTitle")}</div>
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <Badge variant={d.validity.acceptanceGate.ok ? "success" : "warning"} size="sm">
              {t(language, "accept.coverageLine", { passed: cov.requiredPassed, total: cov.requiredTotal })}
            </Badge>
            <Badge
              variant={
                rev && revState === "current"
                  ? rev.verdict === "pass"
                    ? "success"
                    : rev.verdict === "block"
                      ? "error"
                      : "warning"
                  : "secondary"
              }
              size="sm"
            >
              {reviewLabel}
            </Badge>
          </div>
          {d.validity.baselineOnlyWarning && (
            <Alert variant="warning" data-testid="fast-track-baseline-warning" className="py-1.5 px-2.5">
              <Icon icon={AlertTriangle} size={14} />
              <AlertDescription className="text-xs">
                {t(language, "accept.fastTrackBaselineWarn")}
              </AlertDescription>
            </Alert>
          )}
        </div>

        <div className="rounded-lg border bg-background/70 p-2.5 space-y-1.5" data-testid="acceptance-diff-card">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold">{t(language, "accept.diffTitle")}</span>
            <Button size="xs" variant="outline" type="button" onClick={onOpenDiff} data-testid="acceptance-view-diff-btn">
              <Icon icon={FileDiff} size={14} /> {t(language, "accept.viewDiffBtn")}
            </Button>
          </div>
          <div className="text-xs text-muted-foreground">
            {t(language, "accept.diffFilesCount", { count: fileCount })}
          </div>
          {tamperingSignals.length > 0 && (
            <Alert variant="error" data-testid="acceptance-tampering-warning" className="py-1.5 px-2.5">
              <Icon icon={AlertTriangle} size={14} />
              <AlertDescription className="text-xs">
                {t(language, "accept.tamperingWarn", { detail: tamperingSignals.join("；") })}
              </AlertDescription>
            </Alert>
          )}
        </div>

        {showScreenshots && (
          <div className="rounded-lg border bg-background/70 p-2.5 space-y-1.5 md:col-span-2" data-testid="acceptance-screenshots-card">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="text-xs font-semibold">{t(language, "accept.screenshotsTitle")}</div>
              {latestShotBatch && (
                <Badge
                  variant={screenshotBatchSource(latestShotBatch) === "scenario" ? "success" : "secondary"}
                  size="sm"
                  data-testid="acceptance-screenshot-source-badge"
                >
                  {t(
                    language,
                    screenshotBatchSource(latestShotBatch) === "scenario"
                      ? "shot.source.scenario"
                      : "shot.source.matrix",
                  )}
                </Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {t(language, "accept.screenshotsCount", { count: latestShotBatch?.shots.length ?? 0 })}
            </div>
            {latestShotBatch && latestShotBatch.shots.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {latestShotBatch.shots.slice(0, 4).map((shot) => {
                  const phaseLabel = screenshotPhaseBadge(language, shot.phase);
                  return (
                    <div
                      key={shot.id}
                      className="relative w-28 rounded border bg-background/60 p-1"
                      data-testid={`acceptance-screenshot-${shot.id}`}
                    >
                      <img
                        src={screenshotUrl(s.id, shot.id)}
                        alt={shot.label}
                        className="h-16 w-full rounded object-cover"
                      />
                      {phaseLabel && (
                        <Badge
                          variant={shot.phase === "before" ? "secondary" : "success"}
                          size="sm"
                          className="absolute left-1 top-1"
                          data-testid={`acceptance-shot-phase-${shot.id}`}
                        >
                          {phaseLabel}
                        </Badge>
                      )}
                      <div className="mt-1 truncate text-[11px] text-muted-foreground">{shot.label}</div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground" data-testid="acceptance-screenshot-empty">
                {t(language, "shot.scenarioEmpty")}
              </div>
            )}
          </div>
        )}
      </div>

      {manualItems.length > 0 && (
        <div className="mt-2.5">
          <ManualChecksChecklistCard
            d={d}
            runLocked={runLocked}
            testId="acceptance-manual-checks-card"
            compact
          />
        </div>
      )}

      <div className="mt-2.5 pt-2.5 border-t space-y-2" data-testid="acceptance-exit-actions">
        <div className="flex flex-wrap items-center gap-3">
          <Input
            size="sm"
            className="max-w-sm"
            data-testid="accept-summary-note"
            value={acceptNote}
            placeholder={t(language, "deliver.notePlaceholder")}
            onChange={(e) => setAcceptNote(e.target.value)}
          />
          <Label className="flex items-center gap-1.5 text-xs font-normal">
            <Checkbox
              data-testid="accept-remember-lesson"
              checked={rememberLesson}
              onCheckedChange={(checked) => setRememberLesson(Boolean(checked))}
            />
            <span>{t(language, "playbook.rememberLabel")}</span>
          </Label>
          <Label className="flex items-center gap-1.5 text-xs font-normal">
            <Checkbox
              data-testid="accept-and-deliver-checkbox"
              checked={openDeliverAfter}
              onCheckedChange={(checked) => setOpenDeliverAfter(Boolean(checked))}
            />
            <span>{t(language, "accept.openDeliverAfter")}</span>
          </Label>
        </div>
        {rememberLesson && !acceptNote.trim() && (
          <div className="text-[11px] text-warning" data-testid="accept-remember-empty-hint">
            {t(language, "accept.rememberEmptyHint")}
          </div>
        )}
        {manualPendingHint && (
          <div className="text-[11px] text-warning" data-testid="acceptance-manual-pending-hint">
            {manualPendingHint}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <AsyncButton
            size="sm"
            type="button"
            data-testid="acceptance-exit-accept-btn"
            disabled={busy || runLocked || !d.validity.acceptanceGate.ok || Boolean(manualPending)}
            title={manualPendingHint ?? undefined}
            onAction={() =>
              handleBannerAction(d, "accept", {
                openDeliverAfter,
                rememberLesson,
                note: acceptNote,
              })
            }
          >
            <Icon icon={Check} size={14} /> {t(language, "accept.exitAccept")}
          </AsyncButton>
          <AsyncButton
            size="sm"
            variant="outline"
            type="button"
            data-testid="acceptance-exit-reject-btn"
            disabled={busy || runLocked}
            onAction={() => handleBannerAction(d, "request_changes")}
          >
            <Icon icon={Undo2} size={14} /> {t(language, "accept.exitReject")}
          </AsyncButton>
          <AsyncButton
            size="sm"
            variant="outline"
            type="button"
            data-testid="acceptance-exit-revise-btn"
            disabled={busy || runLocked}
            onAction={() => handleBannerAction(d, "revise_plan")}
          >
            <Icon icon={RotateCcw} size={14} /> {t(language, "accept.exitRevisePlan")}
          </AsyncButton>
        </div>
      </div>
    </Card>
  );
}

function InlineDecisionCard({
  d,
  runLocked,
  confirmApproval,
}: {
  d: RequirementDetail;
  runLocked: boolean;
  confirmApproval: ConfirmApproval;
}) {
  const language = useUiStore((s) => s.language);
  const busy = useUiStore((s) => s.busy);
  const { state: s } = d;
  const pending = s.pendingDecisions ?? [];

  const dirtyCustomRef = useRef<Set<string>>(new Set());
  const lastReqIdRef = useRef<string>(s.id);

  const [drafts, setDrafts] = useState<
    Record<string, { selectedOptionId: string | null; customAnswer: string }>
  >(() => {
    const init: Record<string, { selectedOptionId: string | null; customAnswer: string }> = {};
    for (const item of pending) {
      init[item.id] = {
        selectedOptionId: item.selectedOptionId ?? null,
        customAnswer: item.customAnswer ?? "",
      };
    }
    return init;
  });

  useEffect(() => {
    const isNewReq = lastReqIdRef.current !== s.id;
    if (isNewReq) {
      lastReqIdRef.current = s.id;
      dirtyCustomRef.current.clear();
    }
    setDrafts((prev) => {
      const next: Record<string, { selectedOptionId: string | null; customAnswer: string }> = {};
      for (const item of s.pendingDecisions ?? []) {
        if (!isNewReq && dirtyCustomRef.current.has(item.id) && prev[item.id]) {
          next[item.id] = prev[item.id]!;
        } else {
          next[item.id] = {
            selectedOptionId: item.selectedOptionId ?? null,
            customAnswer: item.customAnswer ?? "",
          };
        }
      }
      return next;
    });
  }, [s.id, s.revision]);

  if (s.stage !== "planning" || pending.length === 0) return null;

  const toSelections = (map: typeof drafts) =>
    pending.map((item) => {
      const cur = map[item.id];
      const custom = cur?.customAnswer?.trim() || "";
      return {
        id: item.id,
        selectedOptionId: custom ? null : (cur?.selectedOptionId ?? null),
        customAnswer: custom || null,
      };
    });

  const mergedPending: DecisionItem[] = pending.map((item) => {
    const cur = drafts[item.id];
    const custom = cur?.customAnswer?.trim() || "";
    return {
      ...item,
      selectedOptionId: custom ? null : (cur?.selectedOptionId ?? null),
      customAnswer: custom || null,
    };
  });
  const directCheck = canDirectApproveWithDecisions({ ...s, pendingDecisions: mergedPending });

  const persistDrafts = async (nextMap: typeof drafts) => {
    if (guardRequirementRunLock(s.id)) return;
    try {
      await api.saveDecisions(s.id, {
        selections: toSelections(nextMap),
      });
      await invalidateAllWorkbenchQueries();
    } catch {
      // Passive autosave; explicit submit/approve still sends the full draft selections.
    }
  };

  const selectPresetOption = (decisionId: string, optionId: string) => {
    dirtyCustomRef.current.delete(decisionId);
    const nextMap = {
      ...drafts,
      [decisionId]: { selectedOptionId: optionId, customAnswer: "" },
    };
    setDrafts(nextMap);
    void persistDrafts(nextMap);
  };

  const updateCustomAnswer = (decisionId: string, val: string) => {
    dirtyCustomRef.current.add(decisionId);
    setDrafts((prev) => ({
      ...prev,
      [decisionId]: {
        selectedOptionId: val.trim() ? null : (prev[decisionId]?.selectedOptionId ?? null),
        customAnswer: val,
      },
    }));
  };

  const handleDirectApprove = async (resetSandbox: boolean) => {
    if (guardRequirementRunLock(s.id) || !directCheck.allowed) return;
    const res = await runBusy(() =>
      api.approve(s.id, {
        expectedRevision: s.revision,
        decisionSelections: toSelections(drafts),
        ...(resetSandbox ? { resetSandbox: true } : {}),
      }),
    );
    if (res) {
      dirtyCustomRef.current.clear();
      await invalidateAllWorkbenchQueries();
      await triggerActiveRun(s.id, "implement");
    }
  };

  const handleSubmitAndRevise = async () => {
    const ok = await reviseDecisionsAndDispatch(s.id, {
      selections: toSelections(drafts),
      expectedRevision: s.revision,
      dispatchAgent: true,
    });
    if (ok) {
      dirtyCustomRef.current.clear();
    }
  };

  const unresolvedRefineCount = (s.discussions ?? []).filter((disc) => disc.mode === "refine" && !disc.resolved).length;

  return (
    <Card className="p-4 mb-3.5 border-warning/45 bg-warning/5" data-testid="decision-card">
      <div className="card-head">
        <div>
          <h3>{t(language, "decisions.cardTitle", { count: pending.length })}</h3>
          <div className="muted xs mt-1">{t(language, "decisions.cardSubtitle")}</div>
        </div>
      </div>

      <div className="flex flex-col gap-3 mt-2">
        {pending.map((item) => {
          const cur = drafts[item.id] ?? { selectedOptionId: null, customAnswer: "" };
          const hasCustom = cur.customAnswer.trim().length > 0;
          return (
            <div
              key={item.id}
              data-testid={`decision-item-${item.id}`}
              className="rounded-lg border bg-background p-3 space-y-2"
            >
              <div className="flex items-start gap-2">
                <Badge variant="warning" size="sm">
                  {item.id}
                </Badge>
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-medium">{item.question}</div>
                  {item.context && <div className="muted xs mt-0.5">{item.context}</div>}
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                {item.options.map((opt) => {
                  const selected = !hasCustom && cur.selectedOptionId === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      disabled={busy || runLocked}
                      data-testid={`decision-option-${item.id}-${opt.id}`}
                      aria-pressed={selected}
                      className={`flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left text-xs transition-colors ${
                        selected
                          ? "border-primary bg-primary/8 font-medium"
                          : "border-border hover:border-primary/40 hover:bg-accent/40"
                      }`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => selectPresetOption(item.id, opt.id)}
                    >
                      <span
                        className={`mt-0.5 inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border ${
                          selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/50"
                        }`}
                      >
                        {selected && <Icon icon={Check} size={14} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 flex-wrap">
                          <span>{opt.label}</span>
                          {opt.recommended && (
                            <Badge variant="info" size="sm">
                              {t(language, "decisions.recommended")}
                            </Badge>
                          )}
                        </span>
                        {opt.description && <span className="block muted mt-0.5 font-normal">{opt.description}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div>
                <Label className="mb-1 block text-[11.5px] text-muted-foreground font-normal">
                  {t(language, "decisions.customLabel")}
                </Label>
                <Input
                  size="sm"
                  data-testid={`decision-custom-${item.id}`}
                  disabled={busy || runLocked}
                  value={cur.customAnswer}
                  placeholder={t(language, "decisions.customPlaceholder")}
                  onChange={(e) => updateCustomAnswer(item.id, e.target.value)}
                  onBlur={() => {
                    if (cur.customAnswer.trim() !== (item.customAnswer ?? "")) {
                      void persistDrafts(drafts);
                    }
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <div className="muted xs" data-testid="decision-direct-hint">
          {!directCheck.allowed
            ? translateRef(language, directCheck.reasonKey, directCheck.reason ?? "")
            : unresolvedRefineCount > 0
              ? t(language, "decisions.unresolvedAnnotationsHint", { count: unresolvedRefineCount })
              : ""}
        </div>
        <div className="flex flex-wrap gap-2">
          <AsyncButton
            size="sm"
            variant="outline"
            type="button"
            data-testid="decision-revise-btn"
            disabled={busy || runLocked}
            onMouseDown={(e) => e.preventDefault()}
            onAction={handleSubmitAndRevise}
          >
            <Icon icon={Undo2} size={14} /> {t(language, "decisions.submitRevise")}
          </AsyncButton>
          <AsyncButton
            size="sm"
            type="button"
            data-testid="decision-direct-approve-btn"
            disabled={busy || runLocked || !directCheck.allowed}
            title={!directCheck.allowed ? translateRef(language, directCheck.reasonKey, directCheck.reason ?? "") : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onAction={() => confirmApproval(t(language, "decisions.directApprove"), handleDirectApprove)}
          >
            <Icon icon={Check} size={14} /> {t(language, "decisions.directApprove")}
          </AsyncButton>
        </div>
      </div>
    </Card>
  );
}

function SpecReviewCard({
  d,
  review,
  runLocked,
}: {
  d: RequirementDetail;
  review: ReviewReport;
  runLocked: boolean;
}) {
  const language = useUiStore((s) => s.language);
  const busy = useUiStore((s) => s.busy);
  const setDrawerOpen = useUiStore((s) => s.setDrawerOpen);
  const setDrawerTab = useUiStore((s) => s.setDrawerTab);
  const { state: s, validity } = d;
  const revValid = validity.reviewValidity;
  const isReviewCurrent = revValid.effectiveState === "current";
  const findings = review.findings ?? [];
  const [selectedFindingIds, setSelectedFindingIds] = useState(() => {
    const nonLowFindings = findings.filter((finding) => finding.severity !== "low");
    return (nonLowFindings.length > 0 ? nonLowFindings : findings).map((finding) => finding.id);
  });

  const toggleFinding = (fid: string) => {
    setSelectedFindingIds((prev) => (prev.includes(fid) ? prev.filter((x) => x !== fid) : [...prev, fid]));
  };

  return (
    <Card className={`review-card p-4 mb-3.5 ${VERDICT_META[review.verdict].tone}`} data-testid="review-report-card">
      <div className="card-head">
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <h3>{t(language, "review.title")}</h3>
          <Badge variant={mapTone(VERDICT_META[review.verdict].tone)}>
            <Icon icon={VERDICT_ICONS[review.verdict]} size={14} />{" "}
            {VERDICT_META[review.verdict].labels[language]}
          </Badge>
          <Badge variant={revValid.effectiveState === "current" ? "info" : "warning"}>
            {revValid.effectiveState === "current"
              ? t(language, "review.currentValid")
              : translateRef(language, revValid.reasonKey, t(language, "review.stale"))}
          </Badge>
          <span className="muted xs">
            {review.reviewerHarness} · {review.reviewerModel}
          </span>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {s.stage !== "done" && s.stage !== "cancelled" && review.verdict !== "pass" && (
            <>
              <AsyncButton
                size="xs"
                variant={isReviewCurrent ? "default" : "outline"}
                type="button"
                data-testid="review-fix-btn"
                disabled={busy || runLocked}
                onAction={() =>
                  dispatchFixFromReview(d, {
                    selectedFindingIds: findings.length > 0 ? selectedFindingIds : undefined,
                  })
                }
              >
                <Icon icon={Wrench} size={14} />{" "}
                {isReviewCurrent
                  ? findings.length > 0 && selectedFindingIds.length > 0
                    ? t(language, "review.fixSelected", { count: selectedFindingIds.length })
                    : t(language, "core.action.fixPerReview")
                  : t(language, "review.fixStale")}
              </AsyncButton>
              <AsyncButton
                size="xs"
                variant="outline"
                type="button"
                data-testid="review-reject-btn"
                disabled={busy || runLocked}
                onAction={() => handleBannerAction(d, "request_changes")}
              >
                <Icon icon={Undo2} size={14} /> {t(language, "core.action.sendBack")}
              </AsyncButton>
              {isReviewCurrent && validity.acceptanceGate.ok && (
                <AsyncButton
                  size="xs"
                  variant="outline"
                  type="button"
                  data-testid="review-override-accept-btn"
                  disabled={busy || runLocked}
                  onAction={() => handleBannerAction(d, "accept")}
                >
                  <Icon icon={Check} size={14} />{" "}
                  {review.verdict === "block"
                    ? t(language, "core.action.ignoreBlockAccept")
                    : t(language, "core.action.acceptRisk")}
                </AsyncButton>
              )}
            </>
          )}
          <AsyncButton
            size="xs"
            variant={!isReviewCurrent ? "default" : "outline"}
            type="button"
            data-testid="review-rerun-btn"
            disabled={busy || runLocked}
            onAction={() => triggerActiveRun(s.id, "review")}
          >
            <Icon icon={Search} size={14} /> {t(language, "review.rerun")}
          </AsyncButton>
          <AsyncButton
            size="xs"
            variant="outline"
            type="button"
            data-testid="review-fresh-rerun-btn"
            disabled={busy || runLocked}
            onAction={() => triggerActiveRun(s.id, "review", { forceFreshSession: true })}
          >
            <Icon icon={Search} size={14} /> {t(language, "review.freshRerun")}
          </AsyncButton>
          <Button
            size="xs"
            variant="outline"
            type="button"
            data-testid="review-compare-diff-btn"
            onClick={() => {
              setDrawerOpen(true);
              setDrawerTab("diff");
            }}
          >
            <Icon icon={PanelRightOpen} size={14} /> {t(language, "changes.dockToDrawer")}
          </Button>
        </div>
      </div>
      <div style={{ fontWeight: 500, marginBottom: 8 }}>{review.summary}</div>

      {findings.length > 0 && (
        <div className="review-findings-list" data-testid="review-findings-list">
          {findings.map((f) => {
            const checked = selectedFindingIds.includes(f.id);
            const sevTone = f.severity === "high" ? "error" : f.severity === "medium" ? "warning" : "secondary";
            const sevLabel =
              f.severity === "high"
                ? t(language, "review.severity.high")
                : f.severity === "medium"
                  ? t(language, "review.severity.medium")
                  : t(language, "review.severity.low");
            return (
              <Label key={f.id} className="review-finding-item w-full font-normal items-start">
                {s.stage !== "done" && review.verdict !== "pass" && (
                  <Checkbox
                    className="mt-0.5"
                    checked={checked}
                    onCheckedChange={() => toggleFinding(f.id)}
                  />
                )}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <Badge variant={sevTone}>{sevLabel}</Badge>
                    <code className="xs">{f.id}</code>
                    <strong style={{ fontSize: 13 }}>{f.title}</strong>
                    {f.criterionIds && f.criterionIds.length > 0 && (
                      <Badge variant="info">{f.criterionIds.join(", ")}</Badge>
                    )}
                  </div>
                  {f.files && f.files.length > 0 && (
                    <div className="muted xs" style={{ marginTop: 2 }}>
                      {t(language, "review.filesLabel")}
                      {f.files.join(" · ")}
                    </div>
                  )}
                  {f.suggestion && (
                    <div className="muted xs" style={{ marginTop: 2 }}>
                      {t(language, "review.suggestionLabel")}
                      {f.suggestion}
                    </div>
                  )}
                </div>
              </Label>
            );
          })}
        </div>
      )}

      <details open={review.verdict !== "pass" && revValid.effectiveState === "current"}>
        <summary className="xs muted" style={{ cursor: "pointer" }}>
          {t(language, "review.expand")}
        </summary>
        <MarkdownView markdown={review.markdown} className="md-body xs" />
      </details>
      {review.verdict === "block" && (
        <div className="mt-2 pt-2 border-t flex justify-end">
          <AsyncButton
            size="xs"
            variant="outline"
            type="button"
            data-testid="review-remember-lesson-btn"
            disabled={busy}
            onAction={() => rememberProjectLesson(review.summary, "review_block", s.id)}
          >
            <Icon icon={Save} size={14} /> {t(language, "playbook.rememberReviewBtn")}
          </AsyncButton>
        </div>
      )}
    </Card>
  );
}

function SpecDesignTab({
  activeProjectId,
  d,
  runLocked,
  confirmApproval,
}: {
  activeProjectId: string | null;
  d: RequirementDetail;
  runLocked: boolean;
  confirmApproval: ConfirmApproval;
}) {
  const language = useUiStore((s) => s.language);
  const busy = useUiStore((s) => s.busy);
  const designViewVersion = useUiStore((s) => s.designViewVersion);
  const designComparePrev = useUiStore((s) => s.designComparePrev);
  const designCompareText = useUiStore((s) => s.designCompareText);
  const setModal = useUiStore((s) => s.setModal);
  const showToast = useUiStore((s) => s.showToast);
  const showToastKey = useUiStore((s) => s.showToastKey);
  const setDrawerOpen = useUiStore((s) => s.setDrawerOpen);
  const setDrawerTab = useUiStore((s) => s.setDrawerTab);
  const setMoreMenuOpen = useUiStore((s) => s.setMoreMenuOpen);
  const setDesignComparePrev = useUiStore((s) => s.setDesignComparePrev);
  const setDesignCompareText = useUiStore((s) => s.setDesignCompareText);
  const highlightedAnchor = useUiStore((s) => s.highlightedAnchor);
  const clearAnchorHighlight = useUiStore((s) => s.clearAnchorHighlight);
  const setDiscussDraft = useDraftStore((s) => s.setDiscussDraft);
  const setDiscussAnchor = useDraftStore((s) => s.setDiscussAnchor);
  const specContainerRef = useRef<HTMLDivElement | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlightedElRef = useRef<HTMLElement | null>(null);
  const handledHighlightNonceRef = useRef<number>(0);
  const [selectionBar, setSelectionBar] = useState<{
    text: string;
    anchor: string;
    top: number;
    left: number;
  } | null>(null);

  const editingSpec = useDraftStore((s) => s.editingSpec);
  const specDraftTitle = useDraftStore((s) => s.specDraftTitle);
  const specDraftBody = useDraftStore((s) => s.specDraftBody);
  const specDraftCriteria = useDraftStore((s) => s.specDraftCriteria);
  const editingDesign = useDraftStore((s) => s.editingDesign);
  const designDraftBody = useDraftStore((s) => s.designDraftBody);
  const startEditSpec = useDraftStore((s) => s.startEditSpec);
  const cancelEditSpec = useDraftStore((s) => s.cancelEditSpec);
  const setSpecDraftTitle = useDraftStore((s) => s.setSpecDraftTitle);
  const setSpecDraftBody = useDraftStore((s) => s.setSpecDraftBody);
  const setSpecDraftCriteria = useDraftStore((s) => s.setSpecDraftCriteria);
  const startEditDesign = useDraftStore((s) => s.startEditDesign);
  const cancelEditDesign = useDraftStore((s) => s.cancelEditDesign);
  const setDesignDraftBody = useDraftStore((s) => s.setDesignDraftBody);

  const { state: s, validity } = d;
  const historyVers = d.designHistoryVersions;
  const activeVer = designViewVersion ?? s.designVersion;
  const review = s.reviewReport;

  const openAnnotate = (anchor: string, initialMessage = "") => {
    setModal({ kind: "annotate_anchor", anchor, message: initialMessage, mode: "refine" });
  };

  const annotationCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of getPendingRefineAnnotations(s.discussions)) {
      if (!item.anchor) continue;
      counts[item.anchor] = (counts[item.anchor] ?? 0) + 1;
    }
    return counts;
  }, [s.discussions]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      highlightedElRef.current?.classList.remove("anchor-jump-highlight");
      clearAnchorHighlight();
    };
  }, [clearAnchorHighlight]);

  useEffect(() => {
    if (!highlightedAnchor) return;
    if (highlightedAnchor.nonce <= handledHighlightNonceRef.current) return;
    const container = specContainerRef.current;
    if (!container) return;
    const targets = Array.from(container.querySelectorAll<HTMLElement>("[data-anchor-target]"));
    const targetAnchor = highlightedAnchor.anchor;
    const matched =
      targets.find((el) => el.dataset.anchorTarget === targetAnchor) ??
      targets.find((el) => targetAnchor.startsWith(`${el.dataset.anchorTarget}#`)) ??
      targets.find((el) => (el.dataset.anchorTarget ?? "").includes(targetAnchor));
    handledHighlightNonceRef.current = highlightedAnchor.nonce;
    if (!matched) {
      clearAnchorHighlight();
      return;
    }
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightedElRef.current?.classList.remove("anchor-jump-highlight");
    matched.scrollIntoView({ behavior: "smooth", block: "center" });
    matched.classList.remove("anchor-jump-highlight");
    void matched.offsetWidth;
    matched.classList.add("anchor-jump-highlight");
    highlightedElRef.current = matched;
    highlightTimerRef.current = setTimeout(() => {
      matched.classList.remove("anchor-jump-highlight");
      if (highlightedElRef.current === matched) highlightedElRef.current = null;
      highlightTimerRef.current = null;
      clearAnchorHighlight();
    }, 1800);
  }, [highlightedAnchor, clearAnchorHighlight]);

  useEffect(() => {
    const dismissSelectionBar = () => setSelectionBar(null);
    const onSelectionChange = () => {
      const sel = typeof window !== "undefined" ? window.getSelection() : null;
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        setSelectionBar(null);
        return;
      }
      const text = sel.toString().trim();
      if (text.length < 4 || text.length > 1200) {
        setSelectionBar(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const common = range.commonAncestorContainer;
      const el = common instanceof Element ? common : common.parentElement;
      const docEl = el?.closest<HTMLElement>("[data-annotatable-doc]");
      if (!docEl || !specContainerRef.current?.contains(docEl)) {
        setSelectionBar(null);
        return;
      }
      const docLabel = docEl.dataset.annotatableDoc ?? "design.md";
      const rows = Array.from(docEl.querySelectorAll<HTMLElement>("[data-anchor-target]"));
      const rect = range.getBoundingClientRect();
      let anchor = docLabel;
      for (const row of rows) {
        const rRect = row.getBoundingClientRect();
        if (rRect.top <= rect.top + 8 && row.dataset.anchorTarget) {
          anchor = row.dataset.anchorTarget;
        }
      }
      setSelectionBar({
        text,
        anchor,
        top: Math.max(56, rect.top - 40),
        left: Math.min(Math.max(16, rect.left + rect.width / 2), window.innerWidth - 180),
      });
    };
    document.addEventListener("mouseup", onSelectionChange);
    document.addEventListener("keyup", onSelectionChange);
    window.addEventListener("scroll", dismissSelectionBar, true);
    window.addEventListener("resize", dismissSelectionBar);
    return () => {
      document.removeEventListener("mouseup", onSelectionChange);
      document.removeEventListener("keyup", onSelectionChange);
      window.removeEventListener("scroll", dismissSelectionBar, true);
      window.removeEventListener("resize", dismissSelectionBar);
    };
  }, []);

  const canEditAttachments = s.acceptance === null && s.stage !== "done";
  const attachments = s.attachments ?? [];

  const addAttachments = async (metas: Array<{ id: string }>) => {
    if (metas.length === 0) return;
    if (guardRequirementRunLock(s.id)) return;
    const res = await runBusy(async () => {
      const out = await api.addRequirementAttachments(s.id, {
        attachmentIds: metas.map((m) => m.id),
        expectedRevision: s.revision,
      });
      await invalidateAllWorkbenchQueries();
      return out;
    });
    if (res) {
      showToastKey(
        metas.length === 1 ? "spec.addedAttachmentsOne" : "spec.addedAttachmentsOther",
        { count: metas.length },
      );
    }
  };

  const deleteAttachment = async (attId: string) => {
    if (guardRequirementRunLock(s.id)) return;
    if (typeof window !== "undefined" && !window.confirm(t(useUiStore.getState().language, "spec.confirmDeleteAttachment"))) {
      return;
    }
    const res = await runBusy(async () => {
      const out = await api.deleteRequirementAttachment(s.id, attId);
      await invalidateAllWorkbenchQueries();
      return out;
    });
    if (res) showToastKey("spec.attachmentDeleted");
  };

  const saveSpec = async () => {
    if (guardRequirementRunLock(s.id)) return;
    const criteria = specDraftCriteria
      .filter((c) => c.description.trim().length > 0)
      .map((c) => ({
        id: c.id.trim() || undefined,
        description: c.description.trim(),
        required: c.required,
        ...(c.kind === "manual" ? { kind: "manual" as const } : {}),
        command: c.kind === "manual" ? undefined : c.command.trim() || undefined,
        ...(c.kind === "manual" && c.steps?.trim() ? { steps: c.steps.trim() } : {}),
      }));
    const res = await runBusy(async () => {
      const out = await api.updateSpec(s.id, {
        title: specDraftTitle,
        specMarkdown: specDraftBody,
        criteria,
        expectedRevision: s.revision,
      });
      cancelEditSpec();
      await invalidateAllWorkbenchQueries();
      return out;
    });
    if (res) showToastKey("spec.savedSpec");
  };

  const saveDesign = async () => {
    if (guardRequirementRunLock(s.id)) return;
    const res = await runBusy(async () => {
      const out = await api.updateDesign(s.id, {
        designMarkdown: designDraftBody,
        expectedRevision: s.revision,
      });
      cancelEditDesign();
      setDesignComparePrev(false);
      setDesignCompareText(null);
      await invalidateAllWorkbenchQueries();
      return out;
    });
    if (res) showToastKey("spec.savedDesign");
  };

  const toggleDesignDiff = async () => {
    if (designComparePrev) {
      setDesignComparePrev(false);
      return;
    }
    if (!designCompareText) {
      const ver = designViewVersion ?? s.designVersion;
      const curr = ver === s.designVersion ? d.designMarkdown : (await api.getDesignHistory(s.id, ver)).markdown;
      const prevVer = ver > 1 ? ver - 1 : ver;
      const prev = ver > 1 ? (await api.getDesignHistory(s.id, prevVer)).markdown : curr;
      setDesignCompareText({ prev, curr, prevVer, currVer: ver });
      setDesignComparePrev(true);
    } else {
      setDesignComparePrev(true);
    }
  };

  return (
    <div ref={specContainerRef}>
      {selectionBar && (
        <div
          className="selection-quick-bar"
          data-testid="selection-quick-bar"
          style={{ top: selectionBar.top, left: selectionBar.left }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button
            type="button"
            className="selection-quick-btn"
            data-testid="selection-ask-btn"
            onClick={() => {
              const quote = `> ${selectionBar.text.replace(/\r?\n+/g, "\n> ")}\n\n`;
              const existing = useDraftStore.getState().discussDraftByReq[s.id] ?? "";
              setDiscussAnchor(s.id, selectionBar.anchor);
              setDiscussDraft(s.id, existing.trim() ? `${existing.trimEnd()}\n\n${quote}` : quote);
              setDrawerOpen(true);
              setDrawerTab("discuss");
              setSelectionBar(null);
              window.getSelection()?.removeAllRanges();
              setTimeout(() => {
                const input = document.getElementById("discuss-input") as HTMLTextAreaElement | null;
                input?.focus();
              }, 60);
            }}
          >
            <Icon icon={MessageSquare} size={14} /> {t(language, "selection.askAi")}
          </button>
          <span className="selection-quick-sep" aria-hidden="true" />
          <button
            type="button"
            className="selection-quick-btn"
            data-testid="selection-annotate-btn"
            onClick={() => {
              const quote = `「${selectionBar.text.slice(0, 180)}」\n`;
              openAnnotate(selectionBar.anchor, quote);
              setSelectionBar(null);
              window.getSelection()?.removeAllRanges();
            }}
          >
            <Icon icon={Pencil} size={14} /> {t(language, "selection.addAnnotation")}
          </button>
        </div>
      )}
      {review && (
        <SpecReviewCard
          key={JSON.stringify([activeProjectId, s.id, review.id])}
          d={d}
          review={review}
          runLocked={runLocked}
        />
      )}

      {s.stage === "planning" && Boolean(s.designHash) && (
        <Card
          className={`p-4 mb-3.5 ${
            s.designReviewReport?.verdict === "block"
              ? "border-destructive/50 bg-destructive/5"
              : s.designReviewReport?.verdict === "concern"
                ? "border-warning/45 bg-warning/5"
                : "border-border bg-muted/20"
          }`}
          data-testid="design-review-card"
        >
          <div className="card-head" style={{ marginBottom: s.designReviewReport ? 8 : 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <h3>{t(language, "designReview.cardTitle")}</h3>
              {s.designReviewReport && (
                <>
                  <Badge
                    variant={
                      s.designReviewReport.verdict === "pass"
                        ? "success"
                        : s.designReviewReport.verdict === "block"
                          ? "error"
                          : "warning"
                    }
                    data-testid="design-review-verdict"
                  >
                    <Icon icon={VERDICT_ICONS[s.designReviewReport.verdict]} size={14} />{" "}
                    {VERDICT_META[s.designReviewReport.verdict].labels[language]}
                  </Badge>
                  {d.validity.designReviewValidity?.effectiveState === "stale" && (
                    <Badge variant="warning" data-testid="design-review-stale-badge">
                      {t(language, "designReview.staleBadge")}
                    </Badge>
                  )}
                  <span className="muted xs">
                    {s.designReviewReport.reviewerHarness}/{s.designReviewReport.reviewerModel}
                  </span>
                </>
              )}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {s.designReviewReport && s.designReviewReport.verdict !== "pass" && (
                <AsyncButton
                  size="xs"
                  variant="default"
                  type="button"
                  data-testid="revise-from-design-review-btn"
                  disabled={busy || runLocked}
                  onAction={() => reviseFromDesignReview(d)}
                >
                  <Icon icon={Undo2} size={14} /> {t(language, "designReview.reviseBtn")}
                </AsyncButton>
              )}
              <AsyncButton
                size="xs"
                variant="outline"
                type="button"
                data-testid="dispatch-design-review-btn"
                disabled={busy || runLocked}
                onAction={() => dispatchDesignReview(s.id)}
              >
                <Icon icon={Search} size={14} /> {t(language, "designReview.triggerBtn")}
              </AsyncButton>
            </div>
          </div>
          {s.designReviewReport && (
            <>
              <div style={{ fontWeight: 500, marginBottom: 6 }}>{s.designReviewReport.summary}</div>
              {s.designReviewReport.verdict === "block" && (
                <div className="muted xs mb-2">{t(language, "designReview.nonBlockingNote")}</div>
              )}
              {s.designReviewReport.findings && s.designReviewReport.findings.length > 0 && (
                <div className="space-y-1.5 mb-2">
                  {s.designReviewReport.findings.map((f) => (
                    <div key={f.id} className="rounded border bg-background/80 px-2.5 py-1.5 text-xs">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Badge variant={f.severity === "high" ? "error" : f.severity === "medium" ? "warning" : "secondary"} size="sm">
                          {f.severity}
                        </Badge>
                        <code>{f.id}</code>
                        <strong>{f.title}</strong>
                      </div>
                      {f.detail && <div className="muted mt-0.5">{f.detail}</div>}
                      {f.suggestion && <div className="muted mt-0.5">{t(language, "review.suggestionLabel")}{f.suggestion}</div>}
                    </div>
                  ))}
                </div>
              )}
              <details>
                <summary className="xs muted" style={{ cursor: "pointer" }}>
                  {t(language, "designReview.expand")}
                </summary>
                <MarkdownView markdown={s.designReviewReport.markdown} className="md-body xs" />
              </details>
            </>
          )}
        </Card>
      )}

      {s.originalGoal && (
        <Card className="p-3.5 mb-3.5 bg-muted/30" data-testid="original-goal-card">
          <div className="card-head" style={{ marginBottom: 6 }}>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t(language, "spec.originalGoalTitle")}
            </h3>
            <Badge variant="secondary" size="sm">
              <Icon icon={Lock} size={14} /> {t(language, "spec.frozen")}
            </Badge>
          </div>
          <div className="text-[13px] whitespace-pre-wrap break-words" data-testid="original-goal-text">
            {s.originalGoal}
          </div>
        </Card>
      )}

      <InlineDecisionCard d={d} runLocked={runLocked} confirmApproval={confirmApproval} />

      {s.humanDecisions && s.humanDecisions.length > 0 && (
        <Card className="p-3.5 mb-3.5 border-info/35 bg-info/5" data-testid="adopted-decisions-card">
          <div className="card-head" style={{ marginBottom: 6 }}>
            <h3>{t(language, "decisions.adoptedTitle", { count: s.humanDecisions.length })}</h3>
          </div>
          <div className="flex flex-col gap-1.5 text-xs">
            {s.humanDecisions.map((dec) => (
              <div key={dec.id} className="flex flex-wrap items-baseline gap-1.5">
                <Badge variant="info" size="sm">{dec.id}</Badge>
                <span className="text-muted-foreground">{dec.question}</span>
                <span>→</span>
                <strong>{dec.answer}</strong>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-4 mb-3.5">
        <div className="card-head">
          <h3>{t(language, "spec.title")}</h3>
          {editingSpec ? (
            <div style={{ display: "flex", gap: 8 }}>
              <Button
                size="xs"
                variant="outline"
                type="button"
                data-action="start-edit-spec"
                onClick={() => cancelEditSpec()}
              >
                <Icon icon={X} size={14} /> {t(language, "common.cancel")}
              </Button>
              <AsyncButton
                size="xs"
                type="button"
                data-testid="save-spec-btn"
                disabled={busy || runLocked}
                onAction={saveSpec}
              >
                <Icon icon={Save} size={14} /> {t(language, "spec.save")}
              </AsyncButton>
            </div>
          ) : (
            s.stage !== "done" &&
            s.stage !== "cancelled" && (
              <Button
                size="xs"
                variant="outline"
                type="button"
                data-action="start-edit-spec"
                disabled={runLocked}
                onClick={() => {
                  setMoreMenuOpen(false);
                  startEditSpec(
                    s.title,
                    d.specMarkdown,
                    s.criteria.map((c) => ({
                      id: c.id,
                      description: c.description,
                      required: c.required,
                      kind: c.kind,
                      command: c.command ?? "",
                      steps: c.steps ?? "",
                    })),
                  );
                }}
              >
                <Icon icon={Pencil} size={14} /> {t(language, "spec.edit")}
              </Button>
            )
          )}
        </div>

        {editingSpec ? (
          <div data-testid="spec-editor" className="flex flex-col gap-2">
            <Input
              id="spec-title-input"
              value={specDraftTitle}
              placeholder={t(language, "spec.titlePlaceholder")}
              onChange={(e) => setSpecDraftTitle(e.target.value)}
            />
            <Textarea
              id="spec-body-input"
              value={specDraftBody}
              onChange={(e) => setSpecDraftBody(e.target.value)}
            />
            <div style={{ marginTop: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <strong style={{ fontSize: 13 }}>{t(language, "spec.criteriaTitle")}</strong>
                <Button
                  size="xs"
                  variant="outline"
                  type="button"
                  data-action="add-criterion"
                  onClick={() =>
                    setSpecDraftCriteria((prev) => [
                      ...prev,
                      { id: `AC-${prev.length + 1}`, description: "", required: true, command: "" },
                    ])
                  }
                >
                  <Icon icon={Plus} size={14} /> {t(language, "spec.addCriterion")}
                </Button>
              </div>
              {specDraftCriteria.map((c, idx) => (
                <div key={idx} className="crit-edit-row" data-criterion-idx={idx}>
                  <Input
                    size="sm"
                    data-crit-field="id"
                    value={c.id}
                    placeholder={`AC-${idx + 1}`}
                    onChange={(e) =>
                      setSpecDraftCriteria((prev) => {
                        const next = [...prev];
                        next[idx] = { ...next[idx]!, id: e.target.value };
                        return next;
                      })
                    }
                  />
                  <Input
                    size="sm"
                    data-crit-field="description"
                    value={c.description}
                    placeholder={t(language, "spec.descriptionPlaceholder")}
                    onChange={(e) =>
                      setSpecDraftCriteria((prev) => {
                        const next = [...prev];
                        next[idx] = { ...next[idx]!, description: e.target.value };
                        return next;
                      })
                    }
                  />
                  <Input
                    size="sm"
                    data-crit-field="command"
                    value={c.kind === "manual" ? (c.steps ?? "") : c.command}
                    placeholder={
                      c.kind === "manual"
                        ? t(language, "spec.stepsPlaceholder")
                        : t(language, "spec.commandPlaceholder")
                    }
                    onChange={(e) =>
                      setSpecDraftCriteria((prev) => {
                        const next = [...prev];
                        next[idx] =
                          c.kind === "manual"
                            ? { ...next[idx]!, steps: e.target.value }
                            : { ...next[idx]!, command: e.target.value };
                        return next;
                      })
                    }
                  />
                  <Label className="gap-1.5 text-xs whitespace-nowrap font-normal">
                    <Checkbox
                      checked={c.kind === "manual"}
                      onCheckedChange={(checked) =>
                        setSpecDraftCriteria((prev) => {
                          const next = [...prev];
                          next[idx] = checked
                            ? { ...next[idx]!, kind: "manual" }
                            : { ...next[idx]!, kind: "command", steps: undefined };
                          return next;
                        })
                      }
                    />
                    {t(language, "spec.manualKindLabel")}
                  </Label>
                  <Label className="gap-1.5 text-xs whitespace-nowrap font-normal">
                    <Checkbox
                      checked={c.required}
                      onCheckedChange={(checked) =>
                        setSpecDraftCriteria((prev) => {
                          const next = [...prev];
                          next[idx] = { ...next[idx]!, required: Boolean(checked) };
                          return next;
                        })
                      }
                    />
                    {t(language, "common.required")}
                  </Label>
                  <Button
                    size="xs"
                    variant="ghost"
                    type="button"
                    onClick={() => setSpecDraftCriteria((prev) => prev.filter((_, i) => i !== idx))}
                  >
                    <Icon icon={Trash2} size={14} /> {t(language, "common.delete")}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <MarkdownView
            markdown={d.specMarkdown}
            annotatable
            docLabel="spec.md"
            annotationCounts={annotationCounts}
            onAnnotate={openAnnotate}
          />
        )}
      </Card>

      <Card className="p-4 mb-3.5" data-testid="requirement-attachments-card">
        <div className="card-head">
          <h3>{t(language, "spec.attachmentTitle", { count: attachments.length })}</h3>
          {!canEditAttachments && (
            <Badge variant="secondary">
              <Icon icon={Lock} size={14} /> {t(language, "spec.frozen")}
            </Badge>
          )}
        </div>
        <AttachmentGallery
          attachments={attachments}
          urlFor={(attId) => requirementAttachmentUrl(s.id, attId)}
          onDelete={canEditAttachments && !runLocked ? (attId) => void deleteAttachment(attId) : undefined}
          emptyText={
            canEditAttachments ? t(language, "spec.attachmentsEmpty") : t(language, "spec.attachmentsEmptyReadonly")
          }
        />
        {canEditAttachments && (
          <div style={{ marginTop: 10 }}>
            <AttachmentPicker value={[]} onChange={(metas) => void addAttachments(metas)} disabled={busy || runLocked} />
          </div>
        )}
      </Card>

      <Card className="p-4 mb-3.5">
        <div className="card-head">
          <h3>
            {t(language, "spec.criteriaHeading", {
              passed: validity.coverage.requiredPassed,
              total: validity.coverage.requiredTotal,
            })}
          </h3>
          {validity.evidenceContext !== "live" && (
            <Badge
              variant={validity.evidenceContext === "accepted" ? "success" : "warning"}
              data-testid="coverage-context-badge"
            >
              <Icon
                icon={validity.evidenceContext === "accepted" ? ShieldCheck : AlertTriangle}
                size={14}
              />{" "}
              {validity.evidenceContext === "accepted"
                ? t(language, "spec.coverageAccepted")
                : t(language, "spec.coverageLegacy")}
            </Badge>
          )}
        </div>
        {validity.evidenceContext !== "live" && (() => {
          const evInfo = describeEvidenceContext(validity, null, language);
          return (
            <Alert
              variant={mapTone(evInfo.tone) === "error" ? "error" : evInfo.tone === "success" ? "success" : evInfo.tone === "warning" ? "warning" : "info"}
              data-testid="evidence-provenance-banner"
              className="mb-2.5 text-xs"
            >
              <Icon icon={CALLOUT_TONE_ICONS[evInfo.tone]} size={14} />
              <AlertTitle>{evInfo.title}</AlertTitle>
              <AlertDescription className="text-foreground">
                {evInfo.acceptedAtText && (
                  <span>{t(language, "spec.evidenceAcceptedAt", { time: evInfo.acceptedAtText })}</span>
                )}
                <div className="text-muted-foreground">{evInfo.provenanceText}</div>
                {evInfo.unavailableReason && <div>{evInfo.unavailableReason}</div>}
              </AlertDescription>
            </Alert>
          );
        })()}
        {validity.coverage.items.length === 0 ? (
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            {t(language, "spec.noCriteria")}
          </p>
        ) : (
          validity.coverage.items.map((item) => {
            const meta = COVERAGE_META[item.state];
            const critAnchor = t(language, "spec.criterionAnchor", { id: item.criterion.id });
            const critAnnotCount = annotationCounts[critAnchor] ?? 0;
            return (
              <div
                key={item.criterion.id}
                className="criteria-row"
                data-testid={`crit-${item.criterion.id}`}
                data-anchor-target={critAnchor}
              >
                <Badge variant={mapTone(meta.tone)}>
                  <Icon icon={COVERAGE_ICONS[item.state]} size={14} />
                  {meta.labels[language]}
                </Badge>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 500 }}>
                    <span className="req-id" style={{ marginRight: 6 }}>
                      {item.criterion.id}
                    </span>
                    {item.criterion.description}
                    <Badge variant="secondary" className="ms-1.5">
                      {item.criterion.required
                        ? t(language, "common.required")
                        : t(language, "common.reference")}
                    </Badge>
                    {(item.criterion.kind === "manual" || (!item.criterion.command && Boolean(item.criterion.steps))) && (
                      <Badge variant="info" className="ms-1.5">
                        {t(language, "spec.manualBadge")}
                      </Badge>
                    )}
                  </div>
                  {item.criterion.command && <div className="crit-cmd">{item.criterion.command}</div>}
                  {item.criterion.steps && (
                    <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                      <strong>{t(language, "spec.manualStepsLabel")}</strong>
                      {item.criterion.steps}
                    </div>
                  )}
                  {(item.reason || item.reasonKey) && (
                    <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                      {translateRef(language, item.reasonKey, item.reason ?? "", item.reasonParams)}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <Button
                    size={critAnnotCount > 0 ? "xs" : "icon-xs"}
                    variant="ghost"
                    type="button"
                    data-action="annotate-anchor"
                    data-anchor={critAnchor}
                    title={t(language, "spec.annotateTitle")}
                    aria-label={t(language, "spec.annotateTitle")}
                    onClick={() => openAnnotate(critAnchor)}
                  >
                    <Icon icon={MessageSquare} size={14} />
                    {critAnnotCount > 0 && <span className="md-annot-count">{critAnnotCount}</span>}
                  </Button>
                  {!item.criterion.command && s.stage === "coding" && (
                    <AsyncButton
                      size="xs"
                      variant={item.state === "passed" ? "default" : "outline"}
                      type="button"
                      data-testid={`manual-check-${item.criterion.id}`}
                      disabled={busy || runLocked}
                      onAction={async () => {
                        if (guardRequirementRunLock(s.id)) return;
                        const nextChecked = item.state !== "passed";
                        const out = await runBusy(() =>
                          api.setManualCheck(s.id, {
                            criterionId: item.criterion.id,
                            checked: nextChecked,
                            expectedRevision: s.revision,
                          }),
                        );
                        if (out) {
                          await invalidateAllWorkbenchQueries();
                          showToastKey("spec.manualCheckSaved");
                        }
                      }}
                    >
                      <Icon icon={Check} size={14} />{" "}
                      {item.state === "passed"
                        ? t(language, "spec.manualVerified")
                        : t(language, "spec.manualMarkVerified")}
                    </AsyncButton>
                  )}
                  {item.criterion.command && s.stage !== "done" && s.stage !== "cancelled" && (
                    <AsyncButton
                      size="xs"
                      variant="outline"
                      type="button"
                      data-testid={`run-criterion-btn-${item.criterion.id}`}
                      disabled={busy || runLocked}
                      onAction={() =>
                        executeVerify(s.id, {
                          command: item.criterion.command!,
                          criterionIds: [item.criterion.id],
                        }).then((res) => {
                          if (res) {
                            showToastKey(
                              res.runs[0]?.passed ? "spec.verifiedPassed" : "spec.verifiedFailed",
                              { id: item.criterion.id },
                              !res.runs[0]?.passed,
                            );
                          }
                        })
                      }
                    >
                      <Icon icon={Play} size={14} /> {t(language, "spec.run")}
                    </AsyncButton>
                  )}
                </div>
              </div>
            );
          })
        )}
      </Card>

      <Card className="p-4 mb-3.5">
        <div className="card-head">
          <h3>
            {t(language, "spec.designTitle", {
              version: s.designVersion > 0 ? t(language, "spec.versionSuffix", { version: activeVer }) : "",
            })}
          </h3>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {d.designMarkdown.trim() && s.stage !== "cancelled" && !editingDesign && (
              <Button
                size="xs"
                variant="outline"
                type="button"
                data-testid="spawn-children-btn"
                disabled={runLocked}
                onClick={() =>
                  setModal({
                    kind: "spawn_children",
                    parentId: s.id,
                    items: buildSpawnDrafts(d),
                    track: "plan_first",
                  })
                }
              >
                <Icon icon={GitFork} size={14} /> {t(language, "spec.spawnBtn")}
              </Button>
            )}
            {historyVers.length > 1 && (
              <Button
                size="xs"
                variant="outline"
                type="button"
                data-action="toggle-design-diff"
                onClick={() => void toggleDesignDiff()}
              >
                {designComparePrev
                  ? <><Icon icon={X} size={14} /> {t(language, "spec.closeCompare")}</>
                  : <><Icon icon={FileDiff} size={14} /> {t(language, "spec.compare", { prev: activeVer - 1, curr: activeVer })}</>}
              </Button>
            )}
            {editingDesign ? (
              <>
                <Button
                  size="xs"
                  variant="outline"
                  type="button"
                  data-action="add-criterion"
                  onClick={() => cancelEditDesign()}
                >
                  <Icon icon={X} size={14} /> {t(language, "common.cancel")}
                </Button>
                <AsyncButton
                  size="xs"
                  type="button"
                  data-testid="save-design-btn"
                  disabled={busy || runLocked}
                  onAction={saveDesign}
                >
                  <Icon icon={Save} size={14} /> {t(language, "spec.saveDesign")}
                </AsyncButton>
              </>
            ) : (
              s.stage !== "done" &&
              s.stage !== "cancelled" && (
                <Button
                  size="xs"
                  variant="outline"
                  type="button"
                  data-testid="start-edit-design-btn"
                  disabled={runLocked}
                  onClick={() => {
                    setMoreMenuOpen(false);
                    startEditDesign(d.designMarkdown);
                  }}
                >
                  <Icon icon={Pencil} size={14} /> {t(language, "spec.editDesign")}
                </Button>
              )
            )}
          </div>
        </div>

        {editingDesign ? (
          <div data-testid="design-editor">
            <Textarea
              id="design-body-input"
              data-testid="design-body-input"
              className="min-h-[220px] font-mono text-[12.5px]"
              value={designDraftBody}
              onChange={(e) => setDesignDraftBody(e.target.value)}
            />
          </div>
        ) : designComparePrev && designCompareText ? (
          <div
            className="diff-code"
            dangerouslySetInnerHTML={{
              __html: renderSimpleLineDiff(designCompareText.prev, designCompareText.curr),
            }}
          />
        ) : d.designMarkdown.trim() ? (
          <MarkdownView
            markdown={d.designMarkdown}
            annotatable
            docLabel="design.md"
            annotationCounts={annotationCounts}
            onAnnotate={openAnnotate}
          />
        ) : (
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            {t(language, "spec.designEmpty")}
          </p>
        )}
      </Card>

      {d.subRequirements && d.subRequirements.length > 0 && (
        <Card className="p-4 mb-3.5" data-testid="sub-requirements-card">
          <div className="card-head">
            <h3>
              {t(language, "spec.subReqsTitle", {
                done: d.subRequirements.filter((c) => c.stage === "done").length,
                total: d.subRequirements.length,
              })}
            </h3>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {d.subRequirements.map((child) => {
              const meta = STAGE_META[child.stage];
              return (
                <Button
                  key={child.id}
                  type="button"
                  variant="ghost"
                  data-testid={`sub-req-link-${child.id}`}
                  className="justify-between text-left px-2 py-1.5"
                  onClick={() => void openRequirement(child.id)}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    <span className="req-id">{child.id}</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {child.title}
                    </span>
                  </span>
                  <Badge variant={mapTone(meta.tone)}>
                    <Icon icon={STAGE_ICONS[child.stage]} size={14} />
                    {meta.labels[language]}
                  </Badge>
                </Button>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}

function pluralScreenshots(language: "zh-CN" | "en", count: number): string {
  return count === 1 ? t(language, "shot.countOne", { count }) : t(language, "shot.countOther", { count });
}

const SCREENSHOT_PHASE_KEYS: Record<ScreenshotPhase, MessageKey> = {
  before: "shot.phase.before",
  after: "shot.phase.after",
  state: "shot.phase.state",
};

const SCREENSHOT_TRIGGER_KEYS: Record<ScreenshotBatch["trigger"], MessageKey> = {
  auto_submit: "shot.trigger.auto",
  manual: "shot.trigger.manual",
  agent_attach: "shot.trigger.agentAttach",
  auto_collect: "shot.trigger.autoCollect",
};

function screenshotBatchSource(batch: ScreenshotBatch): "scenario" | "matrix" {
  return batch.source === "scenario" ? "scenario" : "matrix";
}

function latestScenarioScreenshotBatch(
  batches: ScreenshotBatch[] | undefined,
  currentCodeSnapshotHash: string | null | undefined,
): ScreenshotBatch | null {
  const scenarios = (batches ?? []).filter(
    (batch) => screenshotBatchSource(batch) === "scenario" && batch.shots.length > 0,
  );
  const matching = currentCodeSnapshotHash
    ? scenarios.filter((batch) => batch.codeSnapshotHash === currentCodeSnapshotHash)
    : [];
  const pool = matching.length > 0 ? matching : scenarios;
  return pool.length > 0
    ? pool.reduce((latest, batch) => (batch.createdAt > latest.createdAt ? batch : latest))
    : null;
}

function screenshotPhaseBadge(language: "zh-CN" | "en", phase: ScreenshotShot["phase"]): string | null {
  return phase ? t(language, SCREENSHOT_PHASE_KEYS[phase]) : null;
}

const SCREENSHOT_REASON_KEYS: Record<ScreenshotSkipReasonCode, MessageKey> = {
  browser_missing: "shot.reason.browser_missing",
  chrome_path_missing: "shot.reason.chrome_path_missing",
  puppeteer_path_missing: "shot.reason.puppeteer_path_missing",
  server_unavailable: "shot.reason.server_unavailable",
  browser_launch_failed: "shot.reason.browser_launch_failed",
  no_shots: "shot.reason.no_shots",
};

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("无法读取截图文件"));
    reader.readAsDataURL(file);
  });
}

function ScreenshotEvidenceSection({ d, runLocked }: { d: RequirementDetail; runLocked: boolean }) {
  const language = useUiStore((s) => s.language);
  const showToastKey = useUiStore((s) => s.showToastKey);
  const showToastError = useUiStore((s) => s.showToastError);
  const [capturing, setCapturing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [lightbox, setLightbox] = useState<{ batchId: string; index: number } | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const isDone = d.state.stage === "done";
  const frozen = d.acceptanceSnapshot?.screenshots;
  const currentHash = d.validity.provenance.codeSnapshotHash;
  const batches = (frozen && frozen.length > 0 ? frozen : d.state.screenshotBatches ?? [])
    .slice()
    .sort((a, b) => {
      const sourceRank = (batch: ScreenshotBatch) => (screenshotBatchSource(batch) === "scenario" ? 0 : 1);
      const matchRank = (batch: ScreenshotBatch) => (currentHash && batch.codeSnapshotHash === currentHash ? 0 : 1);
      return sourceRank(a) - sourceRank(b) || matchRank(a) - matchRank(b) || b.createdAt - a.createdAt;
    });
  const hasScenario = batches.some(
    (batch) => screenshotBatchSource(batch) === "scenario" && batch.shots.length > 0,
  );
  const canCapture = d.state.stage === "coding";
  const activeBatch = lightbox ? batches.find((batch) => batch.id === lightbox.batchId) ?? null : null;
  const activeShot = activeBatch && lightbox ? activeBatch.shots[lightbox.index] ?? null : null;

  useEffect(() => {
    if (!lightbox || !activeBatch) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setLightbox(null);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        setLightbox((prev) =>
          prev ? { ...prev, index: (prev.index - 1 + activeBatch.shots.length) % activeBatch.shots.length } : prev,
        );
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setLightbox((prev) => (prev ? { ...prev, index: (prev.index + 1) % activeBatch.shots.length } : prev));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [lightbox, activeBatch]);

  const recapture = async () => {
    if (capturing) return;
    if (guardRequirementRunLock(d.state.id)) return;
    setCapturing(true);
    try {
      const res = await captureUiScreenshots(d.state.id);
      if (res) {
        const capture = res.screenshotCapture;
        if (capture.status === "captured") {
          showToastKey("shot.updated", { count: capture.batch?.shots.length ?? 0 });
        } else if (capture.status === "partial") {
          showToastKey("shot.partial", { count: capture.batch?.shots.length ?? 0 }, true);
        } else {
          // 历史记录保留工作台生成的原文；当前操作只显示按界面语言本地化的提示。
          const reasonKey = capture.reasonCode ? SCREENSHOT_REASON_KEYS[capture.reasonCode] : undefined;
          showToastKey(
            reasonKey ?? "shot.skippedReason",
            reasonKey ? (capture.reasonParams ?? undefined) : undefined,
            true,
          );
        }
      }
    } finally {
      setCapturing(false);
    }
  };

  const uploadScreenshots = async (fileList: FileList | null) => {
    const files = Array.from(fileList ?? []).filter(
      (file) => file.type === "image/png" || file.name.toLowerCase().endsWith(".png"),
    );
    if (files.length === 0) {
      showToastKey("shot.uploadEmpty", undefined, true);
      return;
    }
    if (uploading) return;
    if (guardRequirementRunLock(d.state.id)) return;
    setUploading(true);
    try {
      const shots = await Promise.all(
        files.slice(0, 12).map(async (file) => ({
          label: file.name.replace(/\.png$/i, "") || "screenshot",
          dataBase64: await fileToBase64(file),
        })),
      );
      const res = await uploadScenarioScreenshots(d.state.id, shots);
      if (res) {
        showToastKey("shot.uploaded", { count: res.screenshotCapture.batch?.shots.length ?? shots.length });
      }
    } catch (error) {
      showToastError(error);
    } finally {
      setUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
    }
  };

  return (
    <Card className="p-4 mb-3.5" data-testid="screenshot-section">
      <div className="card-head">
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <h3>{t(language, "shot.title")}</h3>
          {isDone && (
            <Badge variant="success">
              <Icon icon={Lock} size={14} /> {t(language, "shot.frozen")}
            </Badge>
          )}
        </div>
        {canCapture && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <input
              ref={uploadInputRef}
              type="file"
              accept="image/png,.png"
              multiple
              hidden
              data-testid="screenshot-upload-input"
              onChange={(event) => void uploadScreenshots(event.target.files)}
            />
            <Button
              size="xs"
              variant="outline"
              type="button"
              data-testid="screenshot-upload-btn"
              disabled={uploading || runLocked}
              onClick={() => uploadInputRef.current?.click()}
            >
              <Icon icon={Upload} size={14} /> {uploading ? t(language, "shot.uploading") : t(language, "shot.upload")}
            </Button>
            <AsyncButton
              size="xs"
              variant="outline"
              type="button"
              data-testid="screenshot-recapture"
              disabled={capturing || runLocked}
              title={t(language, "shot.matrixHint")}
              onAction={recapture}
            >
              <Icon icon={RefreshCw} size={14} />{" "}
              {capturing ? t(language, "shot.matrixCapturing") : t(language, "shot.matrixCapture")}
            </AsyncButton>
          </div>
        )}
      </div>

      {batches.length === 0 ? (
        <div className="space-y-1">
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            {isDone ? t(language, "shot.noneDone") : t(language, "shot.scenarioEmpty")}
          </p>
          {!isDone && (
            <p className="muted" style={{ fontSize: 12, margin: 0 }} data-testid="screenshot-upload-hint">
              {t(language, "shot.uploadHint")}
            </p>
          )}
        </div>
      ) : (
        <>
          {!hasScenario && !isDone && (
            <Alert variant="warning" className="mb-2 text-xs" data-testid="screenshot-scenario-missing">
              <Icon icon={AlertTriangle} size={14} />
              <AlertDescription className="text-foreground">
                {t(language, "shot.scenarioEmpty")}
              </AlertDescription>
            </Alert>
          )}
          {batches.map((batch) => {
            const fingerprintMatch = Boolean(currentHash && batch.codeSnapshotHash === currentHash);
            const source = screenshotBatchSource(batch);
            const statusMeta =
              batch.status === "captured"
                ? { label: t(language, "shot.status.captured"), tone: "success" as const }
                : batch.status === "partial"
                  ? { label: t(language, "shot.status.partial"), tone: "warning" as const }
                  : { label: t(language, "shot.status.skipped"), tone: "warning" as const };
            return (
              <div key={batch.id} className="screenshot-batch" data-testid={`screenshot-batch-${batch.id}`}>
                <div className="screenshot-batch-head">
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <Badge
                      variant={source === "scenario" ? "success" : "secondary"}
                      data-testid={`screenshot-source-badge-${batch.id}`}
                    >
                      {t(language, source === "scenario" ? "shot.source.scenario" : "shot.source.matrix")}
                    </Badge>
                    <Badge variant={statusMeta.tone}>
                      <Icon
                        icon={batch.status === "captured" ? CheckCircle2 : AlertTriangle}
                        size={14}
                      />{" "}
                      {statusMeta.label}
                    </Badge>
                    <span className="muted" style={{ fontSize: 12.5 }}>
                      {formatDateTime(batch.createdAt, language)} ·{" "}
                      {t(language, SCREENSHOT_TRIGGER_KEYS[batch.trigger])}{" "}
                      · {pluralScreenshots(language, batch.shots.length)}
                    </span>
                    <Badge variant={fingerprintMatch ? "success" : "warning"} data-testid="screenshot-fingerprint-badge">
                      <Icon icon={fingerprintMatch ? Check : RefreshCw} size={14} />{" "}
                      {fingerprintMatch ? t(language, "shot.match") : t(language, "shot.stale")}
                    </Badge>
                  </div>
                  <span className="muted" style={{ fontSize: 11.5 }}>
                    {batch.codeSnapshotHash.slice(0, 8)}
                  </span>
                </div>

                {source === "matrix" && (
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }} data-testid={`screenshot-matrix-note-${batch.id}`}>
                    {t(language, "shot.matrixNote")}
                  </div>
                )}

                {batch.skipReason && (
                  <Alert variant="warning" className="my-2 text-xs" data-testid="screenshot-skip-reason">
                    <Icon icon={AlertTriangle} size={14} />
                    <AlertDescription className="text-foreground">{batch.skipReason}</AlertDescription>
                  </Alert>
                )}

                {batch.shots.length > 0 && (
                  <div className="screenshot-grid">
                    {batch.shots.map((shot, index) => {
                      const phaseLabel = screenshotPhaseBadge(language, shot.phase);
                      return (
                        <button
                          key={shot.id}
                          type="button"
                          className="screenshot-thumb"
                          data-testid={`shot-${shot.id}`}
                          onClick={() => setLightbox({ batchId: batch.id, index })}
                        >
                          <img src={screenshotUrl(d.state.id, shot.id)} alt={shot.label} loading="lazy" />
                          <span style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                            {phaseLabel && (
                              <Badge
                                variant={shot.phase === "before" ? "secondary" : "success"}
                                size="sm"
                                data-testid={`screenshot-phase-${shot.id}`}
                              >
                                {phaseLabel}
                              </Badge>
                            )}
                            <span className="screenshot-thumb-label">{shot.label}</span>
                          </span>
                          {shot.description && (
                            <span
                              className="muted"
                              style={{ fontSize: 11 }}
                              data-testid={`screenshot-description-${shot.id}`}
                            >
                              {shot.description}
                            </span>
                          )}
                          <span className="muted" style={{ fontSize: 11 }}>
                            {shot.viewport} ·{" "}
                            {shot.theme === "dark" ? t(language, "shot.theme.dark") : t(language, "shot.theme.light")}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}

      {activeBatch && activeShot && lightbox && (
        <ModalShell wide hasExplicitTitle onClose={() => setLightbox(null)} testId="screenshot-lightbox">
          <DialogHeader>
            <DialogTitle className="text-base">{activeShot.label}</DialogTitle>
            <DialogDescription>
              {t(language, "shot.counter", {
                index: lightbox.index + 1,
                total: activeBatch.shots.length,
                viewport: activeShot.viewport,
                theme: activeShot.theme === "dark" ? t(language, "shot.theme.dark") : t(language, "shot.theme.light"),
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex items-center gap-2.5">
              <Button
                size="xs"
                variant="outline"
                type="button"
                data-testid="screenshot-lightbox-prev"
                onClick={() =>
                  setLightbox((prev) =>
                    prev
                      ? { ...prev, index: (prev.index - 1 + activeBatch.shots.length) % activeBatch.shots.length }
                      : prev,
                  )
                }
              >
                <Icon icon={ChevronLeft} size={14} /> {t(language, "shot.prev")}
              </Button>
              <img
                className="screenshot-lightbox-image"
                data-testid="screenshot-lightbox-image"
                src={screenshotUrl(d.state.id, activeShot.id)}
                alt={activeShot.label}
              />
              <Button
                size="xs"
                variant="outline"
                type="button"
                data-testid="screenshot-lightbox-next"
                onClick={() =>
                  setLightbox((prev) =>
                    prev ? { ...prev, index: (prev.index + 1) % activeBatch.shots.length } : prev,
                  )
                }
              >
                {t(language, "shot.next")} <Icon icon={ChevronRight} size={14} />
              </Button>
            </div>
            <div className="mt-3 space-y-1.5 text-xs" data-testid="screenshot-lightbox-meta">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-muted-foreground">{t(language, "shot.sourceLabel")}</span>
                <Badge
                  variant={screenshotBatchSource(activeBatch) === "scenario" ? "success" : "secondary"}
                  size="sm"
                  data-testid="screenshot-lightbox-source"
                >
                  {t(
                    language,
                    screenshotBatchSource(activeBatch) === "scenario"
                      ? "shot.source.scenario"
                      : "shot.source.matrix",
                  )}
                </Badge>
                {activeShot.phase && (
                  <>
                    <span className="text-muted-foreground">{t(language, "shot.phaseLabel")}</span>
                    <Badge variant={activeShot.phase === "before" ? "secondary" : "success"} size="sm">
                      {t(language, SCREENSHOT_PHASE_KEYS[activeShot.phase])}
                    </Badge>
                  </>
                )}
              </div>
              <div data-testid="screenshot-lightbox-description">
                <span className="text-muted-foreground">{t(language, "shot.descriptionLabelWithColon")}</span>
                {activeShot.description || t(language, "shot.noDescription")}
              </div>
              {activeShot.criterionIds && activeShot.criterionIds.length > 0 && (
                <div data-testid="screenshot-lightbox-criteria">
                  <span className="text-muted-foreground">{t(language, "shot.criteriaLabelWithColon")}</span>
                  {activeShot.criterionIds.join(", ")}
                </div>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" type="button" onClick={() => setLightbox(null)}>
              <Icon icon={X} size={14} /> {t(language, "common.closeEsc")}
            </Button>
          </DialogFooter>
        </ModalShell>
      )}
    </Card>
  );
}

function DiffCode({ lines }: { lines: string[] }) {
  const html = useMemo(() => renderDiffLinesHtml(lines), [lines]);
  return <div className="diff-code" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function DiffViewerPanel({ d, inDrawer = false }: { d: RequirementDetail; inDrawer?: boolean }) {
  const language = useUiStore((s) => s.language);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const storeSelectedDiffFile = useUiStore((s) => s.selectedDiffFile);
  const storeDiffViewMode = useUiStore((s) => s.diffViewMode);
  const storeDiffFileQuery = useUiStore((s) => s.diffFileQuery);
  const storeSetSelectedDiffFile = useUiStore((s) => s.setSelectedDiffFile);
  const storeSetDiffViewMode = useUiStore((s) => s.setDiffViewMode);
  const storeSetDiffFileQuery = useUiStore((s) => s.setDiffFileQuery);
  const setDrawerOpen = useUiStore((s) => s.setDrawerOpen);
  const setDrawerTab = useUiStore((s) => s.setDrawerTab);
  const setWorkspaceTab = useUiStore((s) => s.setWorkspaceTab);
  const showToastKey = useUiStore((s) => s.showToastKey);

  const [drawerSelectedFile, setDrawerSelectedFile] = useState<string | null>(null);
  const [drawerViewMode, setDrawerViewMode] = useState<DiffViewMode>("split");
  const [drawerFileQuery, setDrawerFileQuery] = useState("");

  const { state: s, validity } = d;
  useEffect(() => {
    if (inDrawer) {
      setDrawerSelectedFile(null);
      setDrawerFileQuery("");
    }
  }, [inDrawer, s.id]);

  const selectedDiffFile = inDrawer ? drawerSelectedFile : storeSelectedDiffFile;
  const setSelectedDiffFile = inDrawer ? setDrawerSelectedFile : storeSetSelectedDiffFile;
  const diffViewMode = inDrawer ? drawerViewMode : storeDiffViewMode;
  const setDiffViewMode = inDrawer ? setDrawerViewMode : storeSetDiffViewMode;
  const diffFileQuery = inDrawer ? drawerFileQuery : storeDiffFileQuery;
  const setDiffFileQuery = inDrawer ? setDrawerFileQuery : storeSetDiffFileQuery;
  const tid = (base: string) => (inDrawer ? `drawer-${base}` : base);

  const isDone = s.stage === "done";
  const { data: diffRes } = useDiffQuery(activeProjectId, s.id, true, false);
  const diffObs = diffRes?.observation ?? diffRes?.changes ?? null;
  const evidenceSummary = describeEvidenceContext(validity, diffRes ?? null, language);

  const rawDiffText = diffObs?.diff ?? "";
  const parsedFiles = useMemo(
    () => (rawDiffText ? parseUnifiedDiff(rawDiffText) : []),
    [rawDiffText],
  );
  const rawDiffHtml = useMemo(
    () => (rawDiffText && parsedFiles.length === 0 ? renderDiffLinesHtml(rawDiffText.split("\n")) : ""),
    [rawDiffText, parsedFiles.length],
  );
  const { totalAdditions, totalDeletions } = useMemo(
    () => ({
      totalAdditions: parsedFiles.reduce((acc, f) => acc + f.additions, 0),
      totalDeletions: parsedFiles.reduce((acc, f) => acc + f.deletions, 0),
    }),
    [parsedFiles],
  );
  const normalizedQuery = diffFileQuery.trim().toLowerCase();
  const visibleFiles = useMemo(
    () => (normalizedQuery ? parsedFiles.filter((f) => f.path.toLowerCase().includes(normalizedQuery)) : parsedFiles),
    [parsedFiles, normalizedQuery],
  );
  const activeDiffFile =
    visibleFiles.find((f) => f.path === selectedDiffFile) ?? visibleFiles[0] ?? null;

  const effectiveMode = inDrawer && diffViewMode === "split" && parsedFiles.length <= 1 ? "unified" : diffViewMode;

  return (
    <>
      <Card className={`diff-panel-card p-4 mb-3.5 ${inDrawer ? "in-drawer" : ""}`} data-testid={inDrawer ? "drawer-diff-panel" : "diff-viewer-panel"}>
        <div className="card-head">
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <h3>{isDone ? t(language, "changes.diffTitleDone") : t(language, "changes.diffTitleLive")}</h3>
            {isDone && (
              <Badge
                variant={evidenceSummary.tone === "success" ? "success" : "warning"}
                data-testid={tid("diff-context-badge")}
              >
                <Icon
                  icon={evidenceSummary.tone === "success" ? ShieldCheck : AlertTriangle}
                  size={14}
                />{" "}
                {evidenceSummary.title}
              </Badge>
            )}
            {parsedFiles.length > 0 && (
              <Badge variant="info" data-testid={tid("diff-stats-badge")}>
                {t(language, "changes.statsSummary", {
                  files: parsedFiles.length,
                  add: totalAdditions,
                  del: totalDeletions,
                })}
              </Badge>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {parsedFiles.length > 0 && (
              <SegmentedControl
                size="sm"
                className="h-8 sm:h-7 [&_[data-slot=segmented-control-item]]:h-7 sm:[&_[data-slot=segmented-control-item]]:h-6 [&_[data-slot=segmented-control-item]]:w-7 [&_[data-slot=segmented-control-item]]:px-0"
                data-testid={tid("diff-view-mode-toggle")}
                render={
                  <RadioGroupPrimitive
                    className="flex items-center"
                    value={effectiveMode}
                    onValueChange={(next) => next && setDiffViewMode(next as DiffViewMode)}
                  />
                }
              >
                <SegmentedControlItem
                  render={<RadioPrimitive.Root value="split" />}
                  aria-label={t(language, "changes.viewMode.split")}
                  title={t(language, "changes.viewMode.split")}
                >
                  <Icon icon={Columns2} size={14} />
                </SegmentedControlItem>
                <SegmentedControlItem
                  render={<RadioPrimitive.Root value="unified" />}
                  aria-label={t(language, "changes.viewMode.unified")}
                  title={t(language, "changes.viewMode.unified")}
                >
                  <Icon icon={FileText} size={14} />
                </SegmentedControlItem>
              </SegmentedControl>
            )}
            <Button
              size="sm"
              variant="outline"
              type="button"
              data-testid={tid("dock-diff-to-drawer-btn")}
              onClick={() => {
                if (inDrawer) {
                  setWorkspaceTab("diff");
                } else {
                  setDrawerOpen(true);
                  setDrawerTab("diff");
                }
              }}
            >
              <Icon icon={PanelRightOpen} size={14} />{" "}
              {inDrawer ? t(language, "changes.openInMain") : t(language, "changes.dockToDrawer")}
            </Button>
            {!isDone && (
              <Button
                size="icon-sm"
                variant="outline"
                type="button"
                aria-label={t(language, "changes.refreshDiff")}
                title={t(language, "changes.refreshDiff")}
                data-testid={tid("refresh-diff-btn")}
                onClick={() => {
                  void queryClient.invalidateQueries({ queryKey: queryKeys.diff(activeProjectId, s.id, false) });
                  showToastKey("changes.refreshedDiff");
                }}
              >
                <Icon icon={RefreshCw} size={14} />
              </Button>
            )}
          </div>
        </div>
        {isDone && (
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }} data-testid={tid("diff-provenance-meta")}>
            {evidenceSummary.acceptedAtText && (
              <span>{t(language, "spec.evidenceTimeLabel", { time: evidenceSummary.acceptedAtText })} · </span>
            )}
            <span>{evidenceSummary.provenanceText}</span>
            {evidenceSummary.scopeNote && <div>{evidenceSummary.scopeNote}</div>}
          </div>
        )}
        {diffRes?.testTamperingSignals && diffRes.testTamperingSignals.length > 0 && (
          <Alert variant="warning" className="mb-2.5 text-xs" data-testid={tid("test-tampering-alert")}>
            <Icon icon={AlertTriangle} size={14} />
            <AlertTitle>{t(language, "ws.tampering.title")}</AlertTitle>
            <AlertDescription className="text-foreground">
              <div>{t(language, "ws.tampering.desc")}</div>
              <ul className="mt-1 list-disc pl-4 space-y-0.5">
                {diffRes.testTamperingSignals.map((sig, i) => (
                  <li key={i}>{sig}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        {evidenceSummary.truncationFlags.length > 0 && (
          <Alert variant="warning" className="mb-2.5 text-xs" data-testid={tid("diff-truncation-notice")}>
            <Icon icon={AlertTriangle} size={14} />
            <AlertDescription className="text-foreground">
              {evidenceSummary.truncationFlags.join(t(language, "changes.truncJoin"))}
            </AlertDescription>
          </Alert>
        )}
        {!diffRes ? (
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            {t(language, "changes.loading")}
          </p>
        ) : diffRes.status === "unavailable" || !diffObs ? (
          <Alert variant="warning" className="text-xs" data-testid={tid("diff-unavailable-notice")}>
            <Icon icon={AlertTriangle} size={14} />
            <AlertDescription className="text-foreground">
              <strong>{t(language, "changes.unavailable")}</strong>：
              {translateRef(
                language,
                diffRes.reasonKey,
                evidenceSummary.unavailableReason ?? diffRes.reason ?? "",
                diffRes.reasonParams,
              ) || t(language, "changes.cannotLoad")}
            </AlertDescription>
          </Alert>
        ) : !diffObs.isGitRepo ? (
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            {t(language, "changes.notGit")}
          </p>
        ) : diffRes.status === "empty" || diffObs.files.length === 0 ? (
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            {isDone ? t(language, "changes.emptyDone") : t(language, "changes.emptyLive")}
          </p>
        ) : effectiveMode === "unified" ? (
          <div className="diff-unified-list" data-testid={tid("diff-unified-list")}>
            {parsedFiles.length > 3 && (
              <InputGroup className="mb-1">
                <InputGroupAddon>
                  <Icon icon={Search} size={14} />
                </InputGroupAddon>
                <InputGroupInput
                  size="sm"
                  data-testid={tid("diff-file-search")}
                  type="search"
                  value={diffFileQuery}
                  placeholder={t(language, "changes.fileSearchPlaceholder")}
                  onChange={(e) => setDiffFileQuery(e.target.value)}
                />
              </InputGroup>
            )}
            {parsedFiles.length === 0 ? (
              rawDiffHtml ? (
                <div
                  className="diff-code"
                  dangerouslySetInnerHTML={{ __html: rawDiffHtml }}
                />
              ) : (
                <div className="diff-files">
                  {diffObs.files.map((f) => (
                    <div key={f.path} className="diff-file-btn" style={{ cursor: "default" }}>
                      <span>{f.path}</span>
                    </div>
                  ))}
                </div>
              )
            ) : visibleFiles.length === 0 ? (
              <Alert data-testid={tid("diff-empty-filter")}>
                <AlertDescription className="flex w-full items-center justify-between gap-2 text-muted-foreground">
                  <span>{t(language, "changes.noFilterMatch", { query: diffFileQuery })}</span>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    data-testid={tid("diff-clear-filter-btn")}
                    onClick={() => setDiffFileQuery("")}
                  >
                    <Icon icon={X} size={14} /> {t(language, "changes.clearFilter")}
                  </Button>
                </AlertDescription>
              </Alert>
            ) : (
              visibleFiles.map((f, idx) => (
                <div key={`${f.path}-${idx}`} className="diff-unified-file">
                  <div className="diff-unified-head">
                    <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, fontWeight: 600 }}>{f.path}</span>
                    <span className="muted xs">+{f.additions}/-{f.deletions}</span>
                  </div>
                  <DiffCode lines={f.lines} />
                </div>
              ))
            )}
          </div>
        ) : (
          <div className={`diff-split ${inDrawer ? "in-drawer" : ""}`}>
            <div className="diff-files">
              {parsedFiles.length > 3 && (
                <div className="diff-file-search-wrap p-1 border-b">
                  <InputGroup>
                    <InputGroupAddon>
                      <Icon icon={Search} size={14} />
                    </InputGroupAddon>
                    <InputGroupInput
                      size="sm"
                      data-testid={tid("diff-file-search")}
                      type="search"
                      value={diffFileQuery}
                      placeholder={t(language, "changes.fileSearchPlaceholder")}
                      onChange={(e) => setDiffFileQuery(e.target.value)}
                    />
                  </InputGroup>
                </div>
              )}
              {visibleFiles.length === 0 && parsedFiles.length > 0 ? (
                <div className="muted xs" style={{ padding: "10px" }}>
                  {t(language, "changes.noFilterMatch", { query: diffFileQuery })}
                </div>
              ) : (
                visibleFiles.map((f, idx) => (
                  <button
                    key={`${f.path}-${idx}`}
                    className={`diff-file-btn ${activeDiffFile?.path === f.path ? "active" : ""}`}
                    type="button"
                    onClick={() => setSelectedDiffFile(f.path)}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.path}</span>
                    <span className="muted" style={{ fontSize: 11 }}>
                      +{f.additions}/-{f.deletions}
                    </span>
                  </button>
                ))
              )}
            </div>
            {parsedFiles.length > 0 && visibleFiles.length === 0 ? (
              <Alert className="self-start" data-testid={tid("diff-empty-filter")}>
                <AlertDescription className="flex w-full items-center justify-between gap-2 text-muted-foreground">
                  <span>{t(language, "changes.noFilterMatch", { query: diffFileQuery })}</span>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    data-testid={tid("diff-clear-filter-btn")}
                    onClick={() => setDiffFileQuery("")}
                  >
                    <Icon icon={X} size={14} /> {t(language, "changes.clearFilter")}
                  </Button>
                </AlertDescription>
              </Alert>
            ) : activeDiffFile ? (
              <DiffCode lines={activeDiffFile.lines} />
            ) : (
              <div className="diff-code" dangerouslySetInnerHTML={{ __html: rawDiffHtml }} />
            )}
          </div>
        )}
      </Card>
    </>
  );
}

function ChangesVerifyTab({
  d,
  runLocked,
  hideManualChecks = false,
}: {
  d: RequirementDetail;
  runLocked: boolean;
  hideManualChecks?: boolean;
}) {
  const language = useUiStore((s) => s.language);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const busy = useUiStore((s) => s.busy);
  const expandedLogs = useUiStore((s) => s.expandedLogs);
  const showToastKey = useUiStore((s) => s.showToastKey);
  const setDrawerOpen = useUiStore((s) => s.setDrawerOpen);
  const setDrawerTab = useUiStore((s) => s.setDrawerTab);

  const [manualCmd, setManualCmd] = useState("");
  const [manualCriteria, setManualCriteria] = useState("");

  const setWorkspaceTab = useUiStore((s) => s.setWorkspaceTab);
  const { state: s, validity } = d;
  const review = s.reviewReport;
  const revValid = validity.reviewValidity;
  const isDone = s.stage === "done";
  const isTerminal = isDone || s.stage === "cancelled";
  const { data: diffRes } = useDiffQuery(activeProjectId, s.id, true, false);
  const diffObs = diffRes?.observation ?? diffRes?.changes ?? null;
  const evidenceSummary = describeEvidenceContext(validity, diffRes ?? null, language);

  const grouped = new Map<string, { command: string; latest: (typeof validity.verifications)[number] }>();
  for (const ev of validity.verifications) {
    grouped.set(ev.record.command, { command: ev.record.command, latest: ev });
  }
  const evCards = Array.from(grouped.values()).reverse();

  const runManualVerify = async () => {
    const command = manualCmd.trim();
    if (!command) {
      showToastKey("changes.enterCommand", undefined, true);
      return;
    }
    const cids = manualCriteria
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const res = await executeVerify(s.id, { command, criterionIds: cids });
    if (res) {
      showToastKey(res.runs[0]?.passed ? "changes.verifyPassed" : "changes.verifyFailed", undefined, !res.runs[0]?.passed);
    }
  };

  return (
    <>
      {review && !isDone && (review.verdict !== "pass" || revValid.effectiveState === "stale") && (
        <Alert
          variant={revValid.effectiveState === "stale" ? "warning" : VERDICT_META[review.verdict].tone === "danger" ? "error" : VERDICT_META[review.verdict].tone === "success" ? "success" : "warning"}
          data-testid="changes-review-callout"
          className="mb-3.5"
        >
          <Icon icon={AlertTriangle} size={14} />
          <AlertDescription className="flex w-full flex-wrap items-center justify-between gap-2.5 text-foreground">
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 3 }}>
                <strong>
                  {revValid.effectiveState === "stale"
                    ? t(language, "review.calloutStale")
                    : t(language, "review.calloutWithVerdict", {
                        verdict: VERDICT_META[review.verdict].labels[language],
                      })}
                </strong>
                <span className="xs muted">
                  {review.reviewerHarness}/{review.reviewerModel}
                </span>
              </div>
              <div className="xs">{review.summary}</div>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {revValid.effectiveState === "current" && review.verdict !== "pass" && (
                <AsyncButton
                  size="xs"
                  type="button"
                  disabled={busy || runLocked}
                  onAction={() => dispatchFixFromReview(d)}
                >
                  <Icon icon={Wrench} size={14} /> {t(language, "core.action.fixPerReview")}
                </AsyncButton>
              )}
              <Button
                size="xs"
                variant="outline"
                type="button"
                disabled={busy}
                onClick={() => setWorkspaceTab("spec")}
              >
                <Icon icon={FileText} size={14} /> {t(language, "review.viewFull")}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      <Card className="p-4 mb-3.5">
        <div className="card-head">
          <h3>{t(language, "changes.evidenceTitle")}</h3>
          {s.criteria.some((c) => c.command) && s.stage !== "done" && s.stage !== "cancelled" && (
            <AsyncButton
              size="xs"
              type="button"
              data-testid="run-all-verifications-btn"
              disabled={busy || runLocked}
              onAction={() => handleBannerAction(d, "run_all_verifications")}
            >
              <Icon icon={Play} size={14} /> {t(language, "changes.runAll")}
            </AsyncButton>
          )}
        </div>

        {evCards.length === 0 ? (
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            {t(language, "changes.noRuns")}
          </p>
        ) : (
          evCards.map(({ command, latest }) => {
            const meta = EVIDENCE_META[latest.effectiveState];
            const log = expandedLogs[latest.record.id];
            return (
              <div key={latest.record.id} className="evidence-card" data-testid={`ev-${latest.record.id}`}>
                <div className="evidence-head">
                  <div className="evidence-info">
                    <Badge variant={mapTone(meta.tone)}>
                      <Icon icon={EVIDENCE_ICONS[latest.effectiveState]} size={14} />{" "}
                      {meta.labels[language]}
                    </Badge>
                    <code className="evidence-command">{command}</code>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {latest.record.durationMs}ms ·{" "}
                      {t(language, "changes.criteriaLinked", {
                        ids: latest.record.criterionIds.join(", ") || t(language, "changes.criteriaNone"),
                      })}
                    </span>
                  </div>
                  <div className="evidence-actions">
                    <Button
                      size="xs"
                      variant="outline"
                      type="button"
                      data-action="toggle-log"
                      onClick={() => void toggleVerificationLog(s.id, latest.record.id)}
                    >
                      {log !== undefined ? (
                        <><Icon icon={EyeOff} size={14} /> {t(language, "changes.hideLog")}</>
                      ) : (
                        <><Icon icon={Eye} size={14} /> {t(language, "changes.viewOutput")}</>
                      )}
                    </Button>
                    {!isTerminal && (
                      <AsyncButton
                        size="xs"
                        variant="outline"
                        type="button"
                        data-testid={`evidence-rerun-btn-${latest.record.id}`}
                        disabled={busy || runLocked}
                        onAction={() =>
                          executeVerify(s.id, { command, criterionIds: latest.record.criterionIds }).then((res) => {
                            if (res) {
                              showToastKey(
                                res.runs[0]?.passed ? "changes.verifyPassed" : "changes.verifyFailedShort",
                                undefined,
                                !res.runs[0]?.passed,
                              );
                            }
                          })
                        }
                      >
                        <Icon icon={RefreshCw} size={14} /> {t(language, "changes.rerun")}
                      </AsyncButton>
                    )}
                  </div>
                </div>
                {(latest.staleReason || latest.staleReasonKey) && (
                  <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                    {translateRef(language, latest.staleReasonKey, latest.staleReason ?? "", latest.staleReasonParams)}
                  </div>
                )}
                {log !== undefined && <pre className="evidence-log">{log || t(language, "changes.noOutput")}</pre>}
              </div>
            );
          })
        )}

        {!isTerminal && (
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <Input
              className="flex-[2] min-w-[180px]"
              id="manual-verify-cmd"
              placeholder={t(language, "changes.manualCmdPlaceholder")}
              value={manualCmd}
              onChange={(e) => setManualCmd(e.target.value)}
            />
            <Input
              className="flex-1 min-w-[120px]"
              id="manual-verify-criteria"
              placeholder={t(language, "changes.manualCriteriaPlaceholder")}
              value={manualCriteria}
              onChange={(e) => setManualCriteria(e.target.value)}
            />
            <AsyncButton
              variant="outline"
              type="button"
              data-testid="manual-verify-btn"
              disabled={busy || runLocked}
              onAction={runManualVerify}
            >
              <Icon icon={Play} size={14} /> {t(language, "changes.runVerify")}
            </AsyncButton>
          </div>
        )}
      </Card>

      {/* REQ-028 F-4: when the acceptance overview is pinned above, its embedded
          manual checklist is authoritative; avoid rendering a duplicate list here. */}
      {!hideManualChecks && (
        <ManualChecksChecklistCard d={d} runLocked={runLocked} testId="changes-manual-checks-card" />
      )}

      <ScreenshotEvidenceSection d={d} runLocked={runLocked} />

      <Card className="p-4 mb-3.5" data-testid="verify-diff-shortcut-card">
        <div className="card-head" style={{ marginBottom: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <h3>{isDone ? t(language, "changes.diffTitleDone") : t(language, "changes.diffTitleLive")}</h3>
            {isDone && (
              <Badge variant={evidenceSummary.tone === "success" ? "success" : "warning"}>
                <Icon icon={evidenceSummary.tone === "success" ? ShieldCheck : AlertTriangle} size={14} />{" "}
                {evidenceSummary.title}
              </Badge>
            )}
            {diffObs && diffObs.files.length > 0 && (
              <Badge variant="info">{diffObs.files.length}</Badge>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Button
              size="xs"
              type="button"
              data-testid="open-diff-tab-btn"
              onClick={() => setWorkspaceTab("diff")}
            >
              <Icon icon={FileDiff} size={14} /> {t(language, "changes.openDiffTab")}
            </Button>
            <Button
              size="xs"
              variant="outline"
              type="button"
              data-testid="verify-dock-diff-btn"
              onClick={() => {
                setDrawerOpen(true);
                setDrawerTab("diff");
              }}
            >
              <Icon icon={PanelRightOpen} size={14} /> {t(language, "changes.dockToDrawer")}
            </Button>
          </div>
        </div>
      </Card>
    </>
  );
}

import { ExecutionAuditTab, TimelineRunsTab } from "./ExecutionAuditTab.tsx";
export { ExecutionAuditTab, TimelineRunsTab };

export function WorkspaceView() {
  const language = useUiStore((s) => s.language);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const selectedId = useUiStore((s) => s.selectedId);
  const workspaceTab = useUiStore((s) => s.workspaceTab);
  const busy = useUiStore((s) => s.busy);
  const drawerOpen = useUiStore((s) => s.drawerOpen);
  const setDrawerOpen = useUiStore((s) => s.setDrawerOpen);
  const moreMenuOpen = useUiStore((s) => s.moreMenuOpen);
  const moreMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const moreMenuAnchorRef = useRef<HTMLSpanElement | null>(null);
  const setWorkspaceTab = useUiStore((s) => s.setWorkspaceTab);
  const setMoreMenuOpen = useUiStore((s) => s.setMoreMenuOpen);
  const setModal = useUiStore((s) => s.setModal);
  const showToast = useUiStore((s) => s.showToast);
  const showToastKey = useUiStore((s) => s.showToastKey);

  const startEditSpec = useDraftStore((s) => s.startEditSpec);
  const startEditDesign = useDraftStore((s) => s.startEditDesign);
  const activeRuns = useStreamStore((s) => s.activeRuns);

  const { data: hub } = useHubStateQuery();
  const { data: project } = useProjectQuery(activeProjectId);
  const {
    data: reqData,
    isError: reqIsError,
    error: reqError,
    refetch: refetchReq,
  } = useRequirementQuery(activeProjectId, selectedId);
  const isDoneStage = reqData?.detail?.state.stage === "done";
  const { data: deliveryPreview } = useDeliveryQuery(activeProjectId, selectedId, Boolean(isDoneStage));
  const [approval, setApproval] = useState<{
    label: string;
    run: (resetSandbox: boolean) => Promise<void>;
  } | null>(null);
  const [actionDetailsOpen, setActionDetailsOpen] = useState(false);

  useEffect(() => {
    setApproval(null);
    setActionDetailsOpen(false);
  }, [activeProjectId, selectedId, reqData?.detail?.state.stage]);

  const d = reqData?.detail ?? null;
  if (!d) {
    const showLoadError = Boolean(reqIsError && !isRequirementNotFoundError(reqError));
    return (
      <WorkspaceLoadingState
        selectedId={selectedId}
        language={language}
        isError={showLoadError}
        errorMessage={showLoadError ? describeClientError(language, reqError) : undefined}
        onRetry={showLoadError ? () => refetchReq() : undefined}
      />
    );
  }

  const { state: s, validity } = d;
  const stageMeta = STAGE_META[s.stage];
  const { banner } = validity;
  const tier = s.tier ?? "standard";
  const hasFailedVerify = validity.coverage.items.some((item) => item.state === "failed");
  const derivedPill =
    s.stage === "planning" && s.designHash
      ? { label: t(language, "ws.derived.awaitingApproval"), tone: "warning" as const }
      : s.stage === "coding" && hasFailedVerify
        ? { label: t(language, "ws.derived.verifyFailed"), tone: "error" as const }
        : s.stage === "coding" && validity.manualCheckPending
          ? { label: t(language, "ws.derived.manualCheckPending"), tone: "warning" as const }
          : s.stage === "coding" && validity.acceptanceGate.ok
            ? { label: t(language, "ws.derived.readyAccept"), tone: "success" as const }
            : null;
  const showAcceptancePanel =
    s.stage === "coding" &&
    (validity.acceptanceGate.ok ||
      Boolean(validity.baselineOnlyWarning && validity.coverage.requiredPassed > 0) ||
      Boolean(validity.manualCheckPending));

  const isGiteeProject =
    project?.remoteProvider === "gitee" ||
    Boolean(project?.project?.gitee) ||
    s.github?.provider === "gitee";
  const prPlatformLabel = isGiteeProject ? "Gitee" : "GitHub";

  const openDeliverModal = (preferPr?: boolean, explicitMode?: "local" | "pr" | "local_merge") => {
    if (guardRequirementRunLock(s.id)) return;
    const candidates = deliveryPreview?.candidates ?? [];
    const matched = candidates.filter((c) => c.inAcceptedSnapshot).map((c) => c.path);
    const defaultSelected = matched.length > 0 ? matched : candidates.map((c) => c.path);
    const usePr =
      preferPr ?? Boolean((reqData?.sandbox || !deliveryPreview?.canCommit) && deliveryPreview?.canCreatePr);
    const deliveryMode =
      explicitMode ?? (reqData?.sandbox ? (usePr ? "pr" : "local_merge") : usePr ? "pr" : "local");
    setModal({
      kind: "deliver",
      commitMessage: deliveryPreview?.suggestedMessage ?? `feat(${s.id.toLowerCase()}): ${s.title}`,
      selectedFiles: defaultSelected,
      note: "",
      createPr: deliveryMode === "pr",
      deliveryMode,
      branchName: deliveryPreview?.suggestedBranch ?? `feat/${s.id.toLowerCase()}`,
      baseBranch: deliveryPreview?.baseBranch ?? (isGiteeProject ? "master" : "main"),
      prTitle: deliveryPreview?.suggestedPrTitle ?? `${s.id}: ${s.title}`,
    });
  };

  const syncPrStatus = async () => {
    if (guardRequirementRunLock(s.id)) return;
    const res = await runBusy(() => api.syncRequirementPr(s.id));
    if (res) {
      await invalidateAllWorkbenchQueries();
      if (res.pr.state === "merged") {
        if (!res.cleanedSandbox) {
          showToastKey("toast.prMerged", { num: res.pr.number });
        } else if (res.mainUpdated) {
          showToastKey("toast.prMergedMain", { num: res.pr.number });
        } else if (res.mainSyncReason) {
          showToastKey("toast.prMergedReason", {
            num: res.pr.number,
            reason: resolveWarningParam(res.mainSyncReason, res.mainSyncReasonRef),
          });
        } else {
          showToastKey("toast.prMergedClean", { num: res.pr.number });
        }
      } else {
        showToastKey("toast.prStatus", { num: res.pr.number, state: prStateRef(res.pr.state) });
      }
      notifyCascadeSyncResults(res.cascadeResults);
    }
  };

  const harnesses = hub?.harnesses ?? [];
  const modelOptions = collectModelOptions(harnesses);
  const defaultAct = defaultActionForRequirement(d);
  const runScope = {
    projectId: activeProjectId ?? hub?.activeProjectId ?? null,
    projectRoot: project?.root ?? null,
    projects: hub?.projects ?? [],
  };
  const activeRun = findLockingRequirementRun(Object.values(activeRuns), s.id, runScope) ?? null;
  const activeAskRun = findActiveAskRun(Object.values(activeRuns), s.id, runScope) ?? null;
  const pendingAnnotationsCount = getPendingRefineAnnotations(s.discussions).length;
  const runningThis = Boolean(activeRun);
  const canRunModel = s.stage !== "done" && s.stage !== "cancelled" && modelOptions.length > 0;
  const canReview = modelOptions.length > 0 && s.stage === "coding";

  const canResetSandbox = s.stage === "planning" && Boolean(s.designHash) && !s.lastFeedback &&
    Boolean(reqData?.sandbox) && Boolean(s.revisedFromCoding || (reqData?.sandboxDrift?.aheadCount ?? 0) > 0);
  const dirtyBaseline = s.stage === "planning" && Boolean(s.designHash) && Boolean(project?.git?.isGitRepo && project.git.dirty);
  const confirmApproval: ConfirmApproval = (label, run) => {
    if (canResetSandbox || dirtyBaseline) setApproval({ label, run });
    else return run(false);
  };

  const headline = translateRef(language, banner.headlineKey, banner.headline, banner.headlineParams);
  const pairedAction = banner.secondaryActions.find(({ id }) =>
    id === "approve_only" || id === "authorize_fast_track" || id === "dispatch_implement" || id === "revise_plan" ||
    id === "reopen" || id === "run_all_verifications" || id === "dispatch_fix" ||
    (id === "accept" && banner.primaryAction?.id !== "dispatch_fix_review") ||
    (id === "request_changes" && (banner.primaryAction?.id === "accept" || banner.primaryAction?.id === "dispatch_fix_review")),
  );
  const otherActions = banner.secondaryActions.filter((action) => action !== pairedAction);
  const recentRun = s.agentRuns?.at(-1);
  const runResult = recentRun && recentRun.status !== "running" && recentRun.action !== "ask"
    ? t(language, "ws.lastRun", { status: formatAgentStatusLabel(language, recentRun.status) })
    : undefined;

  const renderBannerAction = (action: BannerAction, variant: "default" | "outline", inDetails = false) => {
    const label = translateRef(language, action.labelKey, action.label, action.labelParams);
    return (
      <AsyncButton
        key={`${s.id}:${action.id}`}
        size="sm"
        variant={variant}
        type="button"
        data-testid={`action-${action.id}`}
        disabled={busy || runningThis || Boolean(action.disabledReason)}
        title={action.disabledReason ?? label}
        onAction={() => {
          const run = (resetSandbox: boolean) => handleBannerAction(d, action.id, { resetSandbox });
          if (action.id === "focus_manual_checks") {
            if (inDetails) setActionDetailsOpen(false);
            // REQ-028 F-3: both spec and changes already render the checklist, so stay put
            // there; only switch back to spec from unrelated tabs.
            if (workspaceTab !== "spec" && workspaceTab !== "changes") setWorkspaceTab("spec");
            if (typeof window !== "undefined") {
              window.setTimeout(() => {
                const target = document.querySelector('[data-testid="acceptance-manual-checks-card"]');
                if (!target) return;
                target.scrollIntoView({ behavior: "smooth", block: "center" });
                target.classList.add("manual-checks-flash");
                window.setTimeout(() => target.classList.remove("manual-checks-flash"), 1800);
              }, 80);
            }
            return;
          }
          if (action.id === "approve_only" || action.id === "approve_and_implement") {
            if (inDetails) setActionDetailsOpen(false);
            return confirmApproval(label, run);
          }
          if (inDetails && ["accept", "accept_override", "request_changes", "revise_plan", "reopen"].includes(action.id)) {
            setActionDetailsOpen(false);
          }
          return run(false);
        }}
      >
        <Icon icon={BANNER_ACTION_ICONS[action.id]} size={14} />
        <span className="truncate">{label}</span>
      </AsyncButton>
    );
  };

  let stageContext: { testId: string; text: string } | undefined;
  if (s.stage === "done" && s.delivery) {
    stageContext = {
      testId: "delivery-summary-line",
      text: [
        t(language, "ws.delivered", { hash: s.delivery.shortHash }) +
          (s.delivery.branch ? t(language, "ws.deliveredBranch", { branch: s.delivery.branch }) : "") +
          t(language, s.delivery.files.length === 1 ? "ws.deliveredFilesOne" : "ws.deliveredFilesOther", { count: s.delivery.files.length }),
        formatDateTime(s.delivery.deliveredAt, language),
        ...(s.github?.pr ? [`PR #${s.github.pr.number} (${formatPrStateLabel(language, s.github.pr.state)})`] : []),
      ].join(" · "),
    };
  } else if (s.stage === "done" && !deliveryPreview?.sandboxActive && deliveryPreview?.canCommit) {
    stageContext = {
      testId: "delivery-pending-hint",
      text: t(language, "ws.deliveryPending", { count: deliveryPreview.candidates.length }),
    };
  } else if (s.stage === "done" && deliveryPreview?.sandboxActive && !s.github?.pr) {
    stageContext = {
      testId: "delivery-sandbox-hint",
      text: t(language, deliveryPreview.canCreatePr ? "ws.deliverySandboxPrPlatform" : "ws.deliverySandboxNoPrPlatform", {
        branch: deliveryPreview.branch ?? reqData?.sandbox?.branch ?? "",
        platform: prPlatformLabel,
      }),
    };
  }

  const canDeliver = s.stage === "done" && Boolean(deliveryPreview?.canCommit || deliveryPreview?.canCreatePr);
  const canMerge = s.stage === "done" && Boolean(reqData?.sandbox && deliveryPreview?.canMergeLocal);
  const canSyncPr = s.stage === "done" && Boolean(s.github?.pr);
  const canApplySandbox = s.stage === "done" && Boolean(reqData?.sandbox);
  const deliveryOptions = (canDeliver && canMerge) || canSyncPr || canApplySandbox;
  const detailsLabel = t(language, !runningThis && deliveryOptions ? "ws.deliveryOptions" : "ws.actionDetails");
  const mergeLocalButton = canMerge && !runningThis && (
    <Button size="sm" variant={canDeliver ? "outline" : "default"} type="button" data-testid="merge-local-btn" disabled={busy} onClick={() => {
      if (canDeliver) setActionDetailsOpen(false);
      openDeliverModal(false, "local_merge");
    }}>
      <Icon icon={GitMerge} size={14} /> <span className="truncate">{t(language, "ws.mergeLocalBtn")}</span>
    </Button>
  );

  return (
    <div className="workspace-detail" data-testid="workspace-detail">
      <div className="workspace-pinned" data-testid="workspace-pinned">
        <StageStepper d={d} running={runningThis} />

        <div className="ws-head">
        <span className="req-id" style={{ fontSize: 14 }}>
          {s.id}
        </span>
        {s.kind === "bug" && (
          <Badge className="ws-bug-badge" variant="error" data-testid="bug-kind-badge" title={t(language, "kind.bugBadge")}>
            <Icon icon={Bug} size={14} /> <span className="ws-compact-label">{t(language, "kind.bugBadge")}</span>
          </Badge>
        )}
        <WorkspaceTitle title={s.title} />
        {reqData?.sandbox && (
          <WorkspaceSandbox key={`${activeProjectId}:${s.id}`} d={d} sandbox={reqData.sandbox} drift={reqData.sandboxDrift} running={runningThis} />
        )}
        <Badge className="ws-stage-badge" variant={mapTone(stageMeta.tone)} data-testid="ws-stage-badge">
          <Icon icon={STAGE_ICONS[s.stage]} size={14} />
          {stageMeta.labels[language]}
        </Badge>
        {derivedPill && (
          <Badge className="ws-derived-badge" variant={derivedPill.tone} data-testid="ws-derived-status-badge">
            {derivedPill.label}
          </Badge>
        )}
        <div className="more-wrap">
          <Menu open={moreMenuOpen} onOpenChange={setMoreMenuOpen}>
            {/*
             * 「更多」菜单的锚点固定在包装节点上，内部按钮重渲染不再重新登记
             * 位置锚点节点；关闭时显式把焦点还给按钮，保留原有键盘行为。
             */}
            <span ref={moreMenuAnchorRef} className="inline-flex shrink-0" data-testid="more-menu-anchor">
              <MenuTrigger
                render={
                  <Button ref={moreMenuButtonRef} size="sm" variant="outline" type="button" title={t(language, "ws.more")} aria-label={t(language, "ws.more")} data-testid="more-menu-btn">
                    <Icon icon={Ellipsis} size={14} /> <span className="ws-compact-label">{t(language, "ws.more")}</span>
                  </Button>
                }
              />
            </span>
            <MenuPopup
              align="end"
              anchor={moreMenuAnchorRef}
              className="min-w-44"
              data-testid="more-menu"
              finalFocus={moreMenuButtonRef}
              side="bottom"
              sideOffset={6}
            >
              {runningThis && (
                <div className="xs muted" data-testid="more-menu-lock-hint" style={{ padding: "6px 8px", maxWidth: 280 }}>
                  {t(language, "ws.runLockMenuHint")}
                </div>
              )}
              <MenuItem
                disabled={runningThis}
                nativeButton
                onClick={() => {
                  startEditSpec(
                    s.title,
                    d.specMarkdown,
                    s.criteria.map((c) => ({
                      id: c.id,
                      description: c.description,
                      required: c.required,
                      kind: c.kind,
                      command: c.command ?? "",
                      steps: c.steps ?? "",
                    })),
                  );
                }}
                render={<button type="button" data-testid="menu-edit-req-btn" />}
              >
                <Icon icon={Pencil} size={14} /> {t(language, "ws.menu.editReq")}
              </MenuItem>
              <MenuItem
                disabled={runningThis}
                nativeButton
                onClick={() => startEditDesign(d.designMarkdown)}
                render={<button type="button" data-testid="menu-edit-design-btn" />}
              >
                <Icon icon={FileEdit} size={14} /> {t(language, "ws.menu.editDesign")}
              </MenuItem>
              <MenuItem
                nativeButton
                onClick={() => void openHandoff(s.id)}
                render={<button type="button" />}
              >
                <Icon icon={FileText} size={14} /> {t(language, "ws.menu.handoff")}
              </MenuItem>
              {!reqData?.sandbox &&
                project?.git?.isGitRepo &&
                s.stage !== "done" &&
                s.stage !== "cancelled" && (
                  <MenuItem
                    disabled={runningThis}
                    nativeButton
                    onClick={async () => {
                      if (guardRequirementRunLock(s.id)) return;
                      const out = await runBusy(() => api.createRequirementSandbox(s.id));
                      if (out) {
                        await invalidateAllWorkbenchQueries();
                        showToastKey("ws.sandboxEnabledToast", {
                          id: s.id,
                          branch: out.sandbox.branch,
                        });
                      }
                    }}
                    render={<button type="button" data-testid="menu-enable-sandbox-btn" />}
                  >
                    <Icon icon={GitBranch} size={14} /> {t(language, "ws.menu.enableSandbox")}
                  </MenuItem>
                )}
              {!s.github?.issue ? (
                <MenuItem
                  disabled={runningThis}
                  nativeButton
                  onClick={() => {
                    setModal({
                      kind: "link_issue",
                      requirementId: s.id,
                      provider: isGiteeProject ? "gitee" : "github",
                      mode: isGiteeProject ? "link" : "create",
                      issueRef: "",
                    });
                  }}
                  render={<button type="button" data-testid="menu-link-issue-btn" />}
                >
                  <Icon icon={Link2} size={14} /> {t(language, isGiteeProject ? "ws.menu.linkGitee" : "ws.menu.linkIssue")}
                </MenuItem>
              ) : s.github.provider !== "gitee" ? (
                <MenuItem
                  disabled={runningThis}
                  nativeButton
                  onClick={async () => {
                    if (guardRequirementRunLock(s.id)) return;
                    const out = await runBusy(() => api.syncRequirementIssue(s.id));
                    if (out) {
                      await invalidateAllWorkbenchQueries();
                      showToastKey("toast.gitHubSynced", { number: s.github!.issue!.number });
                    }
                  }}
                  render={<button type="button" data-testid="menu-sync-issue-btn" />}
                >
                  <Icon icon={RefreshCw} size={14} /> {t(language, "ws.menu.syncIssue", { number: s.github.issue.number })}
                </MenuItem>
              ) : null}
              {s.stage === "planning" && (
                <MenuItem
                  disabled={runningThis}
                  nativeButton
                  onClick={() => {
                    void handleBannerAction(d, "fast_track");
                  }}
                  render={<button type="button" data-testid="menu-fast-track-btn" />}
                >
                  <Icon icon={Zap} size={14} /> {t(language, "ws.menu.fastTrack")}
                </MenuItem>
              )}
              {s.stage === "coding" && (
                <MenuItem
                  disabled={runningThis}
                  nativeButton
                  onClick={() => {
                    void handleBannerAction(d, "revise_plan");
                  }}
                  render={<button type="button" data-testid="menu-revise-plan-btn" />}
                >
                  <Icon icon={Undo2} size={14} /> {t(language, "ws.menu.revisePlan")}
                </MenuItem>
              )}
              {s.stage !== "done" && s.stage !== "cancelled" && (
                <>
                  <MenuSeparator />
                  <MenuItem
                    disabled={runningThis}
                    nativeButton
                    variant="destructive"
                    onClick={() => {
                      setModal({ kind: "lifecycle", action: "cancel", reason: "" });
                    }}
                    render={<button type="button" data-testid="menu-cancel-btn" />}
                  >
                    <Icon icon={XCircle} size={14} /> {t(language, "ws.menu.cancel")}
                  </MenuItem>
                </>
              )}
              {(s.stage === "done" || s.stage === "cancelled") && (
                <MenuItem
                  disabled={runningThis}
                  nativeButton
                  onClick={() => {
                    setModal({
                      kind: "lifecycle",
                      action: "reopen",
                      reason: "",
                      preserveApproval: d.validity.approval.valid,
                    });
                  }}
                  render={<button type="button" data-testid="menu-reopen-btn" />}
                >
                  <Icon icon={RotateCcw} size={14} /> {t(language, "ws.menu.reopen")}
                </MenuItem>
              )}
              <MenuSeparator />
              <MenuItem
                nativeButton
                onClick={() => {
                  setModal({
                    kind: "debug_info",
                    text: JSON.stringify(
                      {
                        projectRoot: project?.root,
                        projectId: project?.project?.projectId,
                        id: s.id,
                        revision: s.revision,
                        specHash: s.specHash,
                        designVersion: s.designVersion,
                        designHash: s.designHash,
                        baseline: s.baseline,
                      },
                      null,
                      2,
                    ),
                  });
                }}
                render={<button type="button" />}
              >
                <Icon icon={Bug} size={14} /> {t(language, "ws.menu.debug")}
              </MenuItem>
              <MenuSeparator />
              {s.parentId && (
                <MenuItem nativeButton onClick={() => void openRequirement(s.parentId!)} render={<button type="button" data-testid="ws-parent-link" />}>
                  <Icon icon={ArrowUp} size={14} /> {t(language, "ws.parentLink", { id: s.parentId })}
                </MenuItem>
              )}
              {s.github?.issue && (
                <MenuItem render={<a href={s.github.issue.url} target="_blank" rel="noreferrer" data-testid="ws-github-issue-link" title={s.github.issue.title} />}>
                  <Icon icon={Link2} size={14} /> Issue #{s.github.issue.number}
                </MenuItem>
              )}
              {s.github?.pr && (
                <MenuItem render={<a href={s.github.pr.url} target="_blank" rel="noreferrer" data-testid="ws-github-pr-link" title={s.github.pr.title} />}>
                  <Icon icon={GitPullRequest} size={14} /> PR #{s.github.pr.number} · {formatPrStateLabel(language, s.github.pr.state)}
                </MenuItem>
              )}
              <MenuItem
                nativeButton
                disabled={busy || runningThis || s.stage === "done" || s.stage === "cancelled"}
                onClick={() => void setRequirementTierAction(d, tier === "sota" ? "standard" : "sota")}
                render={<button type="button" data-testid="ws-tier-badge" title={t(language, "tier.toggleTitle")} />}
              >
                <Icon icon={Zap} size={14} /> {t(language, tier === "sota" ? "tier.sota" : "tier.standard")}
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
        <Button
          size="xs"
          type="button"
          variant="ghost"
          className={`ws-drawer-toggle ${drawerOpen ? "open" : ""}`}
          data-action="toggle-drawer"
          data-testid="toggle-drawer-btn"
          aria-expanded={drawerOpen}
          aria-label={drawerOpen ? t(language, "topbar.collapseDrawer") : t(language, "topbar.expandDrawer")}
          title={drawerOpen ? t(language, "topbar.drawerTitleOpen") : t(language, "topbar.drawerTitleClosed")}
          onClick={() => setDrawerOpen(!drawerOpen)}
        >
          <span className="drawer-toggle-icon">
            <Icon icon={drawerOpen ? PanelRightClose : PanelRightOpen} size={14} />
            {(runningThis || activeAskRun) && (
              <span
                className="pulse-dot"
                role="img"
                aria-label={t(language, activeAskRun && !runningThis ? "drawer.askRunning" : "drawer.running")}
              />
            )}
          </span>
          <span className="ws-compact-label">{t(language, "topbar.drawerLabelClosed")}</span>
          {pendingAnnotationsCount > 0 && (
            <span className="ws-drawer-annot-badge" data-testid="ws-drawer-annot-badge">
              {pendingAnnotationsCount}
            </span>
          )}
        </Button>
      </div>

      <section className={`banner ${banner.tone}${runningThis ? " ws-execution-running" : ""}`} data-testid="action-banner">
        {activeRun ? (
          <LiveAgentRows run={activeRun} headline={headline} />
        ) : (
          <>
            <div className="ws-execution-row">
              <div className="banner-text truncate" title={headline}>{headline}</div>
              <div className="ws-inline-actions">
                {banner.primaryAction && renderBannerAction(banner.primaryAction, "default")}
                {pairedAction && renderBannerAction(pairedAction, "outline")}
                {canDeliver && (
                  <Button
                    size="sm"
                    variant={s.delivery ? "outline" : "default"}
                    type="button"
                    data-testid="open-deliver-btn"
                    disabled={busy}
                    onClick={() => openDeliverModal(Boolean(reqData?.sandbox && deliveryPreview?.canCreatePr))}
                  >
                    <Icon icon={reqData?.sandbox && deliveryPreview?.canCreatePr ? GitPullRequest : GitCommit} size={14} />
                    <span className="truncate">
                      {reqData?.sandbox && deliveryPreview?.canCreatePr
                        ? s.github?.pr
                          ? t(language, "ws.deliverPrAppend")
                          : t(language, "ws.deliverPrCreatePlatform", { platform: prPlatformLabel })
                        : t(language, s.delivery ? "ws.deliverMore" : "ws.deliverStart")}
                    </span>
                  </Button>
                )}
                {!canDeliver && mergeLocalButton}
              </div>
            </div>
            <div className="ws-execution-row">
              {canRunModel ? (
                <div className="banner-runner-row" role="group" aria-label={t(language, "ws.modelDispatch")}>
                  <RunnerSelect stageAction={defaultAct} testId="banner-runner-select" tier={s.tier} />
                  {canReview && (
                    <AsyncButton
                      size="sm"
                      variant="outline"
                      type="button"
                      data-testid="run-review-btn"
                      disabled={busy}
                      title={t(language, "ws.crossReview")}
                      aria-label={t(language, "ws.crossReview")}
                      onAction={() => triggerActiveRun(s.id, "review")}
                    >
                      <Icon icon={Search} size={14} /> <span className="ws-compact-label">{t(language, "ws.crossReview")}</span>
                    </AsyncButton>
                  )}
                </div>
              ) : stageContext ? (
                <div className="ws-stage-context truncate" data-testid={stageContext.testId} title={stageContext.text}>{stageContext.text}</div>
              ) : s.lastFeedback ? (
                <div className="ws-stage-context truncate" title={s.lastFeedback}>{t(language, "ws.lastFeedback")} {s.lastFeedback}</div>
              ) : null}
              {runResult && (
                <span className="ws-run-result truncate" data-testid="workspace-run-result" title={recentRun?.errorSummary ?? runResult}>
                  {runResult}
                </span>
              )}
            </div>
          </>
        )}
        <Popover open={actionDetailsOpen} onOpenChange={setActionDetailsOpen}>
          <PopoverTrigger
            render={<Button size="sm" variant="outline" type="button" className="ws-action-details" data-testid="workspace-action-details-btn" aria-label={detailsLabel} title={detailsLabel} />}
          >
            <Icon icon={Ellipsis} size={14} /> <span className="ws-compact-label">{detailsLabel}</span>
          </PopoverTrigger>
          <PopoverPopup align="end" className="w-96 max-w-(--available-width)" data-testid="workspace-action-details">
            <div className="ws-popup-content">
              <PopoverTitle>{detailsLabel}</PopoverTitle>
              <p>{headline}</p>
              {runningThis && <p>{t(language, "ws.runLockHint")}</p>}
              {s.lastFeedback && <p className="whitespace-pre-wrap"><strong>{t(language, "ws.lastFeedback")}</strong> {s.lastFeedback}</p>}
              {stageContext && <p>{stageContext.text}</p>}
              {runResult && !runningThis && <p>{runResult}{recentRun?.errorSummary ? ` · ${recentRun.errorSummary}` : ""}</p>}
              {!runningThis && (otherActions.length > 0 || deliveryOptions) && (
                <div className="ws-popup-actions">
                  {otherActions.map((action) => renderBannerAction(action, "outline", true))}
                  {canDeliver && mergeLocalButton}
                  {canSyncPr && (
                    <AsyncButton size="sm" variant="outline" type="button" data-testid="sync-pr-btn" disabled={busy} onAction={syncPrStatus}>
                      <Icon icon={RefreshCw} size={14} /> <span className="truncate">{t(language, reqData?.sandbox ? "ws.syncPrCleanup" : "ws.syncPr")}</span>
                    </AsyncButton>
                  )}
                  {canApplySandbox && (
                    <AsyncButton
                      size="sm"
                      variant="outline"
                      type="button"
                      data-testid="apply-sandbox-btn"
                      disabled={busy}
                      onAction={async () => {
                        if (guardRequirementRunLock(s.id)) return;
                        const res = await runBusy(() => api.applySandbox(s.id));
                        if (res) {
                          await invalidateAllWorkbenchQueries();
                          showToastKey(
                            res.webReloaded ? "toast.appliedReload" : res.restartRecommended ? "toast.appliedRestart" : "toast.applied",
                            { count: res.appliedFiles.length },
                          );
                          notifyCascadeSyncResults(res.cascadeResults);
                        }
                      }}
                    >
                      <Icon icon={GitMerge} size={14} /> <span className="truncate">{t(language, deliveryPreview?.canCreatePr ? "ws.applySandboxLocal" : "ws.applySandbox")}</span>
                    </AsyncButton>
                  )}
                </div>
              )}
            </div>
          </PopoverPopup>
        </Popover>
      </section>
      </div>
      {approval && s.stage === "planning" && (
        <ApprovalConfirmation
          label={approval.label}
          canResetSandbox={canResetSandbox}
          dirtyBaseline={dirtyBaseline}
          disabled={busy || runningThis}
          onClose={() => setApproval(null)}
          onApprove={approval.run}
        />
      )}

      <Tabs
        className="w-full shrink-0 gap-0 mb-4 border-b border-border"
        value={workspaceTab}
        onValueChange={(next) => setWorkspaceTab(next as typeof workspaceTab)}
      >
        <TabsList
          variant="underline"
          size="lg"
          data-testid="workspace-tabs"
          className="w-full justify-start overflow-x-auto overflow-y-hidden max-sm:flex-wrap"
        >
          <TabsTab className="grow-0" value="spec" data-testid="tab-spec">
            <Icon icon={FileText} size={14} /> {t(language, "ws.tab.spec")}
          </TabsTab>
          <TabsTab className="grow-0" value="diff" data-testid="tab-diff">
            <Icon icon={FileDiff} size={14} /> {t(language, "ws.tab.diff")}
          </TabsTab>
          <TabsTab className="grow-0" value="changes" data-testid="tab-changes">
            <Icon icon={GitBranch} size={14} /> {t(language, "ws.tab.changes")}
          </TabsTab>
          <TabsTab className="grow-0" value="timeline" data-testid="tab-timeline">
            <Icon icon={History} size={14} /> {t(language, "ws.tab.timeline")}
          </TabsTab>
          <TabsTab className="grow-0" value="audit" data-testid="tab-audit">
            <Icon icon={BarChart3} size={14} /> {t(language, "ws.tab.audit")}
          </TabsTab>
        </TabsList>
      </Tabs>

      <div className="workspace-tab-scroll" data-testid="workspace-tab-scroll">
        {workspaceTab === "spec" ? (
          <>
            {showAcceptancePanel && (
              <AcceptanceSummaryPanel
                key={s.id}
                d={d}
                busy={busy}
                runLocked={runningThis}
                onOpenDiff={() => setWorkspaceTab("diff")}
              />
            )}
            <SpecDesignTab
              activeProjectId={activeProjectId}
              d={d}
              runLocked={runningThis}
              confirmApproval={confirmApproval}
            />
          </>
        ) : workspaceTab === "diff" ? (
          <DiffViewerPanel d={d} />
        ) : workspaceTab === "changes" ? (
          <>
            {showAcceptancePanel && (
              <AcceptanceSummaryPanel
                key={`${s.id}:changes`}
                d={d}
                busy={busy}
                runLocked={runningThis}
                onOpenDiff={() => setWorkspaceTab("diff")}
              />
            )}
            <ChangesVerifyTab d={d} runLocked={runningThis} hideManualChecks={showAcceptancePanel} />
          </>
        ) : workspaceTab === "audit" ? (
          <ExecutionAuditTab d={d} />
        ) : (
          <TimelineRunsTab d={d} />
        )}
      </div>
    </div>
  );
}
