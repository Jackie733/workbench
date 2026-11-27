import type {
  AgentAction,
  AgentRunRecord,
  AttachmentMeta,
  CriterionCoverageState,
  EffectiveVerificationState,
  GitRemoteProvider,
  OutputLanguage,
  PrivacyMode,
  RequirementDetail,
  RequirementDiffView,
  RequirementKind,
  RequirementSummary,
  RequirementTier,
  ReviewReport,
  ReviewVerdict,
  Stage,
  Track,
  ValidityReport,
} from "../core/types.ts";
import { REASONING_EFFORTS, type DiscoveredModel, type HarnessInfo, type ModelTarget, type ReasoningEffort, type RoutingConfig } from "../hub/types.ts";
import type { BrowseResponse, GiteeIssueListItem } from "./api.ts";
import {
  formatDateTime as formatDateTimeIn,
  formatRelativeTime,
  formatNumber,
  pluralMessage,
  readStorageItem,
  t,
  translateRef,
  type MessageKey,
  type MessageParams,
  type UiLanguage,
} from "./i18n.ts";

export type Scope = "active" | "decisions" | "sandboxes" | "done" | "cancelled" | "all";
export type MainView = "workspace" | "insights";
export type WorkspaceTab = "spec" | "diff" | "changes" | "timeline" | "audit";
export type DrawerTab = "discuss" | "console" | "diff";
export type ProjectSortMode = "attention" | "recent" | "name" | "added";
export type ProjectGroupMode = "none" | "node" | "status" | "category";
export type DiffViewMode = "split" | "unified";

export interface CriterionDraft {
  id: string;
  description: string;
  required: boolean;
  kind?: "command" | "manual";
  command: string;
  steps?: string;
}

export interface PendingAnnotation {
  id: string;
  anchor: string;
  message: string;
}

export type ModalState =
  | null
  | {
      kind: "new_req";
      goal: string;
      reqKind?: RequirementKind;
      tier?: RequirementTier;
      mode?: "create" | "import_issue";
      issueRef?: string;
      giteeFilter?: "collaborator" | "assigned" | "created" | "all";
      giteeStatuses?: string[];
      giteeProjects?: string[];
      giteeSearch?: string;
      selectedGiteeIssue?: GiteeIssueListItem | null;
      createGitHubIssue?: boolean;
      createSandbox?: boolean;
      stackedOnReqId?: string;
      attachments?: AttachmentMeta[];
    }
  | { kind: "feedback"; feedback: string; dispatchAgent: boolean; rememberLesson?: boolean }
  | { kind: "revise_plan"; reason: string; dispatchAgent: boolean }
  | {
      kind: "accept_override";
      verdict: ReviewVerdict | "stale" | "missing";
      summary: string;
      reason: string;
      acceptedRisks: string[];
      rememberLesson?: boolean;
      openDeliverAfter?: boolean;
    }
  | { kind: "lifecycle"; action: "cancel" | "reopen"; reason: string; preserveApproval?: boolean }
  | {
      kind: "add_project";
      nodeId: string;
      browse: BrowseResponse | null;
      pathInput: string;
      nameInput: string;
      initPrivacy: PrivacyMode | "none";
      showNodeHelp?: boolean;
    }
  | {
      kind: "routing";
      tab?: "routing" | "project";
      draft: RoutingConfig | null;
      hubLangDraft?: OutputLanguage;
      giteeTokenDraft?: string;
      clearGiteeToken?: boolean;
      projLangDraft?: OutputLanguage | "inherit";
      projProviderDraft?: GitRemoteProvider;
      ghRepoDraft?: string;
      ghBaseBranchDraft?: string;
      ghAutoCreateDraft?: boolean;
      ghAutoSyncDraft?: boolean;
      giteeRepoDraft?: string;
      giteeEnterpriseDraft?: string;
      giteeBaseBranchDraft?: string;
      fastCmdDraft?: string;
      fullCmdDraft?: string;
      autoScreenshotsDraft?: boolean;
      worktreeEnabledDraft?: boolean;
      worktreeSetupScriptDraft?: string;
      worktreeCopyFilesDraft?: string;
    }
  | {
      kind: "spawn_children";
      parentId: string;
      items: Array<{ title: string; goal: string }>;
      track: Track;
    }
  | { kind: "annotate_anchor"; anchor: string; message: string; mode: "ask" | "refine" }
  | { kind: "handoff_preview"; markdown: string }
  | {
      kind: "deliver";
      commitMessage: string;
      selectedFiles: string[];
      note: string;
      createPr?: boolean;
      deliveryMode?: "local" | "pr" | "local_merge";
      branchName?: string;
      baseBranch?: string;
      prTitle?: string;
      forceWithLease?: boolean;
    }
  | {
      kind: "link_issue";
      requirementId: string;
      provider?: GitRemoteProvider;
      mode: "create" | "link";
      issueRef: string;
    }
  | { kind: "observability_pricing" }
  | { kind: "debug_info"; text: string };

export interface StatusMeta {
  labels: Record<UiLanguage, string>;
  tone: string;
}

