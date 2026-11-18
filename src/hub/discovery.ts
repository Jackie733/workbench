import { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteJson, readJsonStrict } from "../core/fs.ts";
import { resolveHubDir } from "./registry.ts";
import { REASONING_EFFORTS, type DiscoveredModel, type HarnessId, type HarnessInfo, type ReasoningEffort } from "./types.ts";

export interface ProbeDependencies {
  homeDir?: string;
  hubDir?: string | null;
  which?: (cmd: string) => string | null;
  runCmd?: (cmd: string, args: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string }>;
}

const VALID_EFFORTS = new Set<string>(REASONING_EFFORTS);
const EFFORT_ORDER: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra", "auto"];

function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return typeof v === "string" && VALID_EFFORTS.has(v);
}

function sortEfforts(efforts: Iterable<ReasoningEffort>): ReasoningEffort[] {
  const uniq = new Set<ReasoningEffort>(efforts);
  return Array.from(uniq).sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
}

function defaultWhich(cmd: string): string | null {
  const found = Bun.which(cmd);
  if (found) return found;
  const home = os.homedir();
  const candidates = [
    path.join(home, ".qoder-cn/entry", cmd),
    path.join(home, ".opencode/bin", cmd),
    path.join(home, ".local/share/mise/installs/node/24.18.0/bin", cmd),
    path.join(home, ".local/share/mise/installs/github-can1357-oh-my-pi/latest", cmd),
    path.join(home, ".local/bin", cmd),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function defaultRunCmd(cmd: string, args: string[], timeoutMs = 6000): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      const exitCode =
        err && typeof (err as { code?: unknown }).code === "number"
          ? ((err as { code: number }).code ?? 1)
          : err
            ? 1
            : 0;
      resolve({ code: exitCode, stdout: stdout ?? "" });
    });
  });
}

const REVIEW_TOKEN_RE = /(?:^|[-_/])(auto-review|code-review|reviewer)(?:$|[-_/])/i;
const FAST_TOKEN_RE = /(?:^|[-_/])(flash|fast|small|mini|lite|luna|haiku|free|lightning)(?:$|[-_/])/i;
const SOTA_TOKEN_RE = /(?:^|[-_/])(sol|astra|hydrogen|opus|ultra|pro|max|orchestrator|sonnet|argon)(?:$|[-_/])/i;

export interface ModelCapabilityMeta {
  intelligence?: number;
  cost?: { input: number; output: number };
  isFree?: boolean;
  isLegacy?: boolean;
  priority?: number;
  reasoning?: boolean;
  supportedEfforts?: ReasoningEffort[];
  defaultEffort?: ReasoningEffort;
}

export function classifyTier(modelId: string, meta?: ModelCapabilityMeta): DiscoveredModel["tier"] {
  const clean = modelId.trim();
  const lower = clean.toLowerCase();
  if (REVIEW_TOKEN_RE.test(lower)) return "review";
  if (lower === "fast" || FAST_TOKEN_RE.test(lower)) return "fast";
  if (meta?.isFree) return "fast";
  if (typeof meta?.intelligence === "number") {
    if (meta.intelligence >= 42.5) return "sota";
    if (meta.intelligence >= 20) return "balanced";
    return "fast";
  }
  if (SOTA_TOKEN_RE.test(lower)) return "sota";
  return "balanced";
}

interface RawModelSpec {
  id: string;
  label?: string;
  provider?: string;
  supportedEfforts?: ReasoningEffort[];
  defaultEffort?: ReasoningEffort;
  intelligence?: number;
  cost?: { input: number; output: number };
  isFree?: boolean;
  isLegacy?: boolean;
  priority?: number;
  effortLocked?: boolean;
  effortVariants?: Partial<Record<ReasoningEffort, string>>;
}

function canonicalModelKey(rawId: string): string {
  const trimmed = rawId.trim().toLowerCase();
  const slashIdx = trimmed.indexOf("/");
  const bare = slashIdx >= 0 ? trimmed.slice(slashIdx + 1) : trimmed;
  return bare.replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");
}

function stripEffortSuffix(id: string): { baseId: string; effort?: ReasoningEffort } {
  const match = /^(.+)-(minimal|low|medium|high|xhigh|max)$/i.exec(id.trim());
  if (!match) return { baseId: id.trim() };
  const effort = match[2]!.toLowerCase();
  if (!isReasoningEffort(effort)) return { baseId: id.trim() };
  return { baseId: match[1]!, effort };
}

interface CapabilityIndex {
  byProviderAndId: Map<string, ModelCapabilityMeta>;
  byCanonicalId: Map<string, ModelCapabilityMeta>;
}

