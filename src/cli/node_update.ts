import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteJson, readJsonStrict } from "../core/fs.ts";
import { isGitRevision } from "../core/revision.ts";
import { isRecord } from "../core/validate.ts";
import type { NodeServiceInstallation } from "./node_service.ts";

export const NODE_UPDATE_TIMEOUT_MS = 12 * 60_000;
export type NodeUpdateReport = {
  id: string;
  revision: string;
  phase: "preparing" | "restarting" | "failed";
  startedAt: number;
  checkoutChanged: boolean;
  checkoutRevision?: string;
  root?: string;
  message?: string;
};

class NodeUpdateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeUpdateValidationError";
  }
}

export function formatNodeUpdateFailure(stage: string, error: unknown): string {
  if (error instanceof NodeUpdateValidationError) {
    return `${stage}: ${error.message}`;
  }
  if (error instanceof Error && /^[^\r\n]+ failed \((?:timeout|\d+|unknown)\)$/.test(error.message)) {
    return `${stage} (${error.message}). Inspect the node updater journal for details.`;
  }
  return `${stage}. Inspect the node updater journal for details.`;
}

export function isNodeUpdateId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

export function readUpdateBranch(hubDir: string): string | undefined {
  const file = path.join(hubDir, "node-update.json");
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile()) throw new Error("node-update.json must be a regular file");
  const config = readJsonStrict<unknown>(file, 4096);
  if (!isRecord(config) || Object.keys(config).length !== 1 || typeof config.branch !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(config.branch)) {
    throw new Error('node-update.json must contain only a Git branch, e.g. {"branch":"main"}');
  }
  return config.branch;
}

export function readNodeUpdate(hubDir: string): NodeUpdateReport | undefined {
  const file = path.join(hubDir, "node-update-status.json");
  try { return readJsonStrict<NodeUpdateReport>(file, 8192); } catch { return undefined; }
}

export function nodeUpdateBlocksWork(report: NodeUpdateReport | undefined, runningRevision: string | undefined): boolean {
  if (!report || report.revision === runningRevision) return report?.phase === "preparing" && Date.now() - report.startedAt < NODE_UPDATE_TIMEOUT_MS;
  if (report.checkoutChanged) return true;
  return report.phase !== "failed" && Date.now() - report.startedAt < NODE_UPDATE_TIMEOUT_MS;
}

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout: number }): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(command, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
    if (!error) resolve(stdout);
    else reject(new Error(`${path.basename(command)} failed (${error.killed ? "timeout" : error.code ?? "unknown"})`, { cause: stderr.trim() }));
  });
  return promise;
}

export async function queueNodeUpdate(installation: NodeServiceInstallation, id: string, revision: string, runningRevision: string): Promise<void> {
  if (!isNodeUpdateId(id) || !isGitRevision(revision) || !isGitRevision(runningRevision)) throw new Error("Invalid node update request");
  if (installation.manager !== "systemd" || !readUpdateBranch(installation.hubDir)) throw new Error("This systemd node has not enabled updates");
  const unit = installation.id.replace(/\.service$/, "-update.service");
  const worker = path.join(path.dirname(installation.cliPath), "node_update_worker.ts");
  // A fixed unit provides single-flight execution and survives the node service restart.
  const args = [installation.bunPath, worker, installation.hubDir, id, revision, runningRevision].map((arg) => arg.replaceAll("$", () => "$$"));
  await run("systemd-run", ["--user", "--collect", `--unit=${unit}`, "--property=Type=exec", "--property=RuntimeMaxSec=660s",
    "--", ...args], { timeout: 10_000 });
}

