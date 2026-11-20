import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  hubLogPath,
  readDaemonInfo,
  readHubConfig,
  removeDaemonInfo,
  resolveHubDir,
} from "../hub/registry.ts";
import type { DaemonInfo } from "../hub/types.ts";
import { getLocalHubJson } from "./hub_http.ts";

const DEFAULT_HUB_PORT = 4318;
const DEFAULT_HUB_HOST = "127.0.0.1";
const MAX_HUB_LOG_BYTES = 5 * 1024 * 1024;

function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function isDaemonHealthy(info: DaemonInfo, hubDir = resolveHubDir()): Promise<boolean> {
  if (!isPidAlive(info.pid)) return false;
  try {
    const host = info.hostname ?? new URL(info.url).hostname;
    const body = await getLocalHubJson(host, info.port, "/api/health", hubDir, AbortSignal.timeout(800)) as { ok?: boolean; serverPid?: number };
    return body.ok === true && (body.serverPid === undefined || body.serverPid === info.pid);
  } catch {
    return false;
  }
}

export async function getDaemonStatus(): Promise<{
  running: boolean;
  info: DaemonInfo | null;
  projectsCount: number;
  activeProjectId: string | null;
}> {
  const cfg = readHubConfig();
  const info = readDaemonInfo();
  const running = info ? await isDaemonHealthy(info) : false;
  if (info && !running && !isPidAlive(info.pid)) {
    removeDaemonInfo(info.pid);
  }
  return {
    running,
    info: running ? info : null,
    projectsCount: cfg.projects.length,
    activeProjectId: cfg.activeProjectId,
  };
}

export async function startDaemon(options: {
  port?: number;
  hostname?: string;
  cliEntryPath?: string;
  registerRoot?: string;
} = {}): Promise<{ started: boolean; info: DaemonInfo }> {
  const existing = readDaemonInfo();
  if (existing && (await isDaemonHealthy(existing))) {
    return { started: false, info: existing };
  }
  if (existing && !isPidAlive(existing.pid)) {
    removeDaemonInfo(existing.pid);
  }

  const hubDir = resolveHubDir();
  fs.mkdirSync(hubDir, { recursive: true, mode: 0o700 });
  const logFile = hubLogPath();
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_HUB_LOG_BYTES) {
      fs.writeFileSync(logFile, "");
    }
  } catch {
    // Ignore log rotate errors.
  }

  const outFd = fs.openSync(logFile, "a", 0o600);
  const cliEntry = options.cliEntryPath ?? path.resolve(import.meta.dir, "./index.ts");
  const port = options.port ?? DEFAULT_HUB_PORT;
  const hostname = options.hostname ?? DEFAULT_HUB_HOST;

  const args = ["run", cliEntry, "serve", "--hub", "--port", String(port), "--host", hostname];
  if (options.registerRoot) {
    args.push("--root", options.registerRoot);
  }

  const child = spawn("bun", args, {
    cwd: path.resolve(cliEntry, "../../.."),
    detached: true,
    stdio: ["ignore", outFd, outFd],
    env: process.env,
  });
  child.unref();
  fs.closeSync(outFd);

  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    const info = readDaemonInfo();
    if (info && (await isDaemonHealthy(info))) {
      return { started: true, info };
    }
    await delay(80);
  }

  throw new Error(`启动 Workbench Hub 后台守护进程超时，请检查日志: ${logFile}`);
}

export async function stopDaemon(): Promise<{ stopped: boolean; pid: number | null }> {
  const info = readDaemonInfo();
  if (!info) return { stopped: false, pid: null };
  if (!isPidAlive(info.pid)) {
    removeDaemonInfo(info.pid);
    return { stopped: false, pid: info.pid };
  }
  const parentHubPid = Number(process.env.WORKBENCH_HUB_PID);
  if (
    info.managedService === true ||
    info.pid === process.pid ||
    info.pid === process.ppid ||
    (Number.isSafeInteger(parentHubPid) && parentHubPid > 0 && info.pid === parentHubPid)
  ) {
    return { stopped: false, pid: info.pid };
  }

  try {
    process.kill(info.pid, "SIGTERM");
  } catch {
    removeDaemonInfo(info.pid);
    return { stopped: false, pid: info.pid };
  }

  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (!isPidAlive(info.pid)) {
      removeDaemonInfo(info.pid);
      return { stopped: true, pid: info.pid };
    }
    await delay(60);
  }

  try {
    process.kill(info.pid, "SIGKILL");
  } catch {
    // Already dead.
  }
  removeDaemonInfo(info.pid);
  return { stopped: true, pid: info.pid };
}

export function openUrlInBrowser(url: string): void {
  try {
    if (process.platform === "linux" && fs.existsSync("/mnt/c/Windows/System32/cmd.exe")) {
      spawn("/mnt/c/Windows/System32/cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // Ignore browser launch error; URL is still printed cleanly.
  }
}

/** Human-reachable LAN URL for wildcard binds; null for loopback/specific binds. */
export function lanUrlFor(hostname: string, port: number): string | null {
  if (hostname !== "0.0.0.0" && hostname !== "::") return null;
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return `http://${address.address}:${port}`;
    }
  }
  return null;
}
