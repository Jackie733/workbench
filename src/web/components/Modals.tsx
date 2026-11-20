import { useRef } from "react";
import {
  AlertTriangle,
  ArrowUp,
  Check,
  Crosshair,
  ExternalLink,
  Flame,
  Folder,
  GitPullRequest,
  Globe,
  Laptop,
  Lightbulb,
  Link2,
  Pencil,
  RefreshCw,
  Server,
  Sparkles,
  Trash2,
  Zap,
} from "lucide-react";
import type { StructuredMessageRef } from "../../core/errors.ts";
import type { GitRemoteProvider, OutputLanguage, PrivacyMode, Track } from "../../core/types.ts";
import type { PainPointCategory } from "../../hub/evolution.ts";
import {
  ROUTING_STAGES,
  type HarnessId,
  type ReasoningEffort,
  type RoutingPreset,
  type RoutingStage,
} from "../../hub/types.ts";
import { api, evolutionAttachmentUrl, setApiProjectScope, type HubStateResponse } from "../api.ts";
import {
  dispatchSyncBaseWithAgent,
  invalidateAllWorkbenchQueries,
  notifyCascadeSyncResults,
  openRequirement,
  queryClient,
  queryKeys,
  runBusy,
  submitAcceptOverride,
  submitAnnotation,
  submitFeedback,
  submitImportGiteeIssue,
  submitImportGitHubIssue,
  submitLifecycle,
  submitNewRequirement,
  syncSandboxBaseAction,
  useDeliveryQuery,
  useEvolutionQuery,
  useGiteeIssuesQuery,
  useGiteeStatusQuery,
  useGitHubStatusQuery,
  useHubStateQuery,
  usePlaybookQuery,
  useProjectQuery,
  useProjectSandboxesQuery,
  useRequirementQuery,
} from "../queries.ts";
import {
  describeClientError,
  describeClientErrorRef,
  formatAgentActionLabel,
  formatGitFileStatusLabel,
  formatGiteeStatusReason,
  formatGitHubStatusReason,
  formatPrStateLabel,
  prStateRef,
  resolveWarningParam,
  t,
  translateRef,
  type MessageKey,
} from "../i18n.ts";
import { effortLabel, formatDateTime, formatReviewFixFeedback, getModelEffortCapability, parseRunnerKey } from "../state.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { AttachmentGallery } from "./AttachmentGallery.tsx";
import { AttachmentPicker } from "./AttachmentPicker.tsx";
import { Icon } from "./Icon.tsx";
import { MarkdownView, ModalShell } from "./Primitives.tsx";
import { RoutingModelPicker } from "./ui/RoutingModelPicker.tsx";

const STAGE_LABEL_KEYS: Record<RoutingStage, MessageKey> = {
  design: "routing.stage.design",
  implement: "routing.stage.implement",
  fix: "routing.stage.fix",
  review: "routing.stage.review",
};

const PRESET_KEYS: Array<{ id: RoutingPreset; nameKey: MessageKey; descKey: MessageKey }> = [
  { id: "balanced", nameKey: "preset.balanced.name", descKey: "preset.balanced.desc" },
  { id: "sota_first", nameKey: "preset.sota_first.name", descKey: "preset.sota_first.desc" },
  { id: "quota_saver", nameKey: "preset.quota_saver.name", descKey: "preset.quota_saver.desc" },
];

