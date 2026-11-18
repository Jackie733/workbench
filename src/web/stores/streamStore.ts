import { create } from "zustand";
import type { AgentRunRecord } from "../../core/types.ts";

export type ActiveRunItem = AgentRunRecord & { requirementId: string; root?: string; projectId?: string };

export interface StreamStoreState {
  activeRuns: Record<string, ActiveRunItem>;
  liveRunLogs: Record<string, string>;
  selectedRunId: string | null;

  syncActiveRuns: (runs: ActiveRunItem[]) => void;
  setRunStarted: (run: ActiveRunItem) => void;
  appendRunLog: (runId: string, chunk: string) => void;
  setRunLogFull: (runId: string, log: string) => void;
  markRunFinished: (runId: string) => void;
  setSelectedRunId: (runId: string | null) => void;
}

export const useStreamStore = create<StreamStoreState>((set) => ({
  activeRuns: {},
  liveRunLogs: {},
  selectedRunId: null,

  syncActiveRuns: (runs) =>
    set(() => {
      const nextActive: Record<string, ActiveRunItem> = {};
      for (const r of runs) nextActive[r.id] = r;
      return { activeRuns: nextActive };
    }),

  setRunStarted: (run) =>
    set((s) => ({
      activeRuns: { ...s.activeRuns, [run.id]: run },
      liveRunLogs: { ...s.liveRunLogs, [run.id]: s.liveRunLogs[run.id] ?? "" },
      selectedRunId: run.id,
    })),

  appendRunLog: (runId, chunk) =>
    set((s) => ({
      liveRunLogs: {
        ...s.liveRunLogs,
        [runId]: (s.liveRunLogs[runId] ?? "") + chunk,
      },
    })),

  setRunLogFull: (runId, log) =>
    set((s) => ({
      liveRunLogs: { ...s.liveRunLogs, [runId]: log },
    })),

  markRunFinished: (runId) =>
    set((s) => {
      const nextActive = { ...s.activeRuns };
      delete nextActive[runId];
      return { activeRuns: nextActive };
    }),

  setSelectedRunId: (selectedRunId) => set({ selectedRunId }),
}));
