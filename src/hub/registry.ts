import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkbenchError } from "../core/errors.ts";
import { atomicWriteJson, canonicalRoot, readJsonStrict } from "../core/fs.ts";
import { DEFAULT_OUTPUT_LANGUAGE, normalizeOutputLanguage } from "../core/language.ts";
import { WORKBENCH_DIR, type OutputLanguage } from "../core/types.ts";
import { buildPresetRouting, normalizeRoutingConfig } from "./routing.ts";
import {
  HARNESS_IDS,
  type BrowseEntry,
  type DaemonInfo,
  type HubConfig,
  type HubProjectEntry,
  type RoutingConfig,
  type RoutingPreset,
} from "./types.ts";

export function resolveHubDir(): string {
  const custom = process.env.WORKBENCH_HUB_DIR?.trim();
  if (custom) return path.resolve(custom);
  return path.join(os.homedir(), ".workbench-hub");
}

export function hubConfigPath(): string {
  return path.join(resolveHubDir(), "hub.json");
}

export function daemonInfoPath(): string {
  return path.join(resolveHubDir(), "daemon.json");
}

export function hubLogPath(): string {
  return path.join(resolveHubDir(), "hub.log");
}

function ensureHubDir(): string {
  const dir = resolveHubDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function projectIdForRoot(canonical: string): string {
  const slug = path.basename(canonical).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "repo";
  const hash = createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
}

export function defaultHubConfig(): HubConfig {
  return {
    schemaVersion: 1,
    activeProjectId: null,
    projects: [],
    routing: buildPresetRouting("balanced"),
    customModels: {},
    outputLanguage: DEFAULT_OUTPUT_LANGUAGE,
  };
}

export function readHubConfig(): HubConfig {
  const filePath = hubConfigPath();
  if (!fs.existsSync(filePath)) {
    return defaultHubConfig();
  }
  try {
    const raw = readJsonStrict<Record<string, unknown>>(filePath, 256 * 1024);
    const projectsRaw = Array.isArray(raw.projects) ? raw.projects : [];
    const projects: HubProjectEntry[] = [];
    const seenRoots = new Set<string>();
    for (const p of projectsRaw) {
      if (!p || typeof p !== "object") continue;
      const obj = p as Record<string, unknown>;
      if (typeof obj.id !== "string" || typeof obj.root !== "string") continue;
      if (!fs.existsSync(obj.root) || seenRoots.has(obj.root)) continue;
      seenRoots.add(obj.root);
      projects.push({
        id: obj.id,
        name: typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : path.basename(obj.root),
        root: obj.root,
        addedAt: typeof obj.addedAt === "number" ? obj.addedAt : Date.now(),
        lastOpenedAt: typeof obj.lastOpenedAt === "number" ? obj.lastOpenedAt : Date.now(),
      });
    }

    const customModels: Record<string, string[]> = {};
    if (raw.customModels && typeof raw.customModels === "object") {
      for (const [k, v] of Object.entries(raw.customModels as Record<string, unknown>)) {
        if ((HARNESS_IDS as readonly string[]).includes(k) && Array.isArray(v)) {
          customModels[k] = v.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
        }
      }
    }

    const activeId =
      typeof raw.activeProjectId === "string" && projects.some((p) => p.id === raw.activeProjectId)
        ? raw.activeProjectId
        : (projects[0]?.id ?? null);

    const outputLanguage = normalizeOutputLanguage(raw.outputLanguage) ?? DEFAULT_OUTPUT_LANGUAGE;

    return {
      schemaVersion: 1,
      activeProjectId: activeId,
      projects,
      routing: normalizeRoutingConfig(raw.routing),
      customModels,
      outputLanguage,
    };
  } catch {
    return defaultHubConfig();
  }
}

export function writeHubConfig(config: HubConfig): HubConfig {
  ensureHubDir();
  atomicWriteJson(hubConfigPath(), config);
  return config;
}

export function registerHubProject(
  root: string,
  options: { name?: string; activate?: boolean } = {},
): { config: HubConfig; project: HubProjectEntry } {
  const base = canonicalRoot(root);
  const config = readHubConfig();
  const now = Date.now();
  const existingIdx = config.projects.findIndex((p) => p.root === base);

  let project: HubProjectEntry;
  let inferredName = options.name?.trim();
  if (!inferredName) {
    try {
      const projFile = path.join(base, WORKBENCH_DIR, "project.json");
      if (fs.existsSync(projFile)) {
        const meta = readJsonStrict<{ name?: string }>(projFile, 64 * 1024);
        if (typeof meta.name === "string" && meta.name.trim()) inferredName = meta.name.trim();
      }
    } catch {
      // Fallback to directory basename.
    }
  }
  if (existingIdx >= 0) {
    const prev = config.projects[existingIdx]!;
    project = {
      ...prev,
      name: inferredName || prev.name,
      lastOpenedAt: now,
    };
    config.projects[existingIdx] = project;
  } else {
    project = {
      id: projectIdForRoot(base),
      name: inferredName || path.basename(base) || "project",
      root: base,
      addedAt: now,
      lastOpenedAt: now,
    };
    config.projects.unshift(project);
  }

  if (options.activate !== false || !config.activeProjectId) {
    config.activeProjectId = project.id;
  }
  writeHubConfig(config);
  return { config, project };
}

export function removeHubProject(projectId: string): HubConfig {
  const config = readHubConfig();
  config.projects = config.projects.filter((p) => p.id !== projectId);
  if (config.activeProjectId === projectId) {
    config.activeProjectId = config.projects[0]?.id ?? null;
  }
  return writeHubConfig(config);
}

export function setActiveHubProject(projectId: string): { config: HubConfig; project: HubProjectEntry } {
  const config = readHubConfig();
  const found = config.projects.find((p) => p.id === projectId);
  if (!found) {
    throw new WorkbenchError("not_found", `未在 Hub 中注册该项目: ${projectId}`);
  }
  found.lastOpenedAt = Date.now();
  config.activeProjectId = found.id;
  writeHubConfig(config);
  return { config, project: found };
}

export function updateHubRouting(routing: RoutingConfig): HubConfig {
  const config = readHubConfig();
  config.routing = normalizeRoutingConfig(routing);
  return writeHubConfig(config);
}

export function applyHubRoutingPreset(preset: RoutingPreset): HubConfig {
  const config = readHubConfig();
  config.routing = buildPresetRouting(preset);
  return writeHubConfig(config);
}

export function updateHubPreferences(patch: { outputLanguage?: OutputLanguage }): HubConfig {
  const config = readHubConfig();
  if (patch.outputLanguage !== undefined) {
    const valid = normalizeOutputLanguage(patch.outputLanguage);
    if (!valid) {
      throw new WorkbenchError("invalid_input", `不支持的输出语言配置: ${String(patch.outputLanguage)}`);
    }
    config.outputLanguage = valid;
  }
  return writeHubConfig(config);
}

export function addCustomModel(harness: string, modelId: string): HubConfig {
  if (!(HARNESS_IDS as readonly string[]).includes(harness)) {
    throw new WorkbenchError("invalid_input", `不支持的 Harness: ${harness}`);
  }
  const clean = modelId.trim();
  if (!clean || clean.length > 200 || /[\x00-\x1f\x7f]/.test(clean)) {
    throw new WorkbenchError("invalid_input", "模型名称无效");
  }
  const config = readHubConfig();
  const list = config.customModels[harness] ?? [];
  if (!list.includes(clean)) {
    list.push(clean);
  }
  config.customModels[harness] = list;
  return writeHubConfig(config);
}

export function writeDaemonInfo(info: DaemonInfo): string {
  ensureHubDir();
  const filePath = daemonInfoPath();
  atomicWriteJson(filePath, info);
  return filePath;
}

export function readDaemonInfo(): DaemonInfo | null {
  try {
    const filePath = daemonInfoPath();
    if (!fs.existsSync(filePath)) return null;
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<DaemonInfo>;
    if (typeof raw.pid !== "number" || typeof raw.port !== "number" || typeof raw.url !== "string") {
      return null;
    }
    return raw as DaemonInfo;
  } catch {
    return null;
  }
}

export function removeDaemonInfo(expectedPid = process.pid): void {
  try {
    const current = readDaemonInfo();
    if (current && current.pid === expectedPid) {
      fs.rmSync(daemonInfoPath(), { force: true });
    }
  } catch {
    // Ignore cleanup failures.
  }
}

/** Returns true when a directory looks like a project repo and is not the default user home directory. */
export function isAutoRegistrableProjectRoot(root: string): boolean {
  const canonical = canonicalRoot(root);
  const homeCandidates = [process.env.HOME?.trim(), os.homedir()].filter((v): v is string => Boolean(v));
  for (const candidate of homeCandidates) {
    try {
      if (canonical === canonicalRoot(candidate)) return false;
    } catch {
      // Ignore unresolvable homedir in isolated environments.
    }
  }
  return fs.existsSync(path.join(canonical, ".git")) || fs.existsSync(path.join(canonical, WORKBENCH_DIR, "project.json"));
}

/** Lists immediate subdirectories safely for the local directory browser modal. */
export function browseDirectory(targetPath?: string): {
  currentPath: string;
  parentPath: string | null;
  isGitRepo: boolean;
  workbenchInitialized: boolean;
  entries: BrowseEntry[];
} {
  const rawTarget = targetPath?.trim() || os.homedir();
  const currentPath = canonicalRoot(rawTarget);
  const parsedParent = path.dirname(currentPath);
  const parentPath = parsedParent && parsedParent !== currentPath ? parsedParent : null;

  const isGit = (dir: string) => fs.existsSync(path.join(dir, ".git"));
  const isWb = (dir: string) => fs.existsSync(path.join(dir, WORKBENCH_DIR, "project.json"));

  const dirents = fs.readdirSync(currentPath, { withFileTypes: true });
  const entries: BrowseEntry[] = [];
  for (const d of dirents) {
    if (d.isSymbolicLink() || !d.isDirectory()) continue;
    if (d.name.startsWith(".")) continue;
    const full = path.join(currentPath, d.name);
    try {
      entries.push({
        name: d.name,
        path: full,
        isDirectory: true,
        isGitRepo: isGit(full),
        workbenchInitialized: isWb(full),
      });
    } catch {
      // Skip unreadable directories.
    }
  }

  entries.sort((a, b) => Number(b.isGitRepo) - Number(a.isGitRepo) || a.name.localeCompare(b.name));
  return {
    currentPath,
    parentPath,
    isGitRepo: isGit(currentPath),
    workbenchInitialized: isWb(currentPath),
    entries: entries.slice(0, 200),
  };
}
