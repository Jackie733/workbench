import { createHash } from "node:crypto";
import type {
  AcceptanceArtifactStatus,
  AcceptanceGate,
  AcceptanceSnapshot,
  ActionBanner,
  AdoptedDecision,
  ApprovalStatus,
  ChangedFile,
  CriteriaCoverage,
  Criterion,
  CriterionCoverageItem,
  DesignReviewValidity,
  EvaluatedVerification,
  EvidenceContext,
  EvidenceProvenance,
  RequirementState,
  ReviewValidity,
  UiMessageParams,
  UiMessageRef,
  ValidityReport,
  VerificationRecord,
} from "./types.ts";

/**
 * Classifies deterministic environment/infrastructure verification failures (missing binary or timeout)
 * that should NOT trigger blind model auto-heal loops.
 */
export function isEnvironmentVerificationFailure(record: VerificationRecord): boolean {
  if (record.passed) return false;
  if (record.timedOut) return true;
  return record.exitCode === 127 || record.exitCode === 126;
}

const TEST_FILE_PATH_RE = /(?:^|\/)(?:__tests__\/.*|test_[^/]+\.py|.*_test\.go|.*\.(?:test|spec)\.[A-Za-z0-9]+)$/i;
const TEST_SKIP_LINE_RE = /^\+(?!\+\+)(?:.*\b(?:describe|it|test|suite)\.(?:skip|only)\s*\(|.*\b(?:xit|xtest|xdescribe)\s*\(|.*@pytest\.mark\.skip\b|.*#\[\s*ignore\b|.*\bt\.(?:Skip|Skipf|SkipNow)\s*\()/;
const ASSERTION_CALL_RE = /\b(?:expect|assert|assertEquals|assertEqual|assertThrows|assert_eq!|assert_ne!|assert!)\s*\(/;

/**
 * Deterministically inspects changed files and diff hunks for signs of deleted tests,
 * newly skipped tests, or removed assertions without replacement. Advisory only.
 */
export function detectTestTamperingSignals(files: ChangedFile[], diff: string): string[] {
  const signals: string[] = [];
  const deletedTests = files
    .filter((f) => TEST_FILE_PATH_RE.test(f.path) && (f.status === "D" || f.status.startsWith("D")))
    .map((f) => f.path);
  if (deletedTests.length > 0) {
    signals.push(`删除了测试文件：${deletedTests.slice(0, 8).join("、")}`);
  }

  if (!diff.trim()) return signals;

  let currentFile = "";
  let inTestFile = false;
  let inRustCfgTest = false;
  const perFileAssertions = new Map<string, { removed: number; added: number }>();
  const skippedLocations: string[] = [];

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/.+? b\/(.+)$/.exec(line);
      currentFile = m ? m[1]! : "";
      inTestFile = TEST_FILE_PATH_RE.test(currentFile);
      inRustCfgTest = false;
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("@@ ")) continue;
    if (!inTestFile && currentFile.endsWith(".rs") && /#\[\s*cfg\s*\(\s*test\s*\)\s*\]/.test(line)) {
      inRustCfgTest = true;
    }
    if (inTestFile || inRustCfgTest) {
      if (TEST_SKIP_LINE_RE.test(line)) {
        const label = currentFile || "diff";
        if (!skippedLocations.includes(label)) skippedLocations.push(label);
      }
      if (line.startsWith("-") && ASSERTION_CALL_RE.test(line)) {
        const counts = perFileAssertions.get(currentFile) ?? { removed: 0, added: 0 };
        counts.removed += 1;
        perFileAssertions.set(currentFile, counts);
      } else if (line.startsWith("+") && ASSERTION_CALL_RE.test(line)) {
        const counts = perFileAssertions.get(currentFile) ?? { removed: 0, added: 0 };
        counts.added += 1;
        perFileAssertions.set(currentFile, counts);
      }
    }
  }

  if (skippedLocations.length > 0) {
    signals.push(`新增跳过测试标记（skip/ignore）：${skippedLocations.slice(0, 8).join("、")}`);
  }
  const droppedAssertionFiles = [...perFileAssertions.entries()]
    .filter(([, counts]) => counts.removed >= 2 && counts.removed > counts.added)
    .map(([filePath, counts]) => `${filePath}（-${counts.removed}/+${counts.added}）`);
  if (droppedAssertionFiles.length > 0) {
    signals.push(`测试文件中净移除了断言：${droppedAssertionFiles.slice(0, 8).join("、")}`);
  }
  return signals;
}

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
    criteria.map((c) =>
      c.kind || c.steps
        ? [c.id, c.description, c.required, c.command ?? null, c.kind ?? null, c.steps ?? null]
        : [c.id, c.description, c.required, c.command ?? null],
    ),
  ]);
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** Computes SHA-256 of design.md content, or empty string when absent. */
export function computeDesignHash(designMarkdown: string): string {
  if (!designMarkdown.trim()) return "";
  return createHash("sha256").update(designMarkdown, "utf8").digest("hex");
}

