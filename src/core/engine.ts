import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { extractMessageRef, WorkbenchError, type StructuredMessageRef } from "./errors.ts";
import { atomicWriteJson, canonicalRoot, resolveSafePath, withProjectWriteLock } from "./fs.ts";
import {
  commitFilesInGit,
  countCommitsBetween,
  createFeatureBranchAtHead,
  detectOmittedDiffContent,
  getGitRemoteUrl,
  getHeadCommitInfo,
  inspectWorkingTreeForDelivery,
  listCommittedFilesBetween,
  observeGitChanges,
  observeGitSnapshot,
  pushBranchToRemote,
} from "./git.ts";
import {
  buildGiteeReasonMessageDetails,
  createOrUpdateGiteePr,
  detectGitRemoteProvider,
  inspectGiteeEnvironment,
  type GiteeApiDeps,
} from "./gitee.ts";
import {
  buildGitHubReasonMessageDetails,
  buildRequirementPrBody,
  commentOnGitHubIssue,
  createOrUpdateGitHubPr,
  inspectGitHubEnvironment,
  type GitHubCommandDeps,
} from "./github.ts";
import {
  claimAttachments,
  copyAttachments,
  normalizeAttachments,
  removeAttachment as removeAttachmentFile,
  requirementAttachmentsDir,
} from "./attachments.ts";
import { normalizeOutputLanguage } from "./language.ts";
import { getSandboxForRequirement, resolveCodeRoot } from "./sandbox.ts";
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
  ACCEPTANCE_SNAPSHOT_SCHEMA_VERSION,
  MAX_ACCEPTANCE_DIFF_BYTES,
  MAX_AGENT_RUNS,
  MAX_DISCUSSIONS,
  MAX_SNAPSHOT_VERIFICATIONS,
  MAX_TIMELINE,
  REVIEW_VERDICTS,
  SCHEMA_VERSION,
  WORKBENCH_DIR,
  type AcceptanceSnapshot,
  type AcceptanceVerificationEvidence,
  type AgentRunRecord,
  type AttachmentMeta,
  type BaselineSnapshot,
  type CriterionInput,
  type DeliveryCandidateFile,
  type DeliveryPreview,
  type DeliveryRecord,
  type DiscussionEntry,
  type GitObservation,
  type GitRemoteProvider,
  type HandoffNote,
  type OutputLanguage,
  type PrivacyMode,
  type ProjectGiteeConfig,
  type ProjectGitHubConfig,
  type ProjectMetadata,
  type RequirementDetail,
  type RequirementDiffView,
  type RequirementGitHubIssueLink,
  type RequirementGitHubLink,
  type RequirementGitHubPrLink,
  type RequirementState,
  type RequirementSummary,
  type ReviewDisposition,
  type ReviewFinding,
  type ReviewReport,
  type ReviewVerdict,
  type ScreenshotBatch,
  type ScreenshotCaptureResult,
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
  sanitizeOutput,
  validateAgentRunRecord,
  validateGitBranchName,
  validateGiteeEnterpriseSlug,
  validateGiteeRepoSlug,
  validateGitHubRepoSlug,
  validateMarkdownContent,
  validateProjectMetadata,
  validateScreenshotBatch,
  validateVerificationRecord,
} from "./validate.ts";
import {
  BASELINE_SCOPE_NOTE,
  WORKTREE_SCOPE_NOTE,
  computeDesignHash,
  computeSpecHash,
  evaluateApproval,
  evaluateRequirement,
} from "./validity.ts";

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
    validity: evaluateRequirement(bundle.state, currentCodeSnapshotHash, {
      acceptanceSnapshot: bundle.acceptanceSnapshot,
      acceptanceSnapshotStatus: bundle.acceptanceSnapshotStatus,
      acceptanceSnapshotReason: bundle.acceptanceSnapshotReason,
      acceptanceSnapshotReasonKey: bundle.acceptanceSnapshotReasonKey,
      acceptanceSnapshotReasonParams: bundle.acceptanceSnapshotReasonParams,
    }),
    acceptanceSnapshot: bundle.acceptanceSnapshot,
  };
}

function buildProgressText(
  state: RequirementState,
  requiredTotal: number,
  requiredPassed: number,
): { text: string; key: string; params?: Record<string, string | number> } {
  const tasksTotal = state.tasks.length;
  const tasksDone = state.tasks.filter((t) => t.status === "done").length;
  switch (state.stage) {
    case "draft":
      return { text: "草稿", key: "progress.draft" };
    case "designing":
      return { text: "方案起草中", key: "progress.designing" };
    case "awaiting_approval":
      return state.designVersion > 0
        ? {
            text: `方案 v${state.designVersion} 待批准`,
            key: "progress.awaitingApprovalDesign",
            params: { version: state.designVersion },
          }
        : { text: "规范变更待确认", key: "progress.specChanged" };
    case "implementing": {
      const parts: string[] = [];
      parts.push(tasksTotal > 0 ? `任务 ${tasksDone}/${tasksTotal}` : "实施中");
      if (requiredTotal > 0) parts.push(`验证 ${requiredPassed}/${requiredTotal}`);
      const key = tasksTotal > 0 ? "progress.implementingTasks" : "progress.implementing";
      return { text: parts.join(" · "), key, params: { done: tasksDone, total: tasksTotal, passed: requiredPassed, required: requiredTotal } };
    }
    case "awaiting_acceptance":
      return {
        text: `待验收 · 验证 ${requiredPassed}/${requiredTotal}`,
        key: "progress.awaitingAcceptance",
        params: { passed: requiredPassed, total: requiredTotal },
      };
    case "done":
      return { text: "已完成", key: "progress.done" };
    case "blocked":
      return { text: `已阻塞 · ${state.blockedReason ?? "未记录原因"}`, key: "progress.blocked" };
    case "cancelled":
      return { text: "已取消", key: "progress.cancelled" };
  }
}

function toSummary(bundle: RequirementBundle, currentCodeSnapshotHash: string | null): RequirementSummary {
  const { state } = bundle;
  const validity = evaluateRequirement(state, currentCodeSnapshotHash, {
    acceptanceSnapshot: bundle.acceptanceSnapshot,
    acceptanceSnapshotStatus: bundle.acceptanceSnapshotStatus,
    acceptanceSnapshotReason: bundle.acceptanceSnapshotReason,
    acceptanceSnapshotReasonKey: bundle.acceptanceSnapshotReasonKey,
    acceptanceSnapshotReasonParams: bundle.acceptanceSnapshotReasonParams,
  });
  const progress = buildProgressText(state, validity.coverage.requiredTotal, validity.coverage.requiredPassed);
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
    ...(validity.decisionReasonKey ? { decisionReasonKey: validity.decisionReasonKey } : {}),
    ...(validity.decisionReasonParams ? { decisionReasonParams: validity.decisionReasonParams } : {}),
    blockedReason: state.blockedReason,
    progressText: progress.text,
    progressKey: progress.key,
    ...(progress.params ? { progressParams: progress.params } : {}),
    ...(state.github ? { github: state.github } : {}),
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
  options: { name?: string; privacyMode?: PrivacyMode; outputLanguage?: OutputLanguage } = {},
): Promise<ProjectMetadata> {
  return storeInitProject(root, options);
}

