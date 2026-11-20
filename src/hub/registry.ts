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
  type BrowseEntry,
  type DaemonInfo,
  type HarnessInfo,
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

export const LOCAL_NODE_ID = "local";

export function isLocalNodeId(nodeId?: string | null): boolean {
  const trimmed = nodeId?.trim();
  return !trimmed || trimmed === LOCAL_NODE_ID;
}

export function isRemoteNodeId(nodeId: unknown): nodeId is string {
  return typeof nodeId === "string" && !isLocalNodeId(nodeId) && /^[A-Za-z0-9._-]{1,64}$/.test(nodeId);
}

function normalizeRemoteRoot(root: string): string {
  const trimmed = root.trim();
  if (!trimmed || /[\0\r\n]/.test(trimmed)) {
    throw new WorkbenchError("invalid_path", "远程项目根目录路径无效");
  }
  if (trimmed.length > 1 && /[\\/]+$/.test(trimmed) && !/^[A-Za-z]:[\\/]+$/.test(trimmed)) {
    return trimmed.replace(/[\\/]+$/, "");
  }
  return trimmed;
}

function projectIdForRoot(canonical: string, nodeId?: string): string {
  const slug = path.basename(canonical).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "repo";
  const key = isLocalNodeId(nodeId) ? canonical : `${nodeId!.trim()}::${canonical}`;
  const hash = createHash("sha256").update(key, "utf8").digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
}

export function defaultHubConfig(): HubConfig {
  return {
    schemaVersion: 1,
    activeProjectId: null,
    projects: [],
    routing: buildPresetRouting("balanced"),
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
    const seenKeys = new Set<string>();
    for (const p of projectsRaw) {
      if (!p || typeof p !== "object") continue;
      const obj = p as Record<string, unknown>;
      if (typeof obj.id !== "string" || typeof obj.root !== "string") continue;
      const nodeId = typeof obj.nodeId === "string" && !isLocalNodeId(obj.nodeId) ? obj.nodeId.trim() : undefined;
      const nodeName = typeof obj.nodeName === "string" && obj.nodeName.trim() ? obj.nodeName.trim() : undefined;
      const dedupeKey = `${nodeId ?? LOCAL_NODE_ID}::${obj.root}`;
      if ((!nodeId && !fs.existsSync(obj.root)) || seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);
      projects.push({
        id: obj.id,
        name: typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : path.basename(obj.root),
        root: obj.root,
        ...(nodeId ? { nodeId } : {}),
        ...(nodeName ? { nodeName } : {}),
        addedAt: typeof obj.addedAt === "number" ? obj.addedAt : Date.now(),
        lastOpenedAt: typeof obj.lastOpenedAt === "number" ? obj.lastOpenedAt : Date.now(),
      });
    }

    const activeId =
      typeof raw.activeProjectId === "string" && projects.some((p) => p.id === raw.activeProjectId)
        ? raw.activeProjectId
        : (projects[0]?.id ?? null);

    const outputLanguage = normalizeOutputLanguage(raw.outputLanguage) ?? DEFAULT_OUTPUT_LANGUAGE;
    const giteeAccessToken =
      typeof raw.giteeAccessToken === "string" && raw.giteeAccessToken.trim() ? raw.giteeAccessToken.trim() : undefined;

    return {
      schemaVersion: 1,
      activeProjectId: activeId,
      projects,
      routing: normalizeRoutingConfig(raw.routing),
      outputLanguage,
      ...(giteeAccessToken ? { giteeAccessToken } : {}),
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
  options: { name?: string; activate?: boolean; nodeId?: string; nodeName?: string } = {},
): { config: HubConfig; project: HubProjectEntry } {
  const local = isLocalNodeId(options.nodeId);
  const nodeId = local ? undefined : options.nodeId!.trim();
  const nodeName = !local && options.nodeName?.trim() ? options.nodeName.trim() : undefined;
  const base = local ? canonicalRoot(root) : normalizeRemoteRoot(root);
  const config = readHubConfig();
  const now = Date.now();
  const existingIdx = config.projects.findIndex((p) => (p.nodeId ?? LOCAL_NODE_ID) === (nodeId ?? LOCAL_NODE_ID) && p.root === base);

  let project: HubProjectEntry;
  let inferredName = options.name?.trim();
  if (local && !inferredName) {
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
      ...(nodeId ? { nodeId } : {}),
      ...(nodeName ? { nodeName } : prev.nodeName ? { nodeName: prev.nodeName } : {}),
      lastOpenedAt: now,
    };
    config.projects[existingIdx] = project;
  } else {
    project = {
      id: projectIdForRoot(base, nodeId),
      name: inferredName || path.basename(base) || "project",
      root: base,
      ...(nodeId ? { nodeId } : {}),
      ...(nodeName ? { nodeName } : {}),
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

export function applyHubRoutingPreset(preset: RoutingPreset, harnesses?: HarnessInfo[] | null): HubConfig {
  const config = readHubConfig();
  config.routing = buildPresetRouting(preset, harnesses);
  return writeHubConfig(config);
}

export function updateHubPreferences(patch: {
  outputLanguage?: OutputLanguage;
  giteeAccessToken?: string | null;
}): HubConfig {
  const config = readHubConfig();
  if (patch.outputLanguage !== undefined) {
    const valid = normalizeOutputLanguage(patch.outputLanguage);
    if (!valid) {
      throw new WorkbenchError("invalid_input", `不支持的输出语言配置: ${String(patch.outputLanguage)}`);
    }
    config.outputLanguage = valid;
  }
  if (patch.giteeAccessToken !== undefined) {
    if (patch.giteeAccessToken === null || patch.giteeAccessToken.trim() === "") {
      delete config.giteeAccessToken;
    } else {
      const clean = patch.giteeAccessToken.trim();
      if (clean.length > 512 || /[\0\r\n\s]/.test(clean)) {
        throw new WorkbenchError("invalid_input", "Gitee 私人令牌格式不合法（不能包含空白或控制字符）");
      }
      config.giteeAccessToken = clean;
    }
  }
  return writeHubConfig(config);
}

export function resolveEffectiveGiteeToken(cfg?: HubConfig | null): string | null {
  const configured = cfg?.giteeAccessToken?.trim();
  if (configured) return configured;
  const envToken = process.env.GITEE_ACCESS_TOKEN?.trim();
  return envToken || null;
}

export function maskAccessToken(token?: string | null): string | null {
  const clean = token?.trim();
  if (!clean) return null;
  if (clean.length <= 4) return "••••";
  return `••••${clean.slice(-4)}`;
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
