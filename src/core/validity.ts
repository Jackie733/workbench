import { createHash } from "node:crypto";
import type {
  AcceptanceArtifactStatus,
  AcceptanceGate,
  AcceptanceSnapshot,
  ActionBanner,
  ApprovalStatus,
  CriteriaCoverage,
  Criterion,
  CriterionCoverageItem,
  EvaluatedVerification,
  EvidenceContext,
  EvidenceProvenance,
  RequirementState,
  ReviewValidity,
  UiMessageParams,
  UiMessageRef,
  ValidityReport,
} from "./types.ts";

export const BASELINE_SCOPE_NOTE = "基于验收基线采集的全部改动（不证明本需求独占所有文件）";
export const WORKTREE_SCOPE_NOTE = "基于工作区采集的改动（不证明本需求独占所有文件）";

export interface EvaluateRequirementOptions {
  acceptanceSnapshot?: AcceptanceSnapshot | null;
  acceptanceSnapshotStatus?: AcceptanceArtifactStatus;
  acceptanceSnapshotReason?: string | null;
  acceptanceSnapshotReasonKey?: string;
  acceptanceSnapshotReasonParams?: UiMessageParams;
}

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
    return state.track === "fast_track"
      ? { valid: false, reason: "尚未授权快速通道", reasonKey: "core.approval.notAuthorizedFast" }
      : { valid: false, reason: "尚未批准技术方案", reasonKey: "core.approval.notApproved" };
  }
  if (approval.specHash !== state.specHash) {
    return {
      valid: false,
      reason: "需求规范或验收条件已修改，需要重新确认",
      reasonKey: "core.approval.specChanged",
    };
  }
  if (state.track === "plan_first") {
    if (approval.track !== "plan_first" || state.designHash === "" || approval.designHash !== state.designHash) {
      return { valid: false, reason: "技术方案已更新，需要重新批准", reasonKey: "core.approval.designUpdated" };
    }
  } else if (approval.track !== "fast_track") {
    return { valid: false, reason: "授权轨道不匹配，请重新授权", reasonKey: "core.approval.trackMismatch" };
  }
  return { valid: true, reason: null };
}

