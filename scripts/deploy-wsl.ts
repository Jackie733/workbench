import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { getLocalHubJson } from "../src/cli/hub_http.ts";
import type { ServiceStatus } from "../src/cli/service.ts";
import { isGitRevision } from "../src/core/revision.ts";
import { isRemoteNodeId, LOCAL_NODE_ID } from "../src/hub/registry.ts";
import type { RemoteNodeInfo } from "../src/hub/types.ts";

export interface DeployTarget {
  sshHost: string;
  distro: string;
  user: string;
  nodeId: string;
  nodeHubDir?: string;
}

export function readDeployTarget(hubDir: string): DeployTarget | null {
  const file = path.join(hubDir, "deploy-target.json");
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error(`Deployment target must be a regular file: ${file}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<DeployTarget> | null;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
    const identifiers = ["sshHost", "distro", "user"] as const;
    const allowed = new Set<string>([...identifiers, "nodeId", "nodeHubDir"]);
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) throw new Error(`unknown field ${JSON.stringify(key)}`);
    }
    for (const key of identifiers) {
      if (typeof value[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value[key])) {
        throw new Error(`${key} must start with a letter or digit and contain only letters, digits, dots, underscores and hyphens`);
      }
    }
    if (!isRemoteNodeId(value.nodeId)) throw new Error("nodeId must be a valid non-local node ID");
    if (value.nodeHubDir !== undefined && (typeof value.nodeHubDir !== "string" || !path.posix.isAbsolute(value.nodeHubDir) || /[\x00-\x1f\x7f-\x9f]/.test(value.nodeHubDir) || value.nodeHubDir !== value.nodeHubDir.trim())) {
      throw new Error("nodeHubDir must be an absolute Linux path without control characters or surrounding whitespace");
    }
    return value as DeployTarget;
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function withDeployLock<T>(hubDir: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
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

interface CheckoutGit {
  git(...args: string[]): string;
  checkout(expected?: string): string;
}

export function checkoutGit(sourceRoot: string, env: NodeJS.ProcessEnv): CheckoutGit {
  const gitEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("GIT_")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: sourceRoot, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const checkout = (expected?: string): string => {
    if (fs.realpathSync(git("rev-parse", "--show-toplevel").trimEnd()) !== sourceRoot) {
      throw new Error(`Not a Git checkout root: ${sourceRoot}`);
    }
    for (const name of ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer"]) {
      const marker = git("rev-parse", "--git-path", name).trimEnd();
      if (fs.existsSync(path.resolve(sourceRoot, marker))) throw new Error(`Git operation in progress in ${sourceRoot}: ${name}`);
    }
    if (git("status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none")) throw new Error(`Dirty Git checkout: ${sourceRoot}`);
    const revision = git("rev-parse", "--verify", "HEAD").trim();
    if (!isGitRevision(revision)) throw new Error(`Invalid Git HEAD in ${sourceRoot}`);
    if (expected !== undefined && revision !== expected) throw new Error(`Git HEAD changed in ${sourceRoot}: expected ${expected}, found ${revision}`);
    return revision;
  };
  return { git, checkout };
}

interface WslProbe {
  root: string;
  revision: string;
  active: boolean;
  connected: boolean;
  shallow: boolean;
}

function parseProbe(value: unknown): WslProbe {
  const probe = value as Partial<WslProbe> | null;
  if (!probe || typeof probe.root !== "string" || !path.posix.isAbsolute(probe.root) || /[\x00-\x1f\x7f-\x9f]/.test(probe.root) ||
      !isGitRevision(probe.revision) || typeof probe.active !== "boolean" || typeof probe.connected !== "boolean" || typeof probe.shallow !== "boolean") {
    throw new Error("Invalid WSL probe response");
  }
  return probe as WslProbe;
}

export type WslTransport = (phase: string, data: Record<string, unknown>, options?: { signal?: AbortSignal; body?: AsyncIterable<string> }) => Promise<unknown>;

export function createWslTransport(target: DeployTarget, env: NodeJS.ProcessEnv, command = [
  "ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10",
  target.sshHost, "wsl.exe", "-d", target.distro, "-u", target.user, "--exec", "/bin/bash", "-s",
]): WslTransport {
  const python = fs.readFileSync(path.join(import.meta.dir, "deploy-wsl-remote.py"), "utf8");
  const launcher = "command -v python3 >/dev/null || { echo 'Required executable not found: Python 3 (python3)' >&2; exit 1; }\n"
    + "exec python3 /dev/fd/3 3<<'WB_DEPLOY_PYTHON'\n" + python + "\nWB_DEPLOY_PYTHON\n";
  return async (phase, data, options) => {
    const request = Buffer.from(JSON.stringify({ ...data, phase, nodeId: target.nodeId, nodeHubDir: target.nodeHubDir })).toString("base64");
    const input = async function* () {
      yield launcher;
      yield request + "\n";
      if (options?.body) yield* options.body;
    };
    const deadline = AbortSignal.timeout(phase === "update" || phase === "import" ? 900_000 : 60_000);
    const signal = options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    signal.throwIfAborted();
    const [file, ...args] = command as [string, ...string[]];
    const child = spawn(file, args, { env, stdio: ["pipe", "pipe", "pipe"], signal });
    const { promise, resolve } = Promise.withResolvers<{ code: number | null; error?: Error }>();
    let childError: Error | undefined;
    let stdout = "", stderr = "";
    child.once("error", (error) => { childError = error; });
    child.once("close", (code) => resolve({ code, error: childError }));
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout = (stdout + chunk).slice(-64 * 1024); });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-64 * 1024); });
    const pipe = pipeline(Readable.from(input()), child.stdin).then(() => null, (error: Error) => error);
    const [{ code, error }, inputError] = await Promise.all([promise, pipe]);
    if (error || code !== 0) {
      const unknown = code === 255 || code === null || signal.aborted;
      const detail = stderr.trim() || error?.message || stdout.trim();
      throw new Error(`Windows SSH / WSL ${phase} failed${code === null ? "" : ` (exit ${code})`}${unknown ? "; remote state unknown, retry will probe again" : ""}${detail ? `: ${detail}` : ""}`);
    }
    if (inputError) throw new Error(`WSL ${phase} input failed; remote state unknown, retry will probe again: ${inputError.message}`);
    const result = stdout.split(/\r?\n/).find((line) => line.startsWith("WB_DEPLOY_RESULT "));
    if (!result) throw new Error(`WSL ${phase} returned no result; remote state unknown, retry will probe again`);
    return JSON.parse(result.slice("WB_DEPLOY_RESULT ".length)) as unknown;
  };
}

export async function prepareWslRelease(
  local: CheckoutGit, probeResult: unknown, revision: string, remote: WslTransport, signal: AbortSignal,
) {
  const probe = parseProbe(probeResult);
  const previous = probe.revision;
  if (previous === revision) return probe;
  if (probe.shallow || local.git("rev-parse", "--is-shallow-repository").trim() === "true") {
    throw new Error("Cannot prove a release from different HEADs in shallow checkouts; obtain complete histories and retry");
  }
  try {
    local.git("merge-base", "--is-ancestor", previous, revision);
  } catch {
    throw new Error(`WSL HEAD ${previous} is not a proven ancestor of Hub HEAD ${revision}; check for a fork or missing history`);
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-deploy-"));
  try {
    const bundle = path.join(directory, "release.bundle");
    local.git("bundle", "create", bundle, "HEAD", `^${previous}`);
    if (local.git("bundle", "list-heads", bundle).trimEnd() !== `${revision} HEAD`) {
      throw new Error(`Git bundle HEAD does not match pinned Hub HEAD ${revision}`);
    }
    const hash = new Bun.CryptoHasher("sha256");
    for await (const chunk of fs.createReadStream(bundle, { signal })) hash.update(chunk as Buffer);
    const body = async function* () {
      for await (const chunk of fs.createReadStream(bundle, { highWaterMark: 48 * 1024, signal })) {
        yield (chunk as Buffer).toString("base64") + "\n";
      }
    };
    console.log(`Sending committed Git history ${previous.slice(0, 12)}..${revision.slice(0, 12)} to WSL (no working-tree files).`);
    await remote("import", { root: probe.root, previous, revision, sha256: hash.digest("hex") }, { signal, body: body() });
    return probe;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

type HubNodeState = Pick<RemoteNodeInfo, "nodeId" | "activeRuns" | "connected" | "revision">;

interface WslDeployment {
  local: CheckoutGit;
  nodeId: string;
  remote: WslTransport;
  signal: AbortSignal;
  hubStatus(): Promise<Pick<ServiceStatus, "active" | "healthy">>;
  readOldNodes(): Promise<HubNodeState[]>;
  stopHub?: () => Promise<void>;
  installHubDependencies(): Promise<void>;
  linkHub(): Promise<void>;
  startHub(): Promise<void>;
  accept(revision: string, remoteRoot: string): Promise<void>;
}

export async function deployWsl({
  local, nodeId, remote, signal, hubStatus, readOldNodes, stopHub, installHubDependencies, linkHub, startHub, accept,
}: WslDeployment): Promise<void> {
  let phase = "check Hub checkout";
  const completed: string[] = [];
  const step = async <T>(name: string, action: () => Promise<T>, record = false): Promise<T> => {
    phase = name;
    signal.throwIfAborted();
    const result = await action();
    if (record) {
      completed.push(name);
      console.log(`Completed: ${name}`);
    }
    return result;
  };
  console.log("Maintenance window: do not submit new tasks until deployment completes.");
  try {
    signal.throwIfAborted();
    const revision = local.checkout();
    const probe = parseProbe(await step("probe Windows SSH and WSL installation", () => remote("probe", {}, { signal })));
    await step("prepare WSL Git revision", () => prepareWslRelease(local, probe, revision, remote, signal));
    const release = { root: probe.root, previous: probe.revision, revision };
    const status = await step("check old Hub and node for active runs", hubStatus);
    if (status.active && !status.healthy) throw new Error("Old Hub is active but unhealthy; restore it before deploying");
    if (status.healthy) {
      const nodes = await readOldNodes();
      const here = nodes.find((node) => node.nodeId === LOCAL_NODE_ID);
      const there = nodes.find((node) => node.nodeId === nodeId);
      if (!Array.isArray(here?.activeRuns)) throw new Error("Old Hub did not report local active runs");
      if (there?.connected && !probe.active) {
        throw new Error(`Hub reports ${nodeId} connected while its installed WSL service is stopped; resolve the duplicate or stale connection and retry`);
      }
      if (probe.active && (!probe.connected || !there?.connected || !Array.isArray(there.activeRuns))) {
        throw new Error(`Active node ${nodeId} is not connected to the healthy old Hub; restore pairing/connection and retry`);
      }
      const busy = (there ? [here, there] : [here]).filter((node) => node.activeRuns?.length);
      if (busy.length) throw new Error(`Active runs on ${busy.map((node) => `${node.nodeId}: ${node.activeRuns.map((run) => run.id).join(", ")}`).join("; ")}`);
    } else if (probe.active) {
      throw new Error(`WSL node ${nodeId} is active but the old Hub is stopped; start the old Hub with wb service start and retry after the node connects`);
    }

    phase = "recheck pinned Hub checkout";
    local.checkout(revision);
    await step("stop WSL node", () => remote("stop", { ...release, active: probe.active }, { signal }), true);
    await step("fast-forward WSL and install frozen production dependencies", () => remote("update", release, { signal }), true);
    phase = "recheck pinned Hub checkout before refreshing Hub";
    local.checkout(revision);
    if (stopHub) await step("stop Hub", stopHub, true);
    await step("install frozen Hub production dependencies", installHubDependencies, true);
    await step("link Hub CLI", linkHub, true);
    await step("start and health-check Hub", startHub, true);
    await step("start WSL node", () => remote("start", { ...release, previous: revision }, { signal }), true);
    await step("verify both revisions and WSL directory access", () => accept(revision, probe.root));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${phase}: ${detail}\nCompleted switch steps: ${completed.join("; ") || "none"}.\nFix the failing stage and rerun bun run deploy from the same checkout with the same options. No automatic rollback.`);
  }
}