export const STAGE_META: Record<Stage, StatusMeta> = {
  planning: { labels: { "zh-CN": "规划中", en: "Planning" }, tone: "info" },
  coding: { labels: { "zh-CN": "研发中", en: "Coding" }, tone: "warning" },
  done: { labels: { "zh-CN": "已完成", en: "Done" }, tone: "success" },
  cancelled: { labels: { "zh-CN": "已取消", en: "Cancelled" }, tone: "neutral" },
};

export type AgentRunTone = "info" | "success" | "danger" | "neutral";

export const AGENT_RUN_TONE: Record<AgentRunRecord["status"], AgentRunTone> = {
  running: "info",
  succeeded: "success",
  failed: "danger",
  cancelled: "neutral",
};

export const COVERAGE_META: Record<CriterionCoverageState, StatusMeta> = {
  passed: { labels: { "zh-CN": "通过", en: "Passed" }, tone: "success" },
  failed: { labels: { "zh-CN": "失败", en: "Failed" }, tone: "danger" },
  stale: { labels: { "zh-CN": "需重跑", en: "Needs rerun" }, tone: "warning" },
  unverified: { labels: { "zh-CN": "未验证", en: "Unverified" }, tone: "neutral" },
  unavailable: { labels: { "zh-CN": "证据不可用", en: "Evidence unavailable" }, tone: "warning" },
};

export interface EvidenceDisplaySummary {
  isHistorical: boolean;
  tone: "success" | "warning" | "info";
  title: string;
  acceptedAtText: string | null;
  provenanceText: string;
  unavailableReason: string | null;
  truncationFlags: string[];
  scopeNote: string | null;
}

/** Formats shared accepted/legacy/live evidence provenance consistently for UI rendering & tests. */
export function describeEvidenceContext(
  validity: ValidityReport,
  diffView?: Pick<
    RequirementDiffView,
    | "context"
    | "status"
    | "reason"
    | "reasonKey"
    | "reasonParams"
    | "acceptedAt"
    | "snapshotId"
    | "scopeNote"
    | "scopeNoteKey"
    | "observation"
  > | null,
  language: UiLanguage = "zh-CN",
): EvidenceDisplaySummary {
  const p = validity.provenance;
  const acceptedAt = diffView?.acceptedAt ?? p.acceptedAt;
  const acceptedAtText = acceptedAt ? formatDateTimeIn(language, acceptedAt) : null;
  const obs = diffView?.observation ?? null;
  const truncationFlags: string[] = [];
  if (obs?.diffTruncated || p.diffTruncated) truncationFlags.push(t(language, "evidence.trunc.diff"));
  if ((obs?.binaryFiles?.length ?? 0) > 0) {
    truncationFlags.push(
      pluralMessage(language, obs!.binaryFiles.length, "evidence.trunc.binaryOne", "evidence.trunc.binaryOther", {
        count: formatNumber(language, obs!.binaryFiles.length),
      }),
    );
  }
  if ((obs?.omittedFiles?.length ?? 0) > 0) {
    truncationFlags.push(
      pluralMessage(language, obs!.omittedFiles.length, "evidence.trunc.omittedOne", "evidence.trunc.omittedOther", {
        count: formatNumber(language, obs!.omittedFiles.length),
      }),
    );
  }
  const scopeNote =
    p.scopeNoteKey || diffView?.scopeNoteKey
      ? t(language, (p.scopeNoteKey ?? diffView?.scopeNoteKey) as MessageKey)
      : (diffView?.scopeNote ?? p.scopeNote);

  const resolveEvidenceReason = (): string | null => {
    if (diffView?.reasonKey) {
      return localizedReason(diffView.reasonKey, diffView.reason ?? p.reason ?? null, language, diffView.reasonParams);
    }
    if (diffView?.status === "unavailable" && diffView.reason) {
      return localizedReason(undefined, diffView.reason, language, undefined);
    }
    return localizedReason(p.reasonKey, p.reason ?? diffView?.reason ?? null, language, p.reasonParams);
  };

  if (p.context === "accepted") {
    const shortSpec = p.specHash ? p.specHash.slice(0, 8) : "-";
    const shortSnap = p.codeSnapshotHash ? p.codeSnapshotHash.slice(0, 8) : "-";
    return {
      isHistorical: true,
      tone: "success",
      title: t(language, "evidence.title.accepted"),
      acceptedAtText,
      provenanceText: t(language, "evidence.provenance.accepted", {
        snapshot: p.snapshotId ?? "-",
        spec: shortSpec,
        code: shortSnap,
        count: formatNumber(language, p.verificationIds.length),
      }),
      unavailableReason: diffView?.status === "unavailable" ? resolveEvidenceReason() : null,
      truncationFlags,
      scopeNote,
    };
  }

  if (p.context === "legacy-unavailable") {
    const shortSpec = p.specHash ? p.specHash.slice(0, 8) : "-";
    const shortSnap = p.codeSnapshotHash ? p.codeSnapshotHash.slice(0, 8) : "-";
    const reason = resolveEvidenceReason();
    const coverageSuffix = p.coverageReasonKey
      ? `${language === "en" ? "; " : "；"}${t(language, p.coverageReasonKey as MessageKey)}`
      : "";
    const unavailableReason = diffView?.status === "unavailable" || p.context === "legacy-unavailable"
      ? reason
        ? `${reason}${coverageSuffix}`
        : t(language, "evidence.unavailable.legacy")
      : null;
    return {
      isHistorical: true,
      tone: "warning",
      title:
        p.artifactStatus === "corrupt" || p.artifactStatus === "missing"
          ? t(language, "evidence.title.missing")
          : t(language, "evidence.title.legacy"),
      acceptedAtText,
      provenanceText: t(language, "evidence.provenance.legacy", {
        spec: shortSpec,
        code: shortSnap,
        count: formatNumber(language, p.verificationIds.length),
        source: p.coverageSource,
      }),
      unavailableReason,
      truncationFlags,
      scopeNote: null,
    };
  }

  return {
    isHistorical: false,
    tone: "info",
    title: t(language, "evidence.title.live"),
    acceptedAtText: null,
    provenanceText: t(language, "evidence.provenance.live", {
      spec: p.specHash?.slice(0, 8) ?? "-",
      code: p.codeSnapshotHash?.slice(0, 8) ?? (language === "en" ? "unknown" : "未知"),
    }),
    unavailableReason: diffView?.status === "unavailable" ? resolveEvidenceReason() : null,
    truncationFlags,
    scopeNote,
  };
}