export async function updateProjectConfig(
  root: string,
  patch: {
    name?: string;
    outputLanguage?: OutputLanguage | null;
    github?: ProjectGitHubConfig | null;
    gitee?: ProjectGiteeConfig | null;
  },
): Promise<ProjectMetadata> {
  const base = canonicalRoot(root);
  return withProjectWriteLock(base, () => {
    const projectPath = resolveSafePath(base, `${WORKBENCH_DIR}/project.json`);
    const current = readProject(base);
    const next: ProjectMetadata = {
      ...current,
      updatedAt: Date.now(),
    };

    if (patch.name !== undefined) {
      const cleanName = patch.name.trim();
      if (!isSafeText(cleanName, 200)) {
        throw new WorkbenchError("invalid_input", "项目名称无效或过长");
      }
      next.name = cleanName;
    }

    if (patch.outputLanguage === null) {
      delete next.outputLanguage;
    } else if (patch.outputLanguage !== undefined) {
      const valid = normalizeOutputLanguage(patch.outputLanguage);
      if (!valid) {
        throw new WorkbenchError("invalid_input", `不支持的输出语言: ${String(patch.outputLanguage)}`);
      }
      next.outputLanguage = valid;
    }

    if (patch.github === null) {
      delete next.github;
    } else if (patch.github !== undefined) {
      const mergedGh: ProjectGitHubConfig = { ...(current.github ?? {}) };
      if (patch.github.repo !== undefined) {
        const cleanRepo = patch.github.repo.trim();
        if (cleanRepo) mergedGh.repo = validateGitHubRepoSlug(cleanRepo);
        else delete mergedGh.repo;
      }
      if (patch.github.defaultBaseBranch !== undefined) {
        const cleanBranch = patch.github.defaultBaseBranch.trim();
        if (cleanBranch) mergedGh.defaultBaseBranch = validateGitBranchName(cleanBranch);
        else delete mergedGh.defaultBaseBranch;
      }
      if (patch.github.autoCreateIssue !== undefined) {
        mergedGh.autoCreateIssue = Boolean(patch.github.autoCreateIssue);
      }
      if (patch.github.autoSyncIssue !== undefined) {
        mergedGh.autoSyncIssue = Boolean(patch.github.autoSyncIssue);
      }
      if (Object.keys(mergedGh).length > 0) {
        next.github = mergedGh;
      } else {
        delete next.github;
      }
    }

    if (patch.gitee === null) {
      delete next.gitee;
    } else if (patch.gitee !== undefined) {
      const mergedGitee: ProjectGiteeConfig = { ...(current.gitee ?? {}) };
      if (patch.gitee.repo !== undefined) {
        const cleanRepo = patch.gitee.repo.trim();
        if (cleanRepo) mergedGitee.repo = validateGiteeRepoSlug(cleanRepo);
        else delete mergedGitee.repo;
      }
      if (patch.gitee.enterprise !== undefined) {
        const cleanEnt = patch.gitee.enterprise.trim();
        if (cleanEnt) mergedGitee.enterprise = validateGiteeEnterpriseSlug(cleanEnt);
        else delete mergedGitee.enterprise;
      }
      if (patch.gitee.defaultBaseBranch !== undefined) {
        const cleanBranch = patch.gitee.defaultBaseBranch.trim();
        if (cleanBranch) mergedGitee.defaultBaseBranch = validateGitBranchName(cleanBranch);
        else delete mergedGitee.defaultBaseBranch;
      }
      if (Object.keys(mergedGitee).length > 0) {
        next.gitee = mergedGitee;
      } else {
        delete next.gitee;
      }
    }

    const validated = validateProjectMetadata(next);
    atomicWriteJson(projectPath, validated);
    return validated;
  });
}

export interface CorruptRequirementEntry {
  id: string;
  code: string;
  message: string;
}

export function listRequirements(
  root: string,
  options: {
    scope?: "active" | "done" | "cancelled" | "all";
    stage?: Stage;
    currentCodeSnapshotHash?: string | null;
    codeSnapshotsById?: ReadonlyMap<string, string | null>;
    onCorrupt?: (entry: CorruptRequirementEntry) => void;
  } = {},
): RequirementSummary[] {
  const ids = listRequirementIds(root);
  const scope = options.scope ?? "active";
  const snapshot = options.currentCodeSnapshotHash ?? null;
  const summaries: RequirementSummary[] = [];

  for (const id of ids) {
    let bundle: RequirementBundle;
    try {
      bundle = readRequirementBundle(root, id);
    } catch (error) {
      const code = error instanceof WorkbenchError ? error.code : "corrupt_record";
      const message = error instanceof Error ? error.message : String(error);
      options.onCorrupt?.({ id, code, message });
      continue;
    }
    const stage = bundle.state.stage;
    const scopeOk =
      scope === "all" ||
      (scope === "active" && stage !== "done" && stage !== "cancelled") ||
      (scope === "done" && stage === "done") ||
      (scope === "cancelled" && stage === "cancelled");
    if (!scopeOk) continue;
    if (options.stage && stage !== options.stage) continue;
    const effectiveSnapshot = options.codeSnapshotsById?.has(id)
      ? (options.codeSnapshotsById.get(id) ?? null)
      : snapshot;
    summaries.push(toSummary(bundle, effectiveSnapshot));
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
    uiRelated?: boolean;
    currentCodeSnapshotHash?: string | null;
    /** 暂存区附件 ID，创建时认领到 .workbench/items/<REQ>/attachments/ */
    attachmentIds?: string[];
    /** 已落盘附件来源（例如痛点转正），创建时复制到新需求目录 */
    attachmentSource?: { dir: string; metas: AttachmentMeta[] };
  },
): Promise<RequirementDetail> {
  const specMarkdown = validateMarkdownContent(input.goal, "spec", false);
  const title = input.title?.trim() ? normalizeTitle(input.title) : deriveTitleFromGoal(specMarkdown);
  const criteria = input.criteria ? normalizeCriteria(input.criteria) : [];
  const track: Track = input.track === "fast_track" ? "fast_track" : "plan_first";
  const specHash = computeSpecHash(specMarkdown, criteria);

  const bundle = await createRequirementFiles(root, (id, now) => {
    let attachments: AttachmentMeta[] = [];
    if (input.attachmentIds && input.attachmentIds.length > 0) {
      attachments = claimAttachments(input.attachmentIds, requirementAttachmentsDir(root, id));
    } else if (input.attachmentSource && input.attachmentSource.metas.length > 0) {
      attachments = copyAttachments(
        input.attachmentSource.dir,
        input.attachmentSource.metas,
        requirementAttachmentsDir(root, id),
      );
    }
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
      lastFeedback: null,
      blockedFrom: null,
      blockedReason: null,
      ...(input.uiRelated === true ? { uiRelated: true } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      timeline: [
        makeEvent(now, "created", "human", `创建需求 ${id}：${title}`),
        ...(attachments.length > 0
          ? [makeEvent(now, "attachment_added", "human", `添加 ${attachments.length} 个附件`)]
          : []),
      ],
      createdAt: now,
      updatedAt: now,
    };
    return { state, specMarkdown, designMarkdown: "" };
  });

  return toDetail(bundle, input.currentCodeSnapshotHash ?? null);
}

/** 为已创建的需求补传附件（已最终验收的需求禁止变更）。 */
export async function addRequirementAttachments(
  root: string,
  id: string,
  attachmentIds: string[],
  options: { expectedRevision?: number; currentCodeSnapshotHash?: string | null } = {},
): Promise<RequirementDetail> {
  if (attachmentIds.length === 0) {
    throw new WorkbenchError("invalid_input", "请先上传附件再添加到需求");
  }
  const bundle = await mutateRequirement(root, id, options.expectedRevision, (current, now) => {
    const { state } = current;
    if (state.acceptance !== null || state.stage === "done") {
      throw new WorkbenchError("invalid_transition", `需求 ${id} 已最终验收，禁止再添加附件`);
    }
    const existing = normalizeAttachments(state.attachments) ?? [];
    const targetDir = requirementAttachmentsDir(root, id);
    const added = claimAttachments(attachmentIds, targetDir, existing);
    if (added.length === 0) return { state };
    return {
      state: {
        ...state,
        attachments: [...existing, ...added],
        timeline: appendTimeline(
          state.timeline,
          makeEvent(
            now,
            "attachment_added",
            "human",
            `添加 ${added.length} 个附件：${added.map((a) => a.name).join("、")}`.slice(0, 500),
          ),
        ),
      },
    };
  });
  return toDetail(bundle, options.currentCodeSnapshotHash ?? null);
}