export function Modals() {
  const language = useUiStore((s) => s.language);
  const m = useUiStore((s) => s.modal);
  const busy = useUiStore((s) => s.busy);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const selectedId = useUiStore((s) => s.selectedId);
  const setModal = useUiStore((s) => s.setModal);
  const showToast = useUiStore((s) => s.showToast);
  const showToastKey = useUiStore((s) => s.showToastKey);
  const setActiveProjectId = useUiStore((s) => s.setActiveProjectId);
  const setSelectedId = useUiStore((s) => s.setSelectedId);
  const setSelectedDiffFile = useUiStore((s) => s.setSelectedDiffFile);
  const setQuery = useUiStore((s) => s.setQuery);

  const { data: hub } = useHubStateQuery();
  const noHubProject = Boolean(hub?.hubMode && hub.projects.length === 0);
  const { data: project } = useProjectQuery(activeProjectId);
  const { data: projectSandboxes } = useProjectSandboxesQuery(
    activeProjectId,
    Boolean(!noHubProject && project?.initialized && m?.kind === "new_req"),
  );
  const { data: reqData } = useRequirementQuery(activeProjectId, selectedId);
  const { data: evolutionData } = useEvolutionQuery(m?.kind === "evolution");
  const { data: playbookData } = usePlaybookQuery(
    activeProjectId,
    m?.kind === "evolution" && m.tab === "playbook" && !noHubProject,
  );
  const { data: deliveryPreview } = useDeliveryQuery(
    activeProjectId,
    selectedId,
    Boolean(selectedId && m?.kind === "deliver"),
  );
  const { data: githubStatus } = useGitHubStatusQuery(
    activeProjectId,
    Boolean(
      !noHubProject &&
        project?.initialized &&
        m &&
        (m.kind === "new_req" || m.kind === "routing" || m.kind === "link_issue" || m.kind === "deliver"),
    ),
  );
  const { data: giteeStatus } = useGiteeStatusQuery(
    activeProjectId,
    Boolean(
      !noHubProject &&
        project?.initialized &&
        m &&
        (m.kind === "new_req" || m.kind === "routing" || m.kind === "link_issue" || m.kind === "deliver"),
    ),
  );
  const isGiteeProject =
    project?.remoteProvider === "gitee" || Boolean(project?.project?.gitee);
  const giteeFilter = m?.kind === "new_req" ? (m.giteeFilter ?? "assigned") : "assigned";
  const giteeState = m?.kind === "new_req" ? (m.giteeState ?? "active") : "active";
  const giteeSearch = m?.kind === "new_req" ? (m.giteeSearch ?? "") : "";
  const giteeIssuesQuery = useGiteeIssuesQuery(
    activeProjectId,
    { filter: giteeFilter, state: giteeState, q: giteeSearch },
    Boolean(
      m?.kind === "new_req" &&
        m.mode === "import_issue" &&
        isGiteeProject &&
        giteeStatus?.authenticated,
    ),
  );

  const fallbackAreaRef = useRef<HTMLTextAreaElement | null>(null);
  if (!m) return null;

  const close = () => setModal(null);
  const bridgeConnected = Boolean(project?.bridge.connected);
  const harnesses = hub?.harnesses ?? [];
  const routing = hub?.routing ?? null;
  const detail = reqData?.detail ?? null;

  if (m.kind === "new_req") {
    const mode = m.mode ?? "create";
    const createIssueChecked =
      m.createGitHubIssue ?? Boolean(project?.project?.github?.autoCreateIssue && githubStatus?.ready);

    return (
      <ModalShell onClose={close} wide={mode === "import_issue" && isGiteeProject} testId="new-req-modal">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>{t(language, "newReq.title")}</h3>
          <div className="segmented" role="tablist" aria-label={t(language, "newReq.modeAria")}>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "create"}
              className={mode === "create" ? "active" : ""}
              data-testid="new-req-mode-create"
              onClick={() =>
                setModal((prev) => (prev?.kind === "new_req" ? { ...prev, mode: "create" } : prev))
              }
            >
              {t(language, "newReq.modeCreate")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "import_issue"}
              className={mode === "import_issue" ? "active" : ""}
              data-testid="new-req-mode-import"
              onClick={() =>
                setModal((prev) =>
                  prev?.kind === "new_req" ? { ...prev, mode: "import_issue", issueRef: prev.issueRef ?? "" } : prev,
                )
              }
            >
              {t(language, isGiteeProject ? "newReq.modeImportGitee" : "newReq.modeImport")}
            </button>
          </div>
        </div>

        {mode === "create" ? (
          <>
            <label className="muted" style={{ fontSize: 13, display: "block", marginBottom: 6 }}>
              {t(language, "newReq.goalLabel")}
            </label>
            <textarea
              className="textarea"
              id="new-req-goal"
              data-testid="new-req-goal"
              autoFocus
              value={m.goal}
              placeholder={t(language, "newReq.goalPlaceholder")}
              onChange={(e) =>
                setModal((prev) => (prev?.kind === "new_req" ? { ...prev, goal: e.target.value } : prev))
              }
            />
            <AttachmentPicker
              value={m.attachments ?? []}
              onChange={(attachments) =>
                setModal((prev) => (prev?.kind === "new_req" ? { ...prev, attachments } : prev))
              }
              disabled={busy}
            />
            {!isGiteeProject && (
              <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, fontSize: 13 }}>
                <input
                  type="checkbox"
                  data-testid="new-req-create-issue"
                  checked={createIssueChecked}
                  disabled={githubStatus !== undefined && !githubStatus.ready}
                  onChange={(e) =>
                    setModal((prev) =>
                      prev?.kind === "new_req" ? { ...prev, createGitHubIssue: e.target.checked } : prev,
                    )
                  }
                />
                <span>
                  {t(language, "newReq.syncIssue")}
                  {githubStatus?.repo ? ` (${githubStatus.repo})` : ""}
                  {githubStatus && !githubStatus.ready ? ` — ${formatGitHubStatusReason(language, githubStatus)}` : ""}
                </span>
              </label>
            )}
            {project?.git?.isGitRepo && (
              <div style={{ marginTop: 8 }}>
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                  <input
                    type="checkbox"
                    data-testid="new-req-create-sandbox"
                    checked={Boolean(m.createSandbox)}
                    onChange={(e) =>
                      setModal((prev) =>
                        prev?.kind === "new_req" ? { ...prev, createSandbox: e.target.checked } : prev,
                      )
                    }
                  />
                  <span>{t(language, "newReq.createSandbox")}</span>
                </label>
                {m.createSandbox && (projectSandboxes?.sandboxes.length ?? 0) > 0 && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, paddingLeft: 22 }}>
                    <span className="xs muted">{t(language, "newReq.stackedOn")}</span>
                    <select
                      className="select"
                      data-testid="new-req-stack-select"
                      value={m.stackedOnReqId ?? ""}
                      onChange={(e) =>
                        setModal((prev) =>
                          prev?.kind === "new_req"
                            ? { ...prev, stackedOnReqId: e.target.value || undefined }
                            : prev,
                        )
                      }
                    >
                      <option value="">{t(language, "newReq.stackMain")}</option>
                      {projectSandboxes!.sandboxes
                        .filter((sb) => sb.stage !== "cancelled")
                        .map((sb) => (
                          <option key={sb.requirementId} value={sb.requirementId}>
                            {sb.requirementId} ({sb.branch})
                          </option>
                        ))}
                    </select>
                  </div>
                )}
              </div>
            )}
            <div className="modal-actions">
              <button className="btn" type="button" onClick={close}>
                {t(language, "common.cancel")}
              </button>
              <button
                className="btn"
                type="button"
                data-testid="save-draft-btn"
                disabled={busy}
                onClick={() =>
                  void submitNewRequirement(
                    m.goal,
                    false,
                    bridgeConnected,
                    isGiteeProject ? false : createIssueChecked,
                    (m.attachments ?? []).map((a) => a.id),
                    { createSandbox: m.createSandbox, stackedOnReqId: m.stackedOnReqId },
                  )
                }
              >
                {t(language, "newReq.saveDraft")}
              </button>
              <button
                className="btn primary"
                type="button"
                data-testid="create-and-dispatch-btn"
                disabled={busy}
                onClick={() =>
                  void submitNewRequirement(
                    m.goal,
                    true,
                    bridgeConnected,
                    isGiteeProject ? false : createIssueChecked,
                    (m.attachments ?? []).map((a) => a.id),
                    { createSandbox: m.createSandbox, stackedOnReqId: m.stackedOnReqId },
                  )
                }
              >
                {t(language, "newReq.createDispatch")}
              </button>
            </div>
          </>
        ) : isGiteeProject ? (
          <div data-testid="gitee-import-pane">
            {giteeStatus && !giteeStatus.authenticated ? (
              <div className="callout warning xs" style={{ marginBottom: 10 }}>
                <div style={{ marginBottom: 6 }}>{formatGiteeStatusReason(language, giteeStatus)}</div>
                <button
                  className="btn xs"
                  type="button"
                  data-testid="goto-gitee-settings-btn"
                  onClick={() =>
                    setModal({
                      kind: "routing",
                      tab: "global",
                      draft: hub?.routing ?? null,
                    })
                  }
                >
                  {t(language, "gitee.gotoSettings")}
                </button>
              </div>
            ) : (
              <>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
                  <div className="segmented" role="tablist" aria-label={t(language, "gitee.filterAria")}>
                    {(
                      [
                        ["assigned", t(language, "gitee.filterAssigned")],
                        ["created", t(language, "gitee.filterCreated")],
                        ["all", t(language, "gitee.filterAll")],
                      ] as const
                    ).map(([val, label]) => (
                      <button
                        key={val}
                        type="button"
                        role="tab"
                        aria-selected={giteeFilter === val}
                        className={giteeFilter === val ? "active" : ""}
                        data-testid={`gitee-filter-${val}`}
                        onClick={() =>
                          setModal((prev) =>
                            prev?.kind === "new_req" ? { ...prev, giteeFilter: val, selectedGiteeIssue: null } : prev,
                          )
                        }
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <select
                    className="select"
                    aria-label={t(language, "gitee.stateAria")}
                    data-testid="gitee-state-select"
                    value={giteeState}
                    onChange={(e) =>
                      setModal((prev) =>
                        prev?.kind === "new_req"
                          ? {
                              ...prev,
                              giteeState: e.target.value as "active" | "open" | "progressing" | "closed" | "all",
                              selectedGiteeIssue: null,
                            }
                          : prev,
                      )
                    }
                  >
                    <option value="active">{t(language, "gitee.stateActive")}</option>
                    <option value="open">{t(language, "gitee.stateOpen")}</option>
                    <option value="progressing">{t(language, "gitee.stateProgressing")}</option>
                    <option value="closed">{t(language, "gitee.stateClosed")}</option>
                    <option value="all">{t(language, "gitee.stateAll")}</option>
                  </select>
                  <button
                    className="btn xs"
                    type="button"
                    data-testid="refresh-gitee-issues-btn"
                    disabled={giteeIssuesQuery.isFetching}
                    onClick={() => void giteeIssuesQuery.refetch()}
                  >
                    <Icon icon={RefreshCw} size={14} /> {t(language, "gitee.refresh")}
                  </button>
                </div>

                <input
                  className="input"
                  style={{ marginBottom: 8 }}
                  data-testid="gitee-issue-search"
                  value={giteeSearch}
                  placeholder={t(language, "gitee.searchPlaceholder")}
                  onChange={(e) =>
                    setModal((prev) =>
                      prev?.kind === "new_req" ? { ...prev, giteeSearch: e.target.value } : prev,
                    )
                  }
                />

                <div
                  data-testid="gitee-issue-list"
                  style={{
                    maxHeight: 240,
                    overflowY: "auto",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: 6,
                    marginBottom: 10,
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  {giteeIssuesQuery.isLoading ? (
                    <div className="muted xs" style={{ padding: 12, textAlign: "center" }}>
                      {t(language, "gitee.loading")}
                    </div>
                  ) : giteeIssuesQuery.isError ? (
                    <div className="callout danger xs">
                      {t(language, "gitee.loadFailed")}
                      {describeClientError(language, giteeIssuesQuery.error)}
                    </div>
                  ) : (giteeIssuesQuery.data?.items.length ?? 0) === 0 ? (
                    <div className="muted xs" style={{ padding: 12, textAlign: "center" }}>
                      {t(language, "gitee.empty")}
                      {giteeStatus?.enterprise
                        ? t(language, "gitee.enterpriseSuffix", { enterprise: giteeStatus.enterprise })
                        : ""}
                    </div>
                  ) : (
                    giteeIssuesQuery.data!.items.map((item) => {
                      const isSelected = m.selectedGiteeIssue?.ident === item.ident;
                      const stateTone =
                        item.state === "closed" || item.state === "rejected"
                          ? "neutral"
                          : item.state === "progressing"
                            ? "info"
                            : "warning";
                      return (
                        <div
                          key={item.ident}
                          data-testid={`gitee-issue-item-${item.ident}`}
                          onClick={() => {
                            if (item.importedRequirementId) return;
                            setModal((prev) =>
                              prev?.kind === "new_req"
                                ? { ...prev, selectedGiteeIssue: item, issueRef: item.ident }
                                : prev,
                            );
                          }}
                          style={{
                            padding: "8px 10px",
                            borderRadius: 6,
                            border: isSelected ? "1.5px solid var(--accent)" : "1px solid var(--border)",
                            background: isSelected ? "var(--bg-soft)" : "transparent",
                            cursor: item.importedRequirementId ? "default" : "pointer",
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: 8,
                          }}
                        >
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 2 }}>
                              <code className="xs">#{item.ident}</code>
                              {item.issueType && <span className="badge neutral">{item.issueType}</span>}
                              <span className={`badge ${stateTone}`}>{item.stateName ?? item.state}</span>
                              {item.programName && <span className="xs muted">{item.programName}</span>}
                              <span className="xs muted">
                                {item.repository ? item.repository : t(language, "gitee.unlinkedRepo")}
                              </span>
                            </div>
                            <div style={{ fontWeight: 500, fontSize: 13 }}>{item.title}</div>
                          </div>
                          {item.importedRequirementId && (
                            <button
                              className="btn xs"
                              type="button"
                              data-testid={`open-imported-gitee-${item.ident}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                setModal(null);
                                void openRequirement(item.importedRequirementId!);
                              }}
                            >
                              {t(language, "gitee.imported", { id: item.importedRequirementId })}
                            </button>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </>
            )}

            <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
              {t(language, "gitee.manualLabel")}
            </label>
            <input
              className="input"
              id="import-issue-ref"
              data-testid="import-issue-ref"
              value={m.issueRef ?? ""}
              placeholder={t(language, "gitee.manualPlaceholder")}
              onChange={(e) =>
                setModal((prev) =>
                  prev?.kind === "new_req"
                    ? { ...prev, issueRef: e.target.value, selectedGiteeIssue: null }
                    : prev,
                )
              }
            />
            <div className="modal-actions">
              <button className="btn" type="button" onClick={close}>
                {t(language, "common.cancel")}
              </button>
              <button
                className="btn"
                type="button"
                data-testid="import-issue-draft-btn"
                disabled={busy || (!m.selectedGiteeIssue && !(m.issueRef ?? "").trim())}
                onClick={() =>
                  void submitImportGiteeIssue({
                    issue: m.selectedGiteeIssue,
                    issueRef: m.issueRef,
                    dispatchAgent: false,
                  })
                }
              >
                {t(language, "gitee.importDraft")}
              </button>
              <button
                className="btn primary"
                type="button"
                data-testid="import-issue-dispatch-btn"
                disabled={busy || (!m.selectedGiteeIssue && !(m.issueRef ?? "").trim())}
                onClick={() =>
                  void submitImportGiteeIssue({
                    issue: m.selectedGiteeIssue,
                    issueRef: m.issueRef,
                    dispatchAgent: true,
                  })
                }
              >
                {t(language, "gitee.importDispatch")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <label className="muted" style={{ fontSize: 13, display: "block", marginBottom: 6 }}>
              {githubStatus?.repo
                ? t(language, "newReq.importLabelRepo", { repo: githubStatus.repo })
                : t(language, "newReq.importLabel")}
            </label>
            <input
              className="input"
              id="import-issue-ref"
              data-testid="import-issue-ref"
              autoFocus
              value={m.issueRef ?? ""}
              placeholder={t(language, "newReq.importPlaceholder")}
              onChange={(e) =>
                setModal((prev) => (prev?.kind === "new_req" ? { ...prev, issueRef: e.target.value } : prev))
              }
            />
            {githubStatus && !githubStatus.ready && (
              <div className="callout warning xs" style={{ marginTop: 8 }}>
                {formatGitHubStatusReason(language, githubStatus)}
              </div>
            )}
            <div className="modal-actions">
              <button className="btn" type="button" onClick={close}>
                {t(language, "common.cancel")}
              </button>
              <button
                className="btn"
                type="button"
                data-testid="import-issue-draft-btn"
                disabled={busy}
                onClick={() => void submitImportGitHubIssue(m.issueRef ?? "", false)}
              >
                {t(language, "newReq.importDraft")}
              </button>
              <button
                className="btn primary"
                type="button"
                data-testid="import-issue-dispatch-btn"
                disabled={busy}
                onClick={() => void submitImportGitHubIssue(m.issueRef ?? "", true)}
              >
                {t(language, "newReq.importDispatch")}
              </button>
            </div>
          </>
        )}
      </ModalShell>
    );
  }

  if (m.kind === "add_project") {
    const browse = m.browse;
    const nodes = hub?.nodes ?? [];
    const connectedNodes = nodes.filter((n) => n.isLocal || n.connected);
    const selectedNodeId = m.nodeId || "local";
    const originHint = typeof window !== "undefined" ? window.location.origin : "http://<ubuntu-ip>:4318";

    const browseDir = async (targetPath?: string, nodeOverride?: string) => {
      const targetNode = nodeOverride ?? selectedNodeId;
      try {
        const next = await api.browseFs(targetPath, targetNode);
        setModal((prev) =>
          prev?.kind === "add_project"
            ? { ...prev, nodeId: targetNode, browse: next, pathInput: next.currentPath }
            : prev,
        );
      } catch (err) {
        setModal((prev) =>
          prev?.kind === "add_project"
            ? { ...prev, nodeId: targetNode, browse: null, pathInput: "" }
            : prev,
        );
        useUiStore.getState().showToastError(err);
      }
    };

    const submitAddProject = async () => {
      const rootPath = m.pathInput.trim();
      if (!rootPath) {
        showToastKey("addProject.enterPath", undefined, true);
        return;
      }
      const res = await runBusy(async () => {
        const out = await api.addHubProject({
          root: rootPath,
          name: m.nameInput.trim() || undefined,
          initPrivacy: m.initPrivacy === "none" ? undefined : m.initPrivacy,
          ...(selectedNodeId !== "local" ? { nodeId: selectedNodeId } : {}),
        });
        setApiProjectScope(out.project.id);
        setModal(null);
        setActiveProjectId(out.project.id);
        setSelectedId(null);
        setSelectedDiffFile(null);
        setQuery("");
        return out;
      });
      if (res) {
        await invalidateAllWorkbenchQueries();
        showToastKey("addProject.switched", { name: res.project.name });
      }
    };

    return (
      <ModalShell onClose={close} wide testId="add-project-modal">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
          <h3 style={{ margin: 0 }}>{t(language, "addProject.title")}</h3>
          <button
            className="btn ghost xs"
            type="button"
            data-testid="toggle-node-help-btn"
            onClick={() =>
              setModal((prev) => (prev?.kind === "add_project" ? { ...prev, showNodeHelp: !prev.showNodeHelp } : prev))
            }
          >
            {m.showNodeHelp ? t(language, "addProject.helpClose") : t(language, "addProject.helpOpen")}
          </button>
        </div>

        {(connectedNodes.length > 1 || selectedNodeId !== "local") && (
          <div style={{ marginBottom: 10 }}>
            <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
              {t(language, "addProject.nodeLabel")}
            </label>
            <div className="segmented" role="tablist" aria-label={t(language, "addProject.nodeAria")} data-testid="add-project-node-tabs">
              {connectedNodes.map((n) => (
                <button
                  key={n.nodeId}
                  type="button"
                  role="tab"
                  aria-selected={selectedNodeId === n.nodeId}
                  className={selectedNodeId === n.nodeId ? "active" : ""}
                  data-testid={`add-project-node-${n.nodeId}`}
                  onClick={() => void browseDir(undefined, n.nodeId)}
                >
                  <Icon icon={n.isLocal ? Server : Laptop} size={14} /> {n.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {m.showNodeHelp && (
          <div className="callout info xs" style={{ marginBottom: 10 }} data-testid="node-connect-guide">
            <div>
              <strong>{t(language, "addProject.helpTitle")}</strong>
            </div>
            <div style={{ marginTop: 4 }}>
              {t(language, "addProject.helpDesc")}
            </div>
            <pre style={{ margin: "6px 0 0", fontFamily: "var(--mono)", fontSize: 11.5, whiteSpace: "pre-wrap" }}>
              {`wb node install --hub ${originHint} --token <${t(language, "addProject.installToken")}> --id wsl-work --name "Windows WSL2"`}
            </pre>
            <div className="muted" style={{ marginTop: 4 }}>
              {t(language, "addProject.helpNotePrefix")}
              <code>wb service password</code>
              {t(language, "addProject.helpNoteSuffix")}
            </div>
          </div>
        )}

        <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
          {t(language, "addProject.pathLabel")}
        </label>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <input
            className="input"
            id="add-project-path"
            data-testid="add-project-path"
            autoFocus
            value={m.pathInput}
            placeholder="/home/tsien/code/your-project"
            onChange={(e) =>
              setModal((prev) => (prev?.kind === "add_project" ? { ...prev, pathInput: e.target.value } : prev))
            }
          />
          <button
            className="btn"
            type="button"
            data-testid="browse-go-btn"
            onClick={() => void browseDir(m.pathInput)}
          >
            {t(language, "addProject.open")}
          </button>
        </div>
        <div className="browse-box" data-testid="fs-browse-list">
          {browse ? (
            <>
              <div className="browse-head">
                <span className="xs muted">{browse.currentPath}</span>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  {browse.isGitRepo ? (
                    <span className="badge success">{t(language, "addProject.gitRepo")}</span>
                  ) : (
                    <span className="badge neutral">{t(language, "addProject.plainDir")}</span>
                  )}
                  {browse.workbenchInitialized && (
                    <span className="badge info">{t(language, "addProject.initialized")}</span>
                  )}
                  {browse.parentPath && (
                    <button
                      className="btn ghost xs"
                      type="button"
                      onClick={() => void browseDir(browse.parentPath!)}
                    >
                      <Icon icon={ArrowUp} size={14} /> {t(language, "addProject.parent")}
                    </button>
                  )}
                </div>
              </div>
              <div className="browse-entries">
                {browse.entries.length === 0 ? (
                  <div className="muted xs" style={{ padding: 10 }}>
                    {t(language, "addProject.noSubdirs")}
                  </div>
                ) : (
                  browse.entries.map((e) => (
                    <div key={e.path} className="browse-entry" onClick={() => void browseDir(e.path)}>
                      <span className="browse-entry-name">
                        <Icon icon={Folder} size={14} /> {e.name}
                      </span>
                      <span style={{ display: "flex", gap: 6 }}>
                        {e.isGitRepo && <span className="badge success">git</span>}
                        {e.workbenchInitialized && <span className="badge info">wb</span>}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </>
          ) : (
            <div className="muted xs" style={{ padding: 12 }}>
              {t(language, "addProject.loading")}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
          <div style={{ flex: 1, minWidth: 180 }}>
            <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
              {t(language, "addProject.nameLabel")}
            </label>
            <input
              className="input"
              id="add-project-name"
              value={m.nameInput}
              placeholder={t(language, "addProject.namePlaceholder")}
              onChange={(e) =>
                setModal((prev) => (prev?.kind === "add_project" ? { ...prev, nameInput: e.target.value } : prev))
              }
            />
          </div>
          <div style={{ flex: 1, minWidth: 180 }}>
            <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
              {t(language, "addProject.privacyLabel")}
            </label>
            <select
              className="select"
              id="add-project-privacy"
              style={{ width: "100%" }}
              value={m.initPrivacy}
              onChange={(e) =>
                setModal((prev) =>
                  prev?.kind === "add_project"
                    ? { ...prev, initPrivacy: e.target.value as PrivacyMode | "none" }
                    : prev,
                )
              }
            >
              <option value="local">{t(language, "addProject.privacyLocal")}</option>
              <option value="tracked">{t(language, "addProject.privacyTracked")}</option>
              <option value="none">{t(language, "addProject.privacyNone")}</option>
            </select>
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn" type="button" onClick={close}>
            {t(language, "common.cancel")}
          </button>
          <button
            className="btn primary"
            type="button"
            data-testid="submit-add-project-btn"
            disabled={busy}
            onClick={() => void submitAddProject()}
          >
            {t(language, "addProject.submit")}
          </button>
        </div>
      </ModalShell>
    );
  }

  if (m.kind === "routing") {
    const tab = m.tab ?? "global";
    const cfg = m.draft ?? routing;
    const hubLangValue = m.hubLangDraft ?? hub?.outputLanguage ?? "zh-CN";
    const savedHubLang = hub?.outputLanguage ?? "zh-CN";
    const giteeTokenValue = m.giteeTokenDraft ?? "";
    const projLangValue = m.projLangDraft ?? project?.project?.outputLanguage ?? "inherit";
    const projProviderValue: GitRemoteProvider = m.projProviderDraft ?? (isGiteeProject ? "gitee" : "github");
    const ghRepoValue = m.ghRepoDraft ?? project?.project?.github?.repo ?? githubStatus?.repo ?? "";
    const ghBaseValue =
      m.ghBaseBranchDraft ?? project?.project?.github?.defaultBaseBranch ?? githubStatus?.defaultBaseBranch ?? "main";
    const ghAutoCreateValue = m.ghAutoCreateDraft ?? Boolean(project?.project?.github?.autoCreateIssue);
    const ghAutoSyncValue = m.ghAutoSyncDraft ?? (project?.project?.github?.autoSyncIssue ?? true);
    const giteeRepoValue = m.giteeRepoDraft ?? project?.project?.gitee?.repo ?? giteeStatus?.repo ?? "";
    const giteeEnterpriseValue =
      m.giteeEnterpriseDraft ?? project?.project?.gitee?.enterprise ?? giteeStatus?.enterprise ?? "";
    const giteeBaseValue =
      m.giteeBaseBranchDraft ?? project?.project?.gitee?.defaultBaseBranch ?? giteeStatus?.defaultBaseBranch ?? "master";
    const fastCmdValue = m.fastCmdDraft ?? project?.project?.verification?.fastCommand ?? "";
    const fullCmdValue = m.fullCmdDraft ?? project?.project?.verification?.fullCommand ?? "";
    const existingAutoScreenshots = project?.project?.verification?.autoScreenshots;
    const autoScreenshotsValue = m.autoScreenshotsDraft ?? (existingAutoScreenshots === true);

    const syncHubStatePatch = async (
      patch: Partial<
        Pick<HubStateResponse, "routing" | "harnesses" | "outputLanguage" | "giteeTokenConfigured" | "giteeTokenMasked">
      >,
    ) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.hubState });
      queryClient.setQueryData<HubStateResponse>(queryKeys.hubState, (prev) =>
        prev ? { ...prev, ...patch } : prev,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.hubState });
    };

    const refreshHarnesses = async () => {
      const targetNodeId = hub?.activeNodeId;
      const res = await runBusy(() => api.refreshHarnesses(targetNodeId));
      if (res) {
        await syncHubStatePatch({ harnesses: res.harnesses });
        const nodeLabel = hub?.nodes?.find((n) => n.nodeId === targetNodeId)?.name ?? t(useUiStore.getState().language, "common.localNode");
        showToastKey("routing.refreshedModels", { node: nodeLabel });
      }
    };

    const applyPreset = async (preset: RoutingPreset) => {
      const res = await runBusy(() => api.applyPreset(preset));
      if (res) {
        await syncHubStatePatch({ routing: res.routing });
        setModal((prev) => (prev?.kind === "routing" ? { ...prev, draft: res.routing } : prev));
        showToastKey("routing.presetApplied", { preset });
      }
    };

    const saveGlobal = async () => {
      if (!cfg) return;
      const tokenPatch = m.clearGiteeToken
        ? null
        : giteeTokenValue.trim()
          ? giteeTokenValue.trim()
          : undefined;
      const res = await runBusy(async () => {
        const routingRes = await api.saveRouting(cfg);
        const prefRes = await api.updateHubPreferences({
          outputLanguage: hubLangValue,
          ...(tokenPatch !== undefined ? { giteeAccessToken: tokenPatch } : {}),
        });
        return { routingRes, prefRes };
      });
      if (res) {
        await syncHubStatePatch({
          routing: res.routingRes.routing,
          outputLanguage: res.prefRes.outputLanguage,
          ...(res.prefRes.giteeTokenConfigured !== undefined
            ? { giteeTokenConfigured: res.prefRes.giteeTokenConfigured }
            : {}),
          ...(res.prefRes.giteeTokenMasked !== undefined ? { giteeTokenMasked: res.prefRes.giteeTokenMasked } : {}),
        });
        await queryClient.invalidateQueries({ queryKey: ["gitee"] });
        setModal(null);
        showToastKey("routing.savedGlobal");
      }
    };

    const saveProject = async () => {
      const out = await runBusy(() =>
        api.updateProjectSettings({
          outputLanguage: projLangValue,
          verification: {
            fastCommand: fastCmdValue.trim(),
            fullCommand: fullCmdValue.trim(),
            ...(m.autoScreenshotsDraft !== undefined
              ? { autoScreenshots: m.autoScreenshotsDraft }
              : existingAutoScreenshots !== undefined
                ? { autoScreenshots: existingAutoScreenshots }
                : {}),
          },
          ...(projProviderValue === "gitee"
            ? {
                gitee: {
                  repo: giteeRepoValue.trim(),
                  enterprise: giteeEnterpriseValue.trim(),
                  defaultBaseBranch: giteeBaseValue.trim() || "master",
                },
                github: null,
              }
            : {
                github: {
                  repo: ghRepoValue.trim(),
                  defaultBaseBranch: ghBaseValue.trim() || "main",
                  autoCreateIssue: ghAutoCreateValue,
                  autoSyncIssue: ghAutoSyncValue,
                },
                gitee: null,
              }),
        }),
      );
      if (out) {
        await invalidateAllWorkbenchQueries();
        setModal(null);
        showToastKey("routing.savedProject");
      }
    };

    return (
      <ModalShell onClose={close} wide testId="routing-modal">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
          <h3 style={{ margin: 0 }}>{t(language, "routing.title")}</h3>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div className="segmented" role="tablist" aria-label={t(language, "routing.scopeAria")}>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "global"}
                className={tab === "global" ? "active" : ""}
                data-testid="settings-tab-global"
                onClick={() => setModal((prev) => (prev?.kind === "routing" ? { ...prev, tab: "global" } : prev))}
              >
                <Icon icon={Globe} size={14} /> {t(language, "routing.global")}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "project"}
                className={tab === "project" ? "active" : ""}
                data-testid="settings-tab-project"
                onClick={() => setModal((prev) => (prev?.kind === "routing" ? { ...prev, tab: "project" } : prev))}
              >
                <Icon icon={Folder} size={14} /> {t(language, "routing.project")}
              </button>
            </div>
            {tab === "global" && (
              <button
                className="btn xs"
                type="button"
                data-testid="refresh-harnesses-btn"
                disabled={busy}
                onClick={() => void refreshHarnesses()}
              >
                <Icon icon={RefreshCw} size={14} /> {t(language, "routing.refreshHarnesses")}
              </button>
            )}
          </div>
        </div>

        {tab === "global" ? (
          <div data-testid="settings-pane-global">
            <div className="preset-grid" data-testid="routing-presets">
              {PRESET_KEYS.map((p) => (
                <button
                  key={p.id}
                  className={`preset-card ${cfg?.activePreset === p.id ? "active" : ""}`}
                  type="button"
                  data-testid={`preset-${p.id}`}
                  onClick={() => void applyPreset(p.id)}
                >
                  <strong>{t(language, p.nameKey)}</strong>
                  <div className="xs muted" style={{ marginTop: 4 }}>
                    {t(language, p.descKey)}
                  </div>
                </button>
              ))}
            </div>

            {cfg && (
              <div className="routing-table" style={{ marginTop: 12 }}>
                {ROUTING_STAGES.map((stg) => {
                  const rule = cfg.stages[stg];
                  const selectedVal = `${rule.primary.harness}::${rule.primary.model}`;
                  const effortCap = getModelEffortCapability(harnesses, rule.primary.harness, rule.primary.model);
                  const efforts = effortCap.efforts;
                  const lockedEffort = effortCap.defaultEffort ?? efforts[0];

                  const changePrimaryModel = (key: string) => {
                    const parsed = parseRunnerKey(key);
                    if (!parsed || !cfg) return;
                    const { harness, model } = parsed;
                    const nextCap = getModelEffortCapability(harnesses, harness, model);
                    const keepEffort =
                      nextCap.mode === "configurable" &&
                      rule.primary.reasoningEffort &&
                      nextCap.efforts.includes(rule.primary.reasoningEffort)
                        ? rule.primary.reasoningEffort
                        : undefined;
                    const nextCfg = {
                      ...cfg,
                      stages: {
                        ...cfg.stages,
                        [stg]: {
                          ...cfg.stages[stg],
                          primary: {
                            harness: harness as HarnessId,
                            model,
                            ...(keepEffort ? { reasoningEffort: keepEffort } : {}),
                          },
                        },
                      },
                    };
                    setModal((prev) => (prev?.kind === "routing" ? { ...prev, draft: nextCfg } : prev));
                  };

                  return (
                    <div key={stg} className="routing-row">
                      <div className="min-w-0">
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{t(language, STAGE_LABEL_KEYS[stg])}</div>
                        <div className="xs muted truncate">
                          {t(language, "routing.fallbacks", {
                            list:
                              rule.fallbacks.map((f) => `${f.harness}/${f.model}`).join(" → ") ||
                              t(language, "common.none"),
                          })}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <RoutingModelPicker
                          testId={`route-select-${stg}`}
                          harnesses={harnesses}
                          value={selectedVal}
                          onChange={changePrimaryModel}
                          ariaLabel={t(language, "routing.primaryModelAria", { stage: t(language, STAGE_LABEL_KEYS[stg]) })}
                        />
                        {effortCap.mode === "configurable" ? (
                          <select
                            className="select font-mono w-[135px]"
                            data-testid={`route-effort-${stg}`}
                            title={t(language, "routing.effortTitle")}
                            value={
                              rule.primary.reasoningEffort && efforts.includes(rule.primary.reasoningEffort)
                                ? rule.primary.reasoningEffort
                                : ""
                            }
                            onChange={(e) => {
                              const eff = e.target.value as ReasoningEffort | "";
                              const nextPrimary = { ...rule.primary };
                              if (eff) nextPrimary.reasoningEffort = eff;
                              else delete nextPrimary.reasoningEffort;
                              const nextCfg = {
                                ...cfg,
                                stages: {
                                  ...cfg.stages,
                                  [stg]: { ...cfg.stages[stg], primary: nextPrimary },
                                },
                              };
                              setModal((prev) => (prev?.kind === "routing" ? { ...prev, draft: nextCfg } : prev));
                            }}
                          >
                            <option value="">
                              {t(language, "routing.defaultEffort")}
                              {effortCap.defaultEffort
                                ? ` (${effortLabel(language, effortCap.defaultEffort)})`
                                : ""}
                            </option>
                            {efforts.map((eff) => (
                              <option key={eff} value={eff}>
                                {effortLabel(language, eff)}
                              </option>
                            ))}
                          </select>
                        ) : effortCap.mode === "locked" ? (
                          <span
                            className="inline-flex items-center justify-center w-[135px] px-2 py-1.5 rounded border border-[var(--border)] text-xs font-mono text-[var(--muted)]"
                            data-testid={`route-effort-${stg}-locked`}
                            title={t(language, "routing.effortLockedTitle")}
                          >
                            {t(language, "routing.effortLockedLabel", {
                              effort: lockedEffort
                                ? effortLabel(language, lockedEffort)
                                : t(language, "routing.effortBuiltin"),
                            })}
                          </span>
                        ) : (
                          <span
                            className="inline-flex items-center justify-center w-[135px] px-2 py-1.5 rounded border border-[var(--border)] text-xs text-[var(--muted)]"
                            data-testid={`route-effort-${stg}-unsupported`}
                            title={t(language, "routing.effortUnsupportedTitle")}
                          >
                            {t(language, "routing.effortUnsupportedLabel")}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {cfg && (
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginTop: 12 }}>
                <input
                  type="checkbox"
                  data-testid="routing-auto-review-checkbox"
                  checked={cfg.autoReview !== false}
                  onChange={(e) => {
                    const nextCfg = { ...cfg, autoReview: e.target.checked };
                    setModal((prev) => (prev?.kind === "routing" ? { ...prev, draft: nextCfg } : prev));
                  }}
                />
                <span>{t(language, "routing.autoReviewLabel")}</span>
              </label>
            )}

            <div className="callout info xs" style={{ margin: "12px 0" }}>
              {t(language, "routing.outputLanguageCallout")}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, alignItems: "end" }}>
              <div>
                <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
                  {t(language, "routing.hubLangLabel")}
                </label>
                <select
                  className="select"
                  data-testid="hub-output-language-select"
                  style={{ width: "100%" }}
                  value={hubLangValue}
                  onChange={(e) =>
                    setModal((prev) =>
                      prev?.kind === "routing" ? { ...prev, hubLangDraft: e.target.value as OutputLanguage } : prev,
                    )
                  }
                >
                  <option value="zh-CN">{t(language, "routing.langZhDefault")}</option>
                  <option value="en">{t(language, "init.langEn")}</option>
                  <option value="auto">{t(language, "routing.langAuto")}</option>
                </select>
              </div>

              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, gap: 6 }}>
                  <label
                    className="muted xs"
                    htmlFor="hub-gitee-token-input"
                    title={t(language, "gitee.tokenTooltip")}
                  >
                    {t(language, "gitee.tokenLabel")}
                  </label>
                  <span
                    className={`badge ${
                      m.clearGiteeToken
                        ? "neutral"
                        : hub?.giteeTokenConfigured
                          ? "success"
                          : "warning"
                    }`}
                    data-testid="hub-gitee-token-status"
                  >
                    {m.clearGiteeToken
                      ? t(language, "gitee.tokenClearOnSave")
                      : hub?.giteeTokenConfigured
                        ? t(language, "gitee.tokenConfigured", { masked: hub.giteeTokenMasked ?? "••••" })
                        : t(language, "gitee.tokenUnconfigured")}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    id="hub-gitee-token-input"
                    type="password"
                    className="input"
                    style={{ flex: 1 }}
                    data-testid="hub-gitee-token-input"
                    value={giteeTokenValue}
                    placeholder={
                      hub?.giteeTokenConfigured
                        ? t(language, "gitee.tokenPlaceholderReplace")
                        : t(language, "gitee.tokenPlaceholderNew")
                    }
                    onChange={(e) =>
                      setModal((prev) =>
                        prev?.kind === "routing"
                          ? { ...prev, giteeTokenDraft: e.target.value, clearGiteeToken: false }
                          : prev,
                      )
                    }
                  />
                  {hub?.giteeTokenConfigured && !m.clearGiteeToken && (
                    <button
                      className="btn xs"
                      type="button"
                      data-testid="hub-gitee-token-clear"
                      onClick={() =>
                        setModal((prev) =>
                          prev?.kind === "routing"
                            ? { ...prev, giteeTokenDraft: "", clearGiteeToken: true }
                            : prev,
                        )
                      }
                    >
                      {t(language, "gitee.tokenClear")}
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="modal-actions">
              <button className="btn" type="button" onClick={close}>
                {t(language, "common.cancel")}
              </button>
              <button
                className="btn primary"
                type="button"
                data-testid="save-routing-btn"
                disabled={busy}
                onClick={() => void saveGlobal()}
              >
                {t(language, "routing.saveGlobal")}
              </button>
            </div>
          </div>
        ) : (
          <div data-testid="settings-pane-project">
            {noHubProject || !project?.initialized ? (
              <div className="empty-card xs muted" style={{ textAlign: "center" }}>
                {t(language, "routing.projectEmpty")}
              </div>
            ) : (
              <>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div>
                    <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
                      {t(language, "routing.projectLangLabel", { name: project.project?.name ?? "" })}
                    </label>
                    <select
                      className="select"
                      data-testid="project-output-language-select"
                      style={{ width: "100%" }}
                      value={projLangValue}
                      onChange={(e) =>
                        setModal((prev) =>
                          prev?.kind === "routing"
                            ? { ...prev, projLangDraft: e.target.value as OutputLanguage | "inherit" }
                            : prev,
                        )
                      }
                    >
                      <option value="inherit">
                        {t(language, "routing.inheritHub", { lang: savedHubLang })}
                      </option>
                      <option value="zh-CN">{t(language, "init.langZh")}</option>
                      <option value="en">{t(language, "init.langEn")}</option>
                      <option value="auto">{t(language, "routing.langAuto")}</option>
                    </select>
                  </div>

                  <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: 8,
                        gap: 8,
                        flexWrap: "wrap",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <strong style={{ fontSize: 13 }}>{t(language, "gitee.providerTitle")}</strong>
                        <div className="segmented" role="tablist" aria-label={t(language, "gitee.providerTitle")}>
                          <button
                            type="button"
                            role="tab"
                            aria-selected={projProviderValue === "github"}
                            className={projProviderValue === "github" ? "active" : ""}
                            data-testid="project-provider-github"
                            onClick={() =>
                              setModal((prev) =>
                                prev?.kind === "routing" ? { ...prev, projProviderDraft: "github" } : prev,
                              )
                            }
                          >
                            GitHub
                          </button>
                          <button
                            type="button"
                            role="tab"
                            aria-selected={projProviderValue === "gitee"}
                            className={projProviderValue === "gitee" ? "active" : ""}
                            data-testid="project-provider-gitee"
                            onClick={() =>
                              setModal((prev) =>
                                prev?.kind === "routing" ? { ...prev, projProviderDraft: "gitee" } : prev,
                              )
                            }
                          >
                            Gitee
                          </button>
                        </div>
                      </div>
                      {projProviderValue === "gitee"
                        ? giteeStatus && (
                            <span
                              className={`badge ${giteeStatus.ready ? "success" : "warning"}`}
                              data-testid="project-provider-status"
                            >
                              {giteeStatus.ready
                                ? t(language, "gitee.statusReady", { account: giteeStatus.account ?? "authenticated" })
                                : formatGiteeStatusReason(language, giteeStatus)}
                            </span>
                          )
                        : githubStatus && (
                            <span
                              className={`badge ${githubStatus.ready ? "success" : "warning"}`}
                              data-testid="project-provider-status"
                            >
                              {githubStatus.ready
                                ? t(language, "gitee.statusGhReady", { account: githubStatus.account ?? "authenticated" })
                                : formatGitHubStatusReason(language, githubStatus)}
                            </span>
                          )}
                    </div>

                    {projProviderValue === "gitee" ? (
                      <>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 150px", gap: 8, marginBottom: 6 }}>
                          <div>
                            <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
                              {t(language, "gitee.repoLabel")}
                            </label>
                            <input
                              className="input"
                              data-testid="project-gitee-repo-input"
                              value={giteeRepoValue}
                              placeholder="openstring/deepmdt-frontend-pc"
                              onChange={(e) =>
                                setModal((prev) =>
                                  prev?.kind === "routing" ? { ...prev, giteeRepoDraft: e.target.value } : prev,
                                )
                              }
                            />
                          </div>
                          <div>
                            <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
                              {t(language, "gitee.enterpriseLabel")}
                            </label>
                            <input
                              className="input"
                              data-testid="project-gitee-enterprise-input"
                              value={giteeEnterpriseValue}
                              placeholder="openstring"
                              onChange={(e) =>
                                setModal((prev) =>
                                  prev?.kind === "routing" ? { ...prev, giteeEnterpriseDraft: e.target.value } : prev,
                                )
                              }
                            />
                          </div>
                          <div>
                            <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
                              {t(language, "gitee.baseBranchLabel")}
                            </label>
                            <input
                              className="input"
                              data-testid="project-gitee-base-input"
                              value={giteeBaseValue}
                              placeholder="master"
                              onChange={(e) =>
                                setModal((prev) =>
                                  prev?.kind === "routing" ? { ...prev, giteeBaseBranchDraft: e.target.value } : prev,
                                )
                              }
                            />
                          </div>
                        </div>
                        {!giteeRepoValue.trim() && !giteeStatus?.repo && (
                          <div className="xs muted" style={{ marginBottom: 4, color: "var(--warning)" }}>
                            {t(language, "gitee.missingRemoteHint")}
                          </div>
                        )}
                        <div className="xs muted">
                          {t(language, "gitee.syncBehaviorHint")}
                        </div>
                      </>
                    ) : (
                      <>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 180px", gap: 8, marginBottom: 8 }}>
                          <div>
                            <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
                              {t(language, "gitee.ghRepoLabel")}
                            </label>
                            <input
                              className="input"
                              data-testid="project-github-repo-input"
                              value={ghRepoValue}
                              placeholder="Jackie733/workbench"
                              onChange={(e) =>
                                setModal((prev) =>
                                  prev?.kind === "routing" ? { ...prev, ghRepoDraft: e.target.value } : prev,
                                )
                              }
                            />
                          </div>
                          <div>
                            <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
                              {t(language, "gitee.baseBranchLabel")}
                            </label>
                            <input
                              className="input"
                              data-testid="project-github-base-input"
                              value={ghBaseValue}
                              placeholder="main"
                              onChange={(e) =>
                                setModal((prev) =>
                                  prev?.kind === "routing" ? { ...prev, ghBaseBranchDraft: e.target.value } : prev,
                                )
                              }
                            />
                          </div>
                        </div>
                        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginBottom: 6 }}>
                          <input
                            type="checkbox"
                            data-testid="project-github-autocreate"
                            checked={ghAutoCreateValue}
                            onChange={(e) =>
                              setModal((prev) =>
                                prev?.kind === "routing" ? { ...prev, ghAutoCreateDraft: e.target.checked } : prev,
                              )
                            }
                          />
                          <span>{t(language, "routing.ghAutoCreate")}</span>
                        </label>
                        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                          <input
                            type="checkbox"
                            data-testid="project-github-autosync"
                            checked={ghAutoSyncValue}
                            onChange={(e) =>
                              setModal((prev) =>
                                prev?.kind === "routing" ? { ...prev, ghAutoSyncDraft: e.target.checked } : prev,
                              )
                            }
                          />
                          <span>{t(language, "routing.ghAutoSync")}</span>
                        </label>
                      </>
                    )}
                  </div>

                  <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                    <strong style={{ fontSize: 13, display: "block", marginBottom: 8 }}>
                      {t(language, "routing.verificationTitle")}
                    </strong>
                    <div style={{ marginBottom: 10 }}>
                      <span className="muted xs" style={{ display: "block", marginBottom: 4 }}>
                        {t(language, "routing.archDocsLabel")}
                      </span>
                      {project.context?.archDocs && project.context.archDocs.length > 0 ? (
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {project.context.archDocs.map((doc) => (
                            <span
                              key={doc.path}
                              className="badge info"
                              title={doc.headings.join(" / ")}
                              data-testid={`proj-arch-doc-${doc.path}`}
                            >
                              {doc.path}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="xs muted">{t(language, "routing.archDocsNone")}</span>
                      )}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                      <div>
                        <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
                          {t(language, "routing.fastCmdLabel")}
                        </label>
                        <input
                          className="input"
                          data-testid="project-fast-cmd-input"
                          value={fastCmdValue}
                          placeholder={project.context?.fastCommand ?? t(language, "routing.fastCmdPlaceholder")}
                          onChange={(e) =>
                            setModal((prev) =>
                              prev?.kind === "routing" ? { ...prev, fastCmdDraft: e.target.value } : prev,
                            )
                          }
                        />
                      </div>
                      <div>
                        <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
                          {t(language, "routing.fullCmdLabel")}
                        </label>
                        <input
                          className="input"
                          data-testid="project-full-cmd-input"
                          value={fullCmdValue}
                          placeholder={project.context?.fullCommand ?? t(language, "routing.fullCmdPlaceholder")}
                          onChange={(e) =>
                            setModal((prev) =>
                              prev?.kind === "routing" ? { ...prev, fullCmdDraft: e.target.value } : prev,
                            )
                          }
                        />
                      </div>
                    </div>
                    <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                      <input
                        type="checkbox"
                        data-testid="project-auto-screenshots"
                        checked={autoScreenshotsValue}
                        onChange={(e) =>
                          setModal((prev) =>
                            prev?.kind === "routing" ? { ...prev, autoScreenshotsDraft: e.target.checked } : prev,
                          )
                        }
                      />
                      <span>{t(language, "routing.autoScreenshotsLabel")}</span>
                    </label>
                  </div>
                </div>

                <div className="modal-actions">
                  <button className="btn" type="button" onClick={close}>
                    {t(language, "common.cancel")}
                  </button>
                  <button
                    className="btn primary"
                    type="button"
                    data-testid="save-project-btn"
                    disabled={busy}
                    onClick={() => void saveProject()}
                  >
                    {t(language, "routing.saveProject")}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </ModalShell>
    );
  }

  if (m.kind === "annotate_anchor") {
    return (
      <ModalShell onClose={close} testId="annotate-modal">
        <h3>{t(language, "annotate.title")}</h3>
        <div className="xs muted" style={{ marginBottom: 8 }}>
          {t(language, "annotate.anchor", { anchor: m.anchor })}
        </div>
        <textarea
          className="textarea"
          id="annotate-msg"
          data-testid="annotate-msg"
          autoFocus
          value={m.message}
          placeholder={t(language, "annotate.placeholder")}
          onChange={(e) =>
            setModal((prev) =>
              prev?.kind === "annotate_anchor" ? { ...prev, message: e.target.value } : prev,
            )
          }
        />
        <div className="modal-actions">
          <button className="btn" type="button" onClick={close}>
            {t(language, "common.cancel")}
          </button>
          <button
            className="btn"
            type="button"
            data-testid="annotate-ask-btn"
            onClick={() => detail && void submitAnnotation(detail.state.id, m.anchor, m.message, "ask")}
          >
            <Icon icon={Lightbulb} size={14} /> {t(language, "annotate.ask")}
          </button>
          <button
            className="btn primary"
            type="button"
            data-testid="annotate-queue-btn"
            onClick={() => detail && void submitAnnotation(detail.state.id, m.anchor, m.message, "refine")}
          >
            <Icon icon={Pencil} size={14} /> {t(language, "annotate.queue")}
          </button>
        </div>
      </ModalShell>
    );
  }

  if (m.kind === "handoff_preview") {
    return (
      <ModalShell onClose={close} wide testId="handoff-modal">
        <h3>{t(language, "handoff.title")}</h3>
        <p className="xs muted" style={{ margin: "0 0 10px" }}>
          {t(language, "handoff.desc")}
        </p>
        <div className="handoff-preview-box">
          <MarkdownView markdown={m.markdown} />
        </div>
        <div className="modal-actions">
          <button className="btn primary" type="button" onClick={close}>
            {t(language, "common.close")}
          </button>
        </div>
      </ModalShell>
    );
  }

  if (m.kind === "feedback") {
    const isDesignStage =
      detail?.state.stage === "awaiting_approval" ||
      detail?.state.stage === "draft" ||
      detail?.state.stage === "designing";
    const reviewReport = detail?.state.reviewReport;
    return (
      <ModalShell onClose={close} testId="feedback-modal">
        <h3>{isDesignStage ? t(language, "feedback.titleDesign") : t(language, "feedback.titleFix")}</h3>
        <p className="xs muted" style={{ margin: "0 0 8px" }}>
          {isDesignStage ? t(language, "feedback.descDesign") : t(language, "feedback.descFix")}
        </p>
        {!isDesignStage && reviewReport && (
          <div style={{ marginBottom: 8 }}>
            <button
              className="btn xs"
              type="button"
              data-testid="feedback-fill-review-btn"
              onClick={() => {
                const snippet = formatReviewFixFeedback(reviewReport);
                setModal((prev) => (prev?.kind === "feedback" ? { ...prev, feedback: snippet } : prev));
              }}
            >
              {t(language, "feedback.fillReview")}
            </button>
          </div>
        )}
        <textarea
          className="textarea"
          id="feedback-input"
          autoFocus
          value={m.feedback}
          placeholder={
            isDesignStage ? t(language, "feedback.placeholderDesign") : t(language, "feedback.placeholderFix")
          }
          onChange={(e) =>
            setModal((prev) => (prev?.kind === "feedback" ? { ...prev, feedback: e.target.value } : prev))
          }
        />
        <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, fontSize: 13 }}>
          <input
            type="checkbox"
            id="feedback-dispatch"
            checked={m.dispatchAgent}
            onChange={(e) =>
              setModal((prev) =>
                prev?.kind === "feedback" ? { ...prev, dispatchAgent: e.target.checked } : prev,
              )
            }
          />
          <span>
            {isDesignStage ? t(language, "feedback.dispatchDesign") : t(language, "feedback.dispatchFix")}
          </span>
        </label>
        <div className="modal-actions">
          <button className="btn" type="button" onClick={close}>
            {t(language, "common.cancel")}
          </button>
          <button
            className="btn primary"
            type="button"
            data-testid="feedback-submit-btn"
            disabled={busy}
            onClick={() => detail && void submitFeedback(detail, m.feedback, m.dispatchAgent)}
          >
            {isDesignStage ? t(language, "feedback.submitDesign") : t(language, "feedback.submitFix")}
          </button>
        </div>
      </ModalShell>
    );
  }

  if (m.kind === "accept_override") {
    const isBlock = m.verdict === "block";
    const title = isBlock
      ? t(language, "acceptOverride.titleBlock")
      : m.verdict === "concern"
        ? t(language, "acceptOverride.titleConcern")
        : t(language, "acceptOverride.titleStale");
    return (
      <ModalShell onClose={close} testId="accept-override-modal">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <Icon icon={AlertTriangle} size={20} />
          <h3 style={{ margin: 0 }}>{title}</h3>
        </div>
        <div className={`callout ${isBlock ? "danger" : "warning"} xs`} style={{ marginBottom: 10 }}>
          <div>
            <strong>{t(language, "acceptOverride.summary")}</strong>
            {m.summary}
          </div>
          {m.acceptedRisks.length > 0 && (
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {m.acceptedRisks.slice(0, 8).map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
        </div>
        <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
          {isBlock ? t(language, "acceptOverride.reasonBlockLabel") : t(language, "acceptOverride.reasonConcernLabel")}
        </label>
        <textarea
          className="textarea"
          data-testid="accept-override-reason"
          autoFocus
          value={m.reason}
          placeholder={
            isBlock
              ? t(language, "acceptOverride.reasonBlockPlaceholder")
              : t(language, "acceptOverride.reasonConcernPlaceholder")
          }
          onChange={(e) =>
            setModal((prev) => (prev?.kind === "accept_override" ? { ...prev, reason: e.target.value } : prev))
          }
        />
        <div className="modal-actions">
          <button className="btn" type="button" onClick={close}>
            {t(language, "acceptOverride.back")}
          </button>
          <button
            className="btn primary"
            type="button"
            data-testid="confirm-accept-override-btn"
            disabled={busy || (isBlock && !m.reason.trim())}
            onClick={() => detail && void submitAcceptOverride(detail, m.verdict, m.reason, m.acceptedRisks)}
          >
            {t(language, "acceptOverride.confirm")}
          </button>
        </div>
      </ModalShell>
    );
  }

  if (m.kind === "lifecycle") {
    const title =
      m.action === "block"
        ? t(language, "lifecycle.blockTitle")
        : m.action === "cancel"
          ? t(language, "lifecycle.cancelTitle")
          : t(language, "lifecycle.reopenTitle");
    const canPreserveApproval = m.action === "reopen" && Boolean(detail?.validity.approval.valid);
    const keepApproval = canPreserveApproval ? m.preserveApproval !== false : false;
    return (
      <ModalShell onClose={close}>
        <h3>{title}</h3>
        {canPreserveApproval && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
            <label
              className={`radio-card ${keepApproval ? "selected" : ""}`}
              data-testid="reopen-keep-approval-option"
              onClick={() =>
                setModal((prev) => (prev?.kind === "lifecycle" ? { ...prev, preserveApproval: true } : prev))
              }
            >
              <input type="radio" name="reopen-mode" checked={keepApproval} readOnly />
              <div>
                <strong style={{ fontSize: 13 }}>{t(language, "lifecycle.reopenKeepApprovalTitle")}</strong>
                <div className="muted xs" style={{ marginTop: 2 }}>
                  {t(language, "lifecycle.reopenKeepApprovalDesc")}
                </div>
              </div>
            </label>
            <label
              className={`radio-card ${!keepApproval ? "selected" : ""}`}
              data-testid="reopen-reset-draft-option"
              onClick={() =>
                setModal((prev) => (prev?.kind === "lifecycle" ? { ...prev, preserveApproval: false } : prev))
              }
            >
              <input type="radio" name="reopen-mode" checked={!keepApproval} readOnly />
              <div>
                <strong style={{ fontSize: 13 }}>{t(language, "lifecycle.reopenResetDraftTitle")}</strong>
                <div className="muted xs" style={{ marginTop: 2 }}>
                  {t(language, "lifecycle.reopenResetDraftDesc")}
                </div>
              </div>
            </label>
          </div>
        )}
        <textarea
          className="textarea"
          id="lifecycle-reason"
          autoFocus
          value={m.reason}
          placeholder={t(language, "lifecycle.reasonPlaceholder")}
          onChange={(e) =>
            setModal((prev) => (prev?.kind === "lifecycle" ? { ...prev, reason: e.target.value } : prev))
          }
        />
        <div className="modal-actions">
          <button className="btn" type="button" onClick={close}>
            {t(language, "common.cancel")}
          </button>
          <button
            className="btn primary"
            type="button"
            data-testid="lifecycle-confirm-btn"
            disabled={busy}
            onClick={() => detail && void submitLifecycle(detail, m.action, m.reason, { preserveApproval: keepApproval })}
          >
            {t(language, "common.confirm")}
          </button>
        </div>
      </ModalShell>
    );
  }

  if (m.kind === "prompt_fallback") {
    const copyPrompt = async () => {
      try {
        await navigator.clipboard.writeText(m.prompt);
        showToastKey("fallback.copied");
      } catch {
        fallbackAreaRef.current?.select();
        showToastKey("fallback.copyHint");
      }
    };

    return (
      <ModalShell onClose={close} testId="prompt-fallback-modal">
        <h3>{t(language, m.titleKey, m.titleParams)}</h3>
        <p className="muted" style={{ fontSize: 13, margin: "0 0 10px" }}>
          {t(language, m.subtitleKey, m.subtitleParams)}
        </p>
        <textarea
          ref={fallbackAreaRef}
          className="textarea"
          id="fallback-prompt-text"
          readOnly
          style={{ minHeight: 170, fontFamily: "var(--mono)", fontSize: 12 }}
          value={m.prompt}
        />
        <div className="modal-actions">
          <button className="btn" type="button" data-action="close-modal" onClick={close}>
            {t(language, "common.close")}
          </button>
          <button className="btn primary" type="button" onClick={() => void copyPrompt()}>
            {t(language, "fallback.copy")}
          </button>
        </div>
      </ModalShell>
    );
  }

  if (m.kind === "quick_report") {
    if (m.pickingElement) return null;

    const submitQuickReport = async () => {
      const title = m.title.trim();
      if (!title) {
        showToastKey("report.needTitle", undefined, true);
        return;
      }
      const attachmentIds = (m.attachments ?? []).map((a) => a.id);
      const res = await runBusy(async () => {
        const rep = await api.reportPainPoint({
          source: "ui_quick_report",
          category: m.category,
          title,
          detail: m.detail.trim() || undefined,
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          context: {
            nodeId: hub?.activeNodeId && hub.activeNodeId !== "local" ? hub.activeNodeId : undefined,
            projectRoot: project?.root,
            requirementId: selectedId ?? undefined,
            domSelector: m.domSelector.trim() || undefined,
            viewport: typeof window !== "undefined" ? `${window.innerWidth}x${window.innerHeight}` : undefined,
            theme: useUiStore.getState().theme,
            urlPath: typeof window !== "undefined" ? window.location.pathname : undefined,
          },
        });
        let promoted: {
          id: string;
          projectId: string;
          warning?: string;
          warningRef?: StructuredMessageRef;
        } | null = null;
        if (m.autoPromote && rep.painPoint) {
          const out = await api.promotePainPoint(rep.painPoint.id, {
            createSandbox: true,
            ...(m.createGitHubIssue !== undefined ? { createGitHubIssue: m.createGitHubIssue } : {}),
          });
          promoted = {
            id: out.requirement.state.id,
            projectId: out.workbenchProjectId,
            warning: out.githubIssueWarning,
            warningRef: out.githubIssueWarningRef,
          };
        }
        return { painPoint: rep.painPoint, promoted };
      });
      if (res) {
        setModal(null);
        await invalidateAllWorkbenchQueries();
        if (res.promoted) {
          setApiProjectScope(res.promoted.projectId);
          setActiveProjectId(res.promoted.projectId);
          await openRequirement(res.promoted.id);
          if (res.promoted.warning) {
            showToastKey(
              "report.promotedWarn",
              {
                id: res.promoted.id,
                warning: resolveWarningParam(res.promoted.warning, res.promoted.warningRef),
              },
              true,
            );
          } else {
            showToastKey("report.promoted", { id: res.promoted.id });
          }
        } else {
          showToastKey("report.recorded");
        }
      }
    };

    return (
      <ModalShell onClose={close} testId="quick-report-modal">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <Icon icon={Zap} size={20} />
          <h3 style={{ margin: 0 }}>{t(language, "report.title")}</h3>
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select
            className="select"
            aria-label={t(language, "report.categoryAria")}
            data-testid="quick-report-category"
            value={m.category}
            onChange={(e) =>
              setModal((prev) =>
                prev?.kind === "quick_report"
                  ? { ...prev, category: e.target.value as PainPointCategory }
                  : prev,
              )
            }
          >
            <option value="ui_anomaly">{t(language, "report.cat.ui_anomaly")}</option>
            <option value="cli_ergonomics">{t(language, "report.cat.cli_ergonomics")}</option>
            <option value="harness_bug">{t(language, "report.cat.harness_bug")}</option>
            <option value="feature_gap">{t(language, "report.cat.feature_gap")}</option>
          </select>
          <input
            className="input"
            aria-label={t(language, "report.selectorAria")}
            style={{ flex: 1, minWidth: 160 }}
            data-testid="quick-report-selector"
            value={m.domSelector}
            placeholder={t(language, "report.selectorPlaceholder")}
            onChange={(e) =>
              setModal((prev) => (prev?.kind === "quick_report" ? { ...prev, domSelector: e.target.value } : prev))
            }
          />
          <button
            className="btn xs"
            type="button"
            data-testid="pick-element-btn"
            title={t(language, "report.pickTitle")}
            onClick={() =>
              setModal((prev) => (prev?.kind === "quick_report" ? { ...prev, pickingElement: true } : prev))
            }
          >
            <Icon icon={Crosshair} size={14} /> {t(language, "report.pick")}
          </button>
        </div>
        <input
          className="input"
          aria-label={t(language, "report.titleAria")}
          data-testid="quick-report-title"
          autoFocus
          style={{ marginBottom: 8 }}
          value={m.title}
          placeholder={t(language, "report.titlePlaceholder")}
          onChange={(e) =>
            setModal((prev) => (prev?.kind === "quick_report" ? { ...prev, title: e.target.value } : prev))
          }
        />
        <textarea
          className="textarea"
          aria-label={t(language, "report.detailAria")}
          data-testid="quick-report-detail"
          value={m.detail}
          placeholder={t(language, "report.detailPlaceholder")}
          onChange={(e) =>
            setModal((prev) => (prev?.kind === "quick_report" ? { ...prev, detail: e.target.value } : prev))
          }
        />
        <AttachmentPicker
          value={m.attachments ?? []}
          onChange={(attachments) =>
            setModal((prev) => (prev?.kind === "quick_report" ? { ...prev, attachments } : prev))
          }
          disabled={busy}
          scope="hub"
        />
        <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, fontSize: 13 }}>
          <input
            type="checkbox"
            data-testid="quick-report-autopromote"
            checked={m.autoPromote}
            onChange={(e) =>
              setModal((prev) =>
                prev?.kind === "quick_report" ? { ...prev, autoPromote: e.target.checked } : prev,
              )
            }
          />
          <span>{t(language, "report.autoPromote")}</span>
        </label>
        {m.autoPromote && (
          <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6, marginLeft: 20, fontSize: 12.5 }}>
            <input
              type="checkbox"
              data-testid="quick-report-create-issue"
              checked={m.createGitHubIssue ?? false}
              onChange={(e) =>
                setModal((prev) =>
                  prev?.kind === "quick_report" ? { ...prev, createGitHubIssue: e.target.checked } : prev,
                )
              }
            />
            <span>{t(language, "report.createIssue")}</span>
          </label>
        )}
        <div className="modal-actions">
          <button className="btn" type="button" onClick={close}>
            {t(language, "common.cancel")}
          </button>
          <button
            className="btn primary"
            type="button"
            data-testid="submit-quick-report-btn"
            disabled={busy}
            onClick={() => void submitQuickReport()}
          >
            {t(language, "report.submit")}
          </button>
        </div>
      </ModalShell>
    );
  }

  if (m.kind === "evolution") {
    const painPoints = evolutionData?.painPoints ?? [];
    const telemetry = evolutionData?.telemetry ?? { entries: [], activeCooldowns: [] };
    const sandboxes = evolutionData?.sandboxes ?? [];
    const currentPlaybook = m.playbookDraft ?? playbookData?.markdown ?? evolutionData?.playbook.markdown ?? "";

    const openWorkbenchReq = async (reqId: string, projectIdOverride?: string | null) => {
      const targetProjId =
        projectIdOverride ??
        evolutionData?.workbenchProjectId ??
        hub?.projects.find((p) => p.root === evolutionData?.workbenchRoot)?.id ??
        null;
      if (targetProjId) {
        setApiProjectScope(targetProjId);
        setActiveProjectId(targetProjId);
      }
      setModal(null);
      await openRequirement(reqId);
    };

    const handlePromote = async (painId: string) => {
      const out = await runBusy(() => api.promotePainPoint(painId, { createSandbox: true }));
      if (out) {
        await invalidateAllWorkbenchQueries();
        if (out.githubIssueWarning) {
          showToastKey(
            "report.promotedWarn",
            {
              id: out.requirement.state.id,
              warning: resolveWarningParam(out.githubIssueWarning, out.githubIssueWarningRef),
            },
            true,
          );
        } else {
          showToastKey(
            out.sandbox ? "evo.createdSandbox" : "evo.created",
            { id: out.requirement.state.id },
          );
        }
        await openWorkbenchReq(out.requirement.state.id, out.workbenchProjectId);
      }
    };

    const handleDismiss = async (painId: string) => {
      const out = await runBusy(() => api.dismissPainPoint(painId));
      if (out) {
        await invalidateAllWorkbenchQueries();
        showToastKey("evo.dismissed");
      }
    };

    const handleApplySandbox = async (reqId: string) => {
      const out = await runBusy(() => api.applyRsiSandbox(reqId));
      if (out) {
        await invalidateAllWorkbenchQueries();
        if (out.webReloaded) {
          showToastKey("evo.appliedReload", { id: reqId });
        } else {
          showToastKey("evo.applied", { id: reqId, count: out.appliedFiles.length });
        }
        notifyCascadeSyncResults(out.cascadeResults);
      }
    };

    const handleSyncSandboxPr = async (reqId: string) => {
      const out = await runBusy(() => api.syncRsiSandboxPr(reqId));
      if (out) {
        await invalidateAllWorkbenchQueries();
        if (out.pr.state === "merged") {
          if (!out.cleanedSandbox) {
            showToastKey("toast.prMerged", { num: out.pr.number });
          } else if (out.mainUpdated) {
            showToastKey("toast.prMergedMain", { num: out.pr.number });
          } else if (out.mainSyncReason) {
            showToastKey("toast.prMergedReason", {
              num: out.pr.number,
              reason: resolveWarningParam(out.mainSyncReason, out.mainSyncReasonRef),
            });
          } else {
            showToastKey("toast.prMergedClean", { num: out.pr.number });
          }
        } else {
          showToastKey("toast.prStatus", { num: out.pr.number, state: prStateRef(out.pr.state) });
        }
        notifyCascadeSyncResults(out.cascadeResults);
      }
    };

    const handleSavePlaybook = async () => {
      const out = await runBusy(() => api.savePlaybook(currentPlaybook));
      if (out) {
        setModal((prev) => (prev?.kind === "evolution" ? { ...prev, playbookDraft: out.markdown } : prev));
        await invalidateAllWorkbenchQueries();
        showToastKey("evo.savedPlaybook", { count: out.rules.length });
      }
    };

    const handleDistillPlaybook = async () => {
      const out = await runBusy(() => api.distillPlaybook());
      if (out) {
        setModal((prev) => (prev?.kind === "evolution" ? { ...prev, playbookDraft: out.markdown } : prev));
        await invalidateAllWorkbenchQueries();
        if (out.added > 0) {
          showToastKey("evo.distilled", { count: out.added });
        } else {
          showToastKey("evo.nothingDistilled");
        }
      }
    };

    return (
      <ModalShell onClose={close} wide testId="evolution-modal">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Icon icon={Sparkles} size={20} />
            <h3 style={{ margin: 0 }}>{t(language, "evo.title")}</h3>
          </div>
          <div className="segmented" role="tablist" aria-label={t(language, "evo.tabsAria")}>
            <button
              type="button"
              role="tab"
              aria-selected={m.tab === "inbox"}
              className={m.tab === "inbox" ? "active" : ""}
              data-testid="evo-tab-inbox"
              onClick={() => setModal({ ...m, tab: "inbox" })}
            >
              {t(language, "evo.tab.inbox", { count: painPoints.filter((p) => p.status === "open").length })}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={m.tab === "playbook"}
              className={m.tab === "playbook" ? "active" : ""}
              data-testid="evo-tab-playbook"
              onClick={() => setModal({ ...m, tab: "playbook", playbookDraft: null })}
            >
              {t(language, "evo.tab.playbook", {
                count: playbookData?.rules.length ?? evolutionData?.playbook.rules.length ?? 0,
              })}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={m.tab === "telemetry"}
              className={m.tab === "telemetry" ? "active" : ""}
              data-testid="evo-tab-telemetry"
              onClick={() => setModal({ ...m, tab: "telemetry" })}
            >
              {t(language, "evo.tab.telemetry", { count: telemetry.entries.length })}
            </button>
          </div>
        </div>

        {m.tab === "inbox" && (
          <div role="tabpanel" data-testid="evo-pane-inbox">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 8, flexWrap: "wrap" }}>
              <span className="xs muted">
                {t(language, "evo.inboxHintPrefix")}
                <code>wb issue</code>
                {t(language, "evo.inboxHintSuffix")}
              </span>
              <button
                className="btn xs"
                type="button"
                onClick={() =>
                  setModal({
                    kind: "quick_report",
                    title: "",
                    detail: "",
                    category: "ui_anomaly",
                    domSelector: "",
                    pickingElement: false,
                    autoPromote: false,
                  })
                }
              >
                <Icon icon={Zap} size={14} /> {t(language, "evo.addPain")}
              </button>
            </div>
            {painPoints.length === 0 ? (
              <div className="empty-card xs muted" style={{ textAlign: "center" }}>
                {t(language, "evo.inboxEmpty")}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: "52vh", overflowY: "auto" }}>
                {painPoints.map((p) => {
                  const sandboxItem = p.promotedReqId ? sandboxes.find((s) => s.requirementId === p.promotedReqId) : undefined;
                  return (
                    <div key={p.id} className="callout" data-testid={`pain-item-${p.id}`}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
                            <span className={`badge ${p.status === "open" ? "warning" : p.status === "promoted" ? "info" : "neutral"}`}>
                              {p.status === "open"
                                ? t(language, "evo.status.open")
                                : p.status === "promoted"
                                  ? t(language, "evo.status.promoted", { id: p.promotedReqId ?? "" })
                                  : t(language, "evo.status.dismissed")}
                            </span>
                            <span className="badge">
                              {translateRef(language, `report.cat.${p.category}`, p.category)}
                            </span>
                            {p.occurrences > 1 && (
                              <span className="badge info">
                                {t(language, "evo.occurrences", { count: p.occurrences })}
                              </span>
                            )}
                            {sandboxItem?.stage && sandboxItem.stage !== "done" && (
                              <span className="badge">
                                {t(language, "evo.sandbox", { stage: sandboxItem.stage })}
                              </span>
                            )}
                            {sandboxItem?.drift && sandboxItem.drift.behindCount > 0 && (
                              <span className={`badge ${sandboxItem.drift.conflictFiles.length > 0 ? "danger" : "warning"}`}>
                                {t(language, "evo.driftBadge", {
                                  count: sandboxItem.drift.behindCount,
                                  conflict:
                                    sandboxItem.drift.conflictFiles.length > 0
                                      ? t(language, "evo.driftConflictPart", { count: sandboxItem.drift.conflictFiles.length })
                                      : "",
                                })}
                              </span>
                            )}
                            {sandboxItem?.github?.issue && (
                              <span className="badge info">Issue #{sandboxItem.github.issue.number}</span>
                            )}
                            {sandboxItem?.github?.pr && (
                              <span className={`badge ${sandboxItem.github.pr.state === "merged" ? "success" : "info"}`}>
                                PR #{sandboxItem.github.pr.number} · {formatPrStateLabel(language, sandboxItem.github.pr.state)}
                              </span>
                            )}
                            <span className="xs muted">{formatDateTime(p.updatedAt, language)}</span>
                          </div>
                          <div style={{ fontWeight: 600 }}>{p.title}</div>
                          {p.detail && p.detail !== p.title && (
                            <div className="xs muted" style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>
                              {p.detail.slice(0, 260)}
                            </div>
                          )}
                          {p.attachments && p.attachments.length > 0 && (
                            <div style={{ marginTop: 6 }}>
                              <AttachmentGallery
                                attachments={p.attachments}
                                urlFor={(attId) => evolutionAttachmentUrl(p.id, attId)}
                              />
                            </div>
                          )}
                        </div>
                        <div style={{ display: "flex", gap: 6, flexShrink: 0, flexWrap: "wrap" }}>
                          {p.status === "open" && (
                            <>
                              <button
                                className="btn primary xs"
                                type="button"
                                data-testid={`promote-pain-${p.id}`}
                                disabled={busy}
                                onClick={() => void handlePromote(p.id)}
                              >
                                <Icon icon={Flame} size={14} /> {t(language, "evo.promote")}
                              </button>
                              <button
                                className="btn ghost xs"
                                type="button"
                                data-testid={`dismiss-pain-${p.id}`}
                                disabled={busy}
                                onClick={() => void handleDismiss(p.id)}
                              >
                                <Icon icon={Trash2} size={14} /> {t(language, "evo.dismiss")}
                              </button>
                            </>
                          )}
                          {p.status === "promoted" && p.promotedReqId && (
                            <button
                              className="btn xs"
                              type="button"
                              data-testid={`open-promoted-${p.id}`}
                              disabled={busy}
                              onClick={() => void openWorkbenchReq(p.promotedReqId!)}
                            >
                              <Icon icon={ExternalLink} size={14} /> {t(language, "evo.viewReq")}
                            </button>
                          )}
                          {sandboxItem?.drift?.canAutoSync && p.promotedReqId && (
                            <button
                              className="btn xs"
                              type="button"
                              disabled={busy}
                              onClick={() => void syncSandboxBaseAction(p.promotedReqId!, { useEvolutionHub: true })}
                            >
                              <Icon icon={RefreshCw} size={14} /> {t(language, "evo.syncBase")}
                            </button>
                          )}
                          {sandboxItem?.canApply && p.promotedReqId && sandboxItem.github?.pr && (
                            <button
                              className="btn primary xs"
                              type="button"
                              data-testid={`sync-pain-pr-${p.id}`}
                              disabled={busy}
                              onClick={() => void handleSyncSandboxPr(p.promotedReqId!)}
                            >
                              <Icon icon={RefreshCw} size={14} /> {t(language, "evo.syncPr")}
                            </button>
                          )}
                          {sandboxItem?.canApply && p.promotedReqId && (
                            <button
                              className={sandboxItem.github?.pr ? "btn xs" : "btn primary xs"}
                              type="button"
                              data-testid={`apply-pain-sandbox-${p.id}`}
                              disabled={busy}
                              onClick={() => void handleApplySandbox(p.promotedReqId!)}
                            >
                              <Icon icon={Check} size={14} /> {t(language, "evo.applySandbox")}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {m.tab === "playbook" && (
          <div role="tabpanel" data-testid="evo-pane-playbook">
            {noHubProject ? (
              <div className="empty-card xs muted" style={{ textAlign: "center" }}>
                {t(language, "evo.playbookNoProject")}
              </div>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 8, flexWrap: "wrap" }}>
                  <span className="xs muted">
                    {t(language, "evo.playbookHintPrefix")}
                    <code>.workbench/playbook.md</code>
                    {t(language, "evo.playbookHintSuffix")}
                  </span>
                  <button
                    className="btn xs"
                    type="button"
                    data-testid="distill-playbook-btn"
                    disabled={busy}
                    onClick={() => void handleDistillPlaybook()}
                  >
                    <Icon icon={RefreshCw} size={14} /> {t(language, "evo.distill")}
                  </button>
                </div>
                <textarea
                  className="textarea"
                  aria-label={t(language, "evo.playbookAria")}
                  data-testid="playbook-editor"
                  style={{ minHeight: 240, fontFamily: "var(--mono)", fontSize: 12.5 }}
                  value={currentPlaybook}
                  placeholder={t(language, "evo.playbookPlaceholder")}
                  onChange={(e) =>
                    setModal((prev) => (prev?.kind === "evolution" ? { ...prev, playbookDraft: e.target.value } : prev))
                  }
                />
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
                  <button
                    className="btn primary xs"
                    type="button"
                    data-testid="save-playbook-btn"
                    disabled={busy}
                    onClick={() => void handleSavePlaybook()}
                  >
                    {t(language, "evo.savePlaybook")}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {m.tab === "telemetry" && (
          <div role="tabpanel" data-testid="evo-pane-telemetry">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 8, flexWrap: "wrap" }}>
              <span className="xs muted">
                {t(language, "evo.telemetryHint")}
              </span>
              <div style={{ display: "flex", gap: 6 }}>
                {telemetry.activeCooldowns.length > 0 && (
                  <button
                    className="btn xs"
                    type="button"
                    data-testid="clear-cooldown-btn"
                    disabled={busy}
                    onClick={async () => {
                      const out = await runBusy(() => api.clearModelCooldown());
                      if (out) {
                        await invalidateAllWorkbenchQueries();
                        showToastKey("evo.clearedCooldowns");
                      }
                    }}
                  >
                    {t(language, "evo.clearCooldown", { count: telemetry.activeCooldowns.length })}
                  </button>
                )}
                <button
                  className="btn xs"
                  type="button"
                  data-testid="reload-web-btn"
                  disabled={busy}
                  onClick={async () => {
                    const out = await runBusy(() => api.reloadWebBundle());
                    if (out?.reloaded) showToastKey("evo.reloadedWeb");
                  }}
                >
                  <Icon icon={RefreshCw} size={14} /> {t(language, "evo.reloadWeb")}
                </button>
              </div>
            </div>
            {telemetry.entries.length === 0 ? (
              <div className="empty-card xs muted" style={{ textAlign: "center" }}>
                {t(language, "evo.telemetryEmpty")}
              </div>
            ) : (
              <div style={{ maxHeight: "48vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                {telemetry.entries.map((e) => {
                  const rate = e.totalRuns > 0 ? Math.round((e.succeededRuns / e.totalRuns) * 100) : 0;
                  const cooling = telemetry.activeCooldowns.some((c) => c.harness === e.harness && c.model === e.model);
                  return (
                    <div
                      key={`${e.harness}::${e.model}::${e.action}`}
                      className="routing-row"
                    >
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>
                          {e.harness} · {e.model}{" "}
                          <span className="badge" data-testid="telemetry-action-badge">
                            {formatAgentActionLabel(language, e.action)}
                          </span>{" "}
                          {cooling && <span className="badge warning">{t(language, "evo.cooling")}</span>}
                        </div>
                        <div className="xs muted">
                          {t(language, "evo.telemetryStats", {
                            total: e.totalRuns,
                            avg: (e.avgDurationMs / 1000).toFixed(1),
                          })}
                          {e.timedOutRuns > 0 ? t(language, "evo.timeouts", { count: e.timedOutRuns }) : ""}
                          {e.rateLimitedRuns > 0
                            ? t(language, "evo.rateLimited", { count: e.rateLimitedRuns })
                            : ""}
                          {e.degradedRuns > 0 ? t(language, "evo.degraded", { count: e.degradedRuns }) : ""}
                        </div>
                      </div>
                      <span className={`badge ${rate >= 70 ? "success" : rate >= 40 ? "warning" : "danger"}`}>
                        {t(language, "evo.successRate", { rate })}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn" type="button" data-action="close-modal" onClick={close}>
            {t(language, "common.close")}
          </button>
        </div>
      </ModalShell>
    );
  }

  if (m.kind === "link_issue") {
    const linkProvider = m.provider ?? (isGiteeProject ? "gitee" : "github");
    const isGiteeLink = linkProvider === "gitee";
    const remoteReady = isGiteeLink ? giteeStatus?.authenticated : githubStatus?.ready;
    const remoteReason = isGiteeLink
      ? giteeStatus
        ? formatGiteeStatusReason(language, giteeStatus)
        : null
      : githubStatus
        ? formatGitHubStatusReason(language, githubStatus)
        : null;

    const submitLinkIssue = async () => {
      if ((isGiteeLink || m.mode === "link") && !m.issueRef.trim()) {
        showToastKey(isGiteeLink ? "gitee.linkNeedRef" : "linkIssue.needRef", undefined, true);
        return;
      }
      const res = await runBusy(() =>
        api.linkRequirementIssue(
          m.requirementId,
          isGiteeLink
            ? { provider: "gitee", issueRef: m.issueRef.trim() }
            : m.mode === "link"
              ? { provider: "github", issueRef: m.issueRef.trim() }
              : { provider: "github" },
        ),
      );
      if (res) {
        setModal(null);
        await invalidateAllWorkbenchQueries();
        const num = res.detail.state.github?.issue?.number;
        if (isGiteeLink) {
          if (num) showToastKey("gitee.linkDoneNum", { num });
          else showToastKey("gitee.linkDone");
        } else {
          if (num) showToastKey("linkIssue.linkedNum", { num });
          else showToastKey("linkIssue.linked");
        }
      }
    };

    return (
      <ModalShell onClose={close} testId="link-issue-modal">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>{t(language, isGiteeLink ? "gitee.linkTitle" : "linkIssue.title")}</h3>
          {!isGiteeLink && (
            <div className="segmented" role="tablist">
              <button
                type="button"
                className={m.mode === "create" ? "active" : ""}
                onClick={() => setModal((prev) => (prev?.kind === "link_issue" ? { ...prev, mode: "create" } : prev))}
              >
                {t(language, "linkIssue.modeCreate")}
              </button>
              <button
                type="button"
                className={m.mode === "link" ? "active" : ""}
                onClick={() => setModal((prev) => (prev?.kind === "link_issue" ? { ...prev, mode: "link" } : prev))}
              >
                {t(language, "linkIssue.modeLink")}
              </button>
            </div>
          )}
        </div>
        {!isGiteeLink && m.mode === "create" ? (
          <div className="callout info xs">
            {t(language, "linkIssue.createDescPrefix")}
            <strong>{m.requirementId}</strong>
            {t(language, "linkIssue.createDescMiddle")}
            {githubStatus?.repo ? ` (${githubStatus.repo}) ` : " "}
            {t(language, "linkIssue.createDescSuffix")}
          </div>
        ) : (
          <>
            <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
              {t(language, isGiteeLink ? "gitee.linkRefLabel" : "linkIssue.refLabel")}
            </label>
            <input
              className="input"
              data-testid="link-issue-ref-input"
              autoFocus
              value={m.issueRef}
              placeholder={t(language, isGiteeLink ? "gitee.linkRefPlaceholder" : "linkIssue.refPlaceholder")}
              onChange={(e) =>
                setModal((prev) => (prev?.kind === "link_issue" ? { ...prev, issueRef: e.target.value } : prev))
              }
            />
          </>
        )}
        {(isGiteeLink ? giteeStatus && !giteeStatus.authenticated : githubStatus && !githubStatus.ready) && (
          <div className="callout warning xs" style={{ marginTop: 8 }}>
            {remoteReason}
          </div>
        )}
        <div className="modal-actions">
          <button className="btn" type="button" onClick={close}>
            {t(language, "common.cancel")}
          </button>
          <button
            className="btn primary"
            type="button"
            data-testid="submit-link-issue-btn"
            disabled={busy || remoteReady === false}
            onClick={() => void submitLinkIssue()}
          >
            <Icon icon={Link2} size={14} />{" "}
            {isGiteeLink
              ? t(language, "gitee.linkSubmit")
              : m.mode === "create"
                ? t(language, "linkIssue.submitCreate")
                : t(language, "linkIssue.submitLink")}
          </button>
        </div>
      </ModalShell>
    );
  }

  if (m.kind === "deliver") {
    if (!detail) return null;
    const candidates = deliveryPreview?.candidates ?? [];
    const selectedSet = new Set(m.selectedFiles);
    const sandboxActive = Boolean(deliveryPreview?.sandboxActive);
    const createPr = sandboxActive ? true : Boolean(m.createPr);
    const canSubmitExistingCommits = createPr && candidates.length === 0 && (deliveryPreview?.aheadCommitsCount ?? 0) > 0;
    const isGiteeDelivery = deliveryPreview?.remoteProvider === "gitee" || isGiteeProject;
    const prPlatformLabel = isGiteeDelivery ? "Gitee" : "GitHub";
    const prAvailable = Boolean(
      deliveryPreview?.canCreatePr || (isGiteeDelivery ? giteeStatus?.ready : githubStatus?.ready),
    );

    const toggleFile = (filePath: string) => {
      setModal((prev) => {
        if (prev?.kind !== "deliver") return prev;
        const next = new Set(prev.selectedFiles);
        if (next.has(filePath)) next.delete(filePath);
        else next.add(filePath);
        return { ...prev, selectedFiles: [...next] };
      });
    };
    const selectPreset = (mode: "accepted" | "all" | "none") => {
      const files =
        mode === "none"
          ? []
          : mode === "accepted"
            ? candidates.filter((c) => c.inAcceptedSnapshot).map((c) => c.path)
            : candidates.map((c) => c.path);
      setModal((prev) => (prev?.kind === "deliver" ? { ...prev, selectedFiles: files } : prev));
    };
    const submitDeliver = async () => {
      const files = m.selectedFiles.filter((f) => candidates.some((c) => c.path === f));
      if (files.length === 0 && !canSubmitExistingCommits) {
        showToastKey("deliver.needFiles", undefined, true);
        return;
      }
      const msg = m.commitMessage.trim();
      if (files.length > 0 && !msg) {
        showToastKey("deliver.needMessage", undefined, true);
        return;
      }
      const res = await runBusy(() =>
        api.deliver(detail.state.id, {
          files,
          commitMessage: msg,
          expectedRevision: detail.state.revision,
          note: m.note.trim() || undefined,
          ...(createPr
            ? {
                createPr: true,
                branchName: m.branchName?.trim() || undefined,
                baseBranch: m.baseBranch?.trim() || undefined,
                prTitle: m.prTitle?.trim() || undefined,
                ...(m.forceWithLease || deliveryPreview?.remoteBranchDiverged ? { forceWithLease: m.forceWithLease ?? true } : {}),
              }
            : {}),
        }),
      );
      if (res) {
        setModal(null);
        await invalidateAllWorkbenchQueries();
        if (res.pr) {
          if (res.githubSyncWarning) {
            showToastKey(
              "deliver.prCreatedWarn",
              {
                num: res.pr.number,
                warning: resolveWarningParam(res.githubSyncWarning, res.githubSyncWarningRef),
              },
              true,
            );
          } else {
            showToastKey("deliver.prCreated", { num: res.pr.number });
          }
        } else {
          showToastKey(
            res.restartRecommended
              ? "deliver.committedRestart"
              : res.webReloaded
                ? "deliver.committedReload"
                : "deliver.committed",
            { hash: res.delivery.shortHash, count: res.delivery.files.length },
          );
        }
      } else {
        // Commit or branch push may have already succeeded before PR creation failed; refresh preview so retry works cleanly.
        await invalidateAllWorkbenchQueries();
      }
    };

    return (
      <ModalShell onClose={close} testId="deliver-modal">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
          <h3 style={{ margin: 0 }}>
            {createPr
              ? t(language, "deliver.titlePrPlatform", { platform: prPlatformLabel })
              : t(language, "deliver.titleLocal")}
          </h3>
          {!sandboxActive && (
            <div className="segmented" role="tablist" aria-label={t(language, "deliver.modeAria")}>
              <button
                type="button"
                className={!createPr ? "active" : ""}
                data-testid="deliver-mode-local"
                onClick={() => setModal((prev) => (prev?.kind === "deliver" ? { ...prev, createPr: false } : prev))}
              >
                {t(language, "deliver.modeLocal")}
              </button>
              <button
                type="button"
                className={createPr ? "active" : ""}
                data-testid="deliver-mode-pr"
                disabled={!prAvailable}
                onClick={() => setModal((prev) => (prev?.kind === "deliver" ? { ...prev, createPr: true } : prev))}
              >
                <Icon icon={GitPullRequest} size={14} /> {t(language, "deliver.modePr")}
              </button>
            </div>
          )}
        </div>
        <div className="muted xs" style={{ marginBottom: 10 }}>
          {t(language, "deliver.targetPrefix")}
          <strong>{detail.state.id}</strong>
          {t(language, "deliver.targetMiddle")}
          <code>{deliveryPreview?.branch ?? "HEAD"}</code>
          {deliveryPreview?.githubRepo ? t(language, "deliver.repo", { repo: deliveryPreview.githubRepo }) : ""}
          {!createPr && t(language, "deliver.localNote")}
        </div>

        {sandboxActive &&
          deliveryPreview?.sandboxDrift &&
          (deliveryPreview.sandboxDrift.behindCount > 0 || deliveryPreview.sandboxDrift.conflictFiles.length > 0) && (
            <div
              className={`callout ${deliveryPreview.sandboxDrift.conflictFiles.length > 0 ? "danger" : "warning"} xs`}
              data-testid="deliver-drift-callout"
              style={{
                marginBottom: 10,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <span>
                {t(language, "deliver.driftWarn", {
                  count: deliveryPreview.sandboxDrift.behindCount,
                  conflict:
                    deliveryPreview.sandboxDrift.conflictFiles.length > 0
                      ? t(language, "deliver.driftConflictSuffix", {
                          count: deliveryPreview.sandboxDrift.conflictFiles.length,
                        })
                      : "",
                })}
              </span>
              {deliveryPreview.sandboxDrift.canAutoSync ? (
                <button
                  className="btn primary xs"
                  type="button"
                  data-testid="deliver-sync-base-btn"
                  disabled={busy}
                  onClick={() => void syncSandboxBaseAction(detail.state.id)}
                >
                  <Icon icon={RefreshCw} size={14} /> {t(language, "deliver.driftSyncBtn")}
                </button>
              ) : (
                <button
                  className="btn primary xs"
                  type="button"
                  data-testid="deliver-resolve-conflict-btn"
                  disabled={busy}
                  onClick={async () => {
                    close();
                    await dispatchSyncBaseWithAgent(detail, deliveryPreview.sandboxDrift!, bridgeConnected);
                  }}
                >
                  {t(language, "deliver.driftResolveBtn")}
                </button>
              )}
            </div>
          )}

        {(candidates.length > 0 || !canSubmitExistingCommits) && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 8, flexWrap: "wrap" }}>
              <strong style={{ fontSize: 13 }}>
                {t(language, "deliver.selectFiles", {
                  selected: m.selectedFiles.length,
                  total: candidates.length,
                })}
              </strong>
              <div style={{ display: "flex", gap: 6 }}>
                {candidates.some((c) => c.inAcceptedSnapshot) && (
                  <button className="btn xs" type="button" onClick={() => selectPreset("accepted")}>
                    {t(language, "deliver.selectAccepted")}
                  </button>
                )}
                <button className="btn xs" type="button" onClick={() => selectPreset("all")}>
                  {t(language, "deliver.selectAll")}
                </button>
                <button className="btn xs" type="button" onClick={() => selectPreset("none")}>
                  {t(language, "deliver.clear")}
                </button>
              </div>
            </div>
            <div
              style={{
                maxHeight: 190,
                overflowY: "auto",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: 8,
                marginBottom: 10,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              {candidates.length === 0 ? (
                <div className="muted xs">{t(language, "deliver.noChanges")}</div>
              ) : (
                candidates.map((c) => (
                  <label
                    key={c.path}
                    style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, cursor: "pointer" }}
                  >
                    <input
                      type="checkbox"
                      data-testid={`deliver-file-${c.path}`}
                      checked={selectedSet.has(c.path)}
                      onChange={() => toggleFile(c.path)}
                    />
                    <code style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {c.path}
                    </code>
                    <span className="badge neutral" title={c.status} data-testid={`deliver-status-${c.path}`}>
                      {formatGitFileStatusLabel(language, c.status)}
                    </span>
                    {deliveryPreview && deliveryPreview.acceptedSnapshotFileCount > 0 && (
                      <span className={`badge ${c.inAcceptedSnapshot ? "success" : "warning"}`}>
                        {c.inAcceptedSnapshot
                          ? t(language, "deliver.acceptedBadge")
                          : t(language, "deliver.otherBadge")}
                      </span>
                    )}
                  </label>
                ))
              )}
            </div>
          </>
        )}

        {canSubmitExistingCommits && (
          <div className="callout info xs" style={{ marginBottom: 10 }}>
            {t(language, "deliver.existingCommitsPrefix")}
            <strong>{deliveryPreview?.aheadCommitsCount}</strong>
            {t(language, "deliver.existingCommitsSuffix")}
          </div>
        )}

        {(candidates.length > 0 || !canSubmitExistingCommits) && (
          <>
            <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
              {t(language, "deliver.commitLabel")}
            </label>
            <input
              className="input"
              data-testid="deliver-commit-message"
              style={{ marginBottom: 8 }}
              value={m.commitMessage}
              onChange={(e) =>
                setModal((prev) => (prev?.kind === "deliver" ? { ...prev, commitMessage: e.target.value } : prev))
              }
            />
          </>
        )}

        {createPr && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 8, paddingTop: 6, borderTop: "1px solid var(--border)" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
                  {t(language, "deliver.branchLabel")}
                </label>
                <input
                  className="input"
                  data-testid="deliver-pr-branch"
                  readOnly={sandboxActive}
                  value={m.branchName ?? deliveryPreview?.suggestedBranch ?? ""}
                  onChange={(e) =>
                    setModal((prev) => (prev?.kind === "deliver" ? { ...prev, branchName: e.target.value } : prev))
                  }
                />
              </div>
              <div>
                <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
                  {t(language, "deliver.baseLabel")}
                </label>
                <input
                  className="input"
                  data-testid="deliver-pr-base"
                  value={m.baseBranch ?? deliveryPreview?.baseBranch ?? "main"}
                  onChange={(e) =>
                    setModal((prev) => (prev?.kind === "deliver" ? { ...prev, baseBranch: e.target.value } : prev))
                  }
                />
              </div>
            </div>
            <div>
              <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
                {t(language, "deliver.prTitleLabelPlatform", { platform: prPlatformLabel })}
              </label>
              <input
                className="input"
                data-testid="deliver-pr-title"
                value={m.prTitle ?? `${detail.state.id}: ${detail.state.title}`}
                onChange={(e) =>
                  setModal((prev) => (prev?.kind === "deliver" ? { ...prev, prTitle: e.target.value } : prev))
                }
              />
            </div>
            {detail.state.github?.issue && (
              <div className="xs muted">
                {t(language, "deliver.prBodyNotePrefix")}
                <code>Closes #{detail.state.github.issue.number}</code>
                {t(language, isGiteeDelivery ? "deliver.prBodyNoteSuffixGitee" : "deliver.prBodyNoteSuffix")}
              </div>
            )}
            {(sandboxActive || deliveryPreview?.remoteBranchExists || deliveryPreview?.remoteBranchDiverged) && (
              <div style={{ marginTop: 2 }}>
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5 }}>
                  <input
                    type="checkbox"
                    data-testid="deliver-force-lease"
                    checked={m.forceWithLease ?? Boolean(deliveryPreview?.remoteBranchDiverged)}
                    onChange={(e) =>
                      setModal((prev) =>
                        prev?.kind === "deliver" ? { ...prev, forceWithLease: e.target.checked } : prev,
                      )
                    }
                  />
                  <span>{t(language, "deliver.forceWithLeaseLabel")}</span>
                </label>
                {deliveryPreview?.remoteBranchDiverged && (
                  <div className="xs muted" style={{ paddingLeft: 22, marginTop: 2 }}>
                    {t(language, "deliver.forceWithLeaseWarn")}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <label className="muted xs" style={{ display: "block", marginBottom: 4 }}>
          {t(language, "deliver.noteLabel")}
        </label>
        <input
          className="input"
          data-testid="deliver-note"
          value={m.note}
          placeholder={t(language, "deliver.notePlaceholder")}
          onChange={(e) =>
            setModal((prev) => (prev?.kind === "deliver" ? { ...prev, note: e.target.value } : prev))
          }
        />
        <div className="modal-actions">
          <button className="btn" type="button" onClick={close}>
            {t(language, "common.cancel")}
          </button>
          <button
            className="btn primary"
            type="button"
            data-testid="submit-deliver-btn"
            disabled={busy || (!canSubmitExistingCommits && m.selectedFiles.length === 0)}
            onClick={() => void submitDeliver()}
          >
            {createPr
              ? t(language, "deliver.submitPrPlatform", { platform: prPlatformLabel })
              : t(language, "deliver.submitLocal")}
          </button>
        </div>
      </ModalShell>
    );
  }

  if (m.kind === "spawn_children") {
    const validItems = m.items.filter((it) => it.title.trim().length > 0);
    const submitSpawn = async () => {
      if (validItems.length === 0) {
        showToastKey("spawn.emptyError", undefined, true);
        return;
      }
      const res = await runBusy(() =>
        api.spawnSubRequirements(m.parentId, {
          items: validItems.map((it) => ({ title: it.title.trim(), goal: it.goal.trim() || it.title.trim() })),
          track: m.track,
        }),
      );
      if (res) {
        await invalidateAllWorkbenchQueries();
        setModal(null);
        showToastKey("spawn.createdToast", { count: res.created.length });
      }
    };
    return (
      <ModalShell onClose={close} wide testId="spawn-children-modal">
        <h3>{t(language, "spawn.title")}</h3>
        <p className="xs muted" style={{ margin: "0 0 10px" }}>
          {t(language, "spawn.desc")}
        </p>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 8 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <span className="muted xs">{t(language, "spawn.trackLabel")}</span>
            <select
              className="select xs"
              data-testid="spawn-track-select"
              value={m.track}
              onChange={(e) =>
                setModal((prev) =>
                  prev?.kind === "spawn_children" ? { ...prev, track: e.target.value as Track } : prev,
                )
              }
            >
              <option value="plan_first">{t(language, "spawn.trackPlan")}</option>
              <option value="fast_track">{t(language, "spawn.trackFast")}</option>
            </select>
          </label>
          <button
            className="btn xs"
            type="button"
            data-testid="spawn-add-item-btn"
            onClick={() =>
              setModal((prev) =>
                prev?.kind === "spawn_children"
                  ? { ...prev, items: [...prev.items, { title: "", goal: "" }] }
                  : prev,
              )
            }
          >
            + {t(language, "spawn.addItem")}
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 320, overflowY: "auto", marginBottom: 12 }}>
          {m.items.map((item, idx) => (
            <div
              key={idx}
              style={{
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: 8,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  className="input"
                  data-testid={`spawn-item-title-${idx}`}
                  value={item.title}
                  placeholder={t(language, "spawn.itemTitlePlaceholder")}
                  onChange={(e) =>
                    setModal((prev) => {
                      if (prev?.kind !== "spawn_children") return prev;
                      const next = [...prev.items];
                      next[idx] = { ...next[idx]!, title: e.target.value };
                      return { ...prev, items: next };
                    })
                  }
                />
                <button
                  className="btn ghost xs"
                  type="button"
                  aria-label={t(language, "common.delete")}
                  onClick={() =>
                    setModal((prev) =>
                      prev?.kind === "spawn_children"
                        ? { ...prev, items: prev.items.filter((_, i) => i !== idx) }
                        : prev,
                    )
                  }
                >
                  <Icon icon={Trash2} size={14} />
                </button>
              </div>
              <textarea
                className="textarea"
                rows={2}
                data-testid={`spawn-item-goal-${idx}`}
                value={item.goal}
                placeholder={t(language, "spawn.itemGoalPlaceholder")}
                onChange={(e) =>
                  setModal((prev) => {
                    if (prev?.kind !== "spawn_children") return prev;
                    const next = [...prev.items];
                    next[idx] = { ...next[idx]!, goal: e.target.value };
                    return { ...prev, items: next };
                  })
                }
              />
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn" type="button" onClick={close}>
            {t(language, "common.cancel")}
          </button>
          <button
            className="btn primary"
            type="button"
            data-testid="spawn-submit-btn"
            disabled={busy || validItems.length === 0}
            onClick={() => void submitSpawn()}
          >
            {t(language, "spawn.submit", { count: validItems.length })}
          </button>
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell onClose={close}>
      <h3>{t(language, "debug.title")}</h3>
      <pre className="evidence-log">{m.text}</pre>
      <div className="modal-actions">
        <button className="btn primary" type="button" onClick={close}>
          {t(language, "common.close")}
        </button>
      </div>
    </ModalShell>
  );
}