function localizedReason(
  key: string | undefined | null,
  raw: string | null,
  language: UiLanguage,
  params?: MessageParams,
): string | null {
  const translated = translateRef(language, key, raw ?? "", params);
  if (translated) return translated;
  return language === "en" ? "Reason unavailable" : "原因不可用";
}

export const EVIDENCE_META: Record<EffectiveVerificationState, StatusMeta> = {
  passed: { labels: { "zh-CN": "当前有效通过", en: "Currently valid & passed" }, tone: "success" },
  failed: { labels: { "zh-CN": "验证失败", en: "Verification failed" }, tone: "danger" },
  stale: { labels: { "zh-CN": "已过期（代码/规范已变）", en: "Expired (code/spec changed)" }, tone: "warning" },
  unknown: { labels: { "zh-CN": "快照缺失", en: "Snapshot missing" }, tone: "warning" },
};

export const VERDICT_META: Record<ReviewVerdict, StatusMeta> = {
  pass: { labels: { "zh-CN": "建议通过", en: "Recommend pass" }, tone: "success" },
  concern: { labels: { "zh-CN": "存在关注点", en: "Concerns" }, tone: "warning" },
  block: { labels: { "zh-CN": "建议阻塞修改", en: "Recommend blocking changes" }, tone: "danger" },
};

export const EFFORT_LABEL_KEYS: Record<ReasoningEffort, MessageKey> = {
  minimal: "effort.minimal",
  low: "effort.low",
  medium: "effort.medium",
  high: "effort.high",
  xhigh: "effort.xhigh",
  max: "effort.max",
  ultra: "effort.ultra",
  auto: "effort.auto",
};

export function effortLabel(language: UiLanguage, effort: ReasoningEffort): string {
  return t(language, EFFORT_LABEL_KEYS[effort]);
}

