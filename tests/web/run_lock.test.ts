import { beforeEach, describe, expect, test } from "bun:test";
import { findLockingRequirementRun, resolveRequirementRunScope } from "../../src/web/state.ts";
import { useStreamStore, type ActiveRunItem } from "../../src/web/stores/streamStore.ts";

function makeRun(overrides: Partial<ActiveRunItem> = {}): ActiveRunItem {
  return {
    id: "RUN-1",
    requirementId: "REQ-001",
    action: "implement",
    harness: "codex",
    model: "gpt-6-astra",
    status: "running",
    startedAt: 1,
    endedAt: null,
    exitCode: null,
    durationMs: 0,
    logPath: "",
    root: "/repo",
    ...overrides,
  };
}

beforeEach(() => {
  useStreamStore.setState({
    activeRuns: {},
    finishedRuns: {},
    locallyStartedRuns: {},
    lastSnapshotStartedAt: 0,
    liveRunLogs: {},
    logHydrated: {},
    runTraces: {},
    liveRunMetrics: {},
    selectedRunByReq: {},
  });
});

describe("运行快照合并", () => {
  test("启动事件先到、旧空快照后到时保留已观察到的活跃运行", () => {
    const snapshotStartedAt = Date.now();
    const run = makeRun();
    useStreamStore.getState().setRunStarted(run);
    useStreamStore.getState().syncActiveRuns([], snapshotStartedAt);
    expect(useStreamStore.getState().activeRuns[run.id]).toEqual(run);
  });

  test("请求发出前已观察到的运行仍由新快照校正移除", () => {
    const run = makeRun();
    useStreamStore.getState().setRunStarted(run);
    useStreamStore.getState().syncActiveRuns([], Date.now() + 1_000);
    expect(useStreamStore.getState().activeRuns[run.id]).toBeUndefined();
    expect(useStreamStore.getState().locallyStartedRuns[run.id]).toBeUndefined();
  });

  test("已结束的运行不会被迟到的快照重新加锁", () => {
    const run = makeRun();
    useStreamStore.getState().setRunStarted(run);
    useStreamStore.getState().markRunFinished(run.id);
    useStreamStore.getState().syncActiveRuns([run], 0);
    expect(useStreamStore.getState().activeRuns[run.id]).toBeUndefined();
  });

  test("更早发出的快照晚到时不会覆盖已应用的新快照", () => {
    const run = makeRun();
    useStreamStore.getState().setRunStarted(run);
    useStreamStore.getState().syncActiveRuns([run], Date.now() + 1_000);
    useStreamStore.getState().syncActiveRuns([], 0);
    expect(useStreamStore.getState().activeRuns[run.id]).toEqual(run);
  });
});

describe("迟到调度响应合并", () => {
  test("调度请求之后应用的新快照缺少该运行时，迟到响应不得重新加锁", () => {
    const requestStartedAt = Date.now();
    const run = makeRun();
    useStreamStore.getState().setRunStarted(run, requestStartedAt);
    // 断线期间运行结束，重连快照已移除该运行。
    useStreamStore.getState().syncActiveRuns([], requestStartedAt + 10);
    expect(useStreamStore.getState().activeRuns[run.id]).toBeUndefined();

    // 挂起的调度响应此时才到达，不得按本地新事件重新加锁。
    useStreamStore.getState().setRunStarted(run, requestStartedAt);
    expect(useStreamStore.getState().activeRuns[run.id]).toBeUndefined();
  });

  test("快照请求早于调度请求时，调度响应仍可加入活跃运行", () => {
    const snapshotStartedAt = Date.now();
    useStreamStore.getState().syncActiveRuns([], snapshotStartedAt);
    const run = makeRun();
    const requestStartedAt = snapshotStartedAt + 5;
    useStreamStore.getState().setRunStarted(run, requestStartedAt);
    expect(useStreamStore.getState().activeRuns[run.id]).toEqual(run);
  });

  test("新快照已包含该运行时，迟到响应保持原记录", () => {
    const requestStartedAt = Date.now();
    const run = makeRun();
    useStreamStore.getState().syncActiveRuns([run], requestStartedAt + 10);
    useStreamStore.getState().setRunStarted(run, requestStartedAt);
    expect(useStreamStore.getState().activeRuns[run.id]).toEqual(run);
  });

  test("WebSocket 启动事件不受调度响应因果守卫影响", () => {
    useStreamStore.getState().syncActiveRuns([], Date.now());
    const run = makeRun();
    useStreamStore.getState().setRunStarted(run);
    expect(useStreamStore.getState().activeRuns[run.id]).toEqual(run);
  });
});

describe("运行项目归属", () => {
  test("单项目模式按当前根目录识别带 Hub 项目编号的本项目运行", () => {
    const run = makeRun({ projectId: "p1" });
    expect(findLockingRequirementRun([run], "REQ-001", { projectId: null, projectRoot: "/repo" })).toBe(run);
    expect(findLockingRequirementRun([run], "REQ-001", { projectId: null, projectRoot: "/other" })).toBeUndefined();
  });

  test("单项目根目录延迟返回时不误锁其他项目的同号需求", () => {
    const foreignRun = makeRun({ projectId: "p2", root: "/repo-b" });
    const localRun = makeRun({ projectId: "p1", root: "/repo-a" });
    const pending = resolveRequirementRunScope({
      activeProjectId: null,
      projects: [
        { id: "p1", root: "/repo-a" },
        { id: "p2", root: "/repo-b" },
      ],
    });
    expect(findLockingRequirementRun([foreignRun, localRun], "REQ-001", pending)).toBeUndefined();

    const resolved = resolveRequirementRunScope({
      activeProjectId: null,
      projectRoot: "/repo-a",
      projects: [
        { id: "p1", root: "/repo-a" },
        { id: "p2", root: "/repo-b" },
      ],
    });
    expect(findLockingRequirementRun([foreignRun], "REQ-001", resolved)).toBeUndefined();
    expect(findLockingRequirementRun([localRun], "REQ-001", resolved)).toBe(localRun);
  });

  test("多项目模式优先使用项目编号，缺失时按根目录解析", () => {
    const withProject = makeRun({ id: "RUN-A", projectId: "p1" });
    const withoutProject = makeRun({ id: "RUN-B" });
    const scope = resolveRequirementRunScope({
      activeProjectId: "p1",
      hubActiveProjectId: "p1",
      projectRoot: "/repo",
      projects: [{ id: "p1", root: "/repo" }],
    });
    expect(findLockingRequirementRun([withProject], "REQ-001", scope)).toBe(withProject);
    expect(findLockingRequirementRun([withoutProject], "REQ-001", scope)).toBe(withoutProject);
    expect(
      findLockingRequirementRun([makeRun({ id: "RUN-C", root: "/elsewhere" })], "REQ-001", scope),
    ).toBeUndefined();
  });
});