/** 删除需求附件（已最终验收的需求禁止变更）。 */
export async function removeRequirementAttachment(
  root: string,
  id: string,
  attId: string,
  options: { expectedRevision?: number; currentCodeSnapshotHash?: string | null } = {},
): Promise<RequirementDetail> {
  const bundle = await mutateRequirement(root, id, options.expectedRevision, (current, now) => {
    const { state } = current;
    if (state.acceptance !== null || state.stage === "done") {
      throw new WorkbenchError("invalid_transition", `需求 ${id} 已最终验收，禁止删除附件`);
    }
    const existing = normalizeAttachments(state.attachments) ?? [];
    const targetDir = requirementAttachmentsDir(root, id);
    if (!fs.existsSync(targetDir)) {
      throw new WorkbenchError("not_found", "附件不存在");
    }
    const remaining = removeAttachmentFile(targetDir, attId, existing);
    const removed = existing.find((m) => m.id === attId);
    return {
      state: {
        ...state,
        attachments: remaining,
        timeline: appendTimeline(
          state.timeline,
          makeEvent(now, "attachment_removed", "human", `删除附件：${removed?.name ?? attId}`),
        ),
      },
    };
  });
  return toDetail(bundle, options.currentCodeSnapshotHash ?? null);
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
    if (
      (state.stage === "draft" || state.stage === "designing" || state.stage === "awaiting_approval") &&
      nextTasks.some((t) => t.status === "done")
    ) {
      throw new WorkbenchError(
        "approval_required",
        "方案尚未获得人类批准，不能把实施任务标记为完成；请先提交方案并等待批准",
      );
    }
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
          {
            blockers: validity.acceptanceGate.blockers,
            ...(validity.acceptanceGate.blockerRefs ? { blockerRefs: validity.acceptanceGate.blockerRefs } : {}),
          },
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
        ...(input.readyForAcceptance === true ? { lastFeedback: null } : {}),
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
    if (state.stage !== "implementing" && state.stage !== "awaiting_acceptance") {
      throw new WorkbenchError(
        "approval_required",
        `当前阶段（${state.stage}）不能记录验证证据；必须先获得人类方案批准并进入实施阶段`,
      );
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

export async function isUiRelatedRequirement(state: RequirementState, codeRoot: string): Promise<boolean> {
  if (state.uiRelated === true) return true;
  try {
    const observed = await observeGitChanges(codeRoot, { sinceHead: state.baseline?.head ?? null });
    return observed.files.some((file) => file.path.startsWith("src/web/"));
  } catch {
    // Git observation is best effort: an unreadable repo should not block acceptance.
    return false;
  }
}

export async function recordScreenshotBatch(
  root: string,
  id: string,
  input: {
    batch: ScreenshotBatch;
    files?: Array<{ shotId: string; bytes: Buffer }>;
    currentCodeSnapshotHash?: string | null;
  },
): Promise<RequirementDetail> {
  const batch = validateScreenshotBatch(input.batch);
  const files = input.files ?? [];
  const bundle = await mutateRequirement(root, id, undefined, (current, now) => {
    const { state } = current;
    if (state.stage === "done" || state.stage === "cancelled") {
      throw new WorkbenchError("invalid_transition", `终态需求（${state.stage}）不能记录新的截图证据`);
    }
    if (state.stage !== "implementing" && state.stage !== "awaiting_acceptance") {
      throw new WorkbenchError(
        "approval_required",
        `当前阶段（${state.stage}）不能记录截图证据；仅实施阶段或待验收阶段允许采集`,
      );
    }
    const existing = state.screenshotBatches ?? [];
    if (existing.some((item) => item.id === batch.id)) {
      throw new WorkbenchError("invalid_input", `截图批次 ID 已存在: ${batch.id}`);
    }
    const nextBatches = [...existing, batch];
    const summary =
      batch.status === "skipped"
        ? `已记录截图采集跳过：${batch.skipReason ?? "浏览器环境不可用"}`
        : batch.status === "partial"
          ? `截图证据部分完成（${batch.shots.length} 张），存在跳过项`
          : `已采集 UI 截图证据（${batch.shots.length} 张）`;
    return {
      screenshotWrite: { batch, files },
      state: {
        ...state,
        screenshotBatches: nextBatches,
        timeline: appendTimeline(
          state.timeline,
          makeEvent(now, "screenshots_captured", batch.actor, summary, batch.skipReason ?? undefined),
        ),
      },
    };
  });

  return toDetail(bundle, input.currentCodeSnapshotHash ?? batch.codeSnapshotHash);
}

function selectSnapshotVerifications(
  evaluated: ReturnType<typeof evaluateRequirement>["verifications"],
  selectedIds: Set<string>,
): { items: AcceptanceVerificationEvidence[]; omittedCount: number } {
  const mapped: AcceptanceVerificationEvidence[] = evaluated.map((ev) => ({
    record: ev.record,
    effectiveState: ev.effectiveState,
    staleReason: ev.staleReason,
    selectedForAcceptance: selectedIds.has(ev.record.id),
  }));
  if (mapped.length <= MAX_SNAPSHOT_VERIFICATIONS) {
    return { items: mapped, omittedCount: 0 };
  }
  // Always keep every selected evidence record, filling remaining slots with the most recent runs.
  const keptIndices = new Set<number>();
  for (let i = 0; i < mapped.length; i++) {
    if (mapped[i]!.selectedForAcceptance && keptIndices.size < MAX_SNAPSHOT_VERIFICATIONS) {
      keptIndices.add(i);
    }
  }
  for (let i = mapped.length - 1; i >= 0 && keptIndices.size < MAX_SNAPSHOT_VERIFICATIONS; i--) {
    keptIndices.add(i);
  }
  const items = mapped.filter((_, idx) => keptIndices.has(idx));
  return { items, omittedCount: mapped.length - items.length };
}

function buildSnapshotGitObservation(snap: AcceptanceSnapshot): GitObservation {
  return {
    isGitRepo: snap.git.isGitRepo,
    head: snap.git.observedHead,
    fingerprint: snap.git.fingerprint,
    dirty: snap.git.dirty,
    files: snap.git.files,
    filesScope: snap.git.filesScope,
    diff: snap.git.diff,
    diffBytes: snap.git.diffBytes,
    diffTruncated: snap.git.diffTruncated,
    diffStatus: snap.git.diffStatus,
    diffReason: snap.git.reason,
    binaryFiles: snap.git.binaryFiles,
    omittedFiles: snap.git.omittedFiles,
    baselineRequested: snap.git.baselineRequested,
    baselineHead: snap.git.baselineHead,
    baselineAvailable: snap.git.baselineAvailable,
    commits: snap.git.commits,
    capturedAt: snap.git.capturedAt,
  };
}

/**
 * Returns diff evidence for a requirement. Done requirements default to their frozen acceptance
 * artifact (or explicit legacy-unavailable) without reading live Git unless `live: true` is passed.
 */
export async function getRequirementDiff(
  root: string,
  id: string,
  options: { live?: boolean; maxDiffBytes?: number } = {},
): Promise<RequirementDiffView> {
  const base = canonicalRoot(root);
  const bundle = readRequirementBundle(base, id);
  const { state } = bundle;

  if (state.stage === "done" && !options.live) {
    if (bundle.acceptanceSnapshotStatus === "available" && bundle.acceptanceSnapshot) {
      const snap = bundle.acceptanceSnapshot;
      const obs = buildSnapshotGitObservation(snap);
      return {
        context: "accepted",
        status: snap.git.diffStatus,
        reason: snap.git.reason,
        acceptedAt: state.acceptance?.acceptedAt ?? snap.acceptedAt,
        snapshotId: snap.id,
        snapshotCapturedAt: snap.capturedAt,
        scopeNote: snap.git.filesScope === "baseline-relative" ? BASELINE_SCOPE_NOTE : WORKTREE_SCOPE_NOTE,
        scopeNoteKey:
          snap.git.filesScope === "baseline-relative" ? "evidence.scope.baseline" : "evidence.scope.worktree",
        observation: obs,
      };
    }
    return {
      context: "legacy-unavailable",
      status: "unavailable",
      reason:
        bundle.acceptanceSnapshotReason ??
        "历史验收记录未固化代码差异快照，无法从当前工作区回溯",
      ...(bundle.acceptanceSnapshotReasonKey
        ? { reasonKey: bundle.acceptanceSnapshotReasonKey }
        : bundle.acceptanceSnapshotReason
          ? {}
          : { reasonKey: "core.diff.noSnapshot" }),
      ...(bundle.acceptanceSnapshotReasonParams ? { reasonParams: bundle.acceptanceSnapshotReasonParams } : {}),
      acceptedAt: state.acceptance?.acceptedAt ?? null,
      snapshotId: state.acceptance?.snapshot?.id ?? null,
      snapshotCapturedAt: state.acceptance?.snapshot?.capturedAt ?? null,
      scopeNote: null,
      observation: null,
    };
  }

  const codeRoot = resolveCodeRoot(base, id);
  const changes = await observeGitChanges(codeRoot, {
    sinceHead: state.baseline?.head ?? null,
    maxDiffBytes: options.maxDiffBytes ?? MAX_ACCEPTANCE_DIFF_BYTES,
  });
  return {
    context: "live",
    status: changes.diffStatus,
    reason: changes.diffReason,
    ...(changes.diffReasonKey ? { reasonKey: changes.diffReasonKey } : {}),
    ...(changes.diffReasonParams ? { reasonParams: changes.diffReasonParams } : {}),
    acceptedAt: null,
    snapshotId: null,
    snapshotCapturedAt: null,
    scopeNote: changes.filesScope === "baseline-relative" ? BASELINE_SCOPE_NOTE : changes.filesScope === "worktree" ? WORKTREE_SCOPE_NOTE : null,
    ...(changes.filesScope === "baseline-relative"
      ? { scopeNoteKey: "evidence.scope.baseline" }
      : changes.filesScope === "worktree"
        ? { scopeNoteKey: "evidence.scope.worktree" }
        : {}),
    observation: changes,
  };
}

export async function acceptRequirement(
  root: string,
  id: string,
  input: {
    currentCodeSnapshotHash: string | null;
    expectedRevision?: number;
    note?: string;
    overrideReason?: string;
    acceptedRisks?: string[];
  },
): Promise<RequirementDetail> {
  if (!input.currentCodeSnapshotHash || !/^[a-f0-9]{64}$/.test(input.currentCodeSnapshotHash)) {
    throw new WorkbenchError("acceptance_gate_failed", "缺少有效的当前代码快照指纹，无法完成验收", {
      messageKey: "accept.errMissingSnapshotHash",
    });
  }
  const base = canonicalRoot(root);
  const snapshotHash = input.currentCodeSnapshotHash;
  const codeRoot = resolveCodeRoot(base, id);
  const codeRootKind = codeRoot !== base ? "sandbox" : "project";
  if (!fs.existsSync(codeRoot)) {
    throw new WorkbenchError("acceptance_gate_failed", "代码根目录不存在，无法捕获验收快照", {
      messageKey: "accept.errMissingCodeRoot",
    });
  }

  // Pre-flight gate & baseline-relative change capture outside the lock to keep lock hold minimal.
  const preBundle = readRequirementBundle(base, id);
  if (input.expectedRevision !== undefined && preBundle.state.revision !== input.expectedRevision) {
    throw new WorkbenchError(
      "revision_conflict",
      `版本冲突：期望 revision=${input.expectedRevision}，实际 revision=${preBundle.state.revision}`,
      {
        expectedRevision: input.expectedRevision,
        actualRevision: preBundle.state.revision,
        messageKey: "accept.errRevisionConflict",
        messageParams: {
          expected: input.expectedRevision,
          actual: preBundle.state.revision,
        },
      },
    );
  }
  if (preBundle.state.stage !== "implementing" && preBundle.state.stage !== "awaiting_acceptance") {
    throw new WorkbenchError("invalid_transition", `当前阶段（${preBundle.state.stage}）无法执行验收通过`, {
      messageKey: "accept.errInvalidStage",
      messageParams: { stage: preBundle.state.stage },
    });
  }
  const preValidity = evaluateRequirement(preBundle.state, snapshotHash);
  if (!preValidity.acceptanceGate.ok) {
    throw new WorkbenchError(
      "acceptance_gate_failed",
      `验收门禁未通过：${preValidity.acceptanceGate.blockers.join("；")}`,
      {
        blockers: preValidity.acceptanceGate.blockers,
        ...(preValidity.acceptanceGate.blockerRefs ? { blockerRefs: preValidity.acceptanceGate.blockerRefs } : {}),
      },
    );
  }
  const overrideReason = input.overrideReason?.trim()
    ? normalizeReason(input.overrideReason, "忽略审查阻塞/接受风险说明")
    : undefined;
  if (
    preValidity.reviewValidity.effectiveState === "current" &&
    preBundle.state.reviewReport?.verdict === "block" &&
    !overrideReason
  ) {
    throw new WorkbenchError(
      "acceptance_gate_failed",
      "当前存在有效的阻塞级（block）跨模型审查意见，强行验收必须填写说明理由（overrideReason）",
      {
        reviewVerdict: "block",
        messageKey: "accept.errReviewBlockRequiresOverride",
      },
    );
  }

  const baselineHead = preBundle.state.baseline?.head ?? null;
  const gitObs = await observeGitChanges(codeRoot, {
    sinceHead: baselineHead,
    maxDiffBytes: MAX_ACCEPTANCE_DIFF_BYTES,
  });

  if (gitObs.isGitRepo) {
    if (baselineHead && !gitObs.baselineAvailable) {
      throw new WorkbenchError(
        "acceptance_gate_failed",
        gitObs.diffReason ?? "验收基线在当前仓库中不可用，无法捕获可信的基线相对 Diff",
        {
          messageKey: gitObs.diffReasonKey ?? "accept.errBaselineUnavailable",
          ...(gitObs.diffReasonParams ? { messageParams: gitObs.diffReasonParams } : {}),
        },
      );
    }
    if (gitObs.diffStatus === "unavailable") {
      throw new WorkbenchError(
        "acceptance_gate_failed",
        gitObs.diffReason ?? "无法捕获验收代码差异快照",
        {
          messageKey: gitObs.diffReasonKey ?? "accept.errDiffUnavailable",
          ...(gitObs.diffReasonParams ? { messageParams: gitObs.diffReasonParams } : {}),
        },
      );
    }
    if (gitObs.fingerprint !== snapshotHash) {
      throw new WorkbenchError(
        "revision_conflict",
        "代码工作区在验收采集期间发生变化，请刷新状态与 Diff 后重试",
        { messageKey: "accept.errWorkspaceChanged" },
      );
    }
  } else if (baselineHead) {
    throw new WorkbenchError("acceptance_gate_failed", "目标目录已不再是 Git 仓库，无法捕获验收快照", {
      messageKey: "accept.errNotGitRepo",
    });
  }

  const sanitized = sanitizeOutput(gitObs.diff, MAX_ACCEPTANCE_DIFF_BYTES);
  const frozenDiff = gitObs.diffStatus === "captured" ? sanitized.text : "";
  const frozenDiffTruncated = gitObs.diffStatus === "captured" ? gitObs.diffTruncated || sanitized.truncated : false;
  const frozenOmitted =
    gitObs.diffStatus === "captured" ? detectOmittedDiffContent(frozenDiff) : { binaryFiles: [], omittedFiles: [] };

  const bundle = await mutateRequirement(base, id, input.expectedRevision, async (current, now) => {
    const { state } = current;
    if (state.stage !== "implementing" && state.stage !== "awaiting_acceptance") {
      throw new WorkbenchError("invalid_transition", `当前阶段（${state.stage}）无法执行验收通过`, {
        messageKey: "accept.errInvalidStage",
        messageParams: { stage: state.stage },
      });
    }
    if ((state.baseline?.head ?? null) !== baselineHead) {
      throw new WorkbenchError("revision_conflict", "需求基线在验收期间发生变化，请刷新后重试", {
        messageKey: "accept.errBaselineChanged",
      });
    }

    const validity = evaluateRequirement(state, snapshotHash);
    if (!validity.acceptanceGate.ok) {
      throw new WorkbenchError(
        "acceptance_gate_failed",
        `验收门禁未通过：${validity.acceptanceGate.blockers.join("；")}`,
        {
          blockers: validity.acceptanceGate.blockers,
          ...(validity.acceptanceGate.blockerRefs ? { blockerRefs: validity.acceptanceGate.blockerRefs } : {}),
        },
      );
    }
    if (
      validity.reviewValidity.effectiveState === "current" &&
      state.reviewReport?.verdict === "block" &&
      !overrideReason
    ) {
      throw new WorkbenchError(
        "acceptance_gate_failed",
        "当前存在有效的阻塞级（block）跨模型审查意见，强行验收必须填写说明理由（overrideReason）",
        {
          reviewVerdict: "block",
          messageKey: "accept.errReviewBlockRequiresOverride",
        },
      );
    }

    if (gitObs.isGitRepo) {
      const postSnap = await observeGitSnapshot(codeRoot);
      if (!postSnap || postSnap.fingerprint !== snapshotHash) {
        throw new WorkbenchError(
          "revision_conflict",
          "代码工作区在验收提交期间发生变化，已拒绝落盘，请刷新后重试",
          { messageKey: "accept.errWorkspaceChangedOnSave" },
        );
      }
    }

    const passingIds = validity.verifications
      .filter((v) => v.effectiveState === "passed")
      .map((v) => v.record.id);
    const passingSet = new Set(passingIds);
    const note = input.note?.trim() ? normalizeReason(input.note, "验收备注") : undefined;
    const acceptedRisks = Array.isArray(input.acceptedRisks)
      ? input.acceptedRisks
          .filter((r): r is string => typeof r === "string")
          .map((r) => sanitizeOutput(r.trim(), 900).text.trim())
          .filter(Boolean)
          .slice(0, 50)
      : undefined;
    const reviewDisposition: ReviewDisposition | undefined =
      state.reviewReport || overrideReason
        ? {
            ...(state.reviewReport
              ? { reviewId: state.reviewReport.id, verdict: state.reviewReport.verdict }
              : {}),
            effectiveState: validity.reviewValidity.effectiveState,
            ...(acceptedRisks && acceptedRisks.length > 0 ? { acceptedRisks } : {}),
          }
        : undefined;
    const timelineDetailParts = [
      overrideReason ? `放行/风险接受理由：${overrideReason}` : "",
      acceptedRisks && acceptedRisks.length > 0 ? `已接受风险项（${acceptedRisks.length}）：${acceptedRisks.join("；")}` : "",
      note ?? "",
    ].filter(Boolean);
    const timelineDetail = timelineDetailParts.length > 0 ? timelineDetailParts.join("\n") : undefined;
    const { items: frozenVerifications, omittedCount } = selectSnapshotVerifications(
      validity.verifications,
      passingSet,
    );

    const snapshotId = `ACC-${now}-${randomUUID().slice(0, 6)}`;
    const snapshot: AcceptanceSnapshot = {
      schemaVersion: ACCEPTANCE_SNAPSHOT_SCHEMA_VERSION,
      id: snapshotId,
      requirementId: state.id,
      capturedAt: gitObs.capturedAt,
      acceptedAt: now,
      specHash: state.specHash,
      designHash: state.designHash,
      codeSnapshotHash: snapshotHash,
      codeRootKind,
      criteria: state.criteria.map((c) => ({ ...c })),
      coverage: validity.coverage.items.map((item) => ({
        criterion: { ...item.criterion },
        state: item.state,
        verificationIds: [...item.verificationIds],
        reason: item.reason,
      })),
      requiredTotal: validity.coverage.requiredTotal,
      requiredPassed: validity.coverage.requiredPassed,
      verifications: frozenVerifications,
      omittedVerificationCount: omittedCount,
      git: {
        diffStatus: gitObs.diffStatus,
        reason: gitObs.diffReason,
        isGitRepo: gitObs.isGitRepo,
        baselineRequested: gitObs.baselineRequested,
        baselineHead: gitObs.baselineHead,
        baselineAvailable: gitObs.baselineAvailable,
        observedHead: gitObs.head,
        fingerprint: gitObs.fingerprint,
        dirty: gitObs.dirty,
        files: gitObs.files,
        filesScope: gitObs.filesScope,
        commits: gitObs.commits,
        diff: frozenDiff,
        diffBytes: Buffer.byteLength(frozenDiff, "utf8"),
        diffTruncated: frozenDiffTruncated,
        maxDiffBytes: MAX_ACCEPTANCE_DIFF_BYTES,
        binaryFiles: frozenOmitted.binaryFiles,
        omittedFiles: frozenOmitted.omittedFiles,
        capturedAt: gitObs.capturedAt,
      },
      ...(state.screenshotBatches && state.screenshotBatches.length > 0
        ? {
            screenshots: state.screenshotBatches.map((batch) => ({
              ...batch,
              shots: batch.shots.map((shot) => ({ ...shot })),
            })),
          }
        : {}),
      contentDigest: "0".repeat(64),
    };

    return {
      acceptanceSnapshotWrite: { snapshot },
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
          ...(overrideReason ? { overrideReason } : {}),
          ...(reviewDisposition ? { reviewDisposition } : {}),
        },
        timeline: appendTimeline(
          state.timeline,
          makeEvent(
            now,
            "accepted",
            "human",
            overrideReason
              ? `人工带理由验收通过（覆盖 ${validity.coverage.requiredPassed}/${validity.coverage.requiredTotal} 项必需条件 · 已记录风险放行）`
              : `人工验收通过（覆盖 ${validity.coverage.requiredPassed}/${validity.coverage.requiredTotal} 项必需条件）`,
            timelineDetail,
          ),
        ),
      },
    };
  });

  return toDetail(bundle, snapshotHash);
}

