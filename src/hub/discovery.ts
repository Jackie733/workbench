import { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { REASONING_EFFORTS, type DiscoveredModel, type HarnessId, type HarnessInfo, type ReasoningEffort } from "./types.ts";

export interface ProbeDependencies {
  homeDir?: string;
  which?: (cmd: string) => string | null;
  runCmd?: (cmd: string, args: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string }>;
}

const VALID_EFFORTS = new Set<string>(REASONING_EFFORTS);

function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return typeof v === "string" && VALID_EFFORTS.has(v);
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

function classifyTier(modelId: string): DiscoveredModel["tier"] {
  const lower = modelId.toLowerCase();
  if (lower.includes("review")) return "review";
  if (
    lower.includes("flash") ||
    lower.includes("fast") ||
    lower.includes("small") ||
    lower.includes("luna") ||
    lower.includes("5.6") ||
    lower.includes("free") ||
    lower.includes("-low")
  ) {
    return "fast";
  }
  if (
    lower.includes("sol") ||
    lower.includes("pro") ||
    lower.includes("max") ||
    lower.includes("astra") ||
    lower.includes("ultra") ||
    lower.includes("opus") ||
    lower.includes("hydrogen") ||
    lower.includes("orchestrator") ||
    lower.includes("xhigh")
  ) {
    return "sota";
  }
  return "balanced";
}

interface RawModelSpec {
  id: string;
  label?: string;
  provider?: string;
  supportedEfforts?: ReasoningEffort[];
  defaultEffort?: ReasoningEffort;
}

function mergeModels(detected: Array<string | RawModelSpec>, customIds: string[] = []): DiscoveredModel[] {
  const seen = new Set<string>();
  const out: DiscoveredModel[] = [];

  for (const entry of detected) {
    const spec: RawModelSpec = typeof entry === "string" ? { id: entry } : entry;
    const clean = spec.id.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push({
      id: clean,
      ...(spec.label ? { label: spec.label } : {}),
      ...(spec.provider ? { provider: spec.provider } : {}),
      tier: classifyTier(clean),
      source: "detected",
      ...(spec.supportedEfforts && spec.supportedEfforts.length > 0 ? { supportedEfforts: spec.supportedEfforts } : {}),
      ...(spec.defaultEffort ? { defaultEffort: spec.defaultEffort } : {}),
    });
  }

  for (const id of customIds) {
    const clean = id.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push({
      id: clean,
      tier: classifyTier(clean),
      source: "custom",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    });
  }

  return out;
}

const QODER_DEFAULT_MODELS = [
  "Auto",
  "Fast",
  "Qwen4-Max",
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
const AGY_EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
const OMP_EFFORTS: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max", "auto"];

const AGY_DEFAULT_MODELS: RawModelSpec[] = [
  { id: "gemini-4-hydrogen-xhigh", label: "Gemini 4 Hydrogen (XHigh)", supportedEfforts: AGY_EFFORTS },
  { id: "gemini-4-hydrogen-high", label: "Gemini 4 Hydrogen (High)", supportedEfforts: AGY_EFFORTS },
  { id: "gemini-4-hydrogen-medium", label: "Gemini 4 Hydrogen (Medium)", supportedEfforts: AGY_EFFORTS },
  { id: "gemini-4-hydrogen-low", label: "Gemini 4 Hydrogen (Low)", supportedEfforts: AGY_EFFORTS },
  { id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)", supportedEfforts: AGY_EFFORTS },
  { id: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium)", supportedEfforts: AGY_EFFORTS },
  { id: "gemini-4-argon-low", label: "Gemini 4 Argon (Low)", supportedEfforts: AGY_EFFORTS },
  { id: "gemini-pro-orchestrator-g1-pro", label: "Orchestrator (Argon)", supportedEfforts: AGY_EFFORTS },
  { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)", supportedEfforts: AGY_EFFORTS },
  { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)", supportedEfforts: AGY_EFFORTS },
  { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)", supportedEfforts: AGY_EFFORTS },
  { id: "claude-opus-5-5-high", label: "Claude Opus 5.5 (High)", supportedEfforts: AGY_EFFORTS },
  { id: "claude-opus-5-5-medium", label: "Claude Opus 5.5 (Medium)", supportedEfforts: AGY_EFFORTS },
  { id: "claude-opus-5-5-low", label: "Claude Opus 5.5 (Low)", supportedEfforts: AGY_EFFORTS },
  { id: "claude-sonnet-5-5-high", label: "Claude Sonnet 5.5 (High)", supportedEfforts: AGY_EFFORTS },
  { id: "claude-sonnet-5-5-medium", label: "Claude Sonnet 5.5 (Medium)", supportedEfforts: AGY_EFFORTS },
  { id: "claude-sonnet-5-5-low", label: "Claude Sonnet 5.5 (Low)", supportedEfforts: AGY_EFFORTS },
  { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)", supportedEfforts: AGY_EFFORTS },
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
        models.push({
          id: slug,
          ...(item.display_name ? { label: item.display_name } : {}),
          ...(efforts && efforts.length > 0 ? { supportedEfforts: efforts } : {}),
          ...(defEffort ? { defaultEffort: defEffort } : {}),
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
        { id: "gpt-6-astra", supportedEfforts: [...fallbackEfforts, "ultra"], defaultEffort: "low" },
        { id: "gpt-6.1-sol", supportedEfforts: [...fallbackEfforts, "ultra"], defaultEffort: "low" },
        { id: "codex-auto-review", supportedEfforts: fallbackEfforts, defaultEffort: "medium" },
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
  antigravityModels: RawModelSpec[];
}

function readOmpSqliteCatalog(homeDir: string): OmpSqliteCatalog {
  const ompModels: RawModelSpec[] = [];
  const opencodeGoModels: RawModelSpec[] = [];
  const antigravityModels: RawModelSpec[] = [];

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

        let parsed: Array<{ id?: string; name?: string; reasoning?: boolean }> = [];
        try {
          parsed = JSON.parse(row.models) as Array<{ id?: string; name?: string; reasoning?: boolean }>;
        } catch {
          continue;
        }
        if (!Array.isArray(parsed)) continue;

        if (baseProvider === "opencode-go") {
          for (const m of parsed) {
            if (!m.id) continue;
            opencodeGoModels.push({
              id: `opencode-go/${m.id}`,
              label: m.name || m.id,
              provider: "opencode-go",
            });
          }
        }

        if (baseProvider === "google-antigravity") {
          for (const m of parsed) {
            if (!m.id || m.id.includes("image") || m.id.startsWith("tab_")) continue;
            antigravityModels.push({
              id: m.id,
              label: m.name || m.id,
              provider: "google-antigravity",
              supportedEfforts: AGY_EFFORTS,
            });
          }
        }

        // For omp, include models from active authenticated providers
        const isActive =
          activeProviders.has(baseProvider) ||
          (baseProvider === "deepseek" && usedModelKeys.some((k) => k.startsWith("deepseek/")));
        if (isActive) {
          for (const m of parsed) {
            if (!m.id || m.id.includes("image") || m.id.startsWith("tab_")) continue;
            ompModels.push({
              id: `${baseProvider}/${m.id}`,
              label: m.name ? `${baseProvider} · ${m.name}` : undefined,
              provider: baseProvider,
              supportedEfforts: OMP_EFFORTS,
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

  return { ompModels, opencodeGoModels, antigravityModels };
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
      supportedEfforts: AGY_EFFORTS,
    });
  }
  return out;
}

function qoderSpecsFromIds(ids: string[]): RawModelSpec[] {
  return ids.map((id) => ({
    id,
    ...(id === "Auto" || id === "Fast" ? {} : { supportedEfforts: QODER_EFFORTS }),
  }));
}

export function discoverHarnessesQuick(
  customModels: Record<string, string[]> = {},
  deps: Pick<ProbeDependencies, "homeDir" | "which"> = {},
): HarnessInfo[] {
  const homeDir = deps.homeDir ?? os.homedir();
  const which = deps.which ?? defaultWhich;
  const now = Date.now();

  const codexBin = which("codex");
  const qoderBin = which("qodercn");
  const opencodeBin = which("opencode");
  const agyBin = which("agy");
  const ompBin = which("omp");

  const codexParsed = parseCodexModels(homeDir);
  const sqliteCatalog = readOmpSqliteCatalog(homeDir);
  const ompDefault = parseOmpDefaultModel(homeDir) ?? "openai-codex/gpt-6.1-sol";
  const ompList: RawModelSpec[] = [
    { id: ompDefault, provider: ompDefault.split("/")[0] || "omp", supportedEfforts: OMP_EFFORTS },
    ...sqliteCatalog.ompModels,
  ];
  const agyModels = [...AGY_DEFAULT_MODELS, ...sqliteCatalog.antigravityModels];
  const opencodeList: Array<string | RawModelSpec> = [
    ...OPENCODE_DEFAULT_MODELS,
    ...sqliteCatalog.opencodeGoModels,
  ];

  return [
    {
      id: "codex",
      label: "Codex CLI",
      subscription: "ChatGPT Plus",
      installed: Boolean(codexBin),
      executable: codexBin,
      models: mergeModels(codexParsed.models, customModels.codex),
      defaultModel: codexParsed.defaultModel ?? codexParsed.models[0]?.id ?? null,
      detectedAt: now,
    },
    {
      id: "qodercn",
      label: "QoderCN",
      subscription: "QoderCN 订阅",
      installed: Boolean(qoderBin),
      executable: qoderBin,
      models: mergeModels(qoderSpecsFromIds(QODER_DEFAULT_MODELS), customModels.qodercn),
      defaultModel: "Qwen4-Max",
      detectedAt: now,
    },
    {
      id: "opencode",
      label: "OpenCode",
      subscription: "OpenCode Go / Free",
      installed: Boolean(opencodeBin),
      executable: opencodeBin,
      models: mergeModels(opencodeList, customModels.opencode),
      defaultModel: OPENCODE_DEFAULT_MODELS[0] ?? null,
      detectedAt: now,
    },
    {
      id: "agy",
      label: "Antigravity (agy)",
      subscription: "Google AI Pro / AGY",
      installed: Boolean(agyBin),
      executable: agyBin,
      models: mergeModels(agyModels, customModels.agy),
      defaultModel: agyModels.find((m) => m.id === "gemini-4-argon-medium")?.id ?? agyModels[0]?.id ?? null,
      detectedAt: now,
    },
    {
      id: "omp",
      label: "oh-my-pi (omp)",
      subscription: "OMP Multi-Provider",
      installed: Boolean(ompBin),
      executable: ompBin,
      models: mergeModels(ompList, customModels.omp),
      defaultModel: ompDefault,
      detectedAt: now,
    },
  ];
}

export async function discoverHarnesses(
  customModels: Record<string, string[]> = {},
  deps: ProbeDependencies = {},
): Promise<HarnessInfo[]> {
  const homeDir = deps.homeDir ?? os.homedir();
  const which = deps.which ?? defaultWhich;
  const runCmd = deps.runCmd ?? defaultRunCmd;
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

  const qoderIds =
    qoderRes.code === 0
      ? qoderRes.stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && l.toUpperCase() !== "MODEL")
      : QODER_DEFAULT_MODELS;
  const qoderModels = qoderSpecsFromIds(qoderIds.length > 0 ? qoderIds : QODER_DEFAULT_MODELS);

  const opencodeCliModels =
    opencodeRes.code === 0
      ? opencodeRes.stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.includes("/") && !l.startsWith("ERROR"))
      : OPENCODE_DEFAULT_MODELS;
  const opencodeCombined: Array<string | RawModelSpec> = [
    ...(opencodeCliModels.length > 0 ? opencodeCliModels : OPENCODE_DEFAULT_MODELS),
    ...sqliteCatalog.opencodeGoModels,
  ];

  const agyCliParsed = agyRes.code === 0 ? parseAgyCliOutput(agyRes.stdout) : [];
  const agyCombined = [
    ...agyCliParsed,
    ...(sqliteCatalog.antigravityModels.length > 0 ? sqliteCatalog.antigravityModels : AGY_DEFAULT_MODELS),
  ];

  const ompDefault = parseOmpDefaultModel(homeDir) ?? "openai-codex/gpt-6.1-sol";
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
      models: mergeModels(codexParsed.models, customModels.codex),
      defaultModel: codexParsed.defaultModel ?? codexParsed.models[0]?.id ?? null,
      detectedAt: now,
    },
    {
      id: "qodercn",
      label: "QoderCN",
      subscription: "QoderCN 订阅",
      installed: Boolean(qoderBin),
      executable: qoderBin,
      models: mergeModels(qoderModels, customModels.qodercn),
      defaultModel: qoderIds.includes("Qwen4-Max") ? "Qwen4-Max" : (qoderIds[0] ?? null),
      detectedAt: now,
    },
    {
      id: "opencode",
      label: "OpenCode",
      subscription: "OpenCode Go / Free",
      installed: Boolean(opencodeBin),
      executable: opencodeBin,
      models: mergeModels(opencodeCombined, customModels.opencode),
      defaultModel: opencodeCliModels[0] ?? OPENCODE_DEFAULT_MODELS[0] ?? null,
      detectedAt: now,
    },
    {
      id: "agy",
      label: "Antigravity (agy)",
      subscription: "Google AI Pro / AGY",
      installed: Boolean(agyBin),
      executable: agyBin,
      models: mergeModels(agyCombined, customModels.agy),
      defaultModel:
        agyCombined.find((m) => m.id === "gemini-4-argon-medium")?.id ?? agyCombined[0]?.id ?? null,
      detectedAt: now,
    },
    {
      id: "omp",
      label: "oh-my-pi (omp)",
      subscription: "OMP Multi-Provider",
      installed: Boolean(ompBin),
      executable: ompBin,
      models: mergeModels(ompCombined, customModels.omp),
      defaultModel: ompDefault,
      detectedAt: now,
    },
  ];

  return results;
}

export function isKnownHarnessId(id: string): id is HarnessId {
  return id === "codex" || id === "qodercn" || id === "opencode" || id === "agy" || id === "omp";
}