export function initialTheme(): "light" | "dark" {
  const saved = readStorageItem("wb-theme");
  if (saved === "light" || saved === "dark") return saved;
  try {
    return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function relativeTime(ms: number, language: UiLanguage = "zh-CN"): string {
  return formatRelativeTime(language, ms);
}

export function formatDateTime(ms: number, language: UiLanguage = "zh-CN"): string {
  return formatDateTimeIn(language, ms);
}

export function filterRequirementsByScope(
  items: readonly RequirementSummary[],
  scope: Exclude<Scope, "decisions" | "sandboxes">,
): RequirementSummary[] {
  switch (scope) {
    case "all":
      return [...items];
    case "active":
      return items.filter((i) => i.stage !== "done" && i.stage !== "cancelled");
    case "done":
      return items.filter((i) => i.stage === "done");
    case "cancelled":
      return items.filter((i) => i.stage === "cancelled");
  }
}

export interface UnifiedRequirementListOptions {
  allItems: readonly RequirementSummary[];
  scope: Scope;
  runs: Iterable<RequirementRunLike>;
  projectId: string | null;
  mergeOrder?: { ordered: ReadonlyArray<{ requirementId: string }> } | null;
  activeSandboxes?: ReadonlyArray<{ requirementId: string }>;
}

/**
 * 统一单一需求队列：将待拍板置顶提示、并行沙箱合并顺序与常规列表合为一份去重队列。
 */
export function orderUnifiedRequirements(options: UnifiedRequirementListOptions): {
  items: RequirementSummary[];
  pendingDecisions: RequirementSummary[];
  pendingIdSet: Set<string>;
} {
  const { allItems, scope, runs, projectId, mergeOrder, activeSandboxes = [] } = options;
  const activeItems = filterRequirementsByScope(allItems, "active");
  const pendingDecisions = partitionPendingDecisions(activeItems, runs, projectId).humanPending.sort((a, b) => {
    const aBlock = isBlockingDecisionRequirement(a) ? 0 : 1;
    const bBlock = isBlockingDecisionRequirement(b) ? 0 : 1;
    if (aBlock !== bBlock) return aBlock - bBlock;
    return a.updatedAt - b.updatedAt;
  });
  const pendingIdSet = new Set(pendingDecisions.map((item) => item.id));

  if (scope === "decisions") {
    return { items: pendingDecisions, pendingDecisions, pendingIdSet };
  }

  if (scope === "sandboxes") {
    const rankMap = new Map<string, number>();
    (mergeOrder?.ordered ?? []).forEach((entry, idx) => rankMap.set(entry.requirementId, idx));
    const sandboxIds = new Set(activeSandboxes.map((s) => s.requirementId));
    for (const id of rankMap.keys()) sandboxIds.add(id);
    const items = allItems
      .filter((item) => sandboxIds.has(item.id))
      .sort((a, b) => {
        const ra = rankMap.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const rb = rankMap.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        if (ra !== rb) return ra - rb;
        return b.updatedAt - a.updatedAt || b.id.localeCompare(a.id);
      });
    return { items, pendingDecisions, pendingIdSet };
  }

  if (scope === "active") {
    const priority = (item: RequirementSummary): number => {
      if (!pendingIdSet.has(item.id)) return 2;
      return isBlockingDecisionRequirement(item) ? 0 : 1;
    };
    const items = [...activeItems].sort((a, b) => {
      const pa = priority(a);
      const pb = priority(b);
      if (pa !== pb) return pa - pb;
      return b.updatedAt - a.updatedAt || b.id.localeCompare(a.id);
    });
    return { items, pendingDecisions, pendingIdSet };
  }

  return {
    items: filterRequirementsByScope(allItems, scope),
    pendingDecisions,
    pendingIdSet,
  };
}

export function filteredItems(items: RequirementSummary[], query: string, language: UiLanguage = "zh-CN"): RequirementSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (item) =>
      item.id.toLowerCase().includes(q) ||
      item.title.toLowerCase().includes(q) ||
      item.progressText.toLowerCase().includes(q) ||
      progressDetail(item, language).toLowerCase().includes(q),
  );
}

export interface RequirementRunLike {
  requirementId: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  action: AgentAction;
  harness: string;
  model: string;
  projectId?: string;
}

export function findActiveRequirementRun(
  runs: Iterable<RequirementRunLike>,
  requirementId: string,
  projectId: string | null,
): RequirementRunLike | undefined {
  for (const run of runs) {
    if (run.requirementId !== requirementId || run.status !== "running") continue;
    // 只读咨询不改变待人工决策状态。
    if (run.action === "ask") continue;
    if (run.projectId && run.projectId !== projectId) continue;
    return run;
  }
  return undefined;
}

export interface RequirementRunScope {
  projectId: string | null;
  projectRoot?: string | null;
  projects?: ReadonlyArray<{ id: string; root: string; nodeId?: string }>;
}

export interface RequirementRunScopeInput {
  activeProjectId: string | null;
  hubActiveProjectId?: string | null;
  projectRoot?: string | null;
  projects?: RequirementRunScope["projects"];
}

/** 界面订阅与命令式守卫共用的作用域解析规则。 */
export function resolveRequirementRunScope(input: RequirementRunScopeInput): RequirementRunScope {
  return {
    projectId: input.activeProjectId ?? input.hubActiveProjectId ?? null,
    projectRoot: input.projectRoot ?? null,
    projects: input.projects ?? [],
  };
}

export type ScopedRequirementRun = RequirementRunLike & { projectId?: string; root?: string };

function runBelongsToScope(run: ScopedRequirementRun, scope: RequirementRunScope): boolean {
  if (scope.projectId === null) {
    // 单项目模式：快照可能已附带 Hub 项目编号，但页面没有项目作用域；按本机当前根目录匹配。
    // 根目录尚未返回时无法判断归属，先等待查询结果，避免误锁其他项目的同号需求。
    if (!scope.projectRoot) return false;
    if (run.root) return run.root === scope.projectRoot;
    if (run.projectId && scope.projects?.length) {
      const owner = scope.projects.find((p) => p.id === run.projectId);
      return Boolean(owner && owner.root === scope.projectRoot);
    }
    return false;
  }
  if (run.projectId) return run.projectId === scope.projectId;
  // 缺少 projectId 时按根目录解析；无法确定归属的记录等待 Hub 快照校正。
  if (!run.root) return false;
  const owner = scope.projects?.find((p) => p.root === run.root);
  return Boolean(owner && owner.id === scope.projectId);
}

/**
 * 需求详情运行期限制的判定入口：`ask` 同样占用同需求调度名额，因此不排除。
 * 首页待决策列表继续使用 {@link findActiveRequirementRun} 的既有语义。
 */