function buildSuggestedCommitMessage(id: string, title: string): string {
  const cleanTitle = title.replace(/[\r\n]+/g, " ").trim().slice(0, 72) || "complete requirement";
  return `feat(${id.toLowerCase()}): ${cleanTitle}`;
}

function normalizeDeliveryFiles(files: string[]): string[] {
  if (!Array.isArray(files) || files.length === 0) {
    throw new WorkbenchError("invalid_input", "请至少选择 1 个要提交的文件");
  }
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of files) {
    if (typeof raw !== "string") {
      throw new WorkbenchError("invalid_input", "交付文件路径必须是字符串");
    }
    const trimmed = raw.trim();
    if (
      !trimmed ||
      !isSafeText(trimmed, 4096) ||
      trimmed.startsWith("/") ||
      trimmed.split("/").includes("..") ||
      trimmed === ".workbench" ||
      trimmed.startsWith(".workbench/") ||
      trimmed === ".omp/workbench" ||
      trimmed.startsWith(".omp/workbench/")
    ) {
      throw new WorkbenchError("invalid_input", `非法或不予提交的路径: ${raw}`);
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      unique.push(trimmed);
    }
  }
  return unique;
}

export type DeliveryCommandDeps = GitHubCommandDeps & {
  giteeDeps?: GiteeApiDeps;
  giteeToken?: string | null;
};

