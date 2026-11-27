import { beforeEach, describe, expect, test } from "bun:test";
import {
  findActiveAskRun,
  findLockingRequirementRun,
  getPendingRefineAnnotations,
  matchesRequirementRunScope,
  resolveRequirementRunScope,
} from "../../src/web/state.ts";
import { useDraftStore } from "../../src/web/stores/draftStore.ts";
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
    liveStreamDeltas: {},
    askPromptsByRun: {},
    lastAskErrorByReq: {},
    logHydrated: {},
    runTraces: {},
    liveRunMetrics: {},
    selectedRunByReq: {},
  });
  useDraftStore.setState({
    discussDraftByReq: {},
    discussAnchorByReq: {},
    discussFreshSessionByReq: {},
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

describe("双轨并发与流式探讨状态", () => {
  test("ask 运行不触发主工作区写锁，但可由独立 ask 轨道识别", () => {
    const scope = { projectId: null, projectRoot: "/repo" };
    const askRun = makeRun({ id: "RUN-ASK", action: "ask" });
    const implRun = makeRun({ id: "RUN-IMPL", action: "implement" });

    expect(findLockingRequirementRun([askRun], "REQ-001", scope)).toBeUndefined();
    expect(findActiveAskRun([askRun], "REQ-001", scope)).toBe(askRun);

    // 双轨并发时各自精确匹配对应轨道
    expect(findLockingRequirementRun([askRun, implRun], "REQ-001", scope)).toBe(implRun);
    expect(findActiveAskRun([askRun, implRun], "REQ-001", scope)).toBe(askRun);
  });

  test("并发 ask 启动不抢占主任务终端选中态，且增量 delta 在完整消息到达后自动清空", () => {
    const implRun = makeRun({ id: "RUN-IMPL", action: "implement" });
    const askRun = makeRun({ id: "RUN-ASK", action: "ask" });

    useStreamStore.getState().setRunStarted(implRun);
    expect(useStreamStore.getState().selectedRunByReq["REQ-001"]).toBe("RUN-IMPL");

    useStreamStore.getState().setRunStarted(askRun);
    expect(useStreamStore.getState().selectedRunByReq["REQ-001"]).toBe("RUN-IMPL");

    useStreamStore.getState().appendRunDelta("RUN-ASK", "thinking", "分析原因");
    useStreamStore.getState().appendRunDelta("RUN-ASK", "text", "第一段");
    useStreamStore.getState().appendRunDelta("RUN-ASK", "text", "第二段");
    expect(useStreamStore.getState().liveStreamDeltas["RUN-ASK"]).toEqual({
      thinking: "分析原因",
      text: "第一段第二段",
    });

    useStreamStore.getState().pushTraceEvent("RUN-ASK", {
      seq: 1,
      ts: Date.now(),
      type: "assistant.message",
      turnIndex: 1,
      text: "第一段第二段",
    });
    expect(useStreamStore.getState().liveStreamDeltas["RUN-ASK"]).toEqual({
      thinking: "分析原因",
      text: "",
    });

    useStreamStore.getState().markRunFinished("RUN-ASK");
    expect(useStreamStore.getState().liveStreamDeltas["RUN-ASK"]).toBeUndefined();
  });

  test("讨论草稿按需求 ID 隔离，且待提交批注严格由服务端未解决 refine 记录派生", () => {
    useDraftStore.getState().setDiscussDraft("REQ-001", "REQ-1 问题");
    useDraftStore.getState().setDiscussAnchor("REQ-001", "design.md#锁");
    useDraftStore.getState().setDiscussDraft("REQ-002", "REQ-2 问题");

    expect(useDraftStore.getState().discussDraftByReq["REQ-001"]).toBe("REQ-1 问题");
    expect(useDraftStore.getState().discussDraftByReq["REQ-002"]).toBe("REQ-2 问题");
    expect(useDraftStore.getState().discussAnchorByReq["REQ-002"]).toBeUndefined();

    const pending = getPendingRefineAnnotations([
      { id: "D-1", at: 1, actor: "human", mode: "ask", message: "纯探讨" },
      { id: "D-2", at: 2, actor: "human", mode: "refine", kind: "annotation", anchor: "design.md#A", message: "待改 A" },
      { id: "D-3", at: 3, actor: "human", mode: "refine", kind: "annotation", message: "已解决", resolved: true },
      { id: "D-4", at: 4, actor: "human", mode: "refine", kind: "refine_summary", message: "汇总记录" },
      { id: "D-5", at: 5, actor: "agent", mode: "ask", message: "AI 回复" },
      { id: "D-6", at: 6, actor: "human", mode: "refine", kind: "chat", message: "直接修订" },
      { id: "D-7", at: 7, actor: "human", mode: "refine", anchor: "spec.md", message: "旧版批注" },
    ]);
    expect(pending.map((item) => item.id)).toEqual(["D-2", "D-7"]);
  });

  test("ask 错误状态按项目隔离，且 markRunFinished 清理 askPromptsByRun", () => {
    const store = useStreamStore.getState();
    store.recordAskPrompt("RUN-A", {
      reqId: "REQ-001",
      message: "项目 A 的问题",
      projectId: "proj-a",
      root: "/repo-a",
    });
    expect(useStreamStore.getState().askPromptsByRun["RUN-A"]).toBeDefined();

    store.markRunFinished("RUN-A");
    expect(useStreamStore.getState().askPromptsByRun["RUN-A"]).toBeUndefined();

    store.setLastAskError("REQ-001", {
      reqId: "REQ-001",
      runId: "RUN-A",
      status: "failed",
      message: "项目 A 的问题",
      projectId: "proj-a",
      root: "/repo-a",
      at: 1,
    });
    store.setLastAskError("REQ-001", {
      reqId: "REQ-001",
      runId: "RUN-B",
      status: "cancelled",
      message: "项目 B 的问题",
      projectId: "proj-b",
      root: "/repo-b",
      at: 2,
    });

    const allErrors = Object.values(useStreamStore.getState().lastAskErrorByReq).filter(Boolean);
    expect(allErrors.length).toBe(2);
    expect(allErrors.find((e) => matchesRequirementRunScope(e!, { projectId: "proj-a", projectRoot: "/repo-a" }))?.runId).toBe("RUN-A");
    expect(allErrors.find((e) => matchesRequirementRunScope(e!, { projectId: "proj-b", projectRoot: "/repo-b" }))?.runId).toBe("RUN-B");

    store.setLastAskError("REQ-001", null, { projectId: "proj-a", root: "/repo-a" });
    const remaining = Object.values(useStreamStore.getState().lastAskErrorByReq).filter(Boolean);
    expect(remaining.map((e) => e?.runId)).toEqual(["RUN-B"]);
  });
});