export function findLockingRequirementRun<T extends ScopedRequirementRun>(
  runs: Iterable<T>,
  requirementId: string,
  scope: RequirementRunScope,
): T | undefined {
  for (const run of runs) {
    if (run.requirementId !== requirementId || run.status !== "running") continue;
    if (runBelongsToScope(run, scope)) return run;
  }
  return undefined;
}

export function partitionPendingDecisions(
  items: RequirementSummary[],
  runs: Iterable<RequirementRunLike>,
  projectId: string | null,
): { humanPending: RequirementSummary[]; agentProcessing: RequirementSummary[] } {
  const runList = Array.from(runs);
  const humanPending: RequirementSummary[] = [];
  const agentProcessing: RequirementSummary[] = [];
  for (const item of items) {
    if (!item.needsDecision) continue;
    if (findActiveRequirementRun(runList, item.id, projectId)) {
      agentProcessing.push(item);
    } else {
      humanPending.push(item);
    }
  }
  return { humanPending, agentProcessing };
}

export function isBlockingDecisionRequirement(item: RequirementSummary): boolean {
  if (item.decisionReasonKey) {
    return (
      item.decisionReasonKey === "core.decision.reviewBlock" ||
      item.decisionReasonKey === "core.decision.needsHuman" ||
      item.decisionReasonKey === "core.decision.bugPaused"
    );
  }
  return false;
}

export function pickDefaultRequirementId(
  items: RequirementSummary[],
  runs: Iterable<RequirementRunLike>,
  projectId: string | null,
): string | null {
  if (items.length === 0) return null;
  const pending = partitionPendingDecisions(items, runs, projectId).humanPending.sort((a, b) => {
    const aBlock = isBlockingDecisionRequirement(a) ? 0 : 1;
    const bBlock = isBlockingDecisionRequirement(b) ? 0 : 1;
    if (aBlock !== bBlock) return aBlock - bBlock;
    return a.updatedAt - b.updatedAt;
  });
  if (pending.length > 0) return pending[0]!.id;
  const active = items.find((i) => i.stage !== "done" && i.stage !== "cancelled");
  if (active) return active.id;
  return items[0]!.id;
}

export interface SortableProjectLike {
  id: string;
  name: string;
  nodeId?: string;
  nodeName?: string;
  addedAt: number;
  lastOpenedAt: number;
  activeCount: number;
  decisionCount: number;
  runningCount: number;
  pinned?: boolean;
  category?: string;
}

export interface ProjectGroupSection<T extends SortableProjectLike> {
  key: string;
  label: string;
  projects: T[];
}

export function sortHubProjects<T extends SortableProjectLike>(
  projects: readonly T[],
  sortMode: ProjectSortMode,
  recentOrder?: ReadonlyMap<string, number>,
): T[] {
  const stableTieBreak = (a: T, b: T) =>
    a.name.localeCompare(b.name, "zh-CN") || a.addedAt - b.addedAt || a.id.localeCompare(b.id);

  return [...projects].sort((a, b) => {
    const aPin = a.pinned ? 1 : 0;
    const bPin = b.pinned ? 1 : 0;
    if (aPin !== bPin) return bPin - aPin;
    switch (sortMode) {
      case "attention": {
        if (a.decisionCount !== b.decisionCount) return b.decisionCount - a.decisionCount;
        if (a.runningCount !== b.runningCount) return b.runningCount - a.runningCount;
        if (a.activeCount !== b.activeCount) return b.activeCount - a.activeCount;
        return stableTieBreak(a, b);
      }
      case "recent": {
        const aTime = recentOrder?.get(a.id) ?? a.lastOpenedAt;
        const bTime = recentOrder?.get(b.id) ?? b.lastOpenedAt;
        return bTime - aTime || stableTieBreak(a, b);
      }
      case "name":
        return stableTieBreak(a, b);
      case "added":
        return b.addedAt - a.addedAt || stableTieBreak(a, b);
    }
  });
}