async function resolveProjectRemoteProvider(
  base: string,
  projectMeta: ProjectMetadata,
  deps?: DeliveryCommandDeps,
): Promise<GitRemoteProvider | null> {
  if (projectMeta.gitee?.repo || projectMeta.gitee?.enterprise) return "gitee";
  if (projectMeta.github?.repo) return "github";
  const remoteUrl = deps?.giteeDeps?.getRemoteUrl
    ? await deps.giteeDeps.getRemoteUrl(base)
    : deps?.getRemoteUrl
      ? await deps.getRemoteUrl(base)
      : await getGitRemoteUrl(base);
  const detected = detectGitRemoteProvider(remoteUrl);
  if (detected) return detected;
  if (projectMeta.gitee) return "gitee";
  return null;
}

/** Previews workspace or RSI sandbox changes for post-acceptance Git commit & GitHub/Gitee PR delivery. */
export async function getRequirementDeliveryPreview(
  root: string,
  id: string,
  deps?: DeliveryCommandDeps,
): Promise<DeliveryPreview> {
  const base = canonicalRoot(root);
  const bundle = readRequirementBundle(base, id);
  const projectMeta = readProject(base);
  const { state } = bundle;
  const sandbox = getSandboxForRequirement(base, id);
  const sandboxActive = Boolean(sandbox);
  const codeRoot = sandbox ? sandbox.worktreePath : base;
  const codeRootKind = sandbox ? "sandbox" : "project";
  const tree = await inspectWorkingTreeForDelivery(codeRoot);
  const acceptedSet = new Set((bundle.acceptanceSnapshot?.git.files ?? []).map((f) => f.path));

  const candidates: DeliveryCandidateFile[] = tree.files.map((f) => ({
    path: f.path,
    status: f.status,
    staged: f.staged,
    unstaged: f.unstaged,
    inAcceptedSnapshot: acceptedSet.has(f.path),
  }));

  const remoteProvider = await resolveProjectRemoteProvider(base, projectMeta, deps);
  let baseBranch: string;
  let remoteRepo: string | null;
  let remoteReady: boolean;
  let remoteReason: string | null;

  if (remoteProvider === "gitee") {
    const giteeEnv = await inspectGiteeEnvironment(
      base,
      projectMeta.gitee,
      deps?.giteeToken ?? deps?.giteeDeps?.token,
      deps?.giteeDeps,
    );
    baseBranch = projectMeta.gitee?.defaultBaseBranch ?? giteeEnv.defaultBaseBranch ?? "master";
    remoteRepo = giteeEnv.repo;
    remoteReady = giteeEnv.ready;
    remoteReason = giteeEnv.reason;
  } else {
    const ghEnv = await inspectGitHubEnvironment(base, projectMeta.github, deps);
    baseBranch = projectMeta.github?.defaultBaseBranch ?? ghEnv.defaultBaseBranch ?? "main";
    remoteRepo = ghEnv.repo;
    remoteReady = ghEnv.ready;
    remoteReason = ghEnv.reason;
  }

  const aheadRef = sandbox
    ? (sandbox.baseHead ?? baseBranch)
    : tree.branch && tree.branch !== baseBranch
      ? baseBranch
      : null;
  const aheadCommitsCount = tree.isGitRepo && aheadRef ? await countCommitsBetween(codeRoot, aheadRef, "HEAD") : 0;

  let reason: string | null = null;
  let canCommit = false;
  let canCreatePr = false;

  if (state.stage !== "done") {
    reason = "仅已验收完成（done）的需求可执行交付提交";
  } else if (!tree.isGitRepo) {
    reason = "当前目录不是 Git 仓库，无法创建交付提交";
  } else if (sandboxActive) {
    if (candidates.length === 0 && aheadCommitsCount === 0) {
      reason = "隔离沙箱中暂无可提交或待推送的变更";
    } else if (!remoteReady) {
      reason =
        remoteReason ??
        (remoteProvider === "gitee"
          ? "Gitee 环境未就绪，可使用「应用沙箱改动」本地合并"
          : "GitHub 环境未就绪，可使用「应用沙箱改动」本地合并");
    } else {
      canCreatePr = true;
    }
  } else {
    if (candidates.length === 0 && aheadCommitsCount === 0) {
      reason = "当前工作区干净，暂无未提交改动";
    } else {
      canCommit = candidates.length > 0;
      canCreatePr = remoteReady && (candidates.length > 0 || aheadCommitsCount > 0);
    }
  }

  const suggestedBranch = sandbox
    ? sandbox.branch
    : tree.branch && tree.branch !== baseBranch && tree.branch !== "master"
      ? tree.branch
      : `feat/${state.id.toLowerCase()}`;

  return {
    requirementId: state.id,
    stage: state.stage,
    isGitRepo: tree.isGitRepo,
    codeRootKind,
    branch: tree.branch,
    head: tree.head,
    dirty: tree.dirty,
    sandboxActive,
    aheadCommitsCount,
    canCommit,
    canCreatePr,
    remoteProvider,
    baseBranch,
    githubRepo: remoteRepo,
    githubReady: remoteReady,
    githubReason: remoteReason,
    reason,
    suggestedMessage: buildSuggestedCommitMessage(state.id, state.title),
    suggestedBranch,
    candidates,
    acceptedSnapshotFileCount: acceptedSet.size,
    delivered: state.delivery ?? null,
    githubPr: state.github?.pr ?? null,
  };
}