function lookupCapability(
  index: CapabilityIndex,
  modelId: string,
  provider?: string,
): { meta?: ModelCapabilityMeta; exactProvider: boolean } {
  const clean = modelId.trim();
  const slashIdx = clean.indexOf("/");
  const effectiveProvider = provider ?? (slashIdx > 0 ? clean.slice(0, slashIdx) : undefined);
  const bareId = slashIdx > 0 ? clean.slice(slashIdx + 1) : clean;
  const bareLower = bareId.toLowerCase();
  const canonical = canonicalModelKey(clean);
  const stripped = stripEffortSuffix(clean);
  const strippedCanonical = canonicalModelKey(stripped.baseId);

  if (effectiveProvider) {
    const exactProv =
      index.byProviderAndId.get(`${effectiveProvider}::${bareLower}`) ??
      index.byProviderAndId.get(`${effectiveProvider}::${canonical}`) ??
      index.byProviderAndId.get(`${effectiveProvider}::${strippedCanonical}`);
    if (exactProv) return { meta: exactProv, exactProvider: true };
  }

  const cross =
    index.byCanonicalId.get(bareLower) ??
    index.byCanonicalId.get(canonical) ??
    index.byCanonicalId.get(strippedCanonical);
  return { meta: cross, exactProvider: false };
}

function mergeCapability(
  spec: RawModelSpec,
  index: CapabilityIndex,
  preferredProvider?: string,
): RawModelSpec {
  const { meta, exactProvider } = lookupCapability(index, spec.id, spec.provider ?? preferredProvider);
  const freeById = /-free$/i.test(spec.id.trim());
  if (!meta) {
    return freeById ? { ...spec, isFree: true } : spec;
  }

  // Only inherit provider-bound properties (supportedEfforts, isFree, cost, reasoning) on exact provider match;
  // cross-provider fallback only shares intrinsic intelligence score.
  const supportedEfforts =
    spec.supportedEfforts !== undefined
      ? spec.supportedEfforts
      : exactProvider
        ? meta.reasoning === false
          ? []
          : meta.supportedEfforts
        : undefined;
  const isFree = spec.isFree ?? (freeById || (exactProvider ? meta.isFree : undefined));
  const cost = spec.cost ?? (exactProvider ? meta.cost : undefined);

  return {
    ...spec,
    ...(supportedEfforts !== undefined ? { supportedEfforts } : {}),
    ...(spec.defaultEffort ?? (exactProvider ? meta.defaultEffort : undefined)
      ? { defaultEffort: spec.defaultEffort ?? meta.defaultEffort }
      : {}),
    ...(spec.intelligence ?? meta.intelligence !== undefined
      ? { intelligence: spec.intelligence ?? meta.intelligence }
      : {}),
    ...(cost ? { cost } : {}),
    ...(isFree ? { isFree: true } : {}),
    ...(spec.isLegacy ?? meta.isLegacy ? { isLegacy: spec.isLegacy ?? meta.isLegacy } : {}),
    ...(spec.priority ?? (exactProvider ? meta.priority : undefined) !== undefined
      ? { priority: spec.priority ?? meta.priority }
      : {}),
  };
}

function mergeModels(
  detected: Array<string | RawModelSpec>,
  source: DiscoveredModel["source"] = "detected",
  capIndex?: CapabilityIndex,
  preferredProvider?: string,
): DiscoveredModel[] {
  const seen = new Set<string>();
  const out: DiscoveredModel[] = [];

  for (const entry of detected) {
    const rawSpec: RawModelSpec = typeof entry === "string" ? { id: entry } : entry;
    const clean = rawSpec.id.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);

    const spec = capIndex ? mergeCapability({ ...rawSpec, id: clean }, capIndex, preferredProvider) : { ...rawSpec, id: clean };
    const meta: ModelCapabilityMeta = {
      intelligence: spec.intelligence,
      cost: spec.cost,
      isFree: spec.isFree,
      isLegacy: spec.isLegacy,
      priority: spec.priority,
      supportedEfforts: spec.supportedEfforts,
      defaultEffort: spec.defaultEffort,
    };

    out.push({
      id: clean,
      ...(spec.label ? { label: spec.label } : {}),
      ...(spec.provider ? { provider: spec.provider } : {}),
      tier: classifyTier(clean, meta),
      source,
      ...(spec.supportedEfforts !== undefined ? { supportedEfforts: spec.supportedEfforts } : {}),
      ...(spec.defaultEffort ? { defaultEffort: spec.defaultEffort } : {}),
      ...(typeof spec.intelligence === "number" ? { intelligence: spec.intelligence } : {}),
      ...(spec.cost ? { cost: spec.cost } : {}),
      ...(spec.isFree ? { isFree: true } : {}),
      ...(spec.isLegacy ? { isLegacy: true } : {}),
      ...(typeof spec.priority === "number" ? { priority: spec.priority } : {}),
      ...(spec.effortLocked ? { effortLocked: true } : {}),
      ...(spec.effortVariants ? { effortVariants: spec.effortVariants } : {}),
    });
  }

  return out;
}

const QODER_DEFAULT_MODELS = [
  "Auto",
  "Fast",
  "Qwen4-Max",
  "Qwen4-Max-Preview",
  "Qwen3.8-Max",
  "Qwen3.8-Flash",
  "DeepSeek-V4-Pro",
  "DeepSeek-Flash",
  "GLM-5.3",
  "GLM-5.3-Flash",
  "Kimi-K3.1-Pro",
  "Kimi-K2.8-Preview",
  "Step-5-Preview",
  "MiniMax-M3.1-Flash",
];

const QODER_EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
const OMP_EFFORTS: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max", "auto"];