interface HubDeploymentAddress {
  host: string;
  port: number;
  hubDir: string;
}

export async function readDeploymentNodes({ host, port, hubDir }: HubDeploymentAddress, signal: AbortSignal): Promise<HubNodeState[]> {
  const value = await getLocalHubJson(host, port, "/api/hub/state", hubDir, signal) as { nodes?: HubNodeState[] } | null;
  if (!Array.isArray(value?.nodes) || value.nodes.some((node) => !node || typeof node.nodeId !== "string" || typeof node.connected !== "boolean")) {
    throw new Error("Hub state did not contain a valid nodes list");
  }
  return value.nodes;
}

export async function verifyWslRelease(
  address: HubDeploymentAddress, nodeId: string, revision: string, remoteRoot: string, signal: AbortSignal,
): Promise<void> {
  const deadline = performance.now() + 60_000;
  let local: HubNodeState | undefined;
  let remote: HubNodeState | undefined;
  let lastError: string | undefined;
  for (;;) {
    signal.throwIfAborted();
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) break;
    const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.min(remaining, 5_000))]);
    try {
      const nodes = await readDeploymentNodes(address, probeSignal);
      local = nodes.find((node) => node.nodeId === LOCAL_NODE_ID);
      remote = nodes.find((node) => node.nodeId === nodeId);
      lastError = undefined;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (!lastError && local?.revision === revision && remote?.connected && remote.revision === revision) {
      const query = new URLSearchParams({ node: nodeId, path: remoteRoot });
      const result = await getLocalHubJson(address.host, address.port, `/api/fs/browse?${query}`, address.hubDir,
        AbortSignal.any([signal, AbortSignal.timeout(15_000)])) as { currentPath?: string } | null;
      if (result?.currentPath !== remoteRoot) {
        throw new Error(`WSL directory probe returned ${JSON.stringify(result?.currentPath) ?? "no path"} instead of ${JSON.stringify(remoteRoot)}`);
      }
      console.log(`Hub ${revision.slice(0, 12)}；${nodeId} ${remote.revision.slice(0, 12)}；远程目录读取通过`);
      return;
    }
    await delay(Math.max(0, Math.min(1_000, deadline - performance.now())), undefined, { signal });
  }
  const describe = (node: HubNodeState | undefined) => {
    const reported = isGitRevision(node?.revision) ? node.revision : "unreported";
    return `${node?.connected ? "online" : "offline"}, revision ${reported}`;
  };
  throw new Error(`Timed out waiting for ${revision}: Hub (${describe(local)}); ${nodeId} (${describe(remote)})${lastError ? `; last state request: ${lastError}` : ""}`);
}
