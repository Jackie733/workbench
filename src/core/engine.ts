import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { extractMessageRef, WorkbenchError, type StructuredMessageRef } from "./errors.ts";
import { atomicWriteFile, atomicWriteJson, canonicalRoot, resolveSafePath, withProjectWriteLock } from "./fs.ts";
import {
  commitFilesInGit,
  computeSelectedFilesContentTreeFingerprint,
  countCommitsBetween,
  countWipCommitsBetween,
  createFeatureBranchAtHead,
  detectOmittedDiffContent,
  getGitRemoteUrl,
  getHeadCommitInfo,
  inspectRemoteBranchDivergence,
  inspectWorkingTreeForDelivery,
  listCommittedFilesBetween,
  observeGitChanges,
  observeGitSnapshot,
  pushBranchToRemote,
  squashBranchCommitsToSingleCommit,
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
import { withCodeRootLock } from "./code_lock.ts";
import { normalizeOutputLanguage } from "./language.ts";
import { getSandboxForRequirement, resolveCodeRoot } from "./sandbox.ts";
import {
  createRequirementFiles,
  isProjectInitialized,
  listAgentRuns,
  listRequirementIds,
  mutateRequirement,
  pruneProjectRunTraces,
  readAgentRun,
  readAgentRunContext,
  readAgentRunTrace,
  readDesignHistory,
  readProject,
  readRequirementBundle,
  readVerificationEvidence,
  initProject as storeInitProject,
  writeAgentRunContext,
  type RequirementBundle,
} from "./store.ts";
import {
  ACCEPTANCE_SNAPSHOT_SCHEMA_VERSION,
  MAX_ACCEPTANCE_DIFF_BYTES,
  MAX_AGENT_RUNS,
  MAX_DISCUSSIONS,
  MAX_HANDOFF_BYTES,
  MAX_SNAPSHOT_VERIFICATIONS,
  MAX_TIMELINE,
  REQUIREMENT_TIERS,
  REVIEW_VERDICTS,
  SCHEMA_VERSION,
  WORKBENCH_DIR,
  type AcceptanceSnapshot,
  type AcceptanceVerificationEvidence,
  type AdoptedDecision,
  type AgentRunRecord,
  type AttachmentMeta,
  type BaselineSnapshot,
  type Criterion,
  type CriterionInput,
  type DecisionItem,
  type DeliveryCandidateFile,
  type DeliveryPreview,
  type DeliveryRecord,
  type DesignReviewReport,
  type DiscussionEntry,
  type GitObservation,
  type GitRemoteProvider,
  type ManualCriterionCheck,
  type NeedsHumanState,
  type OutputLanguage,
  type PrivacyMode,
  type ProjectGiteeConfig,
  type ProjectGitHubConfig,
  type ProjectMetadata,
  type ProjectVerificationConfig,
  type ProjectWorktreeConfig,
  type RequirementDetail,
  type RequirementDiffView,
  type RequirementGitHubIssueLink,
  type RequirementGitHubLink,
  type RequirementGitHubPrLink,
  type RequirementKind,
  type RequirementState,
  type RequirementSummary,
  type RequirementTier,
  type ReviewDisposition,
  type ReviewFinding,
  type ReviewReport,
  type ReviewVerdict,
  type RoutingConfig,
  type RunBillingMode,
  type RunContextSnapshot,
  type RunCostSummary,
  type RunTokenUsage,
  type RunTraceEvent,
  type ScreenshotBatch,
  type ScreenshotCaptureResult,
  type Stage,
  type TimelineEvent,
  type TimelineEventKind,
  type Track,
  type VerificationRecord,
} from "./types.ts";
import {
  assertRequirementId,
  clipHeadTailUtf8,
  deriveTitleFromGoal,
  isSafeText,
  normalizeCriteria,
  normalizeDecisionItems,
  normalizeReason,
  normalizeTitle,
  sanitizeOutput,
  validateAgentRunRecord,
  validateGitBranchName,
  validateGiteeEnterpriseSlug,
  validateGiteeRepoSlug,
  validateGitHubRepoSlug,
  validateMarkdownContent,
  validateProjectMetadata,
  validateProjectRoutingConfig,
  validateScreenshotBatch,
  validateVerificationRecord,
} from "./validate.ts";
import {
  BASELINE_SCOPE_NOTE,
  WORKTREE_SCOPE_NOTE,
  canDirectApproveWithDecisions,
  computeDecisionsHash,
  computeDesignHash,
  computeSpecHash,
  detectTestTamperingSignals,
  evaluateApproval,
  evaluateRequirement,
  isManualCriterion,
} from "./validity.ts";

function makeEvent(
  at: number,
  kind: TimelineEventKind,
  actor: TimelineEvent["actor"],
  summary: string,
  detail?: string,
  runId?: string,
): TimelineEvent {
  return {
    id: randomUUID(),
    at,
    kind,
    actor,
    summary,
    ...(detail ? { detail } : {}),
    ...(runId ? { runId } : {}),
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
  gateOk: boolean,
): { text: string; key: string; params?: Record<string, string | number> } {
  switch (state.stage) {
    case "planning":
      if (state.designHash !== "" && !state.lastFeedback) {
        return {
          text: `方案 v${state.designVersion} 待批准`,
          key: "progress.awaitingApprovalDesign",
          params: { version: state.designVersion },
        };
      }
      return state.lastFeedback
        ? { text: "方案修订中", key: "progress.designing" }
        : { text: "规划中", key: "progress.draft" };
    case "coding": {
      if (gateOk) {
        return {
          text: `待验收 · 验证 ${requiredPassed}/${requiredTotal}`,
          key: "progress.awaitingAcceptance",
          params: { passed: requiredPassed, total: requiredTotal },
        };
      }
      const parts: string[] = ["编码中"];
      if (requiredTotal > 0) parts.push(`验证 ${requiredPassed}/${requiredTotal}`);
      return {
        text: parts.join(" · "),
        key: "progress.implementing",
        params: { passed: requiredPassed, required: requiredTotal },
      };
    }
    case "done":
      return { text: "已完成", key: "progress.done" };
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
  const progress = buildProgressText(
    state,
    validity.coverage.requiredTotal,
    validity.coverage.requiredPassed,
    validity.acceptanceGate.ok,
  );
  return {
    id: state.id,
    ...(state.parentId ? { parentId: state.parentId } : {}),
    title: state.title,
    stage: state.stage,
    track: state.track,
    kind: state.kind ?? "feature",
    tier: state.tier,
    revision: state.revision,
    designVersion: state.designVersion,
    criteriaCount: state.criteria.length,
    requiredTotal: validity.coverage.requiredTotal,
    requiredPassed: validity.coverage.requiredPassed,
    needsDecision: validity.needsDecision,
    decisionReason: validity.decisionReason,
    ...(validity.decisionReasonKey ? { decisionReasonKey: validity.decisionReasonKey } : {}),
    ...(validity.decisionReasonParams ? { decisionReasonParams: validity.decisionReasonParams } : {}),
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
  options: { name?: string; privacyMode?: PrivacyMode; outputLanguage?: OutputLanguage; routing?: RoutingConfig } = {},
): Promise<ProjectMetadata> {
  return storeInitProject(root, options);
}

export async function updateProjectConfig(
  root: string,
  patch: {
    name?: string;
    outputLanguage?: OutputLanguage | null;
    routing?: RoutingConfig | null;
    github?: ProjectGitHubConfig | null;
    gitee?: ProjectGiteeConfig | null;
    verification?: ProjectVerificationConfig | null;
    worktree?: ProjectWorktreeConfig | null;
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

    if (patch.routing === null) {
      delete next.routing;
    } else if (patch.routing !== undefined) {
      next.routing = validateProjectRoutingConfig(patch.routing);
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

    if (patch.verification === null) {
      delete next.verification;
    } else if (patch.verification !== undefined) {
      const mergedVer: ProjectVerificationConfig = { ...(current.verification ?? {}) };
      if (patch.verification.fastCommand !== undefined) {
        const cleanFast = patch.verification.fastCommand.trim();
        if (cleanFast) mergedVer.fastCommand = cleanFast;
        else delete mergedVer.fastCommand;
      }
      if (patch.verification.fullCommand !== undefined) {
        const cleanFull = patch.verification.fullCommand.trim();
        if (cleanFull) mergedVer.fullCommand = cleanFull;
        else delete mergedVer.fullCommand;
      }
      if (patch.verification.autoScreenshots !== undefined) {
        mergedVer.autoScreenshots = Boolean(patch.verification.autoScreenshots);
      }
      if (Object.keys(mergedVer).length > 0) {
        next.verification = mergedVer;
      } else {
        delete next.verification;
      }
    }

    if (patch.worktree === null) {
      delete next.worktree;
    } else if (patch.worktree !== undefined) {
      const mergedWt: ProjectWorktreeConfig = { ...(current.worktree ?? {}) };
      if (patch.worktree.enabled !== undefined) {
        mergedWt.enabled = Boolean(patch.worktree.enabled);
      }
      if (patch.worktree.copyFiles !== undefined) {
        const cleaned = patch.worktree.copyFiles
          .map((f) => f.trim())
          .filter(Boolean)
          .slice(0, 64);
        if (cleaned.length > 0) mergedWt.copyFiles = Array.from(new Set(cleaned));
        else delete mergedWt.copyFiles;
      }
      if (patch.worktree.setupScript !== undefined) {
        const cleanScript = patch.worktree.setupScript.trim();
        if (cleanScript) mergedWt.setupScript = cleanScript;
        else delete mergedWt.setupScript;
      }
      if (Object.keys(mergedWt).length > 0) {
        next.worktree = mergedWt;
      } else {
        delete next.worktree;
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
  const detail = toDetail(bundle, options.currentCodeSnapshotHash ?? null);
  const subRequirements = listRequirements(root, {
    scope: "all",
    currentCodeSnapshotHash: options.currentCodeSnapshotHash ?? null,
    onCorrupt: () => {},
  }).filter((item) => item.parentId === id);
  return subRequirements.length > 0 ? { ...detail, subRequirements } : detail;
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

export function listRequirementAgentRuns(root: string, id: string): AgentRunRecord[] {
  return listAgentRuns(root, id);
}

export function getAgentRunTrace(
  root: string,
  id: string,
  runId: string,
  opts?: { afterSeq?: number; limit?: number },
): {
  record: AgentRunRecord;
  events: RunTraceEvent[];
  nextSeq: number;
  totalEvents: number;
  hasMore: boolean;
  traceAvailable: boolean;
} {
  return readAgentRunTrace(root, id, runId, opts);
}

export function getAgentRunContext(root: string, id: string, runId: string): RunContextSnapshot | null {
  return readAgentRunContext(root, id, runId);
}

export function saveAgentRunContext(
  root: string,
  id: string,
  runId: string,
  snapshot: RunContextSnapshot,
): string {
  return writeAgentRunContext(root, id, runId, snapshot);
}

export function pruneProjectTraces(
  root: string,
  olderThanDays: number,
  activeRunIds?: Set<string>,
): { deletedFiles: number; freedBytes: number; scannedRuns: number } {
  return pruneProjectRunTraces(root, olderThanDays, activeRunIds);
}

/**
 * Extracts structured acceptance criteria from an inline ```workbench-criteria JSON block inside design.md.
 * Returns null if no valid block is present.
 */
export function extractInlineCriteriaFromDesign(designMarkdown: string): CriterionInput[] | null {
  const match = /```workbench-criteria\s*\r?\n([\s\S]*?)```/m.exec(designMarkdown);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]!.trim()) as unknown;
    const rawList = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { criteria?: unknown }).criteria)
        ? (parsed as { criteria: unknown[] }).criteria
        : null;
    if (!rawList || rawList.length === 0) return null;
    const out: CriterionInput[] = [];
    for (const item of rawList) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const description = typeof obj.description === "string" ? obj.description.trim() : "";
      if (!description) continue;
      const kind =
        obj.kind === "manual" || obj.type === "manual" || obj.manual === true
          ? ("manual" as const)
          : obj.kind === "command" || obj.type === "command"
            ? ("command" as const)
            : undefined;
      out.push({
        ...(typeof obj.id === "string" && obj.id.trim() ? { id: obj.id.trim() } : {}),
        description,
        required: obj.required === undefined ? true : Boolean(obj.required),
        ...(kind ? { kind } : {}),
        ...(kind !== "manual" && typeof obj.command === "string" && obj.command.trim() ? { command: obj.command.trim() } : {}),
        ...(typeof obj.steps === "string" && obj.steps.trim() ? { steps: obj.steps.trim() } : {}),
      });
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Extracts optional structured pending decisions from an inline ```workbench-decisions JSON block inside design.md (WB-18).
 * Returns null if no valid block is present.
 */
export function extractInlineDecisionsFromDesign(designMarkdown: string): DecisionItem[] | null {
  const match = /```workbench-decisions\s*\r?\n([\s\S]*?)```/m.exec(designMarkdown);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]!.trim()) as unknown;
    const rawList = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { decisions?: unknown }).decisions)
        ? (parsed as { decisions: unknown[] }).decisions
        : null;
    if (!rawList || rawList.length === 0) return null;
    const normalized = normalizeDecisionItems(rawList).map(({ selectedOptionId: _s, customAnswer: _c, decidedAt: _d, ...rest }) => rest);
    return normalized.length > 0 ? normalized : null;
  } catch {
    return null;
  }
}

export async function setRequirementTier(
  root: string,
  id: string,
  tier: RequirementTier,
  options: { expectedRevision?: number; reason?: string; currentCodeSnapshotHash?: string | null } = {},
): Promise<RequirementDetail> {
  if (!REQUIREMENT_TIERS.includes(tier)) {
    throw new WorkbenchError("invalid_input", `无效的执行档位: ${String(tier)}`);
  }
  const bundle = await mutateRequirement(root, id, options.expectedRevision, (current, now) => {
    const { state } = current;
    if (state.stage === "done" || state.stage === "cancelled") {
      throw new WorkbenchError("invalid_transition", `终态需求（${state.stage}）不能切换执行档位`);
    }
    if (state.tier === tier && !state.needsHuman) {
      return { state };
    }
    const label = tier === "sota" ? "SOTA 主程" : "标准主程";
    return {
      state: {
        ...state,
        tier,
        ...(tier === "sota" ? { needsHuman: null } : {}),
        timeline: appendTimeline(
          state.timeline,
          makeEvent(now, "tier_changed", "human", `切换执行档位为：${label}`, options.reason),
        ),
      },
    };
  });
  return toDetail(bundle, options.currentCodeSnapshotHash ?? null);
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
    if (state.stage === "done" || state.stage === "cancelled") {
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
      nextStage = "planning";
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
        ...(designChanged && nextDesignHash !== "" ? { lastFeedback: null } : {}),
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
    parentId?: string;
    criteria?: CriterionInput[];
    track?: Track;
    kind?: RequirementKind;
    tier?: RequirementTier;
    uiRelated?: boolean;
    currentCodeSnapshotHash?: string | null;
    /** 暂存区附件 ID，创建时认领到 .workbench/items/<REQ>/attachments/ */
    attachmentIds?: string[];
    /** 已落盘附件来源，创建时复制到新需求目录 */
    attachmentSource?: { dir: string; metas: AttachmentMeta[] };
  },
): Promise<RequirementDetail> {
  const specMarkdown = validateMarkdownContent(input.goal, "spec", false);
  const title = input.title?.trim() ? normalizeTitle(input.title) : deriveTitleFromGoal(specMarkdown);
  const criteria = input.criteria ? normalizeCriteria(input.criteria) : [];
  const track: Track = input.track === "fast_track" ? "fast_track" : "plan_first";
  const kind: RequirementKind = input.kind === "bug" ? "bug" : "feature";
  const tier: RequirementTier = input.tier === "sota" ? "sota" : "standard";
  const specHash = computeSpecHash(specMarkdown, criteria);
  const parentId = input.parentId?.trim() ? assertRequirementId(input.parentId.trim()) : undefined;
  if (parentId) {
    readRequirementBundle(root, parentId);
  }

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
      ...(parentId ? { parentId } : {}),
      title,
      originalGoal: specMarkdown,
      stage: "planning",
      track,
      ...(kind === "bug" ? { kind: "bug" as const } : {}),
      tier,
      revision: 1,
      specHash,
      designVersion: 0,
      designHash: "",
      criteria,
      approval: null,
      acceptance: null,
      baseline: null,
      verifications: [],
      lastFeedback: null,
      ...(input.uiRelated === true ? { uiRelated: true } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      timeline: [
        makeEvent(now, "created", "human", `${kind === "bug" ? "登记 Bug" : "创建需求"} ${id}：${title}`),
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

function isHumanCriteriaAdjustmentPreservingApproval(prev: Criterion[], next: Criterion[]): boolean {
  if (prev.length === 0 || !next.some((c) => c.required)) return false;
  const prevIds = new Set(prev.map((c) => c.id));
  // Allow relaxing/adjusting existing criteria without resetting approved design; brand-new required criteria still require re-approval.
  return next.every((c) => !c.required || prevIds.has(c.id));
}

/**
 * WB-21 / FLOW §1B: strict append-only check for Bug regression criteria during `coding`.
 * Every prior criterion MUST remain intact (no deletions, no weakening required->optional, no altering commands/steps).
 */
export function isStrictAppendOnlyCriteriaUpdate(prev: Criterion[], next: Criterion[]): boolean {
  const nextById = new Map(next.map((c) => [c.id, c]));
  for (const c of prev) {
    const matched = nextById.get(c.id);
    if (!matched) return false;
    if (matched.required !== c.required) return false;
    if (matched.description !== c.description) return false;
    if ((matched.kind ?? undefined) !== (c.kind ?? undefined)) return false;
    if ((matched.command ?? undefined) !== (c.command ?? undefined)) return false;
    if ((matched.steps ?? undefined) !== (c.steps ?? undefined)) return false;
  }
  return true;
}

/**
 * WB-21 / FLOW §1B: allows `kind: "bug"` in `coding` stage to append regression test criteria
 * without invalidating launch approval; strictly forbids deleting or weakening existing criteria.
 */
export async function appendBugRegressionCriteria(
  root: string,
  id: string,
  input: {
    criteria: CriterionInput[];
    actor?: "agent" | "human";
    expectedRevision?: number;
    currentCodeSnapshotHash?: string | null;
  },
): Promise<RequirementDetail> {
  if (!Array.isArray(input.criteria) || input.criteria.length === 0) {
    throw new WorkbenchError("invalid_input", "请提供至少 1 条要追加的回归测试验收条件");
  }
  const actor = input.actor ?? "agent";
  const bundle = await mutateRequirement(root, id, input.expectedRevision, (current, now) => {
    const { state } = current;
    if (state.kind !== "bug") {
      throw new WorkbenchError("invalid_transition", `仅 Bug 类型需求支持编码期只增不删追加回归验收条件`);
    }
    if (state.stage !== "coding") {
      throw new WorkbenchError("invalid_transition", `仅编码阶段允许追加 Bug 回归验收条件（当前：${state.stage}）`);
    }
    const existingIds = new Set(state.criteria.map((c) => c.id));
    let seq = state.criteria.length;
    const incomingWithIds: CriterionInput[] = input.criteria.map((item) => {
      const explicitId = typeof item.id === "string" && item.id.trim() ? item.id.trim() : "";
      if (explicitId && existingIds.has(explicitId)) {
        throw new WorkbenchError(
          "invalid_input",
          `Bug 编码期仅允许只增不删追加新条件，禁止覆盖已有验收条件 ${explicitId}`,
        );
      }
      if (explicitId) {
        existingIds.add(explicitId);
        return { ...item, id: explicitId, systemInjected: false };
      }
      do {
        seq += 1;
      } while (existingIds.has(`AC-${seq}`));
      const autoId = `AC-${seq}`;
      existingIds.add(autoId);
      return { ...item, id: autoId, systemInjected: false };
    });
    const merged = normalizeCriteria([...state.criteria, ...incomingWithIds]);
    if (!isStrictAppendOnlyCriteriaUpdate(state.criteria, merged)) {
      throw new WorkbenchError("invalid_input", "Bug 编码期验收条件仅允许只增不删，禁止删除或削弱已有条件");
    }
    const nextSpecHash = computeSpecHash(current.specMarkdown, merged);
    const nextApproval = state.approval ? { ...state.approval, specHash: nextSpecHash } : null;
    const addedIds = merged.slice(state.criteria.length).map((c) => c.id);
    return {
      state: {
        ...state,
        criteria: merged,
        specHash: nextSpecHash,
        approval: nextApproval,
        timeline: appendTimeline(
          state.timeline,
          makeEvent(now, "spec_updated", actor, `Bug 编码期追加回归测试验收条件：${addedIds.join("、")}`),
        ),
      },
    };
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
    if (state.stage === "done" || state.stage === "cancelled") {
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
        if (
          state.stage === "coding" &&
          nextSpec === current.specMarkdown &&
          (isHumanCriteriaAdjustmentPreservingApproval(state.criteria, nextCriteria) ||
            (state.kind === "bug" && isStrictAppendOnlyCriteriaUpdate(state.criteria, nextCriteria)))
        ) {
          nextStage = state.stage;
          nextApproval = { ...nextApproval, specHash: nextSpecHash };
        } else {
          nextApproval = null;
          if (nextStage === "coding") {
            nextStage = "planning";
          }
        }
      }
    }

    const nextManualChecks = pruneManualChecksForCriteria(state.manualChecks, nextCriteria);
    return {
      specMarkdown: input.specMarkdown !== undefined ? nextSpec : undefined,
      state: {
        ...state,
        title: nextTitle,
        criteria: nextCriteria,
        ...(nextManualChecks !== undefined ? { manualChecks: nextManualChecks } : {}),
        specHash: nextSpecHash,
        approval: nextApproval,
        stage: nextStage,
        timeline: appendTimeline(state.timeline, makeEvent(now, "spec_updated", "human", summary)),
      },
    };
  });

  return toDetail(bundle, input.currentCodeSnapshotHash ?? null);
}

function pruneManualChecksForCriteria(
  manualChecks: ManualCriterionCheck[] | undefined,
  criteria: Criterion[],
): ManualCriterionCheck[] | undefined {
  if (!manualChecks || manualChecks.length === 0) return manualChecks;
  const manualIds = new Set(criteria.filter((c) => isManualCriterion(c)).map((c) => c.id));
  return manualChecks.filter((mc) => manualIds.has(mc.criterionId));
}

function isNonBreakingCriteriaUpdate(prev: Criterion[], next: Criterion[]): boolean {
  const nextById = new Map(next.map((c) => [c.id, c]));
  for (const c of prev) {
    if (!c.required) continue;
    const matched = nextById.get(c.id);
    if (!matched || !matched.required) return false;
    if (matched.description !== c.description) return false;
    const wasManual = isManualCriterion(c);
    const isNowManual = isManualCriterion(matched);
    if (wasManual !== isNowManual) return false;
    if (wasManual && (matched.steps ?? "") !== (c.steps ?? "")) return false;
    if (c.command && matched.command !== c.command) return false;
  }
  return true;
}

export interface DecisionSelectionInput {
  id: string;
  selectedOptionId?: string | null;
  customAnswer?: string | null;
}

export function applyDecisionSelectionsToItems(
  items: DecisionItem[],
  selections: DecisionSelectionInput[],
  now: number,
): DecisionItem[] {
  const byId = new Map(selections.map((s) => [s.id.trim(), s]));
  return items.map((item) => {
    const sel = byId.get(item.id);
    if (!sel) return item;
    const rawCustom = typeof sel.customAnswer === "string" ? sel.customAnswer.trim() : "";
    const customAnswer = rawCustom ? sanitizeOutput(rawCustom, 1000).text.trim() : null;
    const rawOptId = typeof sel.selectedOptionId === "string" ? sel.selectedOptionId.trim() : "";
    const validOptId =
      !customAnswer && rawOptId && item.options.some((opt) => opt.id === rawOptId)
        ? rawOptId
        : null;
    const next: DecisionItem = {
      id: item.id,
      question: item.question,
      ...(item.context ? { context: item.context } : {}),
      options: item.options,
      ...(validOptId ? { selectedOptionId: validOptId } : {}),
      ...(customAnswer ? { customAnswer } : {}),
      ...(validOptId || customAnswer ? { decidedAt: now } : {}),
    };
    return next;
  });
}

function mergePendingDecisionsWithPrior(
  incoming: DecisionItem[],
  prior: DecisionItem[] | undefined,
): DecisionItem[] {
  if (!prior || prior.length === 0) return incoming;
  const priorById = new Map(prior.map((p) => [p.id, p]));
  return incoming.map((item) => {
    const prev = priorById.get(item.id);
    if (!prev || prev.question !== item.question) return item;
    const preservedCustom = !item.customAnswer && !item.selectedOptionId && prev.customAnswer ? prev.customAnswer : item.customAnswer;
    const preservedOpt =
      !preservedCustom &&
      !item.selectedOptionId &&
      prev.selectedOptionId &&
      item.options.some((opt) => opt.id === prev.selectedOptionId)
        ? prev.selectedOptionId
        : !preservedCustom
          ? item.selectedOptionId
          : undefined;
    return {
      ...item,
      ...(preservedOpt ? { selectedOptionId: preservedOpt } : {}),
      ...(preservedCustom ? { customAnswer: preservedCustom } : {}),
      ...(preservedOpt || preservedCustom ? { decidedAt: item.decidedAt ?? prev.decidedAt ?? null } : {}),
    };
  });
}

function mergeAdoptedDecisions(
  existing: AdoptedDecision[] | undefined,
  incoming: AdoptedDecision[],
): AdoptedDecision[] {
  const result = [...(existing ?? [])];
  const byId = new Map<string, number>();
  result.forEach((d, idx) => byId.set(d.id, idx));
  const usedIds = new Set(result.map((d) => d.id));
  for (const ad of incoming) {
    const existingIdx = byId.get(ad.id);
    if (existingIdx !== undefined) {
      if (result[existingIdx]!.question === ad.question) {
        result[existingIdx] = ad;
        continue;
      }
      let suffix = 2;
      let nextId = `${ad.id}-${suffix}`;
      while (usedIds.has(nextId)) {
        suffix += 1;
        nextId = `${ad.id}-${suffix}`;
      }
      usedIds.add(nextId);
      const renamed: AdoptedDecision = { ...ad, id: nextId };
      byId.set(nextId, result.length);
      result.push(renamed);
    } else {
      usedIds.add(ad.id);
      byId.set(ad.id, result.length);
      result.push(ad);
    }
  }
  return result;
}

export async function propose(
  root: string,
  id: string,
  input: {
    title?: string;
    specMarkdown?: string;
    criteria?: CriterionInput[];
    designMarkdown?: string;
    decisions?: DecisionItem[] | null;
    summary?: string;
    expectedRevision?: number;
    actor?: "agent" | "human";
    currentCodeSnapshotHash?: string | null;
  },
): Promise<RequirementDetail> {
  const bundle = await mutateRequirement(root, id, input.expectedRevision, (current, now) => {
    const { state } = current;
    if (state.stage === "done" || state.stage === "cancelled") {
      throw new WorkbenchError("invalid_transition", `当前阶段（${state.stage}）不能提交方案或规范提案`);
    }
    if (
      input.title === undefined &&
      input.specMarkdown === undefined &&
      input.criteria === undefined &&
      input.designMarkdown === undefined &&
      input.decisions === undefined
    ) {
      throw new WorkbenchError("invalid_input", "propose 至少需要更新 title、spec、criteria、design 或 decisions 中的一项");
    }

    const nextTitle = input.title !== undefined ? normalizeTitle(input.title) : state.title;
    const nextSpec =
      input.specMarkdown !== undefined
        ? validateMarkdownContent(input.specMarkdown, "spec", false)
        : current.specMarkdown;
    const nextDesign =
      input.designMarkdown !== undefined
        ? validateMarkdownContent(input.designMarkdown, "design", true)
        : current.designMarkdown;
    const inlineCriteria =
      input.criteria === undefined && input.designMarkdown !== undefined
        ? extractInlineCriteriaFromDesign(nextDesign)
        : null;
    const nextCriteria =
      input.criteria !== undefined
        ? normalizeCriteria(input.criteria)
        : inlineCriteria
          ? normalizeCriteria(inlineCriteria)
          : state.criteria;

    let nextPendingDecisions = state.pendingDecisions;
    if (input.decisions === null) {
      nextPendingDecisions = undefined;
    } else if (input.decisions !== undefined) {
      const normalized = normalizeDecisionItems(input.decisions);
      nextPendingDecisions =
        normalized.length > 0 ? mergePendingDecisionsWithPrior(normalized, state.pendingDecisions) : undefined;
    } else if (input.designMarkdown !== undefined) {
      const inlineDecisions = extractInlineDecisionsFromDesign(nextDesign);
      if (inlineDecisions && inlineDecisions.length > 0) {
        nextPendingDecisions = mergePendingDecisionsWithPrior(inlineDecisions, state.pendingDecisions);
      } else if (computeDesignHash(nextDesign) !== state.designHash) {
        // Revised design resolved all open forks when no workbench-decisions block remains.
        nextPendingDecisions = undefined;
      }
    }

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

    if (
      state.stage === "coding" &&
      state.kind === "bug" &&
      actor === "agent" &&
      (input.criteria !== undefined || inlineCriteria !== null) &&
      !isStrictAppendOnlyCriteriaUpdate(state.criteria, nextCriteria)
    ) {
      throw new WorkbenchError("invalid_input", "Bug 编码期验收条件仅允许「只增不删」追加回归测试，禁止删除或削弱已有条件");
    }

    if (nextApproval !== null && (specChanged || designChanged)) {
      if (
        state.stage === "coding" &&
        state.kind === "bug" &&
        !designChanged &&
        nextSpec === current.specMarkdown &&
        nextTitle === state.title &&
        isStrictAppendOnlyCriteriaUpdate(state.criteria, nextCriteria)
      ) {
        nextStage = "coding";
        nextApproval = {
          ...nextApproval,
          specHash: nextSpecHash,
        };
      } else if (
        state.track === "fast_track" &&
        state.approval?.track === "fast_track" &&
        actor === "agent" &&
        state.criteria.length === 0 &&
        !designChanged &&
        nextSpec === current.specMarkdown &&
        nextTitle === state.title
      ) {
        nextStage = "coding";
        nextApproval = {
          ...state.approval,
          specHash: nextSpecHash,
        };
      } else if (
        state.stage === "coding" &&
        actor === "agent" &&
        !designChanged &&
        nextSpec === current.specMarkdown &&
        nextTitle === state.title &&
        !(state.track === "plan_first" && nextDesignHash === "") &&
        isNonBreakingCriteriaUpdate(state.criteria, nextCriteria)
      ) {
        nextStage = "coding";
        nextApproval = {
          ...nextApproval,
          specHash: nextSpecHash,
          designVersion: nextDesignVersion,
          designHash: nextDesignHash,
        };
      } else if (state.stage === "coding" && actor === "agent") {
        throw new WorkbenchError(
          "invalid_transition",
          "编码阶段 Agent 无权擅自修改已批准的规范/方案、削弱验收条件或回退至 planning 阶段；请暂停上报并由人类发起 revisePlan",
        );
      } else {
        nextApproval = null;
        nextStage = "planning";
      }
    }

    const kind: TimelineEventKind = designChanged ? "design_proposed" : "spec_updated";
    const eventSummary =
      input.summary?.trim() ||
      (designChanged && nextDesignHash !== ""
        ? `提交技术方案 v${nextDesignVersion}${nextPendingDecisions?.length ? `（含 ${nextPendingDecisions.length} 项待拍板决策）` : ""}`
        : "更新需求规范与验收条件");

    const nextManualChecks = pruneManualChecksForCriteria(state.manualChecks, nextCriteria);
    const nextState: RequirementState = {
      ...state,
      title: nextTitle,
      criteria: nextCriteria,
      ...(nextManualChecks !== undefined ? { manualChecks: nextManualChecks } : {}),
      specHash: nextSpecHash,
      designVersion: nextDesignVersion,
      designHash: nextDesignHash,
      approval: nextApproval,
      stage: nextStage,
      lastFeedback: null,
      timeline: appendTimeline(state.timeline, makeEvent(now, kind, actor, eventSummary)),
    };
    if (nextPendingDecisions && nextPendingDecisions.length > 0) {
      nextState.pendingDecisions = nextPendingDecisions;
    } else {
      delete nextState.pendingDecisions;
    }

    return {
      specMarkdown: input.specMarkdown !== undefined ? nextSpec : undefined,
      designMarkdown: input.designMarkdown !== undefined ? nextDesign : undefined,
      snapshotDesignVersion,
      state: nextState,
    };
  });

  return toDetail(bundle, input.currentCodeSnapshotHash ?? null);
}

/** Persists asynchronous human selections on inline planning decision cards without leaving `planning` (WB-18). */
export async function saveDecisionSelections(
  root: string,
  id: string,
  input: {
    selections: DecisionSelectionInput[];
    expectedRevision?: number;
    currentCodeSnapshotHash?: string | null;
  },
): Promise<RequirementDetail> {
  const bundle = await mutateRequirement(root, id, input.expectedRevision, (current, now) => {
    const { state } = current;
    if (state.stage !== "planning") {
      throw new WorkbenchError("invalid_transition", `当前阶段（${state.stage}）无法更新方案待拍板决策`);
    }
    const pending = state.pendingDecisions ?? [];
    if (pending.length === 0) {
      throw new WorkbenchError("invalid_input", "当前方案没有待拍板决策项");
    }
    const updated = applyDecisionSelectionsToItems(pending, input.selections ?? [], now);
    return {
      state: {
        ...state,
        pendingDecisions: updated,
      },
    };
  });
  return toDetail(bundle, input.currentCodeSnapshotHash ?? null);
}

/**
 * Exit 2 of the WB-18 inline decision card ("提交决策并修订方案"):
 * persists human selections + bundles ALL card answers and ALL unresolved `refine` annotations
 * into a single consolidated feedback packet for one `design` revision run.
 */
export async function submitDecisionsAndRevise(
  root: string,
  id: string,
  input: {
    selections?: DecisionSelectionInput[];
    note?: string;
    expectedRevision?: number;
    currentCodeSnapshotHash?: string | null;
  } = {},
): Promise<{ detail: RequirementDetail; feedback: string; unresolvedAnnotationIds: string[] }> {
  let consolidatedFeedback = "";
  let unresolvedIds: string[] = [];

  const bundle = await mutateRequirement(root, id, input.expectedRevision, (current, now) => {
    const { state } = current;
    if (state.stage !== "planning") {
      throw new WorkbenchError("invalid_transition", `当前阶段（${state.stage}）无法提交决策并修订方案`);
    }
    const updatedPending =
      state.pendingDecisions && state.pendingDecisions.length > 0 && input.selections
        ? applyDecisionSelectionsToItems(state.pendingDecisions, input.selections, now)
        : (state.pendingDecisions ?? []);

    const decisionLines: string[] = [];
    const adoptedFromCard: AdoptedDecision[] = [];
    for (const item of updatedPending) {
      const custom = item.customAnswer?.trim() || "";
      const presetOpt = item.selectedOptionId
        ? item.options.find((opt) => opt.id === item.selectedOptionId)
        : undefined;
      if (custom) {
        decisionLines.push(`- [${item.id}] ${item.question} → 自定义结论：${custom}`);
        adoptedFromCard.push({
          id: item.id,
          question: item.question,
          answer: custom,
          adoptedAt: now,
        });
      } else if (presetOpt) {
        decisionLines.push(`- [${item.id}] ${item.question} → 选用「${presetOpt.label}」(${presetOpt.id})`);
        adoptedFromCard.push({
          id: item.id,
          question: item.question,
          answer: presetOpt.label,
          optionId: presetOpt.id,
          optionLabel: presetOpt.label,
          adoptedAt: now,
        });
      }
    }

    const unresolvedNotes = (state.discussions ?? []).filter(
      (d) => d.actor === "human" && d.mode === "refine" && (!d.kind || d.kind === "annotation") && !d.resolved,
    );
    unresolvedIds = unresolvedNotes.map((d) => d.id);
    const noteText = input.note?.trim() ? normalizeReason(input.note, "补充意见") : "";

    if (decisionLines.length === 0 && unresolvedNotes.length === 0 && !noteText) {
      throw new WorkbenchError("invalid_input", "请至少作答 1 项决策、添加批注或填写修订意见");
    }

    const parts: string[] = ["请结合以下人类决策与批注一次性修订方案并补齐验收条件："];
    if (decisionLines.length > 0) {
      parts.push("", "【已拍板决策】", ...decisionLines);
    }
    if (unresolvedNotes.length > 0) {
      parts.push(
        "",
        `【未解决行内批注（共 ${unresolvedNotes.length} 条）】`,
        ...unresolvedNotes.map((d) => `- ${d.anchor ? `[${d.anchor}] ` : ""}${d.message}`),
      );
    }
    if (noteText) {
      parts.push("", `【补充说明】${noteText}`);
    }
    consolidatedFeedback = sanitizeOutput(parts.join("\n"), 7500).text;

    const nextHumanDecisions = mergeAdoptedDecisions(state.humanDecisions, adoptedFromCard);

    const nextState: RequirementState = {
      ...state,
      stage: "planning",
      approval: null,
      lastFeedback: consolidatedFeedback,
      ...(updatedPending.length > 0 ? { pendingDecisions: updatedPending } : {}),
      ...(nextHumanDecisions.length > 0 ? { humanDecisions: nextHumanDecisions } : {}),
      timeline: appendTimeline(
        state.timeline,
        makeEvent(
          now,
          "decisions_updated",
          "human",
          `提交 ${adoptedFromCard.length} 项决策与 ${unresolvedNotes.length} 条批注，触发方案修订`,
          consolidatedFeedback.slice(0, 500),
        ),
      ),
    };
    return { state: nextState };
  });

  return {
    detail: toDetail(bundle, input.currentCodeSnapshotHash ?? null),
    feedback: consolidatedFeedback,
    unresolvedAnnotationIds: unresolvedIds,
  };
}

export async function approveDesign(
  root: string,
  id: string,
  input: {
    expectedRevision?: number;
    baseline?: BaselineSnapshot | null;
    note?: string;
    decisionSelections?: DecisionSelectionInput[];
    resetSandbox?: boolean;
    currentCodeSnapshotHash?: string | null;
  } = {},
): Promise<RequirementDetail> {
  const bundle = await mutateRequirement(root, id, input.expectedRevision, (current, now) => {
    const { state } = current;
    if (state.stage !== "planning") {
      throw new WorkbenchError("invalid_transition", `当前阶段（${state.stage}）无法执行方案批准`);
    }
    if (!current.designMarkdown.trim() || state.designHash === "" || state.designVersion < 1) {
      throw new WorkbenchError("approval_required", "尚未提交可批准的技术方案正文（design.md）");
    }

    const updatedPending =
      state.pendingDecisions && state.pendingDecisions.length > 0 && input.decisionSelections
        ? applyDecisionSelectionsToItems(state.pendingDecisions, input.decisionSelections, now)
        : (state.pendingDecisions ?? []);

    const candidateState: RequirementState = {
      ...state,
      ...(updatedPending.length > 0 ? { pendingDecisions: updatedPending } : {}),
    };
    const directCheck = canDirectApproveWithDecisions(candidateState);
    if (!directCheck.allowed) {
      const code = state.criteria.some((c) => c.required) ? "invalid_input" : "approval_required";
      throw new WorkbenchError(code, directCheck.reason ?? "当前不满足直接批准条件，请先修订方案", {
        ...(directCheck.reasonKey ? { messageKey: directCheck.reasonKey } : {}),
      });
    }

    const adoptedNow: AdoptedDecision[] = updatedPending.map((item) => {
      const opt = item.options.find((o) => o.id === item.selectedOptionId)!;
      return {
        id: item.id,
        question: item.question,
        answer: opt.label,
        optionId: opt.id,
        optionLabel: opt.label,
        adoptedAt: now,
      };
    });
    const nextHumanDecisions = mergeAdoptedDecisions(state.humanDecisions, adoptedNow);
    const decisionsHash = computeDecisionsHash(nextHumanDecisions);

    const note = input.note?.trim() ? normalizeReason(input.note, "批准备注") : undefined;
    const baseline =
      state.revisedFromCoding && input.resetSandbox !== true && state.baseline
        ? state.baseline
        : (input.baseline ?? state.baseline);
    const nextState: RequirementState = {
      ...state,
      track: "plan_first",
      stage: "coding",
      baseline,
      lastFeedback: null,
      needsHuman: null,
      revisedFromCoding: false,
      ...(nextHumanDecisions.length > 0 ? { humanDecisions: nextHumanDecisions } : {}),
      approval: {
        approvedAt: now,
        track: "plan_first",
        specHash: state.specHash,
        designVersion: state.designVersion,
        designHash: state.designHash,
        ...(decisionsHash ? { decisionsHash } : {}),
        baselineHead: baseline?.head ?? null,
        baselineFingerprint: baseline?.fingerprint ?? null,
        ...(note ? { note } : {}),
      },
      timeline: appendTimeline(
        state.timeline,
        makeEvent(
          now,
          "approved",
          "human",
          updatedPending.length > 0
            ? `采纳 ${updatedPending.length} 项决策并批准方案 v${state.designVersion}，进入编码阶段`
            : `批准方案 v${state.designVersion}，进入编码阶段`,
          note,
        ),
      ),
    };
    delete nextState.pendingDecisions;

    return {
      snapshotSpecRevision: state.revision,
      state: nextState,
    };
  });

  return toDetail(bundle, input.currentCodeSnapshotHash ?? null);
}

/**
 * Records or clears a human manual criterion checkoff bound to the current `specHash + codeSnapshotHash` (WB-18 / FLOW §1.2).
 */
export async function setManualCriterionCheck(
  root: string,
  id: string,
  input: {
    criterionId: string;
    checked: boolean;
    note?: string;
    expectedRevision?: number;
    currentCodeSnapshotHash: string | null;
  },
): Promise<RequirementDetail> {
  if (!input.currentCodeSnapshotHash || !/^[a-f0-9]{64}$/.test(input.currentCodeSnapshotHash)) {
    throw new WorkbenchError("acceptance_gate_failed", "缺少有效的当前代码快照指纹，无法记录人工核验状态");
  }
  const snapHash = input.currentCodeSnapshotHash;
  const bundle = await mutateRequirement(root, id, input.expectedRevision, (current, now) => {
    const { state } = current;
    if (state.stage !== "coding") {
      throw new WorkbenchError("invalid_transition", `仅编码阶段允许勾选人工验收条件（当前：${state.stage}）`);
    }
    const crit = state.criteria.find((c) => c.id === input.criterionId);
    if (!crit) {
      throw new WorkbenchError("not_found", `未找到验收条件 ${input.criterionId}`);
    }
    if (input.checked && !isManualCriterion(crit)) {
      throw new WorkbenchError("invalid_input", `验收条件 ${input.criterionId} 为自动化命令验证，请运行命令而非手工勾选`);
    }
    const note = input.note?.trim() ? sanitizeOutput(input.note.trim(), 900).text.trim() : undefined;
    const prev = (state.manualChecks ?? []).filter((mc) => mc.criterionId !== crit.id);
    const nextChecks: ManualCriterionCheck[] = input.checked
      ? [
          ...prev,
          {
            criterionId: crit.id,
            checked: true,
            checkedAt: now,
            specHash: state.specHash,
            codeSnapshotHash: snapHash,
            ...(note ? { note } : {}),
          },
        ]
      : prev;
    return {
      state: {
        ...state,
        manualChecks: nextChecks,
        timeline: appendTimeline(
          state.timeline,
          makeEvent(
            now,
            "manual_checked",
            "human",
            input.checked
              ? `人工核验通过验收条件 ${crit.id}（${crit.description.slice(0, 60)}）`
              : `取消人工核验勾选 ${crit.id}`,
            note,
          ),
        ),
      },
    };
  });
  return toDetail(bundle, snapHash);
}

/**
 * Human-only domain transition `coding -> planning` (WB-19 / FLOW §1.5):
 * invalidates approval, snapshots current `git diff` into `handoff.md`, leaves sandbox working tree untouched,
 * and marks `revisedFromCoding: true` so re-approval can offer optional sandbox reset.
 */
export async function revisePlan(
  root: string,
  id: string,
  input: {
    reason: string;
    expectedRevision?: number;
    currentCodeSnapshotHash?: string | null;
  },
): Promise<RequirementDetail> {
  const base = canonicalRoot(root);
  const reason = normalizeReason(input.reason, "退回修改方案原因");
  const codeRoot = resolveCodeRoot(base, id);
  const preBundle = readRequirementBundle(base, id);
  const changes = await observeGitChanges(codeRoot, {
    sinceHead: preBundle.state.baseline?.head ?? null,
    maxDiffBytes: 24 * 1024,
  }).catch(() => null);

  const diffSectionLines: string[] = [
    "",
    "## 退回修改方案前的代码改动现场（revisePlan）",
    `- **退回原因**：${reason}`,
  ];
  if (changes?.isGitRepo) {
    diffSectionLines.push(`- **代码目录**：\`${codeRoot}\` · HEAD \`${changes.head || "(unborn)"}\` · 变更文件数 ${changes.files.length}`);
    if (changes.files.length > 0) {
      diffSectionLines.push(`- **变更文件**：${changes.files.slice(0, 20).map((f) => `\`${f.path}\``).join("、")}`);
    }
    if (changes.diff.trim()) {
      diffSectionLines.push("```diff", sanitizeOutput(changes.diff.trim(), 16 * 1024).text, "```");
    } else {
      diffSectionLines.push("- 当前相对基线暂无代码差异。");
    }
  }
  const diffSection = diffSectionLines.join("\n");

  const bundle = await mutateRequirement(base, id, input.expectedRevision, (current, now) => {
    const { state } = current;
    if (state.stage !== "coding") {
      throw new WorkbenchError("invalid_transition", `仅编码阶段允许执行退回修改方案（当前：${state.stage}）`);
    }
    const existingHandoff = current.handoffMarkdown.trim();
    const prefixBase = `# ${state.id} · ${state.title}\n`;
    const budgetForExisting = Math.max(0, MAX_HANDOFF_BYTES - Buffer.byteLength(diffSection, "utf8") - 128);
    let combinedHandoff = existingHandoff ? `${existingHandoff}\n${diffSection}\n` : `${prefixBase}${diffSection}\n`;
    if (Buffer.byteLength(combinedHandoff, "utf8") > MAX_HANDOFF_BYTES) {
      const clippedExisting =
        budgetForExisting > 256
          ? clipHeadTailUtf8(existingHandoff, Math.min(2048, Math.floor(budgetForExisting / 4)), Math.floor(budgetForExisting * 0.7)).text
          : "";
      combinedHandoff = clippedExisting ? `${clippedExisting}\n${diffSection}\n` : `${prefixBase}${diffSection}\n`;
      if (Buffer.byteLength(combinedHandoff, "utf8") > MAX_HANDOFF_BYTES) {
        combinedHandoff = sanitizeOutput(combinedHandoff, MAX_HANDOFF_BYTES - 16).text;
      }
    }
    const mergedHandoff = validateMarkdownContent(combinedHandoff, "handoff", true);
    const convertedFromBug = state.kind === "bug" && state.track !== "plan_first";
    return {
      handoffMarkdown: mergedHandoff,
      state: {
        ...state,
        stage: "planning",
        ...(state.kind === "bug" ? { track: "plan_first" as const } : {}),
        approval: null,
        lastFeedback: reason,
        needsHuman: null,
        revisedFromCoding: true,
        timeline: appendTimeline(
          state.timeline,
          makeEvent(
            now,
            "plan_revised",
            "human",
            convertedFromBug
              ? "Bug 转常规方案流程（保留 Bug 标签，轨道切为 plan_first，已将当前 Diff 写入 handoff.md）"
              : "人类退回修改方案（coding → planning，已将当前 Diff 写入 handoff.md）",
            reason,
          ),
        ),
      },
    };
  });

  return toDetail(bundle, input.currentCodeSnapshotHash ?? changes?.fingerprint ?? null);
}

/** Records or clears explicit `needs_human` escalation state on a requirement (WB-19 / FLOW §3.1). */
export async function setRequirementNeedsHuman(
  root: string,
  id: string,
  needsHuman: NeedsHumanState | null,
  currentCodeSnapshotHash?: string | null,
): Promise<RequirementDetail> {
  const sanitizedNeedsHuman = needsHuman
    ? {
        ...needsHuman,
        reason: sanitizeOutput(needsHuman.reason.trim(), 1000).text.trim() || "需人工接管",
      }
    : null;
  const bundle = await mutateRequirement(root, id, undefined, (current, now) => {
    const { state } = current;
    if (state.stage === "done" || state.stage === "cancelled") {
      return { state };
    }
    if (!sanitizedNeedsHuman && !state.needsHuman) {
      return { state };
    }
    return {
      state: {
        ...state,
        needsHuman: sanitizedNeedsHuman,
        timeline: sanitizedNeedsHuman
          ? appendTimeline(
              state.timeline,
              makeEvent(now, "needs_human", "system", `升级为需人工接管：${sanitizeOutput(sanitizedNeedsHuman.reason, 300).text.trim()}`),
            )
          : state.timeline,
      },
    };
  });
  return toDetail(bundle, currentCodeSnapshotHash ?? null);
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
  const projectMeta = getProjectStatus(root).project;
  const configuredFastCmd = projectMeta?.verification?.fastCommand?.trim() || null;

  const bundle = await mutateRequirement(root, id, input.expectedRevision, (current, now) => {
    const { state } = current;
    if (state.stage !== "planning") {
      throw new WorkbenchError("invalid_transition", `当前阶段（${state.stage}）不能启用快速通道`);
    }
    const note = input.note?.trim() ? normalizeReason(input.note, "授权说明") : undefined;
    const baseline = input.baseline ?? state.baseline;
    const autoCriteria =
      state.criteria.length === 0 && configuredFastCmd
        ? [
            {
              id: "AC-1",
              description: "项目快速基线验证通过",
              required: true,
              command: configuredFastCmd,
              systemInjected: true,
            },
          ]
        : state.criteria;
    const nextSpecHash = autoCriteria !== state.criteria ? computeSpecHash(current.specMarkdown, autoCriteria) : state.specHash;
    const decisionsHash = computeDecisionsHash(state.humanDecisions);
    const isBug = state.kind === "bug";
    const nextState: RequirementState = {
      ...state,
      track: "fast_track",
      stage: "coding",
      criteria: autoCriteria,
      specHash: nextSpecHash,
      baseline,
      lastFeedback: null,
      needsHuman: null,
      revisedFromCoding: false,
      approval: {
        approvedAt: now,
        track: "fast_track",
        specHash: nextSpecHash,
        designVersion: state.designVersion,
        designHash: state.designHash,
        ...(decisionsHash ? { decisionsHash } : {}),
        baselineHead: baseline?.head ?? null,
        baselineFingerprint: baseline?.fingerprint ?? null,
        ...(note ? { note } : {}),
      },
      timeline: appendTimeline(
        state.timeline,
        makeEvent(
          now,
          "fast_tracked",
          "human",
          isBug ? "授权开始修复 Bug，直接进入编码、回归测试与验证" : "启用快速通道，跳过方案审批直接进入编码与验证",
          note,
        ),
      ),
    };
    delete nextState.pendingDecisions;
    return {
      snapshotSpecRevision: state.revision,
      state: nextState,
    };
  });

  return toDetail(bundle, input.currentCodeSnapshotHash ?? null);
}

export interface SpawnSubRequirementItem {
  title: string;
  goal?: string;
  track?: Track;
}

const SPAWN_SKIP_HEADING_RE = /^(?:总体思路|背景|概述|目标|验收|验证|目录|风险|回滚|overview|background|verification|testing|risks?)$/i;

export function extractSpawnCandidatesFromRequirement(detail: RequirementDetail): SpawnSubRequirementItem[] {
  const md = detail.designMarkdown.trim();
  if (!md) return [];
  const candidates: SpawnSubRequirementItem[] = [];
  const lines = md.split(/\r?\n/);
  let currentTitle: string | null = null;
  let currentBody: string[] = [];
  let inFence = false;
  const flush = () => {
    if (!currentTitle) return;
    const body = currentBody.join("\n").trim();
    const cleanTitle = currentTitle.replace(/^\d+(?:\.\d+)*[.)、\s]+/, "").trim() || currentTitle;
    if (!SPAWN_SKIP_HEADING_RE.test(cleanTitle)) {
      candidates.push({
        title: cleanTitle.slice(0, 100),
        goal: body ? body.slice(0, 2000) : cleanTitle,
      });
    }
    currentTitle = null;
    currentBody = [];
  };
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
    }
    if (!inFence) {
      const m = /^##\s+(.+?)\s*#*$/.exec(line.trim());
      if (m) {
        flush();
        currentTitle = m[1]!.trim();
        continue;
      }
    }
    if (currentTitle) {
      currentBody.push(line);
    }
  }
  flush();
  return candidates.slice(0, 12);
}

