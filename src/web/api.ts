import type {
  AgentAction,
  AgentRunRecord,
  AttachmentMeta,
  CascadeSyncItemResult,
  CriterionInput,
  DeliveryPreview,
  DeliveryRecord,
  DiscussionEntry,
  GitRemoteProvider,
  MergeOrderRecommendation,
  OutputLanguage,
  PrivacyMode,
  ProjectGiteeConfig,
  ProjectGitHubConfig,
  ProjectMetadata,
  ProjectVerificationConfig,
  ProjectWorktreeConfig,
  RequirementDetail,
  RequirementDiffView,
  RequirementGitHubLink,
  RequirementGitHubPrLink,
  RequirementKind,
  RequirementSummary,
  RequirementTier,
  RunContextSnapshot,
  RunTraceEvent,
  SandboxDriftInfo,
  ScreenshotCaptureResult,
  ScreenshotPhase,
  Stage,
  Track,
  VerificationRecord,
} from "../core/types.ts";
import type { ProjectContextSummary } from "../core/context.ts";
import type { StructuredMessageRef } from "../core/errors.ts";
import type { GitObservation } from "../core/git.ts";
import type { GiteeEnvironmentStatus, GiteeIssueFilter, GiteeIssueItem } from "../core/gitee.ts";
import type { GitHubEnvironmentStatus, ImportedGitHubIssue } from "../core/github.ts";
import type { SandboxRecord } from "../core/sandbox.ts";
import type { InsightsQueryFilter, InsightsResponse } from "../hub/ledger.ts";
import type { ModelStageStats } from "../hub/telemetry.ts";
import type {
  BrowseEntry,
  HarnessInfo,
  HubObservabilityConfig,
  HubProjectEntry,
  ModelTarget,
  NodeUpdateStatus,
  RemoteNodeInfo,
  RoutingConfig,
} from "../hub/types.ts";

export type { InsightsDiagnostic, InsightsQueryFilter, InsightsResponse, RunLedgerEntry } from "../hub/ledger.ts";

export interface RunTraceResponse {
  runId: string;
  live: boolean;
  hasTrace: boolean;
  record: AgentRunRecord;
  events: RunTraceEvent[];
  nextSeq: number;
  totalEvents: number;
  hasMore: boolean;
}

export interface RunContextResponse {
  runId: string;
  hasContext: boolean;
  context: RunContextSnapshot | null;
}

export interface HubPricingResponse {
  observability: HubObservabilityConfig;
  quotaPoolLabels: Record<string, string>;
}

export interface PruneTracesResult {
  deletedFiles: number;
  freedBytes: number;
  scannedRuns: number;
  projectsPruned?: number;
  retentionDays?: number;
}

export interface GiteeIssueListItem extends GiteeIssueItem {
  importedRequirementId: string | null;
}

export interface ProjectInfoResponse {
  initialized: boolean;
  project: ProjectMetadata | null;
  routing?: RoutingConfig | null;
  root: string;
  effectiveOutputLanguage?: "zh-CN" | "en";
  remoteProvider?: GitRemoteProvider | null;
  remoteRepo?: string | null;
  context?: ProjectContextSummary;
  git: { isGitRepo: boolean; head?: string; dirty?: boolean; fingerprint?: string | null };
}

export interface HubProjectSummary extends HubProjectEntry {
  nodeOnline?: boolean;
  initialized: boolean;
  isGitRepo: boolean;
  activeCount: number;
  decisionCount: number;
  runningCount: number;
  routing?: RoutingConfig | null;
}

export interface HubStateResponse {
  hubMode: boolean;
  activeProjectId: string | null;
  activeNodeId?: string;
  projects: HubProjectSummary[];
  nodes?: RemoteNodeInfo[];
  harnesses: HarnessInfo[];
  routing: RoutingConfig | null;
  outputLanguage?: OutputLanguage;
  giteeTokenConfigured?: boolean;
  giteeTokenMasked?: string | null;
  activeRuns: Array<AgentRunRecord & { requirementId: string; root?: string; projectId?: string }>;
  cooldownCount?: number;
}

