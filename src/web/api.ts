import type {
  CriterionInput,
  PrivacyMode,
  ProjectMetadata,
  RequirementDetail,
  RequirementSummary,
  VerificationRecord,
} from "../core/types.ts";
import type { GitObservation } from "../core/git.ts";
import type { BridgeStatus, DispatchOutcome } from "../server/index.ts";
import type { DispatchAction } from "../server/prompts.ts";

export interface ProjectInfoResponse {
  initialized: boolean;
  project: ProjectMetadata | null;
  root: string;
  bridge: BridgeStatus;
  git: { isGitRepo: boolean; head?: string; dirty?: boolean; fingerprint?: string | null };
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
  getProject: () => requestJson<ProjectInfoResponse>("/api/project"),
  initProject: (input: { name?: string; privacyMode: PrivacyMode }) =>
    requestJson<{ initialized: boolean; project: ProjectMetadata }>("/api/project/init", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listRequirements: (scope: "active" | "done" | "cancelled" | "all") =>
    requestJson<{ items: RequirementSummary[]; codeSnapshotHash: string | null; bridge: BridgeStatus }>(
      `/api/requirements?scope=${encodeURIComponent(scope)}`,
    ),
  createRequirement: (input: { goal: string; title?: string; dispatchAgent?: boolean }) =>
    requestJson<{ detail: RequirementDetail; dispatch: DispatchOutcome | null }>("/api/requirements", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  getRequirement: (id: string) =>
    requestJson<{ detail: RequirementDetail; bridge: BridgeStatus; codeSnapshotHash: string | null }>(
      `/api/requirements/${encodeURIComponent(id)}`,
    ),
  getDiff: (id: string) =>
    requestJson<{ changes: GitObservation }>(`/api/requirements/${encodeURIComponent(id)}/diff`),
  getDesignHistory: (id: string, version: number) =>
    requestJson<{ version: number; markdown: string }>(
      `/api/requirements/${encodeURIComponent(id)}/history/${version}`,
    ),
  getEvidence: (id: string, verificationId: string) =>
    requestJson<{ record: VerificationRecord; log: string }>(
      `/api/requirements/${encodeURIComponent(id)}/evidence/${encodeURIComponent(verificationId)}`,
    ),
  updateSpec: (
    id: string,
    input: { title?: string; specMarkdown?: string; criteria?: CriterionInput[]; expectedRevision?: number },
  ) =>
    requestJson<{ detail: RequirementDetail }>(`/api/requirements/${encodeURIComponent(id)}/spec`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  approve: (id: string, input: { expectedRevision?: number; dispatchAgent?: boolean; note?: string }) =>
    requestJson<{ detail: RequirementDetail; dispatch: DispatchOutcome | null }>(
      `/api/requirements/${encodeURIComponent(id)}/approve`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  fastTrack: (id: string, input: { expectedRevision?: number; dispatchAgent?: boolean; note?: string }) =>
    requestJson<{ detail: RequirementDetail; dispatch: DispatchOutcome | null }>(
      `/api/requirements/${encodeURIComponent(id)}/fast-track`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  requestChanges: (id: string, input: { feedback: string; expectedRevision?: number; dispatchAgent?: boolean }) =>
    requestJson<{ detail: RequirementDetail; dispatch: DispatchOutcome | null }>(
      `/api/requirements/${encodeURIComponent(id)}/request-changes`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  verify: (
    id: string,
    input: { command?: string; criterionIds?: string[]; all?: boolean; timeoutMs?: number },
  ) =>
    requestJson<{ detail: RequirementDetail; runs: VerificationRecord[] }>(
      `/api/requirements/${encodeURIComponent(id)}/verify`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  accept: (id: string, input: { expectedRevision?: number; note?: string }) =>
    requestJson<{ detail: RequirementDetail }>(`/api/requirements/${encodeURIComponent(id)}/accept`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  block: (id: string, input: { reason: string; expectedRevision?: number }) =>
    requestJson<{ detail: RequirementDetail }>(`/api/requirements/${encodeURIComponent(id)}/block`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  unblock: (id: string, input: { expectedRevision?: number }) =>
    requestJson<{ detail: RequirementDetail }>(`/api/requirements/${encodeURIComponent(id)}/unblock`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  cancel: (id: string, input: { reason: string; expectedRevision?: number }) =>
    requestJson<{ detail: RequirementDetail }>(`/api/requirements/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  reopen: (id: string, input: { reason: string; expectedRevision?: number }) =>
    requestJson<{ detail: RequirementDetail }>(`/api/requirements/${encodeURIComponent(id)}/reopen`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  dispatch: (id: string, input: { action: DispatchAction; mode?: "send" | "prefill" }) =>
    requestJson<{ detail: RequirementDetail; dispatch: DispatchOutcome }>(
      `/api/requirements/${encodeURIComponent(id)}/dispatch`,
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
