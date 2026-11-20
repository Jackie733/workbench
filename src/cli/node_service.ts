import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WorkbenchError } from "../core/errors.ts";
import { atomicWriteFile, atomicWriteJson, readJsonStrict } from "../core/fs.ts";
import { buildNodeWebSocketUrl, startWorkbenchNodeClient } from "../hub/node_bridge.ts";
import { isLocalNodeId, isRemoteNodeId, resolveHubDir } from "../hub/registry.ts";
import { nodeUpdateBlocksWork, queueNodeUpdate, readNodeUpdate, readUpdateBranch } from "./node_update.ts";

type Manager = "launchd" | "systemd";
type NodeServiceAction = "start" | "stop" | "restart" | "status" | "uninstall";

const MARKER = "Workbench managed remote node; schemaVersion=1";
const MAX_NODE_LOG_BYTES = 5 * 1024 * 1024;
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const;

export interface NodeConfig {
  schemaVersion: 1;
  hubUrl: string;
  token?: string;
  nodeId: string;
  nodeName: string;
}

export interface NodeRuntimeStatus {
  pid: number;
  nodeId: string;
  nodeName: string;
  hubUrl: string;
  connected: boolean;
  connectedAt: number | null;
  lastError: string | null;
  updatedAt: number;
}

export interface NodeServiceInstallation {
  schemaVersion: 1;
  manager: Manager;
  id: string;
  definitionPath: string;
  bunPath: string;
  cliPath: string;
  workingDirectory: string;
  hubDir: string;
  path: string;
  proxyEnv?: Record<string, string>;
}

export interface NodeStatusResult {
  configured: boolean;
  installed: boolean;
  manager: Manager | null;
  serviceId: string | null;
  active: boolean;
  connected: boolean;
  pid: number | null;
  nodeId: string | null;
  nodeName: string | null;
  hubUrl: string | null;
  lastError: string | null;
  logPath: string;
}

export interface NodeCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function fail(message: string): never {
  throw new WorkbenchError("execution_failed", message);
}

function validateText(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new WorkbenchError("invalid_input", "节点配置不能包含 NUL、CR 或 LF");
  return value;
}

function canonicalPath(value: string): string {
  const absolute = path.resolve(value);
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
  const parent = path.dirname(absolute);
  return parent === absolute ? absolute : path.join(canonicalPath(parent), path.basename(absolute));
}

function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function xml(value: string): string {
  return validateText(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]!);
}

function unit(value: string, executableArgument = false): string {
  let escaped = validateText(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
  if (executableArgument) escaped = escaped.replace(/\$/g, "$$$$");
  return `"${escaped}"`;
}

function collectProxyEnv(env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  const proxyEnv: Record<string, string> = {};
  for (const key of PROXY_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value) proxyEnv[key] = validateText(value);
  }
  return Object.keys(proxyEnv).length > 0 ? proxyEnv : undefined;
}

function assertRegular(file: string): void {
  if (!fs.lstatSync(file).isFile()) fail(`拒绝访问非普通文件或符号链接: ${file}`);
}

function execute(command: string, args: string[]): Promise<NodeCommandResult> {
  const { promise, resolve, reject } = Promise.withResolvers<NodeCommandResult>();
  execFile(command, args, { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    if (error && (typeof error.code !== "number" || error.killed)) {
      reject(new WorkbenchError("execution_failed", `${command} ${args.join(" ")}: ${error.message}${stderr ? `\n${stderr.trim()}` : ""}`));
    } else {
      resolve({ exitCode: error ? Number(error.code) : 0, stdout, stderr });
    }
  });
  return promise;
}

export function defaultNodeIdentity(env: NodeJS.ProcessEnv = process.env): { nodeId: string; nodeName: string } {
  const host = os.hostname() || "node";
  const wslDistro = env.WSL_DISTRO_NAME?.trim();
  const rawId = (wslDistro ? `wsl-${wslDistro}` : host)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const nodeId = rawId && !isLocalNodeId(rawId) ? rawId : "remote-node";
  const nodeName = wslDistro ? `Windows WSL2 (${wslDistro})` : host;
  return { nodeId, nodeName };
}

export function nodeConfigPath(hubDir: string = resolveHubDir()): string {
  return path.join(hubDir, "node.json");
}