export function groupHubProjects<T extends SortableProjectLike>(
  projects: readonly T[],
  groupMode: ProjectGroupMode,
  sortMode: ProjectSortMode,
  language: UiLanguage = "zh-CN",
  recentOrder?: ReadonlyMap<string, number>,
): ProjectGroupSection<T>[] {
  const sorted = sortHubProjects(projects, sortMode, recentOrder);
  if (groupMode === "none" || sorted.length === 0) {
    return [{ key: "all", label: "", projects: sorted }];
  }
  if (groupMode === "node") {
    const local: T[] = [];
    const byNode = new Map<string, { label: string; list: T[] }>();
    for (const p of sorted) {
      const isRemote = Boolean(p.nodeId && p.nodeId !== "local");
      if (!isRemote) {
        local.push(p);
      } else {
        const key = p.nodeId!;
        let entry = byNode.get(key);
        if (!entry) {
          entry = { label: p.nodeName ?? key, list: [] };
          byNode.set(key, entry);
        }
        entry.list.push(p);
      }
    }
    const sections: ProjectGroupSection<T>[] = [];
    if (local.length > 0) {
      sections.push({ key: "node:local", label: t(language, "sidebar.group.local"), projects: local });
    }
    for (const [nodeId, entry] of byNode.entries()) {
      sections.push({ key: `node:${nodeId}`, label: entry.label, projects: entry.list });
    }
    return sections;
  }
  if (groupMode === "status") {
    const active: T[] = [];
    const idle: T[] = [];
    for (const p of sorted) {
      if (p.decisionCount > 0 || p.runningCount > 0 || p.activeCount > 0) active.push(p);
      else idle.push(p);
    }
    const sections: ProjectGroupSection<T>[] = [];
    if (active.length > 0) {
      sections.push({ key: "status:active", label: t(language, "sidebar.group.active"), projects: active });
    }
    if (idle.length > 0) {
      sections.push({ key: "status:idle", label: t(language, "sidebar.group.idle"), projects: idle });
    }
    return sections;
  }
  // groupMode === "category"
  const byCat = new Map<string, T[]>();
  const uncategorized: T[] = [];
  for (const p of sorted) {
    const cat = p.category?.trim() ?? "";
    if (!cat) {
      uncategorized.push(p);
    } else {
      const list = byCat.get(cat) ?? [];
      list.push(p);
      byCat.set(cat, list);
    }
  }
  const sections: ProjectGroupSection<T>[] = [];
  for (const [cat, list] of Array.from(byCat.entries()).sort((a, b) => a[0].localeCompare(b[0], "zh-CN"))) {
    sections.push({ key: `cat:${cat}`, label: cat, projects: list });
  }
  if (uncategorized.length > 0) {
    sections.push({
      key: "cat:__none__",
      label: t(language, "sidebar.group.uncategorized"),
      projects: uncategorized,
    });
  }
  return sections;
}

/** 去除与阶段徽章重复的进度文本，仅保留增量信息。 */
export function progressDetail(item: RequirementSummary, language: UiLanguage = "zh-CN"): string {
  switch (item.stage) {
    case "planning":
      return item.designVersion > 0
        ? t(language, "progress.designVersion", { version: item.designVersion })
        : "";
    case "coding":
      return item.requiredTotal > 0
        ? t(language, "progress.verify", { passed: item.requiredPassed, total: item.requiredTotal })
        : "";
    case "done":
    case "cancelled":
      return "";
  }
}

export function defaultActionForRequirement(d: RequirementDetail): AgentAction {
  const act = d.validity.banner.primaryAction?.id;
  if (act === "dispatch_fix" || act === "dispatch_fix_review" || act === "escalate_sota") return "fix";
  if (act === "dispatch_review") return "review";
  if (act === "dispatch_implement" || act === "approve_and_implement") return "implement";
  if (d.validity.acceptanceGate.ok) return "review";
  if (d.state.stage === "coding") return "implement";
  return "design";
}

export function formatReviewFixFeedback(report: ReviewReport, selectedFindingIds?: string[]): string {
  const lines: string[] = [
    `请根据跨模型 Code Review（${report.reviewerHarness}/${report.reviewerModel} · ${report.verdict}）的问题进行修复：`,
    `核心结论：${report.summary}`,
  ];
  const findings = report.findings ?? [];
  const chosen =
    selectedFindingIds && selectedFindingIds.length > 0
      ? findings.filter((f) => selectedFindingIds.includes(f.id))
      : findings;
  if (chosen.length > 0) {
    lines.push("", "待修复审查项：");
    for (const f of chosen) {
      const crit = f.criterionIds?.length ? ` [${f.criterionIds.join(", ")}]` : "";
      const files = f.files?.length ? ` (${f.files.join(", ")})` : "";
      lines.push(`- [${f.severity}] ${f.id} ${f.title}${crit}${files}`);
      if (f.suggestion) lines.push(`  修复建议：${f.suggestion}`);
    }
  } else if (report.markdown.trim()) {
    lines.push("", "审查详情摘要：", report.markdown.trim().slice(0, 1400));
  }
  return lines.join("\n").slice(0, 1950);
}

export function canDirectApproveWithDecisions(state: Pick<RequirementDetail["state"], "pendingDecisions" | "criteria">): {
  allowed: boolean;
  reason: string | null;
  reasonKey?: string;
} {
  const pending = state.pendingDecisions ?? [];
  if (pending.length > 0) {
    for (const item of pending) {
      if (item.customAnswer && item.customAnswer.trim().length > 0) {
        return {
          allowed: false,
          reason: `决策 ${item.id} 包含自定义输入，需先提交决策并修订方案后再批准`,
          reasonKey: "decisions.directBlockedCustom",
        };
      }
      const validPreset =
        Boolean(item.selectedOptionId) &&
        item.options.some((opt) => opt.id === item.selectedOptionId);
      if (!validPreset) {
        return {
          allowed: false,
          reason: `仍有未作答的待拍板决策（${item.id}），请先完成选择`,
          reasonKey: "decisions.directBlockedUnanswered",
        };
      }
    }
  }
  const hasRequiredCriterion = state.criteria.some((c) => c.required);
  if (!hasRequiredCriterion) {
    return {
      allowed: false,
      reason: "尚未定义必需验收条件，请先修订方案补齐验收条件后再批准",
      reasonKey: "decisions.directBlockedNoCriteria",
    };
  }
  return { allowed: true, reason: null };
}

