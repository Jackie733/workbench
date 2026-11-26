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
  Loader2,
  Lock,
  Maximize2,
  MessageSquare,
  Minimize2,
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
  Wrench,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import type {
  AgentRunRecord,
  RequirementDetail,
  ScreenshotSkipReasonCode,
  Stage,
} from "../../core/types.ts";
import { api, requirementAttachmentUrl, screenshotUrl } from "../api.ts";
import {
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
  dispatchFixFromReview,
  dispatchSyncBaseWithAgent,
  executeVerify,
  guardRequirementRunLock,
  handleBannerAction,
  invalidateAllWorkbenchQueries,
  notifyCascadeSyncResults,
  openHandoff,
  openRequirement,
  queryClient,
  queryKeys,
  runBusy,
  setRequirementTierAction,
  syncSandboxBaseAction,
  toggleVerificationLog,
  triggerActiveRun,
  useDeliveryQuery,
  useDiffQuery,
  useHubStateQuery,
  useProjectQuery,
  useRequirementQuery,
} from "../queries.ts";
import { parseUnifiedDiff, renderDiffLinesHtml, renderSimpleLineDiff } from "../render.ts";
import {
  collectModelOptions,
  COVERAGE_META,
  defaultActionForRequirement,
  describeEvidenceContext,
  EVIDENCE_META,
  findLockingRequirementRun,
  formatDateTime,
  STAGE_META,
  VERDICT_META,
  type DiffViewMode,
} from "../state.ts";
import { useDraftStore } from "../stores/draftStore.ts";
import { useStreamStore } from "../stores/streamStore.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { AttachmentGallery } from "./AttachmentGallery.tsx";
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
import { RadioGroupPrimitive, RadioPrimitive } from "./ui/radio-group.tsx";
import { SegmentedControl, SegmentedControlItem } from "./ui/segmented-control.tsx";
import { Tabs, TabsList, TabsTab } from "./ui/tabs.tsx";
import { Textarea } from "./ui/textarea.tsx";

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

