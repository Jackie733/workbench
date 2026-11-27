import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUp,
  Bug,
  Check,
  ChevronDown,
  CircleHelp,
  ClipboardCheck,
  Download,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitCommit,
  GitFork,
  GitPullRequest,
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
  Search,
  Send,
  Server,
  Settings,
  Trash2,
  Wrench,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import type { PrivacyMode, RequirementKind, RequirementTier, RunBillingMode, Track } from "../../core/types.ts";
import type { ModelPriceOverride } from "../../hub/types.ts";
import { api, setApiProjectScope } from "../api.ts";
import {
  dispatchSyncBaseWithAgent,
  guardRequirementRunLock,
  invalidateAllWorkbenchQueries,
  openRequirement,
  runBusy,
  submitAcceptOverride,
  submitAnnotation,
  submitFeedback,
  submitImportGiteeIssue,
  submitImportGitHubIssue,
  submitLifecycle,
  submitNewRequirement,
  submitRevisePlan,
  syncSandboxBaseAction,
  notifyCascadeSyncResults,
  useDeliveryQuery,
  useGiteeIssuesQuery,
  useGiteeStatusQuery,
  useGitHubStatusQuery,
  useHubPricingQuery,
  useHubStateQuery,
  useProjectQuery,
  useProjectSandboxesQuery,
  useRequirementQuery,
  useRequirementRunLock,
} from "../queries.ts";
import {
  describeClientError,
  formatGitFileStatusLabel,
  formatGiteeStatusReason,
  formatGitHubStatusReason,
  resolveWarningParam,
  t,
} from "../i18n.ts";
import { formatBytes, formatReviewFixFeedback, relativeTime } from "../state.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { AttachmentPicker } from "./AttachmentPicker.tsx";
import { Icon } from "./Icon.tsx";
import { MarkdownView, ModalShell, RunLockNotice } from "./Primitives.tsx";
import { RoutingSettingsModal } from "./RoutingSettingsModal.tsx";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert.tsx";
import { AsyncButton } from "./ui/async-button.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Checkbox } from "./ui/checkbox.tsx";
import { DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "./ui/dialog.tsx";
import { Input } from "./ui/input.tsx";
import { Label } from "./ui/label.tsx";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover.tsx";
import { Radio, RadioGroup, RadioGroupPrimitive, RadioPrimitive } from "./ui/radio-group.tsx";
import { SegmentedControl, SegmentedControlItem } from "./ui/segmented-control.tsx";
import { SimpleSelect } from "./ui/select.tsx";
import { Textarea } from "./ui/textarea.tsx";

const STANDARD_QUOTA_POOLS = [
  "opencode-go",
  "openai-codex",
  "qoder-cn",
  "google-antigravity",
  "opencode-free",
  "anthropic",
  "openai",
];

const GITEE_NO_PROGRAM_KEY = "__none__";

const GITEE_STATUS_COLORS: Record<string, string> = {
  待办的: "#f59e0b",
  待办: "#f59e0b",
  开启: "#f59e0b",
  开发中: "#3b82f6",
  进行中: "#3b82f6",
  开发完成: "#64748b",
  已完成: "#64748b",
  待测试: "#eab308",
  测试中: "#eab308",
  执行中: "#6366f1",
  测试未通过: "#ef4444",
  已拒绝: "#dc2626",
  已验收: "#10b981",
  已关闭: "#9ca3af",
};

const GITEE_PROJECT_DOT_COLORS = ["#2563eb", "#10b981", "#7c3aed", "#f59e0b", "#0ea5e9", "#ec4899"];

function giteeStatusDotColor(statusKey: string, rawState?: string): string {
  const known = GITEE_STATUS_COLORS[statusKey];
  if (known) return known;
  if (rawState === "progressing") return "#3b82f6";
  if (rawState === "closed" || rawState === "rejected") return "#9ca3af";
  return "#f59e0b";
}

function giteeProjectDotColor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return GITEE_PROJECT_DOT_COLORS[hash % GITEE_PROJECT_DOT_COLORS.length]!;
}

interface GiteeFilterOption {
  value: string;
  label: string;
  count: number;
  color?: string;
}