export function routedTargetForAction(
  routing: RoutingConfig | null,
  action: AgentAction,
  tier: RequirementTier = "standard",
): ModelTarget | null {
  if (!routing) return null;
  if (action === "review") return routing.reviewer?.primary ?? null;
  return (tier === "sota" ? routing.sotaLead?.primary : routing.defaultLead?.primary) ?? null;
}

export function parseRunnerKey(key: string): { harness: string; model: string } | null {
  const sepIdx = key.indexOf("::");
  if (sepIdx <= 0) return null;
  const harness = key.slice(0, sepIdx);
  const model = key.slice(sepIdx + 2);
  return harness && model ? { harness, model } : null;
}

export function activeRunnerChoice(
  selectedRunnerKey: string,
  routing: RoutingConfig | null,
  action: AgentAction,
  selectedEffort?: ReasoningEffort | "",
  tier: RequirementTier = "standard",
): { harness?: string; model?: string; effort?: ReasoningEffort } {
  if (selectedRunnerKey) {
    const parsed = parseRunnerKey(selectedRunnerKey);
    if (parsed) {
      return { harness: parsed.harness, model: parsed.model, ...(selectedEffort ? { effort: selectedEffort } : {}) };
    }
  }
  const primary = routedTargetForAction(routing, action, tier);
  const effort = selectedEffort || primary?.reasoningEffort;
  return primary ? { harness: primary.harness, model: primary.model, ...(effort ? { effort } : {}) } : {};
}

export interface ModelEffortCapability {
  mode: "configurable" | "locked" | "unsupported";
  efforts: ReasoningEffort[];
  defaultEffort?: ReasoningEffort;
}

export function getModelEffortCapability(
  harnesses: HarnessInfo[],
  harnessId?: string,
  modelId?: string,
): ModelEffortCapability {
  if (!harnessId || !modelId) {
    return { mode: "configurable", efforts: ["low", "medium", "high", "xhigh"] };
  }
  const h = harnesses.find((x) => x.id === harnessId);
  const exact = h?.models.find((x) => x.id === modelId);
  if (exact) {
    if (exact.effortLocked) {
      const lockedEff = exact.defaultEffort ?? exact.supportedEfforts?.[0];
      return {
        mode: "locked",
        efforts: lockedEff ? [lockedEff] : [],
        defaultEffort: lockedEff,
      };
    }
    if (exact.supportedEfforts !== undefined) {
      if (exact.supportedEfforts.length === 0) {
        return { mode: "unsupported", efforts: [] };
      }
      if (exact.supportedEfforts.length === 1) {
        return {
          mode: "locked",
          efforts: exact.supportedEfforts,
          defaultEffort: exact.defaultEffort ?? exact.supportedEfforts[0],
        };
      }
      return {
        mode: "configurable",
        efforts: exact.supportedEfforts,
        defaultEffort: exact.defaultEffort,
      };
    }
  } else if (h) {
    for (const candidate of h.models) {
      if (!candidate.effortVariants) continue;
      for (const [eff, variantId] of Object.entries(candidate.effortVariants) as Array<[ReasoningEffort, string]>) {
        if (variantId === modelId) {
          return {
            mode: "locked",
            efforts: [eff],
            defaultEffort: eff,
          };
        }
      }
    }
  }

  if (harnessId === "codex" || harnessId === "agy" || harnessId === "qodercn") {
    return { mode: "configurable", efforts: ["low", "medium", "high", "xhigh", "max"] };
  }
  if (harnessId === "omp") {
    return { mode: "configurable", efforts: ["minimal", "low", "medium", "high", "xhigh", "max", "auto"] };
  }
  if (harnessId === "opencode") {
    return { mode: "configurable", efforts: ["low", "medium", "high"] };
  }
  return { mode: "configurable", efforts: [...REASONING_EFFORTS] };
}

export function supportedEffortsForModel(
  harnesses: HarnessInfo[],
  harnessId?: string,
  modelId?: string,
): ReasoningEffort[] {
  return getModelEffortCapability(harnesses, harnessId, modelId).efforts;
}

export interface RunnerModelOption {
  key: string;
  label: string;
  harnessId: string;
  harnessLabel: string;
  modelId: string;
  displayLabel: string;
  tier: DiscoveredModel["tier"] | "custom";
  provider?: string;
  intelligence?: number;
  isLegacy?: boolean;
  /** 配置弹窗中标记尚未真实探测验证的模型 */
  unverified?: boolean;
  /** 配置弹窗中保留的、不在当前 Harness 列表内的已配置模型 */
  preserved?: boolean;
}

export interface RunnerModelGroup {
  key: string;
  label: string;
  items: RunnerModelOption[];
}

