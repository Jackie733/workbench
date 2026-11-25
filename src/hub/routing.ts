import { DEFAULT_PROJECT_ROUTING, type AgentAction, type RequirementTier } from "../core/types.ts";
import { isModelCoolingDown } from "./telemetry.ts";
import {
  HARNESS_IDS,
  REASONING_EFFORTS,
  ROUTING_ROLES,
  type DiscoveredModel,
  type HarnessId,
  type HarnessInfo,
  type ModelTarget,
  type ReasoningEffort,
  type RoleRouteRule,
  type RoutingConfig,
  type RoutingRole,
} from "./types.ts";

const EFFORT_RANK: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra", "auto"];
const EFFORT_SET = new Set<string>(REASONING_EFFORTS);
const FALLBACK_DEFAULT_ROUTING = DEFAULT_PROJECT_ROUTING;

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

function dedupeTargets(list: ModelTarget[], max = 4): ModelTarget[] {
  const seen = new Set<string>();
  const out: ModelTarget[] = [];
  for (const item of list) {
    const key = `${item.harness}::${item.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

function pickCrossHarnessTargets(
  candidates: Array<{ harness: HarnessId; model: DiscoveredModel; effort?: ReasoningEffort }>,
  preferredPrimary?: { harness: HarnessId; model: DiscoveredModel; effort?: ReasoningEffort },
  max = 4,
): RoleRouteRule | null {
  if (candidates.length === 0) return null;
  const primary = preferredPrimary ?? candidates[0]!;
  const toTarget = (c: { harness: HarnessId; model: DiscoveredModel; effort?: ReasoningEffort }): ModelTarget => {
    const clamped = clampEffortForModel(c.model, c.effort);
    return {
      harness: c.harness,
      model: c.model.id,
      ...(clamped ? { reasoningEffort: clamped } : {}),
    };
  };

  const ordered: ModelTarget[] = [toTarget(primary)];
  const usedHarnesses = new Set<HarnessId>([primary.harness]);
  // First pass: pick one fallback from each distinct harness for cross-subscription resilience.
  for (const c of candidates) {
    if (ordered.length >= max) break;
    if (usedHarnesses.has(c.harness)) continue;
    usedHarnesses.add(c.harness);
    ordered.push(toTarget(c));
  }
  // Second pass: fill remaining slots from remaining candidates if fewer harnesses are installed.
  for (const c of candidates) {
    if (ordered.length >= max) break;
    ordered.push(toTarget(c));
  }

  const unique = dedupeTargets(ordered, max);
  if (unique.length === 0) return null;
  return {
    primary: unique[0]!,
    fallbacks: unique.slice(1),
  };
}

/**
 * Generates an explicit initial 3-role project routing config from the node's installed CLIs.
 * Called once on project initialization and persisted into `.workbench/project.json`.
 */
export function buildInitialProjectRouting(harnesses?: HarnessInfo[] | null): RoutingConfig {
  if (!harnesses || harnesses.length === 0) {
    return structuredClone(FALLBACK_DEFAULT_ROUTING);
  }
  const installed = harnesses.filter((h) => h.installed && h.models.length > 0 && h.id !== "omp");
  const activeHarnesses = installed.length > 0 ? installed : harnesses.filter((h) => h.installed && h.models.length > 0);
  if (activeHarnesses.length === 0) {
    return structuredClone(FALLBACK_DEFAULT_ROUTING);
  }

  type Entry = { harness: HarnessId; model: DiscoveredModel };
  const allEntries: Entry[] = [];
  for (const h of activeHarnesses) {
    for (const m of h.models) {
      if (m.isLegacy || m.id === "Auto" || m.id === "Fast") continue;
      allEntries.push({ harness: h.id, model: m });
    }
  }
  if (allEntries.length === 0) {
    for (const h of activeHarnesses) {
      for (const m of h.models) allEntries.push({ harness: h.id, model: m });
    }
  }

  // 1. defaultLead: prefer balanced/workhorse subscription models (then fast, then sota)
  const workhorsePool = [
    ...allEntries.filter((e) => e.model.tier === "balanced"),
    ...allEntries.filter((e) => e.model.tier === "fast"),
    ...allEntries.filter((e) => e.model.tier === "sota"),
  ];
  const defaultLead =
    pickCrossHarnessTargets(workhorsePool.length > 0 ? workhorsePool : allEntries) ??
    FALLBACK_DEFAULT_ROUTING.defaultLead;

  // 2. sotaLead: prefer sota tier models with high reasoning effort when supported
  const sotaPool = [
    ...allEntries.filter((e) => e.model.tier === "sota").map((e) => ({ ...e, effort: "high" as ReasoningEffort })),
    ...allEntries.filter((e) => e.model.tier === "balanced"),
  ];
  const sotaLead =
    pickCrossHarnessTargets(sotaPool.length > 0 ? sotaPool : allEntries) ??
    FALLBACK_DEFAULT_ROUTING.sotaLead;

  // 3. reviewer: prefer dedicated review model or a different harness from defaultLead for heterogeneous blind review
  const reviewPool = [
    ...allEntries.filter((e) => e.model.tier === "review"),
    ...allEntries.filter((e) => e.harness !== defaultLead.primary.harness && (e.model.tier === "sota" || e.model.tier === "balanced")),
    ...allEntries.filter((e) => e.harness !== defaultLead.primary.harness),
    ...allEntries,
  ];
  const reviewer =
    pickCrossHarnessTargets(reviewPool.length > 0 ? reviewPool : allEntries) ??
    FALLBACK_DEFAULT_ROUTING.reviewer;

  return {
    defaultLead,
    sotaLead,
    reviewer,
    autoReview: true,
    autoHeal: true,
  };
}

export function resolveRoleForAction(action: AgentAction, tier: RequirementTier = "standard"): RoutingRole {
  if (action === "review") return "reviewer";
  return tier === "sota" ? "sotaLead" : "defaultLead";
}

export function sanitizeModelTarget(raw: unknown, fallback: ModelTarget): ModelTarget {
  if (!raw || typeof raw !== "object") return fallback;
  const obj = raw as Record<string, unknown>;
  const rawHarness = typeof obj.harness === "string" ? obj.harness.trim() : "";
  const rawModel = typeof obj.model === "string" ? obj.model.trim() : "";
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

export function normalizeRoutingConfig(raw: unknown, fallback: RoutingConfig = FALLBACK_DEFAULT_ROUTING): RoutingConfig {
  if (!raw || typeof raw !== "object") return structuredClone(fallback);
  const obj = raw as Record<string, unknown>;
  const rules = {} as Record<RoutingRole, RoleRouteRule>;
  for (const role of ROUTING_ROLES) {
    const defRule = fallback[role];
    const candidate = obj[role];
    if (!candidate || typeof candidate !== "object") {
      rules[role] = { primary: { ...defRule.primary }, fallbacks: defRule.fallbacks.map((fb) => ({ ...fb })) };
      continue;
    }
    const ruleObj = candidate as Record<string, unknown>;
    const primary = sanitizeModelTarget(ruleObj.primary, defRule.primary);
    const fallbacks = Array.isArray(ruleObj.fallbacks)
      ? ruleObj.fallbacks
          .slice(0, 6)
          .map((item, idx) => sanitizeModelTarget(item, defRule.fallbacks[idx] ?? defRule.primary))
      : defRule.fallbacks.map((fb) => ({ ...fb }));
    rules[role] = { primary, fallbacks };
  }
  return {
    defaultLead: rules.defaultLead,
    sotaLead: rules.sotaLead,
    reviewer: rules.reviewer,
    ...(typeof obj.autoReview === "boolean" ? { autoReview: obj.autoReview } : {}),
    ...(typeof obj.autoHeal === "boolean" ? { autoHeal: obj.autoHeal } : {}),
  };
}

function normalizeTargetWithHarnesses(
  target: ModelTarget,
  harnesses: HarnessInfo[] | null,
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

  // Keep user-configured model verbatim so explicit project routing is never silently rewritten.
  return { target, available: true };
}

/**
 * Returns ordered execution targets for an action + requirement tier, honoring any explicit override first.
 * Strictly stays within the active tier's role rule (never auto-escalates standard -> sotaLead).
 */
export function resolveRouteCandidates(
  routing: RoutingConfig,
  harnesses: HarnessInfo[] | null,
  action: AgentAction,
  tier: RequirementTier = "standard",
  override?: Partial<ModelTarget> | null,
): ModelTarget[] {
  const role = resolveRoleForAction(action, tier);
  const rule: RoleRouteRule = routing[role];
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
      const resolved = normalizeTargetWithHarnesses(entry.target, harnesses);
      if (resolved.available) {
        normalizedList.push(resolved.target);
      }
    }
  }

  const unique = dedupeTargets(normalizedList, 12);

  let ordered = unique;
  if (installedSet && installedSet.size > 0) {
    const installedFirst = unique.filter((t, idx) => (idx === 0 && Boolean(override?.harness)) || installedSet.has(t.harness));
    if (installedFirst.length > 0) ordered = installedFirst;
  }

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

const MODEL_UNAVAILABLE_RE =
  /(model unavailable|model[_\s-]?not[_\s-]?found|unknown model|invalid model|unsupported model|no such model|provider[^\n]*unavailable|模型不可用|未找到模型)/i;

function matchesNonZeroOutput(output: string, exitCode: number | null, pattern: RegExp): boolean {
  if (exitCode === 0) return false;
  const tail = output.length > 4096 ? output.slice(-4096) : output;
  return pattern.test(tail);
}

export function detectRateLimitOrQuotaError(output: string, exitCode: number | null): boolean {
  return matchesNonZeroOutput(output, exitCode, RATE_LIMIT_RE);
}

export function detectModelUnavailableError(output: string, exitCode: number | null): boolean {
  return matchesNonZeroOutput(output, exitCode, MODEL_UNAVAILABLE_RE);
}
