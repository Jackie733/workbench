import {
  appendBugRegressionCriteria,
  getProjectStatus,
  getRequirement,
  getRequirementDiff,
  listRequirements,
  propose,
} from "../core/engine.ts";
import { WorkbenchError } from "../core/errors.ts";
import { canonicalRoot } from "../core/fs.ts";
import { observeGitSnapshot, resolveProjectRequirementSnapshots } from "../core/git.ts";
import { checkLanguageMismatchWarning, normalizeOutputLanguage, resolveEffectiveOutputLanguage } from "../core/language.ts";
import { runVerification } from "../core/runner.ts";
import { resolveCodeRoot } from "../core/sandbox.ts";
import { captureRequirementScreenshots } from "../core/screenshots.ts";
import { STAGES, type CriterionInput, type DecisionItem, type Stage } from "../core/types.ts";
import { isRecord, sanitizeOutput } from "../core/validate.ts";
import { readHubConfig } from "../hub/registry.ts";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const WORKBENCH_TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: "wb_list",
    description:
      "List requirements in the current workbench project with stage, track, task progress, and real-time verification coverage.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        scope: {
          type: "string",
          enum: ["active", "done", "cancelled", "all"],
          description: "Filter scope (defaults to 'active').",
        },
        stage: {
          type: "string",
          enum: [...STAGES],
          description: "Optional exact stage filter.",
        },
      },
    },
  },
  {
    name: "wb_get",
    description:
      "Get full details of one requirement including spec.md, design.md, acceptance criteria coverage, tasks, latest verification evidence, and human feedback.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: {
          type: "string",
          pattern: "^REQ-\\d{3,}$",
          description: "Requirement ID such as REQ-001.",
        },
        includeDiff: {
          type: "boolean",
          description: "Include current workspace git changed files and bounded unified diff.",
        },
      },
    },
  },
  {
    name: "wb_propose",
    description:
      "Propose or update requirement title, spec.md, acceptance criteria, and/or design.md. Automatically submits for human approval or invalidates stale approval if changed. Always write human-readable text in the project's configured outputLanguage (default Simplified Chinese zh-CN, visible in wb_get), keeping only code identifiers and shell commands verbatim.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", pattern: "^REQ-\\d{3,}$", description: "Requirement ID." },
        title: { type: "string", description: "Updated concise requirement title (in configured outputLanguage)." },
        spec: { type: "string", description: "Updated spec.md Markdown (goal & scope, in configured outputLanguage)." },
        criteria: {
          type: "array",
          description: "Complete list of acceptance criteria with optional verification commands or manual check steps.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["description"],
            properties: {
              id: { type: "string", description: "Stable ID such as AC-1." },
              description: { type: "string", description: "Human-readable description (in configured outputLanguage)." },
              kind: { type: "string", enum: ["command", "manual"], description: "Defaults to command when command is set." },
              required: { type: "boolean", description: "Defaults to true." },
              command: { type: "string", description: "Shell command that verifies this criterion." },
              steps: { type: "string", description: "Manual inspection steps when kind is manual." },
            },
          },
        },
        design: { type: "string", description: "Proposed technical design.md Markdown (in configured outputLanguage)." },
        decisions: {
          type: ["array", "null"],
          description: "Optional structured pending decision cards for human selection, or null to clear.",
        },
        summary: { type: "string", description: "Short timeline summary of this proposal (in configured outputLanguage)." },
        expectedRevision: { type: "integer", minimum: 1, description: "Optional optimistic lock revision." },
      },
    },
  },
  {
    name: "wb_screenshot",
    description:
      "Capture the default UI screenshot evidence matrix (home + requirement tabs, light/dark themes, desktop/narrow viewports) for a requirement. Best-effort: missing browser records a skipped batch without blocking acceptance.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", pattern: "^REQ-\\d{3,}$", description: "Requirement ID." },
        label: { type: "string", description: "Optional label prefix for captured shots." },
      },
    },
  },
  {
    name: "wb_verify",
    description:
      "Execute a real verification command in the project root, bind it to current git snapshot & specHash, and record immutable evidence.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id", "command", "criterionIds"],
      properties: {
        id: { type: "string", pattern: "^REQ-\\d{3,}$", description: "Requirement ID." },
        command: { type: "string", description: "Exact shell command to execute." },
        criterionIds: {
          type: "array",
          items: { type: "string" },
          description: "Acceptance criterion IDs verified by this command.",
        },
        timeoutMs: { type: "integer", minimum: 500, maximum: 1800000 },
      },
    },
  },
];

