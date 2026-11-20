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
  RequirementDetail,
  RequirementDiffView,
  RequirementGitHubLink,
  RequirementGitHubPrLink,
  RequirementSummary,
  SandboxDriftInfo,
  ScreenshotCaptureResult,
  Stage,
  Track,
  VerificationRecord,
} from "../core/types.ts";
import type { ProjectContextSummary } from "../core/context.ts";
import type { StructuredMessageRef } from "../core/errors.ts";
import type { GitObservation } from "../core/git.ts";
import type { GiteeEnvironmentStatus, GiteeIssueItem } from "../core/gitee.ts";
import type { GitHubEnvironmentStatus, ImportedGitHubIssue } from "../core/github.ts";
import type { SandboxRecord } from "../core/sandbox.ts";
import type {
  EvolutionPainPoint,
  PainPointCategory,
  PainPointContext,
  PainPointSource,
} from "../hub/evolution.ts";
import type { ModelStageStats } from "../hub/telemetry.ts";
import type {
  BrowseEntry,
  HarnessInfo,
  HubProjectEntry,
  ModelTarget,
  NodeUpdateStatus,
  RemoteNodeInfo,
  RoutingConfig,
  RoutingPreset,
} from "../hub/types.ts";
import type { BridgeStatus, DispatchOutcome } from "../server/index.ts";
import type { DispatchAction } from "../server/prompts.ts";

export interface GiteeIssueListItem extends GiteeIssueItem {
  importedRequirementId: string | null;
}

export interface ProjectInfoResponse {
  initialized: boolean;
  project: ProjectMetadata | null;
  root: string;
  bridge: BridgeStatus;
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
}

export interface HubStateResponse {
  hubMode: boolean;
  activeProjectId: string | null;
  activeNodeId?: string;
  projects: HubProjectSummary[];
  nodes?: RemoteNodeInfo[];
  harnesses: HarnessInfo[];
  routing: RoutingConfig;
  outputLanguage?: OutputLanguage;
  giteeTokenConfigured?: boolean;
  giteeTokenMasked?: string | null;
  activeRuns: Array<AgentRunRecord & { requirementId: string; root?: string; projectId?: string }>;
  evolutionOpenCount?: number;
  cooldownCount?: number;
}

export interface PlaybookResponse {
  exists: boolean;
  markdown: string;
  rules: string[];
  updatedAt: number | null;
}

export interface EvolutionSandboxItem extends SandboxRecord {
  stage?: Stage | null;
  title?: string;
  canApply?: boolean;
  github?: RequirementGitHubLink | null;
  drift?: SandboxDriftInfo | null;
}

export interface ProjectSandboxesResponse {
  sandboxes: EvolutionSandboxItem[];
  mergeOrder: MergeOrderRecommendation | null;
}