export interface RunnerModelSections {
  favorites: RunnerModelOption[];
  groups: RunnerModelGroup[];
}

export function runnerModelSearchText(option: RunnerModelOption): string {
  return [
    option.harnessId,
    option.harnessLabel,
    option.modelId,
    option.displayLabel,
    option.provider ?? "",
    option.unverified ? "未验证 unverified" : "",
    option.preserved ? "保留 preserved" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function matchesModelQuery(text: string, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;
  const haystack = text.toLowerCase();
  if (haystack.includes(trimmed)) return true;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((token) => haystack.includes(token))) return true;
  const compactQuery = trimmed.replace(/\s+/g, "");
  let qi = 0;
  for (let i = 0; i < haystack.length && qi < compactQuery.length; i += 1) {
    if (haystack[i] === compactQuery[qi]) qi += 1;
  }
  return qi === compactQuery.length;
}

export function filterRunnerModelOptions(
  options: RunnerModelOption[],
  query: string,
): RunnerModelOption[] {
  const trimmed = query.trim();
  if (!trimmed) return options;
  return options.filter((option) => matchesModelQuery(runnerModelSearchText(option), trimmed));
}

export function collectModelOptions(harnesses: HarnessInfo[]): RunnerModelOption[] {
  const opts: RunnerModelOption[] = [];
  for (const h of harnesses) {
    if (!h.installed) continue;
    for (const m of h.models) {
      opts.push({
        key: `${h.id}::${m.id}`,
        label: `${h.label} · ${m.id}`,
        harnessId: h.id,
        harnessLabel: h.label,
        modelId: m.id,
        displayLabel: m.label ?? m.id,
        tier: m.tier,
        ...(m.provider ? { provider: m.provider } : {}),
        ...(typeof m.intelligence === "number" ? { intelligence: m.intelligence } : {}),
        ...(m.isLegacy ? { isLegacy: true } : {}),
      });
    }
  }
  return opts;
}

/**
 * 配置弹窗入口的模型列表：包含未安装 Harness，并保留不在列表中的当前配置值。
 * 收藏只移动展示位置，不会凭收藏记录凭空生成这里没有的选项。
 */
export function collectRoutingModelOptions(
  harnesses: HarnessInfo[],
  currentKey?: string,
  language: UiLanguage = "zh-CN",
): RunnerModelOption[] {
  const opts: RunnerModelOption[] = [];
  for (const h of harnesses) {
    const harnessLabel = `${h.label} (${h.installed ? h.subscription : t(language, "common.uninstalled")})`;
    for (const m of h.models) {
      opts.push({
        key: `${h.id}::${m.id}`,
        label: `${h.id} · ${m.id}`,
        harnessId: h.id,
        harnessLabel,
        modelId: m.id,
        displayLabel: m.label ?? m.id,
        tier: m.tier,
        ...(m.provider ? { provider: m.provider } : {}),
        ...(m.source === "builtin" ? { unverified: true } : {}),
      });
    }
  }
  if (currentKey && !opts.some((option) => option.key === currentKey)) {
    const parsed = parseRunnerKey(currentKey);
    if (parsed) {
      opts.push({
        key: currentKey,
        label: `${parsed.harness} · ${parsed.model}`,
        harnessId: parsed.harness,
        harnessLabel: `${parsed.harness} (${t(language, "routing.preservedConfig")})`,
        modelId: parsed.model,
        displayLabel: parsed.model,
        tier: "custom",
        preserved: true,
      });
    }
  }
  return opts;
}

export function groupRunnerModelOptions(options: RunnerModelOption[]): RunnerModelGroup[] {
  const groups = new Map<string, RunnerModelGroup>();
  for (const option of options) {
    let group = groups.get(option.harnessId);
    if (!group) {
      group = { key: option.harnessId, label: option.harnessLabel, items: [] };
      groups.set(option.harnessId, group);
    }
    group.items.push(option);
  }
  return Array.from(groups.values());
}

/** 将收藏项提取到独立分组并保持各自原有顺序；未收藏项按 Harness 分组，收藏项不再重复出现。 */
export function splitFavoriteRunnerModelOptions(
  options: RunnerModelOption[],
  favorites: Iterable<string>,
): RunnerModelSections {
  const favoriteSet = favorites instanceof Set ? favorites : new Set(favorites);
  const favoriteItems: RunnerModelOption[] = [];
  const ordinary: RunnerModelOption[] = [];
  for (const option of options) {
    if (favoriteSet.has(option.key)) favoriteItems.push(option);
    else ordinary.push(option);
  }
  return { favorites: favoriteItems, groups: groupRunnerModelOptions(ordinary) };
}

export function formatDurationHuman(ms: number | undefined | null): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m`;
}

export function formatTokenCount(n: number | undefined | null): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatUsd(n: number | undefined | null): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function formatPercent(ratio: number | undefined | null): string {
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio <= 0) return "0%";
  return `${Math.round(Math.min(1, ratio) * 100)}%`;
}

export function formatBytes(bytes: number | undefined | null): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
