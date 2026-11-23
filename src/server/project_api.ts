import * as fs from "node:fs";
import * as path from "node:path";
import {
  acceptRequirement,
  addDiscussion,
  addRequirementAttachments,
  approveDesign,
  authorizeFastTrack,
  blockRequirement,
  cancelRequirement,
  createRequirement,
  deliverRequirement,
  getAgentRunContext,
  getAgentRunDetail,
  getAgentRunTrace,
  getDesignHistoryVersion,
  getProjectStatus,
  getRequirement,
  getRequirementDeliveryPreview,
  getRequirementDiff,
  getVerificationEvidence,
  initProject,
  linkRequirementGitHubIssue,
  listRequirementAgentRuns,
  listRequirements,
  markDesigning,
  pruneProjectTraces,
  recordRequirementGitHubSync,
  removeRequirementAttachment,
  reopenRequirement,
  requestChanges,
  resolveDiscussions,
  spawnSubRequirements,
  unblockRequirement,
  updateDesign,
  updateProjectConfig,
  updateSpec,
  updateTasks,
  type CorruptRequirementEntry,
  type SpawnSubRequirementItem,
} from "../core/engine.ts";
import { discoverProjectContext } from "../core/context.ts";
import { resolveSafePath } from "../core/fs.ts";
import {
  normalizeAttachments,
  readAttachmentForServe,
  requirementAttachmentsDir,
} from "../core/attachments.ts";
import { extractMessageRef, WorkbenchError, type StructuredMessageRef, type WorkbenchErrorCode } from "../core/errors.ts";
import { getGitRemoteUrl, observeGitSnapshot, resolveProjectRequirementSnapshots } from "../core/git.ts";
import {
  detectGitRemoteProvider,
  extractGiteeOwner,
  inspectGiteeEnvironment,
  listGiteeMyIssues,
  parseGiteeRepoFromRemoteUrl,
  viewGiteeIssue,
  viewGiteePr,
  type GiteeApiDeps,
  type GiteeIssueItem,
} from "../core/gitee.ts";
import {
  buildGitHubReasonMessageDetails,
  buildRequirementIssueBody,
  commentOnGitHubIssue,
  createGitHubIssue,
  inspectGitHubEnvironment,
  parseGitHubRepoFromRemoteUrl,
  setGitHubIssueState,
  viewGitHubIssue,
  viewGitHubPr,
  type GitHubCommandDeps,
} from "../core/github.ts";
import { normalizeOutputLanguage, resolveEffectiveOutputLanguage } from "../core/language.ts";
import { distillRequirementToPlaybook, readPlaybook, writePlaybook } from "../core/playbook.ts";
import { runAllVerifications, runVerification } from "../core/runner.ts";
import { getSandboxForRequirement, listProjectSandboxes, resolveCodeRoot } from "../core/sandbox.ts";
import { captureRequirementScreenshots } from "../core/screenshots.ts";
import { isProjectInitialized, readRequirementScreenshot } from "../core/store.ts";
import {
  AGENT_ACTIONS,
  WORKBENCH_DIR,
  type AgentAction,
  type AgentRunRecord,
  type CriterionInput,
  type OutputLanguage,
  type ProjectGiteeConfig,
  type ProjectGitHubConfig,
  type ProjectVerificationConfig,
  type RequirementDetail,
  type Stage,
  type TaskInput,
  type Track,
} from "../core/types.ts";
import { isRecord, sanitizeOutput, validateGiteeIssueIdent } from "../core/validate.ts";
import {
  applySandboxToMain,
  createOrReuseWorktree,
  inspectRsiSandboxDrift,
  prepareSandboxConflictResolution,
  recommendSandboxMergeOrder,
  reconcileRsiSandboxBaseline,
  syncRequirementMirrorToSandbox,
  syncRsiSandboxBase,
  syncRsiSandboxPrAndCleanup,
} from "../hub/evolution.ts";
import type { HubExecutor } from "../hub/executor.ts";
import { synthesizeHandoffPacket } from "../hub/handoff.ts";
import { enrichAgentRunRecord } from "../hub/pricing.ts";
import { readHubConfig } from "../hub/registry.ts";
import { REASONING_EFFORTS, type ReasoningEffort } from "../hub/types.ts";
import { buildAgentPrompt, type DispatchAction } from "./prompts.ts";

export interface BridgeStatus {
  connected: boolean;
  agent: string | null;
  sessionId: string | null;
  state: "idle" | "working" | "waiting_user" | "offline";
  model: string | null;
  updatedAt: number;
}

export interface DispatchOutcome {
  delivered: boolean;
  status: "submitted" | "prefilled" | "rejected" | "offline";
  reason?: string;
  prompt: string;
}

export interface LocalProjectSnapshot {
  initialized: boolean;
  isGitRepo: boolean;
  activeCount: number;
  decisionCount: number;
  runningCount: number;
}

export function httpStatusForError(code: WorkbenchErrorCode): number {
  switch (code) {
    case "not_initialized":
    case "invalid_input":
    case "invalid_path":
    case "symlink_not_allowed":
      return 400;
    case "payload_too_large":
      return 413;
    case "not_found":
      return 404;
    case "already_initialized":
    case "revision_conflict":
    case "invalid_transition":
    case "approval_required":
    case "acceptance_gate_failed":
    case "lock_timeout":
      return 409;
    case "corrupt_record":
    case "unsupported_schema":
    case "execution_failed":
      return 500;
  }
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export function readStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((v): v is string => typeof v === "string");
}

export async function readBody(req: Request): Promise<Record<string, unknown>> {
  let text = "";
  try {
    text = await req.text();
  } catch {
    throw new WorkbenchError("invalid_input", "无法读取请求体");
  }
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WorkbenchError("invalid_input", "请求体必须是合法 JSON");
  }
  if (!isRecord(parsed)) {
    throw new WorkbenchError("invalid_input", "请求体必须是 JSON 对象");
  }
  return parsed;
}

