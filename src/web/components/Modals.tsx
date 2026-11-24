import { useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowUp,
  Ban,
  BarChart3,
  BookOpen,
  Bug,
  Check,
  CircleAlert,
  CircleHelp,
  CircleOff,
  ClipboardCheck,
  Copy,
  Crosshair,
  Download,
  ExternalLink,
  FileText,
  Flame,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitCommit,
  GitFork,
  GitPullRequest,
  Globe,
  Inbox,
  Info,
  Laptop,
  Lightbulb,
  Link2,
  ListChecks,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Send,
  Server,
  Settings,
  Sparkles,
  Terminal,
  Trash2,
  Wrench,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import type { StructuredMessageRef } from "../../core/errors.ts";
import type { GitRemoteProvider, OutputLanguage, PrivacyMode, RunBillingMode, Track } from "../../core/types.ts";
import type { PainPointCategory } from "../../hub/evolution.ts";
import {
  ROUTING_STAGES,
  type HarnessId,
  type ModelPriceOverride,
  type ReasoningEffort,
  type RoutingPreset,
  type RoutingStage,
} from "../../hub/types.ts";
import { api, evolutionAttachmentUrl, setApiProjectScope, type HubStateResponse, type ProjectInfoResponse } from "../api.ts";
import {
  dispatchSyncBaseWithAgent,
  guardRequirementRunLock,
  invalidateAllWorkbenchQueries,
  notifyCascadeSyncResults,
  openRequirement,
  queryClient,
  queryKeys,
  resolveEffectiveRouting,
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
  useHubPricingQuery,
  useHubStateQuery,
  usePlaybookQuery,
  useProjectQuery,
  useProjectSandboxesQuery,
  useRequirementQuery,
  useRequirementRunLock,
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
import {
  effortLabel,
  formatBytes,
  formatDateTime,
  formatReviewFixFeedback,
  getModelEffortCapability,
  parseRunnerKey,
} from "../state.ts";
import { useDraftStore } from "../stores/draftStore.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { AttachmentGallery } from "./AttachmentGallery.tsx";
import { AttachmentPicker } from "./AttachmentPicker.tsx";
import { Icon } from "./Icon.tsx";
import { MarkdownView, ModalShell, RunLockNotice } from "./Primitives.tsx";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Checkbox } from "./ui/checkbox.tsx";
import { DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "./ui/dialog.tsx";
import { Input } from "./ui/input.tsx";
import { Label } from "./ui/label.tsx";
import { Radio, RadioGroup, RadioGroupPrimitive, RadioPrimitive } from "./ui/radio-group.tsx";
import { RoutingModelPicker } from "./ui/RoutingModelPicker.tsx";
import { SegmentedControl, SegmentedControlItem } from "./ui/segmented-control.tsx";
import { SimpleSelect } from "./ui/select.tsx";
import { Textarea } from "./ui/textarea.tsx";

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

const STANDARD_QUOTA_POOLS = [
  "opencode-go",
  "openai-codex",
  "qoder-cn",
  "google-antigravity",
  "opencode-free",
  "anthropic",
  "openai",
];

function ObservabilityPricingModal({ onClose }: { onClose: () => void }) {
  const language = useUiStore((s) => s.language);
  const busy = useUiStore((s) => s.busy);
  const showToastKey = useUiStore((s) => s.showToastKey);
  const { data } = useHubPricingQuery(true);

  const [retentionDays, setRetentionDays] = useState<number>(30);
  const [billingMap, setBillingMap] = useState<Record<string, RunBillingMode>>({});
  const [priceRows, setPriceRows] = useState<Array<{ key: string; spec: ModelPriceOverride }>>([]);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (!data || initialized) return;
    const obs = data.observability ?? {};
    setRetentionDays(obs.traceRetentionDays ?? 30);
    setBillingMap(obs.billingOverrides ? { ...obs.billingOverrides } : {});
    setPriceRows(
      obs.pricingOverrides
        ? Object.entries(obs.pricingOverrides).map(([key, spec]) => ({ key, spec: { ...spec } }))
        : [],
    );
    setInitialized(true);
  }, [data, initialized]);

  const pools = Array.from(new Set([...STANDARD_QUOTA_POOLS, ...Object.keys(billingMap)]));

  const handleSave = async () => {
    const pricingOverrides: Record<string, ModelPriceOverride> = {};
    for (const row of priceRows) {
      const k = row.key.trim();
      if (!k) continue;
      pricingOverrides[k] = row.spec;
    }
    const ok = await runBusy(() =>
      api.updateHubPricing({
        traceRetentionDays: Math.max(1, Math.floor(retentionDays || 30)),
        billingOverrides: billingMap,
        pricingOverrides,
      }),
    );
    if (ok) {
      await invalidateAllWorkbenchQueries();
      showToastKey("pricing.saved");
      onClose();
    }
  };

  const handlePrune = async () => {
    const out = await runBusy(() => api.pruneHubRunTraces(Math.max(0, Math.floor(retentionDays || 30))));
    if (out) {
      await invalidateAllWorkbenchQueries();
      showToastKey("pricing.prunedSummary", {
        deleted: out.deletedFiles,
        freed: formatBytes(out.freedBytes),
        projects: out.projectsPruned ?? 1,
      });
    }
  };

  return (
    <ModalShell onClose={onClose} wide hasExplicitTitle>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Icon icon={Settings} size={20} />
          <span>{t(language, "pricing.title")}</span>
        </DialogTitle>
        <DialogDescription>{t(language, "pricing.hint")}</DialogDescription>
      </DialogHeader>

      <DialogPanel className="space-y-4">
        <div className="field">
          <Label className="field-label" htmlFor="obs-retention-days">
            {t(language, "pricing.retentionDays")}
          </Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="obs-retention-days"
              type="number"
              min={1}
              max={3650}
              size="sm"
              className="w-28"
              value={retentionDays}
              onChange={(e) => setRetentionDays(Number(e.target.value) || 30)}
            />
            <Button
              type="button"
              variant="outline"
              size="xs"
              data-testid="prune-traces-now-btn"
              disabled={busy}
              onClick={() => void handlePrune()}
            >
              <Icon icon={Trash2} size={14} /> {t(language, "pricing.pruneNow")}
            </Button>
          </div>
        </div>

        <div className="field">
          <div className="field-label">{t(language, "pricing.billingOverrides")}</div>
          <div className="pricing-grid">
            {pools.map((pool) => {
              const label = data?.quotaPoolLabels?.[pool] ?? pool;
              const currentVal = billingMap[pool] ?? "";
              return (
                <div key={pool} className="pricing-row">
                  <span className="xs">
                    <strong>{label}</strong> <code className="muted">{pool}</code>
                  </span>
                  <SimpleSelect
                    size="sm"
                    value={currentVal}
                    onValueChange={(next) => {
                      const val = next as RunBillingMode | "";
                      setBillingMap((prev) => {
                        const copy = { ...prev };
                        if (!val) delete copy[pool];
                        else copy[pool] = val;
                        return copy;
                      });
                    }}
                    options={[
                      { value: "", label: "Default" },
                      { value: "subscription", label: t(language, "insights.billing.subscription") },
                      { value: "api", label: t(language, "insights.billing.api") },
                      { value: "free", label: t(language, "insights.billing.free") },
                    ]}
                  />
                </div>
              );
            })}
          </div>
        </div>

        <div className="field">
          <div className="card-head" style={{ marginBottom: 6 }}>
            <span className="field-label" style={{ margin: 0 }}>{t(language, "pricing.pricingOverrides")}</span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() =>
                setPriceRows((prev) => [
                  ...prev,
                  { key: "", spec: { input: 2.0, output: 8.0, cacheRead: 0.2, contextWindow: 200_000 } },
                ])
              }
            >
              <Icon icon={Plus} size={14} /> {t(language, "pricing.addModelOverride")}
            </Button>
          </div>
          <div className="flex flex-col gap-1.5">
            {priceRows.map((row, idx) => (
              <div key={idx} className="pricing-override-row">
                <Input
                  type="text"
                  size="sm"
                  placeholder={t(language, "pricing.modelKeyPlaceholder")}
                  value={row.key}
                  onChange={(e) =>
                    setPriceRows((prev) => prev.map((r, i) => (i === idx ? { ...r, key: e.target.value } : r)))
                  }
                />
                <Input
                  type="number"
                  step="0.01"
                  size="sm"
                  title="Input $/1M"
                  value={row.spec.input}
                  onChange={(e) =>
                    setPriceRows((prev) =>
                      prev.map((r, i) => (i === idx ? { ...r, spec: { ...r.spec, input: Number(e.target.value) || 0 } } : r)),
                    )
                  }
                />
                <Input
                  type="number"
                  step="0.01"
                  size="sm"
                  title="Output $/1M"
                  value={row.spec.output}
                  onChange={(e) =>
                    setPriceRows((prev) =>
                      prev.map((r, i) => (i === idx ? { ...r, spec: { ...r.spec, output: Number(e.target.value) || 0 } } : r)),
                    )
                  }
                />
                <Input
                  type="number"
                  size="sm"
                  title="Context Window"
                  value={row.spec.contextWindow ?? 200_000}
                  onChange={(e) =>
                    setPriceRows((prev) =>
                      prev.map((r, i) =>
                        i === idx ? { ...r, spec: { ...r.spec, contextWindow: Number(e.target.value) || 200_000 } } : r,
                      ),
                    )
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Remove"
                  onClick={() => setPriceRows((prev) => prev.filter((_, i) => i !== idx))}
                >
                  <Icon icon={Trash2} size={14} />
                </Button>
              </div>
            ))}
          </div>
        </div>
      </DialogPanel>

      <DialogFooter>
        <Button variant="ghost" type="button" onClick={onClose}>
          <Icon icon={X} size={14} /> {t(language, "common.cancel")}
        </Button>
        <Button
          variant="default"
          type="button"
          data-testid="save-pricing-btn"
          disabled={busy}
          onClick={() => void handleSave()}
        >
          <Icon icon={Save} size={14} /> {t(language, "pricing.save")}
        </Button>
      </DialogFooter>
    </ModalShell>
  );
}