function assertAllowedKeys(obj: Record<string, unknown>, allowed: readonly string[], toolName: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new WorkbenchError("invalid_input", `工具 ${toolName} 不允许参数: ${key}`);
    }
  }
}

function asArgsRecord(args: unknown, toolName: string): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (!isRecord(args)) {
    throw new WorkbenchError("invalid_input", `工具 ${toolName} 的参数必须是 JSON 对象`);
  }
  return args;
}

export async function executeWorkbenchTool(
  root: string,
  name: string,
  rawArgs: unknown,
): Promise<unknown> {
  const base = canonicalRoot(root);
  const args = asArgsRecord(rawArgs, name);

  switch (name) {
    case "wb_list": {
      assertAllowedKeys(args, ["scope", "stage"], name);
      const scope = args.scope as "active" | "done" | "cancelled" | "all" | undefined;
      if (scope !== undefined && !["active", "done", "cancelled", "all"].includes(scope)) {
        throw new WorkbenchError("invalid_input", `无效的 scope: ${String(scope)}`);
      }
      const stage = args.stage as Stage | undefined;
      if (stage !== undefined && !STAGES.includes(stage)) {
        throw new WorkbenchError("invalid_input", `无效的 stage: ${String(stage)}`);
      }
      const { baseSnapshot: snapshot, byReqId } = await resolveProjectRequirementSnapshots(base);
      const items = listRequirements(base, {
        scope,
        stage,
        currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
        codeSnapshotsById: byReqId,
      });
      return {
        items,
        total: items.length,
        codeSnapshotHash: snapshot?.fingerprint ?? null,
      };
    }

    case "wb_get": {
      assertAllowedKeys(args, ["id", "includeDiff"], name);
      if (typeof args.id !== "string") {
        throw new WorkbenchError("invalid_input", "缺少字符串参数 id");
      }
      const includeDiff = args.includeDiff === true;
      const codeRoot = resolveCodeRoot(base, args.id);
      const snapshot = await observeGitSnapshot(codeRoot);
      const detail = getRequirement(base, args.id, {
        currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
      });
      const projectMeta = getProjectStatus(base).project;
      const outputLanguage = resolveEffectiveOutputLanguage({
        projectLanguage: projectMeta?.outputLanguage,
        hubLanguage: normalizeOutputLanguage(process.env.WORKBENCH_OUTPUT_LANGUAGE) ?? readHubConfig().outputLanguage,
        contextText: `${detail.state.title}\n${detail.specMarkdown}`,
      });
      const response: Record<string, unknown> = {
        id: detail.state.id,
        kind: detail.state.kind ?? "feature",
        title: detail.state.title,
        originalGoal: detail.state.originalGoal ?? detail.specMarkdown,
        stage: detail.state.stage,
        track: detail.state.track,
        tier: detail.state.tier,
        revision: detail.state.revision,
        designVersion: detail.state.designVersion,
        outputLanguage,
        github: detail.state.github ?? null,
        specMarkdown: detail.specMarkdown,
        designMarkdown: detail.designMarkdown,
        handoffMarkdown: detail.handoffMarkdown,
        pendingDecisions: detail.state.pendingDecisions ?? [],
        humanDecisions: detail.state.humanDecisions ?? [],
        manualChecks: detail.state.manualChecks ?? [],
        needsHuman: detail.state.needsHuman ?? null,
        discussions: (detail.state.discussions ?? []).slice(-20),
        reviewReport: detail.state.reviewReport ?? null,
        designReviewReport: detail.state.designReviewReport ?? null,
        designReviewValidity: detail.validity.designReviewValidity ?? null,
        lastFeedback: detail.state.lastFeedback,
        uiRelated: detail.state.uiRelated ?? false,
        screenshotBatches: detail.state.screenshotBatches ?? [],
        approval: detail.validity.approval,
        coverage: detail.validity.coverage,
        verifications: detail.validity.verifications.slice(-10).map((ev) => ({
          id: ev.record.id,
          command: ev.record.command,
          criterionIds: ev.record.criterionIds,
          effectiveState: ev.effectiveState,
          staleReason: ev.staleReason,
          exitCode: ev.record.exitCode,
          timedOut: ev.record.timedOut,
          durationMs: ev.record.durationMs,
          endedAt: ev.record.endedAt,
          outputPreview: sanitizeOutput(ev.record.outputPreview, 2048).text,
        })),
        acceptance: detail.state.acceptance,
        evidenceContext: detail.validity.evidenceContext,
        provenance: detail.validity.provenance,
        acceptanceGate: detail.validity.acceptanceGate,
        nextHeadline: detail.validity.banner.headline,
      };
      if (includeDiff) {
        const diffView = await getRequirementDiff(base, args.id, { maxDiffBytes: 24 * 1024 });
        const obs = diffView.observation;
        response.gitChanges = obs
          ? {
              context: diffView.context,
              status: diffView.status,
              reason: diffView.reason,
              acceptedAt: diffView.acceptedAt,
              snapshotId: diffView.snapshotId,
              scopeNote: diffView.scopeNote,
              head: obs.head,
              dirty: obs.dirty,
              files: obs.files,
              filesScope: obs.filesScope,
              commits: obs.commits,
              diff: sanitizeOutput(obs.diff, 24 * 1024).text,
              diffTruncated: obs.diffTruncated,
              binaryFiles: obs.binaryFiles,
              omittedFiles: obs.omittedFiles,
              testTamperingSignals: diffView.testTamperingSignals ?? [],
            }
          : {
              context: diffView.context,
              status: diffView.status,
              reason: diffView.reason,
              acceptedAt: diffView.acceptedAt,
              snapshotId: diffView.snapshotId,
              scopeNote: diffView.scopeNote,
              head: null,
              dirty: false,
              files: [],
              filesScope: "none",
              commits: [],
              diff: "",
              diffTruncated: false,
              binaryFiles: [],
              omittedFiles: [],
              testTamperingSignals: [],
            };
      }
      return response;
    }

    case "wb_propose": {
      assertAllowedKeys(args, ["id", "title", "spec", "criteria", "design", "decisions", "summary", "expectedRevision"], name);
      if (typeof args.id !== "string") {
        throw new WorkbenchError("invalid_input", "缺少字符串参数 id");
      }
      if (args.criteria !== undefined) {
        if (!Array.isArray(args.criteria)) {
          throw new WorkbenchError("invalid_input", "criteria 必须是数组");
        }
        for (const item of args.criteria) {
          if (!isRecord(item)) throw new WorkbenchError("invalid_input", "criteria 元素必须是对象");
          assertAllowedKeys(item, ["id", "description", "kind", "required", "command", "steps"], `${name}.criteria`);
        }
      }
      if (args.decisions !== undefined && args.decisions !== null && !Array.isArray(args.decisions)) {
        throw new WorkbenchError("invalid_input", "decisions 必须是数组或 null");
      }
      if (args.expectedRevision !== undefined && !Number.isSafeInteger(args.expectedRevision)) {
        throw new WorkbenchError("invalid_input", "expectedRevision 必须是正整数");
      }
      const snapshot = await observeGitSnapshot(resolveCodeRoot(base, args.id));
      const detail = await propose(base, args.id, {
        title: typeof args.title === "string" ? args.title : undefined,
        specMarkdown: typeof args.spec === "string" ? args.spec : undefined,
        criteria: args.criteria as CriterionInput[] | undefined,
        designMarkdown: typeof args.design === "string" ? args.design : undefined,
        decisions: args.decisions as DecisionItem[] | null | undefined,
        summary: typeof args.summary === "string" ? args.summary : undefined,
        expectedRevision: args.expectedRevision as number | undefined,
        actor: "agent",
        currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
      });
      const projectMeta = getProjectStatus(base).project;
      const outputLanguage = resolveEffectiveOutputLanguage({
        projectLanguage: projectMeta?.outputLanguage,
        hubLanguage: normalizeOutputLanguage(process.env.WORKBENCH_OUTPUT_LANGUAGE) ?? readHubConfig().outputLanguage,
        contextText: `${detail.state.title}\n${detail.specMarkdown}`,
      });
      const languageWarning = checkLanguageMismatchWarning(outputLanguage, {
        title: typeof args.title === "string" ? args.title : undefined,
        spec: typeof args.spec === "string" ? args.spec : undefined,
        design: typeof args.design === "string" ? args.design : undefined,
        criteriaDescriptions: Array.isArray(args.criteria)
          ? (args.criteria as CriterionInput[]).map((c) => c.description)
          : undefined,
      });
      return {
        id: detail.state.id,
        stage: detail.state.stage,
        track: detail.state.track,
        revision: detail.state.revision,
        designVersion: detail.state.designVersion,
        criteriaCount: detail.state.criteria.length,
        outputLanguage,
        ...(languageWarning ? { languageWarning } : {}),
        approval: detail.validity.approval,
        nextHeadline: detail.validity.banner.headline,
      };
    }

    case "wb_screenshot": {
      assertAllowedKeys(args, ["id", "label"], name);
      if (typeof args.id !== "string") {
        throw new WorkbenchError("invalid_input", "缺少字符串参数 id");
      }
      if (args.label !== undefined && typeof args.label !== "string") {
        throw new WorkbenchError("invalid_input", "label 必须是字符串");
      }
      if (typeof args.label === "string" && args.label.trim().length > 120) {
        throw new WorkbenchError("invalid_input", "label 不能超过 120 字符");
      }
      const snapshot = await observeGitSnapshot(resolveCodeRoot(base, args.id));
      const capture = await captureRequirementScreenshots(base, args.id, {
        trigger: "manual",
        actor: "agent",
        ...(typeof args.label === "string" && args.label.trim() ? { label: args.label.trim() } : {}),
        currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
      });
      return {
        id: args.id,
        status: capture.status,
        batchId: capture.batchId,
        reason: capture.reason,
        screenshotCapture: capture,
      };
    }

    case "wb_verify": {
      assertAllowedKeys(args, ["id", "command", "criterionIds", "timeoutMs"], name);
      if (typeof args.id !== "string" || typeof args.command !== "string" || !Array.isArray(args.criterionIds)) {
        throw new WorkbenchError("invalid_input", "wb_verify 需要 id、command 和 criterionIds 参数");
      }
      if (args.criterionIds.some((c) => typeof c !== "string")) {
        throw new WorkbenchError("invalid_input", "criterionIds 元素必须是字符串");
      }
      const res = await runVerification(base, args.id, {
        command: args.command,
        criterionIds: args.criterionIds as string[],
        timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
      });
      return {
        id: res.detail.state.id,
        stage: res.detail.state.stage,
        revision: res.detail.state.revision,
        verification: {
          id: res.record.id,
          command: res.record.command,
          criterionIds: res.record.criterionIds,
          passed: res.record.passed,
          exitCode: res.record.exitCode,
          timedOut: res.record.timedOut,
          durationMs: res.record.durationMs,
          outputPreview: sanitizeOutput(res.log, 8192).text,
          truncated: res.record.truncated,
        },
        coverage: res.detail.validity.coverage,
        acceptanceGate: res.detail.validity.acceptanceGate,
      };
    }

    default:
      throw new WorkbenchError("invalid_input", `未知或禁止的工作台工具: ${name}`);
  }
}