export function evaluateVerifications(
  state: RequirementState,
  currentCodeSnapshotHash: string | null,
): EvaluatedVerification[] {
  return state.verifications.map((record) => {
    if (record.specHash !== state.specHash) {
      return {
        record,
        effectiveState: "stale",
        staleReason: "需求规范或验收条件已更新",
        staleReasonKey: "core.verify.specUpdated",
      };
    }
    if (!currentCodeSnapshotHash) {
      return record.passed
        ? {
            record,
            effectiveState: "unknown",
            staleReason: "无法读取当前代码快照，暂不能确认通过状态",
            staleReasonKey: "core.verify.noSnapshot",
          }
        : {
            record,
            effectiveState: "failed",
            staleReason: record.timedOut ? "执行超时" : `退出码 ${record.exitCode}`,
            ...(record.timedOut
              ? { staleReasonKey: "core.verify.timeout" }
              : { staleReasonKey: "core.verify.exitCode", staleReasonParams: { code: record.exitCode ?? "-" } }),
          };
    }
    if (record.codeSnapshotHash !== currentCodeSnapshotHash) {
      return {
        record,
        effectiveState: "stale",
        staleReason: "验证后代码已有新改动，需重跑验证",
        staleReasonKey: "core.verify.codeChanged",
      };
    }
    if (record.timedOut) {
      return { record, effectiveState: "failed", staleReason: "命令执行超时", staleReasonKey: "core.verify.timeoutCommand" };
    }
    if (record.passed) {
      return { record, effectiveState: "passed", staleReason: null };
    }
    return {
      record,
      effectiveState: "failed",
      staleReason: `退出码 ${record.exitCode ?? "未知"}`,
      staleReasonKey: "core.verify.exitCode",
      staleReasonParams: { code: record.exitCode ?? "-" },
    };
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
    let reasonKey: string | undefined = "core.coverage.notRun";
    let reasonParams: UiMessageParams | undefined;

    if (currentPass) {
      coverageState = "passed";
      reason = null;
      reasonKey = undefined;
    } else if (latest) {
      if (latest.effectiveState === "failed") {
        coverageState = "failed";
        reason = latest.staleReason;
        reasonKey = latest.staleReasonKey;
        reasonParams = latest.staleReasonParams;
      } else {
        coverageState = "stale";
        reason = latest.staleReason;
        reasonKey = latest.staleReasonKey;
        reasonParams = latest.staleReasonParams;
      }
    }

    if (criterion.required) {
      requiredTotal += 1;
      if (coverageState === "passed") requiredPassed += 1;
    } else {
      optionalTotal += 1;
      if (coverageState === "passed") optionalPassed += 1;
    }

    items.push({ criterion, state: coverageState, verificationIds, reason, ...(reasonKey ? { reasonKey } : {}), ...(reasonParams ? { reasonParams } : {}) });
  }

  return { items, requiredTotal, requiredPassed, optionalTotal, optionalPassed };
}

export function evaluateAcceptanceGate(
  state: RequirementState,
  approval: ApprovalStatus,
  coverage: CriteriaCoverage,
): AcceptanceGate {
  const blockers: string[] = [];
  const blockerRefs: UiMessageRef[] = [];
  if (state.stage === "blocked") {
    blockers.push("需求处于阻塞状态");
    blockerRefs.push({ key: "core.gate.blocked" });
  } else if (state.stage === "cancelled") {
    blockers.push("需求已取消");
    blockerRefs.push({ key: "core.gate.cancelled" });
  } else if (state.stage === "done") {
    blockers.push("需求已完成验收");
    blockerRefs.push({ key: "core.gate.done" });
  }

  if (!approval.valid && state.stage !== "done" && state.stage !== "cancelled") {
    blockers.push(approval.reason ?? "尚未获得实施授权");
    blockerRefs.push({ key: approval.reasonKey ?? "core.approval.notApproved" });
  }
  if (coverage.requiredTotal === 0) {
    blockers.push("至少需要定义 1 条必需验收条件，禁止 0/0 直接通过");
    blockerRefs.push({ key: "core.gate.noRequired" });
  } else if (coverage.requiredPassed < coverage.requiredTotal) {
    const missing = coverage.items
      .filter((item) => item.criterion.required && item.state !== "passed")
      .map((item) => item.criterion.id);
    blockers.push(`仍有 ${missing.length} 项必需验收条件未在当前代码快照下通过（${missing.join(", ")}）`);
    blockerRefs.push({ key: "core.gate.missing", params: { count: missing.length, ids: missing.join(", ") } });
  }
  if (state.tasks.some((task) => task.status === "blocked")) {
    blockers.push("存在标记为阻塞的实施任务");
    blockerRefs.push({ key: "core.gate.taskBlocked" });
  }

  return { ok: blockers.length === 0, blockers, blockerRefs };
}

function deriveReadyAcceptanceBanner(
  state: RequirementState,
  coverage: CriteriaCoverage,
  reviewValidity: ReviewValidity,
  hasVerifyCommands: boolean,
): {
  banner: ActionBanner;
  needsDecision: boolean;
  decisionReason: string | null;
  decisionReasonKey?: string;
  decisionReasonParams?: UiMessageParams;
} {
  const report = state.reviewReport;
  const rerunVerify = hasVerifyCommands
    ? [{ id: "run_all_verifications" as const, label: "重跑验证", labelKey: "core.action.rerunShort" }]
    : [];

  if (reviewValidity.effectiveState === "current" && report) {
    if (report.verdict === "block") {
      const highCnt = (report.findings ?? []).filter((f) => f.severity === "high").length;
      const medCnt = (report.findings ?? []).filter((f) => f.severity === "medium").length;
      const countTag = highCnt > 0 || medCnt > 0 ? `（高 ${highCnt} / 中 ${medCnt}）` : "";
      return {
        needsDecision: true,
        decisionReason: "审查建议阻塞",
        decisionReasonKey: "core.decision.reviewBlock",
        banner: {
          headline: `跨模型审查建议阻塞${countTag}：${report.summary}`,
          headlineKey: "core.banner.review.block",
          headlineParams: {
            counts: highCnt > 0 || medCnt > 0 ? { key: "core.review.counts", params: { high: highCnt, medium: medCnt } } : "",
            summary: report.summary,
          },
          tone: "danger",
          primaryAction: {
            id: "dispatch_fix_review",
            label: "让 Agent 按审查意见修复",
            labelKey: "core.action.dispatchFixReview",
          },
          secondaryActions: [
            { id: "dispatch_review", label: "重新审查", labelKey: "core.action.dispatchReview" },
            { id: "request_changes", label: "打回修改…", labelKey: "core.action.requestChanges" },
            { id: "accept", label: "忽略阻塞并验收…", labelKey: "core.action.ignoreBlockAccept" },
          ],
        },
      };
    }
    if (report.verdict === "concern") {
      return {
        needsDecision: true,
        decisionReason: "审查有关注点",
        decisionReasonKey: "core.decision.reviewConcern",
        banner: {
          headline: `跨模型审查存在关注点：${report.summary}`,
          headlineKey: "core.banner.review.concern",
          headlineParams: { summary: report.summary },
          tone: "warning",
          primaryAction: {
            id: "dispatch_fix_review",
            label: "按审查意见修复",
            labelKey: "core.action.fixPerReview",
          },
          secondaryActions: [
            { id: "accept", label: "接受风险并验收…", labelKey: "core.action.acceptRisk" },
            { id: "dispatch_review", label: "重新审查", labelKey: "core.action.dispatchReview" },
            { id: "request_changes", label: "打回修改…", labelKey: "core.action.requestChanges" },
          ],
        },
      };
    }
    return {
      needsDecision: true,
      decisionReason: "待最终验收",
      decisionReasonKey: "core.decision.finalAcceptance",
      banner: {
        headline: `验证与跨模型审查均已通过（${coverage.requiredPassed}/${coverage.requiredTotal}），可进行最终验收`,
        headlineKey: "core.banner.review.passed",
        headlineParams: { passed: coverage.requiredPassed, total: coverage.requiredTotal },
        tone: "success",
        primaryAction: { id: "accept", label: "验收通过", labelKey: "core.action.accept" },
        secondaryActions: [
          { id: "request_changes", label: "打回修改…", labelKey: "core.action.sendBack" },
          ...rerunVerify,
        ],
      },
    };
  }

  if (reviewValidity.effectiveState === "stale") {
    return {
      needsDecision: true,
      decisionReason: "审查已过期",
      decisionReasonKey: "core.decision.reviewStale",
      banner: {
        headline: `验证已通过（${coverage.requiredPassed}/${coverage.requiredTotal}），但跨模型审查已过期（${reviewValidity.reason ?? "代码或规范已变化"}）`,
        headlineKey: "core.banner.review.stale",
        headlineParams: {
          passed: coverage.requiredPassed,
          total: coverage.requiredTotal,
          reason: reviewValidity.reasonKey
            ? { key: reviewValidity.reasonKey }
            : (reviewValidity.reason ?? ""),
        },
        tone: "warning",
        primaryAction: {
          id: "dispatch_review",
          label: "重新跨模型审查",
          labelKey: "core.action.dispatchReview",
        },
        secondaryActions: [
          { id: "accept", label: "跳过复审直接验收", labelKey: "core.action.skipReReviewAccept" },
          { id: "request_changes", label: "打回修改…", labelKey: "core.action.sendBack" },
          ...rerunVerify,
        ],
      },
    };
  }

  return {
    needsDecision: true,
    decisionReason: "待审查/验收",
    decisionReasonKey: "core.decision.reviewPending",
    banner: {
      headline: `所有必需验收条件已通过验证（${coverage.requiredPassed}/${coverage.requiredTotal}），建议先发起跨模型审查`,
      headlineKey: "core.banner.review.suggest",
      headlineParams: { passed: coverage.requiredPassed, total: coverage.requiredTotal },
      tone: "info",
      primaryAction: {
        id: "dispatch_review",
        label: "发起跨模型审查",
        labelKey: "core.action.dispatchReviewStart",
      },
      secondaryActions: [
        { id: "accept", label: "跳过审查直接验收", labelKey: "core.action.skipReviewAccept" },
        { id: "request_changes", label: "打回修改…", labelKey: "core.action.sendBack" },
        ...rerunVerify,
      ],
    },
  };
}

export function deriveActionBanner(
  state: RequirementState,
  approval: ApprovalStatus,
  coverage: CriteriaCoverage,
  gate: AcceptanceGate,
  reviewValidity: ReviewValidity = evaluateReviewReport(state, null),
): {
  banner: ActionBanner;
  needsDecision: boolean;
  decisionReason: string | null;
  decisionReasonKey?: string;
  decisionReasonParams?: UiMessageParams;
} {
  const hasVerifyCommands = state.criteria.some((c) => Boolean(c.command));
  const doneTasks = state.tasks.filter((t) => t.status === "done").length;

  switch (state.stage) {
    case "draft":
      return {
        needsDecision: false,
        decisionReason: null,
        banner: {
          headline: "需求已保存，等待整理规范与方案",
          headlineKey: "core.banner.draft",
          tone: "neutral",
          primaryAction: {
            id: "dispatch_design",
            label: "让 Agent 整理并出方案",
            labelKey: "core.action.dispatchDesign",
          },
          secondaryActions: [
            { id: "authorize_fast_track", label: "快速通道：直接实施", labelKey: "core.action.fastTrack" },
          ],
        },
      };

    case "designing":
      return {
        needsDecision: false,
        decisionReason: null,
        banner: {
          headline: state.lastFeedback ? "已记录修改意见，等待 Agent 修订方案" : "Agent 正在调研与起草技术方案",
          headlineKey: state.lastFeedback ? "core.banner.designing.revising" : "core.banner.designing.working",
          tone: "info",
          primaryAction: {
            id: "dispatch_design",
            label: "通知 Agent 生成方案",
            labelKey: "core.action.notifyDesign",
          },
          secondaryActions: [
            { id: "authorize_fast_track", label: "快速通道：直接实施", labelKey: "core.action.fastTrack" },
          ],
        },
      };

    case "awaiting_approval": {
      if (state.designHash !== "") {
        return {
          needsDecision: true,
          decisionReason: "方案待批准",
          decisionReasonKey: "core.decision.awaitingApproval",
          banner: {
            headline: `Agent 已提交技术方案 v${state.designVersion}（含 ${state.criteria.length} 项验收条件），请审阅`,
            headlineKey: "core.banner.awaitApproval.design",
            headlineParams: { version: state.designVersion, count: state.criteria.length },
            tone: "warning",
            primaryAction: {
              id: "approve_and_implement",
              label: "批准方案并开始实施",
              labelKey: "core.action.approveImplement",
            },
            secondaryActions: [
              { id: "approve_only", label: "仅批准方案", labelKey: "core.action.approveOnly" },
              { id: "request_changes", label: "提出修改意见…", labelKey: "core.action.requestChanges" },
            ],
          },
        };
      }
      return {
        needsDecision: true,
        decisionReason: "规范待确认",
        decisionReasonKey: "core.decision.specConfirm",
        banner: {
          headline: `规范或验收条件已更新（共 ${state.criteria.length} 项条件），请确认后继续`,
          headlineKey: "core.banner.awaitApproval.spec",
          headlineParams: { count: state.criteria.length },
          tone: "warning",
          primaryAction: {
            id: "authorize_fast_track",
            label: "确认并继续实施",
            labelKey: "core.action.confirmContinue",
          },
          secondaryActions: [
            { id: "dispatch_design", label: "让 Agent 补充技术方案", labelKey: "core.action.supplementDesign" },
            { id: "request_changes", label: "提出修改意见…", labelKey: "core.action.requestChanges" },
          ],
        },
      };
    }

    case "implementing": {
      const failedCount = coverage.items.filter((i) => i.state === "failed").length;
      const staleCount = coverage.items.filter((i) => i.state === "stale").length;
      if (gate.ok) {
        return deriveReadyAcceptanceBanner(state, coverage, reviewValidity, hasVerifyCommands);
      }
      if (failedCount > 0) {
        return {
          needsDecision: false,
          decisionReason: null,
          banner: {
            headline: `有 ${failedCount} 项验收条件验证失败，请修复后重新验证`,
            headlineKey: "core.banner.implementing.failed",
            headlineParams: { count: failedCount },
            tone: "danger",
            primaryAction: { id: "dispatch_fix", label: "让 Agent 修复失败项", labelKey: "core.action.dispatchFix" },
            secondaryActions: hasVerifyCommands
              ? [{ id: "run_all_verifications", label: "重新运行验证", labelKey: "core.action.rerun" }]
              : [],
          },
        };
      }
      if (staleCount > 0) {
        return {
          needsDecision: false,
          decisionReason: null,
          banner: {
            headline: `代码或规范已变化，有 ${staleCount} 项验证结果已过期，需重新验证`,
            headlineKey: "core.banner.implementing.stale",
            headlineParams: { count: staleCount },
            tone: "warning",
            primaryAction: hasVerifyCommands
              ? { id: "run_all_verifications", label: "重新运行验证", labelKey: "core.action.rerun" }
              : { id: "dispatch_implement", label: "让 Agent 重新验证", labelKey: "core.action.agentReverify" },
            secondaryActions: hasVerifyCommands
              ? [{ id: "dispatch_implement", label: "继续让 Agent 实施", labelKey: "core.action.continueImplement" }]
              : [],
          },
        };
      }
      const prefix = state.track === "fast_track" ? "快速通道已开启" : "方案已批准";
      const taskHint = state.tasks.length > 0 ? ` · 任务 ${doneTasks}/${state.tasks.length}` : "";
      const readyKey =
        state.track === "fast_track"
          ? state.tasks.length > 0
            ? "core.banner.implementing.readyFastTasks"
            : "core.banner.implementing.readyFast"
          : state.tasks.length > 0
            ? "core.banner.implementing.readyApprovedTasks"
            : "core.banner.implementing.readyApproved";
      return {
        needsDecision: false,
        decisionReason: null,
        banner: {
          headline: `${prefix}${taskHint} · 待完成开发并运行验证`,
          headlineKey: readyKey,
          headlineParams: { done: doneTasks, total: state.tasks.length },
          tone: "info",
          primaryAction: {
            id: "dispatch_implement",
            label: state.tasks.length > 0 ? "继续让 Agent 实施" : "开始实施",
            labelKey: state.tasks.length > 0 ? "core.action.continueImplement" : "core.action.startImplement",
          },
          secondaryActions: hasVerifyCommands
            ? [{ id: "run_all_verifications", label: "运行全部验证", labelKey: "core.action.runAll" }]
            : [],
        },
      };
    }

    case "awaiting_acceptance":
      if (gate.ok) {
        return deriveReadyAcceptanceBanner(state, coverage, reviewValidity, hasVerifyCommands);
      }
      return {
        needsDecision: true,
        decisionReason: "待最终验收",
        decisionReasonKey: "core.decision.finalAcceptance",
        banner: {
          headline: `尚未满足验收条件：${gate.blockers[0] ?? "请先完成验证"}`,
          headlineKey: "core.banner.awaitAcceptance.blocked",
          headlineParams: {
            reason: gate.blockerRefs?.[0] ?? gate.blockers[0] ?? { key: "core.action.rerunShort" },
          },
          tone: "warning",
          primaryAction: hasVerifyCommands
            ? { id: "run_all_verifications", label: "重新运行验证", labelKey: "core.action.rerun" }
            : { id: "dispatch_fix", label: "让 Agent 补充验证", labelKey: "core.action.agentSupplement" },
          secondaryActions: [{ id: "request_changes", label: "打回修改…", labelKey: "core.action.sendBack" }],
        },
      };

    case "blocked":
      return {
        needsDecision: true,
        decisionReason: "已阻塞",
        decisionReasonKey: "core.decision.blocked",
        banner: {
          headline: `需求受阻：${state.blockedReason ?? "未记录原因"}`,
          headlineKey: "core.banner.blocked",
          headlineParams: { reason: state.blockedReason ?? { key: "core.reason.unrecorded" } },
          tone: "warning",
          primaryAction: { id: "unblock", label: "解除阻塞", labelKey: "core.action.unblock" },
          secondaryActions: [],
        },
      };

    case "done":
      return {
        needsDecision: false,
        decisionReason: null,
        banner: {
          headline: state.delivery
            ? `已验收并完成交付（提交 ${state.delivery.shortHash} · ${state.delivery.files.length} 个文件）`
            : "已验收完成",
          headlineKey: state.delivery ? "core.banner.done.delivered" : "core.banner.done",
          ...(state.delivery
            ? { headlineParams: { hash: state.delivery.shortHash, count: state.delivery.files.length } }
            : {}),
          tone: "success",
          primaryAction: null,
          secondaryActions: [{ id: "reopen", label: "重新打开", labelKey: "core.action.reopen" }],
        },
      };

    case "cancelled":
      return {
        needsDecision: false,
        decisionReason: null,
        banner: {
          headline: `需求已取消${state.blockedReason ? `：${state.blockedReason}` : ""}`,
          headlineKey: state.blockedReason ? "core.banner.cancelledReason" : "core.banner.cancelled",
          ...(state.blockedReason ? { headlineParams: { reason: state.blockedReason } } : {}),
          tone: "neutral",
          primaryAction: null,
          secondaryActions: [{ id: "reopen", label: "重新打开", labelKey: "core.action.reopen" }],
        },
      };
  }
}

export function evaluateReviewReport(
  state: RequirementState,
  currentCodeSnapshotHash: string | null,
): ReviewValidity {
  const report = state.reviewReport;
  if (!report) {
    return { effectiveState: "missing", reason: null };
  }
  if (report.reviewedSpecHash !== state.specHash) {
    return {
      effectiveState: "stale",
      reason: "需求规范或验收条件已修改，建议复审",
      reasonKey: "core.review.staleSpec",
    };
  }
  if (!currentCodeSnapshotHash || report.reviewedCodeSnapshotHash !== currentCodeSnapshotHash) {
    return {
      effectiveState: "stale",
      reason: "审查后工作区代码已有新改动，建议复审",
      reasonKey: "core.review.staleCode",
    };
  }
  return { effectiveState: "current", reason: null };
}

function buildLiveProvenance(
  state: RequirementState,
  currentCodeSnapshotHash: string | null,
): EvidenceProvenance {
  return {
    context: "live",
    coverageSource: "live",
    artifactStatus: "none",
    reason: null,
    acceptedAt: null,
    snapshotId: null,
    snapshotPath: null,
    snapshotCapturedAt: null,
    specHash: state.specHash,
    codeSnapshotHash: currentCodeSnapshotHash,
    verificationIds: [],
    diffStatus: null,
    diffBytes: 0,
    diffTruncated: false,
    fileCount: 0,
    commitCount: 0,
    baselineHead: state.baseline?.head ?? null,
    observedHead: null,
    scopeNote: null,
  };
}

function evaluateLegacyDoneVerifications(state: RequirementState): EvaluatedVerification[] {
  const acc = state.acceptance!;
  const acceptedSet = new Set(acc.verificationIds);
  return state.verifications.map((record) => {
    if (record.specHash !== acc.specHash) {
      return {
        record,
        effectiveState: "stale",
        staleReason: "规范与验收记录不一致",
        staleReasonKey: "core.legacy.verify.specMismatch",
      };
    }
    if (record.codeSnapshotHash !== acc.codeSnapshotHash) {
      return {
        record,
        effectiveState: "stale",
        staleReason: "非验收代码快照下的验证记录",
        staleReasonKey: "core.legacy.verify.snapshotMismatch",
      };
    }
    if (record.timedOut) {
      return {
        record,
        effectiveState: "failed",
        staleReason: "命令执行超时",
        staleReasonKey: "core.verify.timeoutCommand",
      };
    }
    if (!record.passed) {
      return {
        record,
        effectiveState: "failed",
        staleReason: `退出码 ${record.exitCode ?? "未知"}`,
        staleReasonKey: "core.verify.exitCode",
        staleReasonParams: { code: record.exitCode ?? "-" },
      };
    }
    if (!acceptedSet.has(record.id)) {
      return {
        record,
        effectiveState: "stale",
        staleReason: "未被纳入该次验收的历史通过记录",
        staleReasonKey: "core.legacy.verify.notIncluded",
      };
    }
    return { record, effectiveState: "passed", staleReason: null };
  });
}

function evaluateLegacyDoneCoverage(
  state: RequirementState,
  evaluated: EvaluatedVerification[],
): {
  coverage: CriteriaCoverage;
  coverageSource: "acceptance-hashes" | "unavailable";
  coverageReason: string | null;
  coverageReasonKey?: string;
} {
  const acc = state.acceptance!;
  if (state.specHash !== acc.specHash) {
    const items: CriterionCoverageItem[] = state.criteria.map((criterion) => ({
      criterion,
      state: "unavailable",
      verificationIds: [],
      reason: "验收后规范或验收条件定义已变化，历史覆盖不可用",
      reasonKey: "core.legacy.coverage.specChanged",
    }));
    return {
      coverageSource: "unavailable",
      coverageReason: "验收后规范或验收条件定义已变化，历史覆盖不可用",
      coverageReasonKey: "core.legacy.coverage.specChanged",
      coverage: {
        items,
        requiredTotal: items.filter((i) => i.criterion.required).length,
        requiredPassed: 0,
        optionalTotal: items.filter((i) => !i.criterion.required).length,
        optionalPassed: 0,
      },
    };
  }

  const byId = new Map(evaluated.map((ev) => [ev.record.id, ev]));
  const missingAcceptedIds = acc.verificationIds.filter((vid) => {
    const ev = byId.get(vid);
    return !ev || ev.effectiveState !== "passed";
  });

  const items: CriterionCoverageItem[] = [];
  let requiredTotal = 0;
  let requiredPassed = 0;
  let optionalTotal = 0;
  let optionalPassed = 0;

  for (const criterion of state.criteria) {
    const matching = evaluated.filter((ev) => ev.record.criterionIds.includes(criterion.id));
    const verificationIds = matching.map((ev) => ev.record.id);
    const acceptedPass = matching.find((ev) => ev.effectiveState === "passed");
    const latest = matching.length > 0 ? matching[matching.length - 1]! : null;

    let coverageState: CriterionCoverageItem["state"] = "unverified";
    let reason: string | null = "历史验收未包含该条件的验证记录";
    let reasonKey: string | undefined = "core.legacy.coverage.missing";
    let reasonParams: UiMessageParams | undefined;

    if (acceptedPass) {
      coverageState = "passed";
      reason = null;
      reasonKey = undefined;
    } else if (missingAcceptedIds.length > 0) {
      coverageState = "unavailable";
      reason = "部分验收证据记录缺失或与验收哈希不一致，无法确认历史覆盖";
      reasonKey = "core.legacy.coverage.unavailable";
    } else if (latest) {
      if (latest.effectiveState === "failed") {
        coverageState = "failed";
        reason = latest.staleReason;
      } else {
        coverageState = "stale";
        reason = latest.staleReason;
      }
      reasonKey = latest.staleReasonKey;
      reasonParams = latest.staleReasonParams;
    }

    if (criterion.required) {
      requiredTotal += 1;
      if (coverageState === "passed") requiredPassed += 1;
    } else {
      optionalTotal += 1;
      if (coverageState === "passed") optionalPassed += 1;
    }
    items.push({
      criterion,
      state: coverageState,
      verificationIds,
      reason,
      ...(reasonKey ? { reasonKey } : {}),
      ...(reasonParams ? { reasonParams } : {}),
    });
  }

  return {
    coverageSource: missingAcceptedIds.length > 0 && requiredPassed === 0 ? "unavailable" : "acceptance-hashes",
    coverageReason:
      missingAcceptedIds.length > 0 ? "部分历史验收证据记录缺失或不一致，仅对已证实的记录恢复覆盖" : null,
    ...(missingAcceptedIds.length > 0
      ? { coverageReasonKey: "core.legacy.coverage.partial" }
      : {}),
    coverage: { items, requiredTotal, requiredPassed, optionalTotal, optionalPassed },
  };
}

export function evaluateRequirement(
  state: RequirementState,
  currentCodeSnapshotHash: string | null,
  options: EvaluateRequirementOptions = {},
): ValidityReport {
  const approval = evaluateApproval(state);
  const reviewValidity = evaluateReviewReport(state, currentCodeSnapshotHash);

  if (state.stage === "done" && state.acceptance) {
    const acc = state.acceptance;
    const snap = options.acceptanceSnapshot ?? null;
    const snapStatus: AcceptanceArtifactStatus =
      options.acceptanceSnapshotStatus ?? (snap ? "available" : acc.snapshot ? "missing" : "none");
    const snapMatches =
      snap !== null &&
      snapStatus === "available" &&
      snap.requirementId === state.id &&
      snap.specHash === acc.specHash &&
      snap.codeSnapshotHash === acc.codeSnapshotHash &&
      snap.acceptedAt === acc.acceptedAt;

    if (snapMatches) {
      const verifications: EvaluatedVerification[] = snap.verifications.map((ev) => ({
        record: ev.record,
        effectiveState: ev.effectiveState,
        staleReason: ev.staleReason,
      }));
      const coverage: CriteriaCoverage = {
        items: snap.coverage,
        requiredTotal: snap.requiredTotal,
        requiredPassed: snap.requiredPassed,
        optionalTotal: snap.coverage.filter((i) => !i.criterion.required).length,
        optionalPassed: snap.coverage.filter((i) => !i.criterion.required && i.state === "passed").length,
      };
      const acceptanceGate = evaluateAcceptanceGate(state, approval, coverage);
      const { banner, needsDecision, decisionReason, decisionReasonKey, decisionReasonParams } = deriveActionBanner(
        state,
        approval,
        coverage,
        acceptanceGate,
        reviewValidity,
      );
      const provenance: EvidenceProvenance = {
        context: "accepted",
        coverageSource: "snapshot",
        artifactStatus: "available",
        reason: snap.git.reason,
        acceptedAt: acc.acceptedAt,
        snapshotId: snap.id,
        snapshotPath: acc.snapshot?.path ?? null,
        snapshotCapturedAt: snap.capturedAt,
        specHash: snap.specHash,
        codeSnapshotHash: snap.codeSnapshotHash,
        verificationIds: [...acc.verificationIds],
        diffStatus: snap.git.diffStatus,
        diffBytes: snap.git.diffBytes,
        diffTruncated: snap.git.diffTruncated,
        fileCount: snap.git.files.length,
        commitCount: snap.git.commits.length,
        baselineHead: snap.git.baselineHead,
        observedHead: snap.git.observedHead || null,
        scopeNote: snap.git.filesScope === "baseline-relative" ? BASELINE_SCOPE_NOTE : WORKTREE_SCOPE_NOTE,
        scopeNoteKey:
          snap.git.filesScope === "baseline-relative" ? "evidence.scope.baseline" : "evidence.scope.worktree",
      };
      return {
        approval,
        verifications,
        coverage,
        acceptanceGate,
        reviewValidity,
        banner,
        needsDecision,
        decisionReason,
        ...(decisionReasonKey ? { decisionReasonKey } : {}),
        ...(decisionReasonParams ? { decisionReasonParams } : {}),
        evidenceContext: "accepted",
        provenance,
      };
    }

    // Legacy done record or missing/corrupt artifact: never backfill historical diff from current HEAD.
    const verifications = evaluateLegacyDoneVerifications(state);
    const { coverage, coverageSource, coverageReason, coverageReasonKey } = evaluateLegacyDoneCoverage(state, verifications);
    const acceptanceGate = evaluateAcceptanceGate(state, approval, coverage);
    const { banner, needsDecision, decisionReason, decisionReasonKey, decisionReasonParams } = deriveActionBanner(
      state,
      approval,
      coverage,
      acceptanceGate,
      reviewValidity,
    );
    const diffReasonKey =
      options.acceptanceSnapshotReasonKey ??
      (options.acceptanceSnapshotReason
        ? undefined
        : snapStatus === "available"
          ? "core.diff.mismatch"
          : acc.snapshot
            ? "core.diff.missing"
            : "core.diff.noSnapshot");
    const diffReasonParams = options.acceptanceSnapshotReasonKey ? options.acceptanceSnapshotReasonParams : undefined;
    const diffReason =
      options.acceptanceSnapshotReason ??
      (snapStatus === "available"
        ? "验收证据快照与验收记录不一致，历史 Diff 不可用"
        : acc.snapshot
          ? "验收证据文件缺失或损坏，历史 Diff 不可用"
          : "历史验收记录未固化代码差异快照，无法从当前工作区回溯");
    const provenance: EvidenceProvenance = {
      context: "legacy-unavailable",
      coverageSource,
      artifactStatus: snapStatus === "available" ? "corrupt" : snapStatus,
      reason: coverageReason ? `${diffReason}；${coverageReason}` : diffReason,
      ...(diffReasonKey ? { reasonKey: diffReasonKey } : {}),
      ...(diffReasonParams ? { reasonParams: diffReasonParams } : {}),
      ...(coverageReasonKey ? { coverageReasonKey } : {}),
      acceptedAt: acc.acceptedAt,
      snapshotId: acc.snapshot?.id ?? null,
      snapshotPath: acc.snapshot?.path ?? null,
      snapshotCapturedAt: acc.snapshot?.capturedAt ?? null,
      specHash: acc.specHash,
      codeSnapshotHash: acc.codeSnapshotHash,
      verificationIds: [...acc.verificationIds],
      diffStatus: "unavailable",
      diffBytes: 0,
      diffTruncated: false,
      fileCount: 0,
      commitCount: 0,
      baselineHead: state.baseline?.head ?? null,
      observedHead: null,
      scopeNote: null,
    };
    return {
      approval,
      verifications,
      coverage,
      acceptanceGate,
      reviewValidity,
      banner,
      needsDecision,
      decisionReason,
      ...(decisionReasonKey ? { decisionReasonKey } : {}),
      ...(decisionReasonParams ? { decisionReasonParams } : {}),
      evidenceContext: "legacy-unavailable",
      provenance,
    };
  }

  const verifications = evaluateVerifications(state, currentCodeSnapshotHash);
  const coverage = evaluateCriteriaCoverage(state, verifications);
  const acceptanceGate = evaluateAcceptanceGate(state, approval, coverage);
  const { banner, needsDecision, decisionReason, decisionReasonKey, decisionReasonParams } = deriveActionBanner(
    state,
    approval,
    coverage,
    acceptanceGate,
    reviewValidity,
  );
  const evidenceContext: EvidenceContext = "live";
  return {
    approval,
    verifications,
    coverage,
    acceptanceGate,
    reviewValidity,
    banner,
    needsDecision,
    decisionReason,
    ...(decisionReasonKey ? { decisionReasonKey } : {}),
    ...(decisionReasonParams ? { decisionReasonParams } : {}),
    evidenceContext,
    provenance: buildLiveProvenance(state, currentCodeSnapshotHash),
  };
}
