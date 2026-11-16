import { create } from "zustand";
import type { ReasoningEffort } from "../../hub/types.ts";
import type { CriterionDraft, PendingAnnotation } from "../state.ts";

export interface DraftStoreState {
  selectedRunnerKey: string;
  selectedEffort: ReasoningEffort | "";

  editingSpec: boolean;
  specDraftTitle: string;
  specDraftBody: string;
  specDraftCriteria: CriterionDraft[];

  editingDesign: boolean;
  designDraftBody: string;

  discussDraft: string;
  discussAnchor: string | null;
  pendingAnnotations: PendingAnnotation[];

  setSelectedRunnerKey: (key: string) => void;
  setSelectedEffort: (effort: ReasoningEffort | "") => void;
  startEditSpec: (title: string, body: string, criteria: CriterionDraft[]) => void;
  cancelEditSpec: () => void;
  setSpecDraftTitle: (title: string) => void;
  setSpecDraftBody: (body: string) => void;
  setSpecDraftCriteria: (criteria: CriterionDraft[] | ((prev: CriterionDraft[]) => CriterionDraft[])) => void;

  startEditDesign: (body: string) => void;
  cancelEditDesign: () => void;
  setDesignDraftBody: (body: string) => void;

  setDiscussDraft: (draft: string) => void;
  setDiscussAnchor: (anchor: string | null) => void;
  addPendingAnnotation: (item: PendingAnnotation) => void;
  removePendingAnnotation: (id: string) => void;
  clearPendingAnnotations: () => void;
}

export const useDraftStore = create<DraftStoreState>((set) => ({
  selectedRunnerKey: "",
  selectedEffort: "",

  editingSpec: false,
  specDraftTitle: "",
  specDraftBody: "",
  specDraftCriteria: [],

  editingDesign: false,
  designDraftBody: "",

  discussDraft: "",
  discussAnchor: null,
  pendingAnnotations: [],

  setSelectedRunnerKey: (selectedRunnerKey) => set({ selectedRunnerKey }),
  setSelectedEffort: (selectedEffort) => set({ selectedEffort }),

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

  setDiscussDraft: (discussDraft) => set({ discussDraft }),
  setDiscussAnchor: (discussAnchor) => set({ discussAnchor }),
  addPendingAnnotation: (item) =>
    set((s) => ({ pendingAnnotations: [...s.pendingAnnotations, item] })),
  removePendingAnnotation: (id) =>
    set((s) => ({ pendingAnnotations: s.pendingAnnotations.filter((x) => x.id !== id) })),
  clearPendingAnnotations: () => set({ pendingAnnotations: [] }),
}));
