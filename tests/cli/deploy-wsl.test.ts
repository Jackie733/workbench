import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkoutGit, createWslTransport, deployWsl, prepareWslRelease, readDeployTarget, verifyWslRelease, withDeployLock, type WslTransport } from "../../scripts/deploy-wsl.ts";
import { createUserServiceManager } from "../../src/cli/service.ts";
import type { RemoteNodeInfo } from "../../src/hub/types.ts";
import { createSessionVerifier, resetAuthPassword } from "../../src/server/auth.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture() {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wb-deploy-test-")));
  dirs.push(parent);
  const hub = path.join(parent, "Hub checkout");
  const node = path.join(parent, "WSL checkout");
  const hubDir = path.join(parent, "Hub data");
  const nodeHubDir = path.join(parent, "WSL data");
  const bin = path.join(parent, "fake path");
  const calls = path.join(parent, "calls.txt");
  for (const dir of [path.join(hub, "src/cli"), hubDir, nodeHubDir, bin]) fs.mkdirSync(dir, { recursive: true });
  git(hub, "init", "-q");
  fs.writeFileSync(path.join(hub, "src/cli/index.ts"), "// installed CLI\n");
  fs.writeFileSync(path.join(hub, ".gitignore"), "local-only\n");
  fs.writeFileSync(path.join(hub, "package.json"), '{"version":"1.0.0"}\n');
  git(hub, "add", ".");
  git(hub, "commit", "-qm", "initial");
  const previous = git(hub, "rev-parse", "HEAD");
  git(parent, "clone", "-q", hub, node);
  // Several independently framed base64 chunks; this data is deliberately incompressible.
  fs.writeFileSync(path.join(hub, "new source.bin"), randomBytes(150_000));
  git(hub, "add", ".");
  git(hub, "commit", "-qm", "release");
  const revision = git(hub, "rev-parse", "HEAD");
  const bun = path.join(bin, "installed bun");
  const failInstall = path.join(parent, "fail install");
  const env = { ...process.env, WB_TEST_CALLS: calls, WB_TEST_FAIL_INSTALL: failInstall };
  const status = { installed: true, configured: true, manager: "systemd", serviceId: "workbench-node.service", nodeId: "wsl-ubuntu", active: false, connected: false };
  fs.writeFileSync(bun, `#!/bin/sh\nif [ "$1" = install ]; then echo install >> "$WB_TEST_CALLS"; test ! -f "$WB_TEST_FAIL_INSTALL"; exit $?; fi\necho "node $3" >> "$WB_TEST_CALLS"\nif [ "$3" = start ]; then printf '%s\\n' '${JSON.stringify({ ...status, active: true })}'; else printf '%s\\n' '${JSON.stringify(status)}'; fi\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(bin, "systemctl"), "#!/bin/sh\nif [ \"$2\" = show ]; then printf 'LoadState=loaded\\nActiveState=inactive\\n'; fi\n", { mode: 0o700 });
  fs.writeFileSync(path.join(nodeHubDir, "node-service.json"), JSON.stringify({ id: status.serviceId, bunPath: bun, cliPath: path.join(node, "src/cli/index.ts"), path: `${bin}:${process.env.PATH}` }));
  fs.writeFileSync(path.join(nodeHubDir, "node.json"), JSON.stringify({ schemaVersion: 1, nodeId: status.nodeId, hubUrl: "http://192.0.2.1:4318", token: "not-printed" }));
  const target = { sshHost: "win-work", distro: "Ubuntu", user: "alice", nodeId: status.nodeId, nodeHubDir };
  const transport = createWslTransport(target, env, ["/bin/bash", "-s"]);
  return { hub, node, hubDir, target, previous, revision, transport, failInstall, calls };
}

const signal = new AbortController().signal;

test("transfers a verified incremental bundle into a checkout with spaces without updating the worktree", async () => {
  const { hub, node, previous, revision, transport, calls } = fixture();
  const local = checkoutGit(hub, process.env);
  await prepareWslRelease(local, await transport("probe", {}), local.checkout(), transport, signal);
  expect(git(node, "rev-parse", "FETCH_HEAD")).toBe(revision);
  expect(git(node, "rev-parse", "HEAD")).toBe(previous);
  expect(fs.existsSync(path.join(node, "new source.bin"))).toBe(false);
  expect(fs.readFileSync(calls, "utf8")).not.toMatch(/node (stop|start)/);
});

test("rejects dirty checkouts, diverged revisions and a pending merge without stopping the node", async () => {
  const { hub, node, previous, revision, transport, calls } = fixture();
  const dirty = path.join(node, "untracked.txt");
  fs.writeFileSync(dirty, "local edits");
  await expect(transport("probe", {})).rejects.toThrow("Dirty Git checkout");
  fs.unlinkSync(dirty);
  fs.writeFileSync(path.join(node, ".git/MERGE_HEAD"), previous + "\n");
  await expect(transport("probe", {})).rejects.toThrow("Git operation in progress");
  fs.unlinkSync(path.join(node, ".git/MERGE_HEAD"));
  fs.writeFileSync(path.join(node, "branch.txt"), "diverged");
  git(node, "add", ".");
  git(node, "commit", "-qm", "diverged");
  git(hub, "fetch", node, "HEAD");
  await expect(prepareWslRelease(checkoutGit(hub, process.env), await transport("probe", {}), revision, transport, signal)).rejects.toThrow("not a proven ancestor");
  expect(fs.readFileSync(calls, "utf8")).not.toMatch(/node (stop|start)/);
});

test("rejects a corrupted bundle and a colliding ignored file before stopping the node", async () => {
  const { hub, node, previous, transport, calls } = fixture();
  const local = checkoutGit(hub, process.env);
  const corrupt: WslTransport = async (phase, data, options) => transport(phase, { ...data, sha256: "0".repeat(64) }, options);
  await expect(prepareWslRelease(local, await transport("probe", {}), local.checkout(), corrupt, signal)).rejects.toThrow("SHA-256 mismatch");
  expect(() => git(node, "rev-parse", "--verify", "FETCH_HEAD")).toThrow();

  fs.writeFileSync(path.join(hub, "local-only"), "new tracked source");
  git(hub, "add", "-f", "local-only");
  git(hub, "commit", "-qm", "track previously ignored path");
  fs.writeFileSync(path.join(node, "local-only"), "keep me");
  await expect(prepareWslRelease(local, await transport("probe", {}), local.checkout(), transport, signal)).rejects.toThrow("overlap a local ignored path");
  expect(git(node, "rev-parse", "HEAD")).toBe(previous);
  expect(fs.readFileSync(path.join(node, "local-only"), "utf8")).toBe("keep me");
  expect(fs.readFileSync(calls, "utf8")).not.toMatch(/node (stop|start)/);
});

test("rejects SSH argument injection and excludes concurrent deployments even after failure", async () => {
  const { hubDir, target } = fixture();
  expect(readDeployTarget(hubDir)).toBeNull();
  const config = path.join(hubDir, "deploy-target.json");
  fs.writeFileSync(config, JSON.stringify({ ...target, sshHost: "-oProxyCommand=bad" }));
  expect(() => readDeployTarget(hubDir)).toThrow("sshHost");
  fs.writeFileSync(config, JSON.stringify({ ...target, user: "alice & whoami" }));
  expect(() => readDeployTarget(hubDir)).toThrow("user");
  fs.writeFileSync(config, JSON.stringify(target));
  expect(readDeployTarget(hubDir)).toEqual(target);
  await expect(withDeployLock(hubDir, async () => {
    await expect(withDeployLock(hubDir, async () => { throw new Error("second deployment entered"); })).rejects.toThrow(`PID ${process.pid}`);
    throw new Error("failed phase");
  })).rejects.toThrow("failed phase");
  expect(fs.existsSync(path.join(hubDir, "deploy.lock"))).toBe(false);
});

test("fast-forwards and reinstalls WSL before refreshing Hub, then starts the same node and checks acceptance", async () => {
  const { hub, node, target, previous, revision, transport, calls } = fixture();
  const stages: string[] = [];
  const remote: WslTransport = async (phase, data, options) => {
    stages.push(phase);
    if (phase === "stop") expect(git(node, "rev-parse", "HEAD")).toBe(previous);
    return transport(phase, data, options);
  };
  await deployWsl({
    local: checkoutGit(hub, process.env), nodeId: target.nodeId, remote, signal,
    hubStatus: async () => ({ active: false, healthy: false }),
    readOldNodes: async () => { throw new Error("Stopped Hub must not be queried"); },
    stopHub: async () => {
      expect(git(node, "rev-parse", "HEAD")).toBe(revision);
      expect(fs.readFileSync(calls, "utf8")).toMatch(/node stop\nnode status\ninstall\n$/);
      stages.push("hub stop");
    },
    installHubDependencies: async () => { stages.push("hub install"); },
    linkHub: async () => { stages.push("hub link"); },
    startHub: async () => { stages.push("hub start"); },
    accept: async (runningRevision, remoteRoot) => {
      expect(runningRevision).toBe(revision);
      expect(remoteRoot).toBe(node);
      expect(fs.readFileSync(path.join(node, "new source.bin"))).toEqual(fs.readFileSync(path.join(hub, "new source.bin")));
      stages.push("accept");
    },
  });
  expect(stages).toEqual(["probe", "import", "stop", "update", "hub stop", "hub install", "hub link", "hub start", "start", "accept"]);
});

test("refuses an active task or unobservable active WSL node before stopping either service", async () => {
  const { hub, node, target, revision } = fixture();
  const called: string[] = [];
  const remote: WslTransport = async (phase) => {
    called.push(phase);
    return { root: node, revision, active: true, connected: true, shallow: false };
  };
  const noSwitch = async () => { throw new Error("Effect after failed preflight"); };
  const common = {
    local: checkoutGit(hub, process.env), nodeId: target.nodeId, remote, signal,
    stopHub: noSwitch, installHubDependencies: noSwitch, linkHub: noSwitch, startHub: noSwitch, accept: noSwitch,
  };
  await expect(deployWsl({ ...common, hubStatus: async () => ({ active: false, healthy: false }), readOldNodes: noSwitch }))
    .rejects.toThrow("start the old Hub");
  await expect(deployWsl({
    ...common,
    hubStatus: async () => ({ active: true, healthy: true }),
    readOldNodes: async () => [
      { nodeId: "local", connected: true, activeRuns: [] },
      { nodeId: target.nodeId, connected: true, activeRuns: [{ id: "run-wsl" } as RemoteNodeInfo["activeRuns"][number]] },
    ],
  })).rejects.toThrow(`Active runs on ${target.nodeId}: run-wsl`);
  expect(called).toEqual(["probe", "probe"]);
});

test("accepts only the expected running revisions followed by a successful authenticated WSL browse", async () => {
  const { hubDir, node, target, previous, revision } = fixture();
  resetAuthPassword(hubDir);
  const authenticate = createSessionVerifier(hubDir);
  let stateReads = 0;
  const browses: Array<[string | null, string | null, number]> = [];
  let reportedPath = node;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req) {
      if (!authenticate(req)) return new Response(null, { status: 401 });
      const url = new URL(req.url);
      if (url.pathname === "/api/hub/state") {
        stateReads++;
        return Response.json({ nodes: [
          { nodeId: "local", connected: true, revision, workbenchVersion: "1.0.0" },
          { nodeId: target.nodeId, connected: true, revision: stateReads === 1 ? previous : revision, workbenchVersion: "1.0.0" },
        ] });
      }
      if (url.pathname === "/api/fs/browse") {
        browses.push([url.searchParams.get("node"), url.searchParams.get("path"), stateReads]);
        return Response.json({ currentPath: reportedPath });
      }
      return new Response(null, { status: 404 });
    },
  });
  try {
    const address = { host: "0.0.0.0", port: server.port!, hubDir };
    await verifyWslRelease(address, target.nodeId, revision, node, signal);
    expect(browses).toEqual([[target.nodeId, node, 2]]);
    reportedPath = path.dirname(node);
    await expect(verifyWslRelease(address, target.nodeId, revision, node, signal)).rejects.toThrow("WSL directory probe returned");
  } finally {
    server.stop(true);
  }
});

test("retries frozen dependencies at an already fast-forwarded revision without retransmitting history", async () => {
  const { hub, node, target, revision, transport, failInstall, calls } = fixture();
  fs.writeFileSync(failInstall, "");
  const stages: string[] = [];
  const remote: WslTransport = async (phase, data, options) => {
    stages.push(phase);
    return transport(phase, data, options);
  };
  const options = {
    local: checkoutGit(hub, process.env), nodeId: target.nodeId, remote, signal,
    hubStatus: async () => ({ active: false, healthy: false }),
    readOldNodes: async () => { throw new Error("both services are stopped"); },
    stopHub: async () => { stages.push("hub stop"); },
    installHubDependencies: async () => { stages.push("hub install"); },
    linkHub: async () => { stages.push("hub link"); },
    startHub: async () => { stages.push("hub start"); },
    accept: async () => { stages.push("accept"); },
  };
  await expect(deployWsl(options)).rejects.toThrow(`WSL checkout at ${revision}, node stopped: Bun frozen production install failed`);
  expect(stages).toEqual(["probe", "import", "stop", "update"]);
  expect(git(node, "rev-parse", "HEAD")).toBe(revision);
  fs.unlinkSync(failInstall);
  stages.length = 0;
  await deployWsl(options);
  expect(stages).toEqual(["probe", "stop", "update", "hub stop", "hub install", "hub link", "hub start", "start", "accept"]);
  expect(fs.readFileSync(calls, "utf8").match(/^install$/gm)).toHaveLength(2);
});

test("an occupied replacement port aborts Hub-only and linked deploy before service or SSH commands", async () => {
  const { hubDir, target } = fixture();
  const home = path.join(hubDir, "home");
  const bin = path.join(hubDir, "bin");
  const commandLog = path.join(hubDir, "unexpected-command");
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "linux") throw new Error(`Unsupported test platform: ${platform}`);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"),
    WORKBENCH_HUB_DIR: hubDir, PATH: `${bin}:${process.env.PATH}`, WB_COMMAND_LOG: commandLog };
  for (const command of [platform === "darwin" ? "launchctl" : "systemctl", "ssh"]) {
    fs.writeFileSync(path.join(bin, command), '#!/bin/sh\nprintf "%s\\n" "$0" >> "$WB_COMMAND_LOG"\nexit 1\n', { mode: 0o700 });
  }
  const old = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response("old Hub") });
  const oldPort = old.port!;
  old.stop(true);
  const manager = createUserServiceManager({ env, hubDir, runCommand: async (_command, args) => {
    const starting = args.includes("enable") || args.includes("bootstrap");
    return { exitCode: starting ? 1 : 0, stdout: "", stderr: starting ? "fixture start blocked" : "" };
  } });
  await expect(manager.installUserService({ host: "0.0.0.0", port: oldPort })).rejects.toThrow("fixture start blocked");
  const serving = Bun.serve({ hostname: "0.0.0.0", port: oldPort, fetch: () => new Response("old Hub") });
  const occupied = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response("occupied") });
  try {
    const deploy = path.resolve(import.meta.dir, "../../scripts/deploy.ts");
    for (const linked of [false, true]) {
      if (linked) fs.writeFileSync(path.join(hubDir, "deploy-target.json"), JSON.stringify(target));
      const proc = Bun.spawn([process.execPath, deploy, "--port", String(occupied.port)], { env, stderr: "pipe", stdout: "ignore" });
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect(code).toBe(1);
      expect(stderr).toContain(`端口 0.0.0.0:${occupied.port} 不可用`);
      expect(fs.existsSync(commandLog)).toBe(false);
    }
    expect(await (await fetch(`http://127.0.0.1:${oldPort}`)).text()).toBe("old Hub");
  } finally {
    occupied.stop(true);
    serving.stop(true);
  }
});