/** Collects active/decision/running counts for a single local project root. */
export async function buildLocalProjectSnapshot(
  projectRoot: string,
  executor: HubExecutor,
): Promise<LocalProjectSnapshot> {
  const status = getProjectStatus(projectRoot);
  const isGitRepo = fs.existsSync(path.join(projectRoot, ".git"));
  const activeRuns = executor.getActiveRuns(projectRoot);
  let activeCount = 0;
  let decisionCount = 0;
  if (status.initialized) {
    try {
      const { baseSnapshot: snap, byReqId } = await resolveProjectRequirementSnapshots(projectRoot);
      const items = listRequirements(projectRoot, {
        scope: "active",
        currentCodeSnapshotHash: snap?.fingerprint ?? null,
        codeSnapshotsById: byReqId,
        onCorrupt: (corrupt) => {
          console.warn(`[workbench] 跳过损坏需求 ${projectRoot}/${corrupt.id}: ${corrupt.message}`);
        },
      });
      activeCount = items.length;
      const processingIds = new Set(
        activeRuns
          .filter((run) => run.status === "running" && run.action !== "ask")
          .map((run) => run.requirementId),
      );
      decisionCount = items.filter((i) => i.needsDecision && !processingIds.has(i.id)).length;
    } catch (error) {
      console.warn(
        `[workbench] 读取项目快照失败 ${projectRoot}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const runningCount = activeRuns.length;
  return {
    initialized: status.initialized,
    isGitRepo,
    activeCount,
    decisionCount,
    runningCount,
  };
}

export interface ProjectApiDeps {
  executor: HubExecutor;
  getBridgeStatus: () => BridgeStatus;
  dispatchToBridge: (
    requirementId: string,
    action: DispatchAction,
    mode: "send" | "prefill",
    prompt: string,
  ) => Promise<DispatchOutcome>;
  broadcastUi: (event: Record<string, unknown>) => void;
  ensureWatcherFor: (projectRoot: string) => void;
  reloadWebBundle: (opts?: { manual?: boolean }) => Promise<{ reloaded: boolean }>;
  getHubOutputLanguage: () => OutputLanguage | undefined;
  getGiteeAccessToken?: () => string | null;
  githubDeps?: GitHubCommandDeps;
  giteeDeps?: GiteeApiDeps;
}

/**
 * Creates a reusable handler for all project-scoped Workbench API routes.
 * Shared identically by the Hub server (local projects) and `wb node` (remote projects).
 */
export function createProjectApiHandler(deps: ProjectApiDeps) {
  const resolveOutputLang = (projectRoot: string, detail?: RequirementDetail) => {
    const projectMeta = getProjectStatus(projectRoot).project;
    return resolveEffectiveOutputLanguage({
      projectLanguage: projectMeta?.outputLanguage,
      hubLanguage: deps.getHubOutputLanguage(),
      contextText: detail ? `${detail.state.title}\n${detail.specMarkdown}` : undefined,
    });
  };

  const tryCreateAndLinkIssue = async (
    projectRoot: string,
    detail: RequirementDetail,
    snapHash: string | null,
    labels?: string[],
  ): Promise<{ detail: RequirementDetail; warning?: string; warningRef?: StructuredMessageRef }> => {
    try {
      const projectMeta = getProjectStatus(projectRoot).project;
      const ghEnv = await inspectGitHubEnvironment(projectRoot, projectMeta?.github, deps.githubDeps);
      if (!ghEnv.ready || !ghEnv.repo) {
        const msgDetails = buildGitHubReasonMessageDetails(ghEnv);
        return {
          detail,
          warning: ghEnv.reason ?? "GitHub 环境未就绪，已跳过同步创建 Issue",
          warningRef: { key: msgDetails.messageKey },
        };
      }
      const issue = await createGitHubIssue(
        {
          root: projectRoot,
          repo: ghEnv.repo,
          title: `[${detail.state.id}] ${detail.state.title}`,
          body: buildRequirementIssueBody(detail),
          labels,
        },
        deps.githubDeps,
      );
      const updated = await linkRequirementGitHubIssue(projectRoot, detail.state.id, {
        repo: ghEnv.repo,
        issue,
        currentCodeSnapshotHash: snapHash,
      });
      return { detail: updated };
    } catch (err) {
      const warningRef = extractMessageRef(err) ?? undefined;
      return {
        detail,
        warning: err instanceof Error ? err.message : String(err),
        ...(warningRef ? { warningRef } : {}),
      };
    }
  };

  const resolveGiteeToken = (): string | null => {
    const raw = deps.getGiteeAccessToken?.() ?? deps.giteeDeps?.token ?? process.env.GITEE_ACCESS_TOKEN ?? "";
    const trimmed = raw.trim();
    return trimmed || null;
  };

  const resolveRemoteUrl = async (projectRoot: string): Promise<string | null> => {
    if (deps.giteeDeps?.getRemoteUrl) return deps.giteeDeps.getRemoteUrl(projectRoot);
    if (deps.githubDeps?.getRemoteUrl) return deps.githubDeps.getRemoteUrl(projectRoot);
    return getGitRemoteUrl(projectRoot);
  };

  const trySyncIssueMilestone = async (
    projectRoot: string,
    detail: RequirementDetail,
    comment: string,
    opts?: { state?: "open" | "closed"; snapHash?: string | null },
  ): Promise<{ detail: RequirementDetail; warning?: string; warningRef?: StructuredMessageRef }> => {
    if (detail.state.github?.provider === "gitee") return { detail };
    const linked = detail.state.github?.issue;
    const repo = detail.state.github?.repo;
    if (!linked || !repo || typeof linked.number !== "number") return { detail };
    try {
      if (opts?.state && opts.state !== linked.state) {
        await setGitHubIssueState(
          { root: projectRoot, repo, issueNumber: linked.number, state: opts.state, comment },
          deps.githubDeps,
        );
      } else {
        await commentOnGitHubIssue(
          { root: projectRoot, repo, issueNumber: linked.number, body: comment },
          deps.githubDeps,
        );
      }
      const updated = await recordRequirementGitHubSync(projectRoot, detail.state.id, {
        issuePatch: {
          ...(opts?.state ? { state: opts.state } : {}),
          lastSyncedStage: detail.state.stage,
        },
        eventKind: "github_issue_synced",
        summary: `已同步阶段 [${detail.state.stage}] 至 GitHub Issue #${linked.number}`,
        currentCodeSnapshotHash: opts?.snapHash ?? null,
      });
      return { detail: updated };
    } catch (err) {
      const warningRef = extractMessageRef(err) ?? undefined;
      return {
        detail,
        warning: err instanceof Error ? err.message : String(err),
        ...(warningRef ? { warningRef } : {}),
      };
    }
  };

  return async function handleProjectApi(req: Request, url: URL, base: string): Promise<Response | null> {
    const pathname = url.pathname;
    const method = req.method.toUpperCase();
    const bridgeStatus = deps.getBridgeStatus();

    if (method === "GET" && pathname === "/api/project") {
      const status = getProjectStatus(base);
      const git = await observeGitSnapshot(base);
      const remoteUrl = git ? await resolveRemoteUrl(base) : null;
      const remoteProvider =
        status.project?.gitee?.repo || status.project?.gitee?.enterprise
          ? "gitee"
          : status.project?.github?.repo
            ? "github"
            : detectGitRemoteProvider(remoteUrl) ?? (status.project?.gitee ? "gitee" : null);
      const remoteRepo =
        remoteProvider === "gitee"
          ? (status.project?.gitee?.repo ?? parseGiteeRepoFromRemoteUrl(remoteUrl))
          : remoteProvider === "github"
            ? (status.project?.github?.repo ?? parseGitHubRepoFromRemoteUrl(remoteUrl))
            : null;
      const effectiveOutputLanguage = resolveEffectiveOutputLanguage({
        projectLanguage: status.project?.outputLanguage,
        hubLanguage: deps.getHubOutputLanguage(),
      });
      return jsonResponse({
        ...status,
        root: base,
        bridge: bridgeStatus,
        effectiveOutputLanguage,
        remoteProvider,
        remoteRepo,
        context: discoverProjectContext(base, status.project),
        git: git ? { isGitRepo: true, head: git.head, dirty: git.dirty, fingerprint: git.fingerprint } : { isGitRepo: false },
      });
    }

    if (method === "PATCH" && pathname === "/api/project/settings") {
      const body = await readBody(req);
      let outputLanguagePatch: OutputLanguage | null | undefined = undefined;
      if (body.outputLanguage === null || body.outputLanguage === "inherit") {
        outputLanguagePatch = null;
      } else if (body.outputLanguage !== undefined) {
        const valid = normalizeOutputLanguage(body.outputLanguage);
        if (!valid) {
          throw new WorkbenchError("invalid_input", `不支持的输出语言: ${String(body.outputLanguage)}`);
        }
        outputLanguagePatch = valid;
      }
      let githubPatch: ProjectGitHubConfig | null | undefined = undefined;
      if (body.github === null) {
        githubPatch = null;
      } else if (isRecord(body.github)) {
        githubPatch = {
          ...(typeof body.github.repo === "string" ? { repo: body.github.repo } : {}),
          ...(typeof body.github.defaultBaseBranch === "string"
            ? { defaultBaseBranch: body.github.defaultBaseBranch }
            : {}),
          ...(typeof body.github.autoCreateIssue === "boolean"
            ? { autoCreateIssue: body.github.autoCreateIssue }
            : {}),
          ...(typeof body.github.autoSyncIssue === "boolean"
            ? { autoSyncIssue: body.github.autoSyncIssue }
            : {}),
        };
      }
      let giteePatch: ProjectGiteeConfig | null | undefined = undefined;
      if (body.gitee === null) {
        giteePatch = null;
      } else if (isRecord(body.gitee)) {
        giteePatch = {
          ...(typeof body.gitee.repo === "string" ? { repo: body.gitee.repo } : {}),
          ...(typeof body.gitee.enterprise === "string" ? { enterprise: body.gitee.enterprise } : {}),
          ...(typeof body.gitee.defaultBaseBranch === "string"
            ? { defaultBaseBranch: body.gitee.defaultBaseBranch }
            : {}),
        };
      }
      let verificationPatch: ProjectVerificationConfig | null | undefined = undefined;
      if (body.verification === null) {
        verificationPatch = null;
      } else if (isRecord(body.verification)) {
        verificationPatch = {
          ...(typeof body.verification.fastCommand === "string" ? { fastCommand: body.verification.fastCommand } : {}),
          ...(typeof body.verification.fullCommand === "string" ? { fullCommand: body.verification.fullCommand } : {}),
          ...(typeof body.verification.autoScreenshots === "boolean"
            ? { autoScreenshots: body.verification.autoScreenshots }
            : {}),
        };
      }
      const project = await updateProjectConfig(base, {
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(outputLanguagePatch !== undefined ? { outputLanguage: outputLanguagePatch } : {}),
        ...(githubPatch !== undefined ? { github: githubPatch } : {}),
        ...(giteePatch !== undefined ? { gitee: giteePatch } : {}),
        ...(verificationPatch !== undefined ? { verification: verificationPatch } : {}),
      });
      deps.broadcastUi({ type: "workbench.updated", reason: "project.settings", root: base, at: Date.now() });
      return jsonResponse({ project });
    }

    if (method === "GET" && pathname === "/api/project/sandboxes") {
      if (!isProjectInitialized(base)) {
        return jsonResponse({ sandboxes: [], mergeOrder: null });
      }
      const fetchRemote = url.searchParams.get("fetch") === "1";
      const mergeOrder = await recommendSandboxMergeOrder(base, { fetchRemote }).catch(() => null);
      const sandboxes = await Promise.all(
        listProjectSandboxes(base).map(async (sb) => {
          const drift = await inspectRsiSandboxDrift(base, sb.requirementId, {
            includeSiblings: true,
            fetchRemote: false,
          }).catch(() => null);
          let detail: RequirementDetail | null = null;
          try {
            detail = getRequirement(base, sb.requirementId);
          } catch {
            detail = null;
          }
          return {
            ...sb,
            stage: detail?.state.stage ?? null,
            title: detail?.state.title ?? sb.requirementId,
            canApply: Boolean(detail && detail.state.stage === "done" && detail.state.acceptance !== null),
            github: detail?.state.github ?? null,
            ...(drift ? { drift } : {}),
          };
        }),
      );
      return jsonResponse({ sandboxes, mergeOrder });
    }

    if (method === "POST" && pathname === "/api/project/runs/prune") {
      if (!isProjectInitialized(base)) {
        return jsonResponse({ result: { deletedFiles: 0, freedBytes: 0, scannedRuns: 0 } });
      }
      const body = await readBody(req);
      const retentionDays =
        typeof body.retentionDays === "number" && Number.isFinite(body.retentionDays)
          ? Math.max(0, Math.floor(body.retentionDays))
          : 30;
      const activeRunIds = new Set(deps.executor.getActiveRuns(base).map((r) => r.id));
      const result = pruneProjectTraces(base, retentionDays, activeRunIds);
      deps.broadcastUi({ type: "workbench.updated", reason: "runs.pruned", root: base, at: Date.now() });
      return jsonResponse({ result });
    }

    if (method === "GET" && pathname === "/api/github/status") {
      const status = getProjectStatus(base);
      const envStatus = await inspectGitHubEnvironment(base, status.project?.github, deps.githubDeps);
      return jsonResponse(envStatus);
    }

    if (method === "GET" && pathname === "/api/gitee/status") {
      const status = getProjectStatus(base);
      const envStatus = await inspectGiteeEnvironment(base, status.project?.gitee, resolveGiteeToken(), deps.giteeDeps);
      return jsonResponse(envStatus);
    }

    if (method === "GET" && pathname === "/api/gitee/issues") {
      const token = resolveGiteeToken();
      if (!token) {
        throw new WorkbenchError("invalid_input", "尚未配置 Gitee 私人令牌 (Access Token)，请先在「工作台设置 -> 全局设置」中填写", {
          messageKey: "gitee.reasonTokenMissing",
        });
      }
      const status = getProjectStatus(base);
      const remoteRepo = status.project?.gitee?.repo ?? parseGiteeRepoFromRemoteUrl(await resolveRemoteUrl(base));
      const enterprise =
        url.searchParams.get("enterprise")?.trim() ||
        status.project?.gitee?.enterprise ||
        extractGiteeOwner(remoteRepo);
      const rawFilter = url.searchParams.get("filter");
      const filter =
        rawFilter === "created" || rawFilter === "all" ? rawFilter : "assigned";
      const rawState = url.searchParams.get("state");
      const state =
        rawState === "open" || rawState === "progressing" || rawState === "closed" || rawState === "all"
          ? rawState
          : "active";
      const search = url.searchParams.get("q") ?? undefined;
      const result = await listGiteeMyIssues(
        { token, enterprise, filter, state, search },
        deps.giteeDeps,
      );
      const existingReqs = isProjectInitialized(base)
        ? listRequirements(base, { scope: "all" })
        : [];
      const importedByIdent = new Map<string, string>();
      for (const reqItem of existingReqs) {
        const num = reqItem.github?.issue?.number;
        if (typeof num === "string" && num.trim()) {
          importedByIdent.set(num.trim().toUpperCase(), reqItem.id);
        }
      }
      return jsonResponse({
        account: result.account,
        enterprise: result.enterprise,
        items: result.items.map((item) => ({
          ...item,
          importedRequirementId: importedByIdent.get(item.ident.toUpperCase()) ?? null,
        })),
      });
    }

    if (method === "GET" && pathname === "/api/project/playbook") {
      return jsonResponse(readPlaybook(base));
    }

    if (method === "PUT" && pathname === "/api/project/playbook") {
      const body = await readBody(req);
      const markdown = typeof body.markdown === "string" ? body.markdown : "";
      const saved = await writePlaybook(base, markdown);
      deps.broadcastUi({ type: "workbench.updated", reason: "playbook.updated", root: base, at: Date.now() });
      return jsonResponse({ exists: true, ...saved });
    }

    if (method === "POST" && pathname === "/api/project/playbook/distill") {
      const body = await readBody(req);
      const reqId = typeof body.requirementId === "string" ? body.requirementId : null;
      const { baseSnapshot: snapshot, byReqId } = await resolveProjectRequirementSnapshots(base);
      let addedTotal = 0;
      if (reqId) {
        const snap = await observeGitSnapshot(resolveCodeRoot(base, reqId));
        const detail = getRequirement(base, reqId, { currentCodeSnapshotHash: snap?.fingerprint ?? null });
        const out = await distillRequirementToPlaybook(base, detail);
        addedTotal += out.added;
      } else {
        const summaries = listRequirements(base, {
          scope: "all",
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
          codeSnapshotsById: byReqId,
        });
        for (const item of summaries) {
          const itemHash = byReqId.has(item.id) ? (byReqId.get(item.id) ?? null) : (snapshot?.fingerprint ?? null);
          const detail = getRequirement(base, item.id, { currentCodeSnapshotHash: itemHash });
          const out = await distillRequirementToPlaybook(base, detail);
          addedTotal += out.added;
        }
      }
      deps.broadcastUi({ type: "workbench.updated", reason: "playbook.distilled", root: base, at: Date.now() });
      return jsonResponse({ added: addedTotal, ...readPlaybook(base) });
    }

    if (method === "POST" && pathname === "/api/project/init") {
      const body = await readBody(req);
      let outputLanguage: OutputLanguage | undefined;
      if (body.outputLanguage !== undefined && body.outputLanguage !== "inherit") {
        outputLanguage = normalizeOutputLanguage(body.outputLanguage);
        if (!outputLanguage) {
          throw new WorkbenchError("invalid_input", `不支持的输出语言: ${String(body.outputLanguage)}`);
        }
      }
      const project = await initProject(base, {
        name: typeof body.name === "string" ? body.name : undefined,
        privacyMode: body.privacyMode === "tracked" ? "tracked" : "local",
        ...(outputLanguage ? { outputLanguage } : {}),
      });
      deps.ensureWatcherFor(base);
      deps.broadcastUi({ type: "workbench.updated", reason: "project.init", root: base, at: Date.now() });
      return jsonResponse({ initialized: true, project }, 201);
    }

    if (method === "GET" && pathname === "/api/requirements") {
      const scope = (url.searchParams.get("scope") ?? "active") as "active" | "done" | "cancelled" | "all";
      const stageParam = url.searchParams.get("stage");
      const { baseSnapshot: snapshot, byReqId } = await resolveProjectRequirementSnapshots(base);
      const corruptItems: CorruptRequirementEntry[] = [];
      const items = listRequirements(base, {
        scope,
        stage: stageParam ? (stageParam as Stage) : undefined,
        currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        codeSnapshotsById: byReqId,
        onCorrupt: (corrupt) => {
          console.warn(`[workbench] 跳过损坏需求 ${base}/${corrupt.id}: ${corrupt.message}`);
          corruptItems.push(corrupt);
        },
      });
      return jsonResponse({
        items,
        ...(corruptItems.length > 0 ? { corruptItems } : {}),
        codeSnapshotHash: snapshot?.fingerprint ?? null,
        bridge: bridgeStatus,
      });
    }

    if (method === "POST" && pathname === "/api/requirements/import-issue") {
      const body = await readBody(req);
      const projectMeta = getProjectStatus(base).project;
      const remoteUrl = await resolveRemoteUrl(base);
      const detectedProvider =
        projectMeta?.gitee?.repo || projectMeta?.gitee?.enterprise
          ? "gitee"
          : projectMeta?.github?.repo
            ? "github"
            : detectGitRemoteProvider(remoteUrl);
      const rawIssueRef =
        typeof body.issueRef === "string" || typeof body.issueRef === "number" ? String(body.issueRef).trim() : "";
      const provider =
        body.provider === "gitee"
          ? "gitee"
          : body.provider === "github"
            ? "github"
            : /gitee\.com/i.test(rawIssueRef)
              ? "gitee"
              : (detectedProvider ?? "github");

      if (provider === "gitee") {
        const token = resolveGiteeToken();
        const remoteRepo = projectMeta?.gitee?.repo ?? parseGiteeRepoFromRemoteUrl(remoteUrl);
        const enterprise =
          (typeof body.enterprise === "string" && body.enterprise.trim()) ||
          projectMeta?.gitee?.enterprise ||
          extractGiteeOwner(remoteRepo);

        let giteeIssue: GiteeIssueItem;
        if (isRecord(body.giteeIssue) && typeof body.giteeIssue.ident === "string") {
          const ident = validateGiteeIssueIdent(body.giteeIssue.ident);
          const title = sanitizeOutput(String(body.giteeIssue.title ?? `工作项 #${ident}`), 360).text.trim();
          const urlStr =
            typeof body.giteeIssue.url === "string" && /^https?:\/\//i.test(body.giteeIssue.url)
              ? body.giteeIssue.url
              : enterprise
                ? `https://e.gitee.com/${enterprise}/issues/list?issue=${encodeURIComponent(ident)}`
                : "https://gitee.com";
          const rawState = String(body.giteeIssue.state ?? "open").toLowerCase();
          const state: GiteeIssueItem["state"] =
            rawState === "progressing"
              ? "progressing"
              : rawState === "closed"
                ? "closed"
                : rawState === "rejected"
                  ? "rejected"
                  : "open";
          giteeIssue = {
            ident,
            url: urlStr,
            title: title || `工作项 #${ident}`,
            body: sanitizeOutput(String(body.giteeIssue.body ?? ""), 64 * 1024).text.trim(),
            state,
            ...(typeof body.giteeIssue.stateName === "string" && body.giteeIssue.stateName.trim()
              ? { stateName: sanitizeOutput(body.giteeIssue.stateName, 60).text }
              : {}),
            ...(typeof body.giteeIssue.issueType === "string" && body.giteeIssue.issueType.trim()
              ? { issueType: sanitizeOutput(body.giteeIssue.issueType, 60).text }
              : {}),
            labels: Array.isArray(body.giteeIssue.labels)
              ? body.giteeIssue.labels.filter((l): l is string => typeof l === "string" && l.trim().length > 0)
              : [],
            repository: typeof body.giteeIssue.repository === "string" ? body.giteeIssue.repository : null,
            enterprise: typeof body.giteeIssue.enterprise === "string" ? body.giteeIssue.enterprise : enterprise,
            programName: typeof body.giteeIssue.programName === "string" ? body.giteeIssue.programName : null,
            updatedAt: typeof body.giteeIssue.updatedAt === "string" ? body.giteeIssue.updatedAt : new Date().toISOString(),
          };
        } else {
          if (!rawIssueRef) {
            throw new WorkbenchError("invalid_input", "请提供 Gitee 工作项编号或 URL", {
              messageKey: "gitee.errIssueRefRequired",
            });
          }
          if (!token) {
            throw new WorkbenchError(
              "invalid_input",
              "尚未配置 Gitee 私人令牌 (Access Token)，请先在「工作台设置 -> 全局设置」中填写",
              { messageKey: "gitee.reasonTokenMissing" },
            );
          }
          giteeIssue = await viewGiteeIssue(
            { token, issueRef: rawIssueRef, enterprise, repo: remoteRepo },
            deps.giteeDeps,
          );
        }

        const snapshot = await observeGitSnapshot(base);
        const existingList = listRequirements(base, {
          scope: "all",
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        const existingMatch = existingList.find(
          (item) =>
            typeof item.github?.issue?.number === "string" &&
            item.github.issue.number.toUpperCase() === giteeIssue.ident.toUpperCase(),
        );
        if (existingMatch) {
          const existingDetail = getRequirement(base, existingMatch.id, {
            currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
          });
          return jsonResponse(
            { detail: existingDetail, alreadyExisted: true, issue: giteeIssue, provider: "gitee" },
            200,
          );
        }

        const metaParts = [
          giteeIssue.issueType ? `类型：${giteeIssue.issueType}` : "",
          giteeIssue.stateName ? `状态：${giteeIssue.stateName}` : `状态：${giteeIssue.state}`,
          giteeIssue.programName ? `所属项目：${giteeIssue.programName}` : "",
          giteeIssue.repository ? `关联仓库：${giteeIssue.repository}` : "未绑定仓库",
        ].filter(Boolean);
        const goal = [
          `# ${giteeIssue.title}`,
          "",
          `> 导入自 Gitee 工作项: [#${giteeIssue.ident}](${giteeIssue.url})`,
          metaParts.length > 0 ? `> ${metaParts.join(" · ")}` : "",
          giteeIssue.labels.length > 0 ? `> 标签：${giteeIssue.labels.join(", ")}` : "",
          "",
          giteeIssue.body || giteeIssue.title,
        ]
          .filter(Boolean)
          .join("\n");

        let detail = await createRequirement(base, {
          goal,
          title: giteeIssue.title,
          track: body.track === "fast_track" ? "fast_track" : "plan_first",
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        const targetRepo = remoteRepo ?? giteeIssue.repository ?? "";
        const targetEnterprise = giteeIssue.enterprise ?? enterprise ?? extractGiteeOwner(targetRepo) ?? undefined;
        detail = await linkRequirementGitHubIssue(base, detail.state.id, {
          provider: "gitee",
          repo: targetRepo,
          enterprise: targetEnterprise,
          issue: {
            number: giteeIssue.ident,
            url: giteeIssue.url,
            title: giteeIssue.title,
            state: giteeIssue.state,
            ...(giteeIssue.issueType ? { issueType: giteeIssue.issueType } : {}),
            ...(giteeIssue.programName ? { programName: giteeIssue.programName } : {}),
            lastSyncedAt: Date.now(),
          },
          summary: `从 Gitee 工作项 #${giteeIssue.ident} 导入`,
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });

        let dispatch: DispatchOutcome | null = null;
        if (body.dispatchAgent === true) {
          detail = await markDesigning(base, detail.state.id, {
            currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
          });
          const prompt = buildAgentPrompt(detail, "design", { outputLanguage: resolveOutputLang(base, detail) });
          dispatch = await deps.dispatchToBridge(detail.state.id, "design", "send", prompt);
        }

        deps.broadcastUi({ type: "workbench.updated", reason: "requirement.created", root: base, id: detail.state.id, at: Date.now() });
        return jsonResponse({ detail, dispatch, alreadyExisted: false, issue: giteeIssue, provider: "gitee" }, 201);
      }

      const issueRef =
        typeof body.issueRef === "string" || typeof body.issueRef === "number" ? body.issueRef : "";
      if (!String(issueRef).trim()) {
        throw new WorkbenchError("invalid_input", "请提供 GitHub Issue 编号或 URL", {
          messageKey: "github.errIssueRefRequired",
        });
      }
      const remoteRepo = projectMeta?.github?.repo ?? parseGitHubRepoFromRemoteUrl(remoteUrl);
      const issue = await viewGitHubIssue({ root: base, repo: remoteRepo, issueRef }, deps.githubDeps);
      const snapshot = await observeGitSnapshot(base);

      // Avoid importing the exact same GitHub Issue twice if an active/existing requirement already tracks it.
      const existingList = listRequirements(base, {
        scope: "all",
        currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
      });
      const existingMatch = existingList.find(
        (item) => item.github?.repo === issue.repo && item.github?.issue?.number === issue.number,
      );
      if (existingMatch) {
        const existingDetail = getRequirement(base, existingMatch.id, {
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        return jsonResponse({ detail: existingDetail, alreadyExisted: true, issue, provider: "github" }, 200);
      }

      const goal = [
        `# ${issue.title}`,
        "",
        `> 导入自 GitHub Issue: ${issue.url}`,
        issue.labels.length > 0 ? `> 标签：${issue.labels.join(", ")}` : "",
        "",
        issue.body || issue.title,
      ]
        .filter(Boolean)
        .join("\n");

      let detail = await createRequirement(base, {
        goal,
        title: issue.title,
        track: body.track === "fast_track" ? "fast_track" : "plan_first",
        currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
      });
      detail = await linkRequirementGitHubIssue(base, detail.state.id, {
        provider: "github",
        repo: issue.repo,
        issue: {
          number: issue.number,
          url: issue.url,
          title: issue.title,
          state: issue.state,
          lastSyncedAt: Date.now(),
        },
        summary: `从 GitHub Issue #${issue.number} 导入`,
        currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
      });

      let dispatch: DispatchOutcome | null = null;
      if (body.dispatchAgent === true) {
        detail = await markDesigning(base, detail.state.id, {
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        const prompt = buildAgentPrompt(detail, "design", { outputLanguage: resolveOutputLang(base, detail) });
        dispatch = await deps.dispatchToBridge(detail.state.id, "design", "send", prompt);
      }

      deps.broadcastUi({ type: "workbench.updated", reason: "requirement.created", root: base, id: detail.state.id, at: Date.now() });
      return jsonResponse({ detail, dispatch, alreadyExisted: false, issue, provider: "github" }, 201);
    }

    if (method === "POST" && pathname === "/api/requirements") {
      const body = await readBody(req);
      const goal = typeof body.goal === "string" ? body.goal : "";
      const title = typeof body.title === "string" ? body.title : undefined;
      const track: Track = body.track === "fast_track" ? "fast_track" : "plan_first";
      const snapshot = await observeGitSnapshot(base);
      const attachmentIds = readStringArray(body.attachmentIds);
      let detail = await createRequirement(base, {
        goal,
        title,
        ...(typeof body.parentId === "string" && body.parentId.trim() ? { parentId: body.parentId.trim() } : {}),
        criteria: Array.isArray(body.criteria) ? (body.criteria as CriterionInput[]) : undefined,
        track,
        currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        ...(attachmentIds && attachmentIds.length > 0 ? { attachmentIds } : {}),
      });

      const projectMeta = getProjectStatus(base).project;
      const shouldCreateIssue =
        body.createGitHubIssue === true ||
        (body.createGitHubIssue !== false && projectMeta?.github?.autoCreateIssue === true);
      let githubWarning: string | undefined;
      let githubWarningRef: StructuredMessageRef | undefined;
      if (shouldCreateIssue) {
        const linked = await tryCreateAndLinkIssue(base, detail, snapshot?.fingerprint ?? null);
        detail = linked.detail;
        githubWarning = linked.warning;
        githubWarningRef = linked.warningRef;
      }

      let sandbox = null;
      if (body.createSandbox === true && snapshot?.head) {
        sandbox = await createOrReuseWorktree(base, detail.state.id, {
          branchPrefix: "feat",
          ...(typeof body.stackedOnReqId === "string" && body.stackedOnReqId.trim()
            ? { stackedOnReqId: body.stackedOnReqId.trim() }
            : {}),
        });
      }

      let dispatch: DispatchOutcome | null = null;
      if (body.dispatchAgent === true) {
        detail = await markDesigning(base, detail.state.id, {
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        if (sandbox) syncRequirementMirrorToSandbox(base, detail.state.id, sandbox.worktreePath);
        const prompt = buildAgentPrompt(detail, "design", { outputLanguage: resolveOutputLang(base, detail) });
        dispatch = await deps.dispatchToBridge(detail.state.id, "design", "send", prompt);
      }

      deps.broadcastUi({ type: "workbench.updated", reason: "requirement.created", root: base, id: detail.state.id, at: Date.now() });
      return jsonResponse(
        {
          detail,
          dispatch,
          ...(sandbox ? { sandbox } : {}),
          ...(githubWarning ? { githubWarning } : {}),
          ...(githubWarningRef ? { githubWarningRef } : {}),
        },
        201,
      );
    }

    // Routes matching /api/requirements/:id[/...]
    const reqMatch = /^\/api\/requirements\/(REQ-\d{3,})(?:\/(.*))?$/.exec(pathname);
    if (reqMatch) {
      const id = reqMatch[1]!;
      const sub = reqMatch[2] ?? "";

      if (method === "GET" && sub === "") {
        const codeRoot = resolveCodeRoot(base, id);
        const snapshot = await observeGitSnapshot(codeRoot);
        let detail = getRequirement(base, id, { currentCodeSnapshotHash: snapshot?.fingerprint ?? null });
        let sandbox = getSandboxForRequirement(base, id);
        if (sandbox && detail.state.stage !== "done" && detail.state.stage !== "cancelled") {
          const reconciled = await reconcileRsiSandboxBaseline(base, id).catch(() => null);
          if (reconciled) {
            detail = getRequirement(base, id, { currentCodeSnapshotHash: snapshot?.fingerprint ?? null });
            sandbox = getSandboxForRequirement(base, id);
          }
        }
        const sandboxDrift = sandbox ? await inspectRsiSandboxDrift(base, id).catch(() => null) : null;
        const obs = readHubConfig().observability;
        const activeById = new Map(
          deps.executor
            .getActiveRuns(base)
            .filter((r) => r.requirementId === id)
            .map((r) => [r.id, r]),
        );
        const readLogSafe = (runId: string): string | undefined => {
          const live = deps.executor.getLiveLog(runId);
          if (live !== null) return live;
          try {
            const p = resolveSafePath(base, `${WORKBENCH_DIR}/items/${id}/runs/run-${path.basename(runId)}.log`);
            if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
          } catch {
            // ignore missing or unsafe log path
          }
          return undefined;
        };
        const mergedRuns = (detail.state.agentRuns ?? []).map((r) => {
          const active = activeById.get(r.id);
          const candidate: AgentRunRecord = active ? { ...r, ...active } : r;
          return enrichAgentRunRecord(candidate, candidate.usage ? undefined : readLogSafe(candidate.id), {
            observability: obs,
          });
        });
        for (const active of activeById.values()) {
          if (!mergedRuns.some((r) => r.id === active.id)) {
            mergedRuns.push(
              enrichAgentRunRecord(active, active.usage ? undefined : readLogSafe(active.id), {
                observability: obs,
              }),
            );
          }
        }
        detail = {
          ...detail,
          state: {
            ...detail.state,
            agentRuns: mergedRuns,
          },
        };
        return jsonResponse({
          detail,
          bridge: bridgeStatus,
          codeSnapshotHash: snapshot?.fingerprint ?? null,
          sandbox,
          ...(sandboxDrift ? { sandboxDrift } : {}),
        });
      }

      if (method === "POST" && sub === "spawn") {
        const body = await readBody(req);
        const snapshot = await observeGitSnapshot(resolveCodeRoot(base, id));
        const items: SpawnSubRequirementItem[] | undefined = Array.isArray(body.items)
          ? body.items
              .filter((x): x is Record<string, unknown> => isRecord(x) && typeof x.title === "string")
              .map((x) => ({
                title: String(x.title),
                ...(typeof x.goal === "string" ? { goal: x.goal } : {}),
                ...(x.track === "fast_track" || x.track === "plan_first" ? { track: x.track } : {}),
              }))
          : undefined;
        const track: Track | undefined =
          body.track === "fast_track" || body.track === "plan_first" ? body.track : undefined;
        const out = await spawnSubRequirements(base, id, {
          items,
          track,
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        deps.broadcastUi({ type: "workbench.updated", reason: "requirement.spawned", root: base, id, at: Date.now() });
        return jsonResponse(out, 201);
      }

      if (method === "GET" && sub === "diff") {
        const live = url.searchParams.get("live") === "1";
        const diffView = await getRequirementDiff(base, id, { live });
        return jsonResponse({ ...diffView, changes: diffView.observation });
      }

      const histMatch = /^history\/(\d+)$/.exec(sub);
      if (method === "GET" && histMatch) {
        const version = Number(histMatch[1]);
        const markdown = getDesignHistoryVersion(base, id, version);
        return jsonResponse({ version, markdown });
      }

      const attMatch = /^attachments\/([^/]+)$/.exec(sub);
      if (method === "GET" && attMatch) {
        const attId = decodeURIComponent(attMatch[1]!);
        const state = getRequirement(base, id).state;
        const metas = normalizeAttachments(state.attachments) ?? [];
        const served = readAttachmentForServe(requirementAttachmentsDir(base, id), attId, metas);
        return new Response(Uint8Array.from(served.bytes), { headers: served.headers });
      }

      if (method === "DELETE" && attMatch) {
        const attId = decodeURIComponent(attMatch[1]!);
        const detail = await removeRequirementAttachment(base, id, attId);
        deps.broadcastUi({ type: "workbench.updated", reason: "attachment.removed", root: base, id, at: Date.now() });
        return jsonResponse({ detail });
      }

      if (method === "POST" && sub === "attachments") {
        const body = await readBody(req);
        const attachmentIds = readStringArray(body.attachmentIds) ?? [];
        const detail = await addRequirementAttachments(base, id, attachmentIds, {
          expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
          currentCodeSnapshotHash: null,
        });
        deps.broadcastUi({ type: "workbench.updated", reason: "attachment.added", root: base, id, at: Date.now() });
        return jsonResponse({ detail }, 201);
      }

      const evMatch = /^evidence\/([^/]+)$/.exec(sub);
      if (method === "GET" && evMatch) {
        const evidence = getVerificationEvidence(base, id, decodeURIComponent(evMatch[1]!));
        return jsonResponse(evidence);
      }

      const shotMatch = /^screenshots\/([^/]+)$/.exec(sub);
      if (method === "GET" && shotMatch) {
        const screenshot = readRequirementScreenshot(base, id, decodeURIComponent(shotMatch[1]!));
        return new Response(new Uint8Array(screenshot.bytes), {
          status: 200,
          headers: {
            "Content-Type": "image/png",
            "Content-Length": String(screenshot.bytes.length),
            "Cache-Control": "private, max-age=31536000, immutable",
          },
        });
      }

      if (method === "POST" && sub === "screenshots/capture") {
        const body = await readBody(req);
        const snapshot = await observeGitSnapshot(resolveCodeRoot(base, id));
        const capture = await captureRequirementScreenshots(base, id, {
          trigger: "manual",
          actor: "human",
          ...(typeof body.label === "string" && body.label.trim() ? { label: body.label.trim() } : {}),
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        const detail = getRequirement(base, id, { currentCodeSnapshotHash: snapshot?.fingerprint ?? null });
        deps.broadcastUi({ type: "workbench.updated", reason: "screenshots.captured", root: base, id, at: Date.now() });
        return jsonResponse({ detail, screenshotCapture: capture });
      }

      if (method === "PATCH" && sub === "spec") {
        const body = await readBody(req);
        const snapshot = await observeGitSnapshot(resolveCodeRoot(base, id));
        const detail = await updateSpec(base, id, {
          title: typeof body.title === "string" ? body.title : undefined,
          specMarkdown: typeof body.specMarkdown === "string" ? body.specMarkdown : undefined,
          criteria: Array.isArray(body.criteria) ? (body.criteria as CriterionInput[]) : undefined,
          expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        deps.broadcastUi({ type: "workbench.updated", reason: "spec.updated", root: base, id, at: Date.now() });
        return jsonResponse({ detail });
      }

      if (method === "PATCH" && sub === "design") {
        const body = await readBody(req);
        const snapshot = await observeGitSnapshot(resolveCodeRoot(base, id));
        const detail = await updateDesign(base, id, {
          designMarkdown: typeof body.designMarkdown === "string" ? body.designMarkdown : "",
          expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
          actor: "human",
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        deps.broadcastUi({ type: "workbench.updated", reason: "design.updated", root: base, id, at: Date.now() });
        return jsonResponse({ detail });
      }

      if (method === "PATCH" && sub === "tasks") {
        const body = await readBody(req);
        if (!Array.isArray(body.tasks)) {
          throw new WorkbenchError("invalid_input", "tasks 必须是数组");
        }
        const snapshot = await observeGitSnapshot(resolveCodeRoot(base, id));
        const detail = await updateTasks(base, id, {
          tasks: body.tasks as TaskInput[],
          note: typeof body.note === "string" ? body.note : undefined,
          expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
          actor: "human",
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        deps.broadcastUi({ type: "workbench.updated", reason: "tasks.updated", root: base, id, at: Date.now() });
        return jsonResponse({ detail });
      }

      if (method === "GET" && sub === "handoff") {
        const synthesized = await synthesizeHandoffPacket(base, id, {
          action: "implement",
          hubOutputLanguage: deps.getHubOutputLanguage(),
        });
        return jsonResponse({ markdown: synthesized.markdown, detail: synthesized.detail });
      }

      if (method === "POST" && sub === "discussions") {
        const body = await readBody(req);
        const snapshot = await observeGitSnapshot(resolveCodeRoot(base, id));
        const res = await addDiscussion(base, id, {
          actor: "human",
          mode: body.mode === "refine" ? "refine" : "ask",
          anchor: typeof body.anchor === "string" ? body.anchor : undefined,
          message: typeof body.message === "string" ? body.message : "",
          resolved: typeof body.resolved === "boolean" ? body.resolved : undefined,
          expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        deps.broadcastUi({ type: "workbench.updated", reason: "discussion.added", root: base, id, at: Date.now() });
        return jsonResponse(res, 201);
      }

      if (method === "POST" && sub === "discussions/resolve") {
        const body = await readBody(req);
        const snapshot = await observeGitSnapshot(resolveCodeRoot(base, id));
        const detail = await resolveDiscussions(base, id, {
          ids: Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : undefined,
          resolved: typeof body.resolved === "boolean" ? body.resolved : true,
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        deps.broadcastUi({ type: "workbench.updated", reason: "discussion.resolved", root: base, id, at: Date.now() });
        return jsonResponse({ detail });
      }

      if (method === "POST" && sub === "run") {
        const body = await readBody(req);
        const action = typeof body.action === "string" && (AGENT_ACTIONS as readonly string[]).includes(body.action)
          ? (body.action as AgentAction)
          : "design";
        const started = await deps.executor.startRun({
          root: base,
          requirementId: id,
          action,
          harness: typeof body.harness === "string" ? body.harness : undefined,
          model: typeof body.model === "string" ? body.model : undefined,
          reasoningEffort:
            typeof body.reasoningEffort === "string" && (REASONING_EFFORTS as readonly string[]).includes(body.reasoningEffort)
              ? (body.reasoningEffort as ReasoningEffort)
              : undefined,
          message: typeof body.message === "string" ? body.message : undefined,
          anchor: typeof body.anchor === "string" ? body.anchor : undefined,
          anchorIds: Array.isArray(body.anchorIds) ? body.anchorIds.filter((x): x is string => typeof x === "string") : undefined,
          mode: body.mode === "refine" ? "refine" : body.mode === "ask" ? "ask" : undefined,
          useFallback: body.useFallback === true,
          resolveConflict: body.resolveConflict === true,
          timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
          idleTimeoutMs: typeof body.idleTimeoutMs === "number" ? body.idleTimeoutMs : undefined,
        });
        return jsonResponse(started, 202);
      }

      if (method === "POST" && sub === "sandbox") {
        const body = await readBody(req);
        const sandbox = await createOrReuseWorktree(base, id, {
          branchPrefix: body.branchPrefix === "rsi" ? "rsi" : "feat",
          ...(typeof body.branchName === "string" && body.branchName.trim() ? { branchName: body.branchName.trim() } : {}),
          ...(typeof body.stackedOnReqId === "string" && body.stackedOnReqId.trim()
            ? { stackedOnReqId: body.stackedOnReqId.trim() }
            : {}),
        });
        const snapshot = await observeGitSnapshot(sandbox.worktreePath);
        const detail = getRequirement(base, id, { currentCodeSnapshotHash: snapshot?.fingerprint ?? null });
        const sandboxDrift = await inspectRsiSandboxDrift(base, id).catch(() => null);
        deps.broadcastUi({ type: "workbench.updated", reason: "sandbox.created", root: base, id, at: Date.now() });
        deps.broadcastUi({ type: "hub.updated", reason: "sandbox.created", root: base, id, at: Date.now() });
        return jsonResponse({ sandbox, detail, sandboxDrift }, 201);
      }

      if (method === "POST" && sub === "sync-base") {
        const body = await readBody(req);
        const res = await syncRsiSandboxBase(base, id, {
          fetchRemote: body.fetchRemote !== false,
        });
        deps.broadcastUi({ type: "hub.updated", reason: "evolution.base_synced", root: base, id, at: Date.now() });
        deps.broadcastUi({ type: "workbench.updated", reason: "sandbox.base_synced", root: base, id, at: Date.now() });
        return jsonResponse(res);
      }

      if (method === "POST" && sub === "apply-sandbox") {
        const applied = await applySandboxToMain(base, id);
        const reloadRes = applied.touchesWeb ? await deps.reloadWebBundle() : { reloaded: false };
        deps.broadcastUi({ type: "hub.updated", reason: "evolution.applied", root: base, id, at: Date.now() });
        deps.broadcastUi({ type: "workbench.updated", reason: "sandbox.applied", root: base, id, at: Date.now() });
        return jsonResponse({
          ...applied,
          webReloaded: reloadRes.reloaded,
          restartRecommended: applied.touchesBackend,
        });
      }

      if (method === "POST" && sub === "sync-resolve") {
        const body = await readBody(req);
        const codeRoot = resolveCodeRoot(base, id);
        const snapshot = await observeGitSnapshot(codeRoot);
        let detail = getRequirement(base, id, { currentCodeSnapshotHash: snapshot?.fingerprint ?? null });
        if (detail.state.stage === "awaiting_approval" && body.approveFirst === true) {
          detail = await approveDesign(base, id, {
            expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : detail.state.revision,
            baseline: snapshot,
            currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
          });
        } else if (detail.state.stage === "done" || detail.state.stage === "awaiting_acceptance") {
          detail = await prepareSandboxConflictResolution(base, id);
        } else if (detail.state.stage !== "implementing") {
          throw new WorkbenchError(
            "approval_required",
            `${id} 当前阶段（${detail.state.stage}）需要先批准方案后才能同步主干并解决冲突`,
          );
        }

        if (body.useCli === true) {
          const started = await deps.executor.startRun({
            root: base,
            requirementId: id,
            action: "fix",
            resolveConflict: true,
            harness: typeof body.harness === "string" ? body.harness : undefined,
            model: typeof body.model === "string" ? body.model : undefined,
            reasoningEffort:
              typeof body.reasoningEffort === "string" &&
              (REASONING_EFFORTS as readonly string[]).includes(body.reasoningEffort)
                ? (body.reasoningEffort as ReasoningEffort)
                : undefined,
            message: typeof body.message === "string" ? body.message : undefined,
          });
          deps.broadcastUi({ type: "workbench.updated", reason: "sandbox.sync_resolve", root: base, id, at: Date.now() });
          return jsonResponse({ detail: started.detail, run: started.run, target: started.target, dispatch: null }, 202);
        }

        const drift = await inspectRsiSandboxDrift(base, id, { includeSiblings: false, fetchRemote: false }).catch(
          () => null,
        );
        const conflicts = drift?.conflictFiles.slice(0, 8).join(", ") ?? "";
        const prompt =
          typeof body.message === "string" && body.message.trim()
            ? body.message.trim()
            : `请处理工作台需求 ${id} 沙箱分支 ${drift?.branch ?? ""} 的主干同步与合并冲突${
                conflicts ? `（冲突文件：${conflicts}）` : ""
              }：保留未提交改动，合并 ${drift?.targetRef ?? drift?.mainHead ?? "main"}，解决冲突后运行 wb verify ${id} --all 与 wb tasks ${id} --ready。`;
        const dispatch =
          body.dispatchAgent === true ? await deps.dispatchToBridge(id, "fix", "send", prompt) : null;
        deps.broadcastUi({ type: "workbench.updated", reason: "sandbox.sync_resolve", root: base, id, at: Date.now() });
        return jsonResponse({ detail, dispatch });
      }

      if (method === "GET" && sub === "runs") {
        const obs = readHubConfig().observability;
        const readLogSafe = (runId: string): string | undefined => {
          const live = deps.executor.getLiveLog(runId);
          if (live !== null) return live;
          try {
            const p = resolveSafePath(base, `${WORKBENCH_DIR}/items/${id}/runs/run-${path.basename(runId)}.log`);
            if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
          } catch {
            // ignore missing or unsafe log path
          }
          return undefined;
        };
        const diskRuns = listRequirementAgentRuns(base, id);
        const activeMap = new Map(
          deps.executor
            .getActiveRuns(base)
            .filter((r) => r.requirementId === id)
            .map((r) => [r.id, r]),
        );
        const merged = diskRuns.map((r) => {
          const candidate = activeMap.get(r.id) ?? r;
          return enrichAgentRunRecord(candidate, candidate.usage ? undefined : readLogSafe(candidate.id), {
            observability: obs,
          });
        });
        for (const active of activeMap.values()) {
          if (!merged.some((r) => r.id === active.id)) {
            merged.push(
              enrichAgentRunRecord(active, active.usage ? undefined : readLogSafe(active.id), {
                observability: obs,
              }),
            );
          }
        }
        merged.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
        return jsonResponse({ runs: merged });
      }

      const runCancelMatch = /^runs\/([^/]+)\/cancel$/.exec(sub);
      if (method === "POST" && runCancelMatch) {
        const runId = decodeURIComponent(runCancelMatch[1]!);
        const cancelled = deps.executor.cancelRun(runId);
        return jsonResponse({ cancelled, runId });
      }

      const runTraceMatch = /^runs\/([^/]+)\/trace$/.exec(sub);
      if (method === "GET" && runTraceMatch) {
        const runId = decodeURIComponent(runTraceMatch[1]!);
        const obs = readHubConfig().observability;
        const readLogSafe = (): string | undefined => {
          const live = deps.executor.getLiveLog(runId);
          if (live !== null) return live;
          try {
            const p = resolveSafePath(base, `${WORKBENCH_DIR}/items/${id}/runs/run-${path.basename(runId)}.log`);
            if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
          } catch {
            // ignore missing or unsafe log path
          }
          return undefined;
        };
        const afterSeqRaw = Number(url.searchParams.get("afterSeq") ?? "0");
        const limitRaw = Number(url.searchParams.get("limit") ?? "2000");
        const afterSeq = Number.isFinite(afterSeqRaw) ? Math.max(0, Math.floor(afterSeqRaw)) : 0;
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(5000, Math.floor(limitRaw)) : 2000;
        const liveTrace = deps.executor.getLiveTrace(runId, afterSeq, limit);
        if (liveTrace) {
          const active = deps.executor.getActiveRuns(base).find((r) => r.id === runId);
          if (active) {
            return jsonResponse({
              runId,
              live: true,
              hasTrace: true,
              record: enrichAgentRunRecord(active, active.usage ? undefined : readLogSafe(), { observability: obs }),
              ...liveTrace,
            });
          }
        }
        const diskTrace = getAgentRunTrace(base, id, runId, { afterSeq, limit });
        return jsonResponse({
          runId,
          live: false,
          hasTrace: diskTrace.traceAvailable,
          record: diskTrace.record
            ? enrichAgentRunRecord(diskTrace.record, diskTrace.record.usage ? undefined : readLogSafe(), {
                observability: obs,
              })
            : null,
          events: diskTrace.events,
          nextSeq: diskTrace.nextSeq,
          totalEvents: diskTrace.totalEvents,
          hasMore: diskTrace.hasMore,
        });
      }

      const runContextMatch = /^runs\/([^/]+)\/context$/.exec(sub);
      if (method === "GET" && runContextMatch) {
        const runId = decodeURIComponent(runContextMatch[1]!);
        const context = getAgentRunContext(base, id, runId);
        return jsonResponse({ runId, hasContext: Boolean(context), context });
      }

      const runDetailMatch = /^runs\/([^/]+)$/.exec(sub);
      if (method === "GET" && runDetailMatch) {
        const runId = decodeURIComponent(runDetailMatch[1]!);
        const obs = readHubConfig().observability;
        const liveLog = deps.executor.getLiveLog(runId);
        if (liveLog !== null) {
          const active = deps.executor.getActiveRuns(base).find((r) => r.id === runId);
          if (active) {
            return jsonResponse({
              record: enrichAgentRunRecord(active, active.usage ? undefined : liveLog, { observability: obs }),
              log: liveLog,
            });
          }
        }
        const detail = getAgentRunDetail(base, id, runId);
        return jsonResponse({
          record: enrichAgentRunRecord(detail.record, detail.record.usage ? undefined : detail.log, {
            observability: obs,
          }),
          log: detail.log,
        });
      }

      if (method === "POST" && sub === "approve") {
        const body = await readBody(req);
        if (body.createSandbox === true) {
          await createOrReuseWorktree(base, id, {
            branchPrefix: "feat",
            ...(typeof body.stackedOnReqId === "string" && body.stackedOnReqId.trim()
              ? { stackedOnReqId: body.stackedOnReqId.trim() }
              : {}),
          });
        }
        const snapshot = await observeGitSnapshot(resolveCodeRoot(base, id));
        const detail = await approveDesign(base, id, {
          expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
          baseline: snapshot,
          note: typeof body.note === "string" ? body.note : undefined,
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        let dispatch: DispatchOutcome | null = null;
        if (body.dispatchAgent === true) {
          const prompt = buildAgentPrompt(detail, "implement", { outputLanguage: resolveOutputLang(base, detail) });
          dispatch = await deps.dispatchToBridge(id, "implement", "send", prompt);
        }
        deps.broadcastUi({ type: "workbench.updated", reason: "approved", root: base, id, at: Date.now() });
        return jsonResponse({ detail, dispatch });
      }

      if (method === "POST" && sub === "fast-track") {
        const body = await readBody(req);
        const snapshot = await observeGitSnapshot(resolveCodeRoot(base, id));
        const detail = await authorizeFastTrack(base, id, {
          expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
          baseline: snapshot,
          note: typeof body.note === "string" ? body.note : undefined,
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        let dispatch: DispatchOutcome | null = null;
        if (body.dispatchAgent === true) {
          const prompt = buildAgentPrompt(detail, "implement", { outputLanguage: resolveOutputLang(base, detail) });
          dispatch = await deps.dispatchToBridge(id, "implement", "send", prompt);
        }
        deps.broadcastUi({ type: "workbench.updated", reason: "fast_tracked", root: base, id, at: Date.now() });
        return jsonResponse({ detail, dispatch });
      }

      if (method === "POST" && sub === "request-changes") {
        const body = await readBody(req);
        const codeRoot = resolveCodeRoot(base, id);
        const snapshot = await observeGitSnapshot(codeRoot);
        const detail = await requestChanges(base, id, {
          feedback: typeof body.feedback === "string" ? body.feedback : "",
          expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        if (codeRoot !== base) {
          syncRequirementMirrorToSandbox(base, id, codeRoot);
        }
        let dispatch: DispatchOutcome | null = null;
        if (body.dispatchAgent === true) {
          const action: DispatchAction = detail.state.stage === "designing" ? "design" : "fix";
          dispatch = await deps.dispatchToBridge(
            id,
            action,
            "send",
            buildAgentPrompt(detail, action, { outputLanguage: resolveOutputLang(base, detail) }),
          );
        }
        deps.broadcastUi({ type: "workbench.updated", reason: "changes_requested", root: base, id, at: Date.now() });
        return jsonResponse({ detail, dispatch });
      }

      if (method === "POST" && sub === "verify") {
        const body = await readBody(req);
        const timeoutMs = typeof body.timeoutMs === "number" ? body.timeoutMs : undefined;
        deps.broadcastUi({ type: "verify.started", root: base, id, at: Date.now() });
        try {
          if (body.all === true || typeof body.command !== "string") {
            const force = body.force !== false;
            const res = await runAllVerifications(base, id, { timeoutMs, force });
            deps.broadcastUi({ type: "workbench.updated", reason: "verified", root: base, id, at: Date.now() });
            return jsonResponse({ detail: res.detail, runs: res.runs.map((r) => r.record) });
          }
          const criterionIds = Array.isArray(body.criterionIds)
            ? body.criterionIds.filter((c): c is string => typeof c === "string")
            : [];
          const res = await runVerification(base, id, {
            command: body.command,
            criterionIds,
            timeoutMs,
          });
          deps.broadcastUi({ type: "workbench.updated", reason: "verified", root: base, id, at: Date.now() });
          return jsonResponse({ detail: res.detail, runs: [res.record] });
        } finally {
          deps.broadcastUi({ type: "verify.finished", root: base, id, at: Date.now() });
        }
      }

      if (method === "POST" && sub === "accept") {
        const body = await readBody(req);
        const snapshot = await observeGitSnapshot(resolveCodeRoot(base, id));
        let detail = await acceptRequirement(base, id, {
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
          expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
          note: typeof body.note === "string" ? body.note : undefined,
          overrideReason: typeof body.overrideReason === "string" ? body.overrideReason : undefined,
          acceptedRisks: readStringArray(body.acceptedRisks),
        });
        const projectMeta = getProjectStatus(base).project;
        let githubSyncWarning: string | undefined;
        let githubSyncWarningRef: StructuredMessageRef | undefined;
        if (
          detail.state.github?.provider !== "gitee" &&
          detail.state.github?.issue &&
          projectMeta?.github?.autoSyncIssue !== false
        ) {
          const synced = await trySyncIssueMilestone(
            base,
            detail,
            `需求 \`${id}\` 已通过人类最终验收（必需验收条件 ${detail.validity.coverage.requiredPassed}/${detail.validity.coverage.requiredTotal}${detail.state.acceptance?.snapshot ? ` · 快照 \`${detail.state.acceptance.snapshot.id}\`` : ""}）。`,
            { snapHash: snapshot?.fingerprint ?? null },
          );
          detail = synced.detail;
          githubSyncWarning = synced.warning;
          githubSyncWarningRef = synced.warningRef;
        }
        deps.broadcastUi({ type: "workbench.updated", reason: "accepted", root: base, id, at: Date.now() });
        return jsonResponse({
          detail,
          ...(githubSyncWarning ? { githubSyncWarning } : {}),
          ...(githubSyncWarningRef ? { githubSyncWarningRef } : {}),
        });
      }

      if (method === "GET" && sub === "delivery") {
        const preview = await getRequirementDeliveryPreview(base, id, {
          ...deps.githubDeps,
          giteeDeps: deps.giteeDeps,
          giteeToken: resolveGiteeToken(),
        });
        const sandboxDrift = preview.sandboxActive
          ? await inspectRsiSandboxDrift(base, id, { includeSiblings: true, fetchRemote: false }).catch(() => null)
          : null;
        return jsonResponse({ ...preview, ...(sandboxDrift ? { sandboxDrift } : {}) });
      }

      if (method === "POST" && sub === "deliver") {
        const body = await readBody(req);
        const files = Array.isArray(body.files) ? body.files.filter((f): f is string => typeof f === "string") : [];
        const commitMessage = typeof body.commitMessage === "string" ? body.commitMessage : "";
        const res = await deliverRequirement(
          base,
          id,
          {
            files,
            commitMessage,
            expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
            note: typeof body.note === "string" ? body.note : undefined,
            createPr: body.createPr === true,
            branchName: typeof body.branchName === "string" ? body.branchName : undefined,
            baseBranch: typeof body.baseBranch === "string" ? body.baseBranch : undefined,
            prTitle: typeof body.prTitle === "string" ? body.prTitle : undefined,
            prBody: typeof body.prBody === "string" ? body.prBody : undefined,
            forceWithLease: body.forceWithLease === true,
          },
          {
            ...deps.githubDeps,
            giteeDeps: deps.giteeDeps,
            giteeToken: resolveGiteeToken(),
          },
        );
        const reloadRes = !body.createPr && res.touchesWeb ? await deps.reloadWebBundle() : { reloaded: false };
        deps.broadcastUi({ type: "workbench.updated", reason: "delivered", root: base, id, at: Date.now() });
        if (res.pr) {
          deps.broadcastUi({ type: "hub.updated", reason: "github.pr_created", root: base, id, at: Date.now() });
        }
        return jsonResponse({
          detail: res.detail,
          delivery: res.delivery,
          ...(res.pr ? { pr: res.pr } : {}),
          ...(res.githubSyncWarning ? { githubSyncWarning: res.githubSyncWarning } : {}),
          ...(res.githubSyncWarningRef ? { githubSyncWarningRef: res.githubSyncWarningRef } : {}),
          webReloaded: reloadRes.reloaded,
          restartRecommended: !body.createPr && res.touchesBackend,
        });
      }

      if (method === "POST" && sub === "github/issue") {
        const body = await readBody(req);
        const snapshot = await observeGitSnapshot(resolveCodeRoot(base, id));
        const detail = getRequirement(base, id, { currentCodeSnapshotHash: snapshot?.fingerprint ?? null });
        const projectMeta = getProjectStatus(base).project;
        if (typeof body.issueRef === "string" || typeof body.issueRef === "number") {
          const remoteUrl = await resolveRemoteUrl(base);
          const isGitee =
            body.provider === "gitee" ||
            projectMeta?.gitee?.repo ||
            projectMeta?.gitee?.enterprise ||
            detectGitRemoteProvider(remoteUrl) === "gitee";
          if (isGitee && body.provider !== "github") {
            const token = resolveGiteeToken();
            if (!token) {
              throw new WorkbenchError("invalid_input", "尚未配置 Gitee 私人令牌 (Access Token)", {
                messageKey: "gitee.errTokenMissing",
              });
            }
            const remoteRepo = projectMeta?.gitee?.repo ?? parseGiteeRepoFromRemoteUrl(remoteUrl);
            const enterprise = projectMeta?.gitee?.enterprise ?? extractGiteeOwner(remoteRepo);
            const issue = await viewGiteeIssue(
              { token, issueRef: String(body.issueRef), enterprise, repo: remoteRepo },
              deps.giteeDeps,
            );
            const targetRepo = remoteRepo ?? issue.repository ?? "";
            const updated = await linkRequirementGitHubIssue(base, id, {
              provider: "gitee",
              repo: targetRepo,
              enterprise: issue.enterprise ?? enterprise ?? extractGiteeOwner(targetRepo),
              issue: {
                number: issue.ident,
                url: issue.url,
                title: issue.title,
                state: issue.state,
                ...(issue.issueType ? { issueType: issue.issueType } : {}),
                ...(issue.programName ? { programName: issue.programName } : {}),
                lastSyncedAt: Date.now(),
              },
              summary: `关联已有 Gitee 工作项 #${issue.ident}`,
              currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
            });
            deps.broadcastUi({ type: "workbench.updated", reason: "github.issue_linked", root: base, id, at: Date.now() });
            return jsonResponse({ detail: updated });
          }
          const remoteRepo = projectMeta?.github?.repo ?? parseGitHubRepoFromRemoteUrl(remoteUrl);
          const issue = await viewGitHubIssue({ root: base, repo: remoteRepo, issueRef: body.issueRef }, deps.githubDeps);
          const updated = await linkRequirementGitHubIssue(base, id, {
            provider: "github",
            repo: issue.repo,
            issue: {
              number: issue.number,
              url: issue.url,
              title: issue.title,
              state: issue.state,
              lastSyncedAt: Date.now(),
            },
            summary: `关联已有 GitHub Issue #${issue.number}`,
            currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
          });
          deps.broadcastUi({ type: "workbench.updated", reason: "github.issue_linked", root: base, id, at: Date.now() });
          return jsonResponse({ detail: updated });
        }
        const ghEnv = await inspectGitHubEnvironment(base, projectMeta?.github, deps.githubDeps);
        if (!ghEnv.ready || !ghEnv.repo) {
          const reasonMessageKey =
            ghEnv.reasonCode === "gh_missing"
              ? "github.reasonGhMissing"
              : ghEnv.reasonCode === "gh_unauthenticated"
                ? "github.reasonGhUnauthenticated"
                : "github.reasonRepoMissing";
          throw new WorkbenchError("execution_failed", ghEnv.reason ?? "GitHub 环境未就绪，无法创建 Issue", {
            messageKey: reasonMessageKey,
          });
        }
        const issue = await createGitHubIssue(
          {
            root: base,
            repo: ghEnv.repo,
            title: typeof body.title === "string" && body.title.trim() ? body.title.trim() : `[${id}] ${detail.state.title}`,
            body: typeof body.body === "string" && body.body.trim() ? body.body.trim() : buildRequirementIssueBody(detail),
          },
          deps.githubDeps,
        );
        const updated = await linkRequirementGitHubIssue(base, id, {
          repo: ghEnv.repo,
          issue,
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        deps.broadcastUi({ type: "workbench.updated", reason: "github.issue_linked", root: base, id, at: Date.now() });
        return jsonResponse({ detail: updated }, 201);
      }

      if (method === "POST" && sub === "github/sync-issue") {
        const body = await readBody(req);
        const snapshot = await observeGitSnapshot(resolveCodeRoot(base, id));
        const detail = getRequirement(base, id, { currentCodeSnapshotHash: snapshot?.fingerprint ?? null });
        if (!detail.state.github?.issue || !detail.state.github?.repo) {
          throw new WorkbenchError("not_found", `需求 ${id} 尚未绑定 GitHub Issue`, {
            messageKey: "github.errIssueNotLinked",
            messageParams: { id },
          });
        }
        const targetState =
          body.state === "closed" || body.state === "open"
            ? (body.state as "open" | "closed")
            : detail.state.stage === "cancelled"
              ? "closed"
              : undefined;
        const comment =
          typeof body.comment === "string" && body.comment.trim()
            ? body.comment.trim()
            : `Workbench 状态同步：需求 \`${id}\` 当前处于阶段 \`${detail.state.stage}\`（必需条件通过 ${detail.validity.coverage.requiredPassed}/${detail.validity.coverage.requiredTotal}${detail.state.github.pr ? ` · PR: ${detail.state.github.pr.url}` : ""}）。`;
        const synced = await trySyncIssueMilestone(base, detail, comment, {
          state: targetState,
          snapHash: snapshot?.fingerprint ?? null,
        });
        if (synced.warning) {
          throw new WorkbenchError(
            "execution_failed",
            synced.warning,
            synced.warningRef
              ? {
                  messageKey: synced.warningRef.key,
                  ...(synced.warningRef.params ? { messageParams: synced.warningRef.params } : {}),
                }
              : undefined,
          );
        }
        deps.broadcastUi({ type: "workbench.updated", reason: "github.issue_synced", root: base, id, at: Date.now() });
        return jsonResponse({ detail: synced.detail });
      }

      if (method === "POST" && sub === "github/pr-sync") {
        const body = await readBody(req);
        const hasSandbox = Boolean(getSandboxForRequirement(base, id));
        if (hasSandbox) {
          const synced = await syncRsiSandboxPrAndCleanup(
            base,
            id,
            { forceCleanup: body.forceCleanup === true },
            deps.githubDeps,
          );
          const reloadRes = synced.cleanedSandbox && synced.touchesWeb ? await deps.reloadWebBundle() : { reloaded: false };
          deps.broadcastUi({ type: "hub.updated", reason: "evolution.pr_synced", root: base, id, at: Date.now() });
          deps.broadcastUi({ type: "workbench.updated", reason: "github.pr_synced", root: base, id, at: Date.now() });
          return jsonResponse({
            ...synced,
            webReloaded: reloadRes.reloaded,
            restartRecommended: synced.cleanedSandbox && synced.touchesBackend,
          });
        }
        const snapshot = await observeGitSnapshot(base);
        const current = getRequirement(base, id, { currentCodeSnapshotHash: snapshot?.fingerprint ?? null });
        if (!current.state.github?.repo || !current.state.github?.pr) {
          throw new WorkbenchError("not_found", `需求 ${id} 尚未绑定 PR`, {
            messageKey: "github.errPrNotLinked",
            messageParams: { id },
          });
        }
        const isGiteePr =
          current.state.github.provider === "gitee" || /gitee\.com/i.test(current.state.github.pr.url);
        if (isGiteePr) {
          const token = resolveGiteeToken();
          if (!token) {
            throw new WorkbenchError("invalid_input", "尚未配置 Gitee 私人令牌 (Access Token)", {
              messageKey: "gitee.errTokenMissing",
            });
          }
          const latestPr = await viewGiteePr(
            { repo: current.state.github.repo, prNumber: current.state.github.pr.number, token },
            deps.giteeDeps,
          );
          const updated = await recordRequirementGitHubSync(base, id, {
            prPatch: latestPr,
            eventKind: "github_pr_synced",
            summary: `同步 Gitee PR !${latestPr.number} 状态：${latestPr.state}`,
            detail: latestPr.url,
            currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
          });
          deps.broadcastUi({ type: "workbench.updated", reason: "github.pr_synced", root: base, id, at: Date.now() });
          return jsonResponse({ detail: updated, pr: latestPr, cleanedSandbox: false, mainUpdated: false, mainSyncReason: null });
        }
        const latestPr = await viewGitHubPr(
          { root: base, repo: current.state.github.repo, prNumber: current.state.github.pr.number },
          deps.githubDeps,
        );
        const updated = await recordRequirementGitHubSync(base, id, {
          prPatch: latestPr,
          ...(latestPr.state === "merged" && current.state.github.issue ? { issuePatch: { state: "closed" } } : {}),
          eventKind: "github_pr_synced",
          summary: `同步 GitHub PR #${latestPr.number} 状态：${latestPr.state}`,
          detail: latestPr.url,
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        deps.broadcastUi({ type: "workbench.updated", reason: "github.pr_synced", root: base, id, at: Date.now() });
        return jsonResponse({ detail: updated, pr: latestPr, cleanedSandbox: false, mainUpdated: false, mainSyncReason: null });
      }

      if (method === "POST" && sub === "block") {
        const body = await readBody(req);
        const snapshot = await observeGitSnapshot(resolveCodeRoot(base, id));
        const detail = await blockRequirement(base, id, {
          reason: typeof body.reason === "string" ? body.reason : "",
          expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        deps.broadcastUi({ type: "workbench.updated", reason: "blocked", root: base, id, at: Date.now() });
        return jsonResponse({ detail });
      }

      if (method === "POST" && sub === "unblock") {
        const body = await readBody(req);
        const snapshot = await observeGitSnapshot(resolveCodeRoot(base, id));
        const detail = await unblockRequirement(base, id, {
          expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        deps.broadcastUi({ type: "workbench.updated", reason: "unblocked", root: base, id, at: Date.now() });
        return jsonResponse({ detail });
      }

      if (method === "POST" && sub === "cancel") {
        const body = await readBody(req);
        const snapshot = await observeGitSnapshot(resolveCodeRoot(base, id));
        const detail = await cancelRequirement(base, id, {
          reason: typeof body.reason === "string" ? body.reason : "",
          expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        deps.broadcastUi({ type: "workbench.updated", reason: "cancelled", root: base, id, at: Date.now() });
        return jsonResponse({ detail });
      }

      if (method === "POST" && sub === "reopen") {
        const body = await readBody(req);
        const snapshot = await observeGitSnapshot(resolveCodeRoot(base, id));
        const detail = await reopenRequirement(base, id, {
          reason: typeof body.reason === "string" ? body.reason : "",
          preserveApproval: body.preserveApproval === true,
          expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
          currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        });
        deps.broadcastUi({ type: "workbench.updated", reason: "reopened", root: base, id, at: Date.now() });
        return jsonResponse({ detail });
      }

      if (method === "POST" && sub === "dispatch") {
        const body = await readBody(req);
        const action = (
          body.action === "implement" || body.action === "fix" || body.action === "review" ? body.action : "design"
        ) as DispatchAction;
        const mode = body.mode === "prefill" ? "prefill" : "send";
        const snapshot = await observeGitSnapshot(resolveCodeRoot(base, id));
        let detail = getRequirement(base, id, { currentCodeSnapshotHash: snapshot?.fingerprint ?? null });

        if (action === "design" && detail.state.stage === "draft") {
          detail = await markDesigning(base, id, { currentCodeSnapshotHash: snapshot?.fingerprint ?? null });
          deps.broadcastUi({ type: "workbench.updated", reason: "designing", root: base, id, at: Date.now() });
        }

        const prompt = buildAgentPrompt(detail, action, { outputLanguage: resolveOutputLang(base, detail) });
        const dispatch = await deps.dispatchToBridge(id, action, mode, prompt);
        return jsonResponse({ detail, dispatch });
      }
    }

    return null;
  };
}
