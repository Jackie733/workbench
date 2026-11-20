#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveHubBindAddress } from "../src/cli/hub_http.ts";
import { assertPortAvailable, createUserServiceManager, readServiceInstallation } from "../src/cli/service.ts";
import { resolveHubDir } from "../src/hub/registry.ts";

const SOURCE_ROOT = fs.realpathSync(path.resolve(import.meta.dir, ".."));

function parseArgs(args: string[]): { port?: number; host?: string } {
  let port: number | undefined;
  let host: string | undefined;
  let portSupplied = false;
  let hostSupplied = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--port" && !portSupplied) {
      const value = args[++i];
      if (!value || !/^\d+$/.test(value)) throw new Error("--port requires an integer from 1 to 65535");
      port = Number(value);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw new Error("--port requires an integer from 1 to 65535");
      }
      portSupplied = true;
    } else if (arg === "--host" && !hostSupplied) {
      const value = args[++i]?.trim();
      if (!value || value.startsWith("-") || value.length > 253 || !/^[A-Za-z0-9.[\]:-]+$/.test(value)) {
        throw new Error("--host requires a bind address (e.g. 127.0.0.1, 0.0.0.0 or a LAN address)");
      }
      host = value;
      hostSupplied = true;
    } else {
      throw new Error(`Unknown or repeated argument: ${arg}. Usage: bun run deploy [--port 4318] [--host 127.0.0.1]`);
    }
  }
  return { port, host };
}

async function runBun(bunPath: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  console.log(`\n> ${JSON.stringify([bunPath, ...args])}`);
  const child = Bun.spawn([bunPath, ...args], {
    cwd: SOURCE_ROOT,
    env,
    signal,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`Bun ${args[0]} failed (exit ${code}); see original output above.`);
}

async function withDeployLock(hubDir: string, run: (signal: AbortSignal) => Promise<void>): Promise<void> {
  fs.mkdirSync(hubDir, { recursive: true, mode: 0o700 });
  const lock = path.join(hubDir, "deploy.lock");
  let fd: number;
  try { fd = fs.openSync(lock, "wx", 0o600); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Do not follow links or block opening a non-regular file in a damaged namespace.
    let pid = "unknown";
    try {
      const existing = fs.openSync(lock, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        if (fs.fstatSync(existing).isFile()) {
          const buf = Buffer.alloc(32);
          const text = buf.subarray(0, fs.readSync(existing, buf)).toString().trim();
          if (/^[1-9]\d*$/.test(text)) pid = text;
        }
      } finally { fs.closeSync(existing); }
    } catch { /* A concurrent owner may just have removed it. */ }
    throw new Error(`Deployment lock ${lock} exists (PID ${pid}). Verify the owner before removing a stale lock.`);
  }
  const owner = fs.fstatSync(fd);
  const abort = new AbortController();
  const interrupt = () => abort.abort(new Error("Deployment interrupted"));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    fs.writeFileSync(fd, `${process.pid}\n`);
    return await run(abort.signal);
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    try {
      const current = fs.lstatSync(lock, { throwIfNoEntry: false });
      if (current?.dev === owner.dev && current.ino === owner.ino) fs.unlinkSync(lock);
    } finally { fs.closeSync(fd); }
  }
}

async function deployLocked(requested: { port?: number; host?: string }, signal: AbortSignal): Promise<void> {
  const existing = readServiceInstallation();
  const port = requested.port ?? existing?.port ?? 4318;
  const host = requested.host ?? existing?.host;
  const bindHost = host ?? "127.0.0.1";
  if (requested.host) await resolveHubBindAddress(bindHost);
  const env = { ...process.env };
  if (existing) {
    for (const key of Object.keys(env)) {
      if (/^(https?|all|no)_proxy$/i.test(key)) delete env[key];
    }
    Object.assign(env, existing.proxyEnv, { PATH: existing.path });
  }
  console.log(`Platform: ${process.platform}/${process.arch}${process.env.WSL_DISTRO_NAME ? ` (WSL: ${process.env.WSL_DISTRO_NAME})` : ""}`);
  console.log(`Source: ${SOURCE_ROOT}`);
  console.log(`Scope: install this checkout's dependencies, link wb for this user, and install/start a user service on ${bindHost}:${port}.`);
  console.log("No Git pull, system upgrades, CLI authentication changes, data deletion, sudo, or linger configuration.");
  console.log("Keep this source directory and Bun executable in place. Deployment stops an existing Hub before refreshing its dependencies.");

  if (typeof Bun === "undefined") throw new Error("Run this script with Bun (current stable recommended).");
  const bunPath = fs.realpathSync(existing?.bunPath ?? process.execPath);
  fs.accessSync(bunPath, fs.constants.R_OK | fs.constants.X_OK);
  console.log(`Bun: ${Bun.version} (${bunPath})`);

  const home = process.env.HOME;
  if (!home || !path.isAbsolute(home) || !fs.statSync(home).isDirectory()) {
    throw new Error("HOME must identify this user's existing absolute home directory.");
  }
  fs.accessSync(home, fs.constants.R_OK | fs.constants.X_OK);
  const gitVersion = execFileSync("git", ["--version"], {
    env,
    cwd: SOURCE_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    timeout: 15_000,
  }).trim();
  console.log(`Git: ${gitVersion}`);

  for (const relative of [
    "package.json", "bun.lock", "src/cli/index.ts", "src/cli/service.ts",
    "src/server/index.ts", "src/mcp/server.ts", "src/web/index.html", "src/web/app.tsx", "src/web/styles.css",
  ]) {
    const file = path.join(SOURCE_ROOT, relative);
    fs.accessSync(file, fs.constants.R_OK);
    if (!fs.statSync(file).isFile()) throw new Error(`Incomplete source checkout: ${relative} is not a file.`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, "package.json"), "utf8")) as { name?: string; bin?: { wb?: string } };
  if (manifest.name !== "workbench" || manifest.bin?.wb !== "./src/cli/index.ts") {
    throw new Error("Source checkout does not contain the expected Workbench package and CLI entry point.");
  }

  // A new port can be tested while the old Hub is still serving. Installation checks again.
  if (existing && port !== existing.port) await assertPortAvailable(port, bindHost);

  const service = createUserServiceManager({ env, execPath: bunPath });
  const stopHub = existing ? async () => { await service.controlUserService("stop"); } : undefined;
  const installHubDependencies = async () => {
    console.log("\nInstalling locked production dependencies. If Bun cannot read the lockfile, upgrade Bun; do not delete the lockfile.");
    await runBun(bunPath, ["install", "--production", "--frozen-lockfile"], env, signal);
  };
  const linkHub = async () => {
    await runBun(bunPath, ["link"], env, signal);
  };
  const startHub = async () => {
    signal.throwIfAborted();
    const status = await service.installUserService({ port, host });
    if (!status.installed || !status.active || !status.healthy) {
      throw new Error("Hub user service is not installed, active and healthy. Inspect wb service status.");
    }
    console.log(`\nHub ready: ${status.url}`);
  };
  signal.throwIfAborted();
  await stopHub?.();
  await installHubDependencies();
  await linkHub();
  await startHub();
  console.log("Next: wb service status, then bun run deploy:check --root <initialized-project-absolute-path>.");
}

export async function deploy(args: string[]): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("User services require macOS or Linux. On Windows use systemd-enabled WSL2; see docs/DEPLOYMENT.md.");
  }
  const requested = parseArgs(args);
  const hubDir = resolveHubDir();
  await withDeployLock(hubDir, (signal) => deployLocked(requested, signal));
}

if (import.meta.main) {
  await deploy(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`Deployment failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
