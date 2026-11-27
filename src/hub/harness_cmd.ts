import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile } from "../core/fs.ts";
import type { AgentAction, HarnessId } from "../core/types.ts";
import { resolveHubDir } from "./registry.ts";
import type { HarnessInfo, ModelTarget } from "./types.ts";

export interface BuiltCommand {
  command: string;
  args: string[];
  displayCommand: string;
}

export interface HarnessIsolationCapability {
  harness: HarnessId;
  supported: boolean;
  cliFlags: readonly string[];
  envOverrides: Readonly<Record<string, string>>;
  note: string;
}

/**
 * Explicit per-harness support matrix for isolating unrelated user-global skills/hooks/extensions
 * during headless Workbench runs while preserving repository instructions and normal read/write tools (WB-17 / FLOW §1.6).
 */
export const HARNESS_ISOLATION_MATRIX: Readonly<Record<HarnessId, HarnessIsolationCapability>> = {
  omp: {
    harness: "omp",
    supported: true,
    cliFlags: ["--no-skills", "--no-extensions"],
    envOverrides: {},
    note: "Disables global skills and extension discovery while keeping built-in tools and repo context files.",
  },
  agy: {
    harness: "agy",
    supported: true,
    cliFlags: ["--disable-slash-commands"],
    envOverrides: {},
    note: "Disables user global slash command and skill expansion in print mode while keeping built-in tools.",
  },
  qodercn: {
    harness: "qodercn",
    supported: true,
    cliFlags: ["--setting-sources", "project,local"],
    envOverrides: {},
    note: "Loads project and local setting sources only, isolating unrelated user-global skills and hooks.",
  },
  opencode: {
    harness: "opencode",
    supported: true,
    cliFlags: [],
    envOverrides: {
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    },
    note: "Disables external Claude Code user-global skill auto-loading via env while preserving OPENCODE_CONFIG_CONTENT tool guards.",
  },
  codex: {
    harness: "codex",
    supported: false,
    cliFlags: [],
    envOverrides: {},
    note: "codex exec reads auth and provider settings from ~/.codex/config.toml and exposes no standalone skill-isolation flag.",
  },
};

export function buildHarnessIsolationEnv(
  harness: HarnessId,
  options: { isolateGlobalConfig?: boolean } = {},
): Record<string, string> {
  if (options.isolateGlobalConfig === false) return {};
  const cap = HARNESS_ISOLATION_MATRIX[harness];
  return cap?.supported ? { ...cap.envOverrides } : {};
}

export type TimeoutReason = "idle" | "max_duration";

export type CustomCommandBuilder = (
  target: ModelTarget,
  ctx: {
    root: string;
    requirementId: string;
    action: AgentAction;
    prompt: string;
    nativeSessionId?: string;
    allowResumeOnReview?: boolean;
    harnesses: HarnessInfo[];
    structuredJson?: boolean;
  },
) => BuiltCommand;

const ACTION_TIMEOUT_DEFAULTS: Record<AgentAction, { idleTimeoutMs: number; maxDurationMs: number }> = {
  ask: { idleTimeoutMs: 5 * 60_000, maxDurationMs: 20 * 60_000 },
  design: { idleTimeoutMs: 10 * 60_000, maxDurationMs: 60 * 60_000 },
  review: { idleTimeoutMs: 10 * 60_000, maxDurationMs: 60 * 60_000 },
  implement: { idleTimeoutMs: 15 * 60_000, maxDurationMs: 2 * 60 * 60_000 },
  fix: { idleTimeoutMs: 15 * 60_000, maxDurationMs: 2 * 60 * 60_000 },
};

