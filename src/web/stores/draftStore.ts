import { create } from "zustand";
import { AGENT_ACTIONS, type AgentAction } from "../../core/types.ts";
import { REASONING_EFFORTS, type ReasoningEffort } from "../../hub/types.ts";
import { readStorageItem, writeStorageItem } from "../i18n.ts";
import type { CriterionDraft } from "../state.ts";

export interface RunnerOverride {
  key: string;
  effort: ReasoningEffort | "";
}

const RUNNER_OVERRIDES_KEY_PREFIX = "wb-runner-overrides::";
const VALID_ACTIONS = new Set<string>(AGENT_ACTIONS);
const VALID_EFFORTS = new Set<string>(REASONING_EFFORTS);

function runnerOverridesStorageKey(projectId: string | null): string {
  return `${RUNNER_OVERRIDES_KEY_PREFIX}${projectId && projectId.trim() ? projectId.trim() : "default"}`;
}

function loadRunnerOverrides(projectId: string | null): Partial<Record<AgentAction, RunnerOverride>> {
  const raw = readStorageItem(runnerOverridesStorageKey(projectId));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Partial<Record<AgentAction, RunnerOverride>> = {};
    for (const [action, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!VALID_ACTIONS.has(action) || !value || typeof value !== "object" || Array.isArray(value)) continue;
      const obj = value as Record<string, unknown>;
      const key = typeof obj.key === "string" ? obj.key.trim() : "";
      const effort =
        typeof obj.effort === "string" && (obj.effort === "" || VALID_EFFORTS.has(obj.effort))
          ? (obj.effort as ReasoningEffort | "")
          : "";
      if (key || effort) {
        out[action as AgentAction] = { key, effort };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function persistRunnerOverrides(
  projectId: string | null,
  overrides: Partial<Record<AgentAction, RunnerOverride>>,
): void {
  const clean: Partial<Record<AgentAction, RunnerOverride>> = {};
  for (const [action, value] of Object.entries(overrides) as Array<[AgentAction, RunnerOverride | undefined]>) {
    if (!value) continue;
    if (value.key || value.effort) clean[action] = value;
  }
  writeStorageItem(runnerOverridesStorageKey(projectId), JSON.stringify(clean));
}

export interface DraftStoreState {
  projectScopeId: string | null;
  /** Per-action runner overrides persisted per project so workspace picks survive reloads and restarts. */
  runnerOverrides: Partial<Record<AgentAction, RunnerOverride>>;
  selectedRunnerKey: string;
  selectedEffort: ReasoningEffort | "";

  editingSpec: boolean;
  specDraftTitle: string;
  specDraftBody: string;
  specDraftCriteria: CriterionDraft[];

  editingDesign: boolean;
  designDraftBody: string;

  discussDraftByReq: Record<string, string>;
  discussAnchorByReq: Record<string, string | null>;
  discussFreshSessionByReq: Record<string, boolean>;

  setProjectScope: (projectId: string | null) => void;
  setSelectedRunnerKey: (key: string, action?: AgentAction) => void;
  setSelectedEffort: (effort: ReasoningEffort | "", action?: AgentAction) => void;
  clearRunnerOverrides: (action?: AgentAction) => void;
  startEditSpec: (title: string, body: string, criteria: CriterionDraft[]) => void;
  cancelEditSpec: () => void;
  setSpecDraftTitle: (title: string) => void;
  setSpecDraftBody: (body: string) => void;
  setSpecDraftCriteria: (criteria: CriterionDraft[] | ((prev: CriterionDraft[]) => CriterionDraft[])) => void;

  startEditDesign: (body: string) => void;
  cancelEditDesign: () => void;
  setDesignDraftBody: (body: string) => void;

  setDiscussDraft: (reqId: string, draft: string) => void;
  setDiscussAnchor: (reqId: string, anchor: string | null) => void;
  setDiscussFreshSession: (reqId: string, fresh: boolean) => void;
}

export const useDraftStore = create<DraftStoreState>((set) => ({
  projectScopeId: null,
  runnerOverrides: loadRunnerOverrides(null),
  selectedRunnerKey: "",
  selectedEffort: "",

  editingSpec: false,
  specDraftTitle: "",
  specDraftBody: "",
  specDraftCriteria: [],

  editingDesign: false,
  designDraftBody: "",

  discussDraftByReq: {},
  discussAnchorByReq: {},
  discussFreshSessionByReq: {},

  setProjectScope: (projectScopeId) =>
    set((s) => {
      if (s.projectScopeId === projectScopeId) return s;
      return {
        projectScopeId,
        runnerOverrides: loadRunnerOverrides(projectScopeId),
        selectedRunnerKey: "",
        selectedEffort: "",
        discussDraftByReq: {},
        discussAnchorByReq: {},
        discussFreshSessionByReq: {},
      };
    }),
  setSelectedRunnerKey: (selectedRunnerKey, action) =>
    set((s) => {
      if (!action) return { selectedRunnerKey };
      const nextOverrides: Partial<Record<AgentAction, RunnerOverride>> = {
        ...s.runnerOverrides,
        [action]: { key: selectedRunnerKey, effort: "" },
      };
      if (!selectedRunnerKey) {
        delete nextOverrides[action];
      }
      persistRunnerOverrides(s.projectScopeId, nextOverrides);
      return {
        selectedRunnerKey,
        runnerOverrides: nextOverrides,
      };
    }),
  setSelectedEffort: (selectedEffort, action) =>
    set((s) => {
      if (!action) return { selectedEffort };
      const existingKey = s.runnerOverrides[action]?.key ?? "";
      const nextOverrides: Partial<Record<AgentAction, RunnerOverride>> = {
        ...s.runnerOverrides,
        [action]: { key: existingKey, effort: selectedEffort },
      };
      if (!existingKey && !selectedEffort) {
        delete nextOverrides[action];
      }
      persistRunnerOverrides(s.projectScopeId, nextOverrides);
      return {
        selectedEffort,
        runnerOverrides: nextOverrides,
      };
    }),
  clearRunnerOverrides: (action) =>
    set((s) => {
      if (action) {
        const nextOverrides = { ...s.runnerOverrides };
        delete nextOverrides[action];
        persistRunnerOverrides(s.projectScopeId, nextOverrides);
        return { runnerOverrides: nextOverrides };
      }
      persistRunnerOverrides(s.projectScopeId, {});
      return { runnerOverrides: {}, selectedRunnerKey: "", selectedEffort: "" };
    }),

  startEditSpec: (specDraftTitle, specDraftBody, specDraftCriteria) =>
    set({ editingSpec: true, specDraftTitle, specDraftBody, specDraftCriteria }),
  cancelEditSpec: () => set({ editingSpec: false }),
  setSpecDraftTitle: (specDraftTitle) => set({ specDraftTitle }),
  setSpecDraftBody: (specDraftBody) => set({ specDraftBody }),
  setSpecDraftCriteria: (fnOrArr) =>
    set((s) => ({
      specDraftCriteria: typeof fnOrArr === "function" ? fnOrArr(s.specDraftCriteria) : fnOrArr,
    })),

  startEditDesign: (designDraftBody) => set({ editingDesign: true, designDraftBody }),
  cancelEditDesign: () => set({ editingDesign: false }),
  setDesignDraftBody: (designDraftBody) => set({ designDraftBody }),

  setDiscussDraft: (reqId, draft) =>
    set((s) => ({
      discussDraftByReq: { ...s.discussDraftByReq, [reqId]: draft },
    })),
  setDiscussAnchor: (reqId, anchor) =>
    set((s) => ({
      discussAnchorByReq: { ...s.discussAnchorByReq, [reqId]: anchor },
    })),
  setDiscussFreshSession: (reqId, fresh) =>
    set((s) => ({
      discussFreshSessionByReq: { ...s.discussFreshSessionByReq, [reqId]: fresh },
    })),
}));
