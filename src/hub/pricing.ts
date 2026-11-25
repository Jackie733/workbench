import type { AgentRunRecord, RunBillingMode, RunCostSummary, RunTokenUsage } from "../core/types.ts";
import { normalizeUsageAgy } from "./stream_adapters.ts";
import type { HarnessInfo, HubObservabilityConfig, ModelPriceOverride } from "./types.ts";

export interface QuotaPoolResolution {
  quotaPool: string;
  billingMode: RunBillingMode;
  label: string;
}

export interface ResolvedModelPriceSpec {
  input: number;       // USD per 1M input tokens
  output: number;      // USD per 1M output/reasoning tokens
  cacheRead: number;   // USD per 1M cached input read tokens
  cacheWrite: number;  // USD per 1M cache creation/write tokens
  contextWindow: number;
  source: "override" | "catalog" | "builtin" | "fallback";
}

export const QUOTA_POOL_LABELS: Record<string, string> = {
  "openai-codex": "ChatGPT Plus (Codex)",
  "qoder-cn": "QoderCN 订阅",
  "google-antigravity": "Antigravity 订阅",
  "opencode-go": "OpenCode Go 订阅",
  "opencode-free": "OpenCode Free",
  deepseek: "DeepSeek API",
  openai: "OpenAI API",
  anthropic: "Anthropic API",
  moonshot: "Moonshot API",
  zai: "Z.ai / GLM API",
  minimax: "MiniMax API",
  "minimax-cn": "MiniMax CN API",
};

interface BuiltinModelPriceRule {
  match: RegExp;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  contextWindow: number;
}

const BUILTIN_MODEL_PRICING: BuiltinModelPriceRule[] = [
  { match: /gpt-6\.2-astra|gpt-6-astra/i, input: 2.5, output: 15.0, cacheRead: 0.25, contextWindow: 400_000 },
  { match: /gpt-6\.2-sol|gpt-6\.1-sol|gpt-6-sol/i, input: 1.75, output: 14.0, cacheRead: 0.175, contextWindow: 400_000 },
  { match: /gpt-6\.1-terra|gpt-6-luna|gpt-5\.6/i, input: 0.5, output: 3.0, cacheRead: 0.05, contextWindow: 256_000 },
  { match: /codex-auto-review/i, input: 1.75, output: 14.0, cacheRead: 0.175, contextWindow: 400_000 },
  { match: /claude-opus/i, input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75, contextWindow: 200_000 },
  { match: /claude-sonnet/i, input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75, contextWindow: 200_000 },
  { match: /claude-haiku/i, input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0, contextWindow: 200_000 },
  { match: /gemini-4-hydrogen|gemini-pro-orchestrator/i, input: 2.0, output: 12.0, cacheRead: 0.2, contextWindow: 1_000_000 },
  { match: /gemini-4-argon/i, input: 1.25, output: 10.0, cacheRead: 0.125, contextWindow: 1_000_000 },
  { match: /gemini-3\.8-flash|gemini-.*flash/i, input: 0.15, output: 0.6, cacheRead: 0.015, contextWindow: 1_000_000 },
  { match: /deepseek-v4-pro|deepseek-r/i, input: 0.55, output: 2.19, cacheRead: 0.055, contextWindow: 128_000 },
  { match: /deepseek-v4|deepseek-flash|deepseek-chat/i, input: 0.27, output: 1.1, cacheRead: 0.027, contextWindow: 128_000 },
  { match: /qwen4-max|qwen3\.8-max/i, input: 1.2, output: 4.8, cacheRead: 0.12, contextWindow: 256_000 },
  { match: /qwen3\.8-flash|qwen.*flash/i, input: 0.15, output: 0.6, cacheRead: 0.015, contextWindow: 256_000 },
  { match: /kimi-k3|kimi-k2/i, input: 0.6, output: 2.5, cacheRead: 0.06, contextWindow: 256_000 },
  { match: /glm-5\.3-flash/i, input: 0.12, output: 0.5, cacheRead: 0.012, contextWindow: 200_000 },
  { match: /glm-5/i, input: 0.5, output: 2.0, cacheRead: 0.05, contextWindow: 200_000 },
  { match: /minimax/i, input: 0.2, output: 0.8, cacheRead: 0.02, contextWindow: 200_000 },
  { match: /step-5/i, input: 0.8, output: 3.2, cacheRead: 0.08, contextWindow: 200_000 },
];

export function formatQuotaPoolLabel(quotaPool: string): string {
  return QUOTA_POOL_LABELS[quotaPool] ?? `${quotaPool}`;
}