export function nodeRuntimePath(hubDir: string = resolveHubDir()): string {
  return path.join(hubDir, "node-runtime.json");
}

export function nodeLogPath(hubDir: string = resolveHubDir()): string {
  return path.join(hubDir, "node.log");
}

export function readNodeConfig(hubDir: string = resolveHubDir()): NodeConfig | null {
  const filePath = nodeConfigPath(hubDir);
  if (!fs.existsSync(filePath)) return null;
  const raw = readJsonStrict<Partial<NodeConfig>>(filePath, 32 * 1024);
  if (raw.schemaVersion !== 1 || typeof raw.hubUrl !== "string" || typeof raw.nodeId !== "string") {
    throw new WorkbenchError("corrupt_record", `远程节点配置文件损坏: ${filePath}`);
  }
  return {
    schemaVersion: 1,
    hubUrl: raw.hubUrl,
    ...(typeof raw.token === "string" && raw.token ? { token: raw.token } : {}),
    nodeId: raw.nodeId,
    nodeName: typeof raw.nodeName === "string" && raw.nodeName.trim() ? raw.nodeName.trim() : raw.nodeId,
  };
}

export function writeNodeConfig(cfg: NodeConfig, hubDir: string = resolveHubDir()): NodeConfig {
  validateText(cfg.hubUrl);
  if (cfg.token) validateText(cfg.token);
  validateText(cfg.nodeId);
  validateText(cfg.nodeName);
  if (!isRemoteNodeId(cfg.nodeId)) {
    throw new WorkbenchError("invalid_input", `无效节点 ID: ${cfg.nodeId}（允许字母/数字/._-，不能为 local）`);
  }
  buildNodeWebSocketUrl(cfg.hubUrl, {
    nodeId: cfg.nodeId,
    nodeName: cfg.nodeName,
    hostname: os.hostname(),
    platform: process.platform,
    version: "5.0.0",
  });
  fs.mkdirSync(hubDir, { recursive: true, mode: 0o700 });
  atomicWriteJson(nodeConfigPath(hubDir), cfg, 0o600);
  return cfg;
}

export function readNodeRuntimeStatus(hubDir: string = resolveHubDir()): NodeRuntimeStatus | null {
  const filePath = nodeRuntimePath(hubDir);
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<NodeRuntimeStatus>;
    if (typeof raw.pid !== "number" || typeof raw.nodeId !== "string") return null;
    return raw as NodeRuntimeStatus;
  } catch {
    return null;
  }
}

function writeNodeRuntimeStatus(status: NodeRuntimeStatus, hubDir: string): void {
  fs.mkdirSync(hubDir, { recursive: true, mode: 0o700 });
  atomicWriteJson(nodeRuntimePath(hubDir), status, 0o600);
}

function removeNodeRuntimeStatus(expectedPid: number, hubDir: string): void {
  try {
    const cur = readNodeRuntimeStatus(hubDir);
    if (cur && cur.pid === expectedPid) {
      fs.rmSync(nodeRuntimePath(hubDir), { force: true });
    }
  } catch {
    // Ignore cleanup errors.
  }
}

function serviceArgs(s: NodeServiceInstallation): string[] {
  return [s.bunPath, "run", s.cliPath, "node", "connect"];
}

function renderDefinition(s: NodeServiceInstallation): string {
  const environment = { ...(s.proxyEnv ?? {}), PATH: s.path, HOME: s.workingDirectory, WORKBENCH_HUB_DIR: s.hubDir };
  if (s.manager === "launchd") {
    const log = nodeLogPath(s.hubDir);
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<!-- ${MARKER} -->\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(s.id)}</string>\n<key>ProgramArguments</key><array>${serviceArgs(s).map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>\n<key>WorkingDirectory</key><string>${xml(s.workingDirectory)}</string>\n<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join("")}</dict>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>ThrottleInterval</key><integer>5</integer>\n<key>StandardOutPath</key><string>${xml(log)}</string>\n<key>StandardErrorPath</key><string>${xml(log)}</string>\n</dict></plist>\n`;
  }
  return `# ${MARKER}\n[Unit]\nDescription=Workbench remote node (${validateText(s.id)})\n\n[Service]\nType=simple\nExecStart=${serviceArgs(s).map((arg) => unit(arg, true)).join(" ")}\nWorkingDirectory=${validateText(s.workingDirectory)}\n${Object.entries(environment).map(([key, value]) => `Environment=${unit(`${key}=${value}`)}`).join("\n")}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=15\nKillMode=control-group\n\n[Install]\nWantedBy=default.target\n`;
}

