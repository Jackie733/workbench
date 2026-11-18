import { useEffect, useState } from "react";
import {
  Content as DropdownContent,
  Item as DropdownItem,
  Portal as DropdownPortal,
  Root as DropdownRoot,
  Trigger as DropdownTrigger,
} from "@radix-ui/react-dropdown-menu";
import { Ellipsis, GitPullRequest, Link2, MessageSquare, Plus, RefreshCw, Search, Zap } from "lucide-react";
import type { AgentRunRecord, RequirementDetail, ScreenshotBatch, Stage } from "../../core/types.ts";
import { api, requirementAttachmentUrl, screenshotUrl } from "../api.ts";
import {
  captureUiScreenshots,
  cancelRun,
  executeVerify,
  handleBannerAction,
  invalidateAllWorkbenchQueries,
  openHandoff,
  openRunConsole,
  queryClient,
  queryKeys,
  runBusy,
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
  const stage = d.state.stage;
  const delivered = Boolean(d.state.delivery);
  const steps = [
    { key: "draft", label: "1. 需求草稿" },
    { key: "designing", label: "2. 方案设计" },
    { key: "awaiting_approval", label: "3. 人工审阅" },
    { key: "implementing", label: "4. 编码与验证" },
    { key: "done", label: "5. 验收完成" },
    { key: "delivered", label: "6. 交付收尾" },
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
  const setDrawerTab = useUiStore((s) => s.setDrawerTab);
  const setDrawerOpen = useUiStore((s) => s.setDrawerOpen);
  const selectedId = useUiStore((s) => s.selectedId);
  const liveText = useStreamStore((s) => s.liveRunLogs[run.id] ?? "");

  const actionLabels: Record<string, string> = {
    design: "梳理规范与方案设计",
    implement: "编写代码与运行验证",
    fix: "诊断并修复失败项",
    review: "独立跨模型审查",
    ask: "实时探讨解答",
  };
  const lines = liveText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("$ "));
  const latestLine = lines[lines.length - 1]?.slice(0, 140) ?? "已连接模型进程，等待首段输出…";

  return (
    <section className="live-agent-banner" data-testid="live-agent-banner">
      <div className="live-agent-head">
        <div className="live-agent-title">
          <span className="pulse-dot" />
          <strong>Agent 正在执行 · {actionLabels[run.action] ?? run.action}</strong>
          <span className="badge info">
            {run.harness}/{run.model}
          </span>
          {run.modelFallback && run.effectiveModel && (
            <span className="badge warning">降级·实际 {run.effectiveModel}</span>
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
            查看终端流
          </button>
          <button
            className="btn danger xs"
            type="button"
            onClick={() => selectedId && void cancelRun(selectedId, run.id)}
          >
            终止
          </button>
        </div>
      </div>
      <div className="live-progress-track" aria-hidden="true">
        <div className="live-shimmer-bar" />
      </div>
      <div className="live-preview-row">
        <span className="muted xs">实时动态：</span>
        <code className="live-preview-line" data-testid="live-banner-preview">
          {latestLine}
        </code>
      </div>
    </section>
  );
}

function SpecDesignTab({ d }: { d: RequirementDetail }) {
  const busy = useUiStore((s) => s.busy);
  const designViewVersion = useUiStore((s) => s.designViewVersion);
  const designComparePrev = useUiStore((s) => s.designComparePrev);
  const designCompareText = useUiStore((s) => s.designCompareText);
  const setModal = useUiStore((s) => s.setModal);
  const showToast = useUiStore((s) => s.showToast);
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
    if (res) showToast(`已添加 ${metas.length} 个附件`);
  };

  const deleteAttachment = async (attId: string) => {
    if (typeof window !== "undefined" && !window.confirm("确认删除该附件？删除后不可恢复。")) return;
    const res = await runBusy(async () => {
      const out = await api.deleteRequirementAttachment(s.id, attId);
      await invalidateAllWorkbenchQueries();
      return out;
    });
    if (res) showToast("附件已删除");
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
    if (res) showToast("已保存规范与验收条件");
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
    if (res) showToast("已保存技术方案");
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
              <h3>跨模型 Code Review</h3>
              <span className={`badge ${VERDICT_META[review.verdict].tone}`}>{VERDICT_META[review.verdict].label}</span>
              <span className={`badge ${revValid.effectiveState === "current" ? "info" : "warning"}`}>
                {revValid.effectiveState === "current" ? "当前快照有效" : "代码已变·建议复审"}
              </span>
              <span className="muted xs">
                {review.reviewerHarness} · {review.reviewerModel}
              </span>
            </div>
            <button
              className="btn xs"
              type="button"
              disabled={busy}
              onClick={() => void triggerActiveRun(s.id, "review")}
            >
              <Icon icon={Search} size={14} /> 重新审查
            </button>
          </div>
          <div style={{ fontWeight: 500, marginBottom: 6 }}>{review.summary}</div>
          <details>
            <summary className="xs muted" style={{ cursor: "pointer" }}>
              展开完整审查意见
            </summary>
            <MarkdownView markdown={review.markdown} className="md-body xs" />
          </details>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3>需求目标与范围（spec.md）</h3>
          {editingSpec ? (
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="btn xs"
                type="button"
                data-action="start-edit-spec"
                onClick={() => cancelEditSpec()}
              >
                取消
              </button>
              <button
                className="btn primary xs"
                type="button"
                data-testid="save-spec-btn"
                disabled={busy}
                onClick={() => void saveSpec()}
              >
                保存规范与条件
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
                编辑规范与条件
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
              placeholder="需求标题"
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
                <strong style={{ fontSize: 13 }}>验收条件清单</strong>
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
                  <Icon icon={Plus} size={14} /> 添加条件
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
                    placeholder="条件描述"
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
                    placeholder="验证命令（可选）"
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
                    必需
                  </label>
                  <button
                    className="btn ghost xs"
                    type="button"
                    onClick={() => setSpecDraftCriteria((prev) => prev.filter((_, i) => i !== idx))}
                  >
                    删除
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
          <h3>附件（{attachments.length}）</h3>
          {!canEditAttachments && <span className="badge neutral">已验收冻结</span>}
        </div>
        <AttachmentGallery
          attachments={attachments}
          urlFor={(attId) => requirementAttachmentUrl(s.id, attId)}
          onDelete={canEditAttachments ? (attId) => void deleteAttachment(attId) : undefined}
          emptyText={canEditAttachments ? "暂无附件，可补充截图、日志或复现文件。" : "暂无附件。"}
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
            验收条件（必需 {validity.coverage.requiredPassed}/{validity.coverage.requiredTotal}）
          </h3>
          {validity.evidenceContext !== "live" && (
            <span
              className={`badge ${validity.evidenceContext === "accepted" ? "success" : "warning"}`}
              data-testid="coverage-context-badge"
            >
              {validity.evidenceContext === "accepted" ? "已固化验收快照" : "历史覆盖恢复（无完整快照）"}
            </span>
          )}
        </div>
        {validity.evidenceContext !== "live" && (() => {
          const evInfo = describeEvidenceContext(validity);
          return (
            <div
              className={`callout ${evInfo.tone}`}
              data-testid="evidence-provenance-banner"
              style={{ marginBottom: 10, fontSize: 12.5 }}
            >
              <strong>{evInfo.title}</strong>
              {evInfo.acceptedAtText ? ` · 验收时间 ${evInfo.acceptedAtText}` : ""}
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
            尚未定义验收条件。可让 Agent 在方案中自动补全，或手动编辑添加。
          </p>
        ) : (
          validity.coverage.items.map((item) => {
            const meta = COVERAGE_META[item.state];
            return (
              <div key={item.criterion.id} className="criteria-row" data-testid={`crit-${item.criterion.id}`}>
                <span className={`badge ${meta.tone}`}>
                  <Icon icon={COVERAGE_ICONS[item.state]} size={14} />
                  {meta.label}
                </span>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 500 }}>
                    <span className="req-id" style={{ marginRight: 6 }}>
                      {item.criterion.id}
                    </span>
                    {item.criterion.description}
                    <span className="badge neutral" style={{ marginLeft: 6 }}>
                      {item.criterion.required ? "必需" : "参考"}
                    </span>
                  </div>
                  {item.criterion.command && <div className="crit-cmd">{item.criterion.command}</div>}
                  {item.reason && (
                    <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                      {item.reason}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <button
                    className="btn ghost xs"
                    type="button"
                    data-action="annotate-anchor"
                    data-anchor={`条件 ${item.criterion.id}`}
                    title="对此条件提问或批注"
                    aria-label="对此条件提问或批注"
                    onClick={() => openAnnotate(`条件 ${item.criterion.id}`)}
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
                            showToast(
                              res.runs[0]?.passed ? `${item.criterion.id} 验证通过` : `${item.criterion.id} 验证未通过`,
                              !res.runs[0]?.passed,
                            );
                          }
                        })
                      }
                    >
                      运行
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
          <h3>技术方案（design.md{s.designVersion > 0 ? ` · v${activeVer}` : ""}）</h3>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {historyVers.length > 1 && (
              <button
                className="btn xs"
                type="button"
                data-action="toggle-design-diff"
                onClick={() => void toggleDesignDiff()}
              >
                {designComparePrev ? "关闭版本对比" : `对比 v${activeVer - 1} → v${activeVer}`}
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
                  取消
                </button>
                <button
                  className="btn primary xs"
                  type="button"
                  data-testid="save-design-btn"
                  disabled={busy}
                  onClick={() => void saveDesign()}
                >
                  保存方案修改
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
                  直接编辑方案
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
            尚未生成技术方案正文（快速通道模式可留空）。
          </p>
        )}
      </div>
    </>
  );
}

function ScreenshotEvidenceSection({ d }: { d: RequirementDetail }) {
  const showToast = useUiStore((s) => s.showToast);
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
          showToast(`截图证据已更新（${capture.batch?.shots.length ?? 0} 张）`);
        } else if (capture.status === "partial") {
          showToast(`截图部分完成（${capture.batch?.shots.length ?? 0} 张），存在跳过项`, true);
        } else {
          showToast(capture.reason ?? "截图采集已跳过", true);
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
          <h3>UI 截图证据</h3>
          {isDone && <span className="badge success">已随验收快照固化</span>}
        </div>
        {canCapture && (
          <button
            className="btn xs"
            type="button"
            data-testid="screenshot-recapture"
            disabled={capturing}
            onClick={() => void recapture()}
          >
            <Icon icon={RefreshCw} size={14} /> {capturing ? "采集中…" : "重新采集"}
          </button>
        )}
      </div>

      {batches.length === 0 ? (
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          {isDone
            ? "本次验收未固化截图证据。"
            : "尚未采集截图证据。UI 相关需求在提交验收时会自动采集，也可点击「重新采集」立即补采。"}
        </p>
      ) : (
        batches.map((batch) => {
          const fingerprintMatch = Boolean(currentHash && batch.codeSnapshotHash === currentHash);
          const statusMeta =
            batch.status === "captured"
              ? { label: "采集完整", tone: "success" }
              : batch.status === "partial"
                ? { label: "部分采集", tone: "warning" }
                : { label: "已跳过", tone: "warning" };
          return (
            <div key={batch.id} className="screenshot-batch" data-testid={`screenshot-batch-${batch.id}`}>
              <div className="screenshot-batch-head">
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span className={`badge ${statusMeta.tone}`}>{statusMeta.label}</span>
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    {formatDateTime(batch.createdAt)} · {batch.trigger === "auto_submit" ? "提交验收时自动采集" : "手动补采"} ·{" "}
                    {batch.shots.length} 张
                  </span>
                  <span className={`badge ${fingerprintMatch ? "success" : "warning"}`} data-testid="screenshot-fingerprint-badge">
                    {fingerprintMatch ? "与当前代码一致" : "基于旧代码采集"}
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
                        {shot.viewport} · {shot.theme === "dark" ? "暗色" : "明色"}
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
              第 {lightbox.index + 1}/{activeBatch.shots.length} 张 · {activeShot.viewport} ·{" "}
              {activeShot.theme === "dark" ? "暗色" : "明色"}
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
              上一张
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
              下一张
            </button>
          </div>
          <div className="modal-actions">
            <button className="btn" type="button" onClick={() => setLightbox(null)}>
              关闭 (Esc)
            </button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}

function ChangesVerifyTab({ d, bridgeConnected }: { d: RequirementDetail; bridgeConnected: boolean }) {
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const busy = useUiStore((s) => s.busy);
  const selectedDiffFile = useUiStore((s) => s.selectedDiffFile);
  const expandedLogs = useUiStore((s) => s.expandedLogs);
  const setSelectedDiffFile = useUiStore((s) => s.setSelectedDiffFile);
  const showToast = useUiStore((s) => s.showToast);

  const [manualCmd, setManualCmd] = useState("");
  const [manualCriteria, setManualCriteria] = useState("");
  const [showLiveComparison, setShowLiveComparison] = useState(false);

  const { state: s, validity } = d;
  const isDone = s.stage === "done";
  const isTerminal = isDone || s.stage === "cancelled";
  const { data: diffRes } = useDiffQuery(activeProjectId, s.id, true, false);
  const { data: liveDiffRes } = useDiffQuery(activeProjectId, s.id, isDone && showLiveComparison, true);
  const diffObs = diffRes?.observation ?? diffRes?.changes ?? null;
  const liveDiffObs = liveDiffRes?.observation ?? liveDiffRes?.changes ?? null;
  const evidenceSummary = describeEvidenceContext(validity, diffRes ?? null);

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
      showToast("请先输入验证命令", true);
      return;
    }
    const cids = manualCriteria
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const res = await executeVerify(s.id, { command, criterionIds: cids });
    if (res) showToast(res.runs[0]?.passed ? "验证通过" : "验证未通过", !res.runs[0]?.passed);
  };

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h3>
            实施任务清单（{tasksDone}/{s.tasks.length}）
          </h3>
        </div>
        {s.tasks.length === 0 ? (
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            Agent 开始实施后将在此自动维护步骤进度。
          </p>
        ) : (
          s.tasks.map((t) => {
            const tm = TASK_META[t.status];
            return (
              <div key={t.id} className="task-row">
                <span className={`badge ${tm.tone}`}>
                  <Icon icon={TASK_ICONS[t.status]} size={14} />
                  {tm.label}
                </span>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 500 }}>{t.title}</div>
                  {t.note && (
                    <div className="muted" style={{ fontSize: 12 }}>
                      {t.note}
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
          <h3>真实验证证据</h3>
          {s.criteria.some((c) => c.command) && s.stage !== "done" && s.stage !== "cancelled" && (
            <button
              className="btn primary xs"
              type="button"
              disabled={busy}
              onClick={() => void handleBannerAction(d, "run_all_verifications", bridgeConnected)}
            >
              运行全部验证
            </button>
          )}
        </div>

        {evCards.length === 0 ? (
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            尚未运行任何验证命令。
          </p>
        ) : (
          evCards.map(({ command, latest }) => {
            const meta = EVIDENCE_META[latest.effectiveState];
            const log = expandedLogs[latest.record.id];
            return (
              <div key={latest.record.id} className="evidence-card" data-testid={`ev-${latest.record.id}`}>
                <div className="evidence-head">
                  <div>
                    <span className={`badge ${meta.tone}`}>{meta.label}</span>
                    <code style={{ marginLeft: 8, fontSize: 12.5 }}>{command}</code>
                    <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
                      {latest.record.durationMs}ms · 关联 {latest.record.criterionIds.join(", ") || "无"}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      className="btn xs"
                      type="button"
                      data-action="toggle-log"
                      onClick={() => void toggleVerificationLog(s.id, latest.record.id)}
                    >
                      {log !== undefined ? "收起日志" : "查看输出"}
                    </button>
                    {!isTerminal && (
                      <button
                        className="btn xs"
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void executeVerify(s.id, { command, criterionIds: latest.record.criterionIds }).then((res) => {
                            if (res) showToast(res.runs[0]?.passed ? "验证通过" : "验证失败", !res.runs[0]?.passed);
                          })
                        }
                      >
                        重跑
                      </button>
                    )}
                  </div>
                </div>
                {latest.staleReason && (
                  <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                    {latest.staleReason}
                  </div>
                )}
                {log !== undefined && <pre className="evidence-log">{log || "（无输出）"}</pre>}
              </div>
            );
          })
        )}

        {!isTerminal && (
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <input
              className="input"
              id="manual-verify-cmd"
              placeholder="手动运行命令，如 bun test"
              style={{ flex: 2, minWidth: 180 }}
              value={manualCmd}
              onChange={(e) => setManualCmd(e.target.value)}
            />
            <input
              className="input"
              id="manual-verify-criteria"
              placeholder="关联条件 ID，如 AC-1"
              style={{ flex: 1, minWidth: 120 }}
              value={manualCriteria}
              onChange={(e) => setManualCriteria(e.target.value)}
            />
            <button
              className="btn"
              type="button"
              disabled={busy}
              onClick={() => void runManualVerify()}
            >
              执行验证
            </button>
          </div>
        )}
      </div>

      <ScreenshotEvidenceSection d={d} />

      <div className="card">
        <div className="card-head">
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <h3>{isDone ? "验收代码改动快照（Git Diff）" : "代码改动（Git Diff）"}</h3>
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
                {showLiveComparison ? "收起当前工作区对比" : "对比当前工作区"}
              </button>
            ) : (
              <button
                className="btn xs"
                type="button"
                onClick={() => {
                  void queryClient.invalidateQueries({ queryKey: queryKeys.diff(activeProjectId, s.id, false) });
                  showToast("已刷新工作区 Git Diff");
                }}
              >
                刷新 Diff
              </button>
            )}
          </div>
        </div>
        {isDone && (
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }} data-testid="diff-provenance-meta">
            {evidenceSummary.acceptedAtText && <span>验收时间：{evidenceSummary.acceptedAtText} · </span>}
            <span>{evidenceSummary.provenanceText}</span>
            {evidenceSummary.scopeNote && <div>{evidenceSummary.scopeNote}</div>}
          </div>
        )}
        {evidenceSummary.truncationFlags.length > 0 && (
          <div className="callout warning" data-testid="diff-truncation-notice" style={{ marginBottom: 10, fontSize: 12.5 }}>
            {evidenceSummary.truncationFlags.join("；")}
          </div>
        )}
        {!diffRes ? (
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            正在加载代码变更…
          </p>
        ) : diffRes.status === "unavailable" || !diffObs ? (
          <div className="callout warning" data-testid="diff-unavailable-notice" style={{ fontSize: 13, margin: 0 }}>
            <strong>历史代码差异不可用</strong>：{diffRes.reason ?? evidenceSummary.unavailableReason ?? "无法获取快照"}
          </div>
        ) : !diffObs.isGitRepo ? (
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            当前目录不是 Git 仓库。
          </p>
        ) : diffRes.status === "empty" || diffObs.files.length === 0 ? (
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            {isDone ? "本次验收记录无代码变更（空 Diff）。" : "自基线以来工作区暂无代码变更。"}
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
              <h3>当前工作区实时对比</h3>
              <span className="badge info">实时工作区（非验收快照）</span>
            </div>
            <button
              className="btn xs"
              type="button"
              onClick={() => {
                void queryClient.invalidateQueries({ queryKey: queryKeys.diff(activeProjectId, s.id, true) });
                showToast("已刷新当前工作区对比");
              }}
            >
              刷新对比
            </button>
          </div>
          {!liveDiffRes ? (
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>
              正在读取当前工作区对比…
            </p>
          ) : liveDiffRes.status === "unavailable" || !liveDiffObs ? (
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>
              当前工作区对比不可用：{liveDiffRes.reason ?? "无法读取"}
            </p>
          ) : liveDiffObs.files.length === 0 ? (
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>
              当前工作区相对基线暂无变更。
            </p>
          ) : (
            <div className="muted" style={{ fontSize: 12.5 }}>
              当前工作区变更文件 {liveDiffObs.files.length} 个（解析补丁 {liveParsedFiles.length} 个），与已固化的验收快照独立展示。
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
  const events = [...d.state.timeline].reverse();
  const runs = [...(d.state.agentRuns ?? [])].reverse();

  return (
    <>
      {runs.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h3>Agent 模型执行历史</h3>
            <button className="btn xs" type="button" onClick={() => void openHandoff(d.state.id)}>
              查看交接简报 handoff.md
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
                  {r.action} · {r.status}
                </span>
                <strong style={{ fontSize: 13, marginLeft: 6 }}>
                  {r.harness} / {r.model}
                </strong>
                {r.modelFallback && r.effectiveModel && (
                  <span className="badge warning xs" style={{ marginLeft: 6 }}>
                    实际 {r.effectiveModel}
                  </span>
                )}
                <span className="muted xs" style={{ marginLeft: 6 }}>
                  {r.durationMs}ms
                </span>
              </div>
              <button className="btn ghost xs" type="button" onClick={() => void openRunConsole(d.state.id, r.id)}>
                查看终端输出
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3>时间线</h3>
        </div>
        {events.map((ev, i) => (
          <div key={`${ev.at}-${i}`} className="timeline-item">
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
              <strong style={{ fontSize: 13.5 }}>{ev.summary}</strong>
              <span className="muted" style={{ fontSize: 12 }}>
                {formatDateTime(ev.at)}
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
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const selectedId = useUiStore((s) => s.selectedId);
  const workspaceTab = useUiStore((s) => s.workspaceTab);
  const busy = useUiStore((s) => s.busy);
  const moreMenuOpen = useUiStore((s) => s.moreMenuOpen);
  const setWorkspaceTab = useUiStore((s) => s.setWorkspaceTab);
  const setMoreMenuOpen = useUiStore((s) => s.setMoreMenuOpen);
  const setModal = useUiStore((s) => s.setModal);
  const showToast = useUiStore((s) => s.showToast);

  const startEditSpec = useDraftStore((s) => s.startEditSpec);
  const startEditDesign = useDraftStore((s) => s.startEditDesign);
  const activeRuns = useStreamStore((s) => s.activeRuns);

  const { data: hub } = useHubStateQuery();
  const { data: project } = useProjectQuery(activeProjectId);
  const { data: reqData } = useRequirementQuery(activeProjectId, selectedId);
  const isDoneStage = reqData?.detail?.state.stage === "done";
  const { data: deliveryPreview } = useDeliveryQuery(activeProjectId, selectedId, Boolean(isDoneStage));

  const d = reqData?.detail ?? null;
  if (!d) return <p className="muted">正在加载需求详情…</p>;

  const { state: s, validity } = d;
  const stageMeta = STAGE_META[s.stage];
  const { banner } = validity;
  const bridgeConnected = Boolean(project?.bridge.connected);

  const openDeliverModal = (preferPr?: boolean) => {
    const candidates = deliveryPreview?.candidates ?? [];
    const matched = candidates.filter((c) => c.inAcceptedSnapshot).map((c) => c.path);
    const defaultSelected = matched.length > 0 ? matched : candidates.map((c) => c.path);
    const usePr = preferPr ?? Boolean(reqData?.sandbox && deliveryPreview?.canCreatePr);
    setModal({
      kind: "deliver",
      commitMessage: deliveryPreview?.suggestedMessage ?? `feat(${s.id.toLowerCase()}): ${s.title}`,
      selectedFiles: defaultSelected,
      note: "",
      createPr: usePr,
      branchName: deliveryPreview?.suggestedBranch ?? `feat/${s.id.toLowerCase()}`,
      baseBranch: deliveryPreview?.baseBranch ?? "main",
      prTitle: `${s.id}: ${s.title}`,
    });
  };

  const syncPrStatus = async () => {
    const res = await runBusy(() => api.syncRequirementPr(s.id));
    if (res) {
      await invalidateAllWorkbenchQueries();
      if (res.pr.state === "merged") {
        showToast(
          res.cleanedSandbox
            ? `PR #${res.pr.number} 已合并并清理沙箱${res.mainUpdated ? "（主干已同步）" : res.mainSyncReason ? `（${res.mainSyncReason}）` : ""}`
            : `PR #${res.pr.number} 已合并`,
        );
      } else {
        showToast(`PR #${res.pr.number} 当前状态：${res.pr.state}`);
      }
    }
  };

  const harnesses = hub?.harnesses ?? [];
  const modelOptions = collectModelOptions(harnesses);
  const defaultAct = defaultActionForRequirement(d);
  const activeRun =
    Object.values(activeRuns).find((r) => r.requirementId === s.id && r.status === "running") ?? null;
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
        <h1 className="ws-title">{s.title}</h1>
        {reqData?.sandbox && (
          <span
            className="badge info"
            data-testid="sandbox-active-badge"
            title={`沙箱分支: ${reqData.sandbox.branch}（验收通过后可推送分支提 PR 或应用到主干）`}
          >
            沙箱隔离中
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
            <Icon icon={GitPullRequest} size={14} /> PR #{s.github.pr.number} · {s.github.pr.state}
          </a>
        )}
        <span className={`badge ${stageMeta.tone}`} data-testid="ws-stage-badge">
          {stageMeta.label}
        </span>
        <div className="more-wrap">
          <DropdownRoot open={moreMenuOpen} onOpenChange={setMoreMenuOpen}>
            <DropdownTrigger asChild>
              <button className="btn" type="button" data-testid="more-menu-btn">
                <Icon icon={Ellipsis} /> 更多
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
                    编辑需求与验收条件
                  </button>
                </DropdownItem>
                <DropdownItem asChild>
                  <button type="button" onClick={() => startEditDesign(d.designMarkdown)}>
                    直接编辑技术方案
                  </button>
                </DropdownItem>
                <DropdownItem asChild>
                  <button type="button" onClick={() => void openHandoff(s.id)}>
                    查看交接简报 handoff.md
                  </button>
                </DropdownItem>
                {!s.github?.issue ? (
                  <DropdownItem asChild>
                    <button
                      type="button"
                      data-testid="menu-link-issue-btn"
                      onClick={() => {
                        setModal({ kind: "link_issue", requirementId: s.id, mode: "create", issueRef: "" });
                      }}
                    >
                      关联 / 创建 GitHub Issue…
                    </button>
                  </DropdownItem>
                ) : (
                  <DropdownItem asChild>
                    <button
                      type="button"
                      data-testid="menu-sync-issue-btn"
                      onClick={async () => {
                        const out = await runBusy(() => api.syncRequirementIssue(s.id));
                        if (out) {
                          await invalidateAllWorkbenchQueries();
                          showToast(`已同步状态至 Issue #${s.github!.issue!.number}`);
                        }
                      }}
                    >
                      同步当前状态到 Issue #{s.github.issue.number}
                    </button>
                  </DropdownItem>
                )}
                {(s.stage === "draft" || s.stage === "designing" || s.stage === "awaiting_approval") && (
                  <DropdownItem asChild>
                    <button
                      type="button"
                      onClick={() => {
                        void handleBannerAction(d, "fast_track", bridgeConnected);
                      }}
                    >
                      切换快速通道
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
                      标记阻塞
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
                      取消需求
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
                      重新打开
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
                    查看调试信息
                  </button>
                </DropdownItem>
              </DropdownContent>
            </DropdownPortal>
          </DropdownRoot>
        </div>
      </div>

      {s.lastFeedback && (
        <div className="callout warning" style={{ marginBottom: 14 }}>
          <strong>最新退回意见：</strong>
          {s.lastFeedback}
        </div>
      )}

      <section className={`banner ${banner.tone}`} data-testid="action-banner">
        <div>
          <div className="banner-text">{banner.headline}</div>
          {s.stage === "awaiting_approval" && project?.git?.isGitRepo && project.git.dirty && (
            <div className="muted xs" style={{ marginTop: 4 }} data-testid="dirty-baseline-hint">
              提示：当前主工作区存在未提交变更，批准后将以当前脏工作区作为基线。
            </div>
          )}
          {s.stage === "done" && s.delivery && (
            <div className="muted xs" style={{ marginTop: 4 }} data-testid="delivery-summary-line">
              已交付提交 <code>{s.delivery.shortHash}</code>
              {s.delivery.branch ? ` · 分支 ${s.delivery.branch}` : ""} · {s.delivery.files.length} 个文件 ·{" "}
              {formatDateTime(s.delivery.deliveredAt)}
              {s.github?.pr && ` · PR #${s.github.pr.number} (${s.github.pr.state})`}
            </div>
          )}
          {s.stage === "done" && !s.delivery && !deliveryPreview?.sandboxActive && deliveryPreview?.canCommit && (
            <div className="muted xs" style={{ marginTop: 4 }} data-testid="delivery-pending-hint">
              工作区尚有 {deliveryPreview.candidates.length} 个未提交变更，建议完成 Git 交付提交以保持下一条需求基线干净。
            </div>
          )}
          {s.stage === "done" && deliveryPreview?.sandboxActive && !s.github?.pr && (
            <div className="muted xs" style={{ marginTop: 4 }} data-testid="delivery-sandbox-hint">
              {deliveryPreview.canCreatePr
                ? `改动位于沙箱分支 ${deliveryPreview.branch ?? reqData?.sandbox?.branch}，建议推送分支并创建标准化 GitHub PR（也可本地应急应用）。`
                : "改动仍在隔离沙箱中，可点击「应用沙箱改动」合并到主干，或配置 GitHub 远端后提交 PR。"}
            </div>
          )}
          {canRunModel && (
            <div className="banner-runner-row">
              <span className="xs muted">模型调度：</span>
              <RunnerSelect stageAction={defaultAct} testId="banner-runner-select" includeManualCopy />
              <button
                className="btn xs"
                type="button"
                data-testid="run-selected-model-btn"
                disabled={busy || runningThis}
                onClick={() => void triggerActiveRun(s.id, defaultAct)}
              >
                {runningThis ? "执行中…" : (
                  <>
                    <Icon icon={Zap} size={14} /> 后台执行
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
                  <Icon icon={Search} size={14} /> 跨模型审查
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
              {banner.primaryAction.label}
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
              {sec.label}
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
                  ? "追加提交 / 更新 PR…"
                  : "提交并创建 GitHub PR…"
                : s.delivery
                  ? "补充交付提交…"
                  : "提交代码交付…"}
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
              {reqData?.sandbox ? "同步 PR 状态并清理沙箱" : "同步 PR 状态"}
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
                  showToast(
                    res.webReloaded
                      ? `已应用沙箱改动（${res.appliedFiles.length} 个文件）并热刷新前端`
                      : res.restartRecommended
                        ? `已应用沙箱改动（${res.appliedFiles.length} 个文件），后端变动建议执行 wb restart 生效`
                        : `已应用沙箱改动（${res.appliedFiles.length} 个文件）`,
                  );
                }
              }}
            >
              {deliveryPreview?.canCreatePr ? "本地应急应用" : "应用沙箱改动"}
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
          规范与方案
        </button>
        <button
          className={`tab ${workspaceTab === "changes" ? "active" : ""}`}
          type="button"
          data-testid="tab-changes"
          onClick={() => setWorkspaceTab("changes")}
        >
          变更与验证
        </button>
        <button
          className={`tab ${workspaceTab === "timeline" ? "active" : ""}`}
          type="button"
          data-testid="tab-timeline"
          onClick={() => setWorkspaceTab("timeline")}
        >
          时间线与运行
        </button>
      </div>

      <div className="workspace-tab-scroll" data-testid="workspace-tab-scroll">
        {workspaceTab === "spec" ? (
          <SpecDesignTab d={d} />
        ) : workspaceTab === "changes" ? (
          <ChangesVerifyTab d={d} bridgeConnected={bridgeConnected} />
        ) : (
          <TimelineRunsTab d={d} />
        )}
      </div>
    </div>
  );
}