function normalizeProviderPool(rawProvider: string): string {
  const lower = rawProvider.trim().toLowerCase();
  if (lower === "codex" || lower === "openai-codex") return "openai-codex";
  if (lower === "qoder-cn" || lower === "qodercn" || lower === "qoder") return "qoder-cn";
  if (lower === "google-antigravity" || lower === "antigravity" || lower === "agy") return "google-antigravity";
  if (lower === "opencode-go") return "opencode-go";
  return lower || "unknown";
}

function defaultBillingForPool(pool: string, model: string, isFreeHint?: boolean): RunBillingMode {
  if (pool === "opencode-free" || isFreeHint || /-free(?::|$)/i.test(model.trim())) {
    return "free";
  }
  if (
    pool === "openai-codex" ||
    pool === "qoder-cn" ||
    pool === "google-antigravity" ||
    pool === "opencode-go"
  ) {
    return "subscription";
  }
  return "api";
}

/**
 * Resolves the underlying provider quota pool and billing mode for a run.
 * - `opencode-go/*` resolves to subscription pool `opencode-go`.
 * - `omp` never acts as a provider pool; it always delegates to the underlying `<provider>` prefix.
 */
export function resolveQuotaPool(
  harness = "",
  model = "",
  options: {
    billingOverrides?: Record<string, RunBillingMode>;
    isFreeHint?: boolean;
  } = {},
): QuotaPoolResolution {
  const h = (typeof harness === "string" ? harness : "").trim().toLowerCase();
  const m = (typeof model === "string" ? model : "").trim();
  const slashIdx = m.indexOf("/");
  const prefix = slashIdx > 0 ? m.slice(0, slashIdx) : "";
  const isFreeModel = Boolean(options.isFreeHint) || /-free(?::|$)/i.test(m) || m === "opencode/big-pickle";

  let quotaPool: string;
  if (h === "codex") {
    quotaPool = "openai-codex";
  } else if (h === "qodercn") {
    quotaPool = "qoder-cn";
  } else if (h === "agy") {
    quotaPool = "google-antigravity";
  } else if (h === "opencode") {
    const prov = normalizeProviderPool(prefix);
    if (prov === "opencode-go") {
      quotaPool = "opencode-go";
    } else if (isFreeModel || prov === "opencode" || !prefix) {
      quotaPool = isFreeModel ? "opencode-free" : prov || "opencode";
    } else {
      quotaPool = prov;
    }
  } else if (h === "omp") {
    if (prefix) {
      const prov = normalizeProviderPool(prefix);
      quotaPool = prov === "opencode" && isFreeModel ? "opencode-free" : prov;
    } else if (/^gpt-|^codex/i.test(m)) {
      quotaPool = "openai-codex";
    } else if (/^gemini-|^claude-.*-5-5/i.test(m)) {
      quotaPool = "google-antigravity";
    } else if (isFreeModel) {
      quotaPool = "opencode-free";
    } else {
      quotaPool = "omp-external";
    }
  } else {
    quotaPool = prefix ? normalizeProviderPool(prefix) : h || "unknown";
  }

  const override = options.billingOverrides?.[quotaPool] ?? options.billingOverrides?.[h];
  const billingMode = override ?? defaultBillingForPool(quotaPool, m, isFreeModel);

  return {
    quotaPool,
    billingMode,
    label: formatQuotaPoolLabel(quotaPool),
  };
}

function findPricingOverride(
  harness: string,
  model: string,
  quotaPool: string,
  overrides?: Record<string, ModelPriceOverride>,
): ModelPriceOverride | undefined {
  if (!overrides) return undefined;
  const slashIdx = model.indexOf("/");
  const shortModel = slashIdx > 0 ? model.slice(slashIdx + 1) : model;
  return (
    overrides[`${quotaPool}::${model}`] ??
    overrides[`${quotaPool}::${shortModel}`] ??
    overrides[`${harness}::${model}`] ??
    overrides[model] ??
    overrides[shortModel] ??
    overrides[quotaPool]
  );
}