const AGY_DEFAULT_MODELS: RawModelSpec[] = [
  { id: "gemini-4-hydrogen-xhigh", label: "Gemini 4 Hydrogen (XHigh)" },
  { id: "gemini-4-hydrogen-high", label: "Gemini 4 Hydrogen (High)" },
  { id: "gemini-4-hydrogen-medium", label: "Gemini 4 Hydrogen (Medium)" },
  { id: "gemini-4-hydrogen-low", label: "Gemini 4 Hydrogen (Low)" },
  { id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" },
  { id: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium)" },
  { id: "gemini-4-argon-low", label: "Gemini 4 Argon (Low)" },
  { id: "gemini-pro-orchestrator-g1-pro", label: "Orchestrator (Argon)" },
  { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
  { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
  { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
  { id: "claude-opus-5-5-high", label: "Claude Opus 5.5 (High)" },
  { id: "claude-opus-5-5-medium", label: "Claude Opus 5.5 (Medium)" },
  { id: "claude-opus-5-5-low", label: "Claude Opus 5.5 (Low)" },
  { id: "claude-sonnet-5-5-high", label: "Claude Sonnet 5.5 (High)" },
  { id: "claude-sonnet-5-5-medium", label: "Claude Sonnet 5.5 (Medium)" },
  { id: "claude-sonnet-5-5-low", label: "Claude Sonnet 5.5 (Low)" },
  { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
];

const OPENCODE_DEFAULT_MODELS = [
  "opencode/beam-free",
  "opencode/big-pickle",
  "opencode/deepseek-v4.1-flash-free",
  "opencode/flint-40b-free",
  "opencode/glm-5.3-flash-free",
  "opencode/hy4-flash-free",
  "opencode/iceman-free",
  "opencode/inkling-2-small-free",
  "opencode/longcat-2.5-free",
  "opencode/mimo-v2.6-flash-free",
  "opencode/minimax-m3.1-flash-free",
  "opencode/nemotron-3.5-lightning-free",
  "opencode/nemotron-3.5-super-vl-free",
];

function parseCodexModels(homeDir: string): { models: RawModelSpec[]; defaultModel: string | null } {
  const models: RawModelSpec[] = [];
  let defaultModel: string | null = null;
  try {
    const cachePath = path.join(homeDir, ".codex/models_cache.json");
    if (fs.existsSync(cachePath)) {
      const raw = JSON.parse(fs.readFileSync(cachePath, "utf8")) as {
        models?: Array<{
          slug?: string;
          id?: string;
          display_name?: string;
          description?: string;
          priority?: number;
          visibility?: string;
          default_reasoning_level?: string;
          supported_reasoning_levels?: Array<{ effort?: string }>;
        }>;
      };
      const list = Array.isArray(raw.models) ? raw.models : [];
      for (const item of list) {
        const slug = (item.slug ?? item.id)?.trim();
        if (!slug) continue;
        const efforts = Array.isArray(item.supported_reasoning_levels)
          ? item.supported_reasoning_levels.map((e) => e.effort).filter(isReasoningEffort)
          : undefined;
        const defEffort = isReasoningEffort(item.default_reasoning_level) ? item.default_reasoning_level : undefined;
        const desc = typeof item.description === "string" ? item.description : "";
        const isLegacy =
          /\b(previous generation|legacy|deprecated)\b/i.test(desc) ||
          (item.visibility === "hide" && !REVIEW_TOKEN_RE.test(slug));
        models.push({
          id: slug,
          provider: "openai-codex",
          ...(item.display_name ? { label: item.display_name } : {}),
          ...(efforts && efforts.length > 0 ? { supportedEfforts: efforts } : {}),
          ...(defEffort ? { defaultEffort: defEffort } : {}),
          ...(typeof item.priority === "number" ? { priority: item.priority } : {}),
          ...(isLegacy ? { isLegacy: true } : {}),
        });
      }
    }
  } catch {
    // Ignore malformed codex cache.
  }
  try {
    const cfgPath = path.join(homeDir, ".codex/config.toml");
    if (fs.existsSync(cfgPath)) {
      const toml = fs.readFileSync(cfgPath, "utf8");
      const m = /^model\s*=\s*"([^"]+)"/m.exec(toml);
      if (m?.[1]) defaultModel = m[1];
    }
  } catch {
    // Ignore unreadable codex config.
  }

  if (models.length === 0) {
    const fallbackEfforts: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
    return {
      models: [
        { id: "gpt-6.2-sol", supportedEfforts: [...fallbackEfforts, "ultra"], defaultEffort: "low", priority: 1 },
        { id: "gpt-6.2-astra", supportedEfforts: [...fallbackEfforts, "ultra"], defaultEffort: "low", priority: 2 },
        { id: "gpt-6.1-terra", supportedEfforts: [...fallbackEfforts, "ultra"], defaultEffort: "low", priority: 3 },
        { id: "codex-auto-review", supportedEfforts: fallbackEfforts, defaultEffort: "medium", priority: 12 },
      ],
      defaultModel,
    };
  }
  return { models, defaultModel };
}

function parseOmpDefaultModel(homeDir: string): string | null {
  try {
    const cfgPath = path.join(homeDir, ".omp/agent/config.yml");
    if (!fs.existsSync(cfgPath)) return null;
    const yml = fs.readFileSync(cfgPath, "utf8");
    const m = /default:\s*([^\s#]+)/m.exec(yml);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

interface OmpSqliteCatalog {
  ompModels: RawModelSpec[];
  opencodeGoModels: RawModelSpec[];
  capabilityIndex: CapabilityIndex;
}

interface RawModelsDbItem {
  id?: string;
  name?: string;
  reasoning?: boolean;
  int?: number;
  priority?: number;
  cost?: { input?: number; output?: number };
  thinking?: { efforts?: unknown[] };
}

const TRUSTED_CAPABILITY_PROVIDERS = new Set([
  "openai-codex",
  "openai",
  "anthropic",
  "google-antigravity",
  "google",
  "google-vertex",
  "opencode-go",
  "deepseek",
  "moonshot",
  "zai",
  "alibaba-coding-plan",
  "minimax",
  "minimax-cn",
  "xai",
]);

function upsertCapability(
  index: CapabilityIndex,
  provider: string,
  modelId: string,
  meta: ModelCapabilityMeta,
): void {
  const bare = modelId.trim().toLowerCase();
  const canonical = canonicalModelKey(modelId);
  const provKey = `${provider}::${bare}`;
  const provCanonKey = `${provider}::${canonical}`;

  const mergeMeta = (prev: ModelCapabilityMeta | undefined, next: ModelCapabilityMeta): ModelCapabilityMeta => {
    if (!prev) return next;
    return {
      intelligence: prev.intelligence ?? next.intelligence,
      cost: prev.cost ?? next.cost,
      isFree: prev.isFree ?? next.isFree,
      isLegacy: prev.isLegacy ?? next.isLegacy,
      priority: prev.priority ?? next.priority,
      reasoning: prev.reasoning ?? next.reasoning,
      supportedEfforts: prev.supportedEfforts ?? next.supportedEfforts,
      defaultEffort: prev.defaultEffort ?? next.defaultEffort,
    };
  };

  index.byProviderAndId.set(provKey, mergeMeta(index.byProviderAndId.get(provKey), meta));
  index.byProviderAndId.set(provCanonKey, mergeMeta(index.byProviderAndId.get(provCanonKey), meta));

  // Cross-provider canonical index only stores intrinsic intelligence & isLegacy from trusted providers first.
  const isTrusted = TRUSTED_CAPABILITY_PROVIDERS.has(provider);
  const prevCanon = index.byCanonicalId.get(canonical);
  const canonMeta: ModelCapabilityMeta = {
    ...(meta.intelligence !== undefined ? { intelligence: meta.intelligence } : {}),
    ...(meta.isLegacy ? { isLegacy: true } : {}),
  };
  if (canonMeta.intelligence === undefined && !canonMeta.isLegacy) return;

  if (!prevCanon) {
    index.byCanonicalId.set(canonical, canonMeta);
  } else if (isTrusted && canonMeta.intelligence !== undefined) {
    // Trusted provider intelligence overrides untrusted aggregator scores.
    index.byCanonicalId.set(canonical, {
      ...prevCanon,
      intelligence: canonMeta.intelligence,
      ...(canonMeta.isLegacy ? { isLegacy: true } : {}),
    });
  } else {
    index.byCanonicalId.set(canonical, {
      intelligence: prevCanon.intelligence ?? canonMeta.intelligence,
      isLegacy: prevCanon.isLegacy ?? canonMeta.isLegacy,
    });
  }
}

function readOmpSqliteCatalog(homeDir: string): OmpSqliteCatalog {
  const ompModels: RawModelSpec[] = [];
  const opencodeGoModels: RawModelSpec[] = [];
  const capabilityIndex: CapabilityIndex = {
    byProviderAndId: new Map(),
    byCanonicalId: new Map(),
  };

  const agentDbPath = path.join(homeDir, ".omp/agent/agent.db");
  const modelsDbPath = path.join(homeDir, ".omp/agent/models.db");

  const activeProviders = new Set<string>();
  const usedModelKeys: string[] = [];

  if (fs.existsSync(agentDbPath)) {
    let agentDb: Database | null = null;
    try {
      agentDb = new Database(agentDbPath, { readonly: true });
      const creds = agentDb
        .query("SELECT provider, disabled_cause FROM auth_credentials WHERE disabled_cause IS NULL")
        .all() as Array<{ provider?: string }>;
      for (const row of creds) {
        if (row.provider) activeProviders.add(row.provider);
      }
      const usages = agentDb
        .query("SELECT model_key FROM model_usage ORDER BY last_used_at DESC LIMIT 40")
        .all() as Array<{ model_key?: string }>;
      for (const row of usages) {
        if (row.model_key && row.model_key.includes("/")) usedModelKeys.push(row.model_key);
      }
      const perfs = agentDb
        .query("SELECT model_key FROM model_perf ORDER BY updated_at DESC LIMIT 30")
        .all() as Array<{ model_key?: string }>;
      for (const row of perfs) {
        if (row.model_key && row.model_key.includes("/")) usedModelKeys.push(row.model_key);
      }
    } catch {
      // Ignore unreadable agent.db
    } finally {
      try {
        agentDb?.close();
      } catch {
        // ignore
      }
    }
  }

  for (const key of usedModelKeys) {
    const slashIdx = key.indexOf("/");
    const provider = slashIdx > 0 ? key.slice(0, slashIdx) : "omp";
    ompModels.push({ id: key, provider, supportedEfforts: OMP_EFFORTS });
  }

  if (activeProviders.has("qoder-cn")) {
    for (const qId of QODER_DEFAULT_MODELS) {
      if (qId === "Auto" || qId === "Fast") continue;
      ompModels.push({
        id: `qoder-cn/${qId}`,
        label: `qoder-cn · ${qId}`,
        provider: "qoder-cn",
        supportedEfforts: OMP_EFFORTS,
      });
    }
  }

  if (fs.existsSync(modelsDbPath)) {
    let modelsDb: Database | null = null;
    try {
      modelsDb = new Database(modelsDbPath, { readonly: true });
      const rows = modelsDb
        .query("SELECT provider_id, models FROM model_cache ORDER BY updated_at DESC")
        .all() as Array<{ provider_id: string; models: string }>;
      const seenProviderBase = new Set<string>();

      for (const row of rows) {
        const baseProvider = row.provider_id.split(":")[0]!;
        if (seenProviderBase.has(baseProvider)) continue;
        seenProviderBase.add(baseProvider);

        let parsed: RawModelsDbItem[] = [];
        try {
          parsed = JSON.parse(row.models) as RawModelsDbItem[];
        } catch {
          continue;
        }
        if (!Array.isArray(parsed)) continue;

        for (const m of parsed) {
          if (!m.id || m.id.includes("image") || m.id.startsWith("tab_")) continue;
          const efforts = Array.isArray(m.thinking?.efforts)
            ? sortEfforts(m.thinking!.efforts.filter(isReasoningEffort))
            : undefined;
          const hasCost =
            m.cost && typeof m.cost.input === "number" && typeof m.cost.output === "number";
          const cost = hasCost ? { input: m.cost!.input!, output: m.cost!.output! } : undefined;
          // google-antigravity entries use 0/0 cost as placeholder for subscription-bundled models.
          const isFree =
            /-free$/i.test(m.id) ||
            Boolean(hasCost && cost!.input === 0 && cost!.output === 0 && baseProvider !== "google-antigravity");

          const meta: ModelCapabilityMeta = {
            ...(typeof m.int === "number" && Number.isFinite(m.int) ? { intelligence: m.int } : {}),
            ...(cost ? { cost } : {}),
            ...(isFree ? { isFree: true } : {}),
            ...(typeof m.priority === "number" ? { priority: m.priority } : {}),
            ...(typeof m.reasoning === "boolean" ? { reasoning: m.reasoning } : {}),
            ...(m.reasoning === false
              ? { supportedEfforts: [] }
              : efforts && efforts.length > 0
                ? { supportedEfforts: efforts }
                : {}),
          };
          upsertCapability(capabilityIndex, baseProvider, m.id, meta);

          if (baseProvider === "opencode-go") {
            opencodeGoModels.push({
              id: `opencode-go/${m.id}`,
              label: m.name || m.id,
              provider: "opencode-go",
              ...(meta.supportedEfforts ? { supportedEfforts: meta.supportedEfforts } : {}),
            });
          }

          const isActive =
            activeProviders.has(baseProvider) ||
            (baseProvider === "deepseek" && usedModelKeys.some((k) => k.startsWith("deepseek/")));
          if (isActive) {
            ompModels.push({
              id: `${baseProvider}/${m.id}`,
              label: m.name ? `${baseProvider} · ${m.name}` : undefined,
              provider: baseProvider,
              supportedEfforts: m.reasoning === false ? [] : (efforts && efforts.length > 0 ? efforts : OMP_EFFORTS),
            });
          }
        }
      }
    } catch {
      // Ignore unreadable models.db
    } finally {
      try {
        modelsDb?.close();
      } catch {
        // ignore
      }
    }
  }

  return { ompModels, opencodeGoModels, capabilityIndex };
}

function parseAgyCliOutput(stdout: string): RawModelSpec[] {
  // Strip ANSI escape codes and carriage returns produced by spinner
  const clean = stdout.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "\n");
  const out: RawModelSpec[] = [];
  for (const rawLine of clean.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.includes("Fetching available models")) continue;
    const match = /^([a-z0-9][a-z0-9._-]+)(?:(?:\t+|\s{2,})(.+))?$/i.exec(line);
    if (!match) continue;
    const id = match[1]!.trim();
    const label = match[2]?.trim();
    out.push({
      id,
      ...(label ? { label } : {}),
      provider: "google-antigravity",
    });
  }
  return out;
}

/**
 * Aggregates AGY effort-suffixed variant IDs (e.g. `gemini-4-hydrogen-high`) into
 * a single logical family model (`gemini-4-hydrogen`) when multiple variants exist,
 * while locking single-variant models (`gpt-oss-120b-medium`) and leaving fixed-policy
 * models (`gemini-pro-orchestrator-g1-pro`) with no effort selector.
 */
function normalizeAgyModels(specs: RawModelSpec[]): RawModelSpec[] {
  const groups = new Map<string, Array<{ raw: RawModelSpec; effort?: ReasoningEffort }>>();
  const order: string[] = [];

  for (const spec of specs) {
    const { baseId, effort } = stripEffortSuffix(spec.id);
    const groupKey = effort ? baseId : spec.id;
    let bucket = groups.get(groupKey);
    if (!bucket) {
      bucket = [];
      groups.set(groupKey, bucket);
      order.push(groupKey);
    }
    bucket.push({ raw: spec, effort });
  }

  const out: RawModelSpec[] = [];
  for (const groupKey of order) {
    const entries = groups.get(groupKey)!;
    const effortEntries = entries.filter((e): e is { raw: RawModelSpec; effort: ReasoningEffort } => Boolean(e.effort));

    if (effortEntries.length >= 2) {
      const variants: Partial<Record<ReasoningEffort, string>> = {};
      for (const item of effortEntries) {
        if (!variants[item.effort]) variants[item.effort] = item.raw.id;
      }
      const supportedEfforts = sortEfforts(Object.keys(variants) as ReasoningEffort[]);
      const firstLabel = effortEntries[0]?.raw.label;
      const cleanLabel = firstLabel
        ? firstLabel.replace(/\s*\((minimal|low|medium|high|xhigh|max)\)\s*$/i, "").trim()
        : undefined;
      const defaultEffort: ReasoningEffort =
        (groupKey.includes("hydrogen") || groupKey.includes("opus")) && supportedEfforts.includes("high")
          ? "high"
          : supportedEfforts.includes("medium")
            ? "medium"
            : supportedEfforts[0]!;
      out.push({
        id: groupKey,
        ...(cleanLabel ? { label: cleanLabel } : {}),
        provider: "google-antigravity",
        supportedEfforts,
        defaultEffort,
        effortVariants: variants,
      });
    } else if (effortEntries.length === 1) {
      const only = effortEntries[0]!;
      out.push({
        ...only.raw,
        provider: "google-antigravity",
        supportedEfforts: [only.effort],
        defaultEffort: only.effort,
        effortLocked: true,
      });
    } else {
      const single = entries[0]!.raw;
      out.push({
        ...single,
        provider: "google-antigravity",
        supportedEfforts: [],
      });
    }
  }
  return out;
}

function qoderSpecsFromIds(ids: string[]): RawModelSpec[] {
  return ids.map((id) => {
    if (id === "Auto" || id === "Fast") {
      return { id, supportedEfforts: [] };
    }
    return {
      id,
      supportedEfforts: QODER_EFFORTS,
    };
  });
}

function enrichCodexIndex(index: CapabilityIndex, codexModels: RawModelSpec[]): void {
  for (const m of codexModels) {
    upsertCapability(index, "openai-codex", m.id, {
      ...(m.priority !== undefined ? { priority: m.priority } : {}),
      ...(m.isLegacy ? { isLegacy: true } : {}),
      ...(m.supportedEfforts ? { supportedEfforts: m.supportedEfforts } : {}),
      ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}),
    });
  }
}

export function harnessesSnapshotPath(hubDir?: string): string {
  return path.join(hubDir ?? resolveHubDir(), "harnesses-snapshot.json");
}

interface HarnessesSnapshotFile {
  schemaVersion: 1;
  savedAt: number;
  harnesses: HarnessInfo[];
}

function readHarnessesSnapshot(hubDir: string | null): Map<HarnessId, HarnessInfo> {
  const map = new Map<HarnessId, HarnessInfo>();
  if (!hubDir) return map;
  try {
    const filePath = harnessesSnapshotPath(hubDir);
    if (!fs.existsSync(filePath)) return map;
    const raw = readJsonStrict<Partial<HarnessesSnapshotFile>>(filePath, 1024 * 1024);
    if (!raw || !Array.isArray(raw.harnesses)) return map;
    for (const h of raw.harnesses) {
      if (h && isKnownHarnessId(h.id) && Array.isArray(h.models)) {
        map.set(h.id, h);
      }
    }
  } catch {
    // Ignore unreadable or malformed snapshot.
  }
  return map;
}

function writeHarnessesSnapshot(hubDir: string | null, harnesses: HarnessInfo[]): void {
  if (!hubDir) return;
  try {
    fs.mkdirSync(hubDir, { recursive: true, mode: 0o700 });
    atomicWriteJson(harnessesSnapshotPath(hubDir), {
      schemaVersion: 1,
      savedAt: Date.now(),
      harnesses,
    } satisfies HarnessesSnapshotFile);
  } catch {
    // Best-effort cache write.
  }
}

function resolveSnapshotHubDir(deps: Pick<ProbeDependencies, "hubDir" | "homeDir" | "which" | "runCmd">): string | null {
  if (deps.hubDir !== undefined) return deps.hubDir;
  if (deps.homeDir !== undefined || deps.which !== undefined || deps.runCmd !== undefined) return null;
  return resolveHubDir();
}

/** Returns a lightweight fingerprint of local CLI model caches to detect external updates. */
export function getLocalCatalogFingerprint(homeDir = os.homedir()): string {
  const watchFiles = [
    path.join(homeDir, ".codex/models_cache.json"),
    path.join(homeDir, ".codex/config.toml"),
    path.join(homeDir, ".omp/agent/models.db"),
    path.join(homeDir, ".omp/agent/agent.db"),
    path.join(homeDir, ".omp/agent/config.yml"),
  ];
  return watchFiles
    .map((p) => {
      try {
        const st = fs.statSync(p);
        return `${Math.round(st.mtimeMs)}:${st.size}`;
      } catch {
        return "0";
      }
    })
    .join("|");
}

export function discoverHarnessesQuick(
  deps: Pick<ProbeDependencies, "homeDir" | "which" | "hubDir"> = {},
): HarnessInfo[] {
  const homeDir = deps.homeDir ?? os.homedir();
  const which = deps.which ?? defaultWhich;
  const hubDir = resolveSnapshotHubDir(deps);
  const snapshot = readHarnessesSnapshot(hubDir);
  const now = Date.now();

  const codexBin = which("codex");
  const qoderBin = which("qodercn");
  const opencodeBin = which("opencode");
  const agyBin = which("agy");
  const ompBin = which("omp");

  const codexParsed = parseCodexModels(homeDir);
  const sqliteCatalog = readOmpSqliteCatalog(homeDir);
  const capIndex = sqliteCatalog.capabilityIndex;
  enrichCodexIndex(capIndex, codexParsed.models);

  const ompDefault = parseOmpDefaultModel(homeDir) ?? "openai-codex/gpt-6.2-sol";
  const ompList: RawModelSpec[] = [
    { id: ompDefault, provider: ompDefault.split("/")[0] || "omp", supportedEfforts: OMP_EFFORTS },
    ...sqliteCatalog.ompModels,
  ];

  const snapQoder = snapshot.get("qodercn");
  const snapOpencode = snapshot.get("opencode");
  const snapAgy = snapshot.get("agy");

  const qoderModels =
    snapQoder && snapQoder.models.length > 0 && snapQoder.executable === qoderBin
      ? snapQoder.models
      : mergeModels(qoderSpecsFromIds(QODER_DEFAULT_MODELS), "builtin", capIndex, "qoder-cn");

  const opencodeFallbackList: Array<string | RawModelSpec> = [
    ...OPENCODE_DEFAULT_MODELS,
    ...sqliteCatalog.opencodeGoModels,
  ];
  const opencodeModels =
    snapOpencode && snapOpencode.models.length > 0 && snapOpencode.executable === opencodeBin
      ? snapOpencode.models
      : mergeModels(opencodeFallbackList, "builtin", capIndex);

  const agyModels =
    snapAgy && snapAgy.models.length > 0 && snapAgy.executable === agyBin
      ? snapAgy.models
      : mergeModels(normalizeAgyModels(AGY_DEFAULT_MODELS), "builtin", capIndex, "google-antigravity");

  return [
    {
      id: "codex",
      label: "Codex CLI",
      subscription: "ChatGPT Plus",
      installed: Boolean(codexBin),
      executable: codexBin,
      models: mergeModels(codexParsed.models, "detected", capIndex, "openai-codex"),
      defaultModel: codexParsed.defaultModel ?? codexParsed.models[0]?.id ?? null,
      detectedAt: now,
    },
    {
      id: "qodercn",
      label: "QoderCN",
      subscription: "QoderCN 订阅",
      installed: Boolean(qoderBin),
      executable: qoderBin,
      models: qoderModels,
      defaultModel: snapQoder?.defaultModel ?? "Qwen4-Max",
      detectedAt: now,
      note: snapQoder
        ? "模型目录来自本地探测快照，后台将自动增量刷新"
        : "模型目录为内置名单，CLI 枚举完成后自动刷新；未验证当前账号可用性",
    },
    {
      id: "opencode",
      label: "OpenCode",
      subscription: "OpenCode Go / Free",
      installed: Boolean(opencodeBin),
      executable: opencodeBin,
      models: opencodeModels,
      defaultModel: snapOpencode?.defaultModel ?? OPENCODE_DEFAULT_MODELS[0] ?? null,
      detectedAt: now,
      note: snapOpencode
        ? "模型目录来自本地探测快照，后台将自动增量刷新"
        : "模型目录为内置名单，CLI 枚举完成后自动刷新；未验证当前账号可用性",
    },
    {
      id: "agy",
      label: "Antigravity (agy)",
      subscription: "Google AI Pro / AGY",
      installed: Boolean(agyBin),
      executable: agyBin,
      models: agyModels,
      defaultModel:
        agyModels.find((m) => m.id === "gemini-4-argon")?.id ??
        agyModels.find((m) => m.id === "gemini-4-argon-medium")?.id ??
        agyModels[0]?.id ??
        null,
      detectedAt: now,
      note: snapAgy
        ? "模型目录来自本地探测快照，后台将自动增量刷新"
        : "模型目录为内置名单，CLI 枚举完成后自动刷新；未验证当前账号可用性",
    },
    {
      id: "omp",
      label: "oh-my-pi (omp)",
      subscription: "OMP Multi-Provider",
      installed: Boolean(ompBin),
      executable: ompBin,
      models: mergeModels(ompList, "detected", capIndex),
      defaultModel: ompDefault,
      detectedAt: now,
    },
  ];
}

export async function discoverHarnesses(deps: ProbeDependencies = {}): Promise<HarnessInfo[]> {
  const homeDir = deps.homeDir ?? os.homedir();
  const which = deps.which ?? defaultWhich;
  const runCmd = deps.runCmd ?? defaultRunCmd;
  const hubDir = resolveSnapshotHubDir(deps);
  const now = Date.now();

  const codexBin = which("codex");
  const qoderBin = which("qodercn");
  const opencodeBin = which("opencode");
  const agyBin = which("agy");
  const ompBin = which("omp");

  const [qoderRes, opencodeRes, agyRes] = await Promise.all([
    qoderBin ? runCmd(qoderBin, ["--list-models"]) : Promise.resolve({ code: 1, stdout: "" }),
    opencodeBin ? runCmd(opencodeBin, ["models"]) : Promise.resolve({ code: 1, stdout: "" }),
    agyBin ? runCmd(agyBin, ["models"], 8000) : Promise.resolve({ code: 1, stdout: "" }),
  ]);

  const codexParsed = parseCodexModels(homeDir);
  const sqliteCatalog = readOmpSqliteCatalog(homeDir);
  const capIndex = sqliteCatalog.capabilityIndex;
  enrichCodexIndex(capIndex, codexParsed.models);

  const qoderIds =
    qoderRes.code === 0
      ? qoderRes.stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && l.toUpperCase() !== "MODEL")
      : QODER_DEFAULT_MODELS;
  const qoderFromCli = qoderRes.code === 0 && qoderIds.length > 0;
  const qoderModels = qoderSpecsFromIds(qoderFromCli ? qoderIds : QODER_DEFAULT_MODELS);

  const opencodeCliModels =
    opencodeRes.code === 0
      ? opencodeRes.stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.includes("/") && !l.startsWith("ERROR"))
      : OPENCODE_DEFAULT_MODELS;
  const opencodeFromCli = opencodeRes.code === 0 && opencodeCliModels.length > 0;
  const opencodeCombined: Array<string | RawModelSpec> = [
    ...(opencodeFromCli ? opencodeCliModels : OPENCODE_DEFAULT_MODELS),
    ...sqliteCatalog.opencodeGoModels,
  ];

  const agyCliParsed = agyRes.code === 0 ? parseAgyCliOutput(agyRes.stdout) : [];
  const agyFromCli = agyCliParsed.length > 0;
  const agyNormalized = normalizeAgyModels(agyFromCli ? agyCliParsed : AGY_DEFAULT_MODELS);
  const agySource: DiscoveredModel["source"] = agyFromCli ? "detected" : "builtin";

  const ompDefault = parseOmpDefaultModel(homeDir) ?? "openai-codex/gpt-6.2-sol";
  const ompCombined: RawModelSpec[] = [
    { id: ompDefault, provider: ompDefault.split("/")[0] || "omp", supportedEfforts: OMP_EFFORTS },
    ...sqliteCatalog.ompModels,
  ];

  const results: HarnessInfo[] = [
    {
      id: "codex",
      label: "Codex CLI",
      subscription: "ChatGPT Plus",
      installed: Boolean(codexBin),
      executable: codexBin,
      models: mergeModels(codexParsed.models, "detected", capIndex, "openai-codex"),
      defaultModel: codexParsed.defaultModel ?? codexParsed.models[0]?.id ?? null,
      detectedAt: now,
    },
    {
      id: "qodercn",
      label: "QoderCN",
      subscription: "QoderCN 订阅",
      installed: Boolean(qoderBin),
      executable: qoderBin,
      models: mergeModels(qoderModels, qoderFromCli ? "detected" : "builtin", capIndex, "qoder-cn"),
      defaultModel: qoderIds.includes("Qwen4-Max") ? "Qwen4-Max" : (qoderIds[0] ?? null),
      detectedAt: now,
      ...(qoderFromCli ? {} : { note: "模型目录来自内置名单（CLI 枚举失败），未验证当前账号可用性" }),
    },
    {
      id: "opencode",
      label: "OpenCode",
      subscription: "OpenCode Go / Free",
      installed: Boolean(opencodeBin),
      executable: opencodeBin,
      models: mergeModels(opencodeCombined, opencodeFromCli ? "detected" : "builtin", capIndex),
      defaultModel: opencodeCliModels[0] ?? OPENCODE_DEFAULT_MODELS[0] ?? null,
      detectedAt: now,
      ...(opencodeFromCli ? {} : { note: "模型目录来自内置名单（CLI 枚举失败），未验证当前账号可用性" }),
    },
    {
      id: "agy",
      label: "Antigravity (agy)",
      subscription: "Google AI Pro / AGY",
      installed: Boolean(agyBin),
      executable: agyBin,
      models: mergeModels(agyNormalized, agySource, capIndex, "google-antigravity"),
      defaultModel:
        agyNormalized.find((m) => m.id === "gemini-4-argon")?.id ??
        agyNormalized.find((m) => m.id === "gemini-4-argon-medium")?.id ??
        agyNormalized[0]?.id ??
        null,
      detectedAt: now,
      ...(agySource === "detected" ? {} : { note: "模型目录来自内置名单（CLI 枚举失败），未验证当前账号可用性" }),
    },
    {
      id: "omp",
      label: "oh-my-pi (omp)",
      subscription: "OMP Multi-Provider",
      installed: Boolean(ompBin),
      executable: ompBin,
      models: mergeModels(ompCombined, "detected", capIndex),
      defaultModel: ompDefault,
      detectedAt: now,
    },
  ];

  writeHarnessesSnapshot(hubDir, results);
  return results;
}

export function isKnownHarnessId(id: string): id is HarnessId {
  return id === "codex" || id === "qodercn" || id === "opencode" || id === "agy" || id === "omp";
}
