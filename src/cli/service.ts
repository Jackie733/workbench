import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WorkbenchError } from "../core/errors.ts";
import { atomicWriteFile, atomicWriteJson } from "../core/fs.ts";
import { readDaemonInfo, resolveHubDir } from "../hub/registry.ts";
import type { DaemonInfo } from "../hub/types.ts";
import { isDaemonHealthy } from "./daemon.ts";

type Manager = "launchd" | "systemd";
type Action = "start" | "stop" | "restart" | "status" | "uninstall";
export interface ServiceInstallation {
  schemaVersion: 1;
  manager: Manager;
  id: string;
  definitionPath: string;
  bunPath: string;
  cliPath: string;
  workingDirectory: string;
  hubDir: string;
  port: number;
  path: string;
  proxyEnv?: Record<string, string>;
}
export interface ServiceStatus {
  installed: boolean;
  manager: Manager | null;
  id: string | null;
  active: boolean;
  healthy: boolean;
  url: string | null;
  definitionPath: string | null;
}
export interface ServiceCommandResult { exitCode: number; stdout: string; stderr: string }
export interface UserServiceManager {
  readServiceInstallation(): ServiceInstallation | null;
  installUserService(options?: { port?: number }): Promise<ServiceStatus>;
  controlUserService(action: Action): Promise<ServiceStatus>;
}
export interface UserServiceOptions {
  platform?: NodeJS.Platform;
  home?: string;
  hubDir?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  cliPath?: string;
  uid?: number;
  runCommand?: (command: string, args: string[]) => Promise<ServiceCommandResult>;
}
const NOT_INSTALLED: ServiceStatus = { installed: false, manager: null, id: null, active: false, healthy: false, url: null, definitionPath: null };
const MARKER = "Workbench managed user Hub; schemaVersion=1";
// Managed services do not inherit the installing shell's environment. Persist only the standard
// proxy variables (both casings are used by different agent CLIs) so model traffic can reach the
// network through the user's system proxy.
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const;

function fail(message: string): never { throw new WorkbenchError("execution_failed", message); }
function validateText(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new WorkbenchError("invalid_input", "服务路径和环境值不能包含 NUL、CR 或 LF");
  return value;
}
function canonicalPath(value: string): string {
  const absolute = path.resolve(value);
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
  const parent = path.dirname(absolute);
  return parent === absolute ? absolute : path.join(canonicalPath(parent), path.basename(absolute));
}
function validPort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new WorkbenchError("invalid_input", `无效端口号: ${String(port)}`);
}
function xml(value: string): string {
  return validateText(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]!);
}
// ExecStart is parsed by systemd, not a shell. Escape both specifiers and variable expansion.
function unit(value: string, executableArgument = false): string {
  let escaped = validateText(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
  if (executableArgument) escaped = escaped.replace(/\$/g, "$$$$");
  return `"${escaped}"`;
}
function serviceArgs(s: ServiceInstallation): string[] {
  return [s.bunPath, "run", s.cliPath, "serve", "--hub", "--host", "127.0.0.1", "--port", String(s.port), "--root", s.workingDirectory];
}
function collectProxyEnv(env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  const proxyEnv: Record<string, string> = {};
  for (const key of PROXY_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value) proxyEnv[key] = validateText(value);
  }
  // Omit the field entirely when no proxy is configured so old and new installations serialize
  // identically; otherwise an upgrade would trigger a needless stop/reinstall on first run.
  return Object.keys(proxyEnv).length > 0 ? proxyEnv : undefined;
}
function definition(s: ServiceInstallation): string {
  // Fixed keys come last so a tampered record can never override PATH/HOME.
  const environment = { ...(s.proxyEnv ?? {}), PATH: s.path, HOME: s.workingDirectory, WORKBENCH_HUB_DIR: s.hubDir };
  if (s.manager === "launchd") {
    const log = path.join(s.hubDir, "service.log");
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<!-- ${MARKER} -->\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(s.id)}</string>\n<key>ProgramArguments</key><array>${serviceArgs(s).map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>\n<key>WorkingDirectory</key><string>${xml(s.workingDirectory)}</string>\n<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join("")}</dict>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>ThrottleInterval</key><integer>5</integer>\n<key>StandardOutPath</key><string>${xml(log)}</string>\n<key>StandardErrorPath</key><string>${xml(log)}</string>\n</dict></plist>\n`;
  }
  return `# ${MARKER}\n[Unit]\nDescription=Workbench user Hub\n\n[Service]\nType=simple\nExecStart=${serviceArgs(s).map((arg) => unit(arg, true)).join(" ")}\nWorkingDirectory=${validateText(s.workingDirectory)}\n${Object.entries(environment).map(([key, value]) => `Environment=${unit(`${key}=${value}`)}`).join("\n")}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=15\nKillMode=control-group\n\n[Install]\nWantedBy=default.target\n`;
}
function execute(command: string, args: string[]): Promise<ServiceCommandResult> {
  const { promise, resolve, reject } = Promise.withResolvers<ServiceCommandResult>();
  execFile(command, args, { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    if (error && (typeof error.code !== "number" || error.killed)) {
      reject(new WorkbenchError("execution_failed", `${command} ${args.join(" ")}: ${error.message}${stderr ? `\n${stderr.trim()}` : ""}`));
    } else resolve({ exitCode: error ? Number(error.code) : 0, stdout, stderr });
  });
  return promise;
}
function assertRegular(file: string): void {
  if (!fs.lstatSync(file).isFile()) fail(`拒绝访问非普通文件或符号链接: ${file}`);
}

