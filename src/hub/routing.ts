import type { AgentAction } from "../core/types.ts";
import { isModelCoolingDown } from "./telemetry.ts";
import {
  HARNESS_IDS,
  REASONING_EFFORTS,
  ROUTING_PRESETS,
  ROUTING_STAGES,
  type DiscoveredModel,
  type HarnessId,
  type HarnessInfo,
  type ModelTarget,
  type ReasoningEffort,
  type RoutingConfig,
  type RoutingPreset,
  type RoutingStage,
  type StageRouteRule,
} from "./types.ts";

function buildStaticPresetRouting(preset: RoutingPreset): RoutingConfig {
  if (preset === "sota_first") {
    return {
      activePreset: "sota_first",
      stages: {
        design: {
          primary: { harness: "codex", model: "gpt-6.2-astra", reasoningEffort: "high" },
          fallbacks: [
            { harness: "agy", model: "gemini-4-hydrogen", reasoningEffort: "high" },
            { harness: "agy", model: "claude-opus-5-5", reasoningEffort: "high" },
            { harness: "qodercn", model: "Kimi-K3.1-Pro", reasoningEffort: "high" },
          ],
        },
        implement: {
          primary: { harness: "codex", model: "gpt-6.2-sol", reasoningEffort: "medium" },
          fallbacks: [
            { harness: "agy", model: "claude-sonnet-5-5", reasoningEffort: "medium" },
            { harness: "qodercn", model: "Qwen4-Max" },
            { harness: "opencode", model: "opencode/deepseek-v4.1-flash-free" },
          ],
        },
        fix: {
          primary: { harness: "codex", model: "gpt-6.2-sol", reasoningEffort: "medium" },
          fallbacks: [
            { harness: "agy", model: "gemini-4-argon", reasoningEffort: "medium" },
            { harness: "qodercn", model: "Qwen4-Max" },
            { harness: "opencode", model: "opencode/deepseek-v4.1-flash-free" },
          ],
        },
        review: {
          primary: { harness: "agy", model: "gemini-4-argon", reasoningEffort: "high" },
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
          primary: { harness: "qodercn", model: "Qwen4-Max" },
          fallbacks: [
            { harness: "agy", model: "gemini-3.8-flash", reasoningEffort: "medium" },
            { harness: "qodercn", model: "Kimi-K3.1-Pro" },
            { harness: "qodercn", model: "DeepSeek-V4-Pro" },
          ],
        },
        implement: {
          primary: { harness: "opencode", model: "opencode/deepseek-v4.1-flash-free" },
          fallbacks: [
            { harness: "opencode", model: "opencode/glm-5.3-flash-free" },
            { harness: "qodercn", model: "DeepSeek-Flash" },
            { harness: "agy", model: "gemini-3.8-flash", reasoningEffort: "low" },
          ],
        },
        fix: {
          primary: { harness: "opencode", model: "opencode/glm-5.3-flash-free" },
          fallbacks: [
            { harness: "opencode", model: "opencode/deepseek-v4.1-flash-free" },
            { harness: "qodercn", model: "DeepSeek-Flash" },
            { harness: "qodercn", model: "Qwen3.8-Flash" },
          ],
        },
        review: {
          primary: { harness: "qodercn", model: "Qwen4-Max" },
          fallbacks: [
            { harness: "agy", model: "gemini-3.8-flash", reasoningEffort: "medium" },
            { harness: "qodercn", model: "DeepSeek-Flash" },
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
        primary: { harness: "codex", model: "gpt-6.2-sol", reasoningEffort: "low" },
        fallbacks: [
          { harness: "agy", model: "gemini-4-argon", reasoningEffort: "medium" },
          { harness: "qodercn", model: "Qwen4-Max" },
          { harness: "qodercn", model: "Kimi-K3.1-Pro" },
        ],
      },
      implement: {
        primary: { harness: "qodercn", model: "Qwen4-Max" },
        fallbacks: [
          { harness: "codex", model: "gpt-6.1-terra", reasoningEffort: "low" },
          { harness: "opencode", model: "opencode/deepseek-v4.1-flash-free" },
          { harness: "agy", model: "gemini-3.8-flash", reasoningEffort: "medium" },
        ],
      },
      fix: {
        primary: { harness: "opencode", model: "opencode/deepseek-v4.1-flash-free" },
        fallbacks: [
          { harness: "agy", model: "gemini-3.8-flash", reasoningEffort: "medium" },
          { harness: "qodercn", model: "DeepSeek-Flash" },
          { harness: "codex", model: "gpt-6.2-sol", reasoningEffort: "low" },
        ],
      },
      review: {
        primary: { harness: "codex", model: "codex-auto-review" },
        fallbacks: [
          { harness: "agy", model: "gemini-4-argon", reasoningEffort: "medium" },
          { harness: "qodercn", model: "Qwen4-Max" },
          { harness: "qodercn", model: "DeepSeek-Flash" },
        ],
      },
    },
  };
}

const EFFORT_RANK: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra", "auto"];

export function clampEffortForModel(
  model: DiscoveredModel,
  desired?: ReasoningEffort,
): ReasoningEffort | undefined {
  if (!desired) return undefined;
  if (model.effortLocked) return undefined;
  const supported = model.supportedEfforts;
  if (!supported) return desired;
  if (supported.length === 0) return undefined;
  if (supported.includes(desired)) return desired;
  const desiredIdx = EFFORT_RANK.indexOf(desired);
  let best = supported[0]!;
  let bestDist = Infinity;
  for (const eff of supported) {
    const dist = Math.abs(EFFORT_RANK.indexOf(eff) - desiredIdx);
    if (dist < bestDist) {
      bestDist = dist;
      best = eff;
    }
  }
  return best;
}

function estimateBaseCapability(harnessId: HarnessId, model: DiscoveredModel): number {
  const lower = model.id.toLowerCase();
  let score = model.intelligence;
  if (score === undefined) {
    if (model.tier === "review") score = 48;
    else if (lower.includes("astra")) score = 57;
    else if (lower.includes("opus")) score = 57;
    else if (lower.includes("hydrogen")) score = 54.5;
    else if (lower.includes("gpt-6.2-sol")) score = 55;
    else if (lower.includes("sonnet")) score = 55;
    else if (lower.includes("argon")) score = 52.5;
    else if (lower.includes("sol")) score = 51;
    else if (lower.includes("kimi-k3.1-pro")) score = 46.5;
    else if (lower.includes("qwen4-max")) score = 43;
    else if (lower.includes("terra")) score = 42;
    else if (model.tier === "sota") score = 46;
    else if (model.tier === "balanced") score = 34;
    else score = 24;
  }

  // Prefer current-generation models and official high-priority Codex picks.
  if (model.isLegacy) score -= 18;
  if (typeof model.priority === "number" && model.priority <= 2) score += 3;
  else if (typeof model.priority === "number" && model.priority === 3) score += 1;

  // Prefer native CLI harnesses over multi-provider aggregator harnesses when capabilities match.
  if (harnessId === "omp") score -= 14;
  if (harnessId === "opencode" && model.id.startsWith("opencode-go/")) score -= 6;
  // Slightly prefer proven coding families among unrated fast/free models.
  if (model.intelligence === undefined && model.tier === "fast" && /(deepseek|glm-5|qwen|gemini)/i.test(lower)) {
    score += 2;
  }
  // Avoid generic Auto/Fast aliases or orchestrator meta-models unless explicitly chosen.
  if (model.id === "Auto" || model.id === "Fast") score -= 8;
  if (lower.includes("orchestrator")) score -= 6;

  return score;
}

function isExpensiveFlagship(model: DiscoveredModel): boolean {
  if (model.cost && model.cost.output >= 25) return true;
  const lower = model.id.toLowerCase();
  return lower.includes("astra") || lower.includes("opus") || lower.includes("hydrogen");
}

function isWorkhorseCodingModel(model: DiscoveredModel): boolean {
  const lower = model.id.toLowerCase();
  return (
    lower.includes("sol") ||
    lower.includes("sonnet") ||
    lower.includes("argon") ||
    lower.includes("qwen4-max") ||
    lower.includes("terra")
  );
}

function desiredEffortForStage(preset: RoutingPreset, stage: RoutingStage, model: DiscoveredModel): ReasoningEffort | undefined {
  if (model.tier === "review" || model.effortLocked) return undefined;
  if (model.supportedEfforts && model.supportedEfforts.length === 0) return undefined;
  if (preset === "sota_first") {
    if (stage === "design" || stage === "review") return clampEffortForModel(model, "high");
    return clampEffortForModel(model, "medium");
  }
  if (preset === "balanced") {
    if (stage === "design") return clampEffortForModel(model, "low");
    if (stage === "review") return clampEffortForModel(model, "medium");
    if (stage === "implement") {
      return model.id === "Qwen4-Max" ? undefined : clampEffortForModel(model, "low");
    }
    return model.isFree ? undefined : clampEffortForModel(model, "medium");
  }
  // quota_saver
  if (stage === "design" || stage === "review") {
    return model.id === "Qwen4-Max" ? undefined : clampEffortForModel(model, "medium");
  }
  return model.isFree ? undefined : clampEffortForModel(model, "low");
}

interface CandidateScore {
  harness: HarnessId;
  model: DiscoveredModel;
  score: number;
}

function scoreModelForStage(
  harness: HarnessId,
  model: DiscoveredModel,
  preset: RoutingPreset,
  stage: RoutingStage,
  implementPrimaryHarness?: HarnessId,
): number {
  const cap = estimateBaseCapability(harness, model);
  const free = Boolean(model.isFree || /-free$/i.test(model.id));
  const expensive = isExpensiveFlagship(model);
  const workhorse = isWorkhorseCodingModel(model);
  const isReviewModel = model.tier === "review";

  if (preset === "sota_first") {
    if (stage === "design") {
      return cap + (expensive ? 4 : 0) + (model.tier === "sota" ? 4 : 0) - (model.tier === "fast" ? 12 : 0) - (isReviewModel ? 14 : 0);
    }
    if (stage === "implement") {
      return cap + (workhorse ? 5 : 0) + (model.tier === "sota" ? 3 : 0) - (model.tier === "fast" ? 12 : 0) - (isReviewModel ? 14 : 0);
    }
    if (stage === "fix") {
      return cap + (workhorse ? 4 : 0) - (isReviewModel ? 12 : 0) - (model.tier === "fast" ? 8 : 0);
    }
    // review: prefer cross-model reviewer or dedicated review model
    const crossBonus = implementPrimaryHarness && harness !== implementPrimaryHarness ? 8 : 0;
    return cap + crossBonus + (isReviewModel ? 8 : 0) - (model.tier === "fast" ? 14 : 0);
  }

  if (preset === "quota_saver") {
    if (stage === "design") {
      const quotaFriendly =
        harness === "qodercn" ? 14 : free ? 10 : model.tier === "fast" ? 8 : expensive ? -18 : harness === "codex" ? -6 : 4;
      return cap + quotaFriendly - (isReviewModel ? 10 : 0);
    }
    if (stage === "implement" || stage === "fix") {
      const freeBonus = free ? 36 : model.tier === "fast" ? 22 : harness === "qodercn" ? 8 : expensive ? -20 : 0;
      return cap * 0.55 + freeBonus - (isReviewModel ? 14 : 0);
    }
    // review
    const reviewFriendly =
      harness === "qodercn" ? 14 : isReviewModel ? 12 : model.tier === "fast" ? 10 : expensive ? -18 : 2;
    return cap * 0.7 + reviewFriendly;
  }

  // balanced
  if (stage === "design") {
    return cap + (workhorse ? 4 : 0) - (expensive ? 6 : 0) - (model.tier === "fast" ? 10 : 0) - (isReviewModel ? 12 : 0);
  }
  if (stage === "implement") {
    const balancedBonus =
      model.id === "Qwen4-Max"
        ? 18
        : workhorse
          ? 6
          : free
            ? 10
            : expensive
              ? -8
              : 0;
    const codexQuotaBalance = harness === "codex" ? -4 : 0;
    return cap + balancedBonus + codexQuotaBalance - (isReviewModel ? 12 : 0);
  }
  if (stage === "fix") {
    const fixBonus = free ? 28 : model.tier === "fast" ? 18 : workhorse ? 6 : expensive ? -10 : 0;
    return cap * 0.65 + fixBonus - (isReviewModel ? 12 : 0);
  }
  // review
  const crossBonus = implementPrimaryHarness && harness !== implementPrimaryHarness ? 4 : 0;
  return cap * 0.75 + crossBonus + (isReviewModel ? 18 : 0) - (expensive ? 10 : 0);
}

function bareModelSignature(modelId: string): string {
  const lower = modelId.trim().toLowerCase();
  const slashIdx = lower.indexOf("/");
  const bare = slashIdx >= 0 ? lower.slice(slashIdx + 1) : lower;
  return bare.replace(/-free$/, "");
}

function pickStageRule(
  pool: CandidateScore[],
  preset: RoutingPreset,
  stage: RoutingStage,
): StageRouteRule | null {
  if (pool.length === 0) return null;
  const sorted = [...pool].sort((a, b) => b.score - a.score);
  const chosen: CandidateScore[] = [sorted[0]!];
  const remaining = sorted.slice(1);
  const harnessCounts = new Map<HarnessId, number>([[chosen[0]!.harness, 1]]);
  const usedSignatures = new Set<string>([bareModelSignature(chosen[0]!.model.id)]);

  while (chosen.length < 4 && remaining.length > 0) {
    let bestIdx = -1;
    let bestAdjusted = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i]!;
      const sig = bareModelSignature(c.model.id);
      if (usedSignatures.has(sig)) continue;
      const usedCount = harnessCounts.get(c.harness) ?? 0;
      // Encourage multi-harness resilience across fallbacks.
      const adjusted = c.score - usedCount * 8;
      if (adjusted > bestAdjusted) {
        bestAdjusted = adjusted;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    const picked = remaining.splice(bestIdx, 1)[0]!;
    chosen.push(picked);
    usedSignatures.add(bareModelSignature(picked.model.id));
    harnessCounts.set(picked.harness, (harnessCounts.get(picked.harness) ?? 0) + 1);
  }

  const toTarget = (c: CandidateScore): ModelTarget => {
    const effort = desiredEffortForStage(preset, stage, c.model);
    return {
      harness: c.harness,
      model: c.model.id,
      ...(effort ? { reasoningEffort: effort } : {}),
    };
  };

  return {
    primary: toTarget(chosen[0]!),
    fallbacks: chosen.slice(1).map(toTarget),
  };
}

export function buildPresetRouting(preset: RoutingPreset, harnesses?: HarnessInfo[] | null): RoutingConfig {
  const staticFallback = buildStaticPresetRouting(preset);
  if (!harnesses || harnesses.length === 0) return staticFallback;

  const installedWithModels = harnesses.filter((h) => h.installed && h.models.length > 0);
  if (installedWithModels.length === 0) return staticFallback;

  const entries: Array<{ harness: HarnessId; model: DiscoveredModel }> = [];
  for (const h of installedWithModels) {
    for (const m of h.models) {
      entries.push({ harness: h.id, model: m });
    }
  }
  if (entries.length === 0) return staticFallback;

  const scoreFor = (stage: RoutingStage, implementPrimaryHarness?: HarnessId): CandidateScore[] =>
    entries.map((e) => ({
      harness: e.harness,
      model: e.model,
      score: scoreModelForStage(e.harness, e.model, preset, stage, implementPrimaryHarness),
    }));

  const designRule = pickStageRule(scoreFor("design"), preset, "design") ?? staticFallback.stages.design;
  const implementRule = pickStageRule(scoreFor("implement"), preset, "implement") ?? staticFallback.stages.implement;
  const fixRule = pickStageRule(scoreFor("fix"), preset, "fix") ?? staticFallback.stages.fix;
  const reviewRule =
    pickStageRule(scoreFor("review", implementRule.primary.harness), preset, "review") ?? staticFallback.stages.review;

  return {
    activePreset: preset,
    stages: {
      design: designRule,
      implement: implementRule,
      fix: fixRule,
      review: reviewRule,
    },
  };
}

export function mapActionToRoutingStage(action: AgentAction): RoutingStage {
  if (action === "ask") return "design";
  return action;
}

const EFFORT_SET = new Set<string>(REASONING_EFFORTS);

export function sanitizeModelTarget(raw: unknown, fallback: ModelTarget): ModelTarget {
  if (!raw || typeof raw !== "object") return fallback;
  const obj = raw as Record<string, unknown>;
  let rawHarness = typeof obj.harness === "string" ? obj.harness : "";
  let rawModel = typeof obj.model === "string" ? obj.model.trim() : "";
  // Smooth migration for legacy persisted "gemini" configs -> "agy"
  if (rawHarness === "gemini") {
    rawHarness = "agy";
    if (!rawModel || rawModel === "default") rawModel = "gemini-4-argon";
  }
  const harness =
    rawHarness && (HARNESS_IDS as readonly string[]).includes(rawHarness)
      ? (rawHarness as HarnessId)
      : fallback.harness;
  const model = rawModel ? rawModel.slice(0, 200) : fallback.model;
  const effort =
    typeof obj.reasoningEffort === "string" && EFFORT_SET.has(obj.reasoningEffort)
      ? (obj.reasoningEffort as ReasoningEffort)
      : undefined;
  return { harness, model, ...(effort ? { reasoningEffort: effort } : {}) };
}

export function normalizeRoutingConfig(raw: unknown): RoutingConfig {
  const defaults = buildStaticPresetRouting("balanced");
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
  return {
    activePreset,
    stages,
    ...(typeof obj.autoReview === "boolean" ? { autoReview: obj.autoReview } : {}),
  };
}

function normalizeTargetWithHarnesses(
  target: ModelTarget,
  harnesses: HarnessInfo[] | null,
  preset: RoutingPreset,
  stage: RoutingStage,
): { target: ModelTarget; available: boolean } {
  if (!harnesses) return { target, available: true };
  const harnessInfo = harnesses.find((h) => h.id === target.harness);
  if (!harnessInfo || harnessInfo.models.length === 0) {
    return { target, available: true };
  }

  const exact = harnessInfo.models.find((m) => m.id === target.model);
  if (exact) {
    const effort = clampEffortForModel(exact, target.reasoningEffort);
    return {
      target: {
        harness: target.harness,
        model: exact.id,
        ...(effort ? { reasoningEffort: effort } : {}),
      },
      available: true,
    };
  }

  // Map legacy suffixed AGY variant IDs (e.g. gemini-4-hydrogen-high) to the aggregated family model.
  for (const m of harnessInfo.models) {
    if (!m.effortVariants) continue;
    for (const [eff, variantId] of Object.entries(m.effortVariants) as Array<[ReasoningEffort, string]>) {
      if (variantId === target.model) {
        const clamped = clampEffortForModel(m, target.reasoningEffort ?? eff);
        return {
          target: {
            harness: target.harness,
            model: m.id,
            ...(clamped ? { reasoningEffort: clamped } : {}),
          },
          available: true,
        };
      }
    }
  }

  // Model ID no longer exists in this harness's discovered catalog: remap to best available model on the same harness.
  const scored = harnessInfo.models
    .map((m) => ({
      harness: harnessInfo.id,
      model: m,
      score: scoreModelForStage(harnessInfo.id, m, preset, stage),
    }))
    .sort((a, b) => b.score - a.score);
  const replacement = scored[0]?.model;
  if (replacement) {
    const effort = clampEffortForModel(replacement, target.reasoningEffort);
    return {
      target: {
        harness: target.harness,
        model: replacement.id,
        ...(effort ? { reasoningEffort: effort } : {}),
      },
      available: true,
    };
  }
  return { target, available: false };
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

  const rawList: Array<{ target: ModelTarget; isExplicitOverride: boolean }> = [];
  if (override?.harness && override?.model) {
    rawList.push({
      target: {
        harness: override.harness,
        model: override.model,
        ...(override.reasoningEffort ? { reasoningEffort: override.reasoningEffort } : {}),
      },
      isExplicitOverride: true,
    });
  } else if (override?.reasoningEffort) {
    rawList.push({
      target: {
        ...rule.primary,
        reasoningEffort: override.reasoningEffort,
      },
      isExplicitOverride: false,
    });
  }

  rawList.push({ target: rule.primary, isExplicitOverride: false });
  for (const fb of rule.fallbacks) {
    rawList.push({ target: fb, isExplicitOverride: false });
  }

  const normalizedList: ModelTarget[] = [];
  for (const entry of rawList) {
    if (entry.isExplicitOverride) {
      normalizedList.push(entry.target);
    } else {
      const resolved = normalizeTargetWithHarnesses(entry.target, harnesses, routing.activePreset, stage);
      if (resolved.available) {
        normalizedList.push(resolved.target);
      }
    }
  }

  // Deduplicate by harness+model
  const seen = new Set<string>();
  const unique: ModelTarget[] = [];
  for (const item of normalizedList) {
    const key = `${item.harness}::${item.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  // Prefer targets whose harness is actually installed, while keeping override first if requested.
  let ordered = unique;
  if (installedSet && installedSet.size > 0) {
    const installedFirst = unique.filter((t, idx) => (idx === 0 && Boolean(override?.harness)) || installedSet.has(t.harness));
    if (installedFirst.length > 0) ordered = installedFirst;
  }

  // Demote cooling-down models after healthy candidates unless explicitly forced via override.
  const explicitOverride = Boolean(override?.harness && override?.model);
  const healthy: ModelTarget[] = [];
  const cooling: ModelTarget[] = [];
  ordered.forEach((t, idx) => {
    if (idx === 0 && explicitOverride) {
      healthy.push(t);
    } else if (isModelCoolingDown(t.harness, t.model)) {
      cooling.push(t);
    } else {
      healthy.push(t);
    }
  });
  return healthy.length > 0 ? [...healthy, ...cooling] : ordered;
}

const RATE_LIMIT_RE =
  /(rate[_\s-]?limit|too many requests|\b429\b|quota[_\s-]?(exceeded|exhausted|limit)|insufficient[_\s_]?quota|usage limit|credit balance|额度不足|配额已用完|触发限流|已限流)/i;

export function detectRateLimitOrQuotaError(output: string, exitCode: number | null): boolean {
  if (exitCode === 0) return false;
  const tail = output.length > 4096 ? output.slice(-4096) : output;
  return RATE_LIMIT_RE.test(tail);
}
