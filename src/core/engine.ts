import { randomUUID } from "node:crypto";
import { WorkbenchError } from "./errors.ts";
import {
  createRequirementFiles,
  isProjectInitialized,
  listRequirementIds,
  mutateRequirement,
  readAgentRun,
  readDesignHistory,
  readProject,
  readRequirementBundle,
  readVerificationEvidence,
  initProject as storeInitProject,
  type RequirementBundle,
} from "./store.ts";
import {
  MAX_AGENT_RUNS,
  MAX_DISCUSSIONS,
  MAX_TIMELINE,
  REVIEW_VERDICTS,
  SCHEMA_VERSION,
  type AgentRunRecord,
  type BaselineSnapshot,
  type CriterionInput,
  type DiscussionEntry,
  type HandoffNote,
  type PrivacyMode,
  type ProjectMetadata,
  type RequirementDetail,
  type RequirementState,
  type RequirementSummary,
  type ReviewReport,
  type ReviewVerdict,
  type Stage,
  type TaskInput,
  type TimelineEvent,
  type TimelineEventKind,
  type Track,
  type VerificationRecord,
} from "./types.ts";
import {
  deriveTitleFromGoal,
  isSafeText,
  normalizeCriteria,
  normalizeReason,
  normalizeTasks,
  normalizeTitle,
  validateAgentRunRecord,
  validateMarkdownContent,
  validateVerificationRecord,
} from "./validate.ts";
import { computeDesignHash, computeSpecHash, evaluateRequirement } from "./validity.ts";

function makeEvent(
  at: number,
  kind: TimelineEventKind,
  actor: TimelineEvent["actor"],
  summary: string,
  detail?: string,
): TimelineEvent {
  return {
    id: randomUUID(),
    at,
    kind,
    actor,
    summary,
    ...(detail ? { detail } : {}),
  };
}

function appendTimeline(timeline: TimelineEvent[], event: TimelineEvent): TimelineEvent[] {
  const next = [...timeline, event];
  return next.length <= MAX_TIMELINE ? next : next.slice(next.length - MAX_TIMELINE);
}

function toDetail(bundle: RequirementBundle, currentCodeSnapshotHash: string | null): RequirementDetail {
  return {
    state: bundle.state,
    specMarkdown: bundle.specMarkdown,
    designMarkdown: bundle.designMarkdown,
    handoffMarkdown: bundle.handoffMarkdown,
    designHistoryVersions: bundle.designHistoryVersions,
    validity: evaluateRequirement(bundle.state, currentCodeSnapshotHash),
  };
}

function buildProgressText(state: RequirementState, requiredTotal: number, requiredPassed: number): string {
  const tasksTotal = state.tasks.length;
  const tasksDone = state.tasks.filter((t) => t.status === "done").length;
  switch (state.stage) {
    case "draft":
      return "草稿";
    case "designing":
      return "方案起草中";
    case "awaiting_approval":
      return state.designVersion > 0 ? `方案 v${state.designVersion} 待批准` : "规范变更待确认";
    case "implementing": {
      const parts: string[] = [];
      parts.push(tasksTotal > 0 ? `任务 ${tasksDone}/${tasksTotal}` : "实施中");
      if (requiredTotal > 0) parts.push(`验证 ${requiredPassed}/${requiredTotal}`);
      return parts.join(" · ");
    }
    case "awaiting_acceptance":
      return `待验收 · 验证 ${requiredPassed}/${requiredTotal}`;
    case "done":
      return "已完成";
    case "blocked":
      return `已阻塞 · ${state.blockedReason ?? "未记录原因"}`;
    case "cancelled":
      return "已取消";
  }
}