/**
 * Commits selected files to Git (and optionally pushes branch + opens/updates a GitHub PR
 * from either the main workspace or an isolated RSI sandbox worktree) without altering acceptance.
 */
export async function deliverRequirement(
  root: string,
  id: string,
  input: {
    files: string[];
    commitMessage: string;
    expectedRevision?: number;
    note?: string;
    createPr?: boolean;
    branchName?: string;
    baseBranch?: string;
    prTitle?: string;
    prBody?: string;
  },
  deps?: DeliveryCommandDeps,
): Promise<{
  detail: RequirementDetail;
  delivery: DeliveryRecord;
  pr?: RequirementGitHubPrLink;
  githubSyncWarning?: string;
  githubSyncWarningRef?: StructuredMessageRef;
  touchesWeb: boolean;
  touchesBackend: boolean;
}> {
  const base = canonicalRoot(root);
  const createPr = input.createPr === true;
  const note = input.note?.trim() ? normalizeReason(input.note, "交付备注") : undefined;

  if (!createPr) {
    const files = normalizeDeliveryFiles(input.files);
    const commitMessage = typeof input.commitMessage === "string" ? input.commitMessage.trim() : "";
    if (!commitMessage || !isSafeText(commitMessage, 4000)) {
      throw new WorkbenchError("invalid_input", "请填写合法的 Git 提交说明");
    }

    let recordedDelivery: DeliveryRecord | null = null;
    const bundle = await mutateRequirement(base, id, input.expectedRevision, async (current, now) => {
      const { state } = current;
      if (state.stage !== "done") {
        throw new WorkbenchError("invalid_transition", `仅已验收完成的需求才能执行交付提交（当前：${state.stage}）`);
      }
      if (getSandboxForRequirement(base, id)) {
        throw new WorkbenchError("invalid_transition", "改动仍在隔离沙箱中，请勾选提交 GitHub PR 或先应用沙箱改动到主干");
      }
      const tree = await inspectWorkingTreeForDelivery(base);
      if (!tree.isGitRepo) {
        throw new WorkbenchError("execution_failed", "当前目录不是 Git 仓库，无法创建交付提交");
      }
      const dirtySet = new Set(tree.files.map((f) => f.path));
      const missing = files.filter((f) => !dirtySet.has(f));
      if (missing.length > 0) {
        throw new WorkbenchError(
          "invalid_input",
          `以下文件当前没有未提交变更，无法纳入提交: ${missing.slice(0, 5).join(", ")}`,
        );
      }

      const committed = await commitFilesInGit(base, files, commitMessage);
      const delivery: DeliveryRecord = {
        deliveredAt: now,
        commitHash: committed.commitHash,
        shortHash: committed.shortHash,
        commitMessage,
        files,
        branch: committed.branch,
        ...(note ? { note } : {}),
      };
      recordedDelivery = delivery;

      const firstLine = commitMessage.split(/\r?\n/, 1)[0] ?? commitMessage;
      return {
        state: {
          ...state,
          delivery,
          timeline: appendTimeline(
            state.timeline,
            makeEvent(
              now,
              "delivered",
              "human",
              `已提交代码交付（${committed.shortHash} · ${files.length} 个文件）：${firstLine.slice(0, 140)}`,
              note,
            ),
          ),
        },
      };
    });

    const postSnap = await observeGitSnapshot(base);
    const touchesWeb = files.some((f) => f.startsWith("src/web/"));
    const touchesBackend = files.some(
      (f) =>
        f.startsWith("src/server/") ||
        f.startsWith("src/hub/") ||
        f.startsWith("src/core/") ||
        f.startsWith("src/cli/") ||
        f.startsWith("src/mcp/"),
    );

    return {
      detail: toDetail(bundle, postSnap?.fingerprint ?? null),
      delivery: recordedDelivery!,
      touchesWeb,
      touchesBackend,
    };
  }

  // PR delivery path (supports both RSI worktree sandbox and standard repository branches).
  const preBundle = readRequirementBundle(base, id);
  const projectMeta = readProject(base);
  if (input.expectedRevision !== undefined && preBundle.state.revision !== input.expectedRevision) {
    throw new WorkbenchError(
      "revision_conflict",
      `需求 ${id} 已被更新（当前修订 ${preBundle.state.revision}，预期修订 ${input.expectedRevision}），请刷新后重试`,
      {
        requirementId: id,
        expectedRevision: input.expectedRevision,
        currentRevision: preBundle.state.revision,
      },
    );
  }
  if (preBundle.state.stage !== "done" || !preBundle.state.acceptance) {
    throw new WorkbenchError("invalid_transition", `仅已完成人工验收的需求才能提交 GitHub PR（当前：${preBundle.state.stage}）`);
  }

  const sandbox = getSandboxForRequirement(base, id);
  const codeRoot = sandbox ? sandbox.worktreePath : base;
  const tree = await inspectWorkingTreeForDelivery(codeRoot);
  if (!tree.isGitRepo) {
    throw new WorkbenchError("execution_failed", "当前目录不是 Git 仓库，无法推送分支或创建 PR");
  }

  const remoteProvider = await resolveProjectRemoteProvider(base, projectMeta, deps);
  let repo: string;
  let baseBranch: string;
  let giteeToken = "";
  let giteeEnterprise: string | null = null;

  if (remoteProvider === "gitee") {
    giteeToken = (deps?.giteeToken ?? deps?.giteeDeps?.token ?? process.env.GITEE_ACCESS_TOKEN ?? "").trim();
    const giteeEnv = await inspectGiteeEnvironment(base, projectMeta.gitee, giteeToken, deps?.giteeDeps);
    if (!giteeEnv.ready || !giteeEnv.repo) {
      throw new WorkbenchError(
        "execution_failed",
        giteeEnv.reason ?? "Gitee 环境未就绪，无法创建 PR",
        buildGiteeReasonMessageDetails(giteeEnv),
      );
    }
    repo = giteeEnv.repo;
    giteeEnterprise = giteeEnv.enterprise;
    baseBranch = validateGitBranchName(
      input.baseBranch?.trim() || projectMeta.gitee?.defaultBaseBranch || giteeEnv.defaultBaseBranch || "master",
    );
  } else {
    const ghEnv = await inspectGitHubEnvironment(base, projectMeta.github, deps);
    if (!ghEnv.ready || !ghEnv.repo) {
      throw new WorkbenchError(
        "execution_failed",
        ghEnv.reason ?? "GitHub CLI 环境未就绪，无法创建 PR",
        buildGitHubReasonMessageDetails(ghEnv),
      );
    }
    repo = ghEnv.repo;
    baseBranch = validateGitBranchName(
      input.baseBranch?.trim() || projectMeta.github?.defaultBaseBranch || ghEnv.defaultBaseBranch || "main",
    );
  }

  let targetBranch = sandbox ? sandbox.branch : (tree.branch ?? "");
  if (!sandbox && (!targetBranch || targetBranch === baseBranch || targetBranch === "master" || targetBranch === "HEAD")) {
    const requestedBranch = input.branchName?.trim() || `feat/${id.toLowerCase()}`;
    targetBranch = await createFeatureBranchAtHead(codeRoot, requestedBranch);
  }
  targetBranch = validateGitBranchName(targetBranch);

  const requestedFiles = Array.isArray(input.files) ? input.files.filter((f) => typeof f === "string" && f.trim().length > 0) : [];
  let committedFiles: string[];
  let commitHash: string;
  let shortHash: string;
  let effectiveCommitMessage: string;

  if (requestedFiles.length > 0) {
    const normalizedFiles = normalizeDeliveryFiles(requestedFiles);
    const commitMessage = typeof input.commitMessage === "string" ? input.commitMessage.trim() : "";
    if (!commitMessage || !isSafeText(commitMessage, 4000)) {
      throw new WorkbenchError("invalid_input", "请填写合法的 Git 提交说明");
    }
    const dirtySet = new Set(tree.files.map((f) => f.path));
    const missing = normalizedFiles.filter((f) => !dirtySet.has(f));
    if (missing.length > 0) {
      throw new WorkbenchError(
        "invalid_input",
        `以下文件当前没有未提交变更，无法纳入提交: ${missing.slice(0, 5).join(", ")}`,
      );
    }
    const committed = await commitFilesInGit(codeRoot, normalizedFiles, commitMessage);
    commitHash = committed.commitHash;
    shortHash = committed.shortHash;
    committedFiles = normalizedFiles;
    effectiveCommitMessage = commitMessage;
  } else {
    const aheadRef = sandbox?.baseHead || baseBranch;
    const aheadCount = await countCommitsBetween(codeRoot, aheadRef, "HEAD");
    if (aheadCount <= 0) {
      throw new WorkbenchError("invalid_input", "请至少选择 1 个要提交的文件，或确保分支已有未推送提交", {
        messageKey: "deliver.errNoFilesOrCommits",
      });
    }
    const headInfo = await getHeadCommitInfo(codeRoot);
    if (!headInfo) {
      throw new WorkbenchError("execution_failed", "无法读取分支最新提交信息", {
        messageKey: "deliver.errNoHeadInfo",
      });
    }
    commitHash = headInfo.commitHash;
    shortHash = headInfo.shortHash;
    committedFiles = await listCommittedFilesBetween(codeRoot, aheadRef, "HEAD");
    effectiveCommitMessage =
      (typeof input.commitMessage === "string" && input.commitMessage.trim()) ||
      headInfo.subject ||
      buildSuggestedCommitMessage(preBundle.state.id, preBundle.state.title);
  }

  await pushBranchToRemote(codeRoot, targetBranch, "origin");

  const firstLine = effectiveCommitMessage.split(/\r?\n/, 1)[0] ?? effectiveCommitMessage;
  const prTitle = (input.prTitle?.trim() || `${id}: ${preBundle.state.title}`).slice(0, 200);
  const currentSnap = await observeGitSnapshot(codeRoot);
  const detailForBody = toDetail(preBundle, currentSnap?.fingerprint ?? null);
  const prBody = input.prBody?.trim() || buildRequirementPrBody(detailForBody, note);

  const prResult =
    remoteProvider === "gitee"
      ? await createOrUpdateGiteePr(
          {
            repo,
            headBranch: targetBranch,
            baseBranch,
            title: prTitle,
            body: prBody,
            token: giteeToken,
          },
          deps?.giteeDeps,
        )
      : await createOrUpdateGitHubPr(
          {
            root: codeRoot,
            repo,
            headBranch: targetBranch,
            baseBranch,
            title: prTitle,
            body: prBody,
          },
          deps,
        );
  const { created: prCreated, ...prLink } = prResult;
  const platformLabel = remoteProvider === "gitee" ? "Gitee" : "GitHub";

  let recordedDelivery: DeliveryRecord | null = null;
  const bundle = await mutateRequirement(base, id, input.expectedRevision, (current, now) => {
    const { state } = current;
    const delivery: DeliveryRecord = {
      deliveredAt: now,
      commitHash,
      shortHash,
      commitMessage: effectiveCommitMessage,
      files: committedFiles,
      branch: targetBranch,
      prNumber: prLink.number,
      prUrl: prLink.url,
      ...(note ? { note } : {}),
    };
    recordedDelivery = delivery;

    const prevGithub: RequirementGitHubLink = state.github ?? { repo };
    const nextGithub: RequirementGitHubLink = {
      ...prevGithub,
      ...(remoteProvider ? { provider: remoteProvider } : {}),
      ...(giteeEnterprise && !prevGithub.enterprise ? { enterprise: giteeEnterprise } : {}),
      repo,
      pr: prLink,
    };

    let timeline = appendTimeline(
      state.timeline,
      makeEvent(
        now,
        "delivered",
        "human",
        `已提交并推送至 ${targetBranch}（${shortHash} · ${committedFiles.length} 个文件）：${firstLine.slice(0, 120)}`,
        note,
      ),
    );
    timeline = appendTimeline(
      timeline,
      makeEvent(
        now,
        "github_pr_created",
        "human",
        `${prCreated ? "已创建" : "已更新"} ${platformLabel} PR #${prLink.number} (${targetBranch} -> ${baseBranch})`,
        prLink.url,
      ),
    );

    return {
      state: {
        ...state,
        delivery,
        github: nextGithub,
        timeline,
      },
    };
  });

  let githubSyncWarning: string | undefined;
  let githubSyncWarningRef: StructuredMessageRef | undefined;
  const linkedIssue = bundle.state.github?.issue;
  if (
    remoteProvider !== "gitee" &&
    linkedIssue &&
    typeof linkedIssue.number === "number" &&
    projectMeta.github?.autoSyncIssue !== false
  ) {
    try {
      await commentOnGitHubIssue(
        {
          root: base,
          repo,
          issueNumber: linkedIssue.number,
          body: `已从需求 \`${id}\` 提交 Pull Request：${prLink.url}（分支 \`${targetBranch}\` → \`${baseBranch}\`，提交 \`${shortHash}\`）。`,
        },
        deps,
      );
    } catch (err) {
      githubSyncWarning = err instanceof Error ? err.message : String(err);
      githubSyncWarningRef = extractMessageRef(err) ?? undefined;
    }
  }

  const touchesWeb = committedFiles.some((f) => f.startsWith("src/web/"));
  const touchesBackend = committedFiles.some(
    (f) =>
      f.startsWith("src/server/") ||
      f.startsWith("src/hub/") ||
      f.startsWith("src/core/") ||
      f.startsWith("src/cli/") ||
      f.startsWith("src/mcp/"),
  );

  return {
    detail: toDetail(bundle, currentSnap?.fingerprint ?? null),
    delivery: recordedDelivery!,
    pr: prLink,
    ...(githubSyncWarning ? { githubSyncWarning } : {}),
    ...(githubSyncWarningRef ? { githubSyncWarningRef } : {}),
    touchesWeb,
    touchesBackend,
  };
}