function LiveAgentBanner({ run }: { run: AgentRunRecord }) {
  const language = useUiStore((s) => s.language);
  const setDrawerTab = useUiStore((s) => s.setDrawerTab);
  const setDrawerOpen = useUiStore((s) => s.setDrawerOpen);
  const selectedId = useUiStore((s) => s.selectedId);
  const liveText = useStreamStore((s) => s.liveRunLogs[run.id] ?? "");

  const actionLabels: Record<string, string> = {
    design: t(language, "live.action.design"),
    implement: t(language, "live.action.implement"),
    fix: t(language, "live.action.fix"),
    review: t(language, "live.action.review"),
    ask: t(language, "live.action.ask"),
  };
  const lines = liveText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("$ "));
  const latestLine = lines[lines.length - 1]?.slice(0, 140) ?? t(language, "live.waiting");

  return (
    <section className="live-agent-banner" data-testid="live-agent-banner">
      <div className="live-agent-head">
        <div className="live-agent-title">
          <span className="pulse-dot" />
          <strong>{t(language, "live.heading", { action: actionLabels[run.action] ?? run.action })}</strong>
          <Badge variant="info">
            {run.harness}/{run.model}
          </Badge>
          {run.modelFallback && run.effectiveModel && (
            <Badge variant="warning">{t(language, "live.fallback", { model: run.effectiveModel })}</Badge>
          )}
        </div>
        <div className="live-agent-controls">
          <LiveTimer startedAt={run.startedAt} />
          <Button
            size="xs"
            variant="outline"
            type="button"
            data-testid="open-console-tab-btn"
            onClick={() => {
              setDrawerOpen(true);
              setDrawerTab("console");
            }}
          >
            <Icon icon={Terminal} size={14} /> {t(language, "live.viewTerminal")}
          </Button>
          <Button
            size="xs"
            variant="destructive"
            type="button"
            onClick={() => selectedId && void cancelRun(selectedId, run.id)}
          >
            <Icon icon={Square} size={14} /> {t(language, "live.stop")}
          </Button>
        </div>
      </div>
      <div className="live-progress-track" aria-hidden="true">
        <div className="live-shimmer-bar" />
      </div>
      <div className="live-preview-row">
        <span className="muted xs">{t(language, "live.progress")}</span>
        <code className="live-preview-line" data-testid="live-banner-preview">
          {latestLine}
        </code>
      </div>
      <div className="live-preview-row" data-testid="run-lock-hint" role="status">
        <Icon icon={Lock} size={14} />
        <span className="muted xs">{t(language, "ws.runLockHint")}</span>
      </div>
    </section>
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

function SpecDesignTab({
  d,
  runLocked,
}: {
  d: RequirementDetail;
  runLocked: boolean;
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
  const revValid = validity.reviewValidity;
  const isReviewCurrent = revValid.effectiveState === "current";
  const findings = review?.findings ?? [];

  const [selectedFindingIds, setSelectedFindingIds] = useState<string[]>(() =>
    findings.filter((f) => f.severity !== "low").map((f) => f.id),
  );
  useEffect(() => {
    const next = (review?.findings ?? []).filter((f) => f.severity !== "low").map((f) => f.id);
    setSelectedFindingIds(next.length > 0 ? next : (review?.findings ?? []).map((f) => f.id));
  }, [review?.id]);

  const toggleFinding = (fid: string) => {
    setSelectedFindingIds((prev) => (prev.includes(fid) ? prev.filter((x) => x !== fid) : [...prev, fid]));
  };

  const openAnnotate = (anchor: string) => {
    setModal({ kind: "annotate_anchor", anchor, message: "", mode: "refine" });
  };

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
        command: c.command.trim() || undefined,
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
    <>
      {review && (
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
                      command: c.command ?? "",
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
                    value={c.command}
                    placeholder={t(language, "spec.commandPlaceholder")}
                    onChange={(e) =>
                      setSpecDraftCriteria((prev) => {
                        const next = [...prev];
                        next[idx] = { ...next[idx]!, command: e.target.value };
                        return next;
                      })
                    }
                  />
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
          <MarkdownView markdown={d.specMarkdown} annotatable docLabel="spec.md" onAnnotate={openAnnotate} />
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
            return (
              <div key={item.criterion.id} className="criteria-row" data-testid={`crit-${item.criterion.id}`}>
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
                  </div>
                  {item.criterion.command && <div className="crit-cmd">{item.criterion.command}</div>}
                  {(item.reason || item.reasonKey) && (
                    <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                      {translateRef(language, item.reasonKey, item.reason ?? "", item.reasonParams)}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    type="button"
                    data-action="annotate-anchor"
                    data-anchor={t(language, "spec.criterionAnchor", { id: item.criterion.id })}
                    title={t(language, "spec.annotateTitle")}
                    aria-label={t(language, "spec.annotateTitle")}
                    onClick={() => openAnnotate(t(language, "spec.criterionAnchor", { id: item.criterion.id }))}
                  >
                    <Icon icon={MessageSquare} size={14} />
                  </Button>
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
          <MarkdownView markdown={d.designMarkdown} annotatable docLabel="design.md" onAnnotate={openAnnotate} />
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
    </>
  );
}

function pluralScreenshots(language: "zh-CN" | "en", count: number): string {
  return count === 1 ? t(language, "shot.countOne", { count }) : t(language, "shot.countOther", { count });
}

const SCREENSHOT_REASON_KEYS: Record<ScreenshotSkipReasonCode, MessageKey> = {
  browser_missing: "shot.reason.browser_missing",
  chrome_path_missing: "shot.reason.chrome_path_missing",
  puppeteer_path_missing: "shot.reason.puppeteer_path_missing",
  server_unavailable: "shot.reason.server_unavailable",
  browser_launch_failed: "shot.reason.browser_launch_failed",
  no_shots: "shot.reason.no_shots",
};

function ScreenshotEvidenceSection({ d, runLocked }: { d: RequirementDetail; runLocked: boolean }) {
  const language = useUiStore((s) => s.language);
  const showToastKey = useUiStore((s) => s.showToastKey);
  const [capturing, setCapturing] = useState(false);
  const [lightbox, setLightbox] = useState<{ batchId: string; index: number } | null>(null);
  const isDone = d.state.stage === "done";
  const frozen = d.acceptanceSnapshot?.screenshots;
  const batches = (frozen && frozen.length > 0 ? frozen : d.state.screenshotBatches ?? []).slice().reverse();
  const currentHash = d.validity.provenance.codeSnapshotHash;
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
          <AsyncButton
            size="xs"
            variant="outline"
            type="button"
            data-testid="screenshot-recapture"
            disabled={capturing || runLocked}
            onAction={recapture}
          >
            <Icon icon={RefreshCw} size={14} />{" "}
            {capturing ? t(language, "shot.capturing") : t(language, "shot.captureAgain")}
          </AsyncButton>
        )}
      </div>

      {batches.length === 0 ? (
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          {isDone ? t(language, "shot.noneDone") : t(language, "shot.none")}
        </p>
      ) : (
        batches.map((batch) => {
          const fingerprintMatch = Boolean(currentHash && batch.codeSnapshotHash === currentHash);
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
                  <Badge variant={statusMeta.tone}>
                    <Icon
                      icon={batch.status === "captured" ? CheckCircle2 : AlertTriangle}
                      size={14}
                    />{" "}
                    {statusMeta.label}
                  </Badge>
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    {formatDateTime(batch.createdAt, language)} ·{" "}
                    {batch.trigger === "auto_submit"
                      ? t(language, "shot.trigger.auto")
                      : t(language, "shot.trigger.manual")}{" "}
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

              {batch.skipReason && (
                <Alert variant="warning" className="my-2 text-xs" data-testid="screenshot-skip-reason">
                  <Icon icon={AlertTriangle} size={14} />
                  <AlertDescription className="text-foreground">{batch.skipReason}</AlertDescription>
                </Alert>
              )}

              {batch.shots.length > 0 && (
                <div className="screenshot-grid">
                  {batch.shots.map((shot, index) => (
                    <button
                      key={shot.id}
                      type="button"
                      className="screenshot-thumb"
                      data-testid={`shot-${shot.id}`}
                      onClick={() => setLightbox({ batchId: batch.id, index })}
                    >
                      <img src={screenshotUrl(d.state.id, shot.id)} alt={shot.label} loading="lazy" />
                      <span className="screenshot-thumb-label">{shot.label}</span>
                      <span className="muted" style={{ fontSize: 11 }}>
                        {shot.viewport} ·{" "}
                        {shot.theme === "dark" ? t(language, "shot.theme.dark") : t(language, "shot.theme.light")}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })
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

export function DiffViewerPanel({ d, inDrawer = false }: { d: RequirementDetail; inDrawer?: boolean }) {
  const language = useUiStore((s) => s.language);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const storeSelectedDiffFile = useUiStore((s) => s.selectedDiffFile);
  const storeDiffViewMode = useUiStore((s) => s.diffViewMode);
  const diffExpandedHeight = useUiStore((s) => s.diffExpandedHeight);
  const storeDiffFileQuery = useUiStore((s) => s.diffFileQuery);
  const storeSetSelectedDiffFile = useUiStore((s) => s.setSelectedDiffFile);
  const storeSetDiffViewMode = useUiStore((s) => s.setDiffViewMode);
  const setDiffExpandedHeight = useUiStore((s) => s.setDiffExpandedHeight);
  const storeSetDiffFileQuery = useUiStore((s) => s.setDiffFileQuery);
  const setDrawerOpen = useUiStore((s) => s.setDrawerOpen);
  const setDrawerTab = useUiStore((s) => s.setDrawerTab);
  const setWorkspaceTab = useUiStore((s) => s.setWorkspaceTab);
  const showToastKey = useUiStore((s) => s.showToastKey);

  const [drawerSelectedFile, setDrawerSelectedFile] = useState<string | null>(null);
  const [drawerViewMode, setDrawerViewMode] = useState<DiffViewMode>("split");
  const [drawerFileQuery, setDrawerFileQuery] = useState("");
  const [showLiveComparison, setShowLiveComparison] = useState(false);

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
  const { data: liveDiffRes } = useDiffQuery(activeProjectId, s.id, isDone && showLiveComparison, true);
  const diffObs = diffRes?.observation ?? diffRes?.changes ?? null;
  const liveDiffObs = liveDiffRes?.observation ?? liveDiffRes?.changes ?? null;
  const evidenceSummary = describeEvidenceContext(validity, diffRes ?? null, language);

  const rawDiffText = diffObs?.diff ?? "";
  const parsedFiles = useMemo(
    () => (rawDiffText ? parseUnifiedDiff(rawDiffText).map((f) => ({ ...f, html: renderDiffLinesHtml(f.lines) })) : []),
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

  const liveDiffText = liveDiffObs?.diff ?? "";
  const liveParsedFiles = useMemo(() => (liveDiffText ? parseUnifiedDiff(liveDiffText) : []), [liveDiffText]);
  const liveDiffHtml = useMemo(
    () => (liveDiffText ? renderDiffLinesHtml(liveDiffText.split("\n")) : ""),
    [liveDiffText],
  );

  const effectiveMode = inDrawer && diffViewMode === "split" && parsedFiles.length <= 1 ? "unified" : diffViewMode;
  const isExpanded = !inDrawer && diffExpandedHeight;

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
                className="h-7 [&_[data-slot=segmented-control-item]]:h-6"
                data-testid={tid("diff-view-mode-toggle")}
                render={
                  <RadioGroupPrimitive
                    className="flex items-center"
                    value={effectiveMode}
                    onValueChange={(next) => next && setDiffViewMode(next as DiffViewMode)}
                  />
                }
              >
                <SegmentedControlItem render={<RadioPrimitive.Root value="split" />}>
                  <Icon icon={Columns2} size={14} /> {t(language, "changes.viewMode.split")}
                </SegmentedControlItem>
                <SegmentedControlItem render={<RadioPrimitive.Root value="unified" />}>
                  <Icon icon={FileText} size={14} /> {t(language, "changes.viewMode.unified")}
                </SegmentedControlItem>
              </SegmentedControl>
            )}
            {!inDrawer && parsedFiles.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                type="button"
                data-testid="diff-expand-height-btn"
                onClick={() => setDiffExpandedHeight(!diffExpandedHeight)}
              >
                <Icon icon={diffExpandedHeight ? Minimize2 : Maximize2} size={14} />{" "}
                {diffExpandedHeight ? t(language, "changes.collapseHeight") : t(language, "changes.expandHeight")}
              </Button>
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
            {isDone ? (
              <Button
                size="xs"
                variant="outline"
                type="button"
                data-testid={tid("toggle-live-diff-btn")}
                onClick={() => setShowLiveComparison((prev) => !prev)}
              >
                {showLiveComparison ? (
                  <><Icon icon={EyeOff} size={14} /> {t(language, "changes.hideCompare")}</>
                ) : (
                  <><Icon icon={FileDiff} size={14} /> {t(language, "changes.compareLive")}</>
                )}
              </Button>
            ) : (
              <Button
                size="xs"
                variant="outline"
                type="button"
                onClick={() => {
                  void queryClient.invalidateQueries({ queryKey: queryKeys.diff(activeProjectId, s.id, false) });
                  showToastKey("changes.refreshedDiff");
                }}
              >
                <Icon icon={RefreshCw} size={14} /> {t(language, "changes.refreshDiff")}
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
          <div className={`diff-unified-list ${isExpanded ? "expanded" : ""}`} data-testid={tid("diff-unified-list")}>
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
                  className={`diff-code ${isExpanded ? "expanded" : ""}`}
                  dangerouslySetInnerHTML={{ __html: rawDiffHtml }}
                />
              ) : (
                <div className="diff-files" style={{ maxHeight: "none" }}>
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
                  <div
                    className={`diff-code ${isExpanded ? "expanded" : ""}`}
                    dangerouslySetInnerHTML={{ __html: f.html }}
                  />
                </div>
              ))
            )}
          </div>
        ) : (
          <div className={`diff-split ${isExpanded ? "expanded" : ""} ${inDrawer ? "in-drawer" : ""}`}>
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
            ) : (
              <div
                className={`diff-code ${isExpanded ? "expanded" : ""}`}
                dangerouslySetInnerHTML={{
                  __html: activeDiffFile ? activeDiffFile.html : rawDiffHtml,
                }}
              />
            )}
          </div>
        )}
      </Card>

      {isDone && showLiveComparison && (
        <Card className="p-4 mb-3.5" data-testid={tid("live-diff-comparison-card")}>
          <div className="card-head">
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <h3>{t(language, "changes.liveTitle")}</h3>
              <Badge variant="info">{t(language, "changes.liveBadge")}</Badge>
            </div>
            <Button
              size="xs"
              variant="outline"
              type="button"
              onClick={() => {
                void queryClient.invalidateQueries({ queryKey: queryKeys.diff(activeProjectId, s.id, true) });
                showToastKey("changes.refreshedCompare");
              }}
            >
              <Icon icon={RefreshCw} size={14} /> {t(language, "changes.refreshCompare")}
            </Button>
          </div>
          {!liveDiffRes ? (
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>
              {t(language, "changes.loadingCompare")}
            </p>
          ) : liveDiffRes.status === "unavailable" || !liveDiffObs ? (
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>
              {t(language, "changes.compareUnavailable", {
                reason:
                  translateRef(
                    language,
                    liveDiffRes.reasonKey,
                    liveDiffRes.reason ?? t(language, "changes.cannotRead"),
                    liveDiffRes.reasonParams,
                  ) || t(language, "changes.cannotRead"),
              })}
            </p>
          ) : liveDiffObs.files.length === 0 ? (
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>
              {t(language, "changes.compareEmpty")}
            </p>
          ) : (
            <div className="muted" style={{ fontSize: 12.5 }}>
              {t(language, "changes.compareSummary", {
                files: liveDiffObs.files.length,
                patches: liveParsedFiles.length,
              })}
              <div
                className="diff-code"
                style={{ marginTop: 8, maxHeight: 420, overflow: "auto" }}
                dangerouslySetInnerHTML={{
                  __html: liveDiffHtml,
                }}
              />
            </div>
          )}
        </Card>
      )}
    </>
  );
}

function ChangesVerifyTab({
  d,
  runLocked,
}: {
  d: RequirementDetail;
  runLocked: boolean;
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
  const { data: reqData } = useRequirementQuery(activeProjectId, selectedId);
  const isDoneStage = reqData?.detail?.state.stage === "done";
  const { data: deliveryPreview } = useDeliveryQuery(activeProjectId, selectedId, Boolean(isDoneStage));

  const d = reqData?.detail ?? null;
  if (!d) return <p className="muted">{t(language, "ws.loading")}</p>;

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
        : s.stage === "coding" && validity.acceptanceGate.ok
          ? { label: t(language, "ws.derived.readyAccept"), tone: "success" as const }
          : null;

  const isGiteeProject =
    project?.remoteProvider === "gitee" ||
    Boolean(project?.project?.gitee) ||
    s.github?.provider === "gitee";
  const prPlatformLabel = isGiteeProject ? "Gitee" : "GitHub";

  const openDeliverModal = (preferPr?: boolean) => {
    if (guardRequirementRunLock(s.id)) return;
    const candidates = deliveryPreview?.candidates ?? [];
    const matched = candidates.filter((c) => c.inAcceptedSnapshot).map((c) => c.path);
    const defaultSelected = matched.length > 0 ? matched : candidates.map((c) => c.path);
    const usePr =
      preferPr ?? Boolean((reqData?.sandbox || !deliveryPreview?.canCommit) && deliveryPreview?.canCreatePr);
    setModal({
      kind: "deliver",
      commitMessage: deliveryPreview?.suggestedMessage ?? `feat(${s.id.toLowerCase()}): ${s.title}`,
      selectedFiles: defaultSelected,
      note: "",
      createPr: usePr,
      branchName: deliveryPreview?.suggestedBranch ?? `feat/${s.id.toLowerCase()}`,
      baseBranch: deliveryPreview?.baseBranch ?? (isGiteeProject ? "master" : "main"),
      prTitle: `${s.id}: ${s.title}`,
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
  const activeRun =
    findLockingRequirementRun(Object.values(activeRuns), s.id, {
      projectId: activeProjectId ?? hub?.activeProjectId ?? null,
      projectRoot: project?.root ?? null,
      projects: hub?.projects ?? [],
    }) ?? null;
  const runningThis = Boolean(activeRun);
  const canRunModel = s.stage !== "done" && s.stage !== "cancelled" && modelOptions.length > 0;
  const canReview = modelOptions.length > 0 && s.stage === "coding";

  return (
    <div className="workspace-detail" data-testid="workspace-detail">
      <div className="workspace-pinned" data-testid="workspace-pinned">
        <StageStepper d={d} running={runningThis} />

        <div className="ws-head">
        <span className="req-id" style={{ fontSize: 14 }}>
          {s.id}
        </span>
        {s.parentId && (
          <Badge
            render={<button type="button" onClick={() => void openRequirement(s.parentId!)} />}
            variant="info"
            data-testid="ws-parent-link"
          >
            <Icon icon={ArrowUp} size={14} /> {t(language, "ws.parentLink", { id: s.parentId })}
          </Badge>
        )}
        <h1 className="ws-title">{s.title}</h1>
        {reqData?.sandbox && (
          <Badge
            variant="info"
            data-testid="sandbox-active-badge"
            title={t(language, "ws.sandboxTitle", { branch: reqData.sandbox.branch })}
          >
            <Icon icon={GitBranch} size={14} /> {t(language, "ws.sandboxActive")}
          </Badge>
        )}
        {s.github?.issue && (
          <Badge
            render={
              <a
                href={s.github.issue.url}
                target="_blank"
                rel="noreferrer"
              />
            }
            variant={s.github.issue.state === "closed" ? "secondary" : "info"}
            data-testid="ws-github-issue-link"
            title={s.github.issue.title}
          >
            <Icon icon={Link2} size={14} /> Issue #{s.github.issue.number}
          </Badge>
        )}
        {s.github?.pr && (
          <Badge
            render={
              <a
                href={s.github.pr.url}
                target="_blank"
                rel="noreferrer"
              />
            }
            variant={s.github.pr.state === "merged" ? "success" : s.github.pr.state === "closed" ? "secondary" : "info"}
            data-testid="ws-github-pr-link"
            title={s.github.pr.title}
          >
            <Icon icon={GitPullRequest} size={14} /> PR #{s.github.pr.number} · {formatPrStateLabel(language, s.github.pr.state)}
          </Badge>
        )}
        <Badge variant={mapTone(stageMeta.tone)} data-testid="ws-stage-badge">
          <Icon icon={STAGE_ICONS[s.stage]} size={14} />
          {stageMeta.labels[language]}
        </Badge>
        {derivedPill && (
          <Badge variant={derivedPill.tone} data-testid="ws-derived-status-badge">
            {derivedPill.label}
          </Badge>
        )}
        <Badge
          render={
            s.stage !== "done" && s.stage !== "cancelled" ? (
              <button
                type="button"
                disabled={busy || runningThis}
                onClick={() => void setRequirementTierAction(d, tier === "sota" ? "standard" : "sota")}
              />
            ) : undefined
          }
          variant={tier === "sota" ? "warning" : "secondary"}
          data-testid="ws-tier-badge"
          title={t(language, "tier.toggleTitle")}
        >
          <Icon icon={Zap} size={14} />
          {t(language, tier === "sota" ? "tier.sota" : "tier.standard")}
        </Badge>
        <div className="more-wrap">
          <Menu open={moreMenuOpen} onOpenChange={setMoreMenuOpen}>
            {/*
             * 「更多」菜单的锚点固定在包装节点上，内部按钮重渲染不再重新登记
             * 位置锚点节点；关闭时显式把焦点还给按钮，保留原有键盘行为。
             */}
            <span ref={moreMenuAnchorRef} className="inline-flex shrink-0" data-testid="more-menu-anchor">
              <MenuTrigger
                render={
                  <Button ref={moreMenuButtonRef} size="sm" variant="outline" type="button" data-testid="more-menu-btn">
                    <Icon icon={Ellipsis} size={14} /> {t(language, "ws.more")}
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
                      command: c.command ?? "",
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
            </MenuPopup>
          </Menu>
        </div>
      </div>

      {s.lastFeedback && (
        <Alert variant="warning" className="mb-3.5 text-xs">
          <Icon icon={AlertTriangle} size={14} />
          <AlertTitle>{t(language, "ws.lastFeedback")}</AlertTitle>
          <AlertDescription className="text-foreground">{s.lastFeedback}</AlertDescription>
        </Alert>
      )}

      {reqData?.sandbox &&
        reqData.sandboxDrift &&
        s.stage !== "cancelled" &&
        !(s.stage === "done" && s.github?.pr?.state === "merged") &&
        (reqData.sandboxDrift.behindCount > 0 ||
          reqData.sandboxDrift.conflictFiles.length > 0 ||
          (reqData.sandboxDrift.siblingConflicts?.length ?? 0) > 0) && (() => {
          const drift = reqData.sandboxDrift!;
          const hasTrueConflict = drift.conflictFiles.length > 0;
          const isAutoMergeable = !hasTrueConflict && drift.driftStatus === "auto_mergeable";
          const siblingList = drift.siblingConflicts ?? [];
          const hasSiblingTrueConflict = siblingList.some((sc) => sc.conflictFiles.length > 0);
          const canAgentResolveNow =
            s.stage === "coding" ||
            s.stage === "done" ||
            (s.stage === "planning" && s.designHash !== "");
          const sep = language === "en" ? ", " : "、";
          return (
            <Alert
              variant={hasTrueConflict ? "error" : "warning"}
              data-testid="sandbox-drift-callout"
              className="mb-3.5"
            >
              <Icon icon={GitBranch} size={14} />
              <AlertDescription className="flex w-full flex-wrap items-center justify-between gap-2.5 text-foreground">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <strong>
                      {drift.behindCount > 0
                        ? t(language, "ws.sandboxDrift.title", {
                            branch: drift.branch,
                            count: drift.behindCount,
                          })
                        : t(language, "ws.sandboxDrift.radarOnlyTitle", { branch: drift.branch })}
                    </strong>
                    {hasTrueConflict && (
                      <Badge variant="error">
                        <Icon icon={AlertTriangle} size={14} />
                        {t(language, "ws.sandboxDrift.conflictBadge", {
                          count: drift.conflictFiles.length,
                        })}
                      </Badge>
                    )}
                    {isAutoMergeable && (
                      <Badge variant="info">
                        <Icon icon={CALLOUT_TONE_ICONS.info} size={14} />
                        {t(language, "ws.sandboxDrift.autoMergeBadge", {
                          count: drift.overlapFiles.length,
                        })}
                      </Badge>
                    )}
                  </div>
                  {hasTrueConflict ? (
                    <div className="xs" style={{ marginTop: 4 }}>
                      {t(language, "ws.sandboxDrift.conflictDetail", {
                        files:
                          drift.conflictFiles.slice(0, 6).join(sep) +
                          (drift.conflictFiles.length > 6 ? "…" : ""),
                      })}
                    </div>
                  ) : isAutoMergeable ? (
                    <div className="xs muted" style={{ marginTop: 4 }}>
                      {t(language, "ws.sandboxDrift.autoMergeDetail", {
                        files:
                          drift.overlapFiles.slice(0, 6).join(sep) +
                          (drift.overlapFiles.length > 6 ? "…" : ""),
                      })}
                    </div>
                  ) : drift.behindCount > 0 ? (
                    <div className="xs muted" style={{ marginTop: 4 }}>
                      {t(language, "ws.sandboxDrift.safeDetail")}
                    </div>
                  ) : null}
                  {siblingList.length > 0 && (
                    <div
                      className="xs"
                      data-testid="sibling-conflict-radar"
                      style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}
                    >
                      <span className={hasSiblingTrueConflict ? "danger-text" : "muted"} style={{ fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <Icon icon={hasSiblingTrueConflict ? AlertTriangle : CALLOUT_TONE_ICONS.info} size={14} />
                        {t(language, "ws.sandboxDrift.siblingTitle")}
                      </span>
                      {siblingList.map((sc) => {
                        const filesText =
                          (sc.conflictFiles.length > 0 ? sc.conflictFiles : sc.overlapFiles).slice(0, 3).join(sep) +
                          ((sc.conflictFiles.length > 0 ? sc.conflictFiles : sc.overlapFiles).length > 3 ? "…" : "");
                        return (
                          <Badge
                            key={sc.requirementId}
                            render={<button type="button" onClick={() => void openRequirement(sc.requirementId)} />}
                            variant={sc.conflictFiles.length > 0 ? "error" : "secondary"}
                          >
                            {t(
                              language,
                              sc.conflictFiles.length > 0
                                ? "ws.sandboxDrift.siblingConflict"
                                : "ws.sandboxDrift.siblingAuto",
                              { id: sc.requirementId, files: filesText },
                            )}
                          </Badge>
                        );
                      })}
                    </div>
                  )}
                  {hasTrueConflict && !canAgentResolveNow && (
                    <div className="xs muted" style={{ marginTop: 4 }}>
                      {t(language, "ws.sandboxDrift.needDesignFirst")}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {drift.canAutoSync && (
                    <AsyncButton
                      size="xs"
                      type="button"
                      data-testid="sync-sandbox-base-btn"
                      disabled={busy || runningThis}
                      onAction={() => syncSandboxBaseAction(s.id)}
                    >
                      <Icon icon={RefreshCw} size={14} />{" "}
                      {t(language, isAutoMergeable ? "ws.sandboxDrift.syncAutoMerge" : "ws.sandboxDrift.sync")}
                    </AsyncButton>
                  )}
                  {hasTrueConflict && canAgentResolveNow && (
                    <AsyncButton
                      size="xs"
                      type="button"
                      data-testid="agent-sync-sandbox-btn"
                      disabled={busy || runningThis}
                      onAction={() => dispatchSyncBaseWithAgent(d, drift)}
                    >
                      <Icon icon={Wrench} size={14} />{" "}
                      {t(
                        language,
                        s.stage === "planning"
                          ? "ws.sandboxDrift.approveAndSyncWithAgent"
                          : "ws.sandboxDrift.syncWithAgent",
                      )}
                    </AsyncButton>
                  )}
                </div>
              </AlertDescription>
            </Alert>
          );
        })()}

      <section className={`banner ${banner.tone}`} data-testid="action-banner">
        <div>
          <div className="banner-text">
            {translateRef(language, banner.headlineKey, banner.headline, banner.headlineParams)}
          </div>
          {s.stage === "planning" && Boolean(s.designHash) && project?.git?.isGitRepo && project.git.dirty && (
            <div className="muted xs" style={{ marginTop: 4 }} data-testid="dirty-baseline-hint">
              {t(language, "ws.dirtyHint")}
            </div>
          )}
          {s.stage === "done" && s.delivery && (
            <div className="muted xs" style={{ marginTop: 4 }} data-testid="delivery-summary-line">
              {t(language, "ws.delivered", { hash: s.delivery.shortHash })}
              {s.delivery.branch ? t(language, "ws.deliveredBranch", { branch: s.delivery.branch }) : ""} ·{" "}
              {t(
                language,
                s.delivery.files.length === 1 ? "ws.deliveredFilesOne" : "ws.deliveredFilesOther",
                { count: s.delivery.files.length },
              )}{" "}
              · {formatDateTime(s.delivery.deliveredAt, language)}
              {s.github?.pr && ` · PR #${s.github.pr.number} (${formatPrStateLabel(language, s.github.pr.state)})`}
            </div>
          )}
          {s.stage === "done" && !s.delivery && !deliveryPreview?.sandboxActive && deliveryPreview?.canCommit && (
            <div className="muted xs" style={{ marginTop: 4 }} data-testid="delivery-pending-hint">
              {t(language, "ws.deliveryPending", { count: deliveryPreview.candidates.length })}
            </div>
          )}
          {s.stage === "done" && deliveryPreview?.sandboxActive && !s.github?.pr && (
            <div className="muted xs" style={{ marginTop: 4 }} data-testid="delivery-sandbox-hint">
              {deliveryPreview.canCreatePr
                ? t(language, "ws.deliverySandboxPrPlatform", {
                    branch: deliveryPreview.branch ?? reqData?.sandbox?.branch ?? "",
                    platform: prPlatformLabel,
                  })
                : t(language, "ws.deliverySandboxNoPrPlatform", { platform: prPlatformLabel })}
            </div>
          )}
          {canRunModel && (
            <div className="banner-runner-row">
              <span className="xs muted">{t(language, "ws.modelDispatch")}</span>
              <RunnerSelect stageAction={defaultAct} testId="banner-runner-select" tier={s.tier} />
              <AsyncButton
                size="sm"
                variant="outline"
                type="button"
                data-testid="run-selected-model-btn"
                disabled={busy || runningThis}
                onAction={() => triggerActiveRun(s.id, defaultAct)}
              >
                {runningThis ? (
                  <><Icon icon={Loader2} size={14} className="spin" /> {t(language, "ws.running")}</>
                ) : (
                  <>
                    <Icon icon={Zap} size={14} /> {t(language, "ws.runBackground")}
                  </>
                )}
              </AsyncButton>
              {canReview && (
                <AsyncButton
                  size="sm"
                  variant="outline"
                  type="button"
                  data-testid="run-review-btn"
                  disabled={busy || runningThis}
                  onAction={() => triggerActiveRun(s.id, "review")}
                >
                  <Icon icon={Search} size={14} /> {t(language, "ws.crossReview")}
                </AsyncButton>
              )}
            </div>
          )}
        </div>
        <div className="banner-actions">
          {banner.primaryAction && (
            <AsyncButton
              key={`${s.id}:${banner.primaryAction.id}`}
              type="button"
              data-testid={`action-${banner.primaryAction.id}`}
              disabled={busy || runningThis}
              onAction={() => handleBannerAction(d, banner.primaryAction!.id)}
            >
              <Icon icon={BANNER_ACTION_ICONS[banner.primaryAction.id]} size={14} />{" "}
              {translateRef(
                language,
                banner.primaryAction.labelKey,
                banner.primaryAction.label,
                banner.primaryAction.labelParams,
              )}
            </AsyncButton>
          )}
          {banner.secondaryActions.map((sec) => (
            <AsyncButton
              key={`${s.id}:${sec.id}`}
              variant="outline"
              type="button"
              data-testid={`action-${sec.id}`}
              disabled={busy || runningThis}
              onAction={() => handleBannerAction(d, sec.id)}
            >
              <Icon icon={BANNER_ACTION_ICONS[sec.id]} size={14} />{" "}
              {translateRef(language, sec.labelKey, sec.label, sec.labelParams)}
            </AsyncButton>
          ))}
          {s.stage === "done" && (deliveryPreview?.canCommit || deliveryPreview?.canCreatePr) && (
            <Button
              variant={s.delivery ? "outline" : "default"}
              type="button"
              data-testid="open-deliver-btn"
              disabled={busy || runningThis}
              onClick={() => openDeliverModal(Boolean(reqData?.sandbox && deliveryPreview?.canCreatePr))}
            >
              <Icon
                icon={reqData?.sandbox && deliveryPreview?.canCreatePr ? GitPullRequest : GitCommit}
                size={14}
              />{" "}
              {reqData?.sandbox && deliveryPreview?.canCreatePr
                ? s.github?.pr
                  ? t(language, "ws.deliverPrAppend")
                  : t(language, "ws.deliverPrCreatePlatform", { platform: prPlatformLabel })
                : s.delivery
                  ? t(language, "ws.deliverMore")
                  : t(language, "ws.deliverStart")}
            </Button>
          )}
          {s.stage === "done" && s.github?.pr && (
            <AsyncButton
              variant="outline"
              type="button"
              data-testid="sync-pr-btn"
              disabled={busy || runningThis}
              onAction={syncPrStatus}
            >
              <Icon icon={RefreshCw} size={14} />{" "}
              {reqData?.sandbox ? t(language, "ws.syncPrCleanup") : t(language, "ws.syncPr")}
            </AsyncButton>
          )}
          {reqData?.sandbox && s.stage === "done" && (
            <AsyncButton
              variant="outline"
              type="button"
              data-testid="apply-sandbox-btn"
              disabled={busy || runningThis}
              onAction={async () => {
                if (guardRequirementRunLock(s.id)) return;
                const res = await runBusy(() => api.applySandbox(s.id));
                if (res) {
                  await invalidateAllWorkbenchQueries();
                  showToastKey(
                    res.webReloaded
                      ? "toast.appliedReload"
                      : res.restartRecommended
                        ? "toast.appliedRestart"
                        : "toast.applied",
                    { count: res.appliedFiles.length },
                  );
                  notifyCascadeSyncResults(res.cascadeResults);
                }
              }}
            >
              <Icon icon={GitMerge} size={14} />{" "}
              {deliveryPreview?.canCreatePr ? t(language, "ws.applySandboxLocal") : t(language, "ws.applySandbox")}
            </AsyncButton>
          )}
        </div>
      </section>

      {activeRun && <LiveAgentBanner run={activeRun} />}
      </div>

      <Tabs
        className="w-full shrink-0 gap-0 mb-4 border-b border-border"
        value={workspaceTab}
        onValueChange={(next) => setWorkspaceTab(next as typeof workspaceTab)}
      >
        <TabsList
          variant="underline"
          size="lg"
          data-testid="workspace-tabs"
          className="w-full justify-start overflow-x-auto max-sm:flex-wrap"
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
          <SpecDesignTab d={d} runLocked={runningThis} />
        ) : workspaceTab === "diff" ? (
          <DiffViewerPanel d={d} />
        ) : workspaceTab === "changes" ? (
          <ChangesVerifyTab d={d} runLocked={runningThis} />
        ) : workspaceTab === "audit" ? (
          <ExecutionAuditTab d={d} />
        ) : (
          <TimelineRunsTab d={d} />
        )}
      </div>
    </div>
  );
}
