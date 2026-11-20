import { describe, expect, test } from "bun:test";
import type { RequirementSummary } from "../../src/core/types.ts";
import {
  findActiveRequirementRun,
  groupHubProjects,
  partitionPendingDecisions,
  pickDefaultRequirementId,
  sortHubProjects,
  type RequirementRunLike,
  type SortableProjectLike,
} from "../../src/web/state.ts";

function summary(id: string, extra: Partial<RequirementSummary> = {}): RequirementSummary {
  return {
    id,
    title: `需求 ${id}`,
    stage: "awaiting_acceptance",
    track: "plan_first",
    revision: 1,
    designVersion: 1,
    criteriaCount: 1,
    requiredTotal: 1,
    requiredPassed: 1,
    tasksTotal: 1,
    tasksDone: 1,
    needsDecision: true,
    decisionReason: "待审查/验收",
    decisionReasonKey: "core.decision.reviewPending",
    blockedReason: null,
    progressText: "",
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

function run(requirementId: string, extra: Partial<RequirementRunLike> = {}): RequirementRunLike {
  return { requirementId, status: "running", action: "review", harness: "codex", model: "gpt-6.2-sol", projectId: "proj-a", ...extra };
}

describe("首页待拍板与 Agent 运行态分组", () => {
  test("同项目运行中的 review 会从待拍板中移除", () => {
    const item = summary("REQ-001");
    const { humanPending, agentProcessing } = partitionPendingDecisions([item], [run("REQ-001")], "proj-a");
    expect(humanPending).toEqual([]);
    expect(agentProcessing).toEqual([item]);
  });

  test("已结束的运行或跨项目运行不影响待拍板判定", () => {
    const item = summary("REQ-001");
    const { humanPending, agentProcessing } = partitionPendingDecisions(
      [item],
      [run("REQ-001", { status: "succeeded" }), run("REQ-001", { projectId: "proj-b" })],
      "proj-a",
    );
    expect(humanPending).toEqual([item]);
    expect(agentProcessing).toEqual([]);
  });

  test("运行中的只读咨询 ask 仍保留待拍板", () => {
    const item = summary("REQ-001");
    const { humanPending, agentProcessing } = partitionPendingDecisions(
      [item],
      [run("REQ-001", { action: "ask" })],
      "proj-a",
    );
    expect(humanPending).toEqual([item]);
    expect(agentProcessing).toEqual([]);
  });

  test("同一需求的多个运行记录中仅运行中的非 ask 动作生效", () => {
    const item = summary("REQ-001");
    const askOnly = partitionPendingDecisions(
      [item],
      [run("REQ-001", { action: "review", status: "succeeded" }), run("REQ-001", { action: "ask" })],
      "proj-a",
    );
    expect(askOnly.humanPending).toEqual([item]);

    const implementRunning = partitionPendingDecisions(
      [item],
      [run("REQ-001", { action: "review", status: "failed" }), run("REQ-001", { action: "implement" })],
      "proj-a",
    );
    expect(implementRunning.humanPending).toEqual([]);
    expect(implementRunning.agentProcessing).toEqual([item]);
  });

  test("分组忽略不需要决策的条目并保持输入顺序", () => {
    const first = summary("REQ-001", { updatedAt: 2 });
    const second = summary("REQ-002", { updatedAt: 1 });
    const ignored = summary("REQ-003", { needsDecision: false, decisionReason: null });
    const { humanPending, agentProcessing } = partitionPendingDecisions([first, second, ignored], [], "proj-a");
    expect(humanPending.map((i) => i.id)).toEqual(["REQ-001", "REQ-002"]);
    expect(agentProcessing).toEqual([]);
  });

  test("findActiveRequirementRun 只匹配指定需求与项目的运行", () => {
    const runs = [run("REQ-001"), run("REQ-002", { projectId: "proj-b" })];
    expect(findActiveRequirementRun(runs, "REQ-001", "proj-a")?.requirementId).toBe("REQ-001");
    expect(findActiveRequirementRun(runs, "REQ-002", "proj-a")).toBeUndefined();
    expect(findActiveRequirementRun(runs, "REQ-003", "proj-a")).toBeUndefined();
  });
});

function proj(id: string, extra: Partial<SortableProjectLike> = {}): SortableProjectLike {
  return {
    id,
    name: `Proj-${id}`,
    addedAt: 100,
    lastOpenedAt: 100,
    activeCount: 0,
    decisionCount: 0,
    runningCount: 0,
    ...extra,
  };
}

describe("IDE 默认需求选中、项目排序与分类", () => {
  test("pickDefaultRequirementId 按阻塞待拍板 -> 普通待拍板 -> 活跃需求 -> 首个需求选择", () => {
    expect(pickDefaultRequirementId([], [], "proj-a")).toBeNull();
    const doneItem = summary("REQ-001", { stage: "done", needsDecision: false });
    const activeItem = summary("REQ-002", { stage: "implementing", needsDecision: false, updatedAt: 5 });
    const pendingItem = summary("REQ-003", { stage: "awaiting_approval", needsDecision: true, updatedAt: 10 });
    const blockedItem = summary("REQ-004", {
      stage: "blocked",
      needsDecision: true,
      decisionReasonKey: "core.decision.blocked",
      updatedAt: 20,
    });
    expect(pickDefaultRequirementId([doneItem], [], "proj-a")).toBe("REQ-001");
    expect(pickDefaultRequirementId([doneItem, activeItem], [], "proj-a")).toBe("REQ-002");
    expect(pickDefaultRequirementId([doneItem, activeItem, pendingItem], [], "proj-a")).toBe("REQ-003");
    expect(pickDefaultRequirementId([doneItem, activeItem, pendingItem, blockedItem], [], "proj-a")).toBe("REQ-004");
  });

  test("sortHubProjects 置顶优先，并支持 attention / recent / name / added 四种排序", () => {
    const a = proj("a", { name: "Beta", addedAt: 10, lastOpenedAt: 300, activeCount: 1, decisionCount: 0 });
    const b = proj("b", { name: "Alpha", addedAt: 30, lastOpenedAt: 100, activeCount: 3, decisionCount: 2 });
    const c = proj("c", { name: "Gamma", addedAt: 20, lastOpenedAt: 200, pinned: true });

    expect(sortHubProjects([a, b, c], "attention").map((p) => p.id)).toEqual(["c", "b", "a"]);
    expect(sortHubProjects([a, b, c], "recent").map((p) => p.id)).toEqual(["c", "a", "b"]);
    expect(sortHubProjects([a, b, c], "name").map((p) => p.id)).toEqual(["c", "b", "a"]);
    expect(sortHubProjects([a, b, c], "added").map((p) => p.id)).toEqual(["c", "b", "a"]);
  });

  test("groupHubProjects 支持 none / node / status / category 四种分组", () => {
    const localActive = proj("p1", { name: "wb", activeCount: 2, category: "核心" });
    const remoteIdle = proj("p2", { name: "app", nodeId: "wsl", nodeName: "WSL2" });

    expect(groupHubProjects([localActive, remoteIdle], "none", "attention").map((s) => s.key)).toEqual(["all"]);
    expect(groupHubProjects([localActive, remoteIdle], "node", "attention").map((s) => s.key)).toEqual([
      "node:local",
      "node:wsl",
    ]);
    expect(groupHubProjects([localActive, remoteIdle], "status", "attention").map((s) => s.key)).toEqual([
      "status:active",
      "status:idle",
    ]);
    expect(groupHubProjects([localActive, remoteIdle], "category", "attention").map((s) => s.key)).toEqual([
      "cat:核心",
      "cat:__none__",
    ]);
  });
});