import { describe, expect, test } from "bun:test";
import type { RequirementSummary } from "../../src/core/types.ts";
import {
  findActiveRequirementRun,
  partitionPendingDecisions,
  type RequirementRunLike,
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