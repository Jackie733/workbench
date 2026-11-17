import type {
  AgentAction,
  AgentRunRecord,
  CriterionInput,
  DeliveryPreview,
  DeliveryRecord,
  DiscussionEntry,
  OutputLanguage,
  PrivacyMode,
  ProjectGitHubConfig,
  ProjectMetadata,
  RequirementDetail,
  RequirementDiffView,
  RequirementGitHubLink,
  RequirementGitHubPrLink,
  RequirementSummary,
  Stage,
  VerificationRecord,
} from "../core/types.ts";
import type { GitObservation } from "../core/git.ts";
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
  RoutingConfig,
  RoutingPreset,
} from "../hub/types.ts";
import type { BridgeStatus, DispatchOutcome } from "../server/index.ts";
import type { DispatchAction } from "../server/prompts.ts";

export interface ProjectInfoResponse {
  initialized: boolean;
  project: ProjectMetadata | null;
  root: string;
  bridge: BridgeStatus;
  effectiveOutputLanguage?: "zh-CN" | "en";
  remoteRepo?: string | null;
  git: { isGitRepo: boolean; head?: string; dirty?: boolean; fingerprint?: string | null };
}

export interface HubProjectSummary extends HubProjectEntry {
  initialized: boolean;
  isGitRepo: boolean;
  activeCount: number;
  decisionCount: number;
  runningCount: number;
}

export interface HubStateResponse {
  hubMode: boolean;
  activeProjectId: string | null;
  projects: HubProjectSummary[];
  harnesses: HarnessInfo[];
  routing: RoutingConfig;
  customModels: Record<string, string[]>;
  outputLanguage?: OutputLanguage;
  activeRuns: Array<AgentRunRecord & { requirementId: string }>;
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
  canApply?: boolean;
  github?: RequirementGitHubLink | null;
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

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await resp.json()) as Record<string, unknown>;
  if (!resp.ok) {
    const err = data.error as { code?: string; message?: string; details?: Record<string, unknown> } | undefined;
    throw new ApiClientError(err?.code ?? "request_failed", err?.message ?? `HTTP ${resp.status}`, err?.details);
  }
  return data as T;
}

export const api = {
  getHubState: () => requestJson<HubStateResponse>("/api/hub/state"),
  addHubProject: (input: { root: string; name?: string; initPrivacy?: PrivacyMode; activate?: boolean }) =>
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
  browseFs: (targetPath?: string) =>
    requestJson<BrowseResponse>(targetPath ? `/api/fs/browse?path=${encodeURIComponent(targetPath)}` : "/api/fs/browse"),
  refreshHarnesses: () => requestJson<{ harnesses: HarnessInfo[] }>("/api/hub/harnesses/refresh", { method: "POST" }),
  saveRouting: (routing: RoutingConfig) =>
    requestJson<{ routing: RoutingConfig; customModels: Record<string, string[]> }>("/api/hub/routing", {
      method: "PUT",
      body: JSON.stringify(routing),
    }),
  applyPreset: (preset: RoutingPreset) =>
    requestJson<{ routing: RoutingConfig; customModels: Record<string, string[]> }>("/api/hub/routing/preset", {
      method: "POST",
      body: JSON.stringify({ preset }),
    }),
  addCustomModel: (harness: string, model: string) =>
    requestJson<{ customModels: Record<string, string[]>; harnesses: HarnessInfo[] }>("/api/hub/models/custom", {
      method: "POST",
      body: JSON.stringify({ harness, model }),
    }),
  updateHubPreferences: (input: { outputLanguage?: OutputLanguage }) =>
    requestJson<{ outputLanguage: OutputLanguage }>("/api/hub/preferences", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  getEvolution: () => requestJson<EvolutionStateResponse>(withProjectParam("/api/hub/evolution")),
  reportPainPoint: (input: {
    source?: PainPointSource;
    category: PainPointCategory;
    title: string;
    detail?: string;
    context?: PainPointContext;
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
    }>(`/api/hub/evolution/apply/${encodeURIComponent(reqId)}`, {
      method: "POST",
    }),
  syncRsiSandboxPr: (reqId: string, input?: { forceCleanup?: boolean }) =>
    requestJson<{
      detail: RequirementDetail;
      pr: RequirementGitHubPrLink;
      cleanedSandbox: boolean;
      mainUpdated: boolean;
      mainSyncReason: string | null;
      webReloaded: boolean;
      restartRecommended: boolean;
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
  }) =>
    requestJson<{ project: ProjectMetadata }>(withProjectParam("/api/project/settings"), {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  getGitHubStatus: () => requestJson<GitHubEnvironmentStatus>(withProjectParam("/api/github/status")),
  listRequirements: (scope: "active" | "done" | "cancelled" | "all") =>
    requestJson<{ items: RequirementSummary[]; codeSnapshotHash: string | null; bridge: BridgeStatus }>(
      withProjectParam(`/api/requirements?scope=${encodeURIComponent(scope)}`),
    ),
  createRequirement: (input: { goal: string; title?: string; dispatchAgent?: boolean; createGitHubIssue?: boolean }) =>
    requestJson<{ detail: RequirementDetail; dispatch: DispatchOutcome | null; githubWarning?: string }>(
      withProjectParam("/api/requirements"),
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  importGitHubIssue: (input: { issueRef: string; dispatchAgent?: boolean }) =>
    requestJson<{
      detail: RequirementDetail;
      dispatch?: DispatchOutcome | null;
      alreadyExisted: boolean;
      issue: ImportedGitHubIssue;
    }>(withProjectParam("/api/requirements/import-issue"), {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getRequirement: (id: string) =>
    requestJson<{ detail: RequirementDetail; bridge: BridgeStatus; codeSnapshotHash: string | null; sandbox?: SandboxRecord | null }>(
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
  getEvidence: (id: string, verificationId: string) =>
    requestJson<{ record: VerificationRecord; log: string }>(
      withProjectParam(`/api/requirements/${encodeURIComponent(id)}/evidence/${encodeURIComponent(verificationId)}`),
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
  approve: (id: string, input: { expectedRevision?: number; dispatchAgent?: boolean; note?: string }) =>
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
  accept: (id: string, input: { expectedRevision?: number; note?: string }) =>
    requestJson<{ detail: RequirementDetail }>(withProjectParam(`/api/requirements/${encodeURIComponent(id)}/accept`), {
      method: "POST",
      body: JSON.stringify(input),
    }),
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
    },
  ) =>
    requestJson<{
      detail: RequirementDetail;
      delivery: DeliveryRecord;
      pr?: RequirementGitHubPrLink;
      githubSyncWarning?: string;
      webReloaded: boolean;
      restartRecommended: boolean;
    }>(withProjectParam(`/api/requirements/${encodeURIComponent(id)}/deliver`), {
      method: "POST",
      body: JSON.stringify(input),
    }),
  linkRequirementIssue: (id: string, input?: { issueRef?: string; title?: string; body?: string }) =>
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
      webReloaded?: boolean;
      restartRecommended?: boolean;
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
  reopen: (id: string, input: { reason: string; expectedRevision?: number }) =>
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
