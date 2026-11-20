import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentAction, AgentRunRecord, RequirementDetail } from "../../src/core/types.ts";
import { TimelineRunsTab } from "../../src/web/components/WorkspaceView.tsx";
import { AGENT_RUN_TONE } from "../../src/web/state.ts";

function makeRun(id: string, action: AgentAction, status: AgentRunRecord["status"]): AgentRunRecord {
  return {
    id,
    action,
    harness: "omp",
    model: "opencode-go/deepseek-v4.1-flash",
    status,
    startedAt: 0,
    endedAt: null,
    exitCode: null,
    durationMs: 0,
    logPath: "",
  };
}

const DETAIL = {
  state: {
    id: "REQ-009",
    timeline: [],
    agentRuns: [
      makeRun("run-running", "implement", "running"),
      makeRun("run-succeeded", "design", "succeeded"),
      makeRun("run-failed", "implement", "failed"),
      makeRun("run-cancelled", "implement", "cancelled"),
    ],
  },
} as unknown as RequirementDetail;

function badgePattern(tone: string, label: string): RegExp {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`class="badge ${tone}"[^>]*>(?:(?!</span>)[\\s\\S])*${escaped}`);
}

describe("REQ-009 Agent 运行状态色板", () => {
  test("四态映射稳定，执行中不得使用警示色", () => {
    expect(AGENT_RUN_TONE).toEqual({
      running: "info",
      succeeded: "success",
      failed: "danger",
      cancelled: "neutral",
    });
    expect(AGENT_RUN_TONE.running).not.toBe("danger");
  });

  test("时间线运行徽标按状态渲染对应色板", () => {
    const html = renderToStaticMarkup(<TimelineRunsTab d={DETAIL} />);

    expect(html).toMatch(badgePattern("info", "实施 · 执行中"));
    expect(html).not.toMatch(badgePattern("danger", "实施 · 执行中"));
    expect(html).toMatch(badgePattern("success", "设计 · 已完成"));
    expect(html).toMatch(badgePattern("danger", "实施 · 失败"));
    expect(html).toMatch(badgePattern("neutral", "实施 · 已终止"));
  });
});