import { useEffect, useState } from "react";
import {
  Content as DropdownContent,
  Item as DropdownItem,
  Portal as DropdownPortal,
  Root as DropdownRoot,
  Trigger as DropdownTrigger,
} from "@radix-ui/react-dropdown-menu";
import {
  AlertTriangle,
  ArrowUp,
  Check,
  Ellipsis,
  GitBranch,
  GitFork,
  GitPullRequest,
  Link2,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Wrench,
  Zap,
} from "lucide-react";
import type {
  AgentRunRecord,
  RequirementDetail,
  ScreenshotBatch,
  ScreenshotSkipReasonCode,
  Stage,
} from "../../core/types.ts";
import { api, requirementAttachmentUrl, screenshotUrl } from "../api.ts";
import {
  formatAgentActionLabel,
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
  dispatchFixFromReview,
  dispatchSyncBaseWithAgent,
  executeVerify,
  handleBannerAction,
  invalidateAllWorkbenchQueries,
  openHandoff,
  openRequirement,
  openRunConsole,
  queryClient,
  queryKeys,
  runBusy,
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
  formatDateTime,
  STAGE_META,
  TASK_META,
  VERDICT_META,
} from "../state.ts";
import { useDraftStore } from "../stores/draftStore.ts";
import { useStreamStore } from "../stores/streamStore.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { AttachmentGallery } from "./AttachmentGallery.tsx";
import { AttachmentPicker } from "./AttachmentPicker.tsx";
import { COVERAGE_ICONS, Icon, TASK_ICONS } from "./Icon.tsx";
import { LiveTimer, MarkdownView, ModalShell, RunnerSelect } from "./Primitives.tsx";

function StageStepper({ d, running }: { d: RequirementDetail; running: boolean }) {
  const language = useUiStore((s) => s.language);
  const stage = d.state.stage;
  const delivered = Boolean(d.state.delivery);
  const steps = [
    { key: "draft", label: t(language, "ws.step.draft") },
    { key: "designing", label: t(language, "ws.step.design") },
    { key: "awaiting_approval", label: t(language, "ws.step.review") },
    { key: "implementing", label: t(language, "ws.step.implement") },
    { key: "done", label: t(language, "ws.step.accept") },
    { key: "delivered", label: t(language, "ws.step.deliver") },
  ];
  const order: Record<Stage, number> = {
    draft: 0,
    designing: 1,
    awaiting_approval: 2,
    implementing: 3,
    awaiting_acceptance: 3,
    done: delivered ? 5 : 5,
    blocked: 3,
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
              : i < 5
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
          <span className="badge info">
            {run.harness}/{run.model}
          </span>
          {run.modelFallback && run.effectiveModel && (
            <span className="badge warning">{t(language, "live.fallback", { model: run.effectiveModel })}</span>
          )}
        </div>
        <div className="live-agent-controls">
          <LiveTimer startedAt={run.startedAt} />
          <button
            className="btn xs"
            type="button"
            data-testid="open-console-tab-btn"
            onClick={() => {
              setDrawerOpen(true);
              setDrawerTab("console");
            }}
          >
            {t(language, "live.viewTerminal")}
          </button>
          <button
            className="btn danger xs"
            type="button"
            onClick={() => selectedId && void cancelRun(selectedId, run.id)}
          >
            {t(language, "live.stop")}
          </button>
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
    </section>
  );
}

