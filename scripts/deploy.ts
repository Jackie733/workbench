#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDaemonHealthy } from "../src/cli/daemon.ts";
import { isLoopbackAddress, resolveHubBindAddress } from "../src/cli/hub_http.ts";
import { assertPortAvailable, createUserServiceManager, readServiceInstallation } from "../src/cli/service.ts";
import { readDaemonInfo, resolveHubDir } from "../src/hub/registry.ts";
import { checkoutGit, createWslTransport, deployWsl, readDeploymentNodes, readDeployTarget, verifyWslRelease, withDeployLock } from "./deploy-wsl.ts";

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

async function deployLocked(requested: { port?: number; host?: string }, hubDir: string, signal: AbortSignal): Promise<void> {
  const target = readDeployTarget(hubDir);
  const existing = readServiceInstallation();
  const port = requested.port ?? existing?.port ?? 4318;
  const host = requested.host ?? existing?.host;
  const bindHost = host ?? "127.0.0.1";
  // Resolve before either side can stop, including host names or IPv6 forms of loopback.
  const address = target || requested.host ? await resolveHubBindAddress(bindHost) : undefined;
  if (target && address && isLoopbackAddress(address)) {
    throw new Error("deploy-target.json requires a LAN-reachable Hub bind address; refusing loopback before stopping either service");
  }
  if (target && existing && fs.realpathSync(existing.cliPath) !== path.join(SOURCE_ROOT, "src/cli/index.ts")) {
    throw new Error("Run deployment from the Hub service's installed source checkout");
  }
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

  if (target) console.log(`WSL target: ${target.sshHost}/${target.distro}/${target.user} (${target.nodeId})`);
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
  if (target) {
    const local = checkoutGit(SOURCE_ROOT, env);
    const remote = createWslTransport(target, env);
    await deployWsl({
      local, remote, nodeId: target.nodeId, signal, stopHub, installHubDependencies, linkHub, startHub,
      hubStatus: async () => {
        const status = await service.controlUserService("status");
        const daemon = !status.active ? readDaemonInfo() : null;
        if (daemon && await isDaemonHealthy(daemon, hubDir)) throw new Error("Unmanaged Hub is running; stop it with wb stop before deploying");
        return status;
      },
      readOldNodes: () => {
        if (!existing) throw new Error("Healthy old Hub has no managed installation record");
        return readDeploymentNodes({ host: existing.host ?? "127.0.0.1", port: existing.port, hubDir },
          AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
      },
      accept: (revision, remoteRoot) => verifyWslRelease({ host: address ?? bindHost, port, hubDir }, target.nodeId, revision, remoteRoot, signal),
    });
  } else {
    signal.throwIfAborted();
    await stopHub?.();
    await installHubDependencies();
    await linkHub();
    await startHub();
    console.log("Next: wb service status, then bun run deploy:check --root <initialized-project-absolute-path>.");
  }
}

export async function deploy(args: string[]): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("User services require macOS or Linux. On Windows use systemd-enabled WSL2; see docs/DEPLOYMENT.md.");
  }
  const requested = parseArgs(args);
  const hubDir = resolveHubDir();
  await withDeployLock(hubDir, (signal) => deployLocked(requested, hubDir, signal));
}

if (import.meta.main) {
  await deploy(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`Deployment failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