/** The injectable boundary is native platform control; health probes remain real HTTP/PID checks. */
export function createUserServiceManager(options: UserServiceOptions = {}): UserServiceManager {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? os.homedir();
  const hubDir = canonicalPath(options.hubDir ?? resolveHubDir());
  const configPath = path.join(hubDir, "service.json");
  const run = options.runCommand ?? execute;
  const uid = options.uid ?? process.getuid?.();
  const domain = `gui/${uid}`;
  function manager(): Manager {
    if (platform === "darwin") return "launchd";
    if (platform === "linux") return "systemd";
    fail("用户级服务仅支持 macOS 和 Linux/WSL2；Windows 请在 WSL2 发行版内安装（参见 docs/DEPLOYMENT.md）。");
  }
  function identity(kind: Manager): { id: string; definitionPath: string } {
    const hash = createHash("sha256").update(hubDir).digest("hex").slice(0, 12);
    const id = kind === "launchd" ? `com.workbench.hub-${hash}` : `workbench-hub-${hash}.service`;
    if (!path.isAbsolute(home)) fail("HOME 必须是绝对路径");
    const configHome = env.XDG_CONFIG_HOME || path.join(home, ".config");
    if (kind === "systemd" && !path.isAbsolute(configHome)) fail("XDG_CONFIG_HOME 必须是绝对路径");
    return { id, definitionPath: kind === "launchd" ? path.join(home, "Library", "LaunchAgents", `${id}.plist`) : path.join(configHome, "systemd", "user", id) };
  }
  function readServiceInstallation(): ServiceInstallation | null {
    if (!fs.existsSync(configPath)) {
      // existsSync follows symlinks; dangling links must not be treated as uninstalled.
      try { fs.lstatSync(configPath); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
      fail(`无效服务安装记录: ${configPath}`);
    }
    assertRegular(configPath);
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch { fail(`服务安装记录损坏: ${configPath}`); }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`服务安装记录损坏: ${configPath}`);
    const s = raw as ServiceInstallation;
    if (s.schemaVersion !== 1 || s.manager !== manager()) fail(`服务安装记录版本或平台不匹配: ${configPath}`);
    for (const key of ["id", "definitionPath", "bunPath", "cliPath", "workingDirectory", "hubDir", "path"] as const) {
      if (typeof s[key] !== "string" || !s[key]) fail(`服务安装记录字段无效: ${key}`);
      validateText(s[key]);
    }
    validPort(s.port);
    if (s.proxyEnv !== undefined) {
      if (!s.proxyEnv || typeof s.proxyEnv !== "object" || Array.isArray(s.proxyEnv)) fail(`服务安装记录字段无效: proxyEnv`);
      for (const [key, value] of Object.entries(s.proxyEnv)) {
        if (!(PROXY_ENV_KEYS as readonly string[]).includes(key)) fail(`服务安装记录字段无效: proxyEnv.${key}`);
        if (typeof value !== "string" || !value) fail(`服务安装记录字段无效: proxyEnv.${key}`);
        validateText(value);
      }
    }
    const expected = identity(s.manager);
    if (s.id !== expected.id || s.definitionPath !== expected.definitionPath || s.hubDir !== hubDir || s.workingDirectory !== home || !path.isAbsolute(s.bunPath) || !path.isAbsolute(s.cliPath) || s.path.split(path.delimiter).some((part) => !path.isAbsolute(part))) fail(`服务安装记录与当前用户/Hub 不匹配: ${configPath}`);
    if (!fs.existsSync(s.definitionPath)) fail(`服务定义缺失: ${s.definitionPath}；请恢复定义后卸载或重新安装`);
    assertRegular(s.definitionPath);
    if (fs.readFileSync(s.definitionPath, "utf8") !== definition(s)) fail(`拒绝修改不属于当前 Workbench 安装的服务定义: ${s.definitionPath}`);
    return s;
  }
  async function command(kind: Manager, args: string[]): Promise<ServiceCommandResult> {
    const executable = kind === "launchd" ? "launchctl" : "systemctl";
    const actualArgs = kind === "systemd" ? ["--user", ...args] : args;
    try { return await run(executable, actualArgs); } catch (error) { fail(`${executable} ${actualArgs.join(" ")}: ${error instanceof Error ? error.message : String(error)}\n${sessionHint()}`); }
  }
  function sessionHint(): string {
    let wsl = Boolean(env.WSL_DISTRO_NAME);
    if (platform === "linux" && !wsl) {
      try { wsl = /microsoft|wsl/i.test(fs.readFileSync("/proc/sys/kernel/osrelease", "utf8")); } catch { /* Not WSL. */ }
    }
    return platform === "darwin" ? "需要当前用户的图形登录会话 (launchctl gui/<uid>)。" : wsl ? "WSL2 需要启用 systemd 并具有可用的 systemctl --user 会话；参见 https://learn.microsoft.com/en-us/windows/wsl/systemd 。安装程序不会修改 /etc/wsl.conf 或启用 linger。" : "需要可用的 systemd --user 会话总线；不会自动启用 linger。可主动使用 wb serve --hub --port 4318 前台运行。";
  }
  async function checked(kind: Manager, args: string[]): Promise<ServiceCommandResult> {
    const result = await command(kind, args);
    if (result.exitCode !== 0) fail(`${kind === "launchd" ? "launchctl" : "systemctl --user"} ${args.join(" ")} 失败 (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}\n${sessionHint()}`);
    return result;
  }
  async function ensureManager(kind: Manager): Promise<void> {
    if (kind === "launchd" && uid === undefined) fail("无法确定当前用户 UID");
    await checked(kind, kind === "launchd" ? ["print", domain] : ["show-environment"]);
  }
  async function nativeState(s: ServiceInstallation): Promise<{ loaded: boolean; active: boolean; pid: number }> {
    const result = await command(s.manager, s.manager === "launchd" ? ["print", `${domain}/${s.id}`] : ["show", s.id, "--property=LoadState,ActiveState,MainPID"]);
    if (s.manager === "launchd") {
      if (result.exitCode !== 0) {
        if (/could not find service|service not found|no such process/i.test(result.stderr)) return { loaded: false, active: false, pid: 0 };
        fail(`launchctl print 失败: ${result.stderr || result.stdout}\n${sessionHint()}`);
      }
      return { loaded: true, active: /\bstate = running\b/.test(result.stdout), pid: Number(result.stdout.match(/^\s*pid = (\d+)/m)?.[1] ?? 0) };
    }
    const props = Object.fromEntries(result.stdout.trim().split("\n").map((line) => { const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)]; }));
    if (props.LoadState === "not-found") return { loaded: false, active: false, pid: 0 };
    if (result.exitCode !== 0 || props.LoadState !== "loaded" || !props.ActiveState || !/^\d+$/.test(props.MainPID ?? "")) fail(`systemctl --user show 失败: ${result.stderr || result.stdout}\n${sessionHint()}`);
    return { loaded: true, active: ["active", "activating", "reloading", "deactivating"].includes(props.ActiveState), pid: Number(props.MainPID) };
  }
  function daemonInfo(): DaemonInfo | null {
    // Production uses the registry reader; isolated controllers read their own namespace.
    if (!options.hubDir) return readDaemonInfo();
    try { return JSON.parse(fs.readFileSync(path.join(hubDir, "daemon.json"), "utf8")) as DaemonInfo; } catch { return null; }
  }
  async function status(s: ServiceInstallation): Promise<ServiceStatus> {
    const state = await nativeState(s);
    const info = daemonInfo();
    const url = `http://127.0.0.1:${s.port}`;
    const healthy = Boolean(state.active && state.pid > 0 && info && info.pid === state.pid && info.port === s.port && info.url === url && await isDaemonHealthy(info));
    return { installed: true, manager: s.manager, id: s.id, active: state.active, healthy, url: healthy ? url : null, definitionPath: s.definitionPath };
  }
  async function waitHealthy(s: ServiceInstallation): Promise<ServiceStatus> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const current = await status(s);
      if (current.healthy) return current;
      await delay(150);
    }
    fail(`用户服务未在 30 秒内通过健康检查（端口 ${s.port}，不会自动换端口）。检查 ${s.manager === "launchd" ? path.join(hubDir, "service.log") : `journalctl --user -u ${s.id}`}；安装记录已保留，可运行 wb service status/uninstall。`);
  }
  async function start(s: ServiceInstallation, restart = false): Promise<ServiceStatus> {
    // A stale source/Bun location must not trigger executable discovery or detached fallback.
    for (const file of [s.bunPath, s.cliPath]) {
      try { fs.accessSync(file, fs.constants.R_OK); } catch { fail(`服务路径不可读: ${file}；请从固定源码目录重新运行部署安装`); }
    }
    if (s.manager === "systemd") await checked(s.manager, [restart ? "restart" : "start", s.id]);
    else {
      const state = await nativeState(s);
      if (state.loaded) await checked(s.manager, ["kickstart", ...(restart ? ["-k"] : []), `${domain}/${s.id}`]);
      else await checked(s.manager, ["bootstrap", domain, s.definitionPath]);
    }
    return waitHealthy(s);
  }
  async function stop(s: ServiceInstallation, uninstall = false): Promise<void> {
    const state = await nativeState(s);
    if (s.manager === "systemd") await checked(s.manager, uninstall ? ["disable", "--now", s.id] : ["stop", s.id]);
    else if (state.loaded) await checked(s.manager, ["bootout", domain, s.definitionPath]);
    const deadline = Date.now() + 30_000;
    while ((await nativeState(s)).active) {
      if (Date.now() >= deadline) fail(`服务未停止，保留安装定义和记录: ${s.id}`);
      await delay(100);
    }
  }
  async function assertPortAvailable(port: number): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const server = net.createServer();
    server.once("error", (error) => reject(new WorkbenchError("execution_failed", `端口 127.0.0.1:${port} 不可用；不会自动换端口: ${error.message}`)));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close((error) => error ? reject(error) : resolve()));
    await promise;
  }
  async function installUserService(installOptions: { port?: number } = {}): Promise<ServiceStatus> {
    const kind = manager();
    const port = installOptions.port ?? 4318;
    validPort(port);
    const existing = readServiceInstallation();
    const id = identity(kind);
    validateText(home);
    try { if (!fs.statSync(home).isDirectory()) fail("HOME 不是目录"); fs.accessSync(home, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK); } catch { fail(`用户 HOME 不可访问: ${home}`); }
    let bunPath: string;
    const cliPath = path.resolve(options.cliPath ?? path.join(import.meta.dir, "index.ts"));
    try {
      bunPath = fs.realpathSync(options.execPath ?? process.execPath);
      fs.accessSync(bunPath, fs.constants.R_OK | fs.constants.X_OK);
      fs.accessSync(cliPath, fs.constants.R_OK);
      fs.accessSync(path.resolve(path.dirname(cliPath), "../../package.json"), fs.constants.R_OK);
      fs.accessSync(path.resolve(path.dirname(cliPath), "../server/index.ts"), fs.constants.R_OK);
    } catch { fail("Bun 或 Workbench 源码不完整/不可读；请保留固定源码目录及其依赖后重装"); }
    const git = await run("git", ["--version"]);
    if (git.exitCode !== 0) fail(`Git 不可用: ${git.stderr || git.stdout}`);
    await ensureManager(kind);
    const searchPath = [...new Set([...(env.PATH ?? "").split(path.delimiter).filter((part) => part && path.isAbsolute(part)), path.dirname(bunPath)])].join(path.delimiter);
    const proxyEnv = collectProxyEnv(env);
    const next: ServiceInstallation = { schemaVersion: 1, manager: kind, ...id, bunPath, cliPath, workingDirectory: home, hubDir, port, path: validateText(searchPath), ...(proxyEnv ? { proxyEnv } : {}) };
    // Render before stopping anything so invalid manager syntax cannot interrupt a working Hub.
    const contents = definition(next);
    if (!existing) {
      try { fs.lstatSync(id.definitionPath); fail(`拒绝覆盖未知服务定义: ${id.definitionPath}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const info = daemonInfo();
      if (info && await isDaemonHealthy(info)) fail("发现未托管的健康 Hub；请先运行 wb stop，避免中断正在运行的任务，再安装用户服务。");
      await assertPortAvailable(port);
    } else if (JSON.stringify(existing) === JSON.stringify(next)) {
      const current = await status(existing);
      if (current.healthy) return current;
      const info = daemonInfo();
      if (info && await isDaemonHealthy(info)) fail("发现未托管的健康 Hub；请先运行 wb stop，避免中断正在运行的任务，再安装用户服务。");
      await assertPortAvailable(port);
      if (kind === "systemd") {
        await checked(kind, ["daemon-reload"]);
        await checked(kind, ["enable", "--now", existing.id]);
        return waitHealthy(existing);
      }
      return start(existing);
    } else {
      const prevState = await nativeState(existing);
      if (existing.port !== port || !prevState.active) {
        await assertPortAvailable(port);
      }
      process.stderr.write("Workbench 服务配置变更，正在停止并重新安装；运行中的任务将被中断。\n");
      await stop(existing);
      if (existing.port === port && prevState.active) {
        await assertPortAvailable(port);
      }
    }
    fs.mkdirSync(hubDir, { recursive: true, mode: 0o700 });
    // Proxy URLs may embed credentials. systemd --user and launchd gui load the file as the same
    // user, so a private mode does not affect service startup.
    atomicWriteFile(next.definitionPath, contents, next.proxyEnv ? 0o600 : undefined);
    atomicWriteJson(configPath, next);
    fs.chmodSync(configPath, 0o600);
    if (kind === "systemd") {
      await checked(kind, ["daemon-reload"]);
      await checked(kind, ["enable", "--now", next.id]);
      return waitHealthy(next);
    }
    return start(next);
  }
  async function controlUserService(action: Action): Promise<ServiceStatus> {
    const s = readServiceInstallation();
    if (!s) {
      if (action === "status" || action === "uninstall") return { ...NOT_INSTALLED };
      fail("尚未安装用户服务；运行 wb service install");
    }
    await ensureManager(s.manager);
    if (action === "status") return status(s);
    if (action === "start" || action === "restart") {
      if (action === "start") { const current = await status(s); if (current.healthy) return current; }
      return start(s, action === "restart");
    }
    await stop(s, action === "uninstall");
    if (action === "stop") return status(s);
    // Revalidate ownership after external commands, before removing either file.
    readServiceInstallation();
    fs.unlinkSync(s.definitionPath);
    if (s.manager === "systemd") {
      try {
        await checked(s.manager, ["daemon-reload"]);
      } catch (error) {
        // Keep an owned, stopped installation diagnosable and uninstallable on retry.
        // Exclusive creation never overwrites a file another actor created meanwhile.
        try { fs.writeFileSync(s.definitionPath, definition(s), { flag: "wx", mode: s.proxyEnv ? 0o600 : 0o644 }); }
        catch (restoreError) { fail(`${error instanceof Error ? error.message : String(error)}\n恢复已停用的服务定义失败: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`); }
        throw error;
      }
    }
    fs.unlinkSync(configPath);
    return { ...NOT_INSTALLED };
  }
  return { readServiceInstallation, installUserService, controlUserService };
}
export function readServiceInstallation(): ServiceInstallation | null { return createUserServiceManager().readServiceInstallation(); }
export function installUserService(options: { port?: number } = {}): Promise<ServiceStatus> { return createUserServiceManager().installUserService(options); }
export function controlUserService(action: Action): Promise<ServiceStatus> { return createUserServiceManager().controlUserService(action); }
