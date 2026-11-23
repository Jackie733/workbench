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
  /** 已结束的运行编号；用于防止迟到的启动响应或旧 Hub 快照重新加锁。 */
  finishedRuns: Record<string, true>;
  /** 运行事件到达本地的时间；快照请求发出后才到达的事件不受旧快照影响。 */
  locallyStartedRuns: Record<string, number>;
  /** 已应用的最新快照请求时间；更早发出的快照不得回滚更新的状态。 */
  lastSnapshotStartedAt: number;
  liveRunLogs: Record<string, string>;
  logHydrated: Record<string, boolean>;
  runTraces: Record<string, RunTraceState>;
  liveRunMetrics: Record<string, Partial<AgentRunRecord>>;
  selectedRunByReq: Record<string, string | null>;

  syncActiveRuns: (runs: ActiveRunItem[], snapshotStartedAt?: number) => void;
  setRunStarted: (run: ActiveRunItem, requestStartedAt?: number) => void;
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
  finishedRuns: {},
  locallyStartedRuns: {},
  lastSnapshotStartedAt: 0,
  liveRunLogs: {},
  logHydrated: {},
  runTraces: {},
  liveRunMetrics: {},
  selectedRunByReq: {},

  syncActiveRuns: (runs, snapshotStartedAt = Date.now()) =>
    set((s) => {
      // 更早发出的快照可能晚到；不得用它回滚已经应用的新快照。
      if (snapshotStartedAt < s.lastSnapshotStartedAt) return s;
      const nextActive: Record<string, ActiveRunItem> = {};
      for (const r of runs) {
        // 旧快照可能仍包含已经结束的运行，结束标记优先于快照。
        if (s.finishedRuns[r.id]) continue;
        nextActive[r.id] = r;
      }
      const nextLocallyStarted: Record<string, number> = {};
      for (const [id, run] of Object.entries(s.activeRuns)) {
        if (nextActive[id] || s.finishedRuns[id]) continue;
        const receivedAt = s.locallyStartedRuns[id];
        // 快照请求发出后才观察到的运行事件不被该快照回滚。
        if (receivedAt !== undefined && receivedAt >= snapshotStartedAt) {
          nextActive[id] = run;
          nextLocallyStarted[id] = receivedAt;
        }
      }
      return {
        activeRuns: nextActive,
        locallyStartedRuns: nextLocallyStarted,
        lastSnapshotStartedAt: snapshotStartedAt,
      };
    }),

  setRunStarted: (run, requestStartedAt) =>
    set((s) => {
      // HTTP 调度响应可能晚于 WebSocket 结束事件；已结束的运行不再加锁。
      if (s.finishedRuns[run.id]) return s;
      // 调度请求之后发出并已应用的新快照不含该运行：迟到的响应不得重新加锁。
      if (requestStartedAt !== undefined && requestStartedAt < s.lastSnapshotStartedAt && !s.activeRuns[run.id]) {
        return s;
      }
      return {
        activeRuns: { ...s.activeRuns, [run.id]: run },
        locallyStartedRuns: { ...s.locallyStartedRuns, [run.id]: Date.now() },
        liveRunLogs: { ...s.liveRunLogs, [run.id]: s.liveRunLogs[run.id] ?? "" },
        runTraces: {
          ...s.runTraces,
          [run.id]: s.runTraces[run.id] ?? { events: [], lastSeq: 0, hydrated: false, hasTrace: true },
        },
        selectedRunByReq: { ...s.selectedRunByReq, [run.requirementId]: run.id },
      };
    }),

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
      const nextLocallyStarted = { ...s.locallyStartedRuns };
      delete nextLocallyStarted[runId];
      return {
        activeRuns: nextActive,
        finishedRuns: { ...s.finishedRuns, [runId]: true },
        locallyStartedRuns: nextLocallyStarted,
      };
    }),

  setSelectedRunForReq: (reqId, runId) =>
    set((s) => ({
      selectedRunByReq: { ...s.selectedRunByReq, [reqId]: runId },
    })),
}));