export function resolveModelSpec(
  harness = "",
  model = "",
  harnessesCatalog: HarnessInfo[] = [],
  observability?: HubObservabilityConfig,
): ResolvedModelPriceSpec {
  const safeHarness = typeof harness === "string" ? harness : "";
  const safeModel = typeof model === "string" ? model : "";
  const { quotaPool, billingMode } = resolveQuotaPool(safeHarness, safeModel, {
    billingOverrides: observability?.billingOverrides,
  });
  const override = findPricingOverride(safeHarness, safeModel, quotaPool, observability?.pricingOverrides);
  if (override) {
    return {
      input: override.input,
      output: override.output,
      cacheRead: override.cacheRead ?? Number((override.input * 0.1).toFixed(4)),
      cacheWrite: override.cacheWrite ?? Number((override.input * 1.25).toFixed(4)),
      contextWindow: override.contextWindow ?? 200_000,
      source: "override",
    };
  }

  const hInfo = harnessesCatalog.find((h) => h.id === safeHarness);
  const mInfo =
    hInfo?.models.find((m) => m.id === safeModel) ??
    hInfo?.models.find((m) => m.effortVariants && Object.values(m.effortVariants).includes(safeModel));

  const builtin = BUILTIN_MODEL_PRICING.find((r) => r.match.test(safeModel));

  if (mInfo?.cost && (mInfo.cost.input > 0 || mInfo.cost.output > 0)) {
    return {
      input: mInfo.cost.input,
      output: mInfo.cost.output,
      cacheRead: mInfo.cost.cacheRead ?? Number((mInfo.cost.input * 0.1).toFixed(4)),
      cacheWrite: mInfo.cost.cacheWrite ?? Number((mInfo.cost.input * 1.25).toFixed(4)),
      contextWindow: mInfo.contextWindow ?? builtin?.contextWindow ?? 200_000,
      source: "catalog",
    };
  }

  if (billingMode === "free") {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      contextWindow: mInfo?.contextWindow ?? builtin?.contextWindow ?? 128_000,
      source: "builtin",
    };
  }

  if (builtin) {
    return {
      input: builtin.input,
      output: builtin.output,
      cacheRead: builtin.cacheRead ?? Number((builtin.input * 0.1).toFixed(4)),
      cacheWrite: builtin.cacheWrite ?? Number((builtin.input * 1.25).toFixed(4)),
      contextWindow: mInfo?.contextWindow ?? builtin.contextWindow,
      source: "builtin",
    };
  }

  return {
    input: 0.5,
    output: 2.0,
    cacheRead: 0.05,
    cacheWrite: 0.625,
    contextWindow: mInfo?.contextWindow ?? 200_000,
    source: "fallback",
  };
}

export function computeRunCost(
  usage: RunTokenUsage | undefined,
  spec: ResolvedModelPriceSpec,
  billingMode: RunBillingMode,
  quotaPool: string,
  reportedCostUsd?: number,
): RunCostSummary {
  if (billingMode === "free") {
    return {
      apiCostUsd: 0,
      equivalentCostUsd: 0,
      billingMode,
      costSource: "free",
      quotaPool,
      currency: "USD",
    };
  }

  const hasReported = typeof reportedCostUsd === "number" && Number.isFinite(reportedCostUsd) && reportedCostUsd > 0;
  let rawCost = hasReported ? reportedCostUsd! : 0;
  let costSource: RunCostSummary["costSource"] = hasReported ? "reported" : "unknown";

  if (!hasReported && usage && usage.totalTokens > 0) {
    const uncachedIn = Math.max(0, usage.uncachedInputTokens);
    const cacheRead = Math.max(0, usage.cacheReadTokens);
    const cacheWrite = Math.max(0, usage.cacheWriteTokens);
    const outAll = Math.max(0, usage.outputTokens + usage.reasoningTokens);
    rawCost =
      (uncachedIn * spec.input +
        cacheRead * spec.cacheRead +
        cacheWrite * spec.cacheWrite +
        outAll * spec.output) /
      1_000_000;
    costSource = spec.source === "fallback" && usage.totalTokens === 0 ? "unknown" : "estimated";
  }

  const rounded = Math.round(rawCost * 1_000_000) / 1_000_000;
  return {
    apiCostUsd: billingMode === "api" ? rounded : 0,
    equivalentCostUsd: rounded,
    billingMode,
    costSource,
    quotaPool,
    currency: "USD",
  };
}