function toSummary(bundle: RequirementBundle, currentCodeSnapshotHash: string | null): RequirementSummary {
  const { state } = bundle;
  const validity = evaluateRequirement(state, currentCodeSnapshotHash);
  return {
    id: state.id,
    title: state.title,
    stage: state.stage,
    track: state.track,
    revision: state.revision,
    designVersion: state.designVersion,
    criteriaCount: state.criteria.length,
    requiredTotal: validity.coverage.requiredTotal,
    requiredPassed: validity.coverage.requiredPassed,
    tasksTotal: state.tasks.length,
    tasksDone: state.tasks.filter((t) => t.status === "done").length,
    needsDecision: validity.needsDecision,
    decisionReason: validity.decisionReason,
    blockedReason: state.blockedReason,
    progressText: buildProgressText(state, validity.coverage.requiredTotal, validity.coverage.requiredPassed),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

export function getProjectStatus(root: string): { initialized: boolean; project: ProjectMetadata | null } {
  if (!isProjectInitialized(root)) {
    return { initialized: false, project: null };
  }
  return { initialized: true, project: readProject(root) };
}

export async function initProject(
  root: string,
  options: { name?: string; privacyMode?: PrivacyMode } = {},
): Promise<ProjectMetadata> {
  return storeInitProject(root, options);
}

export function listRequirements(
  root: string,
  options: {
    scope?: "active" | "done" | "cancelled" | "all";
    stage?: Stage;
    currentCodeSnapshotHash?: string | null;
  } = {},
): RequirementSummary[] {
  const ids = listRequirementIds(root);
  const scope = options.scope ?? "active";
  const snapshot = options.currentCodeSnapshotHash ?? null;
  const summaries: RequirementSummary[] = [];

  for (const id of ids) {
    const bundle = readRequirementBundle(root, id);
    const stage = bundle.state.stage;
    const scopeOk =
      scope === "all" ||
      (scope === "active" && stage !== "done" && stage !== "cancelled") ||
      (scope === "done" && stage === "done") ||
      (scope === "cancelled" && stage === "cancelled");
    if (!scopeOk) continue;
    if (options.stage && stage !== options.stage) continue;
    summaries.push(toSummary(bundle, snapshot));
  }

  return summaries.sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
}

export function getRequirement(
  root: string,
  id: string,
  options: { currentCodeSnapshotHash?: string | null } = {},
): RequirementDetail {
  const bundle = readRequirementBundle(root, id);
  return toDetail(bundle, options.currentCodeSnapshotHash ?? null);
}

export function getDesignHistoryVersion(root: string, id: string, version: number): string {
  return readDesignHistory(root, id, version);
}

export function getVerificationEvidence(
  root: string,
  id: string,
  verificationId: string,
): { record: VerificationRecord; log: string } {
  return readVerificationEvidence(root, id, verificationId);
}

export function getAgentRunDetail(
  root: string,
  id: string,
  runId: string,
): { record: AgentRunRecord; log: string } {
  return readAgentRun(root, id, runId);
}

function normalizeHandoffNoteInput(
  raw: { keyDecisions?: string[]; deadEnds?: string[]; nextSteps?: string[] } | undefined,
  prev: HandoffNote | null | undefined,
  now: number,
): HandoffNote | null | undefined {
  if (raw === undefined) return prev;
  const clean = (arr: string[] | undefined, fallback: string[]) =>
    arr === undefined
      ? fallback
      : arr
          .filter((s) => typeof s === "string" && s.trim().length > 0)
          .slice(0, 32)
          .map((s) => s.trim().slice(0, 900));
  return {
    updatedAt: now,
    keyDecisions: clean(raw.keyDecisions, prev?.keyDecisions ?? []),
    deadEnds: clean(raw.deadEnds, prev?.deadEnds ?? []),
    nextSteps: clean(raw.nextSteps, prev?.nextSteps ?? []),
  };
}

export async function updateDesign(
  root: string,
  id: string,
  input: {
    designMarkdown: string;
    expectedRevision?: number;
    actor?: "human" | "agent";
    currentCodeSnapshotHash?: string | null;
  },
): Promise<RequirementDetail> {
  const bundle = await mutateRequirement(root, id, input.expectedRevision, (current, now) => {
    const { state } = current;
    if (state.stage === "done" || state.stage === "cancelled" || state.stage === "blocked") {
      throw new WorkbenchError("invalid_transition", `当前阶段（${state.stage}）不允许直接修改技术方案`);
    }
    const nextDesign = validateMarkdownContent(input.designMarkdown, "design", true);
    const nextDesignHash = computeDesignHash(nextDesign);
    const designChanged = nextDesignHash !== state.designHash;

    let nextDesignVersion = state.designVersion;
    let snapshotDesignVersion: number | undefined;
    if (designChanged && nextDesignHash !== "") {
      nextDesignVersion += 1;
      snapshotDesignVersion = nextDesignVersion;
    }

    let nextApproval = state.approval;
    let nextStage = state.stage;
    if (designChanged && nextApproval !== null && state.track === "plan_first") {
      nextApproval = null;
      nextStage = "awaiting_approval";
    } else if (designChanged && nextDesignHash !== "" && (state.stage === "draft" || state.stage === "designing")) {
      nextStage = "awaiting_approval";
    }

    const actor = input.actor ?? "human";
    return {
      designMarkdown: nextDesign,
      snapshotDesignVersion,
      state: {
        ...state,
        designVersion: nextDesignVersion,
        designHash: nextDesignHash,
        approval: nextApproval,
        stage: nextStage,
        timeline: appendTimeline(
          state.timeline,
          makeEvent(now, "design_proposed", actor, designChanged ? `在线更新技术方案 v${nextDesignVersion}` : "保存技术方案"),
        ),
      },
    };
  });

  return toDetail(bundle, input.currentCodeSnapshotHash ?? null);
}

export async function createRequirement(
  root: string,
  input: {
    goal: string;
    title?: string;
    criteria?: CriterionInput[];
    track?: Track;
    currentCodeSnapshotHash?: string | null;
  },
): Promise<RequirementDetail> {
  const specMarkdown = validateMarkdownContent(input.goal, "spec", false);
  const title = input.title?.trim() ? normalizeTitle(input.title) : deriveTitleFromGoal(specMarkdown);
  const criteria = input.criteria ? normalizeCriteria(input.criteria) : [];
  const track: Track = input.track === "fast_track" ? "fast_track" : "plan_first";
  const specHash = computeSpecHash(specMarkdown, criteria);

  const bundle = await createRequirementFiles(root, (id, now) => {
    const state: RequirementState = {
      schemaVersion: SCHEMA_VERSION,
      id,
      title,
      stage: "draft",
      track,
      revision: 1,
      specHash,
      designVersion: 0,
      designHash: "",
      criteria,
      approval: null,
      acceptance: null,
      tasks: [],
      baseline: null,
      verifications: [],
      timeline: [makeEvent(now, "created", "human", `创建需求 ${id}：${title}`)],
      lastFeedback: null,
      blockedFrom: null,
      blockedReason: null,
      createdAt: now,
      updatedAt: now,
    };
    return { state, specMarkdown, designMarkdown: "" };
  });

  return toDetail(bundle, input.currentCodeSnapshotHash ?? null);
}

export async function updateSpec(
  root: string,
  id: string,
  input: {
    title?: string;
    specMarkdown?: string;
    criteria?: CriterionInput[];
    expectedRevision?: number;
    currentCodeSnapshotHash?: string | null;
  },
): Promise<RequirementDetail> {
  const bundle = await mutateRequirement(root, id, input.expectedRevision, (current, now) => {
    const { state } = current;
    if (state.stage === "done" || state.stage === "cancelled" || state.stage === "blocked") {
      throw new WorkbenchError("invalid_transition", `当前阶段（${state.stage}）不允许直接修改规范`);
    }
    const nextTitle = input.title !== undefined ? normalizeTitle(input.title) : state.title;
    const nextSpec =
      input.specMarkdown !== undefined
        ? validateMarkdownContent(input.specMarkdown, "spec", false)
        : current.specMarkdown;
    const nextCriteria = input.criteria !== undefined ? normalizeCriteria(input.criteria) : state.criteria;
    const nextSpecHash = computeSpecHash(nextSpec, nextCriteria);
    const specChanged = nextSpecHash !== state.specHash;

    let nextStage = state.stage;
    let nextApproval = state.approval;
    let summary = "更新需求标题";

    if (specChanged) {
      summary = "更新需求规范或验收条件";
      if (nextApproval !== null) {
        nextApproval = null;
        if (nextStage === "implementing" || nextStage === "awaiting_acceptance") {
          nextStage = current.designMarkdown.trim() ? "awaiting_approval" : "draft";
        }
      }
    }

    return {
      specMarkdown: input.specMarkdown !== undefined ? nextSpec : undefined,
      state: {
        ...state,
        title: nextTitle,
        criteria: nextCriteria,
        specHash: nextSpecHash,
        approval: nextApproval,
        stage: nextStage,
        timeline: appendTimeline(state.timeline, makeEvent(now, "spec_updated", "human", summary)),
      },
    };
  });

  return toDetail(bundle, input.currentCodeSnapshotHash ?? null);
}

export async function markDesigning(
  root: string,
  id: string,
  input: { expectedRevision?: number; currentCodeSnapshotHash?: string | null } = {},
): Promise<RequirementDetail> {
  const bundle = await mutateRequirement(root, id, input.expectedRevision, (current, now) => {
    const { state } = current;
    if (state.stage !== "draft" && state.stage !== "designing") {
      throw new WorkbenchError("invalid_transition", `只有草稿或起草中状态才能通知 Agent 整理方案（当前：${state.stage}）`);
    }
    const timeline =
      state.stage === "draft"
        ? appendTimeline(state.timeline, makeEvent(now, "spec_updated", "human", "已通知 Agent 整理规范与方案"))
        : state.timeline;
    return {
      state: {
        ...state,
        stage: "designing",
        timeline,
      },
    };
  });

  return toDetail(bundle, input.currentCodeSnapshotHash ?? null);
}

export async function propose(
  root: string,
  id: string,
  input: {
    title?: string;
    specMarkdown?: string;
    criteria?: CriterionInput[];
    designMarkdown?: string;
    summary?: string;
    handoffNote?: { keyDecisions?: string[]; deadEnds?: string[]; nextSteps?: string[] };
    expectedRevision?: number;
    actor?: "agent" | "human";
    currentCodeSnapshotHash?: string | null;
  },
): Promise<RequirementDetail> {
  const bundle = await mutateRequirement(root, id, input.expectedRevision, (current, now) => {
    const { state } = current;
    if (state.stage === "done" || state.stage === "cancelled" || state.stage === "blocked") {
      throw new WorkbenchError("invalid_transition", `当前阶段（${state.stage}）不能提交方案或规范提案`);
    }
    if (
      input.title === undefined &&
      input.specMarkdown === undefined &&
      input.criteria === undefined &&
      input.designMarkdown === undefined
    ) {
      throw new WorkbenchError("invalid_input", "propose 至少需要更新 title、spec、criteria 或 design 中的一项");
    }

    const nextTitle = input.title !== undefined ? normalizeTitle(input.title) : state.title;
    const nextSpec =
      input.specMarkdown !== undefined
        ? validateMarkdownContent(input.specMarkdown, "spec", false)
        : current.specMarkdown;
    const nextCriteria = input.criteria !== undefined ? normalizeCriteria(input.criteria) : state.criteria;
    const nextDesign =
      input.designMarkdown !== undefined
        ? validateMarkdownContent(input.designMarkdown, "design", true)
        : current.designMarkdown;

    const nextSpecHash = computeSpecHash(nextSpec, nextCriteria);
    const nextDesignHash = computeDesignHash(nextDesign);
    const specChanged = nextSpecHash !== state.specHash;
    const designChanged = nextDesignHash !== state.designHash;

    let nextDesignVersion = state.designVersion;
    let snapshotDesignVersion: number | undefined;
    if (designChanged && nextDesignHash !== "") {
      nextDesignVersion += 1;
      snapshotDesignVersion = nextDesignVersion;
    }

    let nextApproval = state.approval;
    let nextStage = state.stage;
    const actor = input.actor ?? "agent";

    if (nextApproval !== null && (specChanged || designChanged)) {
      if (
        state.track === "fast_track" &&
        state.approval?.track === "fast_track" &&
        actor === "agent" &&
        state.criteria.length === 0 &&
        !designChanged &&
        nextSpec === current.specMarkdown &&
        nextTitle === state.title
      ) {
        // Fast-track started with 0 criteria; allow agent to populate initial testable criteria without resetting approval.
        nextStage = "implementing";
        nextApproval = {
          ...state.approval,
          specHash: nextSpecHash,
        };
      } else {
        // Any change to spec/criteria/design invalidates prior approval and forces human re-check.
        nextApproval = null;
        nextStage = "awaiting_approval";
      }
    } else if (state.stage === "draft" || state.stage === "designing") {
      if (nextDesignHash !== "" || state.track === "plan_first") {
        nextStage = "awaiting_approval";
      }
    }

    const kind: TimelineEventKind = designChanged ? "design_proposed" : "spec_updated";
    const eventSummary =
      input.summary?.trim() ||
      (designChanged && nextDesignHash !== ""
        ? `提交技术方案 v${nextDesignVersion}`
        : "更新需求规范与验收条件");

    const nextHandoffNote = normalizeHandoffNoteInput(input.handoffNote, state.handoffNote, now);

    return {
      specMarkdown: input.specMarkdown !== undefined ? nextSpec : undefined,
      designMarkdown: input.designMarkdown !== undefined ? nextDesign : undefined,
      snapshotDesignVersion,
      state: {
        ...state,
        title: nextTitle,
        criteria: nextCriteria,
        specHash: nextSpecHash,
        designVersion: nextDesignVersion,
        designHash: nextDesignHash,
        approval: nextApproval,
        stage: nextStage,
        lastFeedback: null,
        ...(nextHandoffNote !== undefined ? { handoffNote: nextHandoffNote } : {}),
        timeline: appendTimeline(state.timeline, makeEvent(now, kind, actor, eventSummary)),
      },
    };
  });

  return toDetail(bundle, input.currentCodeSnapshotHash ?? null);
}

export async function approveDesign(
  root: string,
  id: string,
  input: {
    expectedRevision?: number;
    baseline?: BaselineSnapshot | null;
    note?: string;
    currentCodeSnapshotHash?: string | null;
  } = {},
): Promise<RequirementDetail> {
  const bundle = await mutateRequirement(root, id, input.expectedRevision, (current, now) => {
    const { state } = current;
    if (state.stage !== "awaiting_approval" && state.stage !== "designing") {
      throw new WorkbenchError("invalid_transition", `当前阶段（${state.stage}）无法执行方案批准`);
    }
    if (!current.designMarkdown.trim() || state.designHash === "" || state.designVersion < 1) {
      throw new WorkbenchError("approval_required", "尚未提交可批准的技术方案正文（design.md）");
    }
    const note = input.note?.trim() ? normalizeReason(input.note, "批准备注") : undefined;
    const baseline = input.baseline ?? state.baseline;
    return {
      snapshotSpecRevision: state.revision,
      state: {
        ...state,
        track: "plan_first",
        stage: "implementing",
        baseline,
        lastFeedback: null,
        approval: {
          approvedAt: now,
          track: "plan_first",
          specHash: state.specHash,
          designVersion: state.designVersion,
          designHash: state.designHash,
          baselineHead: baseline?.head ?? null,
          baselineFingerprint: baseline?.fingerprint ?? null,
          ...(note ? { note } : {}),
        },
        timeline: appendTimeline(
          state.timeline,
          makeEvent(now, "approved", "human", `批准方案 v${state.designVersion}，进入实施阶段`, note),
        ),
      },
    };
  });

  return toDetail(bundle, input.currentCodeSnapshotHash ?? null);
}

export async function authorizeFastTrack(
  root: string,
  id: string,
  input: {
    expectedRevision?: number;
    baseline?: BaselineSnapshot | null;
    note?: string;
    currentCodeSnapshotHash?: string | null;
  } = {},
): Promise<RequirementDetail> {
  const bundle = await mutateRequirement(root, id, input.expectedRevision, (current, now) => {
    const { state } = current;
    if (state.stage !== "draft" && state.stage !== "designing" && state.stage !== "awaiting_approval") {
      throw new WorkbenchError("invalid_transition", `当前阶段（${state.stage}）不能启用快速通道`);
    }
    const note = input.note?.trim() ? normalizeReason(input.note, "授权说明") : undefined;
    const baseline = input.baseline ?? state.baseline;
    return {
      snapshotSpecRevision: state.revision,
      state: {
        ...state,
        track: "fast_track",
        stage: "implementing",
        baseline,
        lastFeedback: null,
        approval: {
          approvedAt: now,
          track: "fast_track",
          specHash: state.specHash,
          designVersion: state.designVersion,
          designHash: state.designHash,
          baselineHead: baseline?.head ?? null,
          baselineFingerprint: baseline?.fingerprint ?? null,
          ...(note ? { note } : {}),
        },
        timeline: appendTimeline(
          state.timeline,
          makeEvent(now, "fast_tracked", "human", "启用快速通道，跳过方案审批直接进入实施与验证", note),
        ),
      },
    };
  });

  return toDetail(bundle, input.currentCodeSnapshotHash ?? null);
}

export async function requestChanges(
  root: string,
  id: string,
  input: { feedback: string; expectedRevision?: number; currentCodeSnapshotHash?: string | null },
): Promise<RequirementDetail> {
  const feedback = normalizeReason(input.feedback, "修改意见");
  const bundle = await mutateRequirement(root, id, input.expectedRevision, (current, now) => {
    const { state } = current;
    if (state.stage === "awaiting_approval") {
      return {
        state: {
          ...state,
          stage: "designing",
          approval: null,
          lastFeedback: feedback,
          timeline: appendTimeline(
            state.timeline,
            makeEvent(now, "changes_requested", "human", "退回方案，要求修改", feedback),
          ),
        },
      };
    }
    if (state.stage === "awaiting_acceptance" || state.stage === "implementing") {
      return {
        state: {
          ...state,
          stage: "implementing",
          lastFeedback: feedback,
          timeline: appendTimeline(state.timeline, makeEvent(now, "rejected", "human", "验收打回修改", feedback)),
        },
      };
    }
    throw new WorkbenchError("invalid_transition", `当前阶段（${state.stage}）不支持退回修改`);
  });

  return toDetail(bundle, input.currentCodeSnapshotHash ?? null);
}

export async function updateTasks(
  root: string,
  id: string,
  input: {
    tasks?: TaskInput[];
    readyForAcceptance?: boolean;
    note?: string;
    handoffNote?: { keyDecisions?: string[]; deadEnds?: string[]; nextSteps?: string[] };
    expectedRevision?: number;
    actor?: "agent" | "human";
    currentCodeSnapshotHash?: string | null;
  },
): Promise<RequirementDetail> {
  const bundle = await mutateRequirement(root, id, input.expectedRevision, (current, now) => {
    const { state } = current;
    if (state.stage === "done" || state.stage === "cancelled" || state.stage === "blocked") {
      throw new WorkbenchError("invalid_transition", `当前阶段（${state.stage}）不允许更新任务进度`);
    }
    if (input.tasks === undefined && input.readyForAcceptance !== true) {
      throw new WorkbenchError("invalid_input", "请提供 tasks 或设置 readyForAcceptance=true");
    }

    const nextTasks = input.tasks !== undefined ? normalizeTasks(input.tasks, state.tasks, now) : state.tasks;
    const note = input.note?.trim() ? normalizeReason(input.note, "进度说明") : undefined;
    const actor = input.actor ?? "agent";

    let nextStage: Stage = state.stage;
    let nextTimeline = state.timeline;

    if (input.tasks !== undefined) {
      const doneCount = nextTasks.filter((t) => t.status === "done").length;
      nextTimeline = appendTimeline(
        nextTimeline,
        makeEvent(now, "tasks_updated", actor, `更新实施任务进度（${doneCount}/${nextTasks.length}）`, note),
      );
    }

    if (input.readyForAcceptance === true) {
      if (state.stage !== "implementing" && state.stage !== "awaiting_acceptance") {
        throw new WorkbenchError(
          "approval_required",
          `需求必须先经人工批准或授权快速通道并处于实施阶段后才能提交验收（当前：${state.stage}）`,
        );
      }
      const candidateState: RequirementState = { ...state, tasks: nextTasks };
      const validity = evaluateRequirement(candidateState, input.currentCodeSnapshotHash ?? null);
      if (!validity.acceptanceGate.ok) {
        throw new WorkbenchError(
          "acceptance_gate_failed",
          `尚不满足提交验收条件：${validity.acceptanceGate.blockers.join("；")}`,
          { blockers: validity.acceptanceGate.blockers },
        );
      }
      nextStage = "awaiting_acceptance";
      nextTimeline = appendTimeline(
        nextTimeline,
        makeEvent(now, "submitted_for_acceptance", actor, "所有必需验证已通过，提交人类最终验收", note),
      );
    }

    const nextHandoffNote = normalizeHandoffNoteInput(input.handoffNote, state.handoffNote, now);

    return {
      state: {
        ...state,
        tasks: nextTasks,
        stage: nextStage,
        ...(nextHandoffNote !== undefined ? { handoffNote: nextHandoffNote } : {}),
        timeline: nextTimeline,
      },
    };
  });

  return toDetail(bundle, input.currentCodeSnapshotHash ?? null);
}

export async function recordVerification(
  root: string,
  id: string,
  input: {
    record: VerificationRecord;
    rawLog: string;
    currentCodeSnapshotHash?: string | null;
  },
): Promise<RequirementDetail> {
  const record = validateVerificationRecord(input.record);
  const bundle = await mutateRequirement(root, id, undefined, (current, now) => {
    const { state } = current;
    if (state.stage === "done" || state.stage === "cancelled") {
      throw new WorkbenchError("invalid_transition", `终态需求（${state.stage}）不能记录新的验证结果`);
    }
    const validIds = new Set(state.criteria.map((c) => c.id));
    for (const criterionId of record.criterionIds) {
      if (!validIds.has(criterionId)) {
        throw new WorkbenchError("invalid_input", `验证关联的验收条件 ID 不存在: ${criterionId}`);
      }
    }

    const nextStage: Stage =
      state.stage === "awaiting_acceptance" && !record.passed ? "implementing" : state.stage;
    const summary = record.passed
      ? `验证通过：${record.command}（${record.durationMs}ms）`
      : `验证失败：${record.command}（${record.timedOut ? "超时" : `退出码 ${record.exitCode ?? "未知"}`}）`;

    return {
      evidenceWrite: { record, rawLog: input.rawLog },
      state: {
        ...state,
        stage: nextStage,
        verifications: [...state.verifications, record],
        timeline: appendTimeline(state.timeline, makeEvent(now, "verified", "system", summary)),
      },
    };
  });

  return toDetail(bundle, input.currentCodeSnapshotHash ?? record.codeSnapshotHash);
}

export async function acceptRequirement(
  root: string,
  id: string,
  input: {
    currentCodeSnapshotHash: string | null;
    expectedRevision?: number;
    note?: string;
  },
): Promise<RequirementDetail> {
  if (!input.currentCodeSnapshotHash || !/^[a-f0-9]{64}$/.test(input.currentCodeSnapshotHash)) {
    throw new WorkbenchError("acceptance_gate_failed", "缺少有效的当前代码快照指纹，无法完成验收");
  }
  const snapshotHash = input.currentCodeSnapshotHash;
  const bundle = await mutateRequirement(root, id, input.expectedRevision, (current, now) => {
    const { state } = current;
    if (state.stage !== "implementing" && state.stage !== "awaiting_acceptance") {
      throw new WorkbenchError("invalid_transition", `当前阶段（${state.stage}）无法执行验收通过`);
    }
    const validity = evaluateRequirement(state, snapshotHash);
    if (!validity.acceptanceGate.ok) {
      throw new WorkbenchError(
        "acceptance_gate_failed",
        `验收门禁未通过：${validity.acceptanceGate.blockers.join("；")}`,
        { blockers: validity.acceptanceGate.blockers },
      );
    }

    const passingIds = validity.verifications
      .filter((v) => v.effectiveState === "passed")
      .map((v) => v.record.id);
    const note = input.note?.trim() ? normalizeReason(input.note, "验收备注") : undefined;

    return {
      state: {
        ...state,
        stage: "done",
        lastFeedback: null,
        acceptance: {
          acceptedAt: now,
          specHash: state.specHash,
          codeSnapshotHash: snapshotHash,
          verificationIds: passingIds,
          ...(note ? { note } : {}),
        },
        timeline: appendTimeline(
          state.timeline,
          makeEvent(
            now,
            "accepted",
            "human",
            `人工验收通过（覆盖 ${validity.coverage.requiredPassed}/${validity.coverage.requiredTotal} 项必需条件）`,
            note,
          ),
        ),
      },
    };
  });

  return toDetail(bundle, snapshotHash);
}

export async function blockRequirement(
  root: string,
  id: string,
  input: { reason: string; expectedRevision?: number; currentCodeSnapshotHash?: string | null },
): Promise<RequirementDetail> {
  const reason = normalizeReason(input.reason, "阻塞原因");
  const bundle = await mutateRequirement(root, id, input.expectedRevision, (current, now) => {
    const { state } = current;
    if (state.stage === "done" || state.stage === "cancelled" || state.stage === "blocked") {
      throw new WorkbenchError("invalid_transition", `当前阶段（${state.stage}）不能标记为阻塞`);
    }
    return {
      state: {
        ...state,
        blockedFrom: state.stage,
        blockedReason: reason,
        stage: "blocked",
        timeline: appendTimeline(state.timeline, makeEvent(now, "blocked", "human", "标记需求受阻", reason)),
      },
    };
  });

  return toDetail(bundle, input.currentCodeSnapshotHash ?? null);
}

export async function unblockRequirement(
  root: string,
  id: string,
  input: { expectedRevision?: number; currentCodeSnapshotHash?: string | null } = {},
): Promise<RequirementDetail> {
  const bundle = await mutateRequirement(root, id, input.expectedRevision, (current, now) => {
    const { state } = current;
    if (state.stage !== "blocked") {
      throw new WorkbenchError("invalid_transition", `只有处于阻塞状态的需求才能解除阻塞（当前：${state.stage}）`);
    }
    const targetStage: Stage =
      state.blockedFrom && state.blockedFrom !== "blocked" && state.blockedFrom !== "done" && state.blockedFrom !== "cancelled"
        ? state.blockedFrom
        : "draft";
    return {
      state: {
        ...state,
        stage: targetStage,
        blockedFrom: null,
        blockedReason: null,
        timeline: appendTimeline(state.timeline, makeEvent(now, "unblocked", "human", `解除阻塞，恢复至 ${targetStage}`)),
      },
    };
  });

  return toDetail(bundle, input.currentCodeSnapshotHash ?? null);
}

export async function cancelRequirement(
  root: string,
  id: string,
  input: { reason: string; expectedRevision?: number; currentCodeSnapshotHash?: string | null },
): Promise<RequirementDetail> {
  const reason = normalizeReason(input.reason, "取消原因");
  const bundle = await mutateRequirement(root, id, input.expectedRevision, (current, now) => {
    const { state } = current;
    if (state.stage === "done" || state.stage === "cancelled") {
      throw new WorkbenchError("invalid_transition", `终态需求（${state.stage}）不能再次取消`);
    }
    return {
      state: {
        ...state,
        stage: "cancelled",
        blockedFrom: null,
        blockedReason: reason,
        timeline: appendTimeline(state.timeline, makeEvent(now, "cancelled", "human", "取消需求", reason)),
      },
    };
  });

  return toDetail(bundle, input.currentCodeSnapshotHash ?? null);
}

export async function reopenRequirement(
  root: string,
  id: string,
  input: { reason: string; expectedRevision?: number; currentCodeSnapshotHash?: string | null },
): Promise<RequirementDetail> {
  const reason = normalizeReason(input.reason, "重开原因");
  const bundle = await mutateRequirement(root, id, input.expectedRevision, (current, now) => {
    const { state } = current;
    if (state.stage !== "done" && state.stage !== "cancelled") {
      throw new WorkbenchError("invalid_transition", `只有已完成或已取消的需求才能重新打开（当前：${state.stage}）`);
    }
    return {
      state: {
        ...state,
        stage: "draft",
        approval: null,
        acceptance: null,
        blockedFrom: null,
        blockedReason: null,
        timeline: appendTimeline(
          state.timeline,
          makeEvent(now, "reopened", "human", "重新打开需求（历史批准与验收仅作存档，不自动复用）", reason),
        ),
      },
    };
  });

  return toDetail(bundle, input.currentCodeSnapshotHash ?? null);
}

/** Appends a discussion / inline annotation entry without mutating stage or invalidating approvals. */
export async function addDiscussion(
  root: string,
  id: string,
  input: {
    actor: "human" | "agent";
    mode: "ask" | "refine";
    message: string;
    anchor?: string;
    harness?: string;
    model?: string;
    resolved?: boolean;
    expectedRevision?: number;
    currentCodeSnapshotHash?: string | null;
  },
): Promise<{ detail: RequirementDetail; entry: DiscussionEntry }> {
  const message = input.message.trim();
  if (!isSafeText(message, 32 * 1024)) {
    throw new WorkbenchError("invalid_input", "讨论或批注内容不能为空或超过长度上限");
  }
  const entry: DiscussionEntry = {
    id: `D-${Date.now()}-${randomUUID().slice(0, 6)}`,
    at: Date.now(),
    actor: input.actor,
    mode: input.mode,
    ...(input.anchor?.trim() ? { anchor: input.anchor.trim().slice(0, 120) } : {}),
    ...(input.harness?.trim() ? { harness: input.harness.trim().slice(0, 64) } : {}),
    ...(input.model?.trim() ? { model: input.model.trim().slice(0, 200) } : {}),
    message,
    ...(input.resolved !== undefined ? { resolved: input.resolved } : {}),
  };

  const bundle = await mutateRequirement(root, id, input.expectedRevision, (current, now) => {
    const { state } = current;
    const prev = state.discussions ?? [];
    const next = [...prev, entry].slice(-MAX_DISCUSSIONS);
    const label = entry.anchor ? `[${entry.anchor}] ` : "";
    const prefix = input.actor === "human" ? (input.mode === "ask" ? "提问探讨" : "添加批注") : "Agent 回复";
    return {
      state: {
        ...state,
        discussions: next,
        timeline: appendTimeline(
          state.timeline,
          makeEvent(now, "discussed", input.actor, `${prefix}：${label}${message.slice(0, 80)}`),
        ),
      },
    };
  });

  return { detail: toDetail(bundle, input.currentCodeSnapshotHash ?? null), entry };
}

export async function resolveDiscussions(
  root: string,
  id: string,
  input: { ids?: string[]; resolved?: boolean; currentCodeSnapshotHash?: string | null } = {},
): Promise<RequirementDetail> {
  const targetResolved = input.resolved ?? true;
  const bundle = await mutateRequirement(root, id, undefined, (current) => {
    const { state } = current;
    const idSet = input.ids ? new Set(input.ids) : null;
    const next = (state.discussions ?? []).map((item) =>
      idSet === null || idSet.has(item.id) ? { ...item, resolved: targetResolved } : item,
    );
    return {
      state: {
        ...state,
        discussions: next,
      },
    };
  });
  return toDetail(bundle, input.currentCodeSnapshotHash ?? null);
}

export async function startAgentRun(
  root: string,
  id: string,
  recordInput: AgentRunRecord,
  currentCodeSnapshotHash?: string | null,
): Promise<RequirementDetail> {
  const record = validateAgentRunRecord(recordInput);
  const bundle = await mutateRequirement(root, id, undefined, (current) => {
    const { state } = current;
    const prev = state.agentRuns ?? [];
    const next = [...prev.filter((r) => r.id !== record.id), record].slice(-MAX_AGENT_RUNS);
    return {
      runWrite: { record, rawLog: "" },
      state: {
        ...state,
        agentRuns: next,
      },
    };
  });
  return toDetail(bundle, currentCodeSnapshotHash ?? null);
}

export async function finishAgentRun(
  root: string,
  id: string,
  runId: string,
  patch: {
    status: "succeeded" | "failed" | "cancelled";
    endedAt: number;
    exitCode: number | null;
    durationMs: number;
    nativeSessionId?: string;
    rateLimited?: boolean;
    errorSummary?: string;
  },
  rawLog: string,
  currentCodeSnapshotHash?: string | null,
): Promise<RequirementDetail> {
  const bundle = await mutateRequirement(root, id, undefined, (current) => {
    const { state } = current;
    const prevRuns = state.agentRuns ?? [];
    const existing = prevRuns.find((r) => r.id === runId);
    if (!existing) {
      throw new WorkbenchError("not_found", `未找到运行记录 ${runId}`);
    }
    const updated: AgentRunRecord = validateAgentRunRecord({
      ...existing,
      status: patch.status,
      endedAt: patch.endedAt,
      exitCode: patch.exitCode,
      durationMs: patch.durationMs,
      ...(patch.nativeSessionId ? { nativeSessionId: patch.nativeSessionId } : {}),
      ...(patch.rateLimited !== undefined ? { rateLimited: patch.rateLimited } : {}),
      ...(patch.errorSummary ? { errorSummary: patch.errorSummary.slice(0, 600) } : {}),
    });
    const nextRuns = prevRuns.map((r) => (r.id === runId ? updated : r)).slice(-MAX_AGENT_RUNS);
    return {
      runWrite: { record: updated, rawLog },
      state: {
        ...state,
        agentRuns: nextRuns,
      },
    };
  });
  return toDetail(bundle, currentCodeSnapshotHash ?? null);
}

/** Records a cross-model code review report without bypassing human acceptance sovereignty. */
export async function recordReviewReport(
  root: string,
  id: string,
  input: {
    reviewerHarness: string;
    reviewerModel: string;
    verdict: ReviewVerdict;
    summary: string;
    markdown: string;
    reviewedSpecHash: string;
    reviewedCodeSnapshotHash: string;
  },
): Promise<RequirementDetail> {
  if (!REVIEW_VERDICTS.includes(input.verdict)) {
    throw new WorkbenchError("invalid_input", `无效的审查结论: ${String(input.verdict)}`);
  }
  const bundle = await mutateRequirement(root, id, undefined, (current, now) => {
    const { state } = current;
    const report: ReviewReport = {
      id: `REV-${now}-${randomUUID().slice(0, 6)}`,
      reviewerHarness: input.reviewerHarness.trim(),
      reviewerModel: input.reviewerModel.trim(),
      verdict: input.verdict,
      summary: input.summary.trim().slice(0, 1800) || "已完成独立代码审查",
      markdown: input.markdown.trim().slice(0, 60 * 1024) || input.summary.trim(),
      reviewedSpecHash: input.reviewedSpecHash,
      reviewedCodeSnapshotHash: input.reviewedCodeSnapshotHash,
      reviewedAt: now,
    };
    const verdictLabel = input.verdict === "pass" ? "建议通过" : input.verdict === "concern" ? "有关注点" : "建议阻塞修复";
    return {
      state: {
        ...state,
        reviewReport: report,
        timeline: appendTimeline(
          state.timeline,
          makeEvent(
            now,
            "review_submitted",
            "agent",
            `跨模型审查 [${report.reviewerHarness}/${report.reviewerModel}]：${verdictLabel}`,
            report.summary,
          ),
        ),
      },
    };
  });
  return toDetail(bundle, input.reviewedCodeSnapshotHash);
}

export async function saveHandoffMarkdown(
  root: string,
  id: string,
  markdown: string,
  currentCodeSnapshotHash?: string | null,
): Promise<RequirementDetail> {
  const valid = validateMarkdownContent(markdown, "handoff", true);
  const bundle = await mutateRequirement(root, id, undefined, (current) => ({
    handoffMarkdown: valid,
    state: current.state,
  }));
  return toDetail(bundle, currentCodeSnapshotHash ?? null);
}