/** Resolves sliding inactivity watchdog and protective wall-clock ceiling for a run. */
export function resolveRunTimeouts(
  action: AgentAction,
  overrides: { timeoutMs?: number; idleTimeoutMs?: number } = {},
): { idleTimeoutMs: number; maxDurationMs: number } {
  const defaults = ACTION_TIMEOUT_DEFAULTS[action] ?? ACTION_TIMEOUT_DEFAULTS.implement;
  const maxDurationMs =
    typeof overrides.timeoutMs === "number" && Number.isFinite(overrides.timeoutMs) && overrides.timeoutMs > 0
      ? Math.floor(overrides.timeoutMs)
      : defaults.maxDurationMs;
  const rawIdle =
    typeof overrides.idleTimeoutMs === "number" && Number.isFinite(overrides.idleTimeoutMs) && overrides.idleTimeoutMs > 0
      ? Math.floor(overrides.idleTimeoutMs)
      : Math.min(defaults.idleTimeoutMs, maxDurationMs);
  return {
    idleTimeoutMs: Math.min(rawIdle, maxDurationMs),
    maxDurationMs,
  };
}

export function ensureWbShim(cliEntryPath: string): string {
  const binDir = path.join(resolveHubDir(), "bin");
  fs.mkdirSync(binDir, { recursive: true, mode: 0o755 });
  const shimPath = path.join(binDir, "wb");
  const content = `#!/usr/bin/env bash\nexec bun run ${JSON.stringify(cliEntryPath)} "$@"\n`;
  if (!fs.existsSync(shimPath) || fs.readFileSync(shimPath, "utf8") !== content) {
    atomicWriteFile(shimPath, content, 0o755);
  }
  return binDir;
}

const QODER_PRINT_MODE_GUARD =
  "Non-interactive -p print mode: NEVER run Bash/shell commands in the background (never set run_in_background=true, never trail commands with &), and NEVER end your turn waiting for a background notification (ending the turn immediately exits the CLI and kills running child processes). Execute checks synchronously and output the complete final response in this turn.";

export const NON_FATAL_FORM_CANCEL_RE = /Cancelled a request for input this run cannot answer:/i;

const SESSION_EXPIRED_RE =
  /(session[_\s-]?(not[_\s-]?found|expired|invalid|missing)|conversation[_\s-]?(not[_\s-]?found|expired|invalid)|unknown[_\s-]?session|cannot resume session|会话不存在|会话已过期)/i;

export function isSessionExpiredError(rawLog: string, exitCode: number | null): boolean {
  if (exitCode === 0) return false;
  const tail = rawLog.length > 4096 ? rawLog.slice(-4096) : rawLog;
  return SESSION_EXPIRED_RE.test(tail);
}

/**
 * Builds OPENCODE_CONFIG_CONTENT for headless runs.
 * Preserves websearch capability while enforcing read-only tool guards on ask/review actions.
 */