/** Fast CJK-aware token count estimator for handoff budgets and tool payload inflation analysis. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk++;
    }
  }
  const nonCjk = text.length - cjk;
  return Math.max(1, Math.ceil(cjk * 0.72 + nonCjk * 0.26));
}

export interface InferredLogMetrics {
  usage?: RunTokenUsage;
  turnsCount?: number;
  toolCallsCount?: number;
  toolErrorCount?: number;
  estimated?: boolean;
}

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const OPENCODE_STEP_LINE_RE = /^>\s+\S+\s+·\s+\S+\s*$/;
const OPENCODE_TOOL_LINE_RE = /^(?:\u2192|\u2190|\u2731|\|)\s+([A-Z][A-Za-z0-9_-]*)\b(.*)$/;
const SHELL_CMD_LINE_RE = /^\$\s+\S+/;

/** Infer token usage and tool activity from raw harness stdout logs when structured telemetry is unavailable. */
export function inferRunMetricsFromRawLog(rawLog: string): InferredLogMetrics {
  if (!rawLog || !rawLog.trim()) return {};
  const cleaned = rawLog.replace(ANSI_ESCAPE_RE, "");

  // Fast path: raw AGY NDJSON logs (`{"event":"init"...}` / `{"event":"step_update"...}` / `{"event":"result"...}`)
  if (/"event"\s*:\s*"(?:init|step_update|result)"/.test(cleaned)) {
    let agyAgentTurns = 0;
    let agyToolCalls = 0;
    let agyToolErrors = 0;
    let agyResultUsage: RunTokenUsage | undefined;
    let agyAccUncached = 0;
    let agyAccCacheRead = 0;
    let agyAccOutput = 0;
    let agyAccThinking = 0;

    for (const line of cleaned.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        if (obj.event === "step_update" && obj.step_update && typeof obj.step_update === "object") {
          const su = obj.step_update as Record<string, unknown>;
          const st = String(su.step_type ?? "");
          const state = String(su.state ?? "").toUpperCase();
          if (st === "agent_response" && (state === "DONE" || state === "ERROR")) {
            agyAgentTurns += 1;
            if (su.usage && typeof su.usage === "object") {
              const u = su.usage as Record<string, unknown>;
              agyAccUncached += Number(u.input_tokens) || 0;
              agyAccCacheRead += Number(u.cache_read_tokens) || 0;
              agyAccOutput += Number(u.output_tokens) || 0;
              agyAccThinking += Number(u.thinking_tokens) || 0;
            }
          } else if (st === "tool" && (state === "DONE" || state === "ERROR")) {
            agyToolCalls += 1;
            if (state === "ERROR" || Boolean((su.tool_info as Record<string, unknown> | undefined)?.error)) {
              agyToolErrors += 1;
            }
          }
        } else if (obj.event === "result" && obj.result && typeof obj.result === "object") {
          const res = obj.result as Record<string, unknown>;
          if (res.usage && typeof res.usage === "object") {
            const normalized = normalizeUsageAgy(res.usage as Record<string, unknown>);
            if (normalized.totalTokens > 0) {
              agyResultUsage = normalized;
            }
          }
        }
      } catch {
        // Ignore malformed JSON line
      }
    }

    const fallbackRawUsage = normalizeUsageAgy({
      input_tokens: agyAccUncached,
      cache_read_tokens: agyAccCacheRead,
      output_tokens: agyAccOutput,
      thinking_tokens: agyAccThinking,
    });
    const fallbackUsage: RunTokenUsage | undefined =
      fallbackRawUsage.totalTokens > 0 ? fallbackRawUsage : undefined;
    const usage = agyResultUsage ?? fallbackUsage;
    if (usage || agyAgentTurns > 0 || agyToolCalls > 0) {
      return {
        ...(usage ? { usage } : {}),
        turnsCount: Math.max(agyAgentTurns, 1),
        toolCallsCount: agyToolCalls,
        toolErrorCount: agyToolErrors,
        estimated: !agyResultUsage,
      };
    }
  }

  let codexReportedTotal = 0;
  const codexMatches = cleaned.matchAll(/tokens used\s*[\r\n]+\s*([\d,]+)/gi);
  for (const m of codexMatches) {
    const parsed = Number(String(m[1] ?? "").replace(/,/g, ""));
    if (Number.isFinite(parsed) && parsed > 0) codexReportedTotal = parsed;
  }

  let stepCount = 0;
  let thinkingCount = 0;
  let toolCallsCount = 0;
  let toolErrorCount = 0;
  let assistantTextChars = 0;
  let inWorkbenchHeader = true;
  let seenLauncherCmd = false;

  const lines = cleaned.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("[workbench:")) {
      inWorkbenchHeader = true;
      continue;
    }

    if (OPENCODE_STEP_LINE_RE.test(trimmed)) {
      inWorkbenchHeader = false;
      stepCount++;
      continue;
    }

    if (trimmed === "thinking" || /^Thinking:/i.test(trimmed)) {
      inWorkbenchHeader = false;
      thinkingCount++;
      continue;
    }

    const ocTool = trimmed.match(OPENCODE_TOOL_LINE_RE);
    if (ocTool) {
      inWorkbenchHeader = false;
      toolCallsCount++;
      if (/\b(error|failed|enoent|exit\s+[1-9])\b/i.test(ocTool[2] ?? "")) {
        toolErrorCount++;
      }
      continue;
    }

    if (SHELL_CMD_LINE_RE.test(trimmed)) {
      if (!seenLauncherCmd && inWorkbenchHeader) {
        seenLauncherCmd = true;
        continue;
      }
      seenLauncherCmd = true;
      inWorkbenchHeader = false;
      toolCallsCount++;
      continue;
    }

    if (trimmed === "exec" || trimmed.startsWith("\ud83d\udd27")) {
      inWorkbenchHeader = false;
      toolCallsCount++;
      continue;
    }

    if (/^(Error|Tool error|Failed to)\b/i.test(trimmed)) {
      toolErrorCount++;
    }

    if (!inWorkbenchHeader) {
      assistantTextChars += trimmed.length;
    }
    if (trimmed.startsWith("> ") || trimmed.startsWith("assistant:")) {
      inWorkbenchHeader = false;
    }
  }

  const turnsCount =
    stepCount > 0
      ? stepCount
      : thinkingCount > 0
        ? thinkingCount
        : toolCallsCount > 0
          ? Math.min(toolCallsCount + 1, 200)
          : assistantTextChars > 0
            ? 1
            : 0;

  if (codexReportedTotal > 0) {
    const inputTokens = Math.round(codexReportedTotal * 0.82);
    const outputTokens = Math.max(0, codexReportedTotal - inputTokens);
    return {
      usage: {
        inputTokens,
        uncachedInputTokens: inputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens,
        reasoningTokens: 0,
        totalTokens: codexReportedTotal,
      },
      turnsCount: Math.max(turnsCount, 1),
      toolCallsCount,
      toolErrorCount,
      estimated: true,
    };
  }

  // Filter out header-only logs with no model activity yet.
  const bodyLines = lines.filter((l) => l.trim() && !l.trim().startsWith("[workbench:"));
  if (bodyLines.length === 0) return {};

  const bodyText = bodyLines.join("\n");
  const bodyTokens = Math.max(1, estimateTokens(bodyText));
  const estimatedOutput = Math.max(1, Math.round(bodyTokens * 0.28));
  const estimatedInput = Math.max(bodyTokens - estimatedOutput, toolCallsCount * 350, 1);
  const totalTokens = estimatedInput + estimatedOutput;
  if (totalTokens <= 0) return {};

  return {
    usage: {
      inputTokens: estimatedInput,
      uncachedInputTokens: estimatedInput,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: estimatedOutput,
      reasoningTokens: 0,
      totalTokens,
    },
    turnsCount: Math.max(turnsCount, 1),
    toolCallsCount,
    toolErrorCount,
    estimated: true,
  };
}

