import type { AgentAction } from "../core/types.ts";
import {
  HARNESS_IDS,
  ROUTING_PRESETS,
  ROUTING_STAGES,
  type HarnessId,
  type HarnessInfo,
  type ModelTarget,
  type RoutingConfig,
  type RoutingPreset,
  type RoutingStage,
  type StageRouteRule,
} from "./types.ts";

export function buildPresetRouting(preset: RoutingPreset): RoutingConfig {
  if (preset === "sota_first") {
    return {
      activePreset: "sota_first",
      stages: {
        design: {
          primary: { harness: "codex", model: "gpt-6.1-sol", reasoningEffort: "high" },
          fallbacks: [
            { harness: "qodercn", model: "DeepSeek-V4-Pro", reasoningEffort: "high" },
            { harness: "gemini", model: "default" },
          ],
        },
        implement: {
          primary: { harness: "codex", model: "gpt-6-astra", reasoningEffort: "medium" },
          fallbacks: [
            { harness: "qodercn", model: "DeepSeek-V4-Pro" },
            { harness: "qodercn", model: "Qwen4-Max" },
            { harness: "opencode", model: "opencode/deepseek-v4.1-flash-free" },
          ],
        },
        fix: {
          primary: { harness: "qodercn", model: "DeepSeek-V4-Pro" },
          fallbacks: [
            { harness: "codex", model: "gpt-6.1-sol", reasoningEffort: "medium" },
            { harness: "opencode", model: "opencode/deepseek-v4.1-flash-free" },
          ],
        },
        review: {
          primary: { harness: "gemini", model: "default" },
          fallbacks: [
            { harness: "qodercn", model: "Qwen4-Max" },
            { harness: "codex", model: "codex-auto-review" },
          ],
        },
      },
    };
  }

  if (preset === "quota_saver") {
    return {
      activePreset: "quota_saver",
      stages: {
        design: {
          primary: { harness: "qodercn", model: "DeepSeek-V4-Pro" },
          fallbacks: [
            { harness: "gemini", model: "default" },
            { harness: "qodercn", model: "Kimi-K3.1-Pro" },
          ],
        },
        implement: {
          primary: { harness: "opencode", model: "opencode/deepseek-v4.1-flash-free" },
          fallbacks: [
            { harness: "opencode", model: "opencode/glm-5.3-flash-free" },
            { harness: "qodercn", model: "Qwen3.8-Flash" },
          ],
        },
        fix: {
          primary: { harness: "opencode", model: "opencode/glm-5.3-flash-free" },
          fallbacks: [
            { harness: "qodercn", model: "Qwen3.8-Flash" },
            { harness: "qodercn", model: "Auto" },
            { harness: "opencode", model: "opencode/deepseek-v4.1-flash-free" },
          ],
        },
        review: {
          primary: { harness: "qodercn", model: "Qwen4-Max" },
          fallbacks: [
            { harness: "qodercn", model: "Qwen3.8-Flash" },
            { harness: "gemini", model: "default" },
            { harness: "codex", model: "codex-auto-review" },
          ],
        },
      },
    };
  }

  // Default: "balanced"
  return {
    activePreset: "balanced",
    stages: {
      design: {
        primary: { harness: "codex", model: "gpt-6-astra", reasoningEffort: "medium" },
        fallbacks: [
          { harness: "qodercn", model: "DeepSeek-V4-Pro", reasoningEffort: "high" },
          { harness: "gemini", model: "default" },
          { harness: "qodercn", model: "Qwen4-Max" },
        ],
      },
      implement: {
        primary: { harness: "qodercn", model: "Qwen4-Max" },
        fallbacks: [
          { harness: "opencode", model: "opencode/deepseek-v4.1-flash-free" },
          { harness: "opencode", model: "opencode/glm-5.3-flash-free" },
          { harness: "codex", model: "gpt-6-luna", reasoningEffort: "low" },
        ],
      },
      fix: {
        primary: { harness: "opencode", model: "opencode/deepseek-v4.1-flash-free" },
        fallbacks: [
          { harness: "qodercn", model: "Qwen3.8-Flash" },
          { harness: "qodercn", model: "DeepSeek-V4-Pro" },
          { harness: "codex", model: "gpt-6-astra", reasoningEffort: "medium" },
        ],
      },
      review: {
        primary: { harness: "codex", model: "codex-auto-review" },
        fallbacks: [
          { harness: "qodercn", model: "Qwen3.8-Flash" },
          { harness: "qodercn", model: "Auto" },
          { harness: "gemini", model: "default" },
          { harness: "qodercn", model: "DeepSeek-V4-Pro" },
        ],
      },
    },
  };
}