export function buildOpencodeNonInteractiveConfig(
  existingRaw?: string,
  options: { readOnly?: boolean } = {},
): string {
  let baseObj: Record<string, unknown> = {};
  if (existingRaw?.trim()) {
    try {
      const parsed = JSON.parse(existingRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        baseObj = { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      // Ignore malformed inherited JSON.
    }
  }
  const existingTools =
    baseObj.tools && typeof baseObj.tools === "object" && !Array.isArray(baseObj.tools)
      ? (baseObj.tools as Record<string, unknown>)
      : {};
  const tools: Record<string, unknown> = {
    ...existingTools,
    ...(options.readOnly ? { write: false, edit: false, patch: false } : {}),
  };
  return JSON.stringify({
    ...baseObj,
    ...(Object.keys(tools).length > 0 ? { tools } : {}),
  });
}

export function buildHarnessCommand(
  target: ModelTarget,
  ctx: {
    root: string;
    action: AgentAction;
    prompt: string;
    nativeSessionId?: string;
    allowResumeOnReview?: boolean;
    harnesses: HarnessInfo[];
    structuredJson?: boolean;
    /** Defaults to true: inject harness-specific global skill/hook isolation flags where supported (WB-17). */
    isolateGlobalConfig?: boolean;
  },
): BuiltCommand {
  const info = ctx.harnesses.find((h) => h.id === target.harness);
  const exe = info?.executable;
  const model = target.model;
  const effort = target.reasoningEffort;
  const structuredJson = ctx.structuredJson !== false;
  const isolateGlobal = ctx.isolateGlobalConfig !== false;
  const isolationFlags = isolateGlobal ? [...HARNESS_ISOLATION_MATRIX[target.harness].cliFlags] : [];
  const isReadOnly = ctx.action === "ask" || ctx.action === "review";
  const effectiveSessionId =
    ctx.nativeSessionId && (ctx.action !== "review" || ctx.allowResumeOnReview === true)
      ? ctx.nativeSessionId
      : undefined;

  switch (target.harness) {
    case "codex": {
      const bin = exe || "codex";
      const modelFlags = model && model !== "default" ? ["-m", model] : [];
      const effortFlags = effort ? ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`] : [];
      const summarySelection = `(model=${model}${effort ? `, effort=${effort}` : ""})`;

      if (effectiveSessionId) {
        const resumeSafetyFlags = isReadOnly
          ? ["-c", 'sandbox_mode="read-only"']
          : ["--dangerously-bypass-approvals-and-sandbox"];
        const args = [
          "exec",
          "resume",
          ...(structuredJson ? ["--json"] : []),
          "--skip-git-repo-check",
          ...modelFlags,
          ...effortFlags,
          ...resumeSafetyFlags,
          effectiveSessionId,
          ctx.prompt,
        ];
        return {
          command: bin,
          args,
          displayCommand: `${bin} exec resume ${structuredJson ? "--json " : ""}${effectiveSessionId} ${summarySelection}`,
        };
      }
      const safetyFlags = isReadOnly ? ["-s", "read-only"] : ["--dangerously-bypass-approvals-and-sandbox"];
      const args = [
        "exec",
        ...(structuredJson ? ["--json"] : []),
        "-C",
        ctx.root,
        "--skip-git-repo-check",
        ...modelFlags,
        ...effortFlags,
        ...safetyFlags,
        ctx.prompt,
      ];
      return {
        command: bin,
        args,
        displayCommand: `${bin} exec ${structuredJson ? "--json " : ""}-C ${ctx.root} ${safetyFlags.join(" ")} ${summarySelection}`,
      };
    }

    case "qodercn": {
      const bin = exe || "qodercn";
      const modelInfo = info?.models.find((m) => m.id === model);
      const effortAllowed =
        model !== "Auto" &&
        model !== "Fast" &&
        (!modelInfo?.supportedEfforts || modelInfo.supportedEfforts.length > 0) &&
        !modelInfo?.effortLocked;
      const permissionFlags = isReadOnly ? ["--permission-mode", "auto"] : ["--dangerously-skip-permissions"];
      const args = [
        "-w",
        ctx.root,
        ...(structuredJson ? ["-o", "stream-json"] : []),
        ...permissionFlags,
        ...isolationFlags,
        "--append-system-prompt",
        QODER_PRINT_MODE_GUARD,
        ...(model && model !== "default" && model !== "Auto" ? ["-m", model] : []),
        ...(effort && effortAllowed ? ["--reasoning-effort", effort] : []),
        ...(effectiveSessionId ? ["-r", effectiveSessionId] : []),
        "-p",
        ctx.prompt,
      ];
      return {
        command: bin,
        args,
        displayCommand: `${bin} -p${structuredJson ? " -o stream-json" : ""} ${permissionFlags.join(" ")} -m ${model}${effectiveSessionId ? ` -r ${effectiveSessionId}` : ""}`,
      };
    }

    case "opencode": {
      const bin = exe || "opencode";
      const args = [
        "run",
        ...(structuredJson ? ["--format", "json"] : []),
        "--standalone",
        ...(isReadOnly ? [] : ["--auto"]),
        ...(model && model !== "default" ? ["--model", model] : []),
        ...(effort && effort !== "minimal" ? ["--thinking"] : []),
        ...(effectiveSessionId ? ["--session", effectiveSessionId] : []),
        ctx.prompt,
      ];
      return {
        command: bin,
        args,
        displayCommand: `${bin} run${structuredJson ? " --format json" : ""} --standalone${isReadOnly ? "" : " --auto"} --model ${model}`,
      };
    }

    case "agy": {
      const bin = exe || "agy";
      const usePlanMode = isReadOnly;
      const modelInfo =
        info?.models.find((m) => m.id === model) ??
        info?.models.find((m) => m.effortVariants && Object.values(m.effortVariants).includes(model));
      const agyEffortRaw =
        effort && (effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh" || effort === "max")
          ? effort
          : undefined;
      let resolvedModel = model;
      let resolvedEffort = agyEffortRaw;
      if (modelInfo?.effortVariants) {
        const targetEff = resolvedEffort ?? modelInfo.defaultEffort;
        if (targetEff && modelInfo.effortVariants[targetEff]) {
          resolvedModel = modelInfo.effortVariants[targetEff]!;
          resolvedEffort =
            targetEff === "low" || targetEff === "medium" || targetEff === "high" || targetEff === "xhigh" || targetEff === "max"
              ? targetEff
              : resolvedEffort;
        } else if (modelInfo.defaultEffort && modelInfo.effortVariants[modelInfo.defaultEffort]) {
          resolvedModel = modelInfo.effortVariants[modelInfo.defaultEffort]!;
        } else {
          const firstVariant = Object.values(modelInfo.effortVariants)[0];
          if (firstVariant) resolvedModel = firstVariant;
        }
      } else if (modelInfo?.effortLocked) {
        resolvedEffort =
          modelInfo.defaultEffort &&
          (modelInfo.defaultEffort === "low" ||
            modelInfo.defaultEffort === "medium" ||
            modelInfo.defaultEffort === "high" ||
            modelInfo.defaultEffort === "xhigh" ||
            modelInfo.defaultEffort === "max")
            ? modelInfo.defaultEffort
            : undefined;
      } else if (modelInfo?.supportedEfforts && modelInfo.supportedEfforts.length === 0) {
        resolvedEffort = undefined;
      }

      const modeFlags = usePlanMode ? ["--mode", "plan"] : [];
      const permissionFlags = usePlanMode ? [] : ["--dangerously-skip-permissions"];
      const args = [
        "-p",
        ctx.prompt,
        ...(structuredJson ? ["--output-format", "stream-json"] : []),
        ...modeFlags,
        ...permissionFlags,
        ...isolationFlags,
        ...(resolvedModel && resolvedModel !== "default" ? ["--model", resolvedModel] : []),
        ...(resolvedEffort ? ["--effort", resolvedEffort] : []),
        ...(effectiveSessionId ? ["--conversation", effectiveSessionId] : []),
      ];
      return {
        command: bin,
        args,
        displayCommand: `${bin} -p${structuredJson ? " --output-format stream-json" : ""}${usePlanMode ? " --mode plan" : ""} (model=${resolvedModel})`,
      };
    }

    case "omp": {
      const bin = exe || "omp";
      const args = [
        "-p",
        ...(structuredJson ? ["--mode=json"] : []),
        `--cwd=${ctx.root}`,
        ...isolationFlags,
        ...(model && model !== "default" ? [`--model=${model}`] : []),
        ...(effort ? [`--thinking=${effort}`] : []),
        ...(effectiveSessionId ? [`--resume=${effectiveSessionId}`] : []),
        ctx.prompt,
      ];
      return {
        command: bin,
        args,
        displayCommand: `${bin} -p${structuredJson ? " --mode=json" : ""} --model=${model}`,
      };
    }
  }
}
