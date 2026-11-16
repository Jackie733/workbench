import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DiscoveredModel, HarnessId, HarnessInfo } from "./types.ts";

export interface ProbeDependencies {
  homeDir?: string;
  which?: (cmd: string) => string | null;
  runCmd?: (cmd: string, args: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string }>;
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

function defaultRunCmd(cmd: string, args: string[], timeoutMs = 4500): Promise<{ code: number; stdout: string }> {
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
  if (lower.includes("flash") || lower.includes("fast") || lower.includes("small") || lower.includes("luna") || lower.includes("5.6") || lower.includes("free")) {
    return "fast";
  }
  if (lower.includes("sol") || lower.includes("pro") || lower.includes("max") || lower.includes("astra") || lower.includes("ultra")) {
    return "sota";
  }
  return "balanced";
}

function mergeModels(detectedIds: string[], customIds: string[] = []): DiscoveredModel[] {
  const seen = new Set<string>();
  const out: DiscoveredModel[] = [];
  for (const id of detectedIds) {
    const clean = id.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push({ id: clean, tier: classifyTier(clean), source: "detected" });
  }
  for (const id of customIds) {
    const clean = id.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push({ id: clean, tier: classifyTier(clean), source: "custom" });
  }
  return out;
}

function parseCodexModels(homeDir: string): { models: string[]; defaultModel: string | null } {
  const models: string[] = [];
  let defaultModel: string | null = null;
  try {
    const cachePath = path.join(homeDir, ".codex/models_cache.json");
    if (fs.existsSync(cachePath)) {
      const raw = JSON.parse(fs.readFileSync(cachePath, "utf8")) as { models?: Array<{ slug?: string; id?: string }> };
      const list = Array.isArray(raw.models) ? raw.models : [];
      for (const item of list) {
        const slug = item.slug ?? item.id;
        if (typeof slug === "string" && slug.trim()) models.push(slug.trim());
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
  return { models: models.length > 0 ? models : ["gpt-6-astra", "gpt-6.1-sol", "codex-auto-review"], defaultModel };
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
  const geminiBin = which("gemini");
  const ompBin = which("omp");

  const codexParsed = parseCodexModels(homeDir);
  const qoderDefault = ["Auto", "Fast", "Qwen4-Max", "Qwen3.8-Flash", "DeepSeek-V4-Pro", "GLM-5.3", "Kimi-K3.1-Pro"];
  const opencodeDefault = [
    "opencode/deepseek-v4.1-flash-free",
    "opencode/glm-5.3-flash-free",
    "opencode/minimax-m3.1-flash-free",
    "opencode/mimo-v2.6-flash-free",
    "opencode/longcat-2.5-free",
    "opencode/nemotron-3.5-lightning-free",
  ];
  const ompDefault = parseOmpDefaultModel(homeDir) ?? "openai-codex/gpt-6.1-sol";

  return [
    {
      id: "codex",
      label: "Codex CLI",
      subscription: "ChatGPT Plus",
      installed: Boolean(codexBin),
      executable: codexBin,
      models: mergeModels(codexParsed.models, customModels.codex),
      defaultModel: codexParsed.defaultModel ?? codexParsed.models[0] ?? null,
      detectedAt: now,
    },
    {
      id: "qodercn",
      label: "QoderCN",
      subscription: "QoderCN 订阅",
      installed: Boolean(qoderBin),
      executable: qoderBin,
      models: mergeModels(qoderDefault, customModels.qodercn),
      defaultModel: "Qwen4-Max",
      detectedAt: now,
    },
    {
      id: "opencode",
      label: "OpenCode",
      subscription: "OpenCode Go / Free",
      installed: Boolean(opencodeBin),
      executable: opencodeBin,
      models: mergeModels(opencodeDefault, customModels.opencode),
      defaultModel: opencodeDefault[0] ?? null,
      detectedAt: now,
    },
    {
      id: "gemini",
      label: "Gemini CLI",
      subscription: "Google AI Pro",
      installed: Boolean(geminiBin),
      executable: geminiBin,
      models: mergeModels(["default", "gemini-2.5-pro", "gemini-2.5-flash"], customModels.gemini),
      defaultModel: "default",
      detectedAt: now,
    },
    {
      id: "omp",
      label: "oh-my-pi (omp)",
      subscription: "OMP Profile",
      installed: Boolean(ompBin),
      executable: ompBin,
      models: mergeModels([ompDefault], customModels.omp),
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
  const geminiBin = which("gemini");
  const ompBin = which("omp");

  const [qoderRes, opencodeRes, geminiCheck] = await Promise.all([
    qoderBin ? runCmd(qoderBin, ["--list-models"]) : Promise.resolve({ code: 1, stdout: "" }),
    opencodeBin ? runCmd(opencodeBin, ["models"]) : Promise.resolve({ code: 1, stdout: "" }),
    geminiBin
      ? runCmd(geminiBin, ["--version"], 2500).then(async (r) => {
          if (r.code === 0) return { bin: geminiBin, note: undefined as string | undefined };
          const mise = which("mise");
          if (mise) {
            const viaMise = await runCmd(mise, ["x", "node@24.4.1", "--", "gemini", "--version"], 3500);
            if (viaMise.code === 0) return { bin: "mise x node@24.4.1 -- gemini", note: "通过 mise node@24.4.1 运行" };
          }
          return { bin: geminiBin, note: undefined as string | undefined };
        })
      : Promise.resolve({ bin: null as string | null, note: undefined as string | undefined }),
  ]);

  const codexParsed = parseCodexModels(homeDir);
  const qoderParsed =
    qoderRes.code === 0
      ? qoderRes.stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && l.toUpperCase() !== "MODEL" && l !== "DeepSeek-Flash")
      : ["Auto", "Fast", "Qwen4-Max", "Qwen3.8-Flash", "DeepSeek-V4-Pro", "GLM-5.3", "Kimi-K3.1-Pro"];

  const opencodeParsed =
    opencodeRes.code === 0
      ? opencodeRes.stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.includes("/") && !l.startsWith("ERROR"))
      : [
          "opencode/deepseek-v4.1-flash-free",
          "opencode/glm-5.3-flash-free",
          "opencode/minimax-m3.1-flash-free",
          "opencode/mimo-v2.6-flash-free",
          "opencode/longcat-2.5-free",
          "opencode/nemotron-3.5-lightning-free",
        ];

  const ompDefault = parseOmpDefaultModel(homeDir) ?? "openai-codex/gpt-6.1-sol";

  const results: HarnessInfo[] = [
    {
      id: "codex",
      label: "Codex CLI",
      subscription: "ChatGPT Plus",
      installed: Boolean(codexBin),
      executable: codexBin,
      models: mergeModels(codexParsed.models, customModels.codex),
      defaultModel: codexParsed.defaultModel ?? codexParsed.models[0] ?? null,
      detectedAt: now,
    },
    {
      id: "qodercn",
      label: "QoderCN",
      subscription: "QoderCN 订阅",
      installed: Boolean(qoderBin),
      executable: qoderBin,
      models: mergeModels(qoderParsed, customModels.qodercn),
      defaultModel: qoderParsed.includes("Qwen4-Max") ? "Qwen4-Max" : (qoderParsed[0] ?? null),
      detectedAt: now,
    },
    {
      id: "opencode",
      label: "OpenCode",
      subscription: "OpenCode Go / Free",
      installed: Boolean(opencodeBin),
      executable: opencodeBin,
      models: mergeModels(opencodeParsed, customModels.opencode),
      defaultModel: opencodeParsed[0] ?? null,
      detectedAt: now,
    },
    {
      id: "gemini",
      label: "Gemini CLI",
      subscription: "Google AI Pro",
      installed: Boolean(geminiCheck.bin),
      executable: geminiCheck.bin,
      models: mergeModels(["default", "gemini-2.5-pro", "gemini-2.5-flash"], customModels.gemini),
      defaultModel: "default",
      detectedAt: now,
      ...(geminiCheck.note ? { note: geminiCheck.note } : {}),
    },
    {
      id: "omp",
      label: "oh-my-pi (omp)",
      subscription: "OMP Profile",
      installed: Boolean(ompBin),
      executable: ompBin,
      models: mergeModels([ompDefault], customModels.omp),
      defaultModel: ompDefault,
      detectedAt: now,
    },
  ];

  return results;
}

export function isKnownHarnessId(id: string): id is HarnessId {
  return id === "codex" || id === "qodercn" || id === "opencode" || id === "gemini" || id === "omp";
}