function buildSpawnDrafts(d: RequirementDetail): Array<{ title: string; goal: string }> {
  if (d.state.tasks.length > 0) {
    return d.state.tasks.slice(0, 12).map((t) => ({
      title: t.title,
      goal: t.note ? `${t.title}\n\n${t.note}` : t.title,
    }));
  }
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

function SpecDesignTab({ d, bridgeConnected }: { d: RequirementDetail; bridgeConnected: boolean }) {
  const language = useUiStore((s) => s.language);
  const busy = useUiStore((s) => s.busy);
  const designViewVersion = useUiStore((s) => s.designViewVersion);
  const designComparePrev = useUiStore((s) => s.designComparePrev);
  const designCompareText = useUiStore((s) => s.designCompareText);
  const setModal = useUiStore((s) => s.setModal);
  const showToast = useUiStore((s) => s.showToast);
  const showToastKey = useUiStore((s) => s.showToastKey);
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
        <div className={`card review-card ${VERDICT_META[review.verdict].tone}`} data-testid="review-report-card">
          <div className="card-head">
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <h3>{t(language, "review.title")}</h3>
              <span className={`badge ${VERDICT_META[review.verdict].tone}`}>
                {VERDICT_META[review.verdict].labels[language]}
              </span>
              <span className={`badge ${revValid.effectiveState === "current" ? "info" : "warning"}`}>
                {revValid.effectiveState === "current"
                  ? t(language, "review.currentValid")
                  : translateRef(language, revValid.reasonKey, t(language, "review.stale"))}
              </span>
              <span className="muted xs">
                {review.reviewerHarness} · {review.reviewerModel}
              </span>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {s.stage !== "done" && s.stage !== "cancelled" && s.stage !== "blocked" && review.verdict !== "pass" && (
                <>
                  <button
                    className={isReviewCurrent ? "btn primary xs" : "btn xs"}
                    type="button"
                    data-testid="review-fix-btn"
                    disabled={busy}
                    onClick={() =>
                      void dispatchFixFromReview(d, bridgeConnected, {
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
                  </button>
                  <button
                    className="btn xs"
                    type="button"
                    data-testid="review-reject-btn"
                    disabled={busy}
                    onClick={() => void handleBannerAction(d, "request_changes", bridgeConnected)}
                  >
                    {t(language, "core.action.sendBack")}
                  </button>
                  {isReviewCurrent && validity.acceptanceGate.ok && (
                    <button
                      className="btn xs"
                      type="button"
                      data-testid="review-override-accept-btn"
                      disabled={busy}
                      onClick={() => void handleBannerAction(d, "accept", bridgeConnected)}
                    >
                      <Icon icon={Check} size={14} />{" "}
                      {review.verdict === "block"
                        ? t(language, "core.action.ignoreBlockAccept")
                        : t(language, "core.action.acceptRisk")}
                    </button>
                  )}
                </>
              )}
              <button
                className={!isReviewCurrent ? "btn primary xs" : "btn xs"}
                type="button"
                data-testid="review-rerun-btn"
                disabled={busy}
                onClick={() => void triggerActiveRun(s.id, "review")}
              >
                <Icon icon={Search} size={14} /> {t(language, "review.rerun")}
              </button>
            </div>
          </div>
          <div style={{ fontWeight: 500, marginBottom: 8 }}>{review.summary}</div>

          {findings.length > 0 && (
            <div className="review-findings-list" data-testid="review-findings-list">
              {findings.map((f) => {
                const checked = selectedFindingIds.includes(f.id);
                const sevTone = f.severity === "high" ? "danger" : f.severity === "medium" ? "warning" : "neutral";
                const sevLabel =
                  f.severity === "high"
                    ? t(language, "review.severity.high")
                    : f.severity === "medium"
                      ? t(language, "review.severity.medium")
                      : t(language, "review.severity.low");
                return (
                  <label key={f.id} className="review-finding-item">
                    {s.stage !== "done" && review.verdict !== "pass" && (
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleFinding(f.id)}
                      />
                    )}
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <span className={`badge ${sevTone}`}>{sevLabel}</span>
                        <code className="xs">{f.id}</code>
                        <strong style={{ fontSize: 13 }}>{f.title}</strong>
                        {f.criterionIds && f.criterionIds.length > 0 && (
                          <span className="badge info">{f.criterionIds.join(", ")}</span>
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
                  </label>
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
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3>{t(language, "spec.title")}</h3>
          {editingSpec ? (
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="btn xs"
                type="button"
                data-action="start-edit-spec"
                onClick={() => cancelEditSpec()}
              >
                {t(language, "common.cancel")}
              </button>
              <button
                className="btn primary xs"
                type="button"
                data-testid="save-spec-btn"
                disabled={busy}
                onClick={() => void saveSpec()}
              >
                {t(language, "spec.save")}
              </button>
            </div>
          ) : (
            s.stage !== "done" &&
            s.stage !== "cancelled" &&
            s.stage !== "blocked" && (
              <button
                className="btn xs"
                type="button"
                data-action="start-edit-spec"
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
                {t(language, "spec.edit")}
              </button>
            )
          )}
        </div>

        {editingSpec ? (
          <div data-testid="spec-editor">
            <input
              className="input"
              id="spec-title-input"
              value={specDraftTitle}
              placeholder={t(language, "spec.titlePlaceholder")}
              style={{ marginBottom: 8 }}
              onChange={(e) => setSpecDraftTitle(e.target.value)}
            />
            <textarea
              className="textarea"
              id="spec-body-input"
              value={specDraftBody}
              onChange={(e) => setSpecDraftBody(e.target.value)}
            />
            <div style={{ marginTop: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <strong style={{ fontSize: 13 }}>{t(language, "spec.criteriaTitle")}</strong>
                <button
                  className="btn xs"
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
                </button>
              </div>
              {specDraftCriteria.map((c, idx) => (
                <div key={idx} className="crit-edit-row" data-criterion-idx={idx}>
                  <input
                    className="input"
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
                  <input
                    className="input"
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
                  <input
                    className="input"
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
                  <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
                    <input
                      type="checkbox"
                      checked={c.required}
                      onChange={(e) =>
                        setSpecDraftCriteria((prev) => {
                          const next = [...prev];
                          next[idx] = { ...next[idx]!, required: e.target.checked };
                          return next;
                        })
                      }
                    />{" "}
                    {t(language, "common.required")}
                  </label>
                  <button
                    className="btn ghost xs"
                    type="button"
                    onClick={() => setSpecDraftCriteria((prev) => prev.filter((_, i) => i !== idx))}
                  >
                    {t(language, "common.delete")}
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <MarkdownView markdown={d.specMarkdown} annotatable docLabel="spec.md" onAnnotate={openAnnotate} />
        )}
      </div>

      <div className="card" data-testid="requirement-attachments-card">
        <div className="card-head">
          <h3>{t(language, "spec.attachmentTitle", { count: attachments.length })}</h3>
          {!canEditAttachments && <span className="badge neutral">{t(language, "spec.frozen")}</span>}
        </div>
        <AttachmentGallery
          attachments={attachments}
          urlFor={(attId) => requirementAttachmentUrl(s.id, attId)}
          onDelete={canEditAttachments ? (attId) => void deleteAttachment(attId) : undefined}
          emptyText={
            canEditAttachments ? t(language, "spec.attachmentsEmpty") : t(language, "spec.attachmentsEmptyReadonly")
          }
        />
        {canEditAttachments && (
          <div style={{ marginTop: 10 }}>
            <AttachmentPicker value={[]} onChange={(metas) => void addAttachments(metas)} disabled={busy} />
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h3>
            {t(language, "spec.criteriaHeading", {
              passed: validity.coverage.requiredPassed,
              total: validity.coverage.requiredTotal,
            })}
          </h3>
          {validity.evidenceContext !== "live" && (
            <span
              className={`badge ${validity.evidenceContext === "accepted" ? "success" : "warning"}`}
              data-testid="coverage-context-badge"
            >
              {validity.evidenceContext === "accepted"
                ? t(language, "spec.coverageAccepted")
                : t(language, "spec.coverageLegacy")}
            </span>
          )}
        </div>
        {validity.evidenceContext !== "live" && (() => {
          const evInfo = describeEvidenceContext(validity, null, language);
          return (
            <div
              className={`callout ${evInfo.tone}`}
              data-testid="evidence-provenance-banner"
              style={{ marginBottom: 10, fontSize: 12.5 }}
            >
              <strong>{evInfo.title}</strong>
              {evInfo.acceptedAtText
                ? t(language, "spec.evidenceAcceptedAt", { time: evInfo.acceptedAtText })
                : ""}
              <div className="muted" style={{ marginTop: 2 }}>
                {evInfo.provenanceText}
              </div>
              {evInfo.unavailableReason && (
                <div style={{ marginTop: 4 }}>{evInfo.unavailableReason}</div>
              )}
            </div>
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
                <span className={`badge ${meta.tone}`}>
                  <Icon icon={COVERAGE_ICONS[item.state]} size={14} />
                  {meta.labels[language]}
                </span>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 500 }}>
                    <span className="req-id" style={{ marginRight: 6 }}>
                      {item.criterion.id}
                    </span>
                    {item.criterion.description}
                    <span className="badge neutral" style={{ marginLeft: 6 }}>
                      {item.criterion.required
                        ? t(language, "common.required")
                        : t(language, "common.reference")}
                    </span>
                  </div>
                  {item.criterion.command && <div className="crit-cmd">{item.criterion.command}</div>}
                  {(item.reason || item.reasonKey) && (
                    <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                      {translateRef(language, item.reasonKey, item.reason ?? "", item.reasonParams)}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <button
                    className="btn ghost xs"
                    type="button"
                    data-action="annotate-anchor"
                    data-anchor={t(language, "spec.criterionAnchor", { id: item.criterion.id })}
                    title={t(language, "spec.annotateTitle")}
                    aria-label={t(language, "spec.annotateTitle")}
                    onClick={() => openAnnotate(t(language, "spec.criterionAnchor", { id: item.criterion.id }))}
                  >
                    <Icon icon={MessageSquare} size={14} />
                  </button>
                  {item.criterion.command && s.stage !== "done" && s.stage !== "cancelled" && (
                    <button
                      className="btn xs"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void executeVerify(s.id, {
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
                      {t(language, "spec.run")}
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h3>
            {t(language, "spec.designTitle", {
              version: s.designVersion > 0 ? t(language, "spec.versionSuffix", { version: activeVer }) : "",
            })}
          </h3>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {(d.designMarkdown.trim() || s.tasks.length > 0) && s.stage !== "cancelled" && !editingDesign && (
              <button
                className="btn xs"
                type="button"
                data-testid="spawn-children-btn"
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
              </button>
            )}
            {historyVers.length > 1 && (
              <button
                className="btn xs"
                type="button"
                data-action="toggle-design-diff"
                onClick={() => void toggleDesignDiff()}
              >
                {designComparePrev
                  ? t(language, "spec.closeCompare")
                  : t(language, "spec.compare", { prev: activeVer - 1, curr: activeVer })}
              </button>
            )}
            {editingDesign ? (
              <>
                <button
                  className="btn xs"
                  type="button"
                  data-action="add-criterion"
                  onClick={() => cancelEditDesign()}
                >
                  {t(language, "common.cancel")}
                </button>
                <button
                  className="btn primary xs"
                  type="button"
                  data-testid="save-design-btn"
                  disabled={busy}
                  onClick={() => void saveDesign()}
                >
                  {t(language, "spec.saveDesign")}
                </button>
              </>
            ) : (
              s.stage !== "done" &&
              s.stage !== "cancelled" &&
              s.stage !== "blocked" && (
                <button
                  className="btn xs"
                  type="button"
                  data-testid="start-edit-design-btn"
                  onClick={() => {
                    setMoreMenuOpen(false);
                    startEditDesign(d.designMarkdown);
                  }}
                >
                  {t(language, "spec.editDesign")}
                </button>
              )
            )}
          </div>
        </div>

        {editingDesign ? (
          <div data-testid="design-editor">
            <textarea
              className="textarea"
              id="design-body-input"
              data-testid="design-body-input"
              style={{ minHeight: 220, fontFamily: "var(--mono)", fontSize: 12.5 }}
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
      </div>

      {d.subRequirements && d.subRequirements.length > 0 && (
        <div className="card" data-testid="sub-requirements-card">
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
                <button
                  key={child.id}
                  type="button"
                  className="btn ghost"
                  data-testid={`sub-req-link-${child.id}`}
                  style={{ justifyContent: "space-between", textAlign: "left", padding: "6px 8px" }}
                  onClick={() => void openRequirement(child.id)}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    <span className="req-id">{child.id}</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {child.title}
                    </span>
                  </span>
                  <span className={`badge ${meta.tone}`}>{meta.labels[language]}</span>
                </button>
              );
            })}
          </div>
        </div>
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

function ScreenshotEvidenceSection({ d }: { d: RequirementDetail }) {
  const language = useUiStore((s) => s.language);
  const showToastKey = useUiStore((s) => s.showToastKey);
  const [capturing, setCapturing] = useState(false);
  const [lightbox, setLightbox] = useState<{ batchId: string; index: number } | null>(null);
  const isDone = d.state.stage === "done";
  const frozen = d.acceptanceSnapshot?.screenshots;
  const batches = (frozen && frozen.length > 0 ? frozen : d.state.screenshotBatches ?? []).slice().reverse();
  const currentHash = d.validity.provenance.codeSnapshotHash;
  const canCapture = d.state.stage === "implementing" || d.state.stage === "awaiting_acceptance";
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
    <div className="card" data-testid="screenshot-section">
      <div className="card-head">
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <h3>{t(language, "shot.title")}</h3>
          {isDone && <span className="badge success">{t(language, "shot.frozen")}</span>}
        </div>
        {canCapture && (
          <button
            className="btn xs"
            type="button"
            data-testid="screenshot-recapture"
            disabled={capturing}
            onClick={() => void recapture()}
          >
            <Icon icon={RefreshCw} size={14} />{" "}
            {capturing ? t(language, "shot.capturing") : t(language, "shot.captureAgain")}
          </button>
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
              ? { label: t(language, "shot.status.captured"), tone: "success" }
              : batch.status === "partial"
                ? { label: t(language, "shot.status.partial"), tone: "warning" }
                : { label: t(language, "shot.status.skipped"), tone: "warning" };
          return (
            <div key={batch.id} className="screenshot-batch" data-testid={`screenshot-batch-${batch.id}`}>
              <div className="screenshot-batch-head">
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span className={`badge ${statusMeta.tone}`}>{statusMeta.label}</span>
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    {formatDateTime(batch.createdAt, language)} ·{" "}
                    {batch.trigger === "auto_submit"
                      ? t(language, "shot.trigger.auto")
                      : t(language, "shot.trigger.manual")}{" "}
                    · {pluralScreenshots(language, batch.shots.length)}
                  </span>
                  <span className={`badge ${fingerprintMatch ? "success" : "warning"}`} data-testid="screenshot-fingerprint-badge">
                    {fingerprintMatch ? t(language, "shot.match") : t(language, "shot.stale")}
                  </span>
                </div>
                <span className="muted" style={{ fontSize: 11.5 }}>
                  {batch.codeSnapshotHash.slice(0, 8)}
                </span>
              </div>

              {batch.skipReason && (
                <div className="callout warning" style={{ margin: "8px 0", fontSize: 12.5 }} data-testid="screenshot-skip-reason">
                  {batch.skipReason}
                </div>
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
        <ModalShell wide onClose={() => setLightbox(null)} testId="screenshot-lightbox">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>{activeShot.label}</h3>
            <span className="muted" style={{ fontSize: 12 }}>
              {t(language, "shot.counter", {
                index: lightbox.index + 1,
                total: activeBatch.shots.length,
                viewport: activeShot.viewport,
                theme: activeShot.theme === "dark" ? t(language, "shot.theme.dark") : t(language, "shot.theme.light"),
              })}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
            <button
              className="btn xs"
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
              {t(language, "shot.prev")}
            </button>
            <img
              className="screenshot-lightbox-image"
              data-testid="screenshot-lightbox-image"
              src={screenshotUrl(d.state.id, activeShot.id)}
              alt={activeShot.label}
            />
            <button
              className="btn xs"
              type="button"
              data-testid="screenshot-lightbox-next"
              onClick={() =>
                setLightbox((prev) =>
                  prev ? { ...prev, index: (prev.index + 1) % activeBatch.shots.length } : prev,
                )
              }
            >
              {t(language, "shot.next")}
            </button>
          </div>
          <div className="modal-actions">
            <button className="btn" type="button" onClick={() => setLightbox(null)}>
              {t(language, "common.closeEsc")}
            </button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}

function ChangesVerifyTab({ d, bridgeConnected }: { d: RequirementDetail; bridgeConnected: boolean }) {
  const language = useUiStore((s) => s.language);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const busy = useUiStore((s) => s.busy);
  const selectedDiffFile = useUiStore((s) => s.selectedDiffFile);
  const expandedLogs = useUiStore((s) => s.expandedLogs);
  const setSelectedDiffFile = useUiStore((s) => s.setSelectedDiffFile);
  const showToast = useUiStore((s) => s.showToast);
  const showToastKey = useUiStore((s) => s.showToastKey);

  const [manualCmd, setManualCmd] = useState("");
  const [manualCriteria, setManualCriteria] = useState("");
  const [showLiveComparison, setShowLiveComparison] = useState(false);

  const setWorkspaceTab = useUiStore((s) => s.setWorkspaceTab);
  const { state: s, validity } = d;
  const review = s.reviewReport;
  const revValid = validity.reviewValidity;
  const isDone = s.stage === "done";
  const isTerminal = isDone || s.stage === "cancelled";
  const { data: diffRes } = useDiffQuery(activeProjectId, s.id, true, false);
  const { data: liveDiffRes } = useDiffQuery(activeProjectId, s.id, isDone && showLiveComparison, true);
  const diffObs = diffRes?.observation ?? diffRes?.changes ?? null;
  const liveDiffObs = liveDiffRes?.observation ?? liveDiffRes?.changes ?? null;
  const evidenceSummary = describeEvidenceContext(validity, diffRes ?? null, language);

  const tasksDone = s.tasks.filter((t) => t.status === "done").length;

  const grouped = new Map<string, { command: string; latest: (typeof validity.verifications)[number] }>();
  for (const ev of validity.verifications) {
    grouped.set(ev.record.command, { command: ev.record.command, latest: ev });
  }
  const evCards = Array.from(grouped.values()).reverse();

  const parsedFiles = diffObs ? parseUnifiedDiff(diffObs.diff) : [];
  const activeDiffFile = parsedFiles.find((f) => f.path === selectedDiffFile) ?? parsedFiles[0] ?? null;
  const liveParsedFiles = liveDiffObs ? parseUnifiedDiff(liveDiffObs.diff) : [];

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
        <div
          className={`callout ${revValid.effectiveState === "stale" ? "warning" : VERDICT_META[review.verdict].tone}`}
          data-testid="changes-review-callout"
          style={{ marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 3 }}>
              <Icon icon={AlertTriangle} size={14} />
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
              <button
                className="btn primary xs"
                type="button"
                disabled={busy}
                onClick={() => void dispatchFixFromReview(d, bridgeConnected)}
              >
                <Icon icon={Wrench} size={14} /> {t(language, "core.action.fixPerReview")}
              </button>
            )}
            <button
              className="btn xs"
              type="button"
              disabled={busy}
              onClick={() => setWorkspaceTab("spec")}
            >
              {t(language, "review.viewFull")}
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3>{t(language, "changes.tasks", { done: tasksDone, total: s.tasks.length })}</h3>
        </div>
        {s.tasks.length === 0 ? (
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            {t(language, "changes.tasksEmpty")}
          </p>
        ) : (
          s.tasks.map((task) => {
            const tm = TASK_META[task.status];
            return (
              <div key={task.id} className="task-row">
                <span className={`badge ${tm.tone}`}>
                  <Icon icon={TASK_ICONS[task.status]} size={14} />
                  {tm.labels[language]}
                </span>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 500 }}>{task.title}</div>
                  {task.note && (
                    <div className="muted" style={{ fontSize: 12 }}>
                      {task.note}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h3>{t(language, "changes.evidenceTitle")}</h3>
          {s.criteria.some((c) => c.command) && s.stage !== "done" && s.stage !== "cancelled" && (
            <button
              className="btn primary xs"
              type="button"
              disabled={busy}
              onClick={() => void handleBannerAction(d, "run_all_verifications", bridgeConnected)}
            >
              {t(language, "changes.runAll")}
            </button>
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
                  <div>
                    <span className={`badge ${meta.tone}`}>{meta.labels[language]}</span>
                    <code style={{ marginLeft: 8, fontSize: 12.5 }}>{command}</code>
                    <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
                      {latest.record.durationMs}ms ·{" "}
                      {t(language, "changes.criteriaLinked", {
                        ids: latest.record.criterionIds.join(", ") || t(language, "changes.criteriaNone"),
                      })}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      className="btn xs"
                      type="button"
                      data-action="toggle-log"
                      onClick={() => void toggleVerificationLog(s.id, latest.record.id)}
                    >
                      {log !== undefined ? t(language, "changes.hideLog") : t(language, "changes.viewOutput")}
                    </button>
                    {!isTerminal && (
                      <button
                        className="btn xs"
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void executeVerify(s.id, { command, criterionIds: latest.record.criterionIds }).then((res) => {
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
                        {t(language, "changes.rerun")}
                      </button>
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
            <input
              className="input"
              id="manual-verify-cmd"
              placeholder={t(language, "changes.manualCmdPlaceholder")}
              style={{ flex: 2, minWidth: 180 }}
              value={manualCmd}
              onChange={(e) => setManualCmd(e.target.value)}
            />
            <input
              className="input"
              id="manual-verify-criteria"
              placeholder={t(language, "changes.manualCriteriaPlaceholder")}
              style={{ flex: 1, minWidth: 120 }}
              value={manualCriteria}
              onChange={(e) => setManualCriteria(e.target.value)}
            />
            <button
              className="btn"
              type="button"
              data-testid="manual-verify-btn"
              disabled={busy}
              onClick={() => void runManualVerify()}
            >
              {t(language, "changes.runVerify")}
            </button>
          </div>
        )}
      </div>

      <ScreenshotEvidenceSection d={d} />

      <div className="card">
        <div className="card-head">
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <h3>{isDone ? t(language, "changes.diffTitleDone") : t(language, "changes.diffTitleLive")}</h3>
            {isDone && (
              <span
                className={`badge ${evidenceSummary.tone === "success" ? "success" : "warning"}`}
                data-testid="diff-context-badge"
              >
                {evidenceSummary.title}
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {isDone ? (
              <button
                className="btn xs"
                type="button"
                data-testid="toggle-live-diff-btn"
                onClick={() => setShowLiveComparison((prev) => !prev)}
              >
                {showLiveComparison ? t(language, "changes.hideCompare") : t(language, "changes.compareLive")}
              </button>
            ) : (
              <button
                className="btn xs"
                type="button"
                onClick={() => {
                  void queryClient.invalidateQueries({ queryKey: queryKeys.diff(activeProjectId, s.id, false) });
                  showToastKey("changes.refreshedDiff");
                }}
              >
                {t(language, "changes.refreshDiff")}
              </button>
            )}
          </div>
        </div>
        {isDone && (
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }} data-testid="diff-provenance-meta">
            {evidenceSummary.acceptedAtText && (
              <span>{t(language, "spec.evidenceTimeLabel", { time: evidenceSummary.acceptedAtText })} · </span>
            )}
            <span>{evidenceSummary.provenanceText}</span>
            {evidenceSummary.scopeNote && <div>{evidenceSummary.scopeNote}</div>}
          </div>
        )}
        {evidenceSummary.truncationFlags.length > 0 && (
          <div className="callout warning" data-testid="diff-truncation-notice" style={{ marginBottom: 10, fontSize: 12.5 }}>
            {evidenceSummary.truncationFlags.join(t(language, "changes.truncJoin"))}
          </div>
        )}
        {!diffRes ? (
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            {t(language, "changes.loading")}
          </p>
        ) : diffRes.status === "unavailable" || !diffObs ? (
          <div className="callout warning" data-testid="diff-unavailable-notice" style={{ fontSize: 13, margin: 0 }}>
            <strong>{t(language, "changes.unavailable")}</strong>：
            {translateRef(
              language,
              diffRes.reasonKey,
              evidenceSummary.unavailableReason ?? diffRes.reason ?? "",
              diffRes.reasonParams,
            ) || t(language, "changes.cannotLoad")}
          </div>
        ) : !diffObs.isGitRepo ? (
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            {t(language, "changes.notGit")}
          </p>
        ) : diffRes.status === "empty" || diffObs.files.length === 0 ? (
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            {isDone ? t(language, "changes.emptyDone") : t(language, "changes.emptyLive")}
          </p>
        ) : (
          <div className="diff-split">
            <div className="diff-files">
              {parsedFiles.map((f) => (
                <button
                  key={f.path}
                  className={`diff-file-btn ${activeDiffFile?.path === f.path ? "active" : ""}`}
                  type="button"
                  onClick={() => setSelectedDiffFile(f.path)}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.path}</span>
                  <span className="muted" style={{ fontSize: 11 }}>
                    +{f.additions}/-{f.deletions}
                  </span>
                </button>
              ))}
            </div>
            <div
              className="diff-code"
              dangerouslySetInnerHTML={{
                __html: activeDiffFile
                  ? renderDiffLinesHtml(activeDiffFile.lines)
                  : renderDiffLinesHtml(diffObs.diff.split("\n")),
              }}
            />
          </div>
        )}
      </div>

      {isDone && showLiveComparison && (
        <div className="card" data-testid="live-diff-comparison-card">
          <div className="card-head">
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <h3>{t(language, "changes.liveTitle")}</h3>
              <span className="badge info">{t(language, "changes.liveBadge")}</span>
            </div>
            <button
              className="btn xs"
              type="button"
              onClick={() => {
                void queryClient.invalidateQueries({ queryKey: queryKeys.diff(activeProjectId, s.id, true) });
                showToastKey("changes.refreshedCompare");
              }}
            >
              {t(language, "changes.refreshCompare")}
            </button>
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
                style={{ marginTop: 8, maxHeight: 320, overflow: "auto" }}
                dangerouslySetInnerHTML={{
                  __html: renderDiffLinesHtml(liveDiffObs.diff.split("\n")),
                }}
              />
            </div>
          )}
        </div>
      )}
    </>
  );
}

function TimelineRunsTab({ d }: { d: RequirementDetail }) {
  const language = useUiStore((s) => s.language);
  const events = [...d.state.timeline].reverse();
  const runs = [...(d.state.agentRuns ?? [])].reverse();

  return (
    <>
      {runs.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h3>{t(language, "timeline.runs")}</h3>
            <button className="btn xs" type="button" onClick={() => void openHandoff(d.state.id)}>
              {t(language, "timeline.viewHandoff")}
            </button>
          </div>
          {runs.map((r) => (
            <div
              key={r.id}
              className="timeline-item"
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}
            >
              <div>
                <span
                  className={`badge ${
                    r.status === "succeeded" ? "success" : r.status === "cancelled" ? "neutral" : "danger"
                  }`}
                >
                  {formatAgentActionLabel(language, r.action)} · {formatAgentStatusLabel(language, r.status)}
                </span>
                <strong style={{ fontSize: 13, marginLeft: 6 }}>
                  {r.harness} / {r.model}
                </strong>
                {r.modelFallback && r.effectiveModel && (
                  <span className="badge warning xs" style={{ marginLeft: 6 }}>
                    {t(language, "timeline.actual", { model: r.effectiveModel })}
                  </span>
                )}
                <span className="muted xs" style={{ marginLeft: 6 }}>
                  {r.durationMs}ms
                </span>
              </div>
              <button className="btn ghost xs" type="button" onClick={() => void openRunConsole(d.state.id, r.id)}>
                {t(language, "timeline.viewOutput")}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3>{t(language, "timeline.title")}</h3>
        </div>
        {events.map((ev, i) => (
          <div key={`${ev.at}-${i}`} className="timeline-item">
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
              <strong style={{ fontSize: 13.5 }}>{ev.summary}</strong>
              <span className="muted" style={{ fontSize: 12 }}>
                {formatDateTime(ev.at, language)}
              </span>
            </div>
            {ev.detail && (
              <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
                {ev.detail}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

export function WorkspaceView() {
  const language = useUiStore((s) => s.language);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const selectedId = useUiStore((s) => s.selectedId);
  const workspaceTab = useUiStore((s) => s.workspaceTab);
  const busy = useUiStore((s) => s.busy);
  const moreMenuOpen = useUiStore((s) => s.moreMenuOpen);
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
  const bridgeConnected = Boolean(project?.bridge.connected);

  const isGiteeProject =
    project?.remoteProvider === "gitee" ||
    Boolean(project?.project?.gitee) ||
    s.github?.provider === "gitee";
  const prPlatformLabel = isGiteeProject ? "Gitee" : "GitHub";

  const openDeliverModal = (preferPr?: boolean) => {
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
    }
  };

  const harnesses = hub?.harnesses ?? [];
  const modelOptions = collectModelOptions(harnesses);
  const defaultAct = defaultActionForRequirement(d);
  const activeRun =
    Object.values(activeRuns).find(
      (r) =>
        r.requirementId === s.id &&
        r.status === "running" &&
        (!r.projectId || r.projectId === activeProjectId),
    ) ?? null;
  const runningThis = Boolean(activeRun);
  const canRunModel =
    s.stage !== "done" && s.stage !== "cancelled" && s.stage !== "blocked" && modelOptions.length > 0;
  const canReview =
    modelOptions.length > 0 && (s.stage === "implementing" || s.stage === "awaiting_acceptance");

  return (
    <div className="workspace-detail" data-testid="workspace-detail">
      <div className="workspace-pinned" data-testid="workspace-pinned">
        <StageStepper d={d} running={runningThis} />

        <div className="ws-head">
        <span className="req-id" style={{ fontSize: 14 }}>
          {s.id}
        </span>
        {s.parentId && (
          <button
            type="button"
            className="badge info"
            data-testid="ws-parent-link"
            style={{ cursor: "pointer", border: "none" }}
            onClick={() => void openRequirement(s.parentId!)}
          >
            <Icon icon={ArrowUp} size={14} /> {t(language, "ws.parentLink", { id: s.parentId })}
          </button>
        )}
        <h1 className="ws-title">{s.title}</h1>
        {reqData?.sandbox && (
          <span
            className="badge info"
            data-testid="sandbox-active-badge"
            title={t(language, "ws.sandboxTitle", { branch: reqData.sandbox.branch })}
          >
            {t(language, "ws.sandboxActive")}
          </span>
        )}
        {s.github?.issue && (
          <a
            className={`badge ${s.github.issue.state === "closed" ? "neutral" : "info"}`}
            href={s.github.issue.url}
            target="_blank"
            rel="noreferrer"
            data-testid="ws-github-issue-link"
            title={s.github.issue.title}
          >
            <Icon icon={Link2} size={14} /> Issue #{s.github.issue.number}
          </a>
        )}
        {s.github?.pr && (
          <a
            className={`badge ${s.github.pr.state === "merged" ? "success" : s.github.pr.state === "closed" ? "neutral" : "info"}`}
            href={s.github.pr.url}
            target="_blank"
            rel="noreferrer"
            data-testid="ws-github-pr-link"
            title={s.github.pr.title}
          >
            <Icon icon={GitPullRequest} size={14} /> PR #{s.github.pr.number} · {formatPrStateLabel(language, s.github.pr.state)}
          </a>
        )}
        <span className={`badge ${stageMeta.tone}`} data-testid="ws-stage-badge">
          {stageMeta.labels[language]}
        </span>
        <div className="more-wrap">
          <DropdownRoot open={moreMenuOpen} onOpenChange={setMoreMenuOpen}>
            <DropdownTrigger asChild>
              <button className="btn" type="button" data-testid="more-menu-btn">
                <Icon icon={Ellipsis} /> {t(language, "ws.more")}
              </button>
            </DropdownTrigger>
            <DropdownPortal>
              <DropdownContent className="more-menu" data-testid="more-menu" align="end" sideOffset={6}>
                <DropdownItem asChild>
                  <button
                    type="button"
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
                  >
                    {t(language, "ws.menu.editReq")}
                  </button>
                </DropdownItem>
                <DropdownItem asChild>
                  <button type="button" onClick={() => startEditDesign(d.designMarkdown)}>
                    {t(language, "ws.menu.editDesign")}
                  </button>
                </DropdownItem>
                <DropdownItem asChild>
                  <button type="button" onClick={() => void openHandoff(s.id)}>
                    {t(language, "ws.menu.handoff")}
                  </button>
                </DropdownItem>
                {!s.github?.issue ? (
                  <DropdownItem asChild>
                    <button
                      type="button"
                      data-testid="menu-link-issue-btn"
                      onClick={() => {
                        setModal({
                          kind: "link_issue",
                          requirementId: s.id,
                          provider: isGiteeProject ? "gitee" : "github",
                          mode: isGiteeProject ? "link" : "create",
                          issueRef: "",
                        });
                      }}
                    >
                      {t(language, isGiteeProject ? "ws.menu.linkGitee" : "ws.menu.linkIssue")}
                    </button>
                  </DropdownItem>
                ) : s.github.provider !== "gitee" ? (
                  <DropdownItem asChild>
                    <button
                      type="button"
                      data-testid="menu-sync-issue-btn"
                      onClick={async () => {
                        const out = await runBusy(() => api.syncRequirementIssue(s.id));
                        if (out) {
                          await invalidateAllWorkbenchQueries();
                          showToastKey("toast.gitHubSynced", { number: s.github!.issue!.number });
                        }
                      }}
                    >
                      {t(language, "ws.menu.syncIssue", { number: s.github.issue.number })}
                    </button>
                  </DropdownItem>
                ) : null}
                {(s.stage === "draft" || s.stage === "designing" || s.stage === "awaiting_approval") && (
                  <DropdownItem asChild>
                    <button
                      type="button"
                      onClick={() => {
                        void handleBannerAction(d, "fast_track", bridgeConnected);
                      }}
                    >
                      {t(language, "ws.menu.fastTrack")}
                    </button>
                  </DropdownItem>
                )}
                {s.stage !== "blocked" && s.stage !== "done" && s.stage !== "cancelled" && (
                  <DropdownItem asChild>
                    <button
                      type="button"
                      onClick={() => {
                        setModal({ kind: "lifecycle", action: "block", reason: "" });
                      }}
                    >
                      {t(language, "ws.menu.block")}
                    </button>
                  </DropdownItem>
                )}
                {s.stage !== "done" && s.stage !== "cancelled" && (
                  <DropdownItem asChild>
                    <button
                      type="button"
                      onClick={() => {
                        setModal({ kind: "lifecycle", action: "cancel", reason: "" });
                      }}
                    >
                      {t(language, "ws.menu.cancel")}
                    </button>
                  </DropdownItem>
                )}
                {(s.stage === "done" || s.stage === "cancelled") && (
                  <DropdownItem asChild>
                    <button
                      type="button"
                      onClick={() => {
                        setModal({ kind: "lifecycle", action: "reopen", reason: "" });
                      }}
                    >
                      {t(language, "ws.menu.reopen")}
                    </button>
                  </DropdownItem>
                )}
                <DropdownItem asChild>
                  <button
                    type="button"
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
                  >
                    {t(language, "ws.menu.debug")}
                  </button>
                </DropdownItem>
              </DropdownContent>
            </DropdownPortal>
          </DropdownRoot>
        </div>
      </div>

      {s.lastFeedback && (
        <div className="callout warning" style={{ marginBottom: 14 }}>
          <strong>{t(language, "ws.lastFeedback")}</strong>
          {s.lastFeedback}
        </div>
      )}

      {reqData?.sandbox &&
        reqData.sandboxDrift &&
        s.stage !== "done" &&
        s.stage !== "cancelled" &&
        (reqData.sandboxDrift.behindCount > 0 || reqData.sandboxDrift.conflictFiles.length > 0) && (
          <div
            className={`callout ${reqData.sandboxDrift.conflictFiles.length > 0 ? "danger" : "warning"}`}
            data-testid="sandbox-drift-callout"
            style={{
              marginBottom: 14,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <Icon icon={GitBranch} size={14} />
                <strong>
                  {t(language, "ws.sandboxDrift.title", {
                    branch: reqData.sandboxDrift.branch,
                    count: reqData.sandboxDrift.behindCount,
                  })}
                </strong>
                {reqData.sandboxDrift.conflictFiles.length > 0 && (
                  <span className="badge danger">
                    {t(language, "ws.sandboxDrift.conflictBadge", {
                      count: reqData.sandboxDrift.conflictFiles.length,
                    })}
                  </span>
                )}
              </div>
              {reqData.sandboxDrift.conflictFiles.length > 0 ? (
                <div className="xs" style={{ marginTop: 4 }}>
                  {t(language, "ws.sandboxDrift.conflictDetail", {
                    files:
                      reqData.sandboxDrift.conflictFiles.slice(0, 6).join(language === "en" ? ", " : "、") +
                      (reqData.sandboxDrift.conflictFiles.length > 6 ? "…" : ""),
                  })}
                </div>
              ) : (
                <div className="xs muted" style={{ marginTop: 4 }}>
                  {t(language, "ws.sandboxDrift.safeDetail")}
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {reqData.sandboxDrift.canAutoSync && (
                <button
                  className="btn primary xs"
                  type="button"
                  data-testid="sync-sandbox-base-btn"
                  disabled={busy || runningThis}
                  onClick={() => void syncSandboxBaseAction(s.id)}
                >
                  <Icon icon={RefreshCw} size={14} /> {t(language, "ws.sandboxDrift.sync")}
                </button>
              )}
              {reqData.sandboxDrift.conflictFiles.length > 0 && (
                <button
                  className="btn primary xs"
                  type="button"
                  data-testid="agent-sync-sandbox-btn"
                  disabled={busy || runningThis}
                  onClick={() => void dispatchSyncBaseWithAgent(d, reqData.sandboxDrift!, bridgeConnected)}
                >
                  <Icon icon={Wrench} size={14} /> {t(language, "ws.sandboxDrift.syncWithAgent")}
                </button>
              )}
            </div>
          </div>
        )}

      <section className={`banner ${banner.tone}`} data-testid="action-banner">
        <div>
          <div className="banner-text">
            {translateRef(language, banner.headlineKey, banner.headline, banner.headlineParams)}
          </div>
          {s.stage === "awaiting_approval" && project?.git?.isGitRepo && project.git.dirty && (
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
              <RunnerSelect stageAction={defaultAct} testId="banner-runner-select" includeManualCopy />
              <button
                className="btn xs"
                type="button"
                data-testid="run-selected-model-btn"
                disabled={busy || runningThis}
                onClick={() => void triggerActiveRun(s.id, defaultAct)}
              >
                {runningThis ? (
                  t(language, "ws.running")
                ) : (
                  <>
                    <Icon icon={Zap} size={14} /> {t(language, "ws.runBackground")}
                  </>
                )}
              </button>
              {canReview && (
                <button
                  className="btn xs"
                  type="button"
                  data-testid="run-review-btn"
                  disabled={busy || runningThis}
                  onClick={() => void triggerActiveRun(s.id, "review")}
                >
                  <Icon icon={Search} size={14} /> {t(language, "ws.crossReview")}
                </button>
              )}
            </div>
          )}
        </div>
        <div className="banner-actions">
          {banner.primaryAction && (
            <button
              className="btn primary"
              type="button"
              data-testid={`action-${banner.primaryAction.id}`}
              disabled={busy}
              onClick={() => void handleBannerAction(d, banner.primaryAction!.id, bridgeConnected)}
            >
              {translateRef(
                language,
                banner.primaryAction.labelKey,
                banner.primaryAction.label,
                banner.primaryAction.labelParams,
              )}
            </button>
          )}
          {banner.secondaryActions.map((sec) => (
            <button
              key={sec.id}
              className="btn"
              type="button"
              data-testid={`action-${sec.id}`}
              disabled={busy}
              onClick={() => void handleBannerAction(d, sec.id, bridgeConnected)}
            >
              {translateRef(language, sec.labelKey, sec.label, sec.labelParams)}
            </button>
          ))}
          {s.stage === "done" && (deliveryPreview?.canCommit || deliveryPreview?.canCreatePr) && (
            <button
              className={s.delivery ? "btn" : "btn primary"}
              type="button"
              data-testid="open-deliver-btn"
              disabled={busy}
              onClick={() => openDeliverModal(Boolean(reqData?.sandbox && deliveryPreview?.canCreatePr))}
            >
              {reqData?.sandbox && deliveryPreview?.canCreatePr
                ? s.github?.pr
                  ? t(language, "ws.deliverPrAppend")
                  : t(language, "ws.deliverPrCreatePlatform", { platform: prPlatformLabel })
                : s.delivery
                  ? t(language, "ws.deliverMore")
                  : t(language, "ws.deliverStart")}
            </button>
          )}
          {s.stage === "done" && s.github?.pr && (
            <button
              className="btn"
              type="button"
              data-testid="sync-pr-btn"
              disabled={busy}
              onClick={() => void syncPrStatus()}
            >
              <Icon icon={RefreshCw} size={14} />{" "}
              {reqData?.sandbox ? t(language, "ws.syncPrCleanup") : t(language, "ws.syncPr")}
            </button>
          )}
          {reqData?.sandbox && s.stage === "done" && (
            <button
              className="btn"
              type="button"
              data-testid="apply-sandbox-btn"
              disabled={busy}
              onClick={async () => {
                const res = await runBusy(() => api.applyRsiSandbox(s.id));
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
                }
              }}
            >
              {deliveryPreview?.canCreatePr ? t(language, "ws.applySandboxLocal") : t(language, "ws.applySandbox")}
            </button>
          )}
        </div>
      </section>

      {activeRun && <LiveAgentBanner run={activeRun} />}
      </div>

      <div className="tabs" data-testid="workspace-tabs">
        <button
          className={`tab ${workspaceTab === "spec" ? "active" : ""}`}
          type="button"
          data-testid="tab-spec"
          onClick={() => setWorkspaceTab("spec")}
        >
          {t(language, "ws.tab.spec")}
        </button>
        <button
          className={`tab ${workspaceTab === "changes" ? "active" : ""}`}
          type="button"
          data-testid="tab-changes"
          onClick={() => setWorkspaceTab("changes")}
        >
          {t(language, "ws.tab.changes")}
        </button>
        <button
          className={`tab ${workspaceTab === "timeline" ? "active" : ""}`}
          type="button"
          data-testid="tab-timeline"
          onClick={() => setWorkspaceTab("timeline")}
        >
          {t(language, "ws.tab.timeline")}
        </button>
      </div>

      <div className="workspace-tab-scroll" data-testid="workspace-tab-scroll">
        {workspaceTab === "spec" ? (
          <SpecDesignTab d={d} bridgeConnected={bridgeConnected} />
        ) : workspaceTab === "changes" ? (
          <ChangesVerifyTab d={d} bridgeConnected={bridgeConnected} />
        ) : (
          <TimelineRunsTab d={d} />
        )}
      </div>
    </div>
  );
}