export async function spawnSubRequirements(
  root: string,
  parentId: string,
  input: {
    items?: SpawnSubRequirementItem[];
    track?: Track;
    currentCodeSnapshotHash?: string | null;
  } = {},
): Promise<{ parent: RequirementDetail; created: RequirementDetail[] }> {
  const base = canonicalRoot(root);
  const parent = getRequirement(base, parentId, { currentCodeSnapshotHash: input.currentCodeSnapshotHash });
  if (parent.state.stage === "cancelled") {
    throw new WorkbenchError("invalid_transition", "已取消的需求不能派生子需求");
  }
  const rawItems =
    input.items && input.items.length > 0
      ? input.items
      : extractSpawnCandidatesFromRequirement(parent);
  const items = rawItems
    .map((item) => ({
      title: item.title?.trim() ?? "",
      goal: item.goal?.trim() || item.title?.trim() || "",
      track: item.track ?? input.track ?? "plan_first",
    }))
    .filter((item) => item.title.length > 0)
    .slice(0, 12);

  if (items.length === 0) {
    throw new WorkbenchError("invalid_input", "请提供至少一条子需求条目，或先在父需求生成方案章节");
  }

  const created: RequirementDetail[] = [];
  for (const item of items) {
    const goalLines: string[] = [
      `# ${item.title}`,
      "",
      `> 派生自父架构需求 \`${parent.state.id}\`（${parent.state.title}）`,
      `> 父方案参考：\`.workbench/items/${parent.state.id}/design.md\``,
      "",
      item.goal,
    ];
    const child = await createRequirement(base, {
      title: item.title,
      goal: goalLines.join("\n"),
      parentId: parent.state.id,
      track: item.track,
      tier: parent.state.tier,
      currentCodeSnapshotHash: input.currentCodeSnapshotHash ?? null,
    });
    created.push(child);
  }

  await mutateRequirement(base, parent.state.id, undefined, (current, now) => ({
    state: {
      ...current.state,
      timeline: appendTimeline(
        current.state.timeline,
        makeEvent(
          now,
          "sub_requirements_spawned",
          "human",
          `派生 ${created.length} 条子需求：${created.map((c) => c.state.id).join("、")}`,
        ),
      ),
    },
  }));

  const updatedParent = getRequirement(base, parent.state.id, {
    currentCodeSnapshotHash: input.currentCodeSnapshotHash ?? null,
  });
  return { parent: updatedParent, created };
}