export interface NodeServiceOptions {
  platform?: NodeJS.Platform;
  home?: string;
  hubDir?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  cliPath?: string;
  uid?: number;
  connectTimeoutMs?: number;
  runCommand?: (command: string, args: string[]) => Promise<NodeCommandResult>;
}

export function createNodeServiceManager(options: NodeServiceOptions = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? os.homedir();
  const hubDir = canonicalPath(options.hubDir ?? resolveHubDir());
  const installFilePath = path.join(hubDir, "node-service.json");
  const run = options.runCommand ?? execute;
  const uid = options.uid ?? process.getuid?.();
  const domain = `gui/${uid}`;
  const connectTimeoutMs = options.connectTimeoutMs ?? 5_000;

  function manager(): Manager {
    if (platform === "darwin") return "launchd";
    if (platform === "linux") return "systemd";
    fail("远程节点服务仅支持 macOS 与 Linux/WSL2");
  }

  function identity(kind: Manager): { id: string; definitionPath: string } {
    const hash = createHash("sha256").update(hubDir).digest("hex").slice(0, 12);
    const id = kind === "launchd" ? `com.workbench.node-${hash}` : `workbench-node-${hash}.service`;
    if (!path.isAbsolute(home)) fail("HOME 必须是绝对路径");
    const configHome = env.XDG_CONFIG_HOME || path.join(home, ".config");
    if (kind === "systemd" && !path.isAbsolute(configHome)) fail("XDG_CONFIG_HOME 必须是绝对路径");
    return {
      id,
      definitionPath:
        kind === "launchd"
          ? path.join(home, "Library", "LaunchAgents", `${id}.plist`)
          : path.join(configHome, "systemd", "user", id),
    };
  }

  function readInstallation(): NodeServiceInstallation | null {
    if (!fs.existsSync(installFilePath)) {
      try { fs.lstatSync(installFilePath); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
      fail(`无效节点服务安装记录: ${installFilePath}`);
    }
    assertRegular(installFilePath);
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(installFilePath, "utf8")); } catch { fail(`节点服务安装记录损坏: ${installFilePath}`); }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`节点服务安装记录损坏: ${installFilePath}`);
    const s = raw as NodeServiceInstallation;
    if (s.schemaVersion !== 1 || s.manager !== manager()) {
      fail(`节点服务安装记录与当前平台不匹配: ${installFilePath}`);
    }
    for (const key of ["id", "definitionPath", "bunPath", "cliPath", "workingDirectory", "hubDir", "path"] as const) {
      if (typeof s[key] !== "string" || !s[key]) fail(`节点服务安装记录字段无效: ${key}`);
      validateText(s[key]);
    }
    if (s.proxyEnv !== undefined) {
      if (!s.proxyEnv || typeof s.proxyEnv !== "object" || Array.isArray(s.proxyEnv)) fail(`节点服务安装记录字段无效: proxyEnv`);
      for (const [key, value] of Object.entries(s.proxyEnv)) {
        if (!(PROXY_ENV_KEYS as readonly string[]).includes(key)) fail(`节点服务安装记录字段无效: proxyEnv.${key}`);
        if (typeof value !== "string" || !value) fail(`节点服务安装记录字段无效: proxyEnv.${key}`);
        validateText(value);
      }
    }
    const expected = identity(s.manager);
    if (
      s.id !== expected.id ||
      s.definitionPath !== expected.definitionPath ||
      s.hubDir !== hubDir ||
      s.workingDirectory !== home ||
      !path.isAbsolute(s.bunPath) ||
      !path.isAbsolute(s.cliPath) ||
      s.path.split(path.delimiter).some((part) => !part || !path.isAbsolute(part))
    ) {
      fail(`节点服务安装记录与当前用户/Hub 不匹配: ${installFilePath}`);
    }
    if (!fs.existsSync(s.definitionPath)) {
      try { fs.lstatSync(s.definitionPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") fail(`节点服务定义缺失: ${s.definitionPath}`);
        throw error;
      }
      fail(`拒绝访问非普通文件或符号链接: ${s.definitionPath}`);
    }
    assertRegular(s.definitionPath);
    if (fs.readFileSync(s.definitionPath, "utf8") !== renderDefinition(s)) {
      fail(`拒绝修改不属于当前 Workbench 节点安装的服务定义: ${s.definitionPath}`);
    }
    return s;
  }

  async function command(kind: Manager, args: string[]): Promise<NodeCommandResult> {
    const executable = kind === "launchd" ? "launchctl" : "systemctl";
    const actualArgs = kind === "systemd" ? ["--user", ...args] : args;
    return run(executable, actualArgs);
  }

  async function checked(kind: Manager, args: string[]): Promise<NodeCommandResult> {
    const res = await command(kind, args);
    if (res.exitCode !== 0) {
      fail(`${kind === "launchd" ? "launchctl" : "systemctl --user"} ${args.join(" ")} 失败: ${res.stderr.trim() || res.stdout.trim()}`);
    }
    return res;
  }

  async function nativeState(s: NodeServiceInstallation): Promise<{ loaded: boolean; active: boolean; pid: number }> {
    const res = await command(s.manager, s.manager === "launchd" ? ["print", `${domain}/${s.id}`] : ["show", s.id, "--property=LoadState,ActiveState,MainPID"]);
    if (s.manager === "launchd") {
      if (res.exitCode !== 0) return { loaded: false, active: false, pid: 0 };
      return {
        loaded: true,
        active: /\bstate = running\b/.test(res.stdout),
        pid: Number(res.stdout.match(/^\s*pid = (\d+)/m)?.[1] ?? 0),
      };
    }
    const props = Object.fromEntries(
      res.stdout
        .trim()
        .split("\n")
        .map((line) => {
          const idx = line.indexOf("=");
          return [line.slice(0, idx), line.slice(idx + 1)];
        }),
    );
    if (props.LoadState === "not-found") return { loaded: false, active: false, pid: 0 };
    return {
      loaded: true,
      active: ["active", "activating", "reloading", "deactivating"].includes(props.ActiveState ?? ""),
      pid: Number(props.MainPID ?? 0),
    };
  }

  async function getStatus(): Promise<NodeStatusResult> {
    const cfg = readNodeConfig(hubDir);
    const installation = readInstallation();
    const runtime = readNodeRuntimeStatus(hubDir);
    const runtimeAlive = Boolean(runtime && isPidAlive(runtime.pid));

    if (installation) {
      const st = await nativeState(installation);
      const pidMatches = Boolean(runtime && runtime.pid === st.pid && runtimeAlive);
      return {
        configured: Boolean(cfg),
        installed: true,
        manager: installation.manager,
        serviceId: installation.id,
        active: st.active,
        connected: Boolean(st.active && pidMatches && runtime?.connected),
        pid: st.active && st.pid > 0 ? st.pid : null,
        nodeId: cfg?.nodeId ?? runtime?.nodeId ?? null,
        nodeName: cfg?.nodeName ?? runtime?.nodeName ?? null,
        hubUrl: cfg?.hubUrl ?? runtime?.hubUrl ?? null,
        lastError: pidMatches ? runtime?.lastError ?? null : null,
        logPath: nodeLogPath(hubDir),
      };
    }

    return {
      configured: Boolean(cfg),
      installed: false,
      manager: null,
      serviceId: null,
      active: runtimeAlive,
      connected: Boolean(runtimeAlive && runtime?.connected),
      pid: runtimeAlive ? runtime!.pid : null,
      nodeId: cfg?.nodeId ?? runtime?.nodeId ?? null,
      nodeName: cfg?.nodeName ?? runtime?.nodeName ?? null,
      hubUrl: cfg?.hubUrl ?? runtime?.hubUrl ?? null,
      lastError: runtimeAlive ? runtime?.lastError ?? null : null,
      logPath: nodeLogPath(hubDir),
    };
  }

  async function waitForConnection(timeoutMs = 5_000): Promise<NodeStatusResult> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const st = await getStatus();
      if (st.connected) return st;
      await delay(120);
    }
    return getStatus();
  }

  async function installService(cfg: NodeConfig): Promise<NodeStatusResult> {
    const kind = manager();
    if (kind === "launchd" && uid === undefined) fail("无法确定当前用户 UID");
    writeNodeConfig(cfg, hubDir);

    const bunPath = fs.realpathSync(options.execPath ?? process.execPath);
    const cliPath = path.resolve(options.cliPath ?? path.join(import.meta.dir, "index.ts"));
    const searchPath = [...new Set([...(env.PATH ?? "").split(path.delimiter).filter((p) => p && path.isAbsolute(p)), path.dirname(bunPath)])].join(path.delimiter);
    const proxyEnv = collectProxyEnv(env);
    const id = identity(kind);
    const next: NodeServiceInstallation = {
      schemaVersion: 1,
      manager: kind,
      ...id,
      bunPath,
      cliPath,
      workingDirectory: home,
      hubDir,
      path: validateText(searchPath),
      ...(proxyEnv ? { proxyEnv } : {}),
    };

    const contents = renderDefinition(next);
    const existing = readInstallation();
    await checked(kind, kind === "launchd" ? ["print", domain] : ["show-environment"]);
    if (existing) {
      if (kind === "systemd") await checked(kind, ["stop", existing.id]).catch(() => {});
      else await command(kind, ["bootout", domain, existing.definitionPath]).catch(() => {});
    } else {
      try {
        fs.lstatSync(next.definitionPath);
        fail(`拒绝覆盖未知节点服务定义: ${next.definitionPath}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await stopDetachedNode(hubDir);
    }

    fs.mkdirSync(path.dirname(next.definitionPath), { recursive: true });
    atomicWriteFile(next.definitionPath, contents, next.proxyEnv ? 0o600 : undefined);
    atomicWriteJson(installFilePath, next, 0o600);

    if (kind === "systemd") {
      await checked(kind, ["daemon-reload"]);
      await checked(kind, ["enable", "--now", next.id]);
    } else {
      await checked(kind, ["bootstrap", domain, next.definitionPath]);
    }
    return waitForConnection(connectTimeoutMs);
  }

  async function controlService(action: NodeServiceAction): Promise<NodeStatusResult> {
    if (action === "status") return getStatus();
    const s = readInstallation();
    if (!s) {
      if (action === "uninstall") {
        await stopDetachedNode(hubDir);
        return getStatus();
      }
      if (action === "stop") {
        await stopDetachedNode(hubDir);
        return getStatus();
      }
      const cfg = readNodeConfig(hubDir);
      if (!cfg) {
        fail("尚未配置远程节点；请运行 wb node install --hub <url> --token <pwd> 或 wb node start --hub <url> --token <pwd>");
      }
      if (action === "restart") await stopDetachedNode(hubDir);
      await startDetachedNode(cfg, { hubDir, cliPath: options.cliPath, execPath: options.execPath });
      return waitForConnection(connectTimeoutMs);
    }

    await checked(s.manager, s.manager === "launchd" ? ["print", domain] : ["show-environment"]);
    if (action === "start" || action === "restart") {
      if (s.manager === "systemd") {
        await checked(s.manager, [action === "restart" ? "restart" : "start", s.id]);
      } else {
        const st = await nativeState(s);
        if (st.loaded) await checked(s.manager, ["kickstart", ...(action === "restart" ? ["-k"] : []), `${domain}/${s.id}`]);
        else await checked(s.manager, ["bootstrap", domain, s.definitionPath]);
      }
      return waitForConnection(connectTimeoutMs);
    }

    if (s.manager === "systemd") {
      await checked(s.manager, action === "uninstall" ? ["disable", "--now", s.id] : ["stop", s.id]);
    } else {
      const st = await nativeState(s);
      if (st.loaded) await checked(s.manager, ["bootout", domain, s.definitionPath]);
    }
    if (action === "uninstall") {
      fs.rmSync(s.definitionPath, { force: true });
      if (s.manager === "systemd") {
        await checked(s.manager, ["daemon-reload"]).catch(() => {});
      }
      fs.rmSync(installFilePath, { force: true });
    }
    return getStatus();
  }

  return { readInstallation, getStatus, installService, controlService };
}

export async function startDetachedNode(
  cfg: NodeConfig,
  opts: { hubDir?: string; cliPath?: string; execPath?: string } = {},
): Promise<NodeStatusResult> {
  const hubDir = opts.hubDir ?? resolveHubDir();
  writeNodeConfig(cfg, hubDir);

  const existing = readNodeRuntimeStatus(hubDir);
  if (existing && isPidAlive(existing.pid)) {
    return createNodeServiceManager({ hubDir }).getStatus();
  }

  fs.mkdirSync(hubDir, { recursive: true, mode: 0o700 });
  const logFile = nodeLogPath(hubDir);
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_NODE_LOG_BYTES) {
      fs.writeFileSync(logFile, "");
    }
  } catch {
    // Ignore log rotate errors.
  }

  const outFd = fs.openSync(logFile, "a", 0o600);
  const cliEntry = opts.cliPath ?? path.resolve(import.meta.dir, "./index.ts");
  const bunBin = opts.execPath ?? process.execPath;
  const child = spawn(bunBin, ["run", cliEntry, "node", "connect"], {
    cwd: os.homedir(),
    detached: true,
    stdio: ["ignore", outFd, outFd],
    env: { ...process.env, WORKBENCH_HUB_DIR: hubDir },
  });
  child.unref();
  fs.closeSync(outFd);

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const st = await createNodeServiceManager({ hubDir }).getStatus();
    if (st.connected) return st;
    await delay(100);
  }
  return createNodeServiceManager({ hubDir }).getStatus();
}

export async function stopDetachedNode(hubDir: string = resolveHubDir()): Promise<boolean> {
  const runtime = readNodeRuntimeStatus(hubDir);
  if (!runtime) return false;
  if (!isPidAlive(runtime.pid)) {
    removeNodeRuntimeStatus(runtime.pid, hubDir);
    return false;
  }
  try {
    process.kill(runtime.pid, "SIGTERM");
  } catch {
    removeNodeRuntimeStatus(runtime.pid, hubDir);
    return false;
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!isPidAlive(runtime.pid)) {
      removeNodeRuntimeStatus(runtime.pid, hubDir);
      return true;
    }
    await delay(60);
  }
  try {
    process.kill(runtime.pid, "SIGKILL");
  } catch {
    // Already exited.
  }
  removeNodeRuntimeStatus(runtime.pid, hubDir);
  return true;
}

/** Runs the node bridge client in the current process until SIGINT/SIGTERM. */
export async function runNodeForeground(cfg: NodeConfig, hubDir: string = resolveHubDir()): Promise<void> {
  let connectedAt: number | null = null;
  let lastError: string | null = null;

  const updateRuntime = (connected: boolean) => {
    writeNodeRuntimeStatus(
      {
        pid: process.pid,
        nodeId: cfg.nodeId,
        nodeName: cfg.nodeName,
        hubUrl: cfg.hubUrl,
        connected,
        connectedAt,
        lastError,
        updatedAt: Date.now(),
      },
      hubDir,
    );
  };

  updateRuntime(false);
  const manager = createNodeServiceManager({ hubDir });
  let updatesEnabled = false;
  if (process.platform === "linux") {
    try {
      const installation = manager.readInstallation();
      updatesEnabled = Boolean(installation && readUpdateBranch(hubDir) && (await manager.getStatus()).pid === process.pid);
    } catch (error) {
      console.error("Node update unavailable:", error);
    }
  }

  const client = startWorkbenchNodeClient({
    hubUrl: cfg.hubUrl,
    token: cfg.token,
    nodeId: cfg.nodeId,
    nodeName: cfg.nodeName,
    updates: updatesEnabled ? {
      read: () => readNodeUpdate(hubDir),
      blocksWork: (revision) => nodeUpdateBlocksWork(readNodeUpdate(hubDir), revision),
      start: async (id, revision, runningRevision) => {
        const installation = manager.readInstallation();
        if (!installation || (await manager.getStatus()).pid !== process.pid) throw new Error("Update requires the installed systemd node");
        await queueNodeUpdate(installation, id, revision, runningRevision);
      },
    } : undefined,
    onConnected: () => {
      connectedAt = Date.now();
      lastError = null;
      updateRuntime(true);
    },
    onDisconnected: (reason) => {
      lastError = reason ?? "连接已断开";
      updateRuntime(false);
    },
  });

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      client.stop();
      removeNodeRuntimeStatus(process.pid, hubDir);
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