function GiteeFilterSelect(props: {
  label: string;
  options: GiteeFilterOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  searchPlaceholder: string;
  clearLabel: string;
  emptyLabel: string;
  formatSelectedCount: (count: number) => string;
  testId: string;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleOptions = normalizedQuery
    ? props.options.filter((opt) => opt.label.toLowerCase().includes(normalizedQuery))
    : props.options;
  const selectedOptions = props.options.filter((opt) => props.selected.includes(opt.value));
  const firstSelected = selectedOptions[0];
  const restCount = selectedOptions.length - 1;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="inline-flex h-8 min-w-0 max-w-60 items-center gap-1.5 rounded-lg border border-input bg-background px-2.5 text-sm shadow-xs/5 outline-none transition-shadow hover:border-ring focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24"
        aria-label={props.label}
        data-testid={props.testId}
      >
        {firstSelected ? (
          <>
            {firstSelected.color && (
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: firstSelected.color }}
              />
            )}
            <span className="truncate font-medium">{firstSelected.label}</span>
            {restCount > 0 && <span className="shrink-0 text-xs font-semibold text-info">+{restCount}</span>}
            <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
              {selectedOptions.length}
            </span>
          </>
        ) : (
          <span className="truncate text-muted-foreground">{props.label}</span>
        )}
        <ChevronDown className="ms-auto size-3.5 shrink-0 opacity-60" />
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="start" sideOffset={6} className="w-72 p-0" viewportClassName="p-0">
        <div className="border-b p-2">
          <Input
            autoFocus
            value={query}
            className="h-8"
            placeholder={props.searchPlaceholder}
            aria-label={props.searchPlaceholder}
            data-testid={`${props.testId}-search`}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="max-h-64 overflow-y-auto p-1" role="listbox" aria-multiselectable="true">
          {visibleOptions.map((opt) => {
            const checked = props.selected.includes(opt.value);
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={checked}
                data-testid={`${props.testId}-option`}
                data-value={opt.value}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent ${
                  checked ? "bg-accent/60" : ""
                }`}
                onClick={() =>
                  props.onChange(
                    checked ? props.selected.filter((value) => value !== opt.value) : [...props.selected, opt.value],
                  )
                }
              >
                <Checkbox checked={checked} tabIndex={-1} aria-hidden="true" className="pointer-events-none" />
                {opt.color && (
                  <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: opt.color }} />
                )}
                <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{opt.count}</span>
              </button>
            );
          })}
          {visibleOptions.length === 0 && (
            <div className="p-4 text-center text-xs text-muted-foreground">{props.emptyLabel}</div>
          )}
        </div>
        <div className="flex items-center justify-between border-t px-2 py-1">
          <Button
            variant="ghost"
            size="xs"
            type="button"
            data-testid={`${props.testId}-clear`}
            onClick={() => props.onChange([])}
          >
            {props.clearLabel}
          </Button>
          <span className="text-xs text-muted-foreground">{props.formatSelectedCount(props.selected.length)}</span>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

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

  const handleSave = () => {
    const pricingOverrides: Record<string, ModelPriceOverride> = {};
    for (const row of priceRows) {
      const k = row.key.trim();
      if (!k) continue;
      pricingOverrides[k] = row.spec;
    }
    // 局部 loading 只跟随受 runBusy 互斥保护的请求；后续刷新与提示继续按原顺序异步执行。
    const request = runBusy(() =>
      api.updateHubPricing({
        traceRetentionDays: Math.max(1, Math.floor(retentionDays || 30)),
        billingOverrides: billingMap,
        pricingOverrides,
      }),
    );
    void request
      .then(async (ok) => {
        if (!ok) return;
        await invalidateAllWorkbenchQueries();
        showToastKey("pricing.saved");
        onClose();
      })
      .catch((err) => useUiStore.getState().showToastError(err));
    return request;
  };

  const handlePrune = () => {
    const request = runBusy(() => api.pruneHubRunTraces(Math.max(0, Math.floor(retentionDays || 30))));
    void request
      .then(async (out) => {
        if (!out) return;
        await invalidateAllWorkbenchQueries();
        showToastKey("pricing.prunedSummary", {
          deleted: out.deletedFiles,
          freed: formatBytes(out.freedBytes),
          projects: out.projectsPruned ?? 1,
        });
      })
      .catch((err) => useUiStore.getState().showToastError(err));
    return request;
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
            <AsyncButton
              type="button"
              variant="outline"
              size="xs"
              data-testid="prune-traces-now-btn"
              disabled={busy}
              onAction={handlePrune}
            >
              <Icon icon={Trash2} size={14} /> {t(language, "pricing.pruneNow")}
            </AsyncButton>
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
        <AsyncButton
          variant="default"
          type="button"
          data-testid="save-pricing-btn"
          disabled={busy}
          onAction={handleSave}
        >
          <Icon icon={Save} size={14} /> {t(language, "pricing.save")}
        </AsyncButton>
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
  const closeModal = useUiStore((s) => s.closeModal);
  const modalInstanceId = useUiStore((s) => s.modalInstanceId);
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
        (m.kind === "new_req" || m.kind === "link_issue" || m.kind === "deliver"),
    ),
  );
  const { data: giteeStatus } = useGiteeStatusQuery(
    activeProjectId,
    Boolean(
      !noHubProject &&
        project?.initialized &&
        m &&
        (m.kind === "new_req" || m.kind === "link_issue" || m.kind === "deliver"),
    ),
  );
  const isGiteeProject =
    project?.remoteProvider === "gitee" || Boolean(project?.project?.gitee);
  const giteeFilter = m?.kind === "new_req" ? (m.giteeFilter ?? "collaborator") : "collaborator";
  const giteeStatuses = m?.kind === "new_req" ? (m.giteeStatuses ?? []) : [];
  const giteeProjects = m?.kind === "new_req" ? (m.giteeProjects ?? []) : [];
  const giteeSearch = m?.kind === "new_req" ? (m.giteeSearch ?? "") : "";
  const giteeIssuesQuery = useGiteeIssuesQuery(
    activeProjectId,
    { filter: giteeFilter, q: giteeSearch },
    Boolean(
      m?.kind === "new_req" &&
        m.mode === "import_issue" &&
        isGiteeProject &&
        giteeStatus?.authenticated,
    ),
  );

  const giteeItems = giteeIssuesQuery.data?.items ?? [];
  const giteeStatusOptions: GiteeFilterOption[] = (() => {
    const counts = new Map<string, { count: number; rawState?: string }>();
    for (const item of giteeItems) {
      const key = item.stateName ?? item.state;
      const prev = counts.get(key);
      counts.set(key, { count: (prev?.count ?? 0) + 1, rawState: prev?.rawState ?? item.state });
    }
    return [...counts.entries()]
      .map(([value, { count, rawState }]) => ({
        value,
        label: value,
        count,
        color: giteeStatusDotColor(value, rawState),
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "zh-CN"));
  })();
  const giteeProjectOptions: GiteeFilterOption[] = (() => {
    const counts = new Map<string, number>();
    for (const item of giteeItems) {
      const key = item.programName ?? GITEE_NO_PROGRAM_KEY;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([value, count]) => ({
        value,
        label: value === GITEE_NO_PROGRAM_KEY ? t(language, "gitee.noProgram") : value,
        count,
        color: value === GITEE_NO_PROGRAM_KEY ? undefined : giteeProjectDotColor(value),
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "zh-CN"));
  })();
  const giteeVisibleItems = giteeItems.filter((item) => {
    const statusKey = item.stateName ?? item.state;
    if (giteeStatuses.length > 0 && !giteeStatuses.includes(statusKey)) return false;
    const projectKey = item.programName ?? GITEE_NO_PROGRAM_KEY;
    if (giteeProjects.length > 0 && !giteeProjects.includes(projectKey)) return false;
    return true;
  });
  const hasGiteeFacetFilters = giteeStatuses.length > 0 || giteeProjects.length > 0;
  const patchGiteeFilters = (patch: {
    giteeFilter?: "collaborator" | "assigned" | "created" | "all";
    giteeStatuses?: string[];
    giteeProjects?: string[];
    giteeSearch?: string;
  }) =>
    setModal((prev) =>
      prev?.kind === "new_req" ? { ...prev, ...patch, selectedGiteeIssue: null } : prev,
    );

  if (!m) return null;

  const close = () => setModal(null);
  // 异步提交完成时只关闭发起请求时的同一弹窗实例，避免旧请求误关用户后来打开的新弹窗。
  const closeSubmitted = () => closeModal(modalInstanceId);
  const runLocked = runLock !== null;
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
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">{t(language, "kind.label")}</span>
                <SegmentedControl
                  size="sm"
                  aria-label={t(language, "kind.label")}
                  render={
                    <RadioGroupPrimitive
                      className="flex items-center"
                      value={m.reqKind ?? "feature"}
                      onValueChange={(next) => {
                        if (next === "feature" || next === "bug") {
                          setModal((prev) =>
                            prev?.kind === "new_req" ? { ...prev, reqKind: next as RequirementKind } : prev,
                          );
                        }
                      }}
                    />
                  }
                >
                  <SegmentedControlItem
                    render={<RadioPrimitive.Root value="feature" data-testid="new-req-kind-feature" />}
                  >
                    {t(language, "kind.feature")}
                  </SegmentedControlItem>
                  <SegmentedControlItem
                    render={<RadioPrimitive.Root value="bug" data-testid="new-req-kind-bug" />}
                  >
                    <Icon icon={Bug} size={14} /> {t(language, "kind.bug")}
                  </SegmentedControlItem>
                </SegmentedControl>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">{t(language, "tier.label")}</span>
                <SegmentedControl
                  size="sm"
                  aria-label={t(language, "tier.label")}
                  render={
                    <RadioGroupPrimitive
                      className="flex items-center"
                      value={m.tier ?? "standard"}
                      onValueChange={(next) => {
                        if (next === "standard" || next === "sota") {
                          setModal((prev) =>
                            prev?.kind === "new_req" ? { ...prev, tier: next as RequirementTier } : prev,
                          );
                        }
                      }}
                    />
                  }
                >
                  <SegmentedControlItem
                    render={<RadioPrimitive.Root value="standard" data-testid="new-req-tier-standard" />}
                  >
                    {t(language, "tier.standard")}
                  </SegmentedControlItem>
                  <SegmentedControlItem
                    render={<RadioPrimitive.Root value="sota" data-testid="new-req-tier-sota" />}
                  >
                    <Icon icon={Zap} size={14} /> {t(language, "tier.sota")}
                  </SegmentedControlItem>
                </SegmentedControl>
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
              <AsyncButton
                variant="outline"
                type="button"
                data-testid="save-draft-btn"
                disabled={busy}
                onAction={() =>
                  submitNewRequirement(
                    m.goal,
                    false,
                    isGiteeProject ? false : createIssueChecked,
                    (m.attachments ?? []).map((a) => a.id),
                    {
                      createSandbox: m.createSandbox,
                      stackedOnReqId: m.stackedOnReqId,
                      tier: m.tier,
                      reqKind: m.reqKind ?? "feature",
                    },
                  )
                }
              >
                <Icon icon={Save} size={14} />{" "}
                {m.reqKind === "bug" ? t(language, "newReq.saveBugOnly") : t(language, "newReq.saveDraft")}
              </AsyncButton>
              <AsyncButton
                variant="default"
                type="button"
                data-testid="create-and-dispatch-btn"
                disabled={busy}
                onAction={() =>
                  submitNewRequirement(
                    m.goal,
                    true,
                    isGiteeProject ? false : createIssueChecked,
                    (m.attachments ?? []).map((a) => a.id),
                    {
                      createSandbox: m.createSandbox,
                      stackedOnReqId: m.stackedOnReqId,
                      tier: m.tier,
                      reqKind: m.reqKind ?? "feature",
                      startImmediately: m.reqKind === "bug",
                    },
                  )
                }
              >
                <Icon icon={m.reqKind === "bug" ? Bug : Zap} size={14} />{" "}
                {m.reqKind === "bug" ? t(language, "newReq.createStartBug") : t(language, "newReq.createDispatch")}
              </AsyncButton>
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
                          tab: "project",
                          draft: null,
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
                          className="flex flex-wrap items-center"
                          value={giteeFilter}
                          onValueChange={(next) => {
                            if (next === "collaborator" || next === "assigned" || next === "created" || next === "all") {
                              patchGiteeFilters({ giteeFilter: next, giteeStatuses: [], giteeProjects: [] });
                            }
                          }}
                        />
                      }
                    >
                      {(
                        [
                          ["collaborator", t(language, "gitee.filterCollaborator")],
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
                  </div>
                  {giteeFilter === "collaborator" && giteeStatus && !giteeStatus.enterprise && (
                    <div className="text-xs text-muted-foreground">{t(language, "gitee.collaboratorHint")}</div>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <GiteeFilterSelect
                      testId="gitee-status-filter"
                      label={t(language, "gitee.statusFilterLabel")}
                      options={giteeStatusOptions}
                      selected={giteeStatuses}
                      onChange={(next) => patchGiteeFilters({ giteeStatuses: next })}
                      searchPlaceholder={t(language, "gitee.filterSearchPlaceholder")}
                      clearLabel={t(language, "gitee.clearOptions")}
                      emptyLabel={t(language, "gitee.noMatchingOptions")}
                      formatSelectedCount={(count) => t(language, "gitee.selectedCount", { count })}
                    />
                    <GiteeFilterSelect
                      testId="gitee-project-filter"
                      label={t(language, "gitee.projectFilterLabel")}
                      options={giteeProjectOptions}
                      selected={giteeProjects}
                      onChange={(next) => patchGiteeFilters({ giteeProjects: next })}
                      searchPlaceholder={t(language, "gitee.filterSearchPlaceholder")}
                      clearLabel={t(language, "gitee.clearOptions")}
                      emptyLabel={t(language, "gitee.noMatchingOptions")}
                      formatSelectedCount={(count) => t(language, "gitee.selectedCount", { count })}
                    />
                    <span className="ms-auto text-xs text-muted-foreground" data-testid="gitee-result-count">
                      {t(language, "gitee.resultCount", { count: giteeVisibleItems.length })}
                    </span>
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

                  {hasGiteeFacetFilters && (
                    <div className="flex flex-wrap items-center gap-1.5" data-testid="gitee-active-filters">
                      {giteeStatusOptions
                        .filter((opt) => giteeStatuses.includes(opt.value))
                        .map((opt) => (
                          <span
                            key={`status:${opt.value}`}
                            className="inline-flex items-center gap-1 rounded-md border bg-secondary/50 py-0.5 pe-0.5 ps-2 text-xs"
                          >
                            {opt.color && (
                              <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: opt.color }} />
                            )}
                            <span>{opt.label}</span>
                            <button
                              type="button"
                              className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                              aria-label={opt.label}
                              onClick={() =>
                                patchGiteeFilters({ giteeStatuses: giteeStatuses.filter((value) => value !== opt.value) })
                              }
                            >
                              <X className="size-3" />
                            </button>
                          </span>
                        ))}
                      {giteeProjectOptions
                        .filter((opt) => giteeProjects.includes(opt.value))
                        .map((opt) => (
                          <span
                            key={`project:${opt.value}`}
                            className="inline-flex items-center gap-1 rounded-md border bg-secondary/50 py-0.5 pe-0.5 ps-2 text-xs"
                          >
                            {opt.color && (
                              <span className="size-2 shrink-0 rounded-[2px]" style={{ backgroundColor: opt.color }} />
                            )}
                            <span>{opt.label}</span>
                            <button
                              type="button"
                              className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                              aria-label={opt.label}
                              onClick={() =>
                                patchGiteeFilters({ giteeProjects: giteeProjects.filter((value) => value !== opt.value) })
                              }
                            >
                              <X className="size-3" />
                            </button>
                          </span>
                        ))}
                      <Button
                        variant="ghost"
                        size="xs"
                        type="button"
                        data-testid="gitee-clear-filters"
                        onClick={() => patchGiteeFilters({ giteeStatuses: [], giteeProjects: [] })}
                      >
                        {t(language, "gitee.clearFilters")}
                      </Button>
                    </div>
                  )}

                  <Input
                    data-testid="gitee-issue-search"
                    value={giteeSearch}
                    placeholder={t(language, "gitee.searchPlaceholder")}
                    onChange={(e) => patchGiteeFilters({ giteeSearch: e.target.value })}
                  />

                  <div
                    data-testid="gitee-issue-list"
                    className="flex max-h-72 flex-col gap-1.5 overflow-y-auto rounded-lg border p-1.5"
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
                    ) : giteeVisibleItems.length === 0 ? (
                      <div className="muted xs flex flex-col items-center gap-2 p-4 text-center">
                        <div>
                          {t(language, "gitee.empty")}
                          {giteeStatus?.enterprise
                            ? t(language, "gitee.enterpriseSuffix", { enterprise: giteeStatus.enterprise })
                            : ""}
                        </div>
                        {hasGiteeFacetFilters && (
                          <Button
                            variant="outline"
                            size="xs"
                            type="button"
                            data-testid="gitee-empty-clear-filters"
                            onClick={() => patchGiteeFilters({ giteeStatuses: [], giteeProjects: [] })}
                          >
                            {t(language, "gitee.clearFilters")}
                          </Button>
                        )}
                      </div>
                    ) : (
                      giteeVisibleItems.map((item) => {
                        const isSelected = m.selectedGiteeIssue?.ident === item.ident;
                        const statusKey = item.stateName ?? item.state;
                        const statusColor = giteeStatusDotColor(statusKey, item.state);
                        const updatedMs = Date.parse(item.updatedAt);
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
                                <span
                                  className="inline-flex h-5 items-center gap-1 rounded-[4px] border px-1.5 text-[11px] font-medium"
                                  style={{
                                    color: statusColor,
                                    borderColor: `${statusColor}55`,
                                    backgroundColor: `${statusColor}14`,
                                  }}
                                >
                                  <span className="size-1.5 rounded-full" style={{ backgroundColor: statusColor }} />
                                  {statusKey}
                                </span>
                                {item.programName ? (
                                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                                    <span
                                      className="size-1.5 rounded-[2px]"
                                      style={{ backgroundColor: giteeProjectDotColor(item.programName) }}
                                    />
                                    {item.programName}
                                  </span>
                                ) : (
                                  <span className="xs muted">{t(language, "gitee.noProgram")}</span>
                                )}
                                <span className="xs muted">
                                  {item.repository ? item.repository : t(language, "gitee.unlinkedRepo")}
                                </span>
                              </div>
                              <div className="text-[13px] font-medium">{item.title}</div>
                              <div className="xs muted mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                {item.assignee && (
                                  <span className="inline-flex items-center gap-1">
                                    <span className="inline-flex size-4 items-center justify-center rounded-full bg-secondary text-[9px] font-semibold">
                                      {item.assignee.slice(0, 1).toUpperCase()}
                                    </span>
                                    {item.assignee}
                                  </span>
                                )}
                                {Number.isFinite(updatedMs) && <span>{relativeTime(updatedMs, language)}</span>}
                              </div>
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
              <AsyncButton
                variant="outline"
                type="button"
                data-testid="import-issue-draft-btn"
                disabled={busy || (!m.selectedGiteeIssue && !(m.issueRef ?? "").trim())}
                onAction={() =>
                  submitImportGiteeIssue({
                    issue: m.selectedGiteeIssue,
                    issueRef: m.issueRef,
                    dispatchAgent: false,
                  })
                }
              >
                <Icon icon={Download} size={14} /> {t(language, "gitee.importDraft")}
              </AsyncButton>
              <AsyncButton
                variant="default"
                type="button"
                data-testid="import-issue-dispatch-btn"
                disabled={busy || (!m.selectedGiteeIssue && !(m.issueRef ?? "").trim())}
                onAction={() =>
                  submitImportGiteeIssue({
                    issue: m.selectedGiteeIssue,
                    issueRef: m.issueRef,
                    dispatchAgent: true,
                  })
                }
              >
                <Icon icon={Zap} size={14} /> {t(language, "gitee.importDispatch")}
              </AsyncButton>
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
              <AsyncButton
                variant="outline"
                type="button"
                data-testid="import-issue-draft-btn"
                disabled={busy}
                onAction={() => submitImportGitHubIssue(m.issueRef ?? "", false)}
              >
                <Icon icon={Download} size={14} /> {t(language, "newReq.importDraft")}
              </AsyncButton>
              <AsyncButton
                variant="default"
                type="button"
                data-testid="import-issue-dispatch-btn"
                disabled={busy}
                onAction={() => submitImportGitHubIssue(m.issueRef ?? "", true)}
              >
                <Icon icon={Zap} size={14} /> {t(language, "newReq.importDispatch")}
              </AsyncButton>
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
        closeSubmitted();
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
          <AsyncButton
            variant="default"
            type="button"
            data-testid="submit-add-project-btn"
            disabled={busy}
            onAction={submitAddProject}
          >
            <Icon icon={Plus} size={14} /> {t(language, "addProject.submit")}
          </AsyncButton>
        </DialogFooter>
      </ModalShell>
    );
  }

  if (m.kind === "routing") {
    return <RoutingSettingsModal modal={m} onClose={close} />;
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
          <Button variant="ghost" type="button" data-testid="annotate-cancel-btn" onClick={close}>
            <Icon icon={X} size={14} /> {t(language, "common.cancel")}
          </Button>
          <AsyncButton
            variant="outline"
            type="button"
            data-testid="annotate-ask-btn"
            disabled={runLocked}
            onAction={() => (detail ? submitAnnotation(detail.state.id, m.anchor, m.message, "ask") : undefined)}
          >
            <Icon icon={Lightbulb} size={14} /> {t(language, "annotate.ask")}
          </AsyncButton>
          <AsyncButton
            variant="default"
            type="button"
            data-testid="annotate-queue-btn"
            onAction={() => (detail ? submitAnnotation(detail.state.id, m.anchor, m.message, "refine") : undefined)}
          >
            <Icon icon={Pencil} size={14} /> {t(language, "annotate.queue")}
          </AsyncButton>
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
    const isDesignStage = detail?.state.stage === "planning";
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
          <Label className="flex items-center gap-2 text-[13px] font-normal">
            <Checkbox
              data-testid="feedback-remember-lesson"
              checked={Boolean(m.rememberLesson)}
              onCheckedChange={(checked) =>
                setModal((prev) =>
                  prev?.kind === "feedback" ? { ...prev, rememberLesson: Boolean(checked) } : prev,
                )
              }
            />
            <span>{t(language, "playbook.rememberLabel")}</span>
          </Label>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" type="button" onClick={close}>
            <Icon icon={X} size={14} /> {t(language, "common.cancel")}
          </Button>
          <AsyncButton
            variant="default"
            type="button"
            data-testid="feedback-submit-btn"
            disabled={busy || runLocked}
            onAction={() =>
              detail
                ? submitFeedback(detail, m.feedback, m.dispatchAgent, { rememberLesson: Boolean(m.rememberLesson) })
                : undefined
            }
          >
            <Icon icon={Send} size={14} />{" "}
            {isDesignStage ? t(language, "feedback.submitDesign") : t(language, "feedback.submitFix")}
          </AsyncButton>
        </DialogFooter>
      </ModalShell>
    );
  }

  if (m.kind === "accept_override") {
    const isBlock = m.verdict === "block";
    const requiresReason = isBlock || m.verdict === "stale";
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
          <Alert variant={requiresReason ? "error" : "warning"}>
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
              {requiresReason ? t(language, "acceptOverride.reasonBlockLabel") : t(language, "acceptOverride.reasonConcernLabel")}
            </Label>
            <Textarea
              data-testid="accept-override-reason"
              autoFocus
              value={m.reason}
              placeholder={
                requiresReason
                  ? t(language, "acceptOverride.reasonBlockPlaceholder")
                  : t(language, "acceptOverride.reasonConcernPlaceholder")
              }
              onChange={(e) =>
                setModal((prev) => (prev?.kind === "accept_override" ? { ...prev, reason: e.target.value } : prev))
              }
            />
          </div>
          <Label className="flex items-center gap-2 text-[13px] font-normal">
            <Checkbox
              data-testid="accept-override-remember-lesson"
              checked={Boolean(m.rememberLesson)}
              onCheckedChange={(checked) =>
                setModal((prev) =>
                  prev?.kind === "accept_override" ? { ...prev, rememberLesson: Boolean(checked) } : prev,
                )
              }
            />
            <span>{t(language, "playbook.rememberLabel")}</span>
          </Label>
          <Label className="flex items-center gap-2 text-[13px] font-normal">
            <Checkbox
              data-testid="accept-override-open-deliver"
              checked={Boolean(m.openDeliverAfter)}
              onCheckedChange={(checked) =>
                setModal((prev) =>
                  prev?.kind === "accept_override" ? { ...prev, openDeliverAfter: Boolean(checked) } : prev,
                )
              }
            />
            <span>{t(language, "accept.openDeliverAfter")}</span>
          </Label>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" type="button" onClick={close}>
            <Icon icon={ArrowLeft} size={14} /> {t(language, "acceptOverride.back")}
          </Button>
          <AsyncButton
            variant="default"
            type="button"
            data-testid="confirm-accept-override-btn"
            disabled={busy || runLocked || (requiresReason && !m.reason.trim())}
            onAction={() =>
              detail
                ? submitAcceptOverride(detail, m.verdict, m.reason, m.acceptedRisks, {
                    rememberLesson: Boolean(m.rememberLesson),
                    openDeliverAfter: Boolean(m.openDeliverAfter),
                  })
                : undefined
            }
          >
            <Icon icon={Check} size={14} /> {t(language, "acceptOverride.confirm")}
          </AsyncButton>
        </DialogFooter>
      </ModalShell>
    );
  }

  if (m.kind === "revise_plan") {
    return (
      <ModalShell onClose={close} testId="revise-plan-modal" hasExplicitTitle>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon icon={RotateCcw} size={20} />
            <span>{t(language, "revisePlan.title")}</span>
          </DialogTitle>
          <DialogDescription>{t(language, "revisePlan.desc")}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {runLocked && <RunLockNotice />}
          <Textarea
            id="revise-plan-reason"
            data-testid="revise-plan-reason"
            autoFocus
            value={m.reason}
            placeholder={t(language, "revisePlan.placeholder")}
            onChange={(e) =>
              setModal((prev) => (prev?.kind === "revise_plan" ? { ...prev, reason: e.target.value } : prev))
            }
          />
          <Label className="flex items-center gap-2 text-[13px] font-normal">
            <Checkbox
              checked={m.dispatchAgent}
              onCheckedChange={(checked) =>
                setModal((prev) =>
                  prev?.kind === "revise_plan" ? { ...prev, dispatchAgent: Boolean(checked) } : prev,
                )
              }
            />
            <span>{t(language, "revisePlan.dispatchLabel")}</span>
          </Label>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" type="button" onClick={close}>
            <Icon icon={X} size={14} /> {t(language, "common.cancel")}
          </Button>
          <AsyncButton
            variant="default"
            type="button"
            data-testid="confirm-revise-plan-btn"
            disabled={busy || runLocked || !m.reason.trim()}
            onAction={() => (detail ? submitRevisePlan(detail, m.reason, m.dispatchAgent) : undefined)}
          >
            <Icon icon={Check} size={14} /> {t(language, "revisePlan.confirm")}
          </AsyncButton>
        </DialogFooter>
      </ModalShell>
    );
  }

  if (m.kind === "lifecycle") {
    const title =
      m.action === "cancel"
        ? t(language, "lifecycle.cancelTitle")
        : t(language, "lifecycle.reopenTitle");
    const canPreserveApproval = m.action === "reopen" && Boolean(detail?.validity.approval.valid);
    const keepApproval = canPreserveApproval ? m.preserveApproval !== false : false;
    return (
      <ModalShell onClose={close} hasExplicitTitle>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon
              icon={m.action === "cancel" ? XCircle : RotateCcw}
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
          <AsyncButton
            variant="default"
            type="button"
            data-testid="lifecycle-confirm-btn"
            disabled={busy || runLocked}
            onAction={() =>
              detail ? submitLifecycle(detail, m.action, m.reason, { preserveApproval: keepApproval }) : undefined
            }
          >
            <Icon icon={Check} size={14} /> {t(language, "common.confirm")}
          </AsyncButton>
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
        closeSubmitted();
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
          <AsyncButton
            variant="default"
            type="button"
            data-testid="submit-link-issue-btn"
            disabled={busy || runLocked || remoteReady === false}
            onAction={submitLinkIssue}
          >
            <Icon icon={Link2} size={14} />{" "}
            {isGiteeLink
              ? t(language, "gitee.linkSubmit")
              : m.mode === "create"
                ? t(language, "linkIssue.submitCreate")
                : t(language, "linkIssue.submitLink")}
          </AsyncButton>
        </DialogFooter>
      </ModalShell>
    );
  }

  if (m.kind === "deliver") {
    if (!detail) return null;
    const candidates = deliveryPreview?.candidates ?? [];
    const selectedSet = new Set(m.selectedFiles);
    const sandboxActive = Boolean(deliveryPreview?.sandboxActive);
    const isGiteeDelivery = deliveryPreview?.remoteProvider === "gitee" || isGiteeProject;
    const prAvailable = Boolean(
      deliveryPreview?.canCreatePr || (isGiteeDelivery ? giteeStatus?.ready : githubStatus?.ready),
    );
    const effectiveMode: "local" | "pr" | "local_merge" = sandboxActive
      ? (m.deliveryMode === "local_merge" ? "local_merge" : m.deliveryMode === "pr" ? "pr" : m.createPr === false || !prAvailable ? "local_merge" : "pr")
      : m.createPr
        ? "pr"
        : "local";
    const createPr = effectiveMode === "pr";
    const isLocalMerge = effectiveMode === "local_merge";
    const canSubmitExistingCommits =
      (createPr || isLocalMerge) && candidates.length === 0 && (deliveryPreview?.aheadCommitsCount ?? 0) > 0;
    const prPlatformLabel = isGiteeDelivery ? "Gitee" : "GitHub";
    const wipCount = deliveryPreview?.wipCommitCount ?? 0;
    const treeMismatch = deliveryPreview?.treeMatchesAcceptance === false;

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
      const msg = m.commitMessage.trim();
      if (isLocalMerge) {
        if (!msg) {
          showToastKey("deliver.needMessage", undefined, true);
          return;
        }
        const res = await runBusy(() =>
          api.mergeSandboxLocal(detail.state.id, {
            commitMessage: msg,
            expectedRevision: detail.state.revision,
            note: m.note.trim() || undefined,
          }),
        );
        if (res) {
          closeSubmitted();
          await invalidateAllWorkbenchQueries();
          showToastKey(
            res.restartRecommended
              ? "deliver.mergedLocalRestart"
              : res.webReloaded
                ? "deliver.mergedLocalReload"
                : "deliver.mergedLocal",
            { hash: res.delivery.shortHash, count: res.delivery.files.length },
          );
          notifyCascadeSyncResults(res.cascadeResults);
        }
        return;
      }
      const files = m.selectedFiles.filter((f) => candidates.some((c) => c.path === f));
      if (files.length === 0 && !canSubmitExistingCommits) {
        showToastKey("deliver.needFiles", undefined, true);
        return;
      }
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
        closeSubmitted();
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
                {isLocalMerge
                  ? t(language, "deliver.titleLocalMerge")
                  : createPr
                    ? t(language, "deliver.titlePrPlatform", { platform: prPlatformLabel })
                    : t(language, "deliver.titleLocal")}
              </span>
            </DialogTitle>
            {sandboxActive ? (
              <SegmentedControl
                size="sm"
                aria-label={t(language, "deliver.modeAria")}
                render={
                  <RadioGroupPrimitive
                    className="flex items-center"
                    value={effectiveMode}
                    onValueChange={(next) => {
                      if (next === "local_merge") {
                        setModal((prev) =>
                          prev?.kind === "deliver" ? { ...prev, deliveryMode: "local_merge", createPr: false } : prev,
                        );
                      } else if (next === "pr" && prAvailable) {
                        setModal((prev) =>
                          prev?.kind === "deliver" ? { ...prev, deliveryMode: "pr", createPr: true } : prev,
                        );
                      }
                    }}
                  />
                }
              >
                <SegmentedControlItem
                  render={<RadioPrimitive.Root value="local_merge" data-testid="deliver-mode-local-merge" />}
                >
                  <Icon icon={GitCommit} size={14} /> {t(language, "deliver.modeLocalMerge")}
                </SegmentedControlItem>
                <SegmentedControlItem
                  render={<RadioPrimitive.Root value="pr" data-testid="deliver-mode-pr" disabled={!prAvailable} />}
                >
                  <Icon icon={GitPullRequest} size={14} /> {t(language, "deliver.modePr")}
                </SegmentedControlItem>
              </SegmentedControl>
            ) : (
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
            {!createPr && !isLocalMerge && t(language, "deliver.localNote")}
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="space-y-3">
          {treeMismatch && (
            <Alert variant="error" data-testid="deliver-tree-mismatch-warn">
              <Icon icon={AlertTriangle} size={14} />
              <AlertDescription>{deliveryPreview?.treeMismatchReason || t(language, "deliver.treeMismatchWarn")}</AlertDescription>
            </Alert>
          )}
          {sandboxActive && wipCount > 0 && (
            <Alert variant="info" data-testid="deliver-wip-squash-hint">
              <Icon icon={Info} size={14} />
              <AlertDescription>{t(language, "deliver.wipSquashHint", { count: wipCount })}</AlertDescription>
            </Alert>
          )}
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
                    <AsyncButton
                      variant="default"
                      size="xs"
                      type="button"
                      data-testid="deliver-sync-base-btn"
                      disabled={busy}
                      onAction={() => syncSandboxBaseAction(detail.state.id)}
                    >
                      <Icon icon={RefreshCw} size={14} /> {t(language, "deliver.driftSyncBtn")}
                    </AsyncButton>
                  ) : (
                    <AsyncButton
                      variant="default"
                      size="xs"
                      type="button"
                      data-testid="deliver-resolve-conflict-btn"
                      disabled={busy}
                      onAction={async () => {
                        await dispatchSyncBaseWithAgent(detail, deliveryPreview.sandboxDrift!);
                        closeSubmitted();
                      }}
                    >
                      <Icon icon={Wrench} size={14} /> {t(language, "deliver.driftResolveBtn")}
                    </AsyncButton>
                  )}
                </AlertDescription>
              </Alert>
            )}

          {!isLocalMerge && (candidates.length > 0 || !canSubmitExistingCommits) && (
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

          {(isLocalMerge || candidates.length > 0 || !canSubmitExistingCommits || (sandboxActive && createPr && wipCount > 0)) && (
            <div>
              <Label className="mb-1 block text-xs text-muted-foreground font-normal">
                {t(language, "deliver.commitLabel")}
              </Label>
              <Textarea
                rows={3}
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
          <AsyncButton
            variant="default"
            type="button"
            data-testid="submit-deliver-btn"
            disabled={busy || runLocked || treeMismatch || (!isLocalMerge && !canSubmitExistingCommits && m.selectedFiles.length === 0)}
            onAction={submitDeliver}
          >
            <Icon icon={createPr ? GitPullRequest : GitCommit} size={14} />{" "}
            {isLocalMerge
              ? t(language, "deliver.submitLocalMerge")
              : createPr
                ? t(language, "deliver.submitPrPlatform", { platform: prPlatformLabel })
                : t(language, "deliver.submitLocal")}
          </AsyncButton>
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
        closeSubmitted();
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
          <AsyncButton
            variant="default"
            type="button"
            data-testid="spawn-submit-btn"
            disabled={busy || runLocked || validItems.length === 0}
            onAction={submitSpawn}
          >
            <Icon icon={GitFork} size={14} /> {t(language, "spawn.submit", { count: validItems.length })}
          </AsyncButton>
        </DialogFooter>
      </ModalShell>
    );
  }

  if (m.kind === "observability_pricing") {
    return <ObservabilityPricingModal onClose={closeSubmitted} />;
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