/** Backfill quota pool, billing mode, context window, estimated log usage, and cost on any run record. */
export function enrichAgentRunRecord<T extends AgentRunRecord>(
  run: T,
  rawLog?: string,
  options?: {
    harnesses?: HarnessInfo[];
    observability?: HubObservabilityConfig;
  },
): T & AgentRunRecord {
  if (!run || typeof run !== "object") return run;
  const harness = typeof run.harness === "string" ? run.harness : "";
  const model = typeof run.model === "string" ? run.model : "";
  if (!harness && !model) return run;

  const obs = options?.observability;
  const pool = resolveQuotaPool(harness, model, { billingOverrides: obs?.billingOverrides });
  const spec = resolveModelSpec(harness, model, options?.harnesses, obs);
  const inferred = !run.usage && rawLog ? inferRunMetricsFromRawLog(rawLog) : {};

  const usage = run.usage ?? inferred.usage;
  const quotaPool = run.quotaPool || pool.quotaPool;
  const billingMode = run.billingMode || pool.billingMode;
  const contextWindow = run.contextWindow ?? spec.contextWindow;
  const turnsCount = run.turnsCount ?? inferred.turnsCount;
  const toolCallsCount = run.toolCallsCount ?? inferred.toolCallsCount;
  const toolErrorCount = run.toolErrorCount ?? inferred.toolErrorCount;

  const cost =
    run.cost && run.cost.costSource !== "unknown"
      ? run.cost
      : usage && usage.totalTokens > 0
        ? computeRunCost(usage, spec, billingMode, quotaPool)
        : run.cost;

  return {
    ...run,
    quotaPool,
    billingMode,
    contextWindow,
    ...(usage ? { usage } : {}),
    ...(cost ? { cost } : {}),
    ...(typeof turnsCount === "number" ? { turnsCount } : {}),
    ...(typeof toolCallsCount === "number" ? { toolCallsCount } : {}),
    ...(typeof toolErrorCount === "number" ? { toolErrorCount } : {}),
  };
}
