import { createHash } from "node:crypto";
import type {
  AcceptanceGate,
  ActionBanner,
  ApprovalStatus,
  CriteriaCoverage,
  Criterion,
  CriterionCoverageItem,
  EvaluatedVerification,
  RequirementState,
  ValidityReport,
} from "./types.ts";

/** Computes deterministic SHA-256 of spec.md content and normalized acceptance criteria. */
export function computeSpecHash(specMarkdown: string, criteria: Criterion[]): string {
  const payload = JSON.stringify([
    specMarkdown,
    criteria.map((c) => [c.id, c.description, c.required, c.command ?? null]),
  ]);
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** Computes SHA-256 of design.md content, or empty string when absent. */
export function computeDesignHash(designMarkdown: string): string {
  if (!designMarkdown.trim()) return "";
  return createHash("sha256").update(designMarkdown, "utf8").digest("hex");
}

export function evaluateApproval(state: RequirementState): ApprovalStatus {
  const approval = state.approval;
  if (!approval) {
    return {
      valid: false,
      reason: state.track === "fast_track" ? "尚未授权快速通道" : "尚未批准技术方案",
    };
  }
  if (approval.specHash !== state.specHash) {
    return { valid: false, reason: "需求规范或验收条件已修改，需要重新确认" };
  }
  if (state.track === "plan_first") {
    if (approval.track !== "plan_first" || state.designHash === "" || approval.designHash !== state.designHash) {
      return { valid: false, reason: "技术方案已更新，需要重新批准" };
    }
  } else if (approval.track !== "fast_track") {
    return { valid: false, reason: "授权轨道不匹配，请重新授权" };
  }
  return { valid: true, reason: null };
}

export function evaluateVerifications(
  state: RequirementState,
  currentCodeSnapshotHash: string | null,
): EvaluatedVerification[] {
  return state.verifications.map((record) => {
    if (record.specHash !== state.specHash) {
      return { record, effectiveState: "stale", staleReason: "需求规范或验收条件已更新" };
    }
    if (!currentCodeSnapshotHash) {
      return record.passed
        ? { record, effectiveState: "unknown", staleReason: "无法读取当前代码快照，暂不能确认通过状态" }
        : { record, effectiveState: "failed", staleReason: record.timedOut ? "执行超时" : `退出码 ${record.exitCode}` };
    }
    if (record.codeSnapshotHash !== currentCodeSnapshotHash) {
      return { record, effectiveState: "stale", staleReason: "验证后代码已有新改动，需重跑验证" };
    }
    if (record.timedOut) {
      return { record, effectiveState: "failed", staleReason: "命令执行超时" };
    }
    if (record.passed) {
      return { record, effectiveState: "passed", staleReason: null };
    }
    return { record, effectiveState: "failed", staleReason: `退出码 ${record.exitCode ?? "未知"}` };
  });
}

export function evaluateCriteriaCoverage(
  state: RequirementState,
  evaluatedVerifications: EvaluatedVerification[],
): CriteriaCoverage {
  const items: CriterionCoverageItem[] = [];
  let requiredTotal = 0;
  let requiredPassed = 0;
  let optionalTotal = 0;
  let optionalPassed = 0;

  for (const criterion of state.criteria) {
    const matching = evaluatedVerifications.filter((ev) => ev.record.criterionIds.includes(criterion.id));
    const verificationIds = matching.map((ev) => ev.record.id);
    const currentPass = matching.find((ev) => ev.effectiveState === "passed");
    const latest = matching.length > 0 ? matching[matching.length - 1]! : null;

    let coverageState: CriterionCoverageItem["state"] = "unverified";
    let reason: string | null = "尚未运行验证";

    if (currentPass) {
      coverageState = "passed";
      reason = null;
    } else if (latest) {
      if (latest.effectiveState === "failed") {
        coverageState = "failed";
        reason = latest.staleReason;
      } else {
        coverageState = "stale";
        reason = latest.staleReason;
      }
    }

    if (criterion.required) {
      requiredTotal += 1;
      if (coverageState === "passed") requiredPassed += 1;
    } else {
      optionalTotal += 1;
      if (coverageState === "passed") optionalPassed += 1;
    }

    items.push({ criterion, state: coverageState, verificationIds, reason });
  }

  return { items, requiredTotal, requiredPassed, optionalTotal, optionalPassed };
}

export function evaluateAcceptanceGate(
  state: RequirementState,
  approval: ApprovalStatus,
  coverage: CriteriaCoverage,
): AcceptanceGate {
  const blockers: string[] = [];
  if (state.stage === "blocked") blockers.push("需求处于阻塞状态");
  else if (state.stage === "cancelled") blockers.push("需求已取消");
  else if (state.stage === "done") blockers.push("需求已完成验收");

  if (!approval.valid && state.stage !== "done" && state.stage !== "cancelled") {
    blockers.push(approval.reason ?? "尚未获得实施授权");
  }
  if (coverage.requiredTotal === 0) {
    blockers.push("至少需要定义 1 条必需验收条件，禁止 0/0 直接通过");
  } else if (coverage.requiredPassed < coverage.requiredTotal) {
    const missing = coverage.items
      .filter((item) => item.criterion.required && item.state !== "passed")
      .map((item) => item.criterion.id);
    blockers.push(`仍有 ${missing.length} 项必需验收条件未在当前代码快照下通过（${missing.join(", ")}）`);
  }
  if (state.tasks.some((task) => task.status === "blocked")) {
    blockers.push("存在标记为阻塞的实施任务");
  }

  return { ok: blockers.length === 0, blockers };
}

export function deriveActionBanner(
  state: RequirementState,
  approval: ApprovalStatus,
  coverage: CriteriaCoverage,
  gate: AcceptanceGate,
): { banner: ActionBanner; needsDecision: boolean; decisionReason: string | null } {
  const hasVerifyCommands = state.criteria.some((c) => Boolean(c.command));
  const doneTasks = state.tasks.filter((t) => t.status === "done").length;

  switch (state.stage) {
    case "draft":
      return {
        needsDecision: false,
        decisionReason: null,
        banner: {
          headline: "需求已保存，等待整理规范与方案",
          tone: "neutral",
          primaryAction: { id: "dispatch_design", label: "让 Agent 整理并出方案" },
          secondaryActions: [{ id: "authorize_fast_track", label: "快速通道：直接实施" }],
        },
      };

    case "designing":
      return {
        needsDecision: false,
        decisionReason: null,
        banner: {
          headline: state.lastFeedback ? "已记录修改意见，等待 Agent 修订方案" : "Agent 正在调研与起草技术方案",
          tone: "info",
          primaryAction: { id: "dispatch_design", label: "通知 Agent 生成方案" },
          secondaryActions: [{ id: "authorize_fast_track", label: "快速通道：直接实施" }],
        },
      };

    case "awaiting_approval": {
      if (state.designHash !== "") {
        return {
          needsDecision: true,
          decisionReason: "方案待批准",
          banner: {
            headline: `Agent 已提交技术方案 v${state.designVersion}（含 ${state.criteria.length} 项验收条件），请审阅`,
            tone: "warning",
            primaryAction: { id: "approve_and_implement", label: "批准方案并开始实施" },
            secondaryActions: [
              { id: "approve_only", label: "仅批准方案" },
              { id: "request_changes", label: "提出修改意见…" },
            ],
          },
        };
      }
      return {
        needsDecision: true,
        decisionReason: "规范待确认",
        banner: {
          headline: `规范或验收条件已更新（共 ${state.criteria.length} 项条件），请确认后继续`,
          tone: "warning",
          primaryAction: { id: "authorize_fast_track", label: "确认并继续实施" },
          secondaryActions: [
            { id: "dispatch_design", label: "让 Agent 补充技术方案" },
            { id: "request_changes", label: "提出修改意见…" },
          ],
        },
      };
    }

    case "implementing": {
      const failedCount = coverage.items.filter((i) => i.state === "failed").length;
      const staleCount = coverage.items.filter((i) => i.state === "stale").length;
      if (gate.ok) {
        return {
          needsDecision: true,
          decisionReason: "验证已全绿，可验收",
          banner: {
            headline: `所有必需验收条件已通过验证（${coverage.requiredPassed}/${coverage.requiredTotal}），可进行最终验收`,
            tone: "success",
            primaryAction: { id: "accept", label: "验收通过" },
            secondaryActions: [
              ...(hasVerifyCommands ? [{ id: "run_all_verifications" as const, label: "重新运行验证" }] : []),
              { id: "request_changes", label: "打回修改…" },
            ],
          },
        };
      }
      if (failedCount > 0) {
        return {
          needsDecision: false,
          decisionReason: null,
          banner: {
            headline: `有 ${failedCount} 项验收条件验证失败，请修复后重新验证`,
            tone: "danger",
            primaryAction: { id: "dispatch_fix", label: "让 Agent 修复失败项" },
            secondaryActions: hasVerifyCommands ? [{ id: "run_all_verifications", label: "重新运行验证" }] : [],
          },
        };
      }
      if (staleCount > 0) {
        return {
          needsDecision: false,
          decisionReason: null,
          banner: {
            headline: `代码或规范已变化，有 ${staleCount} 项验证结果已过期，需重新验证`,
            tone: "warning",
            primaryAction: hasVerifyCommands
              ? { id: "run_all_verifications", label: "重新运行验证" }
              : { id: "dispatch_implement", label: "让 Agent 重新验证" },
            secondaryActions: hasVerifyCommands ? [{ id: "dispatch_implement", label: "继续让 Agent 实施" }] : [],
          },
        };
      }
      const prefix = state.track === "fast_track" ? "快速通道已开启" : "方案已批准";
      const taskHint = state.tasks.length > 0 ? ` · 任务 ${doneTasks}/${state.tasks.length}` : "";
      return {
        needsDecision: false,
        decisionReason: null,
        banner: {
          headline: `${prefix}${taskHint} · 待完成开发并运行验证`,
          tone: "info",
          primaryAction: { id: "dispatch_implement", label: state.tasks.length > 0 ? "继续让 Agent 实施" : "开始实施" },
          secondaryActions: hasVerifyCommands ? [{ id: "run_all_verifications", label: "运行全部验证" }] : [],
        },
      };
    }

    case "awaiting_acceptance":
      return {
        needsDecision: true,
        decisionReason: "待最终验收",
        banner: gate.ok
          ? {
              headline: `所有必需条件已通过验证（${coverage.requiredPassed}/${coverage.requiredTotal}），请审阅 Diff 与证据`,
              tone: "success",
              primaryAction: { id: "accept", label: "验收通过" },
              secondaryActions: [
                { id: "request_changes", label: "打回修改…" },
                ...(hasVerifyCommands ? [{ id: "run_all_verifications" as const, label: "重跑验证" }] : []),
              ],
            }
          : {
              headline: `尚未满足验收条件：${gate.blockers[0] ?? "请先完成验证"}`,
              tone: "warning",
              primaryAction: hasVerifyCommands
                ? { id: "run_all_verifications", label: "重新运行验证" }
                : { id: "dispatch_fix", label: "让 Agent 补充验证" },
              secondaryActions: [{ id: "request_changes", label: "打回修改…" }],
            },
      };

    case "blocked":
      return {
        needsDecision: true,
        decisionReason: "已阻塞",
        banner: {
          headline: `需求受阻：${state.blockedReason ?? "未记录原因"}`,
          tone: "warning",
          primaryAction: { id: "unblock", label: "解除阻塞" },
          secondaryActions: [],
        },
      };

    case "done":
      return {
        needsDecision: false,
        decisionReason: null,
        banner: {
          headline: "已验收完成",
          tone: "success",
          primaryAction: null,
          secondaryActions: [{ id: "reopen", label: "重新打开" }],
        },
      };

    case "cancelled":
      return {
        needsDecision: false,
        decisionReason: null,
        banner: {
          headline: `需求已取消${state.blockedReason ? `：${state.blockedReason}` : ""}`,
          tone: "neutral",
          primaryAction: null,
          secondaryActions: [{ id: "reopen", label: "重新打开" }],
        },
      };
  }
}

export function evaluateRequirement(state: RequirementState, currentCodeSnapshotHash: string | null): ValidityReport {
  const approval = evaluateApproval(state);
  const verifications = evaluateVerifications(state, currentCodeSnapshotHash);
  const coverage = evaluateCriteriaCoverage(state, verifications);
  const acceptanceGate = evaluateAcceptanceGate(state, approval, coverage);
  const { banner, needsDecision, decisionReason } = deriveActionBanner(state, approval, coverage, acceptanceGate);
  return {
    approval,
    verifications,
    coverage,
    acceptanceGate,
    banner,
    needsDecision,
    decisionReason,
  };
}
