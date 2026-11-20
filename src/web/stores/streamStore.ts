import { create } from "zustand";
import type { AgentRunRecord, RunTraceEvent } from "../../core/types.ts";

export type ActiveRunItem = AgentRunRecord & { requirementId: string; root?: string; projectId?: string };

export interface RunTraceState {
  events: RunTraceEvent[];
  lastSeq: number;
  hydrated: boolean;
  hasTrace: boolean;
  loading?: boolean;
}

export interface StreamStoreState {
  activeRuns: Record<string, ActiveRunItem>;
  liveRunLogs: Record<string, string>;
  logHydrated: Record<string, boolean>;
  runTraces: Record<string, RunTraceState>;
  liveRunMetrics: Record<string, Partial<AgentRunRecord>>;
  selectedRunByReq: Record<string, string | null>;

  syncActiveRuns: (runs: ActiveRunItem[]) => void;
  setRunStarted: (run: ActiveRunItem) => void;
  appendRunLog: (runId: string, chunk: string) => void;
  setRunLogFull: (runId: string, log: string, hydrated?: boolean) => void;
  applyTraceSnapshot: (
    runId: string,
    res: { events: RunTraceEvent[]; nextSeq: number; hasTrace: boolean },
    append?: boolean,
  ) => void;
  pushTraceEvent: (runId: string, ev: RunTraceEvent) => void;
  updateLiveMetrics: (runId: string, metrics: Partial<AgentRunRecord>) => void;
  markRunFinished: (runId: string) => void;
  setSelectedRunForReq: (reqId: string, runId: string | null) => void;
}

function mergeEventsSorted(existing: RunTraceEvent[], incoming: RunTraceEvent[]): RunTraceEvent[] {
  if (incoming.length === 0) return existing;
  const bySeq = new Map<number, RunTraceEvent>();
  for (const ev of existing) bySeq.set(ev.seq, ev);
  for (const ev of incoming) bySeq.set(ev.seq, ev);
  return Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
}

export const useStreamStore = create<StreamStoreState>((set) => ({
  activeRuns: {},
  liveRunLogs: {},
  logHydrated: {},
  runTraces: {},
  liveRunMetrics: {},
  selectedRunByReq: {},

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
      runTraces: {
        ...s.runTraces,
        [run.id]: s.runTraces[run.id] ?? { events: [], lastSeq: 0, hydrated: false, hasTrace: true },
      },
      selectedRunByReq: { ...s.selectedRunByReq, [run.requirementId]: run.id },
    })),

  appendRunLog: (runId, chunk) =>
    set((s) => ({
      liveRunLogs: {
        ...s.liveRunLogs,
        [runId]: (s.liveRunLogs[runId] ?? "") + chunk,
      },
    })),

  setRunLogFull: (runId, log, hydrated = true) =>
    set((s) => ({
      liveRunLogs: { ...s.liveRunLogs, [runId]: log },
      logHydrated: { ...s.logHydrated, [runId]: hydrated },
    })),

  applyTraceSnapshot: (runId, res, append = false) =>
    set((s) => {
      const prev = s.runTraces[runId];
      const baseEvents = append && prev ? prev.events : [];
      const merged = mergeEventsSorted(baseEvents, res.events);
      const maxSeq = merged.length > 0 ? merged[merged.length - 1]!.seq : 0;
      const lastSeq = Math.max(prev?.lastSeq ?? 0, res.nextSeq, maxSeq);
      return {
        runTraces: {
          ...s.runTraces,
          [runId]: {
            events: merged,
            lastSeq,
            hydrated: true,
            hasTrace: res.hasTrace || merged.length > 0,
            loading: false,
          },
        },
      };
    }),

  pushTraceEvent: (runId, ev) =>
    set((s) => {
      const prev = s.runTraces[runId] ?? { events: [], lastSeq: 0, hydrated: false, hasTrace: true };
      if (prev.events.some((item) => item.seq === ev.seq)) return s;
      const nextEvents =
        prev.events.length === 0 || ev.seq > prev.events[prev.events.length - 1]!.seq
          ? [...prev.events, ev]
          : mergeEventsSorted(prev.events, [ev]);
      return {
        runTraces: {
          ...s.runTraces,
          [runId]: {
            ...prev,
            events: nextEvents,
            lastSeq: Math.max(prev.lastSeq, ev.seq),
            hasTrace: true,
          },
        },
      };
    }),

  updateLiveMetrics: (runId, metrics) =>
    set((s) => {
      const active = s.activeRuns[runId];
      return {
        liveRunMetrics: {
          ...s.liveRunMetrics,
          [runId]: { ...(s.liveRunMetrics[runId] ?? {}), ...metrics },
        },
        ...(active
          ? {
              activeRuns: {
                ...s.activeRuns,
                [runId]: { ...active, ...metrics },
              },
            }
          : {}),
      };
    }),

  markRunFinished: (runId) =>
    set((s) => {
      const nextActive = { ...s.activeRuns };
      delete nextActive[runId];
      return { activeRuns: nextActive };
    }),

  setSelectedRunForReq: (reqId, runId) =>
    set((s) => ({
      selectedRunByReq: { ...s.selectedRunByReq, [reqId]: runId },
    })),
}));