export async function linkRequirementGitHubIssue(
  root: string,
  id: string,
  input: {
    provider?: GitRemoteProvider;
    repo: string;
    enterprise?: string | null;
    issue: RequirementGitHubIssueLink;
    summary?: string;
    currentCodeSnapshotHash?: string | null;
  },
): Promise<RequirementDetail> {
  const base = canonicalRoot(root);
  const provider = input.provider ?? "github";
  const enterprise = input.enterprise?.trim() ? validateGiteeEnterpriseSlug(input.enterprise) : undefined;
  const repo = input.repo.trim()
    ? provider === "gitee"
      ? validateGiteeRepoSlug(input.repo)
      : validateGitHubRepoSlug(input.repo)
    : "";
  if (!repo && !(provider === "gitee" && enterprise)) {
    throw new WorkbenchError("invalid_input", "请提供有效的仓库标识或企业空间标识");
  }
  const bundle = await mutateRequirement(base, id, undefined, (current, now) => {
    const { state } = current;
    const nextGithub: RequirementGitHubLink = {
      ...(state.github ?? { repo }),
      provider,
      repo,
      ...(enterprise ? { enterprise } : {}),
      issue: input.issue,
    };
    return {
      state: {
        ...state,
        github: nextGithub,
        timeline: appendTimeline(
          state.timeline,
          makeEvent(
            now,
            "github_issue_linked",
            "human",
            input.summary?.trim() ||
              (provider === "gitee"
                ? `已关联 Gitee 工作项 #${input.issue.number}`
                : `已关联 GitHub Issue #${input.issue.number}`),
            input.issue.url,
          ),
        ),
      },
    };
  });
  return toDetail(bundle, input.currentCodeSnapshotHash ?? null);
}

