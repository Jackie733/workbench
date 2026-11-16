#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { installUserService } from "../src/cli/service.ts";

const SOURCE_ROOT = path.resolve(import.meta.dir, "..");

function parsePort(args: string[]): number {
  let port = 4318;
  let supplied = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg !== "--port" || supplied) {
      throw new Error(`Unknown or repeated argument: ${arg}. Usage: bun run deploy [--port 4318]`);
    }
    const value = args[++i];
    if (!value || !/^\d+$/.test(value)) throw new Error("--port requires an integer from 1 to 65535");
    port = Number(value);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new Error("--port requires an integer from 1 to 65535");
    }
    supplied = true;
  }
  return port;
}

async function runBun(bunPath: string, args: string[]): Promise<void> {
  console.log(`\n> ${JSON.stringify([bunPath, ...args])}`);
  const child = Bun.spawn([bunPath, ...args], {
    cwd: SOURCE_ROOT,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`Bun ${args[0]} failed (exit ${code}); see original output above.`);
}

export async function deploy(args: string[]): Promise<void> {
  const port = parsePort(args);
  console.log(`Platform: ${process.platform}/${process.arch}${process.env.WSL_DISTRO_NAME ? ` (WSL: ${process.env.WSL_DISTRO_NAME})` : ""}`);
  console.log(`Source: ${SOURCE_ROOT}`);
  console.log(`Scope: install this checkout's dependencies, link wb for this user, and install/start a loopback-only user service on port ${port}.`);
  console.log("No Git pull, system upgrades, CLI authentication changes, data deletion, sudo, or linger configuration.");
  console.log("Keep this source directory and Bun executable in place. Stop the service before updating source; changed installation settings restart it and interrupt running tasks.");

  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("User services require macOS or Linux. On Windows, run deployment inside a systemd-enabled WSL2 distribution; see docs/DEPLOYMENT.md.");
  }
  if (typeof Bun === "undefined") throw new Error("Run this script with Bun (current stable recommended).");
  const bunPath = fs.realpathSync(process.execPath);
  fs.accessSync(bunPath, fs.constants.R_OK | fs.constants.X_OK);
  console.log(`Bun: ${Bun.version} (${bunPath})`);

  const home = process.env.HOME;
  if (!home || !path.isAbsolute(home) || !fs.statSync(home).isDirectory()) {
    throw new Error("HOME must identify this user's existing absolute home directory.");
  }
  fs.accessSync(home, fs.constants.R_OK | fs.constants.X_OK);
  const gitVersion = execFileSync("git", ["--version"], {
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

  console.log("\nInstalling locked dependencies. If this Bun cannot read the frozen lockfile format, upgrade Bun; do not delete the lockfile.");
  await runBun(bunPath, ["install", "--frozen-lockfile"]);
  await runBun(bunPath, ["link"]);
  console.log("\nInstalling/starting the user service (the service manager must be available in this user's login session)...");
  const status = await installUserService({ port });
  console.log(JSON.stringify(status, null, 2));
  if (!status.installed || !status.active || !status.healthy) {
    throw new Error("Deployment did not produce an installed, active, healthy user service. Inspect wb service status; no detached fallback was started.");
  }
  console.log(`\nHub ready: ${status.url}`);
  console.log("Next: wb service status, then bun run deploy:check --root <initialized-project-absolute-path>.");
  console.log("Uninstall only the service with: wb service uninstall (project data, Hub data, and authentication are retained).");
}

if (import.meta.main) {
  await deploy(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`Deployment failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