/** Computes deterministic SHA-256 of adopted human decisions, or empty string when none. */
export function computeDecisionsHash(decisions: AdoptedDecision[] | undefined): string {
  if (!decisions || decisions.length === 0) return "";
  const payload = JSON.stringify(
    decisions.map((d) => [d.id, d.question, d.answer, d.optionId ?? null, d.optionLabel ?? null]),
  );
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * Checks whether a planning requirement with pending decision cards is eligible for
 * the direct-approve exit ("采纳选择并直接批准进入编码") per WB-18 / FLOW §1.4:
 * - Every pending decision must have a valid preset `selectedOptionId` (no unanswered item)
 * - No item may use a custom freeform `customAnswer` (custom answers require a design revision round)
 * - Hard invariant ③: at least 1 required acceptance criterion must already exist.
 */
export function canDirectApproveWithDecisions(state: RequirementState): {
  allowed: boolean;
  reason: string | null;
  reasonKey?: string;
} {
  const pending = state.pendingDecisions ?? [];
  if (pending.length > 0) {
    for (const item of pending) {
      if (item.customAnswer && item.customAnswer.trim().length > 0) {
        return {
          allowed: false,
          reason: `决策 ${item.id} 包含自定义输入，需先提交决策并修订方案后再批准`,
          reasonKey: "decisions.directBlockedCustom",
        };
      }
      const validPreset =
        Boolean(item.selectedOptionId) &&
        item.options.some((opt) => opt.id === item.selectedOptionId);
      if (!validPreset) {
        return {
          allowed: false,
          reason: `仍有未作答的待拍板决策（${item.id}），请先完成选择`,
          reasonKey: "decisions.directBlockedUnanswered",
        };
      }
    }
  }
  const hasRequiredCriterion = state.criteria.some((c) => c.required);
  if (!hasRequiredCriterion) {
    return {
      allowed: false,
      reason: "尚未定义必需验收条件，请先修订方案补齐验收条件后再批准",
      reasonKey: "decisions.directBlockedNoCriteria",
    };
  }
  return { allowed: true, reason: null };
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
  const currentDecisionsHash = computeDecisionsHash(state.humanDecisions);
  if (
    (approval.decisionsHash !== undefined || currentDecisionsHash !== "") &&
    (approval.decisionsHash ?? "") !== currentDecisionsHash
  ) {
    return {
      valid: false,
      reason: "已采纳决策发生变更，需要重新批准",
      reasonKey: "core.approval.decisionsChanged",
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

export function isManualCriterion(criterion: Pick<Criterion, "kind" | "command" | "steps">): boolean {
  return criterion.kind === "manual" || (!criterion.command?.trim() && Boolean(criterion.steps?.trim()));
}

export function evaluateCriteriaCoverage(
  state: RequirementState,
  evaluatedVerifications: EvaluatedVerification[],
  currentCodeSnapshotHash: string | null = null,
): CriteriaCoverage {
  const items: CriterionCoverageItem[] = [];
  let requiredTotal = 0;
  let requiredPassed = 0;
  let optionalTotal = 0;
  let optionalPassed = 0;
  const manualChecksById = new Map((state.manualChecks ?? []).map((mc) => [mc.criterionId, mc]));

  for (const criterion of state.criteria) {
    const isManual = isManualCriterion(criterion);
    const manualCheck = manualChecksById.get(criterion.id);

    const matching = isManual ? [] : evaluatedVerifications.filter((ev) => ev.record.criterionIds.includes(criterion.id));
    const verificationIds = matching.map((ev) => ev.record.id);
    const currentPass = matching.find((ev) => ev.effectiveState === "passed");
    const latest = matching.length > 0 ? matching[matching.length - 1]! : null;

    let coverageState: CriterionCoverageItem["state"] = "unverified";
    let reason: string | null = isManual ? "待人工核验并勾选确认" : "尚未运行验证";
    let reasonKey: string | undefined = isManual ? "core.coverage.manualUnverified" : "core.coverage.notRun";
    let reasonParams: UiMessageParams | undefined;

    if (isManual) {
      if (manualCheck?.checked) {
        if (
          manualCheck.specHash === state.specHash &&
          Boolean(currentCodeSnapshotHash) &&
          manualCheck.codeSnapshotHash === currentCodeSnapshotHash
        ) {
          coverageState = "passed";
          reason = null;
          reasonKey = undefined;
        } else {
          coverageState = "stale";
          reason =
            manualCheck.specHash !== state.specHash
              ? "需求规范或验收条件已更新，需重新人工核验"
              : "代码已有新改动，需重新人工核验";
          reasonKey =
            manualCheck.specHash !== state.specHash
              ? "core.coverage.manualStaleSpec"
              : "core.coverage.manualStaleCode";
        }
      }
    } else if (currentPass) {
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
  if (state.stage === "cancelled") {
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
    const wasBlocking = report?.verdict === "block";
    return {
      needsDecision: true,
      decisionReason: wasBlocking ? "阻塞审查已过期" : "审查已过期",
      decisionReasonKey: wasBlocking ? "core.decision.reviewBlock" : "core.decision.reviewStale",
      banner: {
        headline: wasBlocking
          ? `验证已通过（${coverage.requiredPassed}/${coverage.requiredTotal}），但上轮阻塞级（block）审查已过期，需复审或填理由放行`
          : `验证已通过（${coverage.requiredPassed}/${coverage.requiredTotal}），但跨模型审查已过期（${reviewValidity.reason ?? "代码或规范已变化"}）`,
        headlineKey: wasBlocking ? "core.banner.review.staleBlock" : "core.banner.review.stale",
        headlineParams: {
          passed: coverage.requiredPassed,
          total: coverage.requiredTotal,
          reason: reviewValidity.reasonKey
            ? { key: reviewValidity.reasonKey }
            : (reviewValidity.reason ?? ""),
        },
        tone: wasBlocking ? "danger" : "warning",
        primaryAction: {
          id: "dispatch_review",
          label: "重新跨模型审查",
          labelKey: "core.action.dispatchReview",
        },
        secondaryActions: [
          {
            id: "accept",
            label: wasBlocking ? "忽略阻塞并验收…" : "跳过复审直接验收",
            labelKey: wasBlocking ? "core.action.ignoreBlockAccept" : "core.action.skipReReviewAccept",
          },
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

/**
 * WB-22 / FLOW §1.3: evaluates independent heterogeneous design review against current specHash + designHash.
 * Strictly isolated from coding `reviewReport` and never blocks human approval or acceptance.
 */
export function evaluateDesignReviewReport(state: RequirementState): DesignReviewValidity {
  const report = state.designReviewReport;
  if (!report) {
    return { effectiveState: "missing", reason: null };
  }
  if (report.reviewedSpecHash !== state.specHash) {
    return {
      effectiveState: "stale",
      reason: "需求规范或验收条件在方案评审后已更新",
      reasonKey: "core.designReview.staleSpec",
    };
  }
  if (!state.designHash || report.reviewedDesignHash !== state.designHash) {
    return {
      effectiveState: "stale",
      reason: "技术方案正文在方案评审后已更新",
      reasonKey: "core.designReview.staleDesign",
    };
  }
  return { effectiveState: "current", reason: null };
}

const GENERIC_BASELINE_DESC_RE = /^(?:项目快速基线验证通过|项目自动化验证通过)$/;

/**
 * WB-23 / FLOW §2.5: honest signal when a `fast_track` item only relies on generic system-injected
 * project baseline command(s) without any requirement-specific test or manual check.
 */
export function isFastTrackBaselineOnly(state: RequirementState): boolean {
  if (state.track !== "fast_track") return false;
  const required = state.criteria.filter((c) => c.required);
  if (required.length === 0) return false;
  return required.every(
    (c) =>
      c.systemInjected === true ||
      (c.kind !== "manual" && Boolean(c.command) && GENERIC_BASELINE_DESC_RE.test(c.description.trim())),
  );
}

export function deriveActionBanner(
  state: RequirementState,
  approval: ApprovalStatus,
  coverage: CriteriaCoverage,
  gate: AcceptanceGate,
  reviewValidity: ReviewValidity = evaluateReviewReport(state, null),
  verifications: EvaluatedVerification[] = [],
  currentCodeSnapshotHash: string | null = null,
): {
  banner: ActionBanner;
  needsDecision: boolean;
  decisionReason: string | null;
  decisionReasonKey?: string;
  decisionReasonParams?: UiMessageParams;
} {
  const hasVerifyCommands = state.criteria.some((c) => Boolean(c.command));

  switch (state.stage) {
    case "planning": {
      const pendingDecisions = state.pendingDecisions ?? [];
      if (pendingDecisions.length > 0 && state.designHash !== "" && !state.lastFeedback) {
        const directCheck = canDirectApproveWithDecisions(state);
        return {
          needsDecision: true,
          decisionReason: "待拍板方案决策",
          decisionReasonKey: "core.decision.pendingDecisions",
          banner: {
            headline: `方案 v${state.designVersion} 存在 ${pendingDecisions.length} 项待拍板决策，请在下方决策卡片完成选择`,
            headlineKey: "core.banner.awaitApproval.decisions",
            headlineParams: { version: state.designVersion, count: pendingDecisions.length },
            tone: "warning",
            primaryAction: directCheck.allowed
              ? {
                  id: "approve_and_implement",
                  label: "采纳选择并批准实施",
                  labelKey: "core.action.approveImplement",
                }
              : null,
            secondaryActions: [
              { id: "request_changes", label: "提出修改意见…", labelKey: "core.action.requestChanges" },
            ],
          },
        };
      }
      if (state.designHash !== "" && !state.lastFeedback) {
        const hasRequired = state.criteria.some((c) => c.required);
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
              ...(!hasRequired ? { disabledReason: "至少需要 1 条必需验收条件才能批准进入编码" } : {}),
            },
            secondaryActions: [
              {
                id: "approve_only",
                label: "仅批准方案",
                labelKey: "core.action.approveOnly",
                ...(!hasRequired ? { disabledReason: "至少需要 1 条必需验收条件才能批准进入编码" } : {}),
              },
              { id: "request_changes", label: "提出修改意见…", labelKey: "core.action.requestChanges" },
            ],
          },
        };
      }
      if (state.lastFeedback) {
        return {
          needsDecision: false,
          decisionReason: null,
          banner: {
            headline: "已记录修改意见，等待 Agent 修订方案",
            headlineKey: "core.banner.designing.revising",
            tone: "info",
            primaryAction: {
              id: "dispatch_design",
              label: "通知 Agent 修订方案",
              labelKey: "core.action.notifyDesign",
            },
            secondaryActions: [
              { id: "authorize_fast_track", label: "快速通道：直接实施", labelKey: "core.action.fastTrack" },
            ],
          },
        };
      }
      if (state.kind === "bug") {
        return {
          needsDecision: false,
          decisionReason: null,
          banner: {
            headline: "Bug 已登记，授权后直接进入单段修复（复现定位 + 回归测试 + 修复）",
            headlineKey: "core.banner.bugDraft",
            tone: "neutral",
            primaryAction: {
              id: "authorize_fast_track",
              label: "开始修复",
              labelKey: "core.action.startBugFix",
            },
            secondaryActions: [
              { id: "dispatch_design", label: "转常规方案流程", labelKey: "core.action.convertPlanFirst" },
            ],
          },
        };
      }
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
    }

    case "coding": {
      if (state.needsHuman && state.needsHuman.source === "bug_pause") {
        return {
          needsDecision: true,
          decisionReason: "Bug 修复暂停待人工拍板",
          decisionReasonKey: "core.decision.bugPaused",
          banner: {
            headline: `Bug 修复已主动暂停，需人工介入：${state.needsHuman.reason}`,
            headlineKey: "core.banner.bugPaused",
            headlineParams: { reason: state.needsHuman.reason },
            tone: "warning",
            primaryAction: {
              id: "request_changes",
              label: "补充信息继续修…",
              labelKey: "core.action.bugSupplyInfo",
            },
            secondaryActions: [
              { id: "revise_plan", label: "转常规方案流程", labelKey: "core.action.convertPlanFirst" },
              { id: "dispatch_fix", label: "继续让 Agent 修复", labelKey: "core.action.dispatchFix" },
            ],
          },
        };
      }
      const failedCount = coverage.items.filter((i) => i.state === "failed").length;
      const staleCount = coverage.items.filter((i) => i.state === "stale").length;
      const latestRun = state.agentRuns && state.agentRuns.length > 0 ? state.agentRuns[state.agentRuns.length - 1] : null;
      const latestCodingRun = state.agentRuns
        ? [...state.agentRuns].reverse().find((r) => r.action === "implement" || r.action === "fix") ?? null
        : null;
      const stillAtBaseline =
        Boolean(state.baseline?.fingerprint) &&
        (!currentCodeSnapshotHash || currentCodeSnapshotHash === state.baseline!.fingerprint);
      if (
        latestCodingRun?.action === "implement" &&
        latestCodingRun.status === "succeeded" &&
        latestCodingRun.noCodeChange === true &&
        stillAtBaseline
      ) {
        const closeAction =
          gate.ok
            ? [{ id: "accept" as const, label: "确认无需改动并验收…", labelKey: "core.action.accept" }]
            : approval.valid && coverage.requiredTotal > 0
              ? [{ id: "accept_override" as const, label: "确认无需改动并关闭…", labelKey: "core.action.acceptWithOverride" }]
              : [];
        return {
          needsDecision: true,
          decisionReason: "未产出代码改动",
          decisionReasonKey: "core.decision.noCodeChange",
          banner: {
            headline: "编码运行已完成，但相对基线未产出任何代码改动，请人工核查",
            headlineKey: "core.banner.noCodeChange",
            tone: "warning",
            primaryAction: {
              id: "dispatch_implement",
              label: "继续让 Agent 实施",
              labelKey: "core.action.continueImplement",
            },
            secondaryActions: [
              ...(hasVerifyCommands && !gate.ok
                ? [{ id: "run_all_verifications" as const, label: "运行全部验证", labelKey: "core.action.runAll" }]
                : []),
              ...closeAction,
              { id: "request_changes", label: "打回修改…", labelKey: "core.action.requestChanges" },
            ],
          },
        };
      }
      if (gate.ok) {
        const ready = deriveReadyAcceptanceBanner(state, coverage, reviewValidity, hasVerifyCommands);
        if (state.needsHuman && state.reviewReport?.verdict !== "pass") {
          const escalateBtn =
            state.tier === "standard"
              ? [{ id: "escalate_sota" as const, label: "升级 SOTA 主程接管", labelKey: "core.action.escalateSota" }]
              : [];
          return {
            needsDecision: true,
            decisionReason: "需人工接管",
            decisionReasonKey: "core.decision.needsHuman",
            banner: {
              headline: `自动闭环已达上限，需人工接管：${state.needsHuman.reason}`,
              headlineKey: "core.banner.needsHuman",
              headlineParams: { reason: state.needsHuman.reason },
              tone: "danger",
              primaryAction:
                escalateBtn[0] ?? {
                  id: "revise_plan",
                  label: "退回修改方案",
                  labelKey: "core.action.revisePlan",
                },
              secondaryActions: [
                ...(escalateBtn.length > 0
                  ? [{ id: "revise_plan" as const, label: "退回修改方案", labelKey: "core.action.revisePlan" }]
                  : []),
                ...(ready.banner.primaryAction ? [ready.banner.primaryAction] : []),
                ...ready.banner.secondaryActions.filter((a) => a.id !== "revise_plan"),
              ],
            },
          };
        }
        return ready;
      }
      const escalateAction =
        state.tier === "standard"
          ? [{ id: "escalate_sota" as const, label: "升级 SOTA 主程接管", labelKey: "core.action.escalateSota" }]
          : [];
      const revisePlanAction = [
        { id: "revise_plan" as const, label: "退回修改方案", labelKey: "core.action.revisePlan" },
      ];
      if (state.needsHuman) {
        const overrideAction =
          approval.valid && coverage.requiredTotal > 0
            ? [{ id: "accept_override" as const, label: "带理由人工验收…", labelKey: "core.action.acceptWithOverride" }]
            : [];
        return {
          needsDecision: true,
          decisionReason: "需人工接管",
          decisionReasonKey: "core.decision.needsHuman",
          banner: {
            headline: `自动修复已达上限，需人工接管：${state.needsHuman.reason}`,
            headlineKey: "core.banner.needsHuman",
            headlineParams: { reason: state.needsHuman.reason },
            tone: "danger",
            primaryAction: escalateAction[0] ?? revisePlanAction[0]!,
            secondaryActions: [
              ...(escalateAction.length > 0 ? revisePlanAction : []),
              { id: "dispatch_fix", label: "让 Agent 修复失败项", labelKey: "core.action.dispatchFix" },
              ...(hasVerifyCommands
                ? [{ id: "run_all_verifications" as const, label: "重新运行验证", labelKey: "core.action.rerun" }]
                : []),
              ...overrideAction,
            ],
          },
        };
      }
      if (failedCount > 0) {
        const overrideAction =
          approval.valid && coverage.requiredTotal > 0
            ? [{ id: "accept_override" as const, label: "带理由人工验收…", labelKey: "core.action.acceptWithOverride" }]
            : [];
        const failedVerifications = verifications.filter((ev) => ev.effectiveState === "failed");
        const isEnvFailureOnly =
          failedVerifications.length > 0 && failedVerifications.every((ev) => isEnvironmentVerificationFailure(ev.record));
        if (isEnvFailureOnly) {
          return {
            needsDecision: true,
            decisionReason: "验证环境异常",
            decisionReasonKey: "core.decision.envFailure",
            banner: {
              headline: `有 ${failedCount} 项验证因环境/基础设施故障失败（命令不存在或执行超时），请排查环境后重跑`,
              headlineKey: "core.banner.envFailure",
              headlineParams: { count: failedCount },
              tone: "danger",
              primaryAction: hasVerifyCommands
                ? { id: "run_all_verifications", label: "重新运行验证", labelKey: "core.action.rerun" }
                : { id: "dispatch_fix", label: "让 Agent 修复失败项", labelKey: "core.action.dispatchFix" },
              secondaryActions: [
                ...(hasVerifyCommands
                  ? [{ id: "dispatch_fix" as const, label: "让 Agent 修复失败项", labelKey: "core.action.dispatchFix" }]
                  : []),
                ...escalateAction,
                ...overrideAction,
              ],
            },
          };
        }
        return {
          needsDecision: false,
          decisionReason: null,
          banner: {
            headline: `有 ${failedCount} 项验收条件验证失败，请修复后重新验证`,
            headlineKey: "core.banner.implementing.failed",
            headlineParams: { count: failedCount },
            tone: "danger",
            primaryAction: { id: "dispatch_fix", label: "让 Agent 修复失败项", labelKey: "core.action.dispatchFix" },
            secondaryActions: [
              ...escalateAction,
              ...(hasVerifyCommands
                ? [{ id: "run_all_verifications" as const, label: "重新运行验证", labelKey: "core.action.rerun" }]
                : []),
              ...overrideAction,
            ],
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
      const lastRunFailed = latestRun?.status === "failed";
      const prefix = state.track === "fast_track" ? "快速通道已开启" : "方案已批准";
      const readyKey =
        state.track === "fast_track"
          ? "core.banner.implementing.readyFast"
          : "core.banner.implementing.readyApproved";
      return {
        needsDecision: false,
        decisionReason: null,
        banner: {
          headline: `${prefix} · 待完成开发并运行验证`,
          headlineKey: readyKey,
          tone: lastRunFailed ? "warning" : "info",
          primaryAction: {
            id: "dispatch_implement",
            label: latestRun ? "继续让 Agent 实施" : "开始实施",
            labelKey: latestRun ? "core.action.continueImplement" : "core.action.startImplement",
          },
          secondaryActions: [
            ...(lastRunFailed ? escalateAction : []),
            ...(hasVerifyCommands
              ? [{ id: "run_all_verifications" as const, label: "运行全部验证", labelKey: "core.action.runAll" }]
              : []),
          ],
        },
      };
    }

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
          headline: `需求已取消${state.cancelReason ? `：${state.cancelReason}` : ""}`,
          headlineKey: state.cancelReason ? "core.banner.cancelledReason" : "core.banner.cancelled",
          ...(state.cancelReason ? { headlineParams: { reason: state.cancelReason } } : {}),
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
  const designReviewValidity = evaluateDesignReviewReport(state);
  const baselineOnlyWarning = isFastTrackBaselineOnly(state);

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
        designReviewValidity,
        baselineOnlyWarning,
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
      designReviewValidity,
      baselineOnlyWarning,
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
  const coverage = evaluateCriteriaCoverage(state, verifications, currentCodeSnapshotHash);
  const acceptanceGate = evaluateAcceptanceGate(state, approval, coverage);
  const { banner, needsDecision, decisionReason, decisionReasonKey, decisionReasonParams } = deriveActionBanner(
    state,
    approval,
    coverage,
    acceptanceGate,
    reviewValidity,
    verifications,
    currentCodeSnapshotHash,
  );
  const evidenceContext: EvidenceContext = "live";
  return {
    approval,
    verifications,
    coverage,
    acceptanceGate,
    reviewValidity,
    designReviewValidity,
    baselineOnlyWarning,
    banner,
    needsDecision,
    decisionReason,
    ...(decisionReasonKey ? { decisionReasonKey } : {}),
    ...(decisionReasonParams ? { decisionReasonParams } : {}),
    evidenceContext,
    provenance: buildLiveProvenance(state, currentCodeSnapshotHash),
  };
}