export async function recordRequirementGitHubSync(
  root: string,
  id: string,
  input: {
    issuePatch?: Partial<RequirementGitHubIssueLink>;
    prPatch?: RequirementGitHubPrLink;
    eventKind: "github_issue_synced" | "github_pr_synced";
    summary: string;
    detail?: string;
    currentCodeSnapshotHash?: string | null;
  },
): Promise<RequirementDetail> {
  const base = canonicalRoot(root);
  const bundle = await mutateRequirement(base, id, undefined, (current, now) => {
    const { state } = current;
    if (!state.github) {
      throw new WorkbenchError("not_found", `需求 ${id} 尚未绑定 GitHub 仓库或 Issue/PR`);
    }
    const nextIssue =
      input.issuePatch && state.github.issue
        ? { ...state.github.issue, ...input.issuePatch, lastSyncedAt: now }
        : state.github.issue;
    const nextPr = input.prPatch ? { ...input.prPatch, lastSyncedAt: now } : state.github.pr;
    return {
      state: {
        ...state,
        github: {
          ...state.github,
          ...(nextIssue !== undefined ? { issue: nextIssue } : {}),
          ...(nextPr !== undefined ? { pr: nextPr } : {}),
        },
        timeline: appendTimeline(state.timeline, makeEvent(now, input.eventKind, "system", input.summary, input.detail)),
      },
    };
  });
  return toDetail(bundle, input.currentCodeSnapshotHash ?? null);
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
        delivery: null,
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
    effectiveModel?: string;
    modelFallback?: boolean;
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
      ...(patch.effectiveModel ? { effectiveModel: patch.effectiveModel } : {}),
      ...(patch.modelFallback !== undefined ? { modelFallback: patch.modelFallback } : {}),
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
    findings?: ReviewFinding[];
    reviewedSpecHash: string;
    reviewedCodeSnapshotHash: string;
  },
): Promise<RequirementDetail> {
  if (!REVIEW_VERDICTS.includes(input.verdict)) {
    throw new WorkbenchError("invalid_input", `无效的审查结论: ${String(input.verdict)}`);
  }
  const cleanFindings =
    Array.isArray(input.findings) && input.findings.length > 0
      ? input.findings.slice(0, 50).map((f, idx) => ({
          id: typeof f.id === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(f.id) ? f.id : `F-${idx + 1}`,
          severity: f.severity === "high" || f.severity === "medium" || f.severity === "low" ? f.severity : "medium",
          title: sanitizeOutput(String(f.title ?? "").trim(), 380).text.trim() || `问题 ${idx + 1}`,
          ...(typeof f.detail === "string" && f.detail.trim()
            ? { detail: sanitizeOutput(f.detail.trim(), 1800).text.trim() }
            : {}),
          ...(Array.isArray(f.criterionIds) && f.criterionIds.length > 0
            ? {
                criterionIds: f.criterionIds
                  .filter((c): c is string => typeof c === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(c))
                  .slice(0, 16),
              }
            : {}),
          ...(Array.isArray(f.files) && f.files.length > 0
            ? {
                files: f.files
                  .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
                  .map((p) => sanitizeOutput(p.trim(), 480).text.trim())
                  .filter(Boolean)
                  .slice(0, 16),
              }
            : {}),
          ...(typeof f.suggestion === "string" && f.suggestion.trim()
            ? { suggestion: sanitizeOutput(f.suggestion.trim(), 1400).text.trim() }
            : {}),
        }))
      : undefined;
  const bundle = await mutateRequirement(root, id, undefined, (current, now) => {
    const { state } = current;
    const report: ReviewReport = {
      id: `REV-${now}-${randomUUID().slice(0, 6)}`,
      reviewerHarness: input.reviewerHarness.trim(),
      reviewerModel: input.reviewerModel.trim(),
      verdict: input.verdict,
      summary: input.summary.trim().slice(0, 1800) || "已完成独立代码审查",
      markdown: input.markdown.trim().slice(0, 60 * 1024) || input.summary.trim(),
      ...(cleanFindings && cleanFindings.length > 0 ? { findings: cleanFindings } : {}),
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

/** Updates requirement baseline HEAD/fingerprint after syncing an isolated sandbox branch to main. */
export async function syncRequirementBaseline(
  root: string,
  id: string,
  input: {
    baselineHead: string;
    baselineFingerprint: string;
    dirty: boolean;
    preserveStage?: boolean;
    summary?: string;
    currentCodeSnapshotHash?: string | null;
  },
): Promise<RequirementDetail> {
  const bundle = await mutateRequirement(root, id, undefined, (current, now) => {
    const { state } = current;
    if (state.stage === "done" || state.stage === "cancelled") {
      throw new WorkbenchError("invalid_transition", `终态需求（${state.stage}）不能刷新基线`);
    }
    const nextStage: Stage =
      !input.preserveStage && state.stage === "awaiting_acceptance" ? "implementing" : state.stage;
    return {
      state: {
        ...state,
        stage: nextStage,
        baseline: {
          head: input.baselineHead,
          fingerprint: input.baselineFingerprint,
          dirty: input.dirty,
          capturedAt: now,
        },
        timeline: appendTimeline(
          state.timeline,
          makeEvent(
            now,
            "tasks_updated",
            "system",
            input.summary ?? `已同步主干基线至 ${input.baselineHead.slice(0, 7)}（需在新基线上复跑验证）`,
          ),
        ),
      },
    };
  });
  return toDetail(bundle, input.currentCodeSnapshotHash ?? input.baselineFingerprint);
}