export function Modals() {
  const language = useUiStore((s) => s.language);
  const m = useUiStore((s) => s.modal);
  const busy = useUiStore((s) => s.busy);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const selectedId = useUiStore((s) => s.selectedId);
  const setModal = useUiStore((s) => s.setModal);
  const setMainView = useUiStore((s) => s.setMainView);
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
  const modalRequirementId = m?.kind === "link_issue" ? m.requirementId : selectedId;
  const runLock = useRequirementRunLock(modalRequirementId);
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
  const runLocked = runLock !== null;
  const bridgeConnected = Boolean(project?.bridge.connected);
  const harnesses = hub?.harnesses ?? [];
  const routing = resolveEffectiveRouting(hub, project);
  const detail = reqData?.detail ?? null;

  if (m.kind === "new_req") {
    const mode = m.mode ?? "create";
    const createIssueChecked =
      m.createGitHubIssue ?? Boolean(project?.project?.github?.autoCreateIssue && githubStatus?.ready);

    return (
      <ModalShell onClose={close} wide={mode === "import_issue" && isGiteeProject} testId="new-req-modal" hasExplicitTitle>
        <DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-2 pe-6">
            <DialogTitle className="flex items-center gap-2">
              <Icon icon={Plus} size={20} />
              <span>{t(language, "newReq.title")}</span>
            </DialogTitle>
            <SegmentedControl
              size="sm"
              aria-label={t(language, "newReq.modeAria")}
              render={
                <RadioGroupPrimitive
                  className="flex items-center"
                  value={mode}
                  onValueChange={(next) => {
                    if (next === "create") {
                      setModal((prev) => (prev?.kind === "new_req" ? { ...prev, mode: "create" } : prev));
                    } else if (next === "import_issue") {
                      setModal((prev) =>
                        prev?.kind === "new_req"
                          ? { ...prev, mode: "import_issue", issueRef: prev.issueRef ?? "" }
                          : prev,
                      );
                    }
                  }}
                />
              }
            >
              <SegmentedControlItem
                render={<RadioPrimitive.Root value="create" data-testid="new-req-mode-create" />}
              >
                <Icon icon={Pencil} size={14} /> {t(language, "newReq.modeCreate")}
              </SegmentedControlItem>
              <SegmentedControlItem
                render={<RadioPrimitive.Root value="import_issue" data-testid="new-req-mode-import" />}
              >
                <Icon icon={Link2} size={14} /> {t(language, isGiteeProject ? "newReq.modeImportGitee" : "newReq.modeImport")}
              </SegmentedControlItem>
            </SegmentedControl>
          </div>
        </DialogHeader>

        {mode === "create" ? (
          <>
            <DialogPanel className="space-y-3">
              <div>
                <Label htmlFor="new-req-goal" className="mb-1.5 block text-xs text-muted-foreground font-normal">
                  {t(language, "newReq.goalLabel")}
                </Label>
                <Textarea
                  id="new-req-goal"
                  data-testid="new-req-goal"
                  autoFocus
                  value={m.goal}
                  placeholder={t(language, "newReq.goalPlaceholder")}
                  onChange={(e) =>
                    setModal((prev) => (prev?.kind === "new_req" ? { ...prev, goal: e.target.value } : prev))
                  }
                />
              </div>
              <AttachmentPicker
                value={m.attachments ?? []}
                onChange={(attachments) =>
                  setModal((prev) => (prev?.kind === "new_req" ? { ...prev, attachments } : prev))
                }
                disabled={busy}
              />
              {!isGiteeProject && (
                <Label className="flex items-center gap-2 text-[13px] font-normal">
                  <Checkbox
                    data-testid="new-req-create-issue"
                    checked={createIssueChecked}
                    disabled={githubStatus !== undefined && !githubStatus.ready}
                    onCheckedChange={(checked) =>
                      setModal((prev) =>
                        prev?.kind === "new_req" ? { ...prev, createGitHubIssue: Boolean(checked) } : prev,
                      )
                    }
                  />
                  <span>
                    {t(language, "newReq.syncIssue")}
                    {githubStatus?.repo ? ` (${githubStatus.repo})` : ""}
                    {githubStatus && !githubStatus.ready ? ` — ${formatGitHubStatusReason(language, githubStatus)}` : ""}
                  </span>
                </Label>
              )}
              {project?.git?.isGitRepo && (
                <div className="space-y-2">
                  <Label className="flex items-center gap-2 text-[13px] font-normal">
                    <Checkbox
                      data-testid="new-req-create-sandbox"
                      checked={Boolean(m.createSandbox)}
                      onCheckedChange={(checked) =>
                        setModal((prev) =>
                          prev?.kind === "new_req" ? { ...prev, createSandbox: Boolean(checked) } : prev,
                        )
                      }
                    />
                    <span>{t(language, "newReq.createSandbox")}</span>
                  </Label>
                  {m.createSandbox && (projectSandboxes?.sandboxes.length ?? 0) > 0 && (
                    <div className="new-req-stack-row">
                      <span className="xs muted new-req-stack-label">{t(language, "newReq.stackedOn")}</span>
                      <SimpleSelect
                        size="sm"
                        className="new-req-stack-select min-h-7 w-0 min-w-0 max-w-full flex-1"
                        data-testid="new-req-stack-select"
                        value={m.stackedOnReqId ?? ""}
                        onValueChange={(next) =>
                          setModal((prev) =>
                            prev?.kind === "new_req" ? { ...prev, stackedOnReqId: next || undefined } : prev,
                          )
                        }
                        options={[
                          { value: "", label: t(language, "newReq.stackMain") },
                          ...projectSandboxes!.sandboxes
                            .filter((sb) => sb.stage !== "cancelled")
                            .map((sb) => ({
                              value: sb.requirementId,
                              label: `${sb.requirementId} (${sb.branch})`,
                            })),
                        ]}
                      />
                    </div>
                  )}
                </div>
              )}
            </DialogPanel>
            <DialogFooter>
              <Button variant="ghost" type="button" onClick={close}>
                <Icon icon={X} size={14} /> {t(language, "common.cancel")}
              </Button>
              <Button
                variant="outline"
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
                <Icon icon={Save} size={14} /> {t(language, "newReq.saveDraft")}
              </Button>
              <Button
                variant="default"
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
                <Icon icon={Zap} size={14} /> {t(language, "newReq.createDispatch")}
              </Button>
            </DialogFooter>
          </>
        ) : isGiteeProject ? (
          <div data-testid="gitee-import-pane" className="contents">
            <DialogPanel className="space-y-3">
              {giteeStatus && !giteeStatus.authenticated ? (
                <Alert variant="warning">
                  <Icon icon={AlertTriangle} size={14} />
                  <AlertDescription className="space-y-2">
                    <div>{formatGiteeStatusReason(language, giteeStatus)}</div>
                    <Button
                      variant="outline"
                      size="xs"
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
                      <Icon icon={Settings} size={14} /> {t(language, "gitee.gotoSettings")}
                    </Button>
                  </AlertDescription>
                </Alert>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <SegmentedControl
                      size="sm"
                      aria-label={t(language, "gitee.filterAria")}
                      render={
                        <RadioGroupPrimitive
                          className="flex items-center"
                          value={giteeFilter}
                          onValueChange={(next) => {
                            if (next === "assigned" || next === "created" || next === "all") {
                              setModal((prev) =>
                                prev?.kind === "new_req" ? { ...prev, giteeFilter: next, selectedGiteeIssue: null } : prev,
                              );
                            }
                          }}
                        />
                      }
                    >
                      {(
                        [
                          ["assigned", t(language, "gitee.filterAssigned")],
                          ["created", t(language, "gitee.filterCreated")],
                          ["all", t(language, "gitee.filterAll")],
                        ] as const
                      ).map(([val, label]) => (
                        <SegmentedControlItem
                          key={val}
                          render={<RadioPrimitive.Root value={val} data-testid={`gitee-filter-${val}`} />}
                        >
                          {label}
                        </SegmentedControlItem>
                      ))}
                    </SegmentedControl>
                    <SimpleSelect
                      size="sm"
                      aria-label={t(language, "gitee.stateAria")}
                      data-testid="gitee-state-select"
                      value={giteeState}
                      onValueChange={(next) =>
                        setModal((prev) =>
                          prev?.kind === "new_req"
                            ? {
                                ...prev,
                                giteeState: next as "active" | "open" | "progressing" | "closed" | "all",
                                selectedGiteeIssue: null,
                              }
                            : prev,
                        )
                      }
                      options={[
                        { value: "active", label: t(language, "gitee.stateActive") },
                        { value: "open", label: t(language, "gitee.stateOpen") },
                        { value: "progressing", label: t(language, "gitee.stateProgressing") },
                        { value: "closed", label: t(language, "gitee.stateClosed") },
                        { value: "all", label: t(language, "gitee.stateAll") },
                      ]}
                    />
                    <Button
                      variant="outline"
                      size="xs"
                      type="button"
                      data-testid="refresh-gitee-issues-btn"
                      disabled={giteeIssuesQuery.isFetching}
                      onClick={() => void giteeIssuesQuery.refetch()}
                    >
                      <Icon icon={RefreshCw} size={14} /> {t(language, "gitee.refresh")}
                    </Button>
                  </div>

                  <Input
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
                    className="flex max-h-60 flex-col gap-1.5 overflow-y-auto rounded-lg border p-1.5"
                  >
                    {giteeIssuesQuery.isLoading ? (
                      <div className="muted xs p-3 text-center">
                        {t(language, "gitee.loading")}
                      </div>
                    ) : giteeIssuesQuery.isError ? (
                      <Alert variant="error">
                        <Icon icon={AlertTriangle} size={14} />
                        <AlertDescription>
                          {t(language, "gitee.loadFailed")}
                          {describeClientError(language, giteeIssuesQuery.error)}
                        </AlertDescription>
                      </Alert>
                    ) : (giteeIssuesQuery.data?.items.length ?? 0) === 0 ? (
                      <div className="muted xs p-3 text-center">
                        {t(language, "gitee.empty")}
                        {giteeStatus?.enterprise
                          ? t(language, "gitee.enterpriseSuffix", { enterprise: giteeStatus.enterprise })
                          : ""}
                      </div>
                    ) : (
                      giteeIssuesQuery.data!.items.map((item) => {
                        const isSelected = m.selectedGiteeIssue?.ident === item.ident;
                        const stateVariant =
                          item.state === "closed" || item.state === "rejected"
                            ? "secondary"
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
                            className={`flex items-center justify-between gap-2 rounded-md border px-2.5 py-2 ${
                              isSelected ? "border-primary bg-accent/60" : "border-border bg-transparent"
                            } ${item.importedRequirementId ? "cursor-default" : "cursor-pointer"}`}
                          >
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div className="mb-0.5 flex flex-wrap items-center gap-1.5">
                                <code className="xs">#{item.ident}</code>
                                {item.issueType && <Badge variant="outline" size="sm">{item.issueType}</Badge>}
                                <Badge variant={stateVariant} size="sm">{item.stateName ?? item.state}</Badge>
                                {item.programName && <span className="xs muted">{item.programName}</span>}
                                <span className="xs muted">
                                  {item.repository ? item.repository : t(language, "gitee.unlinkedRepo")}
                                </span>
                              </div>
                              <div className="text-[13px] font-medium">{item.title}</div>
                            </div>
                            {item.importedRequirementId && (
                              <Button
                                variant="outline"
                                size="xs"
                                type="button"
                                data-testid={`open-imported-gitee-${item.ident}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setModal(null);
                                  void openRequirement(item.importedRequirementId!);
                                }}
                              >
                                <Icon icon={ExternalLink} size={14} /> {t(language, "gitee.imported", { id: item.importedRequirementId })}
                              </Button>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </>
              )}

              <div>
                <Label htmlFor="import-issue-ref" className="mb-1 block text-xs text-muted-foreground font-normal">
                  {t(language, "gitee.manualLabel")}
                </Label>
                <Input
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
              </div>
            </DialogPanel>
            <DialogFooter>
              <Button variant="ghost" type="button" onClick={close}>
                <Icon icon={X} size={14} /> {t(language, "common.cancel")}
              </Button>
              <Button
                variant="outline"
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
                <Icon icon={Download} size={14} /> {t(language, "gitee.importDraft")}
              </Button>
              <Button
                variant="default"
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
                <Icon icon={Zap} size={14} /> {t(language, "gitee.importDispatch")}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            <DialogPanel className="space-y-3">
              <div>
                <Label htmlFor="import-issue-ref" className="mb-1.5 block text-xs text-muted-foreground font-normal">
                  {githubStatus?.repo
                    ? t(language, "newReq.importLabelRepo", { repo: githubStatus.repo })
                    : t(language, "newReq.importLabel")}
                </Label>
                <Input
                  id="import-issue-ref"
                  data-testid="import-issue-ref"
                  autoFocus
                  value={m.issueRef ?? ""}
                  placeholder={t(language, "newReq.importPlaceholder")}
                  onChange={(e) =>
                    setModal((prev) => (prev?.kind === "new_req" ? { ...prev, issueRef: e.target.value } : prev))
                  }
                />
              </div>
              {githubStatus && !githubStatus.ready && (
                <Alert variant="warning">
                  <Icon icon={AlertTriangle} size={14} />
                  <AlertDescription>{formatGitHubStatusReason(language, githubStatus)}</AlertDescription>
                </Alert>
              )}
            </DialogPanel>
            <DialogFooter>
              <Button variant="ghost" type="button" onClick={close}>
                <Icon icon={X} size={14} /> {t(language, "common.cancel")}
              </Button>
              <Button
                variant="outline"
                type="button"
                data-testid="import-issue-draft-btn"
                disabled={busy}
                onClick={() => void submitImportGitHubIssue(m.issueRef ?? "", false)}
              >
                <Icon icon={Download} size={14} /> {t(language, "newReq.importDraft")}
              </Button>
              <Button
                variant="default"
                type="button"
                data-testid="import-issue-dispatch-btn"
                disabled={busy}
                onClick={() => void submitImportGitHubIssue(m.issueRef ?? "", true)}
              >
                <Icon icon={Zap} size={14} /> {t(language, "newReq.importDispatch")}
              </Button>
            </DialogFooter>
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
      <ModalShell onClose={close} wide testId="add-project-modal" hasExplicitTitle>
        <DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-2 pe-6">
            <DialogTitle className="flex items-center gap-2">
              <Icon icon={FolderPlus} size={20} />
              <span>{t(language, "addProject.title")}</span>
            </DialogTitle>
            <Button
              variant="ghost"
              size="xs"
              type="button"
              data-testid="toggle-node-help-btn"
              onClick={() =>
                setModal((prev) => (prev?.kind === "add_project" ? { ...prev, showNodeHelp: !prev.showNodeHelp } : prev))
              }
            >
              <Icon icon={CircleHelp} size={14} />{" "}
              {m.showNodeHelp ? t(language, "addProject.helpClose") : t(language, "addProject.helpOpen")}
            </Button>
          </div>
        </DialogHeader>

        <DialogPanel className="space-y-3">
          {(connectedNodes.length > 1 || selectedNodeId !== "local") && (
            <div>
              <Label className="mb-1 block text-xs text-muted-foreground font-normal">
                {t(language, "addProject.nodeLabel")}
              </Label>
              <SegmentedControl
                size="sm"
                aria-label={t(language, "addProject.nodeAria")}
                data-testid="add-project-node-tabs"
                render={
                  <RadioGroupPrimitive
                    className="flex flex-wrap items-center"
                    value={selectedNodeId}
                    onValueChange={(next) => {
                      if (next) void browseDir(undefined, next);
                    }}
                  />
                }
              >
                {connectedNodes.map((n) => (
                  <SegmentedControlItem
                    key={n.nodeId}
                    render={<RadioPrimitive.Root value={n.nodeId} data-testid={`add-project-node-${n.nodeId}`} />}
                  >
                    <Icon icon={n.isLocal ? Server : Laptop} size={14} /> {n.name}
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
            </div>
          )}

          {m.showNodeHelp && (
            <Alert variant="info" data-testid="node-connect-guide">
              <Icon icon={Info} size={14} />
              <AlertTitle>{t(language, "addProject.helpTitle")}</AlertTitle>
              <AlertDescription className="space-y-1.5">
                <div>{t(language, "addProject.helpDesc")}</div>
                <pre className="whitespace-pre-wrap font-mono text-[11.5px]">
                  {`wb node install --hub ${originHint} --token <${t(language, "addProject.installToken")}> --id wsl-work --name "Windows WSL2"`}
                </pre>
                <div className="muted">
                  {t(language, "addProject.helpNotePrefix")}
                  <code>wb service password</code>
                  {t(language, "addProject.helpNoteSuffix")}
                </div>
              </AlertDescription>
            </Alert>
          )}

          <div>
            <Label htmlFor="add-project-path" className="mb-1 block text-xs text-muted-foreground font-normal">
              {t(language, "addProject.pathLabel")}
            </Label>
            <div className="flex gap-2">
              <Input
                id="add-project-path"
                data-testid="add-project-path"
                autoFocus
                value={m.pathInput}
                placeholder="/home/tsien/code/your-project"
                onChange={(e) =>
                  setModal((prev) => (prev?.kind === "add_project" ? { ...prev, pathInput: e.target.value } : prev))
                }
              />
              <Button
                variant="outline"
                type="button"
                data-testid="browse-go-btn"
                onClick={() => void browseDir(m.pathInput)}
              >
                <Icon icon={FolderOpen} size={14} /> {t(language, "addProject.open")}
              </Button>
            </div>
          </div>

          <div className="browse-box" data-testid="fs-browse-list">
            {browse ? (
              <>
                <div className="browse-head">
                  <span className="xs muted">{browse.currentPath}</span>
                  <div className="flex items-center gap-1.5">
                    {browse.isGitRepo ? (
                      <Badge variant="success" size="sm">
                        <Icon icon={GitBranch} size={14} /> {t(language, "addProject.gitRepo")}
                      </Badge>
                    ) : (
                      <Badge variant="secondary" size="sm">{t(language, "addProject.plainDir")}</Badge>
                    )}
                    {browse.workbenchInitialized && (
                      <Badge variant="info" size="sm">{t(language, "addProject.initialized")}</Badge>
                    )}
                    {browse.parentPath && (
                      <Button
                        variant="ghost"
                        size="xs"
                        type="button"
                        onClick={() => void browseDir(browse.parentPath!)}
                      >
                        <Icon icon={ArrowUp} size={14} /> {t(language, "addProject.parent")}
                      </Button>
                    )}
                  </div>
                </div>
                <div className="browse-entries">
                  {browse.entries.length === 0 ? (
                    <div className="muted xs p-2.5">
                      {t(language, "addProject.noSubdirs")}
                    </div>
                  ) : (
                    browse.entries.map((e) => (
                      <div key={e.path} className="browse-entry" onClick={() => void browseDir(e.path)}>
                        <span className="browse-entry-name">
                          <Icon icon={Folder} size={14} /> {e.name}
                        </span>
                        <span className="flex gap-1.5">
                          {e.isGitRepo && <Badge variant="success" size="sm">git</Badge>}
                          {e.workbenchInitialized && <Badge variant="info" size="sm">wb</Badge>}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </>
            ) : (
              <div className="muted xs p-3">
                {t(language, "addProject.loading")}
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-2.5">
            <div className="min-w-44 flex-1">
              <Label htmlFor="add-project-name" className="mb-1 block text-xs text-muted-foreground font-normal">
                {t(language, "addProject.nameLabel")}
              </Label>
              <Input
                id="add-project-name"
                value={m.nameInput}
                placeholder={t(language, "addProject.namePlaceholder")}
                onChange={(e) =>
                  setModal((prev) => (prev?.kind === "add_project" ? { ...prev, nameInput: e.target.value } : prev))
                }
              />
            </div>
            <div className="min-w-44 flex-1">
              <Label htmlFor="add-project-privacy" className="mb-1 block text-xs text-muted-foreground font-normal">
                {t(language, "addProject.privacyLabel")}
              </Label>
              <SimpleSelect
                id="add-project-privacy"
                className="w-full"
                value={m.initPrivacy}
                onValueChange={(next) =>
                  setModal((prev) =>
                    prev?.kind === "add_project"
                      ? { ...prev, initPrivacy: next as PrivacyMode | "none" }
                      : prev,
                  )
                }
                options={[
                  { value: "local", label: t(language, "addProject.privacyLocal") },
                  { value: "tracked", label: t(language, "addProject.privacyTracked") },
                  { value: "none", label: t(language, "addProject.privacyNone") },
                ]}
              />
            </div>
          </div>
        </DialogPanel>

        <DialogFooter>
          <Button variant="ghost" type="button" onClick={close}>
            <Icon icon={X} size={14} /> {t(language, "common.cancel")}
          </Button>
          <Button
            variant="default"
            type="button"
            data-testid="submit-add-project-btn"
            disabled={busy}
            onClick={() => void submitAddProject()}
          >
            <Icon icon={Plus} size={14} /> {t(language, "addProject.submit")}
          </Button>
        </DialogFooter>
      </ModalShell>
    );
  }

  if (m.kind === "routing") {
    const tab = m.tab ?? (!noHubProject && project?.initialized ? "project" : "global");
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
      if (patch.routing) {
        const projKey = queryKeys.project(activeProjectId);
        queryClient.setQueryData<ProjectInfoResponse>(projKey, (prev) =>
          prev
            ? {
                ...prev,
                routing: patch.routing,
                project: prev.project ? { ...prev.project, routing: patch.routing } : prev.project,
              }
            : prev,
        );
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.hubState });
      void queryClient.invalidateQueries({ queryKey: ["project"] });
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
      const startModal = useUiStore.getState().modal;
      const draftAtStart = startModal?.kind === "routing" ? startModal.draft : undefined;
      const res = await runBusy(() => api.applyPreset(preset));
      if (res) {
        useDraftStore.getState().clearRunnerOverrides();
        setModal((prev) =>
          prev?.kind === "routing" && prev.draft === draftAtStart ? { ...prev, draft: res.routing } : prev,
        );
        await syncHubStatePatch({ routing: res.routing });
        showToastKey("routing.presetApplied", { preset });
      }
    };

    const saveGlobal = async () => {
      const tokenPatch = m.clearGiteeToken
        ? null
        : giteeTokenValue.trim()
          ? giteeTokenValue.trim()
          : undefined;
      const res = await runBusy(() =>
        api.updateHubPreferences({
          outputLanguage: hubLangValue,
          ...(tokenPatch !== undefined ? { giteeAccessToken: tokenPatch } : {}),
        }),
      );
      if (res) {
        await syncHubStatePatch({
          outputLanguage: res.outputLanguage,
          ...(res.giteeTokenConfigured !== undefined
            ? { giteeTokenConfigured: res.giteeTokenConfigured }
            : {}),
          ...(res.giteeTokenMasked !== undefined ? { giteeTokenMasked: res.giteeTokenMasked } : {}),
        });
        await queryClient.invalidateQueries({ queryKey: ["gitee"] });
        setModal(null);
        showToastKey("routing.savedGlobal");
      }
    };

    const saveProject = async () => {
      const snapModal = useUiStore.getState().modal;
      const lm = snapModal?.kind === "routing" ? snapModal : m;
      const latestCfg = lm.draft ?? routing;
      const latestProjLang = lm.projLangDraft ?? project?.project?.outputLanguage ?? "inherit";
      const latestProjProvider: GitRemoteProvider = lm.projProviderDraft ?? (isGiteeProject ? "gitee" : "github");
      const latestGhRepo = lm.ghRepoDraft ?? project?.project?.github?.repo ?? githubStatus?.repo ?? "";
      const latestGhBase =
        lm.ghBaseBranchDraft ?? project?.project?.github?.defaultBaseBranch ?? githubStatus?.defaultBaseBranch ?? "main";
      const latestGhAutoCreate = lm.ghAutoCreateDraft ?? Boolean(project?.project?.github?.autoCreateIssue);
      const latestGhAutoSync = lm.ghAutoSyncDraft ?? (project?.project?.github?.autoSyncIssue ?? true);
      const latestGiteeRepo = lm.giteeRepoDraft ?? project?.project?.gitee?.repo ?? giteeStatus?.repo ?? "";
      const latestGiteeEnterprise =
        lm.giteeEnterpriseDraft ?? project?.project?.gitee?.enterprise ?? giteeStatus?.enterprise ?? "";
      const latestGiteeBase =
        lm.giteeBaseBranchDraft ?? project?.project?.gitee?.defaultBaseBranch ?? giteeStatus?.defaultBaseBranch ?? "master";
      const latestFastCmd = lm.fastCmdDraft ?? project?.project?.verification?.fastCommand ?? "";
      const latestFullCmd = lm.fullCmdDraft ?? project?.project?.verification?.fullCommand ?? "";

      const out = await runBusy(() =>
        api.updateProjectSettings({
          outputLanguage: latestProjLang,
          ...(latestCfg ? { routing: latestCfg } : {}),
          verification: {
            fastCommand: latestFastCmd.trim(),
            fullCommand: latestFullCmd.trim(),
            ...(lm.autoScreenshotsDraft !== undefined
              ? { autoScreenshots: lm.autoScreenshotsDraft }
              : existingAutoScreenshots !== undefined
                ? { autoScreenshots: existingAutoScreenshots }
                : {}),
          },
          ...(latestProjProvider === "gitee"
            ? {
                gitee: {
                  repo: latestGiteeRepo.trim(),
                  enterprise: latestGiteeEnterprise.trim(),
                  defaultBaseBranch: latestGiteeBase.trim() || "master",
                },
                github: null,
              }
            : {
                github: {
                  repo: latestGhRepo.trim(),
                  defaultBaseBranch: latestGhBase.trim() || "main",
                  autoCreateIssue: latestGhAutoCreate,
                  autoSyncIssue: latestGhAutoSync,
                },
                gitee: null,
              }),
        }),
      );
      if (out) {
        if (lm.draft) {
          useDraftStore.getState().clearRunnerOverrides();
        }
        const savedProject = out.project;
        const projKey = queryKeys.project(activeProjectId);
        await queryClient.cancelQueries({ queryKey: projKey });
        queryClient.setQueryData<ProjectInfoResponse>(projKey, (prev) =>
          prev
            ? {
                ...prev,
                project: savedProject,
                ...(savedProject.routing ? { routing: savedProject.routing } : {}),
              }
            : prev,
        );
        if (savedProject.routing) {
          await queryClient.cancelQueries({ queryKey: queryKeys.hubState });
          queryClient.setQueryData<HubStateResponse>(queryKeys.hubState, (prev) =>
            prev ? { ...prev, routing: savedProject.routing ?? prev.routing } : prev,
          );
        }
        setModal(null);
        showToastKey("routing.savedProject");
        void invalidateAllWorkbenchQueries();
      }
    };

    return (
      <ModalShell
        onClose={close}
        wide
        testId="routing-modal"
        hasExplicitTitle
        className="[&_[data-slot=dialog-header]]:px-5 [&_[data-slot=dialog-header]]:py-2 [&_[data-slot=dialog-panel]]:px-5 [&_[data-slot=dialog-panel]]:py-1.5 [&_[data-slot=dialog-footer]]:px-5 [&_[data-slot=dialog-footer]]:py-2 [&_.routing-row]:py-1 [&_.preset-card]:py-1.5"
      >
        <DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-2 pe-6">
            <DialogTitle className="flex items-center gap-2">
              <Icon icon={Settings} size={20} />
              <span>{t(language, "routing.title")}</span>
            </DialogTitle>
            <div className="flex items-center gap-2">
              <SegmentedControl
                size="sm"
                aria-label={t(language, "routing.scopeAria")}
                render={
                  <RadioGroupPrimitive
                    className="flex items-center"
                    value={tab}
                    onValueChange={(next) => {
                      if (next === "project" || next === "global") {
                        setModal((prev) => (prev?.kind === "routing" ? { ...prev, tab: next } : prev));
                      }
                    }}
                  />
                }
              >
                <SegmentedControlItem
                  render={<RadioPrimitive.Root value="project" data-testid="settings-tab-project" />}
                >
                  <Icon icon={Folder} size={14} /> {t(language, "routing.project")}
                </SegmentedControlItem>
                <SegmentedControlItem
                  render={<RadioPrimitive.Root value="global" data-testid="settings-tab-global" />}
                >
                  <Icon icon={Globe} size={14} /> {t(language, "routing.global")}
                </SegmentedControlItem>
              </SegmentedControl>
              {tab === "project" && (
                <Button
                  variant="outline"
                  size="xs"
                  type="button"
                  data-testid="refresh-harnesses-btn"
                  disabled={busy}
                  onClick={() => void refreshHarnesses()}
                >
                  <Icon icon={RefreshCw} size={14} /> {t(language, "routing.refreshHarnesses")}
                </Button>
              )}
            </div>
          </div>
        </DialogHeader>

        {tab === "global" ? (
          <div data-testid="settings-pane-global" className="contents">
            <DialogPanel className="space-y-3">
              <Alert variant="info">
                <Icon icon={Info} size={14} />
                <AlertDescription>{t(language, "routing.outputLanguageCallout")}</AlertDescription>
              </Alert>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:items-end">
                <div>
                  <Label className="mb-1 block text-xs text-muted-foreground font-normal">
                    {t(language, "routing.hubLangLabel")}
                  </Label>
                  <SimpleSelect
                    className="w-full"
                    data-testid="hub-output-language-select"
                    value={hubLangValue}
                    onValueChange={(next) =>
                      setModal((prev) =>
                        prev?.kind === "routing" ? { ...prev, hubLangDraft: next as OutputLanguage } : prev,
                      )
                    }
                    options={[
                      { value: "zh-CN", label: t(language, "routing.langZhDefault") },
                      { value: "en", label: t(language, "init.langEn") },
                      { value: "auto", label: t(language, "routing.langAuto") },
                    ]}
                  />
                </div>

                <div>
                  <div className="mb-1 flex items-center justify-between gap-1.5">
                    <Label
                      className="text-xs text-muted-foreground font-normal"
                      htmlFor="hub-gitee-token-input"
                      title={t(language, "gitee.tokenTooltip")}
                    >
                      {t(language, "gitee.tokenLabel")}
                    </Label>
                    <Badge
                      variant={
                        m.clearGiteeToken
                          ? "secondary"
                          : hub?.giteeTokenConfigured
                            ? "success"
                            : "warning"
                      }
                      size="sm"
                      data-testid="hub-gitee-token-status"
                    >
                      <Icon
                        icon={
                          m.clearGiteeToken
                            ? Trash2
                            : hub?.giteeTokenConfigured
                              ? Check
                              : AlertTriangle
                        }
                        size={14}
                      />{" "}
                      {m.clearGiteeToken
                        ? t(language, "gitee.tokenClearOnSave")
                        : hub?.giteeTokenConfigured
                          ? t(language, "gitee.tokenConfigured", { masked: hub.giteeTokenMasked ?? "••••" })
                          : t(language, "gitee.tokenUnconfigured")}
                    </Badge>
                  </div>
                  <div className="flex gap-1.5">
                    <Input
                      id="hub-gitee-token-input"
                      type="password"
                      className="flex-1"
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
                      <Button
                        variant="outline"
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
                        <Icon icon={X} size={14} /> {t(language, "gitee.tokenClear")}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </DialogPanel>

            <DialogFooter>
              <Button variant="ghost" type="button" onClick={close}>
                <Icon icon={X} size={14} /> {t(language, "common.cancel")}
              </Button>
              <Button
                variant="default"
                type="button"
                data-testid="save-routing-btn"
                disabled={busy}
                onClick={() => void saveGlobal()}
              >
                <Icon icon={Save} size={14} /> {t(language, "routing.saveGlobal")}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div data-testid="settings-pane-project" className="contents">
            {noHubProject || !project?.initialized ? (
              <>
                <DialogPanel>
                  <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
                    {t(language, "routing.projectEmpty")}
                  </div>
                </DialogPanel>
                <DialogFooter>
                  <Button variant="ghost" type="button" onClick={close}>
                    <Icon icon={X} size={14} /> {t(language, "common.close")}
                  </Button>
                </DialogFooter>
              </>
            ) : (
              <>
                <DialogPanel className="space-y-1.5 py-1.5">
                  <div className="space-y-1">
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
                          <div className="xs muted truncate mt-0.5" title={t(language, p.descKey)}>
                            {t(language, p.descKey)}
                          </div>
                        </button>
                      ))}
                    </div>

                    {cfg && (
                      <div className="routing-table mt-1.5">
                        {ROUTING_STAGES.map((stg) => {
                          const rule = cfg.stages[stg];
                          const selectedVal = `${rule.primary.harness}::${rule.primary.model}`;
                          const effortCap = getModelEffortCapability(harnesses, rule.primary.harness, rule.primary.model);
                          const efforts = effortCap.efforts;
                          const lockedEffort = effortCap.defaultEffort ?? efforts[0];
                          const lockedLabel = t(language, "routing.effortLockedLabel", {
                            effort: lockedEffort ? effortLabel(language, lockedEffort) : t(language, "routing.effortBuiltin"),
                          });

                          const changePrimaryModel = (key: string) => {
                            const parsed = parseRunnerKey(key);
                            if (!parsed || !cfg) return;
                            const { harness, model } = parsed;
                            const nextCap = getModelEffortCapability(harnesses, harness, model);
                            setModal((prev) => {
                              if (prev?.kind !== "routing") return prev;
                              const baseCfg = prev.draft ?? routing;
                              if (!baseCfg) return prev;
                              const prevRule = baseCfg.stages[stg];
                              const keepEffort =
                                nextCap.mode === "configurable" &&
                                prevRule.primary.reasoningEffort &&
                                nextCap.efforts.includes(prevRule.primary.reasoningEffort)
                                  ? prevRule.primary.reasoningEffort
                                  : undefined;
                              return {
                                ...prev,
                                draft: {
                                  ...baseCfg,
                                  stages: {
                                    ...baseCfg.stages,
                                    [stg]: {
                                      ...prevRule,
                                      primary: {
                                        harness: harness as HarnessId,
                                        model,
                                        ...(keepEffort ? { reasoningEffort: keepEffort } : {}),
                                      },
                                    },
                                  },
                                },
                              };
                            });
                          };

                          return (
                            <div key={stg} className="routing-row">
                              <div className="min-w-0">
                                <div className="text-[13px] font-semibold">{t(language, STAGE_LABEL_KEYS[stg])}</div>
                                <div className="xs muted truncate">
                                  {t(language, "routing.fallbacks", {
                                    list:
                                      rule.fallbacks.map((f) => `${f.harness}/${f.model}`).join(" → ") ||
                                      t(language, "common.none"),
                                  })}
                                </div>
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                <RoutingModelPicker
                                  testId={`route-select-${stg}`}
                                  harnesses={harnesses}
                                  value={selectedVal}
                                  onChange={changePrimaryModel}
                                  ariaLabel={t(language, "routing.primaryModelAria", { stage: t(language, STAGE_LABEL_KEYS[stg]) })}
                                />
                                {effortCap.mode === "configurable" ? (
                                  <SimpleSelect
                                    size="sm"
                                    className="w-[135px] font-mono"
                                    data-testid={`route-effort-${stg}`}
                                    title={t(language, "routing.effortTitle")}
                                    value={
                                      rule.primary.reasoningEffort && efforts.includes(rule.primary.reasoningEffort)
                                        ? rule.primary.reasoningEffort
                                        : ""
                                    }
                                    onValueChange={(next) => {
                                      const eff = next as ReasoningEffort | "";
                                      setModal((prev) => {
                                        if (prev?.kind !== "routing") return prev;
                                        const baseCfg = prev.draft ?? routing;
                                        if (!baseCfg) return prev;
                                        const prevRule = baseCfg.stages[stg];
                                        const nextPrimary = { ...prevRule.primary };
                                        if (eff) nextPrimary.reasoningEffort = eff;
                                        else delete nextPrimary.reasoningEffort;
                                        return {
                                          ...prev,
                                          draft: {
                                            ...baseCfg,
                                            stages: {
                                              ...baseCfg.stages,
                                              [stg]: { ...prevRule, primary: nextPrimary },
                                            },
                                          },
                                        };
                                      });
                                    }}
                                    options={[
                                      {
                                        value: "",
                                        label: `${t(language, "routing.defaultEffort")}${
                                          effortCap.defaultEffort ? ` (${effortLabel(language, effortCap.defaultEffort)})` : ""
                                        }`,
                                      },
                                      ...efforts.map((eff) => ({
                                        value: eff,
                                        label: effortLabel(language, eff),
                                      })),
                                    ]}
                                  />
                                ) : effortCap.mode === "locked" ? (
                                  <span
                                    className="inline-flex h-7 w-[135px] items-center justify-center overflow-hidden rounded-md border border-border px-2 py-0.5 font-mono text-xs text-muted-foreground"
                                    data-testid={`route-effort-${stg}-locked`}
                                    title={`${lockedLabel} · ${t(language, "routing.effortLockedTitle")}`}
                                  >
                                    <span className="min-w-0 truncate">{lockedLabel}</span>
                                  </span>
                                ) : (
                                  <span
                                    className="inline-flex h-7 w-[135px] items-center justify-center overflow-hidden rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground"
                                    data-testid={`route-effort-${stg}-unsupported`}
                                    title={`${t(language, "routing.effortUnsupportedLabel")} · ${t(language, "routing.effortUnsupportedTitle")}`}
                                  >
                                    <span className="min-w-0 truncate">
                                      {t(language, "routing.effortUnsupportedLabel")}
                                    </span>
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {cfg && (
                      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-3">
                        <Label className="flex items-center gap-2 text-[13px] font-normal">
                          <Checkbox
                            data-testid="routing-auto-review-checkbox"
                            checked={cfg.autoReview !== false}
                            onCheckedChange={(checked) => {
                              setModal((prev) => {
                                if (prev?.kind !== "routing") return prev;
                                const baseCfg = prev.draft ?? routing;
                                return baseCfg ? { ...prev, draft: { ...baseCfg, autoReview: Boolean(checked) } } : prev;
                              });
                            }}
                          />
                          <span>{t(language, "routing.autoReviewLabel")}</span>
                        </Label>
                        {cfg.autoReview !== false && (
                          <div className="flex items-center gap-2 text-xs">
                            <span className="muted">{t(language, "routing.maxAutoReviewRoundsLabel")}</span>
                            <SimpleSelect
                              size="sm"
                              data-testid="routing-max-auto-review-rounds"
                              value={String(cfg.maxAutoReviewRounds ?? 1)}
                              onValueChange={(next) => {
                                const val = Number(next);
                                setModal((prev) => {
                                  if (prev?.kind !== "routing") return prev;
                                  const baseCfg = prev.draft ?? routing;
                                  return baseCfg
                                    ? {
                                        ...prev,
                                        draft: {
                                          ...baseCfg,
                                          maxAutoReviewRounds: Number.isFinite(val) ? val : 1,
                                        },
                                      }
                                    : prev;
                                });
                              }}
                              options={[
                                { value: "1", label: "1" },
                                { value: "2", label: "2" },
                                { value: "3", label: "3" },
                                { value: "5", label: "5" },
                              ]}
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="border-t pt-2">
                    <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <strong className="text-[13px]">{t(language, "gitee.providerTitle")}</strong>
                        <SegmentedControl
                          size="sm"
                          aria-label={t(language, "gitee.providerTitle")}
                          render={
                            <RadioGroupPrimitive
                              className="flex items-center"
                              value={projProviderValue}
                              onValueChange={(next) => {
                                if (next === "github" || next === "gitee") {
                                  setModal((prev) =>
                                    prev?.kind === "routing" ? { ...prev, projProviderDraft: next } : prev,
                                  );
                                }
                              }}
                            />
                          }
                        >
                          <SegmentedControlItem
                            render={<RadioPrimitive.Root value="github" data-testid="project-provider-github" />}
                          >
                            GitHub
                          </SegmentedControlItem>
                          <SegmentedControlItem
                            render={<RadioPrimitive.Root value="gitee" data-testid="project-provider-gitee" />}
                          >
                            Gitee
                          </SegmentedControlItem>
                        </SegmentedControl>
                      </div>
                      {projProviderValue === "gitee"
                        ? giteeStatus && (
                            <Badge
                              variant={giteeStatus.ready ? "success" : "warning"}
                              size="sm"
                              data-testid="project-provider-status"
                            >
                              <Icon icon={giteeStatus.ready ? Check : AlertTriangle} size={14} />
                              {giteeStatus.ready
                                ? t(language, "gitee.statusReady", { account: giteeStatus.account ?? "authenticated" })
                                : formatGiteeStatusReason(language, giteeStatus)}
                            </Badge>
                          )
                        : githubStatus && (
                            <Badge
                              variant={githubStatus.ready ? "success" : "warning"}
                              size="sm"
                              data-testid="project-provider-status"
                            >
                              <Icon icon={githubStatus.ready ? Check : AlertTriangle} size={14} />
                              {githubStatus.ready
                                ? t(language, "gitee.statusGhReady", { account: githubStatus.account ?? "authenticated" })
                                : formatGitHubStatusReason(language, githubStatus)}
                            </Badge>
                          )}
                    </div>

                    {projProviderValue === "gitee" ? (
                      <>
                        <div className="mb-1.5 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_150px]">
                          <div>
                            <Label className="mb-1 block text-xs text-muted-foreground font-normal">
                              {t(language, "gitee.repoLabel")}
                            </Label>
                            <Input
                              size="sm"
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
                            <Label className="mb-1 block text-xs text-muted-foreground font-normal">
                              {t(language, "gitee.enterpriseLabel")}
                            </Label>
                            <Input
                              size="sm"
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
                            <Label className="mb-1 block text-xs text-muted-foreground font-normal">
                              {t(language, "gitee.baseBranchLabel")}
                            </Label>
                            <Input
                              size="sm"
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
                          <div className="xs mb-1 text-warning-foreground">
                            {t(language, "gitee.missingRemoteHint")}
                          </div>
                        )}
                        <div className="xs muted">
                          {t(language, "gitee.syncBehaviorHint")}
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="mb-1.5 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_180px]">
                          <div>
                            <Label className="mb-1 block text-xs text-muted-foreground font-normal">
                              {t(language, "gitee.ghRepoLabel")}
                            </Label>
                            <Input
                              size="sm"
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
                            <Label className="mb-1 block text-xs text-muted-foreground font-normal">
                              {t(language, "gitee.baseBranchLabel")}
                            </Label>
                            <Input
                              size="sm"
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
                        <div className="flex flex-wrap items-center gap-4">
                          <Label className="flex items-center gap-2 text-[13px] font-normal">
                            <Checkbox
                              data-testid="project-github-autocreate"
                              checked={ghAutoCreateValue}
                              onCheckedChange={(checked) =>
                                setModal((prev) =>
                                  prev?.kind === "routing" ? { ...prev, ghAutoCreateDraft: Boolean(checked) } : prev,
                                )
                              }
                            />
                            <span>{t(language, "routing.ghAutoCreate")}</span>
                          </Label>
                          <Label className="flex items-center gap-2 text-[13px] font-normal">
                            <Checkbox
                              data-testid="project-github-autosync"
                              checked={ghAutoSyncValue}
                              onCheckedChange={(checked) =>
                                setModal((prev) =>
                                  prev?.kind === "routing" ? { ...prev, ghAutoSyncDraft: Boolean(checked) } : prev,
                                )
                              }
                            />
                            <span>{t(language, "routing.ghAutoSync")}</span>
                          </Label>
                        </div>
                      </>
                    )}
                  </div>

                  <div className="border-t pt-2">
                    <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                      <strong className="text-[13px]">
                        {t(language, "routing.verificationTitle")}
                      </strong>
                      <div className="flex flex-wrap items-center gap-2.5">
                        <Label className="flex items-center gap-1.5 text-xs font-normal">
                          <Checkbox
                            data-testid="project-auto-screenshots"
                            checked={autoScreenshotsValue}
                            onCheckedChange={(checked) =>
                              setModal((prev) =>
                                prev?.kind === "routing" ? { ...prev, autoScreenshotsDraft: Boolean(checked) } : prev,
                              )
                            }
                          />
                          <span>{t(language, "routing.autoScreenshotsLabel")}</span>
                        </Label>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="muted xs">
                            {t(language, "routing.archDocsLabel")}
                          </span>
                          {project.context?.archDocs && project.context.archDocs.length > 0 ? (
                            <div className="flex flex-wrap gap-1.5">
                              {project.context.archDocs.map((doc) => (
                                <Badge
                                  key={doc.path}
                                  variant="info"
                                  size="sm"
                                  title={doc.headings.join(" / ")}
                                  data-testid={`proj-arch-doc-${doc.path}`}
                                >
                                  {doc.path}
                                </Badge>
                              ))}
                            </div>
                          ) : (
                            <span className="xs muted">{t(language, "routing.archDocsNone")}</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      <div>
                        <Label className="mb-1 block text-xs text-muted-foreground font-normal">
                          {t(language, "routing.projectLangLabel", { name: project.project?.name ?? "" })}
                        </Label>
                        <SimpleSelect
                          size="sm"
                          className="w-full"
                          data-testid="project-output-language-select"
                          value={projLangValue}
                          onValueChange={(next) =>
                            setModal((prev) =>
                              prev?.kind === "routing"
                                ? { ...prev, projLangDraft: next as OutputLanguage | "inherit" }
                                : prev,
                            )
                          }
                          options={[
                            { value: "inherit", label: t(language, "routing.inheritHub", { lang: savedHubLang }) },
                            { value: "zh-CN", label: t(language, "init.langZh") },
                            { value: "en", label: t(language, "init.langEn") },
                            { value: "auto", label: t(language, "routing.langAuto") },
                          ]}
                        />
                      </div>
                      <div>
                        <Label className="mb-1 block text-xs text-muted-foreground font-normal">
                          {t(language, "routing.fastCmdLabel")}
                        </Label>
                        <Input
                          size="sm"
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
                        <Label className="mb-1 block text-xs text-muted-foreground font-normal">
                          {t(language, "routing.fullCmdLabel")}
                        </Label>
                        <Input
                          size="sm"
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
                  </div>
                </DialogPanel>

                <DialogFooter>
                  <Button variant="ghost" type="button" onClick={close}>
                    <Icon icon={X} size={14} /> {t(language, "common.cancel")}
                  </Button>
                  <Button
                    variant="default"
                    type="button"
                    data-testid="save-project-btn"
                    disabled={busy}
                    onClick={() => void saveProject()}
                  >
                    <Icon icon={Save} size={14} /> {t(language, "routing.saveProject")}
                  </Button>
                </DialogFooter>
              </>
            )}
          </div>
        )}
      </ModalShell>
    );
  }

  if (m.kind === "annotate_anchor") {
    return (
      <ModalShell onClose={close} testId="annotate-modal" hasExplicitTitle>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon icon={MessageSquare} size={20} />
            <span>{t(language, "annotate.title")}</span>
          </DialogTitle>
          <DialogDescription>{t(language, "annotate.anchor", { anchor: m.anchor })}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {runLocked && <RunLockNotice />}
          <Textarea
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
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" type="button" onClick={close}>
            <Icon icon={X} size={14} /> {t(language, "common.cancel")}
          </Button>
          <Button
            variant="outline"
            type="button"
            data-testid="annotate-ask-btn"
            disabled={runLocked}
            onClick={() => detail && void submitAnnotation(detail.state.id, m.anchor, m.message, "ask")}
          >
            <Icon icon={Lightbulb} size={14} /> {t(language, "annotate.ask")}
          </Button>
          <Button
            variant="default"
            type="button"
            data-testid="annotate-queue-btn"
            onClick={() => detail && void submitAnnotation(detail.state.id, m.anchor, m.message, "refine")}
          >
            <Icon icon={Pencil} size={14} /> {t(language, "annotate.queue")}
          </Button>
        </DialogFooter>
      </ModalShell>
    );
  }

  if (m.kind === "handoff_preview") {
    return (
      <ModalShell onClose={close} wide testId="handoff-modal" hasExplicitTitle>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon icon={FileText} size={20} />
            <span>{t(language, "handoff.title")}</span>
          </DialogTitle>
          <DialogDescription>{t(language, "handoff.desc")}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="handoff-preview-box">
            <MarkdownView markdown={m.markdown} />
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="default" type="button" onClick={close}>
            <Icon icon={X} size={14} /> {t(language, "common.close")}
          </Button>
        </DialogFooter>
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
      <ModalShell onClose={close} testId="feedback-modal" hasExplicitTitle>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon icon={Pencil} size={20} />
            <span>{isDesignStage ? t(language, "feedback.titleDesign") : t(language, "feedback.titleFix")}</span>
          </DialogTitle>
          <DialogDescription>
            {isDesignStage ? t(language, "feedback.descDesign") : t(language, "feedback.descFix")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {runLocked && <RunLockNotice />}
          {!isDesignStage && reviewReport && (
            <div>
              <Button
                variant="outline"
                size="xs"
                type="button"
                data-testid="feedback-fill-review-btn"
                onClick={() => {
                  const snippet = formatReviewFixFeedback(reviewReport);
                  setModal((prev) => (prev?.kind === "feedback" ? { ...prev, feedback: snippet } : prev));
                }}
              >
                <Icon icon={ClipboardCheck} size={14} /> {t(language, "feedback.fillReview")}
              </Button>
            </div>
          )}
          <Textarea
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
          <Label className="flex items-center gap-2 text-[13px] font-normal">
            <Checkbox
              id="feedback-dispatch"
              checked={m.dispatchAgent}
              onCheckedChange={(checked) =>
                setModal((prev) =>
                  prev?.kind === "feedback" ? { ...prev, dispatchAgent: Boolean(checked) } : prev,
                )
              }
            />
            <span>
              {isDesignStage ? t(language, "feedback.dispatchDesign") : t(language, "feedback.dispatchFix")}
            </span>
          </Label>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" type="button" onClick={close}>
            <Icon icon={X} size={14} /> {t(language, "common.cancel")}
          </Button>
          <Button
            variant="default"
            type="button"
            data-testid="feedback-submit-btn"
            disabled={busy || runLocked}
            onClick={() => detail && void submitFeedback(detail, m.feedback, m.dispatchAgent)}
          >
            <Icon icon={Send} size={14} />{" "}
            {isDesignStage ? t(language, "feedback.submitDesign") : t(language, "feedback.submitFix")}
          </Button>
        </DialogFooter>
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
      <ModalShell onClose={close} testId="accept-override-modal" hasExplicitTitle>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon icon={AlertTriangle} size={20} />
            <span>{title}</span>
          </DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {runLocked && <RunLockNotice />}
          <Alert variant={isBlock ? "error" : "warning"}>
            <Icon icon={AlertTriangle} size={14} />
            <AlertDescription className="space-y-1.5">
              <div>
                <strong>{t(language, "acceptOverride.summary")}</strong>
                {m.summary}
              </div>
              {m.acceptedRisks.length > 0 && (
                <ul className="m-0 list-disc pl-4">
                  {m.acceptedRisks.slice(0, 8).map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
            </AlertDescription>
          </Alert>
          <div>
            <Label className="mb-1 block text-xs text-muted-foreground font-normal">
              {isBlock ? t(language, "acceptOverride.reasonBlockLabel") : t(language, "acceptOverride.reasonConcernLabel")}
            </Label>
            <Textarea
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
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" type="button" onClick={close}>
            <Icon icon={ArrowLeft} size={14} /> {t(language, "acceptOverride.back")}
          </Button>
          <Button
            variant="default"
            type="button"
            data-testid="confirm-accept-override-btn"
            disabled={busy || runLocked || (isBlock && !m.reason.trim())}
            onClick={() => detail && void submitAcceptOverride(detail, m.verdict, m.reason, m.acceptedRisks)}
          >
            <Icon icon={Check} size={14} /> {t(language, "acceptOverride.confirm")}
          </Button>
        </DialogFooter>
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
      <ModalShell onClose={close} hasExplicitTitle>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon
              icon={m.action === "block" ? Ban : m.action === "cancel" ? XCircle : RotateCcw}
              size={20}
            />
            <span>{title}</span>
          </DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {runLocked && <RunLockNotice />}
          {canPreserveApproval && (
            <RadioGroup
              className="gap-2"
              value={keepApproval ? "keep" : "reset"}
              onValueChange={(next) =>
                setModal((prev) =>
                  prev?.kind === "lifecycle" ? { ...prev, preserveApproval: next === "keep" } : prev,
                )
              }
            >
              <Label
                className="flex w-full cursor-pointer items-start gap-2.5 rounded-lg border p-3 has-data-checked:border-primary/48 has-data-checked:bg-accent/50"
                data-testid="reopen-keep-approval-option"
              >
                <Radio className="mt-0.5" value="keep" />
                <div>
                  <div className="text-[13px] font-semibold">{t(language, "lifecycle.reopenKeepApprovalTitle")}</div>
                  <div className="muted xs mt-0.5 font-normal">
                    {t(language, "lifecycle.reopenKeepApprovalDesc")}
                  </div>
                </div>
              </Label>
              <Label
                className="flex w-full cursor-pointer items-start gap-2.5 rounded-lg border p-3 has-data-checked:border-primary/48 has-data-checked:bg-accent/50"
                data-testid="reopen-reset-draft-option"
              >
                <Radio className="mt-0.5" value="reset" />
                <div>
                  <div className="text-[13px] font-semibold">{t(language, "lifecycle.reopenResetDraftTitle")}</div>
                  <div className="muted xs mt-0.5 font-normal">
                    {t(language, "lifecycle.reopenResetDraftDesc")}
                  </div>
                </div>
              </Label>
            </RadioGroup>
          )}
          <Textarea
            id="lifecycle-reason"
            autoFocus
            value={m.reason}
            placeholder={t(language, "lifecycle.reasonPlaceholder")}
            onChange={(e) =>
              setModal((prev) => (prev?.kind === "lifecycle" ? { ...prev, reason: e.target.value } : prev))
            }
          />
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" type="button" onClick={close}>
            <Icon icon={X} size={14} /> {t(language, "common.cancel")}
          </Button>
          <Button
            variant="default"
            type="button"
            data-testid="lifecycle-confirm-btn"
            disabled={busy || runLocked}
            onClick={() => detail && void submitLifecycle(detail, m.action, m.reason, { preserveApproval: keepApproval })}
          >
            <Icon icon={Check} size={14} /> {t(language, "common.confirm")}
          </Button>
        </DialogFooter>
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
      <ModalShell onClose={close} testId="prompt-fallback-modal" hasExplicitTitle>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon icon={Terminal} size={20} />
            <span>{t(language, m.titleKey, m.titleParams)}</span>
          </DialogTitle>
          <DialogDescription>{t(language, m.subtitleKey, m.subtitleParams)}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Textarea
            ref={fallbackAreaRef}
            id="fallback-prompt-text"
            readOnly
            className="min-h-44 font-mono text-xs"
            value={m.prompt}
          />
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" type="button" data-action="close-modal" onClick={close}>
            <Icon icon={X} size={14} /> {t(language, "common.close")}
          </Button>
          <Button variant="default" type="button" onClick={() => void copyPrompt()}>
            <Icon icon={Copy} size={14} /> {t(language, "fallback.copy")}
          </Button>
        </DialogFooter>
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
      <ModalShell onClose={close} testId="quick-report-modal" hasExplicitTitle>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon icon={Zap} size={20} />
            <span>{t(language, "report.title")}</span>
          </DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <SimpleSelect
              aria-label={t(language, "report.categoryAria")}
              data-testid="quick-report-category"
              value={m.category}
              onValueChange={(next) =>
                setModal((prev) =>
                  prev?.kind === "quick_report"
                    ? { ...prev, category: next as PainPointCategory }
                    : prev,
                )
              }
              options={[
                { value: "ui_anomaly", label: t(language, "report.cat.ui_anomaly") },
                { value: "cli_ergonomics", label: t(language, "report.cat.cli_ergonomics") },
                { value: "harness_bug", label: t(language, "report.cat.harness_bug") },
                { value: "feature_gap", label: t(language, "report.cat.feature_gap") },
              ]}
            />
            <Input
              aria-label={t(language, "report.selectorAria")}
              className="min-w-40 flex-1"
              data-testid="quick-report-selector"
              value={m.domSelector}
              placeholder={t(language, "report.selectorPlaceholder")}
              onChange={(e) =>
                setModal((prev) => (prev?.kind === "quick_report" ? { ...prev, domSelector: e.target.value } : prev))
              }
            />
            <Button
              variant="outline"
              type="button"
              data-testid="pick-element-btn"
              title={t(language, "report.pickTitle")}
              onClick={() =>
                setModal((prev) => (prev?.kind === "quick_report" ? { ...prev, pickingElement: true } : prev))
              }
            >
              <Icon icon={Crosshair} size={14} /> {t(language, "report.pick")}
            </Button>
          </div>
          <Input
            aria-label={t(language, "report.titleAria")}
            data-testid="quick-report-title"
            autoFocus
            value={m.title}
            placeholder={t(language, "report.titlePlaceholder")}
            onChange={(e) =>
              setModal((prev) => (prev?.kind === "quick_report" ? { ...prev, title: e.target.value } : prev))
            }
          />
          <Textarea
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
          <Label className="flex items-center gap-2 text-[13px] font-normal">
            <Checkbox
              data-testid="quick-report-autopromote"
              checked={m.autoPromote}
              onCheckedChange={(checked) =>
                setModal((prev) =>
                  prev?.kind === "quick_report" ? { ...prev, autoPromote: Boolean(checked) } : prev,
                )
              }
            />
            <span>{t(language, "report.autoPromote")}</span>
          </Label>
          {m.autoPromote && (
            <Label className="ms-5 flex items-center gap-2 text-xs font-normal">
              <Checkbox
                data-testid="quick-report-create-issue"
                checked={m.createGitHubIssue ?? false}
                onCheckedChange={(checked) =>
                  setModal((prev) =>
                    prev?.kind === "quick_report" ? { ...prev, createGitHubIssue: Boolean(checked) } : prev,
                  )
                }
              />
              <span>{t(language, "report.createIssue")}</span>
            </Label>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" type="button" onClick={close}>
            <Icon icon={X} size={14} /> {t(language, "common.cancel")}
          </Button>
          <Button
            variant="default"
            type="button"
            data-testid="submit-quick-report-btn"
            disabled={busy}
            onClick={() => void submitQuickReport()}
          >
            <Icon icon={Send} size={14} /> {t(language, "report.submit")}
          </Button>
        </DialogFooter>
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
      <ModalShell onClose={close} wide testId="evolution-modal" hasExplicitTitle>
        <DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-2 pe-6">
            <DialogTitle className="flex items-center gap-2">
              <Icon icon={Sparkles} size={20} />
              <span>{t(language, "evo.title")}</span>
            </DialogTitle>
            <SegmentedControl
              size="sm"
              aria-label={t(language, "evo.tabsAria")}
              render={
                <RadioGroupPrimitive
                  className="flex items-center"
                  value={m.tab}
                  onValueChange={(next) => {
                    if (next === "inbox" || next === "telemetry") {
                      setModal({ ...m, tab: next });
                    } else if (next === "playbook") {
                      setModal({ ...m, tab: "playbook", playbookDraft: null });
                    }
                  }}
                />
              }
            >
              <SegmentedControlItem
                render={<RadioPrimitive.Root value="inbox" data-testid="evo-tab-inbox" />}
              >
                <Icon icon={Inbox} size={14} />{" "}
                {t(language, "evo.tab.inbox", { count: painPoints.filter((p) => p.status === "open").length })}
              </SegmentedControlItem>
              <SegmentedControlItem
                render={<RadioPrimitive.Root value="playbook" data-testid="evo-tab-playbook" />}
              >
                <Icon icon={BookOpen} size={14} />{" "}
                {t(language, "evo.tab.playbook", {
                  count: playbookData?.rules.length ?? evolutionData?.playbook.rules.length ?? 0,
                })}
              </SegmentedControlItem>
              <SegmentedControlItem
                render={<RadioPrimitive.Root value="telemetry" data-testid="evo-tab-telemetry" />}
              >
                <Icon icon={Activity} size={14} /> {t(language, "evo.tab.telemetry", { count: telemetry.entries.length })}
              </SegmentedControlItem>
            </SegmentedControl>
          </div>
        </DialogHeader>

        <DialogPanel>
          {m.tab === "inbox" && (
            <div role="tabpanel" data-testid="evo-pane-inbox" className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="xs muted">
                  {t(language, "evo.inboxHintPrefix")}
                  <code>wb issue</code>
                  {t(language, "evo.inboxHintSuffix")}
                </span>
                <Button
                  variant="outline"
                  size="xs"
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
                </Button>
              </div>
              {painPoints.length === 0 ? (
                <div className="rounded-xl border border-dashed p-6 text-center text-xs text-muted-foreground">
                  {t(language, "evo.inboxEmpty")}
                </div>
              ) : (
                <div className="flex max-h-[52vh] flex-col gap-2 overflow-y-auto">
                  {painPoints.map((p) => {
                    const sandboxItem = p.promotedReqId ? sandboxes.find((s) => s.requirementId === p.promotedReqId) : undefined;
                    return (
                      <div
                        key={p.id}
                        className="rounded-xl border bg-card p-3 text-card-foreground shadow-xs/5"
                        data-testid={`pain-item-${p.id}`}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="mb-1 flex flex-wrap items-center gap-1.5">
                              <Badge
                                variant={p.status === "open" ? "warning" : p.status === "promoted" ? "info" : "secondary"}
                                size="sm"
                              >
                                <Icon
                                  icon={p.status === "open" ? CircleAlert : p.status === "promoted" ? Sparkles : CircleOff}
                                  size={14}
                                />{" "}
                                {p.status === "open"
                                  ? t(language, "evo.status.open")
                                  : p.status === "promoted"
                                    ? t(language, "evo.status.promoted", { id: p.promotedReqId ?? "" })
                                    : t(language, "evo.status.dismissed")}
                              </Badge>
                              <Badge variant="outline" size="sm">
                                {translateRef(language, `report.cat.${p.category}`, p.category)}
                              </Badge>
                              {p.occurrences > 1 && (
                                <Badge variant="info" size="sm">
                                  {t(language, "evo.occurrences", { count: p.occurrences })}
                                </Badge>
                              )}
                              {sandboxItem?.stage && sandboxItem.stage !== "done" && (
                                <Badge variant="outline" size="sm">
                                  {t(language, "evo.sandbox", { stage: sandboxItem.stage })}
                                </Badge>
                              )}
                              {sandboxItem?.drift && sandboxItem.drift.behindCount > 0 && (
                                <Badge variant={sandboxItem.drift.conflictFiles.length > 0 ? "error" : "warning"} size="sm">
                                  {t(language, "evo.driftBadge", {
                                    count: sandboxItem.drift.behindCount,
                                    conflict:
                                      sandboxItem.drift.conflictFiles.length > 0
                                        ? t(language, "evo.driftConflictPart", { count: sandboxItem.drift.conflictFiles.length })
                                        : "",
                                  })}
                                </Badge>
                              )}
                              {sandboxItem?.github?.issue && (
                                <Badge variant="info" size="sm">
                                  <Icon icon={Link2} size={14} /> Issue #{sandboxItem.github.issue.number}
                                </Badge>
                              )}
                              {sandboxItem?.github?.pr && (
                                <Badge variant={sandboxItem.github.pr.state === "merged" ? "success" : "info"} size="sm">
                                  <Icon icon={GitPullRequest} size={14} /> PR #{sandboxItem.github.pr.number} ·{" "}
                                  {formatPrStateLabel(language, sandboxItem.github.pr.state)}
                                </Badge>
                              )}
                              <span className="xs muted">{formatDateTime(p.updatedAt, language)}</span>
                            </div>
                            <div className="font-semibold">{p.title}</div>
                            {p.detail && p.detail !== p.title && (
                              <div className="xs muted mt-1 whitespace-pre-wrap">
                                {p.detail.slice(0, 260)}
                              </div>
                            )}
                            {p.attachments && p.attachments.length > 0 && (
                              <div className="mt-1.5">
                                <AttachmentGallery
                                  attachments={p.attachments}
                                  urlFor={(attId) => evolutionAttachmentUrl(p.id, attId)}
                                />
                              </div>
                            )}
                          </div>
                          <div className="flex shrink-0 flex-wrap gap-1.5">
                            {p.status === "open" && (
                              <>
                                <Button
                                  variant="default"
                                  size="xs"
                                  type="button"
                                  data-testid={`promote-pain-${p.id}`}
                                  disabled={busy}
                                  onClick={() => void handlePromote(p.id)}
                                >
                                  <Icon icon={Flame} size={14} /> {t(language, "evo.promote")}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  type="button"
                                  data-testid={`dismiss-pain-${p.id}`}
                                  disabled={busy}
                                  onClick={() => void handleDismiss(p.id)}
                                >
                                  <Icon icon={Trash2} size={14} /> {t(language, "evo.dismiss")}
                                </Button>
                              </>
                            )}
                            {p.status === "promoted" && p.promotedReqId && (
                              <Button
                                variant="outline"
                                size="xs"
                                type="button"
                                data-testid={`open-promoted-${p.id}`}
                                disabled={busy}
                                onClick={() => void openWorkbenchReq(p.promotedReqId!)}
                              >
                                <Icon icon={ExternalLink} size={14} /> {t(language, "evo.viewReq")}
                              </Button>
                            )}
                            {sandboxItem?.drift?.canAutoSync && p.promotedReqId && (
                              <Button
                                variant="outline"
                                size="xs"
                                type="button"
                                disabled={busy}
                                onClick={() => void syncSandboxBaseAction(p.promotedReqId!, { useEvolutionHub: true })}
                              >
                                <Icon icon={RefreshCw} size={14} /> {t(language, "evo.syncBase")}
                              </Button>
                            )}
                            {sandboxItem?.canApply && p.promotedReqId && sandboxItem.github?.pr && (
                              <Button
                                variant="default"
                                size="xs"
                                type="button"
                                data-testid={`sync-pain-pr-${p.id}`}
                                disabled={busy}
                                onClick={() => void handleSyncSandboxPr(p.promotedReqId!)}
                              >
                                <Icon icon={RefreshCw} size={14} /> {t(language, "evo.syncPr")}
                              </Button>
                            )}
                            {sandboxItem?.canApply && p.promotedReqId && (
                              <Button
                                variant={sandboxItem.github?.pr ? "outline" : "default"}
                                size="xs"
                                type="button"
                                data-testid={`apply-pain-sandbox-${p.id}`}
                                disabled={busy}
                                onClick={() => void handleApplySandbox(p.promotedReqId!)}
                              >
                                <Icon icon={Check} size={14} /> {t(language, "evo.applySandbox")}
                              </Button>
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
            <div role="tabpanel" data-testid="evo-pane-playbook" className="space-y-2.5">
              {noHubProject ? (
                <div className="rounded-xl border border-dashed p-6 text-center text-xs text-muted-foreground">
                  {t(language, "evo.playbookNoProject")}
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="xs muted">
                      {t(language, "evo.playbookHintPrefix")}
                      <code>.workbench/playbook.md</code>
                      {t(language, "evo.playbookHintSuffix")}
                    </span>
                    <Button
                      variant="outline"
                      size="xs"
                      type="button"
                      data-testid="distill-playbook-btn"
                      disabled={busy}
                      onClick={() => void handleDistillPlaybook()}
                    >
                      <Icon icon={RefreshCw} size={14} /> {t(language, "evo.distill")}
                    </Button>
                  </div>
                  <Textarea
                    aria-label={t(language, "evo.playbookAria")}
                    data-testid="playbook-editor"
                    className="min-h-60 font-mono text-xs"
                    value={currentPlaybook}
                    placeholder={t(language, "evo.playbookPlaceholder")}
                    onChange={(e) =>
                      setModal((prev) => (prev?.kind === "evolution" ? { ...prev, playbookDraft: e.target.value } : prev))
                    }
                  />
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="default"
                      size="xs"
                      type="button"
                      data-testid="save-playbook-btn"
                      disabled={busy}
                      onClick={() => void handleSavePlaybook()}
                    >
                      <Icon icon={Save} size={14} /> {t(language, "evo.savePlaybook")}
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}

          {m.tab === "telemetry" && (
            <div role="tabpanel" data-testid="evo-pane-telemetry" className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="xs muted">
                  {t(language, "evo.telemetryHint")}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    variant="outline"
                    size="xs"
                    type="button"
                    data-testid="evo-open-insights-btn"
                    onClick={() => {
                      close();
                      setMainView("insights");
                    }}
                  >
                    <Icon icon={BarChart3} size={14} /> {t(language, "evo.openInsights")}
                  </Button>
                  <Button
                    variant="outline"
                    size="xs"
                    type="button"
                    data-testid="evo-open-pricing-btn"
                    onClick={() => setModal({ kind: "observability_pricing" })}
                  >
                    <Icon icon={Settings} size={14} /> {t(language, "evo.openPricingConfig")}
                  </Button>
                  {telemetry.activeCooldowns.length > 0 && (
                    <Button
                      variant="outline"
                      size="xs"
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
                      <Icon icon={RotateCcw} size={14} /> {t(language, "evo.clearCooldown", { count: telemetry.activeCooldowns.length })}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="xs"
                    type="button"
                    data-testid="reload-web-btn"
                    disabled={busy}
                    onClick={async () => {
                      const out = await runBusy(() => api.reloadWebBundle());
                      if (out?.reloaded) showToastKey("evo.reloadedWeb");
                    }}
                  >
                    <Icon icon={RefreshCw} size={14} /> {t(language, "evo.reloadWeb")}
                  </Button>
                </div>
              </div>
              {telemetry.entries.length === 0 ? (
                <div className="rounded-xl border border-dashed p-6 text-center text-xs text-muted-foreground">
                  {t(language, "evo.telemetryEmpty")}
                </div>
              ) : (
                <div className="flex max-h-[48vh] flex-col gap-1.5 overflow-y-auto">
                  {telemetry.entries.map((e) => {
                    const rate = e.totalRuns > 0 ? Math.round((e.succeededRuns / e.totalRuns) * 100) : 0;
                    const cooling = telemetry.activeCooldowns.some((c) => c.harness === e.harness && c.model === e.model);
                    return (
                      <div
                        key={`${e.harness}::${e.model}::${e.action}`}
                        className="routing-row"
                      >
                        <div>
                          <div className="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold">
                            <span>{e.harness} · {e.model}</span>
                            <Badge variant="outline" size="sm" data-testid="telemetry-action-badge">
                              {formatAgentActionLabel(language, e.action)}
                            </Badge>
                            {cooling && <Badge variant="warning" size="sm">{t(language, "evo.cooling")}</Badge>}
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
                        <Badge variant={rate >= 70 ? "success" : rate >= 40 ? "warning" : "error"} size="sm">
                          {t(language, "evo.successRate", { rate })}
                        </Badge>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </DialogPanel>

        <DialogFooter>
          <Button variant="ghost" type="button" data-action="close-modal" onClick={close}>
            <Icon icon={X} size={14} /> {t(language, "common.close")}
          </Button>
        </DialogFooter>
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
      if (guardRequirementRunLock(m.requirementId)) return;
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
      <ModalShell onClose={close} testId="link-issue-modal" hasExplicitTitle>
        <DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-2 pe-6">
            <DialogTitle className="flex items-center gap-2">
              <Icon icon={Link2} size={20} />
              <span>{t(language, isGiteeLink ? "gitee.linkTitle" : "linkIssue.title")}</span>
            </DialogTitle>
            {!isGiteeLink && (
              <SegmentedControl
                size="sm"
                render={
                  <RadioGroupPrimitive
                    className="flex items-center"
                    value={m.mode}
                    onValueChange={(next) => {
                      if (next === "create" || next === "link") {
                        setModal((prev) => (prev?.kind === "link_issue" ? { ...prev, mode: next } : prev));
                      }
                    }}
                  />
                }
              >
                <SegmentedControlItem render={<RadioPrimitive.Root value="create" />}>
                  <Icon icon={Plus} size={14} /> {t(language, "linkIssue.modeCreate")}
                </SegmentedControlItem>
                <SegmentedControlItem render={<RadioPrimitive.Root value="link" />}>
                  <Icon icon={Link2} size={14} /> {t(language, "linkIssue.modeLink")}
                </SegmentedControlItem>
              </SegmentedControl>
            )}
          </div>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {!isGiteeLink && m.mode === "create" ? (
            <Alert variant="info">
              <Icon icon={Info} size={14} />
              <AlertDescription>
                {t(language, "linkIssue.createDescPrefix")}
                <strong>{m.requirementId}</strong>
                {t(language, "linkIssue.createDescMiddle")}
                {githubStatus?.repo ? ` (${githubStatus.repo}) ` : " "}
                {t(language, "linkIssue.createDescSuffix")}
              </AlertDescription>
            </Alert>
          ) : (
            <div>
              <Label className="mb-1 block text-xs text-muted-foreground font-normal">
                {t(language, isGiteeLink ? "gitee.linkRefLabel" : "linkIssue.refLabel")}
              </Label>
              <Input
                data-testid="link-issue-ref-input"
                autoFocus
                value={m.issueRef}
                placeholder={t(language, isGiteeLink ? "gitee.linkRefPlaceholder" : "linkIssue.refPlaceholder")}
                onChange={(e) =>
                  setModal((prev) => (prev?.kind === "link_issue" ? { ...prev, issueRef: e.target.value } : prev))
                }
              />
            </div>
          )}
          {(isGiteeLink ? giteeStatus && !giteeStatus.authenticated : githubStatus && !githubStatus.ready) && (
            <Alert variant="warning">
              <Icon icon={AlertTriangle} size={14} />
              <AlertDescription>{remoteReason}</AlertDescription>
            </Alert>
          )}
          {runLocked && <RunLockNotice />}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" type="button" onClick={close}>
            <Icon icon={X} size={14} /> {t(language, "common.cancel")}
          </Button>
          <Button
            variant="default"
            type="button"
            data-testid="submit-link-issue-btn"
            disabled={busy || runLocked || remoteReady === false}
            onClick={() => void submitLinkIssue()}
          >
            <Icon icon={Link2} size={14} />{" "}
            {isGiteeLink
              ? t(language, "gitee.linkSubmit")
              : m.mode === "create"
                ? t(language, "linkIssue.submitCreate")
                : t(language, "linkIssue.submitLink")}
          </Button>
        </DialogFooter>
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
      if (guardRequirementRunLock(detail.state.id)) return;
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
      <ModalShell onClose={close} testId="deliver-modal" hasExplicitTitle>
        <DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-2 pe-6">
            <DialogTitle className="flex items-center gap-2">
              <Icon icon={createPr ? GitPullRequest : GitCommit} size={20} />
              <span>
                {createPr
                  ? t(language, "deliver.titlePrPlatform", { platform: prPlatformLabel })
                  : t(language, "deliver.titleLocal")}
              </span>
            </DialogTitle>
            {!sandboxActive && (
              <SegmentedControl
                size="sm"
                aria-label={t(language, "deliver.modeAria")}
                render={
                  <RadioGroupPrimitive
                    className="flex items-center"
                    value={createPr ? "pr" : "local"}
                    onValueChange={(next) => {
                      if (next === "local") {
                        setModal((prev) => (prev?.kind === "deliver" ? { ...prev, createPr: false } : prev));
                      } else if (next === "pr" && prAvailable) {
                        setModal((prev) => (prev?.kind === "deliver" ? { ...prev, createPr: true } : prev));
                      }
                    }}
                  />
                }
              >
                <SegmentedControlItem
                  render={<RadioPrimitive.Root value="local" data-testid="deliver-mode-local" />}
                >
                  <Icon icon={GitCommit} size={14} /> {t(language, "deliver.modeLocal")}
                </SegmentedControlItem>
                <SegmentedControlItem
                  render={<RadioPrimitive.Root value="pr" data-testid="deliver-mode-pr" disabled={!prAvailable} />}
                >
                  <Icon icon={GitPullRequest} size={14} /> {t(language, "deliver.modePr")}
                </SegmentedControlItem>
              </SegmentedControl>
            )}
          </div>
          <DialogDescription>
            {t(language, "deliver.targetPrefix")}
            <strong>{detail.state.id}</strong>
            {t(language, "deliver.targetMiddle")}
            <code>{deliveryPreview?.branch ?? "HEAD"}</code>
            {deliveryPreview?.githubRepo ? t(language, "deliver.repo", { repo: deliveryPreview.githubRepo }) : ""}
            {!createPr && t(language, "deliver.localNote")}
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="space-y-3">
          {sandboxActive &&
            deliveryPreview?.sandboxDrift &&
            (deliveryPreview.sandboxDrift.behindCount > 0 || deliveryPreview.sandboxDrift.conflictFiles.length > 0) && (
              <Alert
                variant={deliveryPreview.sandboxDrift.conflictFiles.length > 0 ? "error" : "warning"}
                data-testid="deliver-drift-callout"
              >
                <Icon icon={AlertTriangle} size={14} />
                <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
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
                    <Button
                      variant="default"
                      size="xs"
                      type="button"
                      data-testid="deliver-sync-base-btn"
                      disabled={busy}
                      onClick={() => void syncSandboxBaseAction(detail.state.id)}
                    >
                      <Icon icon={RefreshCw} size={14} /> {t(language, "deliver.driftSyncBtn")}
                    </Button>
                  ) : (
                    <Button
                      variant="default"
                      size="xs"
                      type="button"
                      data-testid="deliver-resolve-conflict-btn"
                      disabled={busy}
                      onClick={async () => {
                        close();
                        await dispatchSyncBaseWithAgent(detail, deliveryPreview.sandboxDrift!, bridgeConnected);
                      }}
                    >
                      <Icon icon={Wrench} size={14} /> {t(language, "deliver.driftResolveBtn")}
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            )}

          {(candidates.length > 0 || !canSubmitExistingCommits) && (
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="text-[13px]">
                  {t(language, "deliver.selectFiles", {
                    selected: m.selectedFiles.length,
                    total: candidates.length,
                  })}
                </strong>
                <div className="flex gap-1.5">
                  {candidates.some((c) => c.inAcceptedSnapshot) && (
                    <Button variant="outline" size="xs" type="button" onClick={() => selectPreset("accepted")}>
                      <Icon icon={Check} size={14} /> {t(language, "deliver.selectAccepted")}
                    </Button>
                  )}
                  <Button variant="outline" size="xs" type="button" onClick={() => selectPreset("all")}>
                    <Icon icon={ListChecks} size={14} /> {t(language, "deliver.selectAll")}
                  </Button>
                  <Button variant="outline" size="xs" type="button" onClick={() => selectPreset("none")}>
                    <Icon icon={X} size={14} /> {t(language, "deliver.clear")}
                  </Button>
                </div>
              </div>
              <div className="flex max-h-48 flex-col gap-1.5 overflow-y-auto rounded-lg border p-2">
                {candidates.length === 0 ? (
                  <div className="muted xs">{t(language, "deliver.noChanges")}</div>
                ) : (
                  candidates.map((c) => (
                    <Label
                      key={c.path}
                      className="flex cursor-pointer items-center gap-2 text-xs font-normal"
                    >
                      <Checkbox
                        data-testid={`deliver-file-${c.path}`}
                        checked={selectedSet.has(c.path)}
                        onCheckedChange={() => toggleFile(c.path)}
                      />
                      <code className="flex-1 truncate">
                        {c.path}
                      </code>
                      <Badge variant="secondary" size="sm" title={c.status} data-testid={`deliver-status-${c.path}`}>
                        {formatGitFileStatusLabel(language, c.status)}
                      </Badge>
                      {deliveryPreview && deliveryPreview.acceptedSnapshotFileCount > 0 && (
                        <Badge variant={c.inAcceptedSnapshot ? "success" : "warning"} size="sm">
                          {c.inAcceptedSnapshot
                            ? t(language, "deliver.acceptedBadge")
                            : t(language, "deliver.otherBadge")}
                        </Badge>
                      )}
                    </Label>
                  ))
                )}
              </div>
            </div>
          )}

          {canSubmitExistingCommits && (
            <Alert variant="info">
              <Icon icon={Info} size={14} />
              <AlertDescription>
                {t(language, "deliver.existingCommitsPrefix")}
                <strong>{deliveryPreview?.aheadCommitsCount}</strong>
                {t(language, "deliver.existingCommitsSuffix")}
              </AlertDescription>
            </Alert>
          )}

          {(candidates.length > 0 || !canSubmitExistingCommits) && (
            <div>
              <Label className="mb-1 block text-xs text-muted-foreground font-normal">
                {t(language, "deliver.commitLabel")}
              </Label>
              <Input
                data-testid="deliver-commit-message"
                value={m.commitMessage}
                onChange={(e) =>
                  setModal((prev) => (prev?.kind === "deliver" ? { ...prev, commitMessage: e.target.value } : prev))
                }
              />
            </div>
          )}

          {createPr && (
            <div className="space-y-2 border-t pt-2">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div>
                  <Label className="mb-1 block text-xs text-muted-foreground font-normal">
                    {t(language, "deliver.branchLabel")}
                  </Label>
                  <Input
                    data-testid="deliver-pr-branch"
                    readOnly={sandboxActive}
                    value={m.branchName ?? deliveryPreview?.suggestedBranch ?? ""}
                    onChange={(e) =>
                      setModal((prev) => (prev?.kind === "deliver" ? { ...prev, branchName: e.target.value } : prev))
                    }
                  />
                </div>
                <div>
                  <Label className="mb-1 block text-xs text-muted-foreground font-normal">
                    {t(language, "deliver.baseLabel")}
                  </Label>
                  <Input
                    data-testid="deliver-pr-base"
                    value={m.baseBranch ?? deliveryPreview?.baseBranch ?? "main"}
                    onChange={(e) =>
                      setModal((prev) => (prev?.kind === "deliver" ? { ...prev, baseBranch: e.target.value } : prev))
                    }
                  />
                </div>
              </div>
              {!sandboxActive &&
                (deliveryPreview?.aheadCommitsCount ?? 0) >= 20 &&
                (m.baseBranch ?? deliveryPreview?.baseBranch) === deliveryPreview?.baseBranch && (
                  <Alert variant="warning" data-testid="deliver-large-ahead-warn">
                    <Icon icon={AlertTriangle} size={14} />
                    <AlertDescription>
                      {t(language, "deliver.largeAheadWarn", {
                        count: deliveryPreview!.aheadCommitsCount,
                        base: deliveryPreview!.baseBranch ?? "main",
                      })}
                    </AlertDescription>
                  </Alert>
                )}
              <div>
                <Label className="mb-1 block text-xs text-muted-foreground font-normal">
                  {t(language, "deliver.prTitleLabelPlatform", { platform: prPlatformLabel })}
                </Label>
                <Input
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
                <div>
                  <Label className="flex items-center gap-2 text-xs font-normal">
                    <Checkbox
                      data-testid="deliver-force-lease"
                      checked={m.forceWithLease ?? Boolean(deliveryPreview?.remoteBranchDiverged)}
                      onCheckedChange={(checked) =>
                        setModal((prev) =>
                          prev?.kind === "deliver" ? { ...prev, forceWithLease: Boolean(checked) } : prev,
                        )
                      }
                    />
                    <span>{t(language, "deliver.forceWithLeaseLabel")}</span>
                  </Label>
                  {deliveryPreview?.remoteBranchDiverged && (
                    <div className="xs muted ps-5.5 mt-0.5">
                      {t(language, "deliver.forceWithLeaseWarn")}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div>
            <Label className="mb-1 block text-xs text-muted-foreground font-normal">
              {t(language, "deliver.noteLabel")}
            </Label>
            <Input
              data-testid="deliver-note"
              value={m.note}
              placeholder={t(language, "deliver.notePlaceholder")}
              onChange={(e) =>
                setModal((prev) => (prev?.kind === "deliver" ? { ...prev, note: e.target.value } : prev))
              }
            />
          </div>
          {runLocked && <RunLockNotice />}
        </DialogPanel>

        <DialogFooter>
          <Button variant="ghost" type="button" onClick={close}>
            <Icon icon={X} size={14} /> {t(language, "common.cancel")}
          </Button>
          <Button
            variant="default"
            type="button"
            data-testid="submit-deliver-btn"
            disabled={busy || runLocked || (!canSubmitExistingCommits && m.selectedFiles.length === 0)}
            onClick={() => void submitDeliver()}
          >
            <Icon icon={createPr ? GitPullRequest : GitCommit} size={14} />{" "}
            {createPr
              ? t(language, "deliver.submitPrPlatform", { platform: prPlatformLabel })
              : t(language, "deliver.submitLocal")}
          </Button>
        </DialogFooter>
      </ModalShell>
    );
  }

  if (m.kind === "spawn_children") {
    const validItems = m.items.filter((it) => it.title.trim().length > 0);
    const submitSpawn = async () => {
      if (guardRequirementRunLock(m.parentId)) return;
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
      <ModalShell onClose={close} wide testId="spawn-children-modal" hasExplicitTitle>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon icon={GitFork} size={20} />
            <span>{t(language, "spawn.title")}</span>
          </DialogTitle>
          <DialogDescription>{t(language, "spawn.desc")}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-[13px]">
              <span className="muted xs">{t(language, "spawn.trackLabel")}</span>
              <SimpleSelect
                size="sm"
                data-testid="spawn-track-select"
                value={m.track}
                onValueChange={(next) =>
                  setModal((prev) =>
                    prev?.kind === "spawn_children" ? { ...prev, track: next as Track } : prev,
                  )
                }
                options={[
                  { value: "plan_first", label: t(language, "spawn.trackPlan") },
                  { value: "fast_track", label: t(language, "spawn.trackFast") },
                ]}
              />
            </div>
            <Button
              variant="outline"
              size="xs"
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
              <Icon icon={Plus} size={14} /> {t(language, "spawn.addItem")}
            </Button>
          </div>
          <div className="flex max-h-80 flex-col gap-2 overflow-y-auto">
            {m.items.map((item, idx) => (
              <div
                key={idx}
                className="flex flex-col gap-1.5 rounded-lg border p-2"
              >
                <div className="flex items-center gap-1.5">
                  <Input
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
                  <Button
                    variant="ghost"
                    size="icon-xs"
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
                  </Button>
                </div>
                <Textarea
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
          {runLocked && <RunLockNotice />}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" type="button" onClick={close}>
            <Icon icon={X} size={14} /> {t(language, "common.cancel")}
          </Button>
          <Button
            variant="default"
            type="button"
            data-testid="spawn-submit-btn"
            disabled={busy || runLocked || validItems.length === 0}
            onClick={() => void submitSpawn()}
          >
            <Icon icon={GitFork} size={14} /> {t(language, "spawn.submit", { count: validItems.length })}
          </Button>
        </DialogFooter>
      </ModalShell>
    );
  }

  if (m.kind === "observability_pricing") {
    return <ObservabilityPricingModal onClose={close} />;
  }

  return (
    <ModalShell onClose={close} hasExplicitTitle>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Icon icon={Bug} size={20} />
          <span>{t(language, "debug.title")}</span>
        </DialogTitle>
      </DialogHeader>
      <DialogPanel>
        <pre className="evidence-log">{m.text}</pre>
      </DialogPanel>
      <DialogFooter>
        <Button variant="default" type="button" onClick={close}>
          <Icon icon={X} size={14} /> {t(language, "common.close")}
        </Button>
      </DialogFooter>
    </ModalShell>
  );
}