export async function applyNodeUpdate(installation: NodeServiceInstallation, id: string, revision: string, runningRevision: string): Promise<void> {
  if (!isNodeUpdateId(id) || !isGitRevision(revision) || !isGitRevision(runningRevision) || installation.manager !== "systemd") throw new Error("Invalid node update request");
  revision = revision.toLowerCase();
  const statusFile = path.join(installation.hubDir, "node-update-status.json");
  const prior = readNodeUpdate(installation.hubDir);
  const priorCheckoutRevision = prior?.checkoutChanged && prior.revision !== runningRevision
    ? (prior.checkoutRevision ?? prior.revision)
    : undefined;
  const state: NodeUpdateReport = {
    id,
    revision,
    startedAt: Date.now(),
    phase: "preparing",
    checkoutChanged: Boolean(priorCheckoutRevision),
    ...(priorCheckoutRevision ? { checkoutRevision: priorCheckoutRevision } : {}),
  };
  let stage = "Validate installed checkout";
  try {
    atomicWriteJson(statusFile, state, 0o600);
    const branch = readUpdateBranch(installation.hubDir);
    if (!branch) throw new NodeUpdateValidationError("Node updates are not enabled");
    const root = fs.realpathSync(path.resolve(path.dirname(installation.cliPath), "../.."));
    if (fs.realpathSync(installation.cliPath) !== path.join(root, "src/cli/index.ts")) {
      throw new NodeUpdateValidationError("Installed CLI is outside the source checkout");
    }
    state.root = root;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") && !/^(https?|all|no)_proxy$/i.test(key)));
    Object.assign(env, installation.proxyEnv, { PATH: installation.path, HOME: installation.workingDirectory, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" });
    const git = (...args: string[]) => run("git", args, { cwd: root, env, timeout: 120_000 });
    const checkout = async () => {
      if (fs.realpathSync((await git("rev-parse", "--show-toplevel")).trimEnd()) !== root) {
        throw new NodeUpdateValidationError("Installed CLI is not in the root Git checkout");
      }
      for (const name of ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer"]) {
        if (fs.existsSync(path.resolve(root, (await git("rev-parse", "--git-path", name)).trimEnd()))) {
          throw new NodeUpdateValidationError(`Git operation in progress: ${name}`);
        }
      }
      if (await git("status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none")) {
        throw new NodeUpdateValidationError("Git checkout is dirty");
      }
      return (await git("rev-parse", "--verify", "HEAD")).trim();
    };
    const previous = await checkout();
    const canContinue =
      previous === runningRevision
      || previous === revision
      || (priorCheckoutRevision !== undefined && previous === priorCheckoutRevision);
    if (!canContinue) {
      throw new NodeUpdateValidationError(
        `Checkout (${previous.slice(0, 7)}) differs from running source (${runningRevision.slice(0, 7)}); restart the installed node locally`,
      );
    }
    stage = "Fetch configured origin branch without prompts";
    await git("check-ref-format", `refs/heads/${branch}`);
    await git("fetch", "--no-tags", "--no-recurse-submodules", "--refmap=", "origin", `refs/heads/${branch}`);
    const published = (await git("rev-parse", "--verify", "FETCH_HEAD")).trim();
    stage = "Verify target is a published fast-forward";
    if ((await git("rev-parse", "--verify", `${revision}^{commit}`)).trim() !== revision) {
      throw new NodeUpdateValidationError("Requested commit is not available by exact object ID");
    }
    if ((await git("rev-parse", "--is-shallow-repository")).trim() === "true" && previous !== revision) {
      throw new NodeUpdateValidationError("Shallow checkout cannot prove ancestry");
    }
    try {
      await git("merge-base", "--is-ancestor", revision, published);
    } catch {
      throw new NodeUpdateValidationError(`Requested commit ${revision.slice(0, 7)} is not published on origin/${branch}`);
    }
    try {
      await git("merge-base", "--is-ancestor", previous, revision);
    } catch {
      throw new NodeUpdateValidationError(`Target commit ${revision.slice(0, 7)} is not a fast-forward from checkout ${previous.slice(0, 7)}`);
    }
    if (await checkout() !== previous) throw new NodeUpdateValidationError("HEAD changed during update preparation");
    if (previous !== revision) {
      stage = "Fast-forward without overwriting ignored files";
      await git("-c", "submodule.recurse=false", "merge", "--ff-only", "--no-overwrite-ignore", revision);
    }
    state.checkoutChanged = true;
    state.checkoutRevision = revision;
    atomicWriteJson(statusFile, state, 0o600);
    stage = "Install frozen production dependencies";
    await run(installation.bunPath, ["install", "--production", "--frozen-lockfile"], { cwd: root, env, timeout: 420_000 });
    if (await checkout() !== revision) throw new NodeUpdateValidationError("Installed checkout no longer matches requested commit");
    stage = "Restart managed node";
    state.phase = "restarting";
    atomicWriteJson(statusFile, state, 0o600);
    await run("systemctl", ["--user", "restart", installation.id], { env, timeout: 30_000 });
  } catch (error) {
    console.error(stage, error);
    state.phase = "failed";
    state.message = formatNodeUpdateFailure(stage, error);
    atomicWriteJson(statusFile, state, 0o600);
    throw error;
  }
}