export async function requestChanges(
  root: string,
  id: string,
  input: {
    feedback: string;
    expectedRevision?: number;
    currentCodeSnapshotHash?: string | null;
    rememberLesson?: boolean;
    lessonText?: string;
  },
): Promise<RequirementDetail> {
  const feedback = normalizeReason(input.feedback, "修改意见");
  const bundle = await mutateRequirement(root, id, input.expectedRevision, (current, now) => {
    const { state } = current;
    if (state.stage === "planning") {
      return {
        state: {
          ...state,
          stage: "planning",
          approval: null,
          lastFeedback: feedback,
          timeline: appendTimeline(
            state.timeline,
            makeEvent(now, "changes_requested", "human", "退回方案，要求修改", feedback),
          ),
        },
      };
    }
    if (state.stage === "coding") {
      return {
        state: {
          ...state,
          stage: "coding",
          lastFeedback: feedback,
          needsHuman: null,
          timeline: appendTimeline(state.timeline, makeEvent(now, "rejected", "human", "验收打回修改", feedback)),
        },
      };
    }
    throw new WorkbenchError("invalid_transition", `当前阶段（${state.stage}）不支持退回修改`);
  });

  if (input.rememberLesson === true) {
    const lesson = (input.lessonText?.trim() || feedback).trim();
    if (lesson) {
      await appendProjectPlaybookLesson(root, { lesson, source: "reject", requirementId: id }).catch(() => null);
    }
  }

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
    if (state.stage !== "coding") {
      throw new WorkbenchError(
        "approval_required",
        `当前阶段（${state.stage}）不能记录验证证据；必须先获得人类方案批准并进入编码阶段`,
      );
    }
    const criteriaById = new Map(state.criteria.map((c) => [c.id, c]));
    for (const criterionId of record.criterionIds) {
      const criterion = criteriaById.get(criterionId);
      if (!criterion) {
        throw new WorkbenchError("invalid_input", `验证关联的验收条件 ID 不存在: ${criterionId}`);
      }
      if (isManualCriterion(criterion)) {
        throw new WorkbenchError("invalid_input", `验收条件 ${criterionId} 为人工核验项，必须由人类手动勾选，禁止写入自动化验证记录`);
      }
    }

    const summary = record.passed
      ? `验证通过：${record.command}（${record.durationMs}ms）`
      : `验证失败：${record.command}（${record.timedOut ? "超时" : `退出码 ${record.exitCode ?? "未知"}`}）`;

    return {
      evidenceWrite: { record, rawLog: input.rawLog },
      state: {
        ...state,
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
    if (state.stage !== "coding") {
      throw new WorkbenchError(
        "approval_required",
        `当前阶段（${state.stage}）不能记录截图证据；仅编码阶段允许采集`,
      );
    }
    const existing = state.screenshotBatches ?? [];
    if (existing.some((item) => item.id === batch.id)) {
      throw new WorkbenchError("invalid_input", `截图批次 ID 已存在: ${batch.id}`);
    }
    const nextBatches = [...existing, batch];
    const evidenceKind = batch.source === "scenario" ? "需求场景截图" : "通用页面巡检截图";
    const summary =
      batch.status === "skipped"
        ? `已记录${evidenceKind}跳过：${batch.skipReason ?? "浏览器环境不可用"}`
        : batch.status === "partial"
          ? `${evidenceKind}部分完成（${batch.shots.length} 张），存在跳过项`
          : `已采集${evidenceKind}（${batch.shots.length} 张）`;
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
  let diffForTampering = changes.diff;
  if (changes.diffStatus === "captured" && changes.diffTruncated && changes.isGitRepo) {
    const testPaths = changes.files
      .map((f) => f.path)
      .filter((p) => /(?:^|\/)(?:__tests__\/.*|test_[^/]+\.py|.*_test\.go|.*\.(?:test|spec)\.[A-Za-z0-9]+)$/i.test(p) || p.endsWith(".rs"));
    if (testPaths.length > 0) {
      try {
        const diffArgs = changes.baselineAvailable && changes.baselineHead
          ? ["-C", codeRoot, "diff", "--no-color", changes.baselineHead, "--", ...testPaths.slice(0, 64)]
          : ["-C", codeRoot, "diff", "--no-color", "HEAD", "--", ...testPaths.slice(0, 64)];
        diffForTampering = execFileSync("git", diffArgs, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
      } catch {
        // Fall back to truncated diff if targeted test diff fails.
      }
    }
  }
  const testTamperingSignals =
    changes.diffStatus === "captured" ? detectTestTamperingSignals(changes.files, diffForTampering) : [];
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
    ...(testTamperingSignals.length > 0 ? { testTamperingSignals } : {}),
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
    rememberLesson?: boolean;
    lessonText?: string;
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
  if (preBundle.state.stage !== "coding") {
    throw new WorkbenchError("invalid_transition", `当前阶段（${preBundle.state.stage}）无法执行验收通过`, {
      messageKey: "accept.errInvalidStage",
      messageParams: { stage: preBundle.state.stage },
    });
  }
  const overrideReason = input.overrideReason?.trim()
    ? normalizeReason(input.overrideReason, "忽略审查阻塞/接受风险说明")
    : undefined;
  const preValidity = evaluateRequirement(preBundle.state, snapshotHash);
  const preNonWaivable =
    !preValidity.approval.valid || preValidity.coverage.requiredTotal === 0;
  if (!preValidity.acceptanceGate.ok && (preNonWaivable || !overrideReason)) {
    throw new WorkbenchError(
      "acceptance_gate_failed",
      `验收门禁未通过：${preValidity.acceptanceGate.blockers.join("；")}`,
      {
        blockers: preValidity.acceptanceGate.blockers,
        ...(preValidity.acceptanceGate.blockerRefs ? { blockerRefs: preValidity.acceptanceGate.blockerRefs } : {}),
      },
    );
  }
  if (
    (preValidity.reviewValidity.effectiveState === "current" || preValidity.reviewValidity.effectiveState === "stale") &&
    preBundle.state.reviewReport?.verdict === "block" &&
    !overrideReason
  ) {
    const isStaleBlock = preValidity.reviewValidity.effectiveState === "stale";
    throw new WorkbenchError(
      "acceptance_gate_failed",
      isStaleBlock
        ? "上一份跨模型审查为阻塞级（block）且因代码或规范变动已过期，跳过复审强行验收必须填写说明理由（overrideReason）"
        : "当前存在有效的阻塞级（block）跨模型审查意见，强行验收必须填写说明理由（overrideReason）",
      {
        reviewVerdict: "block",
        reviewState: preValidity.reviewValidity.effectiveState,
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
    if (state.stage !== "coding") {
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
    const nonWaivable = !validity.approval.valid || validity.coverage.requiredTotal === 0;
    if (!validity.acceptanceGate.ok && (nonWaivable || !overrideReason)) {
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
      (validity.reviewValidity.effectiveState === "current" || validity.reviewValidity.effectiveState === "stale") &&
      state.reviewReport?.verdict === "block" &&
      !overrideReason
    ) {
      const isStaleBlock = validity.reviewValidity.effectiveState === "stale";
      throw new WorkbenchError(
        "acceptance_gate_failed",
        isStaleBlock
          ? "上一份跨模型审查为阻塞级（block）且因代码或规范变动已过期，跳过复审强行验收必须填写说明理由（overrideReason）"
          : "当前存在有效的阻塞级（block）跨模型审查意见，强行验收必须填写说明理由（overrideReason）",
        {
          reviewVerdict: "block",
          reviewState: validity.reviewValidity.effectiveState,
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
    const rawUserRisks = Array.isArray(input.acceptedRisks)
      ? input.acceptedRisks
          .filter((r): r is string => typeof r === "string")
          .map((r) => sanitizeOutput(r.trim(), 900).text.trim())
          .filter(Boolean)
      : [];
    const gateBlockersForAudit = !validity.acceptanceGate.ok ? validity.acceptanceGate.blockers : [];
    const mergedRisks = Array.from(new Set([...gateBlockersForAudit, ...rawUserRisks])).slice(0, 50);
    const acceptedRisks = mergedRisks.length > 0 ? mergedRisks : undefined;
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
        needsHuman: null,
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

  if (input.rememberLesson === true) {
    const lesson = (input.lessonText?.trim() || input.note?.trim() || input.overrideReason?.trim() || "").trim();
    if (lesson) {
      await appendProjectPlaybookLesson(base, { lesson, source: "accept", requirementId: id }).catch(() => null);
    }
  }

  return toDetail(bundle, snapshotHash);
}

export function buildSuggestedCommitMessage(
  id: string,
  title: string,
  specMarkdown?: string,
  files?: string[],
): string {
  const cleanTitle = title.replace(/[\r\n]+/g, " ").trim().slice(0, 72) || "complete requirement";
  const subject = `feat(${id.toLowerCase()}): ${cleanTitle}`;
  if (!specMarkdown?.trim() && (!files || files.length === 0)) {
    return subject;
  }
  const bodyLines: string[] = [];
  if (specMarkdown?.trim()) {
    const firstPara = specMarkdown
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith(">") && !l.startsWith("```"));
    if (firstPara && firstPara !== cleanTitle) {
      bodyLines.push(firstPara.slice(0, 180));
    }
  }
  if (files && files.length > 0) {
    const previewFiles = files.slice(0, 8).join(", ");
    const suffix = files.length > 8 ? ` (+${files.length - 8} more)` : "";
    bodyLines.push(`Changed files (${files.length}): ${previewFiles}${suffix}`);
  }
  return bodyLines.length > 0 ? `${subject}\n\n${bodyLines.join("\n")}` : subject;
}

/** Records a completed local squash-merge delivery on a `done` requirement (WB-20). */
export async function recordLocalDelivery(
  root: string,
  id: string,
  input: {
    delivery: DeliveryRecord;
    summary?: string;
    expectedRevision?: number;
    currentCodeSnapshotHash?: string | null;
  },
): Promise<RequirementDetail> {
  const bundle = await mutateRequirement(root, id, input.expectedRevision, (current, now) => {
    const { state } = current;
    if (state.stage !== "done") {
      throw new WorkbenchError("invalid_transition", `仅已验收完成的需求才能记录交付结果（当前：${state.stage}）`);
    }
    const firstLine = input.delivery.commitMessage.split(/\r?\n/, 1)[0] ?? input.delivery.commitMessage;
    return {
      state: {
        ...state,
        delivery: input.delivery,
        timeline: appendTimeline(
          state.timeline,
          makeEvent(
            now,
            "delivered",
            "human",
            input.summary?.trim() ||
              `已一键压缩合入本地主干（${input.delivery.shortHash} · ${input.delivery.files.length} 个文件）：${firstLine.slice(0, 120)}`,
            input.delivery.note,
          ),
        ),
      },
    };
  });
  return toDetail(bundle, input.currentCodeSnapshotHash ?? null);
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
  const explicitBaseBranch =
    remoteProvider === "gitee"
      ? projectMeta.gitee?.defaultBaseBranch?.trim() || undefined
      : projectMeta.github?.defaultBaseBranch?.trim() || undefined;
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
    baseBranch = explicitBaseBranch ?? giteeEnv.defaultBaseBranch ?? "master";
    remoteRepo = giteeEnv.repo;
    remoteReady = giteeEnv.ready;
    remoteReason = giteeEnv.reason;
  } else {
    const ghEnv = await inspectGitHubEnvironment(base, projectMeta.github, deps);
    baseBranch = explicitBaseBranch ?? ghEnv.defaultBaseBranch ?? "main";
    remoteRepo = ghEnv.repo;
    remoteReady = ghEnv.ready;
    remoteReason = ghEnv.reason;
  }

  const aheadRef = sandbox
    ? (sandbox.baseHead ?? baseBranch)
    : tree.branch && tree.branch !== baseBranch
      ? baseBranch
      : null;
  let effectiveAheadCount =
    tree.isGitRepo && aheadRef ? await countCommitsBetween(codeRoot, aheadRef, "HEAD") : 0;
  const wipCommitCount =
    tree.isGitRepo && sandbox && aheadRef ? await countWipCommitsBetween(codeRoot, aheadRef, "HEAD") : 0;

  const isFeaturePrefix = /^(?:feat|fix|rsi|chore|hotfix|bugfix|refactor|docs|test)\//i;
  if (
    !sandbox &&
    tree.isGitRepo &&
    tree.branch &&
    tree.branch !== baseBranch &&
    !explicitBaseBranch &&
    !isFeaturePrefix.test(tree.branch) &&
    effectiveAheadCount >= 10
  ) {
    const curRemote = await inspectRemoteBranchDivergence(codeRoot, tree.branch, "origin");
    if (curRemote.remoteBranchExists) {
      baseBranch = tree.branch;
      effectiveAheadCount = 0;
    }
  }

  let reason: string | null = null;
  let canCommit = false;
  let canCreatePr = false;
  let canMergeLocal = false;

  if (state.stage !== "done") {
    reason = "仅已验收完成（done）的需求可执行交付提交";
  } else if (!tree.isGitRepo) {
    reason = "当前目录不是 Git 仓库，无法创建交付提交";
  } else if (sandboxActive) {
    if (candidates.length === 0 && effectiveAheadCount === 0) {
      reason = "隔离沙箱中暂无可提交或待推送的变更";
    } else {
      canMergeLocal = true;
      if (!remoteReady) {
        reason =
          remoteReason ??
          (remoteProvider === "gitee"
            ? "Gitee 环境未就绪，可使用「一键合入本地主干」本地合并"
            : "GitHub 环境未就绪，可使用「一键合入本地主干」本地合并");
      } else {
        canCreatePr = true;
      }
    }
  } else {
    if (candidates.length === 0 && effectiveAheadCount === 0) {
      reason = "当前工作区干净，暂无未提交改动";
    } else {
      canCommit = candidates.length > 0;
      canCreatePr = remoteReady && (candidates.length > 0 || effectiveAheadCount > 0);
    }
  }

  let treeMatchesAcceptance = true;
  let treeMismatchReason: string | null = null;
  const currentSnap = tree.isGitRepo ? await observeGitSnapshot(codeRoot) : null;
  if (state.stage === "done" && state.acceptance && currentSnap?.fingerprint) {
    let matchesAccepted = currentSnap.fingerprint === state.acceptance.codeSnapshotHash;
    const matchesCleanSync = Boolean(
      sandbox?.lastCleanSyncFingerprint && sandbox.lastCleanSyncFingerprint === currentSnap.fingerprint,
    );
    if (
      !matchesAccepted &&
      !matchesCleanSync &&
      !sandboxActive &&
      bundle.acceptanceSnapshot &&
      bundle.acceptanceSnapshot.git.files.length > 0 &&
      bundle.acceptanceSnapshot.git.observedHead &&
      tree.head === bundle.acceptanceSnapshot.git.observedHead
    ) {
      const acceptedPaths = bundle.acceptanceSnapshot.git.files.map((f) => f.path);
      const selectedFp = await computeSelectedFilesContentTreeFingerprint(codeRoot, acceptedPaths);
      if (selectedFp && selectedFp === state.acceptance.codeSnapshotHash) {
        matchesAccepted = true;
      }
    }
    if (!matchesAccepted && !matchesCleanSync) {
      treeMatchesAcceptance = false;
      treeMismatchReason = "当前代码内容树与验收快照不一致，请重新验证受影响条件后再交付";
    }
  }

  const suggestedBranch = sandbox
    ? sandbox.branch
    : tree.branch && tree.branch !== baseBranch && tree.branch !== "main" && tree.branch !== "master"
      ? tree.branch
      : `feat/${state.id.toLowerCase()}`;

  const remoteDivergence =
    tree.isGitRepo && suggestedBranch !== baseBranch
      ? await inspectRemoteBranchDivergence(codeRoot, suggestedBranch, "origin")
      : { remoteBranchExists: false, behindRemoteCount: 0, diverged: false };

  const previewFiles =
    candidates.length > 0
      ? candidates.map((c) => c.path)
      : bundle.acceptanceSnapshot?.git.files.map((f) => f.path) ?? [];
  const detailForPreview = toDetail(bundle, currentSnap?.fingerprint ?? null);
  const suggestedPrTitle = `${state.id}: ${state.title}`.slice(0, 200);
  const suggestedPrBody = buildRequirementPrBody(detailForPreview);

  return {
    requirementId: state.id,
    stage: state.stage,
    isGitRepo: tree.isGitRepo,
    codeRootKind,
    branch: tree.branch,
    head: tree.head,
    dirty: tree.dirty,
    sandboxActive,
    aheadCommitsCount: effectiveAheadCount,
    canCommit,
    canCreatePr,
    canMergeLocal,
    wipCommitCount,
    treeMatchesAcceptance,
    treeMismatchReason,
    remoteProvider,
    baseBranch,
    githubRepo: remoteRepo,
    githubReady: remoteReady,
    githubReason: remoteReason,
    reason,
    suggestedMessage: buildSuggestedCommitMessage(state.id, state.title, bundle.specMarkdown, previewFiles),
    suggestedBranch,
    suggestedPrTitle,
    suggestedPrBody,
    candidates,
    acceptedSnapshotFileCount: acceptedSet.size,
    delivered: state.delivery ?? null,
    githubPr: state.github?.pr ?? null,
    remoteBranchExists: remoteDivergence.remoteBranchExists,
    remoteBranchDiverged: remoteDivergence.diverged,
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
    forceWithLease?: boolean;
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
    const bundle = await withCodeRootLock(base, "write", { kind: "deliver", requirementId: id }, () =>
      mutateRequirement(base, id, input.expectedRevision, async (current, now) => {
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

        // WB-20 / FLOW §4.2: verify selected delivery tree matches accepted snapshot before reusing acceptance.
        if (state.acceptance && current.acceptanceSnapshot && current.acceptanceSnapshot.git.files.length > 0) {
          const acceptedFiles = current.acceptanceSnapshot.git.files.map((f) => f.path).sort();
          const selectedSorted = [...files].sort();
          const scopeChanged =
            acceptedFiles.length !== selectedSorted.length ||
            acceptedFiles.some((f, idx) => f !== selectedSorted[idx]);
          if (scopeChanged) {
            throw new WorkbenchError(
              "acceptance_gate_failed",
              "所选交付文件范围与验收快照不一致，请重新验证受影响条件并确认后再交付",
              { requiresReverify: true },
            );
          }
          if (current.acceptanceSnapshot.git.observedHead && tree.head !== current.acceptanceSnapshot.git.observedHead) {
            throw new WorkbenchError(
              "acceptance_gate_failed",
              "目标基线在验收后已发生变化，请重新验证受影响条件并确认后再交付",
              { requiresReverify: true },
            );
          }
          const selectedTreeFp = await computeSelectedFilesContentTreeFingerprint(base, files);
          if (selectedTreeFp && selectedTreeFp !== state.acceptance.codeSnapshotHash) {
            throw new WorkbenchError(
              "acceptance_gate_failed",
              "待交付文件内容树在验收后已发生变化，请重新验证受影响条件后再交付",
              { requiresReverify: true },
            );
          }
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
      }),
    );

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

  const requestedBranch = input.branchName?.trim() || "";
  let targetBranch = "";
  let committedFiles: string[] = [];
  let commitHash = "";
  let shortHash = "";
  let effectiveCommitMessage = "";

  await withCodeRootLock(codeRoot, "write", { kind: "deliver_pr", requirementId: id }, async () => {
    const liveTree = await inspectWorkingTreeForDelivery(codeRoot);
    if (!liveTree.isGitRepo) {
      throw new WorkbenchError("execution_failed", "当前目录不是 Git 仓库，无法推送分支或创建 PR");
    }
    targetBranch = sandbox ? sandbox.branch : (liveTree.branch ?? "");
    if (
      !sandbox &&
      (!targetBranch ||
        targetBranch === baseBranch ||
        targetBranch === "main" ||
        targetBranch === "master" ||
        targetBranch === "HEAD" ||
        (requestedBranch && requestedBranch !== targetBranch))
    ) {
      targetBranch = await createFeatureBranchAtHead(codeRoot, requestedBranch || `feat/${id.toLowerCase()}`);
    }
    targetBranch = validateGitBranchName(targetBranch);

    const requestedFiles = Array.isArray(input.files) ? input.files.filter((f) => typeof f === "string" && f.trim().length > 0) : [];
    const preDeliverySnap = await observeGitSnapshot(codeRoot);

    if (requestedFiles.length > 0) {
      const normalizedFiles = normalizeDeliveryFiles(requestedFiles);
      const commitMessage = typeof input.commitMessage === "string" ? input.commitMessage.trim() : "";
      if (!commitMessage || !isSafeText(commitMessage, 4000)) {
        throw new WorkbenchError("invalid_input", "请填写合法的 Git 提交说明");
      }
      const dirtySet = new Set(liveTree.files.map((f) => f.path));
      const missing = normalizedFiles.filter((f) => !dirtySet.has(f));
      if (missing.length > 0) {
        throw new WorkbenchError(
          "invalid_input",
          `以下文件当前没有未提交变更，无法纳入提交: ${missing.slice(0, 5).join(", ")}`,
        );
      }
      if (preBundle.acceptanceSnapshot && preBundle.acceptanceSnapshot.git.files.length > 0) {
        const acceptedPaths = new Set(preBundle.acceptanceSnapshot.git.files.map((f) => f.path));
        const omitsAccepted = preBundle.acceptanceSnapshot.git.files.some(
          (f) => dirtySet.has(f.path) && !normalizedFiles.includes(f.path),
        );
        const addsUnaccepted = normalizedFiles.some((f) => !acceptedPaths.has(f));
        if (omitsAccepted || addsUnaccepted) {
          throw new WorkbenchError(
            "acceptance_gate_failed",
            "所选交付文件范围与验收快照不一致，请重新验证受影响条件后再交付",
            { requiresReverify: true },
          );
        }
      }
      if (preBundle.state.acceptance) {
        if (!sandbox) {
          if (
            preBundle.acceptanceSnapshot?.git.observedHead &&
            liveTree.head !== preBundle.acceptanceSnapshot.git.observedHead
          ) {
            throw new WorkbenchError(
              "acceptance_gate_failed",
              "目标基线在验收后已发生变化，请重新验证受影响条件后再创建 PR",
              { requiresReverify: true },
            );
          }
          const selectedTreeFp = await computeSelectedFilesContentTreeFingerprint(codeRoot, normalizedFiles);
          if (selectedTreeFp && selectedTreeFp !== preBundle.state.acceptance.codeSnapshotHash) {
            throw new WorkbenchError(
              "acceptance_gate_failed",
              "待交付文件内容树在验收后已发生变化，请重新验证受影响条件后再创建 PR",
              { requiresReverify: true },
            );
          }
        } else if (preDeliverySnap?.fingerprint && preDeliverySnap.fingerprint !== preBundle.state.acceptance.codeSnapshotHash) {
          throw new WorkbenchError(
            "acceptance_gate_failed",
            "沙箱代码内容树在验收后已发生变化，请重新验证受影响条件后再创建 PR",
            { requiresReverify: true },
          );
        }
      }
      const aheadRefForWip = sandbox?.baseHead || baseBranch;
      const wipCount = sandbox ? await countWipCommitsBetween(codeRoot, aheadRefForWip, "HEAD") : 0;
      if (sandbox && wipCount > 0 && normalizedFiles.length === liveTree.files.length) {
        const squashed = await squashBranchCommitsToSingleCommit(codeRoot, aheadRefForWip, commitMessage);
        if (
          squashed.beforeFingerprint &&
          squashed.afterFingerprint &&
          squashed.beforeFingerprint !== squashed.afterFingerprint
        ) {
          if (squashed.origHead) {
            try {
              execFileSync("git", ["-C", codeRoot, "reset", "--soft", squashed.origHead], { stdio: "ignore" });
            } catch {
              // Ignore rollback error.
            }
          }
          throw new WorkbenchError(
            "acceptance_gate_failed",
            "压缩提交后文件树与验收快照不一致，请重新验证受影响条件后再交付",
            { requiresReverify: true },
          );
        }
        commitHash = squashed.commitHash;
        shortHash = squashed.shortHash;
        committedFiles = squashed.files;
        effectiveCommitMessage = commitMessage;
      } else {
        const committed = await commitFilesInGit(codeRoot, normalizedFiles, commitMessage);
        commitHash = committed.commitHash;
        shortHash = committed.shortHash;
        committedFiles = normalizedFiles;
        effectiveCommitMessage = commitMessage;
      }
    } else {
      if (
        preBundle.state.acceptance &&
        preDeliverySnap?.fingerprint &&
        preDeliverySnap.fingerprint !== preBundle.state.acceptance.codeSnapshotHash
      ) {
        throw new WorkbenchError(
          "acceptance_gate_failed",
          "代码内容树在验收后已发生变化，请重新验证受影响条件后再创建 PR",
          { requiresReverify: true },
        );
      }
      const aheadRef = sandbox?.baseHead || baseBranch;
      const aheadCount = await countCommitsBetween(codeRoot, aheadRef, "HEAD");
      if (aheadCount <= 0 && !liveTree.dirty) {
        throw new WorkbenchError("invalid_input", "请至少选择 1 个要提交的文件，或确保分支已有未推送提交", {
          messageKey: "deliver.errNoFilesOrCommits",
        });
      }
      const wipCount = sandbox ? await countWipCommitsBetween(codeRoot, aheadRef, "HEAD") : 0;
      const shouldAutoSquash = Boolean(sandbox && (wipCount > 0 || aheadCount > 1 || liveTree.dirty));
      if (shouldAutoSquash) {
        const squashMsg =
          (typeof input.commitMessage === "string" && input.commitMessage.trim()) ||
          buildSuggestedCommitMessage(preBundle.state.id, preBundle.state.title, preBundle.specMarkdown);
        const squashed = await squashBranchCommitsToSingleCommit(codeRoot, aheadRef, squashMsg);
        if (
          squashed.beforeFingerprint &&
          squashed.afterFingerprint &&
          squashed.beforeFingerprint !== squashed.afterFingerprint
        ) {
          if (squashed.origHead) {
            try {
              execFileSync("git", ["-C", codeRoot, "reset", "--soft", squashed.origHead], { stdio: "ignore" });
            } catch {
              // Ignore rollback error.
            }
          }
          throw new WorkbenchError(
            "acceptance_gate_failed",
            "压缩提交后文件树与验收快照不一致，请重新验证受影响条件后再交付",
            { requiresReverify: true },
          );
        }
        commitHash = squashed.commitHash;
        shortHash = squashed.shortHash;
        committedFiles = squashed.files;
        effectiveCommitMessage = squashMsg;
      } else {
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
    }

    const allowForceLease =
      input.forceWithLease === true &&
      targetBranch !== baseBranch &&
      targetBranch !== "main" &&
      targetBranch !== "master";
    await pushBranchToRemote(codeRoot, targetBranch, "origin", { forceWithLease: allowForceLease });
  });

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
        cancelReason: reason,
        timeline: appendTimeline(state.timeline, makeEvent(now, "cancelled", "human", "取消需求", reason)),
      },
    };
  });

  return toDetail(bundle, input.currentCodeSnapshotHash ?? null);
}

export async function reopenRequirement(
  root: string,
  id: string,
  input: {
    reason: string;
    preserveApproval?: boolean;
    expectedRevision?: number;
    currentCodeSnapshotHash?: string | null;
  },
): Promise<RequirementDetail> {
  const reason = normalizeReason(input.reason, "重开原因");
  const bundle = await mutateRequirement(root, id, input.expectedRevision, (current, now) => {
    const { state } = current;
    if (state.stage !== "done" && state.stage !== "cancelled") {
      throw new WorkbenchError("invalid_transition", `只有已完成或已取消的需求才能重新打开（当前：${state.stage}）`);
    }
    const canKeepApproval = input.preserveApproval === true && evaluateApproval(state).valid;
    return {
      state: {
        ...state,
        stage: canKeepApproval ? "coding" : "planning",
        approval: canKeepApproval ? state.approval : null,
        acceptance: null,
        delivery: null,
        cancelReason: null,
        needsHuman: null,
        timeline: appendTimeline(
          state.timeline,
          makeEvent(
            now,
            "reopened",
            "human",
            canKeepApproval
              ? "退回编码阶段（保留既有方案批准，历史验收记录仅作存档）"
              : "重新打开需求（历史批准与验收仅作存档，不自动复用）",
            reason,
          ),
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
    kind?: DiscussionEntry["kind"];
    message: string;
    anchor?: string;
    harness?: string;
    model?: string;
    resolved?: boolean;
    adopted?: boolean;
    runId?: string;
    durationMs?: number;
    toolCallsCount?: number;
    handoffMode?: DiscussionEntry["handoffMode"];
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
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.anchor?.trim() ? { anchor: input.anchor.trim().slice(0, 120) } : {}),
    ...(input.harness?.trim() ? { harness: input.harness.trim().slice(0, 64) } : {}),
    ...(input.model?.trim() ? { model: input.model.trim().slice(0, 200) } : {}),
    message,
    ...(input.resolved !== undefined ? { resolved: input.resolved } : {}),
    ...(input.adopted !== undefined ? { adopted: input.adopted } : {}),
    ...(input.runId?.trim() ? { runId: input.runId.trim().slice(0, 80) } : {}),
    ...(typeof input.durationMs === "number" && Number.isFinite(input.durationMs) && input.durationMs >= 0
      ? { durationMs: Math.round(input.durationMs) }
      : {}),
    ...(typeof input.toolCallsCount === "number" && Number.isFinite(input.toolCallsCount) && input.toolCallsCount >= 0
      ? { toolCallsCount: Math.floor(input.toolCallsCount) }
      : {}),
    ...(input.handoffMode ? { handoffMode: input.handoffMode } : {}),
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
  input: { ids?: string[]; resolved?: boolean; adopted?: boolean; currentCodeSnapshotHash?: string | null } = {},
): Promise<RequirementDetail> {
  const targetResolved = input.resolved;
  const targetAdopted = input.adopted;
  const bundle = await mutateRequirement(root, id, undefined, (current) => {
    const { state } = current;
    const idSet = input.ids ? new Set(input.ids) : null;
    const next = (state.discussions ?? []).map((item) => {
      if (idSet !== null && !idSet.has(item.id)) return item;
      return {
        ...item,
        ...(targetResolved !== undefined ? { resolved: targetResolved } : targetAdopted === undefined ? { resolved: true } : {}),
        ...(targetAdopted !== undefined ? { adopted: targetAdopted } : {}),
      };
    });
    return {
      state: {
        ...state,
        discussions: next,
      },
    };
  });
  return toDetail(bundle, input.currentCodeSnapshotHash ?? null);
}

export async function deleteDiscussion(
  root: string,
  id: string,
  discId: string,
  currentCodeSnapshotHash?: string | null,
): Promise<RequirementDetail> {
  const cleanId = discId.trim();
  if (!cleanId) {
    throw new WorkbenchError("invalid_input", "批注或讨论 ID 不能为空");
  }
  const bundle = await mutateRequirement(root, id, undefined, (current) => {
    const { state } = current;
    const prev = state.discussions ?? [];
    if (!prev.some((item) => item.id === cleanId)) {
      throw new WorkbenchError("not_found", `未找到批注或讨论记录: ${cleanId}`);
    }
    const next = prev.filter((item) => item.id !== cleanId);
    return {
      state: {
        ...state,
        discussions: next,
      },
    };
  });
  return toDetail(bundle, currentCodeSnapshotHash ?? null);
}

export async function startAgentRun(
  root: string,
  id: string,
  recordInput: AgentRunRecord,
  currentCodeSnapshotHash?: string | null,
): Promise<RequirementDetail> {
  const record = validateAgentRunRecord(recordInput);
  const bundle = await mutateRequirement(root, id, undefined, (current, now) => {
    const { state } = current;
    const prev = state.agentRuns ?? [];
    const next = [...prev.filter((r) => r.id !== record.id), record].slice(-MAX_AGENT_RUNS);
    const isHandoff = record.handoffMode === "fresh_handoff" || record.handoffMode === "native_resume";
    const handoffHint =
      record.handoffMode === "native_resume"
        ? "同构续接会话"
        : record.handoffMode === "fresh_handoff"
          ? "跨模型交接启动"
          : "首次调度";
    const event = makeEvent(
      now,
      isHandoff ? "agent_handoff" : "agent_run_started",
      "system",
      `${handoffHint} [${record.action}]：${record.harness}/${record.model}`,
      record.dispatchReason ? `调度原因：${record.dispatchReason}` : undefined,
      record.id,
    );
    return {
      runWrite: { record, rawLog: "" },
      state: {
        ...state,
        agentRuns: next,
        timeline: appendTimeline(state.timeline, event),
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
    quotaPool?: string;
    billingMode?: RunBillingMode;
    usage?: RunTokenUsage;
    cost?: RunCostSummary;
    turnsCount?: number;
    toolCallsCount?: number;
    toolErrorCount?: number;
    compactionCount?: number;
    peakContextTokens?: number;
    contextWindow?: number;
    llmDurationMs?: number;
    toolDurationMs?: number;
    ttftMs?: number;
    specChanged?: boolean;
    specHashAfter?: string;
    codeChanged?: boolean;
    noCodeChange?: boolean;
    wipCommitHash?: string;
    tracePath?: string;
    contextPath?: string;
    traceTruncated?: boolean;
    healthWarnings?: string[];
  },
  rawLog: string,
  currentCodeSnapshotHash?: string | null,
): Promise<RequirementDetail> {
  const bundle = await mutateRequirement(root, id, undefined, (current, now) => {
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
      ...(patch.quotaPool ? { quotaPool: patch.quotaPool } : {}),
      ...(patch.billingMode ? { billingMode: patch.billingMode } : {}),
      ...(patch.usage ? { usage: patch.usage } : {}),
      ...(patch.cost ? { cost: patch.cost } : {}),
      ...(patch.turnsCount !== undefined ? { turnsCount: patch.turnsCount } : {}),
      ...(patch.toolCallsCount !== undefined ? { toolCallsCount: patch.toolCallsCount } : {}),
      ...(patch.toolErrorCount !== undefined ? { toolErrorCount: patch.toolErrorCount } : {}),
      ...(patch.compactionCount !== undefined ? { compactionCount: patch.compactionCount } : {}),
      ...(patch.peakContextTokens !== undefined ? { peakContextTokens: patch.peakContextTokens } : {}),
      ...(patch.contextWindow !== undefined ? { contextWindow: patch.contextWindow } : {}),
      ...(patch.llmDurationMs !== undefined ? { llmDurationMs: patch.llmDurationMs } : {}),
      ...(patch.toolDurationMs !== undefined ? { toolDurationMs: patch.toolDurationMs } : {}),
      ...(patch.ttftMs !== undefined ? { ttftMs: patch.ttftMs } : {}),
      ...(patch.specChanged !== undefined ? { specChanged: patch.specChanged } : {}),
      ...(patch.specHashAfter ? { specHashAfter: patch.specHashAfter } : {}),
      ...(patch.codeChanged !== undefined ? { codeChanged: patch.codeChanged } : {}),
      ...(patch.noCodeChange !== undefined ? { noCodeChange: patch.noCodeChange } : {}),
      ...(patch.wipCommitHash ? { wipCommitHash: patch.wipCommitHash } : {}),
      ...(patch.tracePath ? { tracePath: patch.tracePath } : {}),
      ...(patch.contextPath ? { contextPath: patch.contextPath } : {}),
      ...(patch.traceTruncated !== undefined ? { traceTruncated: patch.traceTruncated } : {}),
      ...(patch.healthWarnings?.length ? { healthWarnings: patch.healthWarnings.slice(0, 20) } : {}),
    });
    const nextRuns = prevRuns.map((r) => (r.id === runId ? updated : r)).slice(-MAX_AGENT_RUNS);
    const statusText = patch.status === "succeeded" ? "完成" : patch.status === "cancelled" ? "已终止" : "失败";
    const secText = `${(patch.durationMs / 1000).toFixed(1)}s`;
    const tokText = patch.usage?.totalTokens ? ` · ${patch.usage.totalTokens.toLocaleString()} tokens` : "";
    const toolText = patch.toolCallsCount ? ` · ${patch.toolCallsCount} 次工具` : "";
    const finishEvent = makeEvent(
      now,
      "agent_run_finished",
      "agent",
      `Agent 运行${statusText} [${updated.action}]：${updated.harness}/${updated.effectiveModel ?? updated.model}（${secText}${tokText}${toolText}）`,
      patch.errorSummary,
      runId,
    );
    return {
      runWrite: { record: updated, rawLog },
      state: {
        ...state,
        agentRuns: nextRuns,
        timeline: appendTimeline(state.timeline, finishEvent),
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
    reviewedCommit?: string;
    reviewerSessionId?: string;
  },
): Promise<RequirementDetail> {
  if (!REVIEW_VERDICTS.includes(input.verdict)) {
    throw new WorkbenchError("invalid_input", `无效的审查结论: ${String(input.verdict)}`);
  }
  const cleanFindings =
    Array.isArray(input.findings) && input.findings.length > 0
      ? input.findings.slice(0, 50).map((f, idx) => ({
          id: typeof f.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(f.id) ? f.id : `F-${idx + 1}`,
          severity: f.severity === "high" || f.severity === "medium" || f.severity === "low" ? f.severity : "medium",
          title: sanitizeOutput(String(f.title ?? "").trim(), 380).text.trim() || `问题 ${idx + 1}`,
          ...(typeof f.detail === "string" && f.detail.trim()
            ? { detail: sanitizeOutput(f.detail.trim(), 1800).text.trim() }
            : {}),
          ...(Array.isArray(f.criterionIds) && f.criterionIds.length > 0
            ? {
                criterionIds: f.criterionIds
                  .filter((c): c is string => typeof c === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(c))
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
  const safeSummary = sanitizeOutput(input.summary.trim(), 1800).text.trim() || "已完成独立代码审查";
  const safeMarkdown = sanitizeOutput(input.markdown.trim(), 60 * 1024).text.trim() || safeSummary;
  const bundle = await mutateRequirement(root, id, undefined, (current, now) => {
    const { state } = current;
    const report: ReviewReport = {
      id: `REV-${now}-${randomUUID().slice(0, 6)}`,
      reviewerHarness: input.reviewerHarness.trim(),
      reviewerModel: input.reviewerModel.trim(),
      verdict: input.verdict,
      summary: safeSummary,
      markdown: safeMarkdown,
      ...(cleanFindings && cleanFindings.length > 0 ? { findings: cleanFindings } : {}),
      reviewedSpecHash: input.reviewedSpecHash,
      reviewedCodeSnapshotHash: input.reviewedCodeSnapshotHash,
      ...(input.reviewedCommit && /^[0-9a-f]{7,64}$/i.test(input.reviewedCommit.trim())
        ? { reviewedCommit: input.reviewedCommit.trim() }
        : {}),
      ...(input.reviewerSessionId?.trim()
        ? { reviewerSessionId: input.reviewerSessionId.trim().slice(0, 256) }
        : {}),
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

/**
 * WB-22 / FLOW §1.3: records an independent heterogeneous design review report bound to specHash + designHash.
 * Strictly isolated from coding `reviewReport` and never mutates approval or stage.
 */
export async function recordDesignReviewReport(
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
    reviewedDesignHash: string;
    currentCodeSnapshotHash?: string | null;
  },
): Promise<RequirementDetail> {
  if (!REVIEW_VERDICTS.includes(input.verdict)) {
    throw new WorkbenchError("invalid_input", `无效的方案评审结论: ${String(input.verdict)}`);
  }
  const cleanFindings =
    Array.isArray(input.findings) && input.findings.length > 0
      ? input.findings.slice(0, 50).map((f, idx) => ({
          id: typeof f.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(f.id) ? f.id : `DF-${idx + 1}`,
          severity: f.severity === "high" || f.severity === "medium" || f.severity === "low" ? f.severity : "medium",
          title: sanitizeOutput(String(f.title ?? "").trim(), 380).text.trim() || `方案建议 ${idx + 1}`,
          ...(typeof f.detail === "string" && f.detail.trim()
            ? { detail: sanitizeOutput(f.detail.trim(), 1800).text.trim() }
            : {}),
          ...(Array.isArray(f.criterionIds) && f.criterionIds.length > 0
            ? {
                criterionIds: f.criterionIds
                  .filter((c): c is string => typeof c === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(c))
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

  const safeSummary = sanitizeOutput(input.summary.trim(), 1800).text.trim() || "已完成独立方案评审";
  const safeMarkdown = sanitizeOutput(input.markdown.trim(), 60 * 1024).text.trim() || safeSummary;
  const bundle = await mutateRequirement(root, id, undefined, (current, now) => {
    const { state } = current;
    const report: DesignReviewReport = {
      id: `DREV-${now}-${randomUUID().slice(0, 6)}`,
      reviewerHarness: input.reviewerHarness.trim(),
      reviewerModel: input.reviewerModel.trim(),
      verdict: input.verdict,
      summary: safeSummary,
      markdown: safeMarkdown,
      ...(cleanFindings && cleanFindings.length > 0 ? { findings: cleanFindings } : {}),
      reviewedSpecHash: input.reviewedSpecHash,
      reviewedDesignHash: input.reviewedDesignHash,
      reviewedAt: now,
    };
    const verdictLabel = input.verdict === "pass" ? "方案通过" : input.verdict === "concern" ? "有关注点" : "建议修改方案";
    return {
      state: {
        ...state,
        designReviewReport: report,
        timeline: appendTimeline(
          state.timeline,
          makeEvent(
            now,
            "design_review_submitted",
            "agent",
            `异构方案评审 [${report.reviewerHarness}/${report.reviewerModel}]：${verdictLabel}`,
            report.summary,
          ),
        ),
      },
    };
  });
  return toDetail(bundle, input.currentCodeSnapshotHash ?? null);
}

const PLAYBOOK_REL_PATH = `${WORKBENCH_DIR}/playbook.md`;
const PLAYBOOK_MAX_BYTES = 16 * 1024;
const PLAYBOOK_HEADER = "# 项目经验法则（Project Playbook）\n\n> 由人工在打回修改、验收备注或审查解决时沉淀，后续 Agent 调度自动读取生效。\n";

export type PlaybookLessonSource = "reject" | "accept" | "review_block" | "manual";

/** WB-24 / FLOW §4.4: reads project-local `.workbench/playbook.md` without touching business code or Git. */
export function readProjectPlaybook(root: string): { markdown: string; lessons: string[]; path: string } {
  const base = canonicalRoot(root);
  const fullPath = resolveSafePath(base, PLAYBOOK_REL_PATH);
  if (!fs.existsSync(fullPath)) {
    return { markdown: "", lessons: [], path: PLAYBOOK_REL_PATH };
  }
  try {
    const raw = fs.readFileSync(fullPath, "utf8");
    const markdown = sanitizeOutput(raw, PLAYBOOK_MAX_BYTES).text;
    const lessons = markdown
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^-\s+/.test(l))
      .map((l) => l.replace(/^-\s+/, "").trim())
      .filter(Boolean);
    return { markdown, lessons, path: PLAYBOOK_REL_PATH };
  } catch {
    return { markdown: "", lessons: [], path: PLAYBOOK_REL_PATH };
  }
}

/**
 * WB-24 / FLOW §4.4: appends one concise project lesson to `.workbench/playbook.md`
 * atomically under the project lock. Never modifies source files, Git index, or code snapshot hashes.
 */
export async function appendProjectPlaybookLesson(
  root: string,
  input: {
    lesson: string;
    source?: PlaybookLessonSource;
    requirementId?: string;
  },
): Promise<{ added: boolean; line: string; totalLessons: number; markdown: string; path: string }> {
  const base = canonicalRoot(root);
  if (!isProjectInitialized(base)) {
    throw new WorkbenchError("not_initialized", "项目尚未初始化 .workbench/，无法记录经验法则");
  }
  const singleLine = sanitizeOutput(input.lesson.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim(), 480).text.trim();
  if (!singleLine) {
    throw new WorkbenchError("invalid_input", "项目经验内容不能为空");
  }
  const sourceTag =
    input.source === "reject"
      ? "打回沉淀"
      : input.source === "accept"
        ? "验收沉淀"
        : input.source === "review_block"
          ? "审查沉淀"
          : "工程规范";
  const reqIdClean = input.requirementId?.trim();
  const reqSuffix = reqIdClean ? ` (${assertRequirementId(reqIdClean)})` : "";
  const formatted = `- [${sourceTag}] ${singleLine}${reqSuffix}`;
  const normalizedNeedle = singleLine.toLowerCase();

  return withProjectWriteLock(base, () => {
    const fullPath = resolveSafePath(base, PLAYBOOK_REL_PATH);
    const existingRaw = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf8") : "";
    const existingBullets = existingRaw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^-\s+/.test(l));

    const alreadyExists = existingBullets.some((b) =>
      b
        .replace(/^-\s+(?:\[[^\]]+\]\s*)?/, "")
        .replace(/\s*\(REQ-\d+\)\s*$/i, "")
        .trim()
        .toLowerCase() === normalizedNeedle,
    );
    if (alreadyExists) {
      const currentMd = existingRaw.trim() ? existingRaw : `${PLAYBOOK_HEADER}\n${existingBullets.join("\n")}\n`;
      return {
        added: false,
        line: formatted,
        totalLessons: existingBullets.length,
        markdown: currentMd,
        path: PLAYBOOK_REL_PATH,
      };
    }

    const nextBullets = [...existingBullets, formatted];
    // Trim oldest entries first if exceeding 16KB cap so newest lessons always survive.
    let nextMarkdown = `${PLAYBOOK_HEADER}\n${nextBullets.join("\n")}\n`;
    while (nextBullets.length > 1 && Buffer.byteLength(nextMarkdown, "utf8") > PLAYBOOK_MAX_BYTES) {
      nextBullets.shift();
      nextMarkdown = `${PLAYBOOK_HEADER}\n${nextBullets.join("\n")}\n`;
    }
    atomicWriteFile(fullPath, nextMarkdown);
    return {
      added: true,
      line: formatted,
      totalLessons: nextBullets.length,
      markdown: nextMarkdown,
      path: PLAYBOOK_REL_PATH,
    };
  });
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
    eventKind?: TimelineEventKind;
    summary?: string;
    currentCodeSnapshotHash?: string | null;
  },
): Promise<RequirementDetail> {
  const bundle = await mutateRequirement(root, id, undefined, (current, now) => {
    const { state } = current;
    if (state.stage === "cancelled" || (state.stage === "done" && !input.preserveStage)) {
      throw new WorkbenchError("invalid_transition", `终态需求（${state.stage}）不能刷新基线`);
    }
    return {
      state: {
        ...state,
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
            input.eventKind ?? "sandbox_synced",
            "system",
            input.summary ?? `已同步主干基线至 ${input.baselineHead.slice(0, 7)}（需在新基线上复跑验证）`,
          ),
        ),
      },
    };
  });
  return toDetail(bundle, input.currentCodeSnapshotHash ?? input.baselineFingerprint);
}

/**
 * Transitions an approved requirement from `done` to `coding`
 * specifically for sandbox conflict resolution without invalidating `approval` or polluting `lastFeedback`.
 */
export async function prepareRequirementForConflictSync(
  root: string,
  id: string,
  input: { summary?: string; currentCodeSnapshotHash?: string | null } = {},
): Promise<RequirementDetail> {
  const bundle = await mutateRequirement(root, id, undefined, (current, now) => {
    const { state } = current;
    if (state.stage === "coding") {
      return { state };
    }
    if (state.stage !== "done") {
      throw new WorkbenchError(
        "invalid_transition",
        `当前阶段（${state.stage}）不能直接进入主干同步消解冲突，请先批准方案`,
      );
    }
    if (!evaluateApproval(state).valid) {
      throw new WorkbenchError("approval_required", `${id} 尚未获得有效方案批准，请先批准方案`);
    }
    return {
      state: {
        ...state,
        stage: "coding",
        acceptance: null,
        delivery: null,
        timeline: appendTimeline(
          state.timeline,
          makeEvent(
            now,
            "sandbox_synced",
            "system",
            input.summary ?? "因主干代码存在合并冲突，已轻量退回编码阶段消解冲突（保留既有方案批准）",
          ),
        ),
      },
    };
  });
  return toDetail(bundle, input.currentCodeSnapshotHash ?? null);
}