export interface EvolutionStateResponse {
  painPoints: EvolutionPainPoint[];
  telemetry: {
    entries: ModelStageStats[];
    activeCooldowns: Array<{ harness: string; model: string; until: number }>;
  };
  sandboxes: EvolutionSandboxItem[];
  workbenchRoot: string;
  workbenchProjectId?: string | null;
  playbook: PlaybookResponse;
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

export function evolutionAttachmentUrl(painId: string, attachmentId: string): string {
  return `/api/hub/evolution/${encodeURIComponent(painId)}/attachments/${encodeURIComponent(attachmentId)}`;
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
    requestJson<{ project: HubProjectEntry; activeProjectId: string | null; projects: HubProjectSummary[] }>(
      `/api/hub/projects/${encodeURIComponent(projectId)}/activate`,
      { method: "POST" },
    ),
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
    requestJson<{ routing: RoutingConfig }>("/api/hub/routing", {
      method: "PUT",
      body: JSON.stringify(routing),
    }),
  applyPreset: (preset: RoutingPreset) =>
    requestJson<{ routing: RoutingConfig }>("/api/hub/routing/preset", {
      method: "POST",
      body: JSON.stringify({ preset }),
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
  getEvolution: () => requestJson<EvolutionStateResponse>(withProjectParam("/api/hub/evolution")),
  uploadAttachments: (files: File[], scope: "project" | "hub" = "project") => {
    const form = new FormData();
    for (const file of files) form.append("files", file, file.name);
    const endpoint = scope === "hub" ? "/api/uploads?scope=hub" : withProjectParam("/api/uploads");
    return requestForm<{ attachments: AttachmentMeta[] }>(endpoint, form);
  },
  reportPainPoint: (input: {
    source?: PainPointSource;
    category: PainPointCategory;
    title: string;
    detail?: string;
    context?: PainPointContext;
    attachmentIds?: string[];
  }) =>
    requestJson<{ painPoint: EvolutionPainPoint | null }>("/api/hub/evolution/report", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  promotePainPoint: (id: string, input?: { createSandbox?: boolean; createGitHubIssue?: boolean }) =>
    requestJson<{
      painPoint: EvolutionPainPoint;
      requirement: RequirementDetail;
      workbenchRoot: string;
      workbenchProjectId: string;
      sandbox: SandboxRecord | null;
      githubIssueWarning?: string;
      githubIssueWarningRef?: StructuredMessageRef;
    }>(`/api/hub/evolution/${encodeURIComponent(id)}/promote`, {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    }),
  dismissPainPoint: (id: string) =>
    requestJson<{ painPoint: EvolutionPainPoint }>(`/api/hub/evolution/${encodeURIComponent(id)}/dismiss`, {
      method: "POST",
    }),
  applyRsiSandbox: (reqId: string) =>
    requestJson<{
      appliedFiles: string[];
      deletedFiles: string[];
      touchesWeb: boolean;
      touchesBackend: boolean;
      webReloaded: boolean;
      restartRecommended: boolean;
      cascadeResults?: CascadeSyncItemResult[];
    }>(`/api/hub/evolution/apply/${encodeURIComponent(reqId)}`, {
      method: "POST",
    }),
  syncRsiSandboxBase: (reqId: string) =>
    requestJson<{
      synced: boolean;
      upToDate: boolean;
      conflictFiles: string[];
      drift: SandboxDriftInfo;
      detail: RequirementDetail;
    }>(`/api/hub/evolution/sync-base/${encodeURIComponent(reqId)}`, {
      method: "POST",
    }),
  syncRsiSandboxPr: (reqId: string, input?: { forceCleanup?: boolean }) =>
    requestJson<{
      detail: RequirementDetail;
      pr: RequirementGitHubPrLink;
      cleanedSandbox: boolean;
      mainUpdated: boolean;
      mainSyncReason: string | null;
      mainSyncReasonRef?: StructuredMessageRef | null;
      webReloaded: boolean;
      restartRecommended: boolean;
      cascadeResults?: CascadeSyncItemResult[];
    }>(`/api/hub/evolution/sync-pr/${encodeURIComponent(reqId)}`, {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    }),
  clearModelCooldown: (harness?: string, model?: string) =>
    requestJson<{ telemetry: EvolutionStateResponse["telemetry"] }>("/api/hub/telemetry/clear-cooldown", {
      method: "POST",
      body: JSON.stringify({ harness, model }),
    }),
  reloadWebBundle: () => requestJson<{ ok: boolean; reloaded: boolean }>("/api/hub/reload-web", { method: "POST" }),
  getPlaybook: () => requestJson<PlaybookResponse>(withProjectParam("/api/project/playbook")),
  savePlaybook: (markdown: string) =>
    requestJson<PlaybookResponse>(withProjectParam("/api/project/playbook"), {
      method: "PUT",
      body: JSON.stringify({ markdown }),
    }),
  distillPlaybook: (requirementId?: string) =>
    requestJson<PlaybookResponse & { added: number }>(withProjectParam("/api/project/playbook/distill"), {
      method: "POST",
      body: JSON.stringify({ requirementId }),
    }),

  getProject: () => requestJson<ProjectInfoResponse>(withProjectParam("/api/project")),
  initProject: (input: { name?: string; privacyMode: PrivacyMode; outputLanguage?: OutputLanguage }) =>
    requestJson<{ initialized: boolean; project: ProjectMetadata }>(withProjectParam("/api/project/init"), {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateProjectSettings: (input: {
    name?: string;
    outputLanguage?: OutputLanguage | "inherit" | null;
    github?: ProjectGitHubConfig | null;
    gitee?: ProjectGiteeConfig | null;
    verification?: ProjectVerificationConfig | null;
  }) =>
    requestJson<{ project: ProjectMetadata }>(withProjectParam("/api/project/settings"), {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  getGitHubStatus: () => requestJson<GitHubEnvironmentStatus>(withProjectParam("/api/github/status")),
  getGiteeStatus: () => requestJson<GiteeEnvironmentStatus>(withProjectParam("/api/gitee/status")),
  listGiteeIssues: (params?: {
    filter?: "assigned" | "created" | "all";
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
      withProjectParam(suffix ? `/api/gitee/issues?${suffix}` : "/api/gitee/issues"),
    );
  },
  getProjectSandboxes: (fetchRemote = false) =>
    requestJson<ProjectSandboxesResponse>(
      withProjectParam(fetchRemote ? "/api/project/sandboxes?fetch=1" : "/api/project/sandboxes"),
    ),
  createRequirementSandbox: (
    id: string,
    input?: { branchPrefix?: "rsi" | "feat"; branchName?: string; stackedOnReqId?: string },
  ) =>
    requestJson<{ sandbox: SandboxRecord; detail: RequirementDetail; sandboxDrift?: SandboxDriftInfo | null }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/sandbox`),
      { method: "POST", body: JSON.stringify(input ?? {}) },
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
      useCli?: boolean;
      dispatchAgent?: boolean;
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
      dispatch: DispatchOutcome | null;
    }>(withProjectParam(`/api/requirements/${encodeURIComponent(id)}/sync-resolve`), {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listRequirements: (scope: "active" | "done" | "cancelled" | "all") =>
    requestJson<{ items: RequirementSummary[]; codeSnapshotHash: string | null; bridge: BridgeStatus }>(
      withProjectParam(`/api/requirements?scope=${encodeURIComponent(scope)}`),
    ),
  createRequirement: (input: {
    goal: string;
    title?: string;
    parentId?: string;
    dispatchAgent?: boolean;
    createGitHubIssue?: boolean;
    createSandbox?: boolean;
    stackedOnReqId?: string;
    attachmentIds?: string[];
  }) =>
    requestJson<{
      detail: RequirementDetail;
      dispatch: DispatchOutcome | null;
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
    dispatchAgent?: boolean;
  }) =>
    requestJson<{
      detail: RequirementDetail;
      dispatch?: DispatchOutcome | null;
      alreadyExisted: boolean;
      issue: ImportedGitHubIssue | GiteeIssueItem;
      provider?: GitRemoteProvider;
    }>(withProjectParam("/api/requirements/import-issue"), {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getRequirement: (id: string) =>
    requestJson<{
      detail: RequirementDetail;
      bridge: BridgeStatus;
      codeSnapshotHash: string | null;
      sandbox?: SandboxRecord | null;
      sandboxDrift?: SandboxDriftInfo | null;
    }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}`),
    ),
  getDiff: (id: string, options: { live?: boolean } = {}) =>
    requestJson<RequirementDiffView & { changes: GitObservation | null }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/diff${options.live ? "?live=1" : ""}`),
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
  addDiscussion: (
    id: string,
    input: { mode: "ask" | "refine"; anchor?: string; message: string; resolved?: boolean },
  ) =>
    requestJson<{ detail: RequirementDetail; entry: DiscussionEntry }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/discussions`),
      { method: "POST", body: JSON.stringify(input) },
    ),
  resolveDiscussions: (id: string, input: { ids?: string[]; resolved?: boolean }) =>
    requestJson<{ detail: RequirementDetail }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/discussions/resolve`),
      { method: "POST", body: JSON.stringify(input) },
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
      mode?: "ask" | "refine";
      useFallback?: boolean;
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
  getAgentRunLog: (id: string, runId: string) =>
    requestJson<{ record: AgentRunRecord; log: string }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`),
    ),
  approve: (
    id: string,
    input: { expectedRevision?: number; dispatchAgent?: boolean; note?: string; createSandbox?: boolean; stackedOnReqId?: string },
  ) =>
    requestJson<{ detail: RequirementDetail; dispatch: DispatchOutcome | null }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/approve`),
      { method: "POST", body: JSON.stringify(input) },
    ),
  fastTrack: (id: string, input: { expectedRevision?: number; dispatchAgent?: boolean; note?: string }) =>
    requestJson<{ detail: RequirementDetail; dispatch: DispatchOutcome | null }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/fast-track`),
      { method: "POST", body: JSON.stringify(input) },
    ),
  requestChanges: (id: string, input: { feedback: string; expectedRevision?: number; dispatchAgent?: boolean }) =>
    requestJson<{ detail: RequirementDetail; dispatch: DispatchOutcome | null }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/request-changes`),
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
  accept: (id: string, input: { expectedRevision?: number; note?: string; overrideReason?: string; acceptedRisks?: string[] }) =>
    requestJson<{ detail: RequirementDetail; githubSyncWarning?: string; githubSyncWarningRef?: StructuredMessageRef }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/accept`),
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  getDelivery: (id: string) =>
    requestJson<DeliveryPreview>(withProjectParam(`/api/requirements/${encodeURIComponent(id)}/delivery`)),
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
  block: (id: string, input: { reason: string; expectedRevision?: number }) =>
    requestJson<{ detail: RequirementDetail }>(withProjectParam(`/api/requirements/${encodeURIComponent(id)}/block`), {
      method: "POST",
      body: JSON.stringify(input),
    }),
  unblock: (id: string, input: { expectedRevision?: number }) =>
    requestJson<{ detail: RequirementDetail }>(withProjectParam(`/api/requirements/${encodeURIComponent(id)}/unblock`), {
      method: "POST",
      body: JSON.stringify(input),
    }),
  cancel: (id: string, input: { reason: string; expectedRevision?: number }) =>
    requestJson<{ detail: RequirementDetail }>(withProjectParam(`/api/requirements/${encodeURIComponent(id)}/cancel`), {
      method: "POST",
      body: JSON.stringify(input),
    }),
  reopen: (id: string, input: { reason: string; preserveApproval?: boolean; expectedRevision?: number }) =>
    requestJson<{ detail: RequirementDetail }>(withProjectParam(`/api/requirements/${encodeURIComponent(id)}/reopen`), {
      method: "POST",
      body: JSON.stringify(input),
    }),
  dispatch: (id: string, input: { action: DispatchAction; mode?: "send" | "prefill" }) =>
    requestJson<{ detail: RequirementDetail; dispatch: DispatchOutcome }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/dispatch`),
      { method: "POST", body: JSON.stringify(input) },
    ),
};

export function connectUiWebSocket(onEvent: (event: Record<string, unknown>) => void): () => void {
  let closed = false;
  let ws: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (closed) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws?role=ui`);
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
