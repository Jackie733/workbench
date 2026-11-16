import { getRequirement, listRequirements, propose, updateTasks } from "../core/engine.ts";
import { WorkbenchError } from "../core/errors.ts";
import { canonicalRoot } from "../core/fs.ts";
import { observeGitChanges, observeGitSnapshot } from "../core/git.ts";
import { runVerification } from "../core/runner.ts";
import { STAGES, TASK_STATUSES, type CriterionInput, type Stage, type TaskInput } from "../core/types.ts";
import { isRecord, sanitizeOutput } from "../core/validate.ts";

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
      "Propose or update requirement title, spec.md, acceptance criteria, and/or design.md. Automatically submits for human approval or invalidates stale approval if changed.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", pattern: "^REQ-\\d{3,}$", description: "Requirement ID." },
        title: { type: "string", description: "Updated concise requirement title." },
        spec: { type: "string", description: "Updated spec.md Markdown (goal & scope)." },
        criteria: {
          type: "array",
          description: "Complete list of acceptance criteria with optional verification commands.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["description"],
            properties: {
              id: { type: "string", description: "Stable ID such as AC-1." },
              description: { type: "string" },
              required: { type: "boolean", description: "Defaults to true." },
              command: { type: "string", description: "Shell command that verifies this criterion." },
            },
          },
        },
        design: { type: "string", description: "Proposed technical design.md Markdown." },
        summary: { type: "string", description: "Short timeline summary of this proposal." },
        handoffNote: {
          type: "object",
          additionalProperties: false,
          description: "Optional concise context handoff memo for downstream agents.",
          properties: {
            keyDecisions: { type: "array", items: { type: "string" } },
            deadEnds: { type: "array", items: { type: "string" } },
            nextSteps: { type: "array", items: { type: "string" } },
          },
        },
        expectedRevision: { type: "integer", minimum: 1, description: "Optional optimistic lock revision." },
      },
    },
  },
  {
    name: "wb_update_tasks",
    description:
      "Update implementation tasks checklist for a requirement, or submit for human acceptance once all required criteria pass on the current git snapshot.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", pattern: "^REQ-\\d{3,}$", description: "Requirement ID." },
        tasks: {
          type: "array",
          description: "Complete ordered implementation task checklist.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "status"],
            properties: {
              id: { type: "string", description: "Preserve existing T-N ID when updating." },
              title: { type: "string" },
              status: { type: "string", enum: [...TASK_STATUSES] },
              note: { type: "string" },
            },
          },
        },
        readyForAcceptance: {
          type: "boolean",
          description: "Set true after all required criteria pass verification to move stage to awaiting_acceptance.",
        },
        note: { type: "string", description: "Short summary of progress or delivery." },
        handoffNote: {
          type: "object",
          additionalProperties: false,
          description: "Optional concise handoff memo (key decisions, dead ends to avoid, next steps).",
          properties: {
            keyDecisions: { type: "array", items: { type: "string" } },
            deadEnds: { type: "array", items: { type: "string" } },
            nextSteps: { type: "array", items: { type: "string" } },
          },
        },
        expectedRevision: { type: "integer", minimum: 1 },
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
        timeoutMs: { type: "integer", minimum: 500, maximum: 300000 },
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
      const snapshot = await observeGitSnapshot(base);
      const items = listRequirements(base, {
        scope,
        stage,
        currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
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
      const snapshot = await observeGitSnapshot(base);
      const detail = getRequirement(base, args.id, {
        currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
      });
      const response: Record<string, unknown> = {
        id: detail.state.id,
        title: detail.state.title,
        stage: detail.state.stage,
        track: detail.state.track,
        revision: detail.state.revision,
        designVersion: detail.state.designVersion,
        specMarkdown: detail.specMarkdown,
        designMarkdown: detail.designMarkdown,
        handoffMarkdown: detail.handoffMarkdown,
        handoffNote: detail.state.handoffNote ?? null,
        discussions: (detail.state.discussions ?? []).slice(-20),
        reviewReport: detail.state.reviewReport ?? null,
        lastFeedback: detail.state.lastFeedback,
        blockedReason: detail.state.blockedReason,
        approval: detail.validity.approval,
        coverage: detail.validity.coverage,
        tasks: detail.state.tasks,
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
        acceptanceGate: detail.validity.acceptanceGate,
        nextHeadline: detail.validity.banner.headline,
      };
      if (includeDiff) {
        const changes = await observeGitChanges(base, {
          sinceHead: detail.state.baseline?.head ?? null,
          maxDiffBytes: 24 * 1024,
        });
        response.gitChanges = {
          head: changes.head,
          dirty: changes.dirty,
          files: changes.files,
          diff: sanitizeOutput(changes.diff, 24 * 1024).text,
          diffTruncated: changes.diffTruncated,
        };
      }
      return response;
    }

    case "wb_propose": {
      assertAllowedKeys(args, ["id", "title", "spec", "criteria", "design", "summary", "handoffNote", "expectedRevision"], name);
      if (typeof args.id !== "string") {
        throw new WorkbenchError("invalid_input", "缺少字符串参数 id");
      }
      if (args.criteria !== undefined) {
        if (!Array.isArray(args.criteria)) {
          throw new WorkbenchError("invalid_input", "criteria 必须是数组");
        }
        for (const item of args.criteria) {
          if (!isRecord(item)) throw new WorkbenchError("invalid_input", "criteria 元素必须是对象");
          assertAllowedKeys(item, ["id", "description", "required", "command"], `${name}.criteria`);
        }
      }
      if (args.expectedRevision !== undefined && !Number.isSafeInteger(args.expectedRevision)) {
        throw new WorkbenchError("invalid_input", "expectedRevision 必须是正整数");
      }
      const snapshot = await observeGitSnapshot(base);
      const detail = await propose(base, args.id, {
        title: typeof args.title === "string" ? args.title : undefined,
        specMarkdown: typeof args.spec === "string" ? args.spec : undefined,
        criteria: args.criteria as CriterionInput[] | undefined,
        designMarkdown: typeof args.design === "string" ? args.design : undefined,
        summary: typeof args.summary === "string" ? args.summary : undefined,
        handoffNote: isRecord(args.handoffNote)
          ? (args.handoffNote as { keyDecisions?: string[]; deadEnds?: string[]; nextSteps?: string[] })
          : undefined,
        expectedRevision: args.expectedRevision as number | undefined,
        actor: "agent",
        currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
      });
      return {
        id: detail.state.id,
        stage: detail.state.stage,
        track: detail.state.track,
        revision: detail.state.revision,
        designVersion: detail.state.designVersion,
        criteriaCount: detail.state.criteria.length,
        approval: detail.validity.approval,
        nextHeadline: detail.validity.banner.headline,
      };
    }

    case "wb_update_tasks": {
      assertAllowedKeys(args, ["id", "tasks", "readyForAcceptance", "note", "handoffNote", "expectedRevision"], name);
      if (typeof args.id !== "string") {
        throw new WorkbenchError("invalid_input", "缺少字符串参数 id");
      }
      if (args.tasks !== undefined) {
        if (!Array.isArray(args.tasks)) {
          throw new WorkbenchError("invalid_input", "tasks 必须是数组");
        }
        for (const item of args.tasks) {
          if (!isRecord(item)) throw new WorkbenchError("invalid_input", "tasks 元素必须是对象");
          assertAllowedKeys(item, ["id", "title", "status", "note"], `${name}.tasks`);
        }
      }
      if (args.expectedRevision !== undefined && !Number.isSafeInteger(args.expectedRevision)) {
        throw new WorkbenchError("invalid_input", "expectedRevision 必须是正整数");
      }
      const snapshot = await observeGitSnapshot(base);
      const detail = await updateTasks(base, args.id, {
        tasks: args.tasks as TaskInput[] | undefined,
        readyForAcceptance: args.readyForAcceptance === true,
        note: typeof args.note === "string" ? args.note : undefined,
        handoffNote: isRecord(args.handoffNote)
          ? (args.handoffNote as { keyDecisions?: string[]; deadEnds?: string[]; nextSteps?: string[] })
          : undefined,
        expectedRevision: args.expectedRevision as number | undefined,
        actor: "agent",
        currentCodeSnapshotHash: snapshot?.fingerprint ?? null,
      });
      return {
        id: detail.state.id,
        stage: detail.state.stage,
        revision: detail.state.revision,
        tasks: detail.state.tasks,
        acceptanceGate: detail.validity.acceptanceGate,
        nextHeadline: detail.validity.banner.headline,
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