export interface ProjectSandboxItem extends SandboxRecord {
  stage?: Stage | null;
  title?: string;
  canApply?: boolean;
  github?: RequirementGitHubLink | null;
  drift?: SandboxDriftInfo | null;
}

export interface ProjectSandboxesResponse {
  sandboxes: ProjectSandboxItem[];
  mergeOrder: MergeOrderRecommendation | null;
}

export interface TelemetrySummaryResponse {
  entries: ModelStageStats[];
  activeCooldowns: Array<{ harness: string; model: string; until: number }>;
}

export interface BrowseResponse {
  currentPath: string;
  parentPath: string | null;
  isGitRepo: boolean;
  workbenchInitialized: boolean;
  entries: BrowseEntry[];
}

export class ApiClientError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

let activeProjectScope: string | null = null;

export function setApiProjectScope(projectId: string | null): void {
  activeProjectScope = projectId;
}

export function withProjectParam(url: string, explicitProjectId?: string | null): string {
  const pid = explicitProjectId !== undefined ? explicitProjectId : activeProjectScope;
  if (!pid || pid === "default") return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}project=${encodeURIComponent(pid)}`;
}

/** Builds the immutable PNG evidence URL used by thumbnail grids and the lightbox. */
export function screenshotUrl(requirementId: string, shotId: string): string {
  return withProjectParam(
    `/api/requirements/${encodeURIComponent(requirementId)}/screenshots/${encodeURIComponent(shotId)}`,
  );
}

export function requirementAttachmentUrl(requirementId: string, attachmentId: string): string {
  return withProjectParam(
    `/api/requirements/${encodeURIComponent(requirementId)}/attachments/${encodeURIComponent(attachmentId)}`,
  );
}

async function requestForm<T>(url: string, form: FormData): Promise<T> {
  const resp = await fetch(url, { method: "POST", body: form });
  const data = (await resp.json()) as Record<string, unknown>;
  if (!resp.ok) {
    const err = data.error as { code?: string; message?: string; details?: Record<string, unknown> } | undefined;
    if (resp.status === 401 && err?.code === "unauthorized" && typeof window !== "undefined") {
      window.dispatchEvent(new Event("wb:unauthorized"));
    }
    throw new ApiClientError(err?.code ?? "request_failed", err?.message ?? `HTTP ${resp.status}`, err?.details);
  }
  return data as T;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await resp.json()) as Record<string, unknown>;
  if (!resp.ok) {
    const err = data.error as { code?: string; message?: string; details?: Record<string, unknown> } | undefined;
    if (resp.status === 401 && err?.code === "unauthorized" && typeof window !== "undefined") {
      window.dispatchEvent(new Event("wb:unauthorized"));
    }
    throw new ApiClientError(err?.code ?? "request_failed", err?.message ?? `HTTP ${resp.status}`, err?.details);
  }
  return data as T;
}

export const api = {
  authStatus: () => requestJson<{ required: boolean; authenticated: boolean }>("/api/auth/status"),
  login: (password: string) =>
    requestJson<{ authenticated: boolean }>("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => requestJson<{ authenticated: boolean }>("/api/auth/logout", { method: "POST" }),
  getHubState: () => requestJson<HubStateResponse>("/api/hub/state"),
  updateNode: ({ nodeId, revision }: { nodeId: string; revision: string }) =>
    requestJson<NodeUpdateStatus>(`/api/hub/nodes/${encodeURIComponent(nodeId)}/update`, { method: "POST", body: JSON.stringify({ revision }) }),
  addHubProject: (input: { root: string; name?: string; initPrivacy?: PrivacyMode; activate?: boolean; nodeId?: string }) =>
    requestJson<{ project: HubProjectEntry; activeProjectId: string | null; projects: HubProjectSummary[] }>("/api/hub/projects", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  activateHubProject: (projectId: string) =>
    requestJson<{ project: HubProjectEntry; activeProjectId: string }>(
      `/api/hub/projects/${encodeURIComponent(projectId)}/activate?summary=0`,
      { method: "POST" },
    ),
  updateHubProjectMeta: (body: { projectId: string; pinned?: boolean; category?: string | null }) =>
    requestJson<{ ok: boolean }>("/api/hub/projects/meta", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  removeHubProject: (projectId: string) =>
    requestJson<{ activeProjectId: string | null; projects: HubProjectSummary[] }>(
      `/api/hub/projects/${encodeURIComponent(projectId)}`,
      { method: "DELETE" },
    ),
  browseFs: (targetPath?: string, nodeId?: string) => {
    const params = new URLSearchParams();
    if (targetPath) params.set("path", targetPath);
    if (nodeId && nodeId !== "local") params.set("node", nodeId);
    const qs = params.toString();
    return requestJson<BrowseResponse>(qs ? `/api/fs/browse?${qs}` : "/api/fs/browse");
  },
  refreshHarnesses: (nodeId?: string) => {
    const qs = nodeId && nodeId !== "local" ? `?node=${encodeURIComponent(nodeId)}` : "";
    return requestJson<{ harnesses: HarnessInfo[] }>(`/api/hub/harnesses/refresh${qs}`, { method: "POST" });
  },
  saveRouting: (routing: RoutingConfig) =>
    requestJson<{ routing: RoutingConfig }>(withProjectParam("/api/project/routing"), {
      method: "PUT",
      body: JSON.stringify(routing),
    }),
  updateHubPreferences: (input: { outputLanguage?: OutputLanguage; giteeAccessToken?: string | null }) =>
    requestJson<{
      outputLanguage: OutputLanguage;
      giteeTokenConfigured?: boolean;
      giteeTokenMasked?: string | null;
    }>("/api/hub/preferences", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  uploadAttachments: (files: File[], scope: "project" | "hub" = "project") => {
    const form = new FormData();
    for (const file of files) form.append("files", file, file.name);
    const endpoint = scope === "hub" ? "/api/uploads?scope=hub" : withProjectParam("/api/uploads");
    return requestForm<{ attachments: AttachmentMeta[] }>(endpoint, form);
  },
  clearModelCooldown: (harness?: string, model?: string) =>
    requestJson<{ telemetry: TelemetrySummaryResponse }>("/api/hub/telemetry/clear-cooldown", {
      method: "POST",
      body: JSON.stringify({ harness, model }),
    }),
  getHubInsights: (filter: InsightsQueryFilter = {}) => {
    const qs = new URLSearchParams();
    if (filter.days !== undefined) qs.set("days", String(filter.days));
    if (filter.projectId) qs.set("projectId", filter.projectId);
    if (filter.nodeId) qs.set("nodeId", filter.nodeId);
    if (filter.quotaPool) qs.set("quotaPool", filter.quotaPool);
    if (filter.harness) qs.set("harness", filter.harness);
    if (filter.action) qs.set("action", filter.action);
    if (filter.billingMode) qs.set("billingMode", filter.billingMode);
    if (filter.status) qs.set("status", filter.status);
    const query = qs.toString();
    return requestJson<InsightsResponse>(query ? `/api/hub/insights?${query}` : "/api/hub/insights");
  },
  getHubPricing: () => requestJson<HubPricingResponse>("/api/hub/insights/pricing"),
  updateHubPricing: (patch: HubObservabilityConfig) =>
    requestJson<{ observability: HubObservabilityConfig }>("/api/hub/insights/pricing", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  pruneHubRunTraces: (retentionDays?: number) =>
    requestJson<PruneTracesResult>("/api/hub/insights/prune", {
      method: "POST",
      body: JSON.stringify({ ...(retentionDays !== undefined ? { retentionDays } : {}) }),
    }),
  reloadWebBundle: () => requestJson<{ ok: boolean; reloaded: boolean }>("/api/hub/reload-web", { method: "POST" }),

  getProject: (projectId: string | null) => requestJson<ProjectInfoResponse>(withProjectParam("/api/project", projectId)),
  initProject: (input: { name?: string; privacyMode: PrivacyMode; outputLanguage?: OutputLanguage }) =>
    requestJson<{ initialized: boolean; project: ProjectMetadata }>(withProjectParam("/api/project/init"), {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateProjectSettings: (input: {
    name?: string;
    outputLanguage?: OutputLanguage | "inherit" | null;
    routing?: RoutingConfig | null;
    github?: ProjectGitHubConfig | null;
    gitee?: ProjectGiteeConfig | null;
    verification?: ProjectVerificationConfig | null;
    worktree?: ProjectWorktreeConfig | null;
  }) =>
    requestJson<{ project: ProjectMetadata }>(withProjectParam("/api/project/settings"), {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  getGitHubStatus: (projectId: string | null) =>
    requestJson<GitHubEnvironmentStatus>(withProjectParam("/api/github/status", projectId)),
  getGiteeStatus: (projectId: string | null) =>
    requestJson<GiteeEnvironmentStatus>(withProjectParam("/api/gitee/status", projectId)),
  listGiteeIssues: (projectId: string | null, params?: {
    filter?: GiteeIssueFilter;
    state?: "active" | "open" | "progressing" | "closed" | "all";
    q?: string;
    enterprise?: string;
  }) => {
    const qs = new URLSearchParams();
    if (params?.filter) qs.set("filter", params.filter);
    if (params?.state) qs.set("state", params.state);
    if (params?.q?.trim()) qs.set("q", params.q.trim());
    if (params?.enterprise?.trim()) qs.set("enterprise", params.enterprise.trim());
    const suffix = qs.toString();
    return requestJson<{ account: string; enterprise: string | null; items: GiteeIssueListItem[] }>(
      withProjectParam(suffix ? `/api/gitee/issues?${suffix}` : "/api/gitee/issues", projectId),
    );
  },
  getProjectSandboxes: (projectId: string | null, fetchRemote = false) =>
    requestJson<ProjectSandboxesResponse>(
      withProjectParam(fetchRemote ? "/api/project/sandboxes?fetch=1" : "/api/project/sandboxes", projectId),
    ),
  createRequirementSandbox: (
    id: string,
    input?: { branchPrefix?: "rsi" | "feat"; branchName?: string; stackedOnReqId?: string },
  ) =>
    requestJson<{ sandbox: SandboxRecord; detail: RequirementDetail; sandboxDrift?: SandboxDriftInfo | null }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/sandbox`),
      { method: "POST", body: JSON.stringify(input ?? {}) },
    ),
  retryOrIgnoreSandboxSetup: (id: string, action: "retry" | "ignore") =>
    requestJson<{ sandbox: SandboxRecord; detail: RequirementDetail }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/sandbox/setup`),
      { method: "POST", body: JSON.stringify({ action }) },
    ),
  syncSandboxBase: (id: string, input?: { fetchRemote?: boolean }) =>
    requestJson<{
      synced: boolean;
      upToDate: boolean;
      conflictFiles: string[];
      drift: SandboxDriftInfo;
      detail: RequirementDetail;
    }>(withProjectParam(`/api/requirements/${encodeURIComponent(id)}/sync-base`), {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    }),
  applySandbox: (id: string) =>
    requestJson<{
      appliedFiles: string[];
      deletedFiles: string[];
      touchesWeb: boolean;
      touchesBackend: boolean;
      webReloaded: boolean;
      restartRecommended: boolean;
      cascadeResults?: CascadeSyncItemResult[];
    }>(withProjectParam(`/api/requirements/${encodeURIComponent(id)}/apply-sandbox`), {
      method: "POST",
    }),
  syncResolveSandbox: (
    id: string,
    input: {
      approveFirst?: boolean;
      expectedRevision?: number;
      harness?: string;
      model?: string;
      reasoningEffort?: ModelTarget["reasoningEffort"];
      message?: string;
    },
  ) =>
    requestJson<{
      detail: RequirementDetail;
      run?: AgentRunRecord;
      target?: ModelTarget;
    }>(withProjectParam(`/api/requirements/${encodeURIComponent(id)}/sync-resolve`), {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listRequirements: (projectId: string | null, scope: "active" | "done" | "cancelled" | "all") =>
    requestJson<{ items: RequirementSummary[]; codeSnapshotHash: string | null }>(
      withProjectParam(`/api/requirements?scope=${encodeURIComponent(scope)}`, projectId),
    ),
  createRequirement: (input: {
    goal: string;
    title?: string;
    parentId?: string;
    kind?: RequirementKind;
    tier?: RequirementTier;
    startImmediately?: boolean;
    createGitHubIssue?: boolean;
    createSandbox?: boolean;
    stackedOnReqId?: string;
    attachmentIds?: string[];
  }) =>
    requestJson<{
      detail: RequirementDetail;
      sandbox?: SandboxRecord | null;
      githubWarning?: string;
      githubWarningRef?: StructuredMessageRef;
    }>(
      withProjectParam("/api/requirements"),
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  spawnSubRequirements: (
    id: string,
    input?: { items?: Array<{ title: string; goal?: string; track?: Track }>; track?: Track },
  ) =>
    requestJson<{ parent: RequirementDetail; created: RequirementDetail[] }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/spawn`),
      { method: "POST", body: JSON.stringify(input ?? {}) },
    ),
  importGitHubIssue: (input: {
    issueRef?: string;
    provider?: GitRemoteProvider;
    giteeIssue?: GiteeIssueItem;
    enterprise?: string;
  }) =>
    requestJson<{
      detail: RequirementDetail;
      alreadyExisted: boolean;
      issue: ImportedGitHubIssue | GiteeIssueItem;
      provider?: GitRemoteProvider;
    }>(withProjectParam("/api/requirements/import-issue"), {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getRequirement: (projectId: string | null, id: string) =>
    requestJson<{
      detail: RequirementDetail;
      codeSnapshotHash: string | null;
      sandbox?: SandboxRecord | null;
      sandboxDrift?: SandboxDriftInfo | null;
    }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}`, projectId),
    ),
  getDiff: (projectId: string | null, id: string, options: { live?: boolean } = {}) =>
    requestJson<RequirementDiffView & { changes: GitObservation | null }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/diff${options.live ? "?live=1" : ""}`, projectId),
    ),
  getDesignHistory: (id: string, version: number) =>
    requestJson<{ version: number; markdown: string }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/history/${version}`),
    ),
  addRequirementAttachments: (id: string, input: { attachmentIds: string[]; expectedRevision?: number }) =>
    requestJson<{ detail: RequirementDetail }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/attachments`),
      { method: "POST", body: JSON.stringify(input) },
    ),
  deleteRequirementAttachment: (id: string, attachmentId: string) =>
    requestJson<{ detail: RequirementDetail }>(
      withProjectParam(
        `/api/requirements/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`,
      ),
      { method: "DELETE" },
    ),
  getEvidence: (id: string, verificationId: string) =>
    requestJson<{ record: VerificationRecord; log: string }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/evidence/${encodeURIComponent(verificationId)}`),
    ),
  captureScreenshots: (id: string, label?: string) =>
    requestJson<{ detail: RequirementDetail; screenshotCapture: ScreenshotCaptureResult }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/screenshots/capture`),
      { method: "POST", body: JSON.stringify({ ...(label?.trim() ? { label: label.trim() } : {}) }) },
    ),
  attachScenarioScreenshots: (
    id: string,
    shots: Array<{
      dataBase64: string;
      label: string;
      description?: string;
      phase?: ScreenshotPhase;
      viewport?: string;
      theme?: "light" | "dark";
      urlPath?: string;
      criterionIds?: string[];
    }>,
  ) =>
    requestJson<{ detail: RequirementDetail; screenshotCapture: ScreenshotCaptureResult }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/screenshots/attach`),
      { method: "POST", body: JSON.stringify({ shots }) },
    ),
  getHandoff: (id: string) =>
    requestJson<{ markdown: string; detail: RequirementDetail }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/handoff`),
    ),
  updateSpec: (
    id: string,
    input: { title?: string; specMarkdown?: string; criteria?: CriterionInput[]; expectedRevision?: number },
  ) =>
    requestJson<{ detail: RequirementDetail }>(withProjectParam(`/api/requirements/${encodeURIComponent(id)}/spec`), {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  updateDesign: (id: string, input: { designMarkdown: string; expectedRevision?: number }) =>
    requestJson<{ detail: RequirementDetail }>(withProjectParam(`/api/requirements/${encodeURIComponent(id)}/design`), {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  setRequirementTier: (
    id: string,
    input: { tier: RequirementTier; expectedRevision?: number; reason?: string; dispatchFix?: boolean },
  ) =>
    requestJson<{ detail: RequirementDetail; run?: AgentRunRecord; target?: ModelTarget }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/tier`),
      { method: "PATCH", body: JSON.stringify(input) },
    ),
  addDiscussion: (
    id: string,
    input: {
      mode: "ask" | "refine";
      kind?: DiscussionEntry["kind"];
      anchor?: string;
      message: string;
      resolved?: boolean;
    },
  ) =>
    requestJson<{ detail: RequirementDetail; entry: DiscussionEntry }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/discussions`),
      { method: "POST", body: JSON.stringify(input) },
    ),
  resolveDiscussions: (id: string, input: { ids?: string[]; resolved?: boolean; adopted?: boolean }) =>
    requestJson<{ detail: RequirementDetail }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/discussions/resolve`),
      { method: "POST", body: JSON.stringify(input) },
    ),
  deleteDiscussion: (id: string, discId: string) =>
    requestJson<{ detail: RequirementDetail }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/discussions/${encodeURIComponent(discId)}`),
      { method: "DELETE" },
    ),
  startAgentRun: (
    id: string,
    input: {
      action: AgentAction;
      harness?: string;
      model?: string;
      reasoningEffort?: ModelTarget["reasoningEffort"];
      message?: string;
      anchor?: string;
      anchorIds?: string[];
      adoptDiscussionId?: string;
      mode?: "ask" | "refine";
      useFallback?: boolean;
      forceFreshSession?: boolean;
      resolveConflict?: boolean;
    },
  ) =>
    requestJson<{ run: AgentRunRecord; detail: RequirementDetail; target: ModelTarget }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/run`),
      { method: "POST", body: JSON.stringify(input) },
    ),
  cancelAgentRun: (id: string, runId: string) =>
    requestJson<{ cancelled: boolean; runId: string }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/cancel`),
      { method: "POST" },
    ),
  listRequirementRuns: (projectId: string | null, id: string) =>
    requestJson<{ runs: AgentRunRecord[] }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/runs`, projectId),
    ),
  getAgentRunTrace: (id: string, runId: string, afterSeq = 0, limit = 2000) =>
    requestJson<RunTraceResponse>(
      withProjectParam(
        `/api/requirements/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/trace?afterSeq=${afterSeq}&limit=${limit}`,
      ),
    ),
  getAgentRunContext: (projectId: string | null, id: string, runId: string) =>
    requestJson<RunContextResponse>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/context`, projectId),
    ),
  pruneProjectRunTraces: (retentionDays?: number) =>
    requestJson<{ result: PruneTracesResult }>(withProjectParam("/api/project/runs/prune"), {
      method: "POST",
      body: JSON.stringify({ ...(retentionDays !== undefined ? { retentionDays } : {}) }),
    }),
  getAgentRunLog: (id: string, runId: string) =>
    requestJson<{ record: AgentRunRecord; log: string }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`),
    ),
  approve: (
    id: string,
    input: {
      expectedRevision?: number;
      note?: string;
      createSandbox?: boolean;
      stackedOnReqId?: string;
      resetSandbox?: boolean;
      decisionSelections?: Array<{ id: string; selectedOptionId?: string | null; customAnswer?: string | null }>;
    },
  ) =>
    requestJson<{ detail: RequirementDetail; sandbox?: SandboxRecord }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/approve`),
      { method: "POST", body: JSON.stringify(input) },
    ),
  setManualCheck: (
    id: string,
    input: { criterionId: string; checked: boolean; note?: string; expectedRevision?: number },
  ) =>
    requestJson<{ detail: RequirementDetail }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/manual-check`),
      { method: "POST", body: JSON.stringify(input) },
    ),
  saveDecisions: (
    id: string,
    input: {
      selections: Array<{ id: string; selectedOptionId?: string | null; customAnswer?: string | null }>;
      expectedRevision?: number;
    },
  ) =>
    requestJson<{ detail: RequirementDetail }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/decisions`),
      { method: "PATCH", body: JSON.stringify(input) },
    ),
  reviseDecisions: (
    id: string,
    input: {
      selections?: Array<{ id: string; selectedOptionId?: string | null; customAnswer?: string | null }>;
      note?: string;
      expectedRevision?: number;
      dispatchAgent?: boolean;
    },
  ) =>
    requestJson<{
      detail: RequirementDetail;
      feedback: string;
      unresolvedAnnotationIds: string[];
      run?: AgentRunRecord;
      target?: ModelTarget;
    }>(withProjectParam(`/api/requirements/${encodeURIComponent(id)}/decisions/revise`), {
      method: "POST",
      body: JSON.stringify(input),
    }),
  revisePlan: (id: string, input: { reason: string; expectedRevision?: number }) =>
    requestJson<{ detail: RequirementDetail }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/revise-plan`),
      { method: "POST", body: JSON.stringify(input) },
    ),
  mergeSandboxLocal: (
    id: string,
    input: { commitMessage?: string; note?: string; expectedRevision?: number },
  ) =>
    requestJson<{
      detail: RequirementDetail;
      delivery: DeliveryRecord;
      squashedCount: number;
      touchesWeb: boolean;
      touchesBackend: boolean;
      webReloaded: boolean;
      restartRecommended: boolean;
      cascadeResults?: CascadeSyncItemResult[];
    }>(withProjectParam(`/api/requirements/${encodeURIComponent(id)}/merge-local`), {
      method: "POST",
      body: JSON.stringify(input),
    }),
  discardSandbox: (id: string) =>
    requestJson<{ discarded: boolean; branch: string | null; detail: RequirementDetail }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/sandbox`),
      { method: "DELETE" },
    ),
  fastTrack: (id: string, input: { expectedRevision?: number; note?: string }) =>
    requestJson<{ detail: RequirementDetail }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/fast-track`),
      { method: "POST", body: JSON.stringify(input) },
    ),
  requestChanges: (
    id: string,
    input: { feedback: string; expectedRevision?: number; rememberLesson?: boolean; lessonText?: string },
  ) =>
    requestJson<{ detail: RequirementDetail }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/request-changes`),
      { method: "POST", body: JSON.stringify(input) },
    ),
  appendBugCriteria: (id: string, input: { criteria: CriterionInput[]; expectedRevision?: number }) =>
    requestJson<{ detail: RequirementDetail }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/bug-criteria`),
      { method: "POST", body: JSON.stringify(input) },
    ),
  reportBugPause: (id: string, input: { reason: string }) =>
    requestJson<{ detail: RequirementDetail }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/bug-pause`),
      { method: "POST", body: JSON.stringify(input) },
    ),
  triggerDesignReview: (id: string, input?: { harness?: string; model?: string }) =>
    requestJson<{ run: AgentRunRecord; detail: RequirementDetail; target: ModelTarget }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/design-review`),
      { method: "POST", body: JSON.stringify(input ?? {}) },
    ),
  getProjectPlaybook: () =>
    requestJson<{ markdown: string; lessons: string[]; path: string }>(withProjectParam("/api/project/playbook")),
  appendPlaybookLesson: (input: {
    lesson: string;
    source?: "reject" | "accept" | "review_block" | "manual";
    requirementId?: string;
  }) =>
    requestJson<{ added: boolean; line: string; totalLessons: number; markdown: string; path: string }>(
      withProjectParam("/api/project/playbook/lessons"),
      { method: "POST", body: JSON.stringify(input) },
    ),
  verify: (
    id: string,
    input: { command?: string; criterionIds?: string[]; all?: boolean; timeoutMs?: number },
  ) =>
    requestJson<{ detail: RequirementDetail; runs: VerificationRecord[] }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/verify`),
      { method: "POST", body: JSON.stringify(input) },
    ),
  accept: (
    id: string,
    input: {
      expectedRevision?: number;
      note?: string;
      overrideReason?: string;
      acceptedRisks?: string[];
      rememberLesson?: boolean;
      lessonText?: string;
    },
  ) =>
    requestJson<{ detail: RequirementDetail; githubSyncWarning?: string; githubSyncWarningRef?: StructuredMessageRef }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/accept`),
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  getDelivery: (projectId: string | null, id: string) =>
    requestJson<DeliveryPreview>(withProjectParam(`/api/requirements/${encodeURIComponent(id)}/delivery`, projectId)),
  deliver: (
    id: string,
    input: {
      files: string[];
      commitMessage: string;
      expectedRevision?: number;
      note?: string;
      createPr?: boolean;
      branchName?: string;
      baseBranch?: string;
      prTitle?: string;
      prBody?: string;
      forceWithLease?: boolean;
    },
  ) =>
    requestJson<{
      detail: RequirementDetail;
      delivery: DeliveryRecord;
      pr?: RequirementGitHubPrLink;
      githubSyncWarning?: string;
      githubSyncWarningRef?: StructuredMessageRef;
      webReloaded: boolean;
      restartRecommended: boolean;
    }>(withProjectParam(`/api/requirements/${encodeURIComponent(id)}/deliver`), {
      method: "POST",
      body: JSON.stringify(input),
    }),
  linkRequirementIssue: (
    id: string,
    input?: { issueRef?: string; provider?: GitRemoteProvider; title?: string; body?: string },
  ) =>
    requestJson<{ detail: RequirementDetail }>(withProjectParam(`/api/requirements/${encodeURIComponent(id)}/github/issue`), {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    }),
  syncRequirementIssue: (id: string, input?: { comment?: string; state?: "open" | "closed" }) =>
    requestJson<{ detail: RequirementDetail }>(withProjectParam(`/api/requirements/${encodeURIComponent(id)}/github/sync-issue`), {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    }),
  syncRequirementPr: (id: string, input?: { forceCleanup?: boolean }) =>
    requestJson<{
      detail: RequirementDetail;
      pr: RequirementGitHubPrLink;
      cleanedSandbox: boolean;
      mainUpdated: boolean;
      mainSyncReason: string | null;
      mainSyncReasonRef?: StructuredMessageRef | null;
      webReloaded?: boolean;
      restartRecommended?: boolean;
      cascadeResults?: CascadeSyncItemResult[];
    }>(withProjectParam(`/api/requirements/${encodeURIComponent(id)}/github/pr-sync`), {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    }),
  cancel: (id: string, input: { reason: string; expectedRevision?: number; discardSandbox?: boolean }) =>
    requestJson<{
      detail: RequirementDetail;
      sandboxCleanup?: {
        cleaned: boolean;
        retained: boolean;
        aheadCount: number;
        dirtyFiles: string[];
        branch: string | null;
      };
    }>(withProjectParam(`/api/requirements/${encodeURIComponent(id)}/cancel`), {
      method: "POST",
      body: JSON.stringify(input),
    }),
  reopen: (id: string, input: { reason: string; preserveApproval?: boolean; expectedRevision?: number }) =>
    requestJson<{ detail: RequirementDetail }>(withProjectParam(`/api/requirements/${encodeURIComponent(id)}/reopen`), {
      method: "POST",
      body: JSON.stringify(input),
    }),
};

export function connectUiWebSocket(
  onEvent: (event: Record<string, unknown>) => void,
  options?: {
    onReconnect?: () => void;
    onConnected?: (info: { reconnected: boolean }) => void;
  },
): () => void {
  let closed = false;
  let hasOpenedOnce = false;
  let ws: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (closed) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws?role=ui`);
    ws.addEventListener("open", () => {
      // 首次连接也可能落在初始快照与事件之间；两种连接都通知上层补拉权威运行快照。
      const reconnected = hasOpenedOnce;
      hasOpenedOnce = true;
      options?.onConnected?.({ reconnected });
      if (reconnected) {
        options?.onReconnect?.();
      }
    });
    ws.addEventListener("message", (ev) => {
      try {
        onEvent(JSON.parse(String(ev.data)) as Record<string, unknown>);
      } catch {
        // Ignore malformed frames.
      }
    });
    ws.addEventListener("close", () => {
      if (!closed) {
        retryTimer = setTimeout(connect, 1500);
      }
    });
  };

  connect();
  return () => {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    ws?.close();
  };
}