export function mapActionToRoutingStage(action: AgentAction): RoutingStage {
  if (action === "ask") return "design";
  return action;
}

export function sanitizeModelTarget(raw: unknown, fallback: ModelTarget): ModelTarget {
  if (!raw || typeof raw !== "object") return fallback;
  const obj = raw as Record<string, unknown>;
  const harness =
    typeof obj.harness === "string" && (HARNESS_IDS as readonly string[]).includes(obj.harness)
      ? (obj.harness as HarnessId)
      : fallback.harness;
  const model = typeof obj.model === "string" && obj.model.trim() ? obj.model.trim().slice(0, 200) : fallback.model;
  const effort =
    obj.reasoningEffort === "low" ||
    obj.reasoningEffort === "medium" ||
    obj.reasoningEffort === "high" ||
    obj.reasoningEffort === "xhigh"
      ? obj.reasoningEffort
      : undefined;
  return { harness, model, ...(effort ? { reasoningEffort: effort } : {}) };
}

export function normalizeRoutingConfig(raw: unknown): RoutingConfig {
  const defaults = buildPresetRouting("balanced");
  if (!raw || typeof raw !== "object") return defaults;
  const obj = raw as Record<string, unknown>;
  const activePreset: RoutingPreset =
    typeof obj.activePreset === "string" && (ROUTING_PRESETS as readonly string[]).includes(obj.activePreset)
      ? (obj.activePreset as RoutingPreset)
      : "balanced";
  const stagesRaw = obj.stages && typeof obj.stages === "object" ? (obj.stages as Record<string, unknown>) : {};
  const stages = { ...defaults.stages };
  for (const stage of ROUTING_STAGES) {
    const defRule = defaults.stages[stage];
    const candidate = stagesRaw[stage];
    if (!candidate || typeof candidate !== "object") continue;
    const ruleObj = candidate as Record<string, unknown>;
    const primary = sanitizeModelTarget(ruleObj.primary, defRule.primary);
    const fallbacks = Array.isArray(ruleObj.fallbacks)
      ? ruleObj.fallbacks
          .slice(0, 6)
          .map((item, idx) => sanitizeModelTarget(item, defRule.fallbacks[idx] ?? defRule.primary))
      : defRule.fallbacks;
    stages[stage] = { primary, fallbacks };
  }
  return { activePreset, stages };
}

/** Returns ordered execution targets for an action, honoring any explicit override first. */
export function resolveRouteCandidates(
  routing: RoutingConfig,
  harnesses: HarnessInfo[] | null,
  action: AgentAction,
  override?: Partial<ModelTarget> | null,
): ModelTarget[] {
  const stage = mapActionToRoutingStage(action);
  const rule: StageRouteRule = routing.stages[stage];
  const installedSet = harnesses ? new Set(harnesses.filter((h) => h.installed).map((h) => h.id)) : null;

  const rawList: ModelTarget[] = [];
  if (override?.harness && override?.model) {
    rawList.push({
      harness: override.harness,
      model: override.model,
      ...(override.reasoningEffort ? { reasoningEffort: override.reasoningEffort } : {}),
    });
  }
  rawList.push(rule.primary, ...rule.fallbacks);

  // Deduplicate by harness+model
  const seen = new Set<string>();
  const unique: ModelTarget[] = [];
  for (const item of rawList) {
    const key = `${item.harness}::${item.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  if (!installedSet || installedSet.size === 0) {
    return unique;
  }

  // Prefer targets whose harness is actually installed, while keeping override first if requested.
  const installedFirst = unique.filter((t, idx) => (idx === 0 && Boolean(override?.harness)) || installedSet.has(t.harness));
  return installedFirst.length > 0 ? installedFirst : unique;
}

const RATE_LIMIT_RE =
  /(rate[_\s-]?limit|too many requests|\b429\b|quota[_\s-]?(exceeded|exhausted|limit)|insufficient[_\s_]?quota|usage limit|credit balance|额度|限流|配额已用完)/i;

export function detectRateLimitOrQuotaError(output: string, exitCode: number | null): boolean {
  if (exitCode === 0) return false;
  return RATE_LIMIT_RE.test(output);
}
