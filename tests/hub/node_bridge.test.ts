import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createNodeServiceManager, defaultNodeIdentity, nodeRuntimePath, readNodeConfig, writeNodeConfig } from "../../src/cli/node_service.ts";
import { HubExecutor } from "../../src/hub/executor.ts";
import { startWorkbenchNodeClient, type NodeClientHandle } from "../../src/hub/node_bridge.ts";
import { readHubConfig, registerHubProject } from "../../src/hub/registry.ts";
import type { HarnessInfo, RemoteNodeInfo } from "../../src/hub/types.ts";
import { resetAuthPassword } from "../../src/server/auth.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";

const tempDirs: string[] = [];
const servers: WorkbenchServerHandle[] = [];
const nodeClients: NodeClientHandle[] = [];
const origHubEnv = process.env.WORKBENCH_HUB_DIR;
const origRsiDepth = process.env.WORKBENCH_RSI_DEPTH;

beforeEach(() => {
  delete process.env.WORKBENCH_RSI_DEPTH;
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return fs.realpathSync(dir);
}

function makeGitRepo(name = "repo"): string {
  const dir = makeTempDir(`wb-${name}-`);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "index.ts"), "export const hello = 'world';\n");
  execFileSync("git", ["add", "index.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function mockHarnesses(): HarnessInfo[] {
  return [
    {
      id: "codex",
      label: "Codex (WSL2)",
      subscription: "Plus",
      installed: true,
      executable: "codex",
      defaultModel: "gpt-6-astra",
      detectedAt: Date.now(),
      models: [{ id: "gpt-6-astra", label: "GPT-6 Astra", tier: "sota", source: "detected" }],
    },
  ];
}

afterEach(() => {
  while (nodeClients.length > 0) nodeClients.pop()!.stop();
  while (servers.length > 0) servers.pop()!.stop();
  if (origHubEnv === undefined) delete process.env.WORKBENCH_HUB_DIR;
  else process.env.WORKBENCH_HUB_DIR = origHubEnv;
  if (origRsiDepth === undefined) delete process.env.WORKBENCH_RSI_DEPTH;
  else process.env.WORKBENCH_RSI_DEPTH = origRsiDepth;
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("cross-machine Hub + outbound remote node bridge (wb node)", () => {
  test("reports startup revisions and rejects unsafe browser update requests", async () => {
    const hubDir = makeTempDir("wb-revisions-");
    process.env.WORKBENCH_HUB_DIR = hubDir;
    const repo = makeGitRepo();
    const server = await startWorkbenchServer({
      root: repo,
      port: 0,
      writeDiscovery: false,
      hubMode: true,
      isRevisionPublished: () => true,
    });
    servers.push(server);
    const client = startWorkbenchNodeClient({
      hubUrl: server.url, token: resetAuthPassword(hubDir).password,
      nodeId: "current", nodeName: "Current", initialHarnesses: mockHarnesses(),
    });
    nodeClients.push(client);
    await client.waitUntilConnected(5_000);
    const readNodes = async () => (await (await fetch(`${server.url}/api/hub/state`)).json() as { nodes: RemoteNodeInfo[] }).nodes;
    const expected = execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: path.resolve(import.meta.dir, "../.."), encoding: "utf8" }).trim();
    const local = (await readNodes()).find((node) => node.isLocal)!;
    expect(local.revision).toBe(expected);
    let current: RemoteNodeInfo | undefined;
    for (let i = 0; i < 100; i++) {
      current = (await readNodes()).find((node) => node.nodeId === "current");
      if (current?.revision !== undefined) break;
      await delay(10);
    }
    expect(current?.revision).toBe(expected);

    const password = resetAuthPassword(hubDir).password;
    const url = new URL("/ws?role=node&nodeId=other", server.url.replace("http", "ws"));
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${password}` } } as unknown as string[]);
    try {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("node WebSocket rejected")), { once: true });
      await promise;
      const different = (expected === "a".repeat(40) ? "b" : "a").repeat(40);
      for (const [name, revision, reported] of [
        ["different", different, different], ["invalid", "1234", undefined], ["legacy", undefined, undefined],
      ]) {
        socket.send(JSON.stringify({ type: "node.hello", name, workbenchVersion: local.workbenchVersion, revision,
          updateEnabled: name === "different", activeRuns: name === "different" ? [{ id: "active-run" }] : [] }));
        let node: RemoteNodeInfo | undefined;
        for (let i = 0; i < 100; i++) {
          node = (await readNodes()).find((entry) => entry.nodeId === "other" && entry.name === name);
          if (node) break;
          await delay(10);
        }
        expect(node?.connected).toBe(true);
        expect(node?.workbenchVersion).toBe(local.workbenchVersion);
        expect(node?.revision).toBe(reported);
        if (name === "different") {
          const start = (origin: string, target: string) => fetch(`${server.url}/api/hub/nodes/other/update`, {
            method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ revision: target }),
          });
          expect((await start("http://foreign.invalid", expected)).status).toBe(403);
          const stale = await start(server.url, different);
          expect(stale.status).toBe(409);
          expect(await stale.text()).toContain("Hub revision changed");
          const busy = await start(server.url, expected);
          expect(busy.status).toBe(409);
          expect(await busy.text()).toContain("active task");
        }
      }
    } finally {
      socket.close();
    }

    const unpublishedServer = await startWorkbenchServer({
      root: repo,
      port: 0,
      writeDiscovery: false,
      hubMode: true,
      isRevisionPublished: () => false,
    });
    servers.push(unpublishedServer);
    const unpubRes = await fetch(`${unpublishedServer.url}/api/hub/nodes/other/update`, {
      method: "POST",
      headers: { Origin: unpublishedServer.url, "Content-Type": "application/json" },
      body: JSON.stringify({ revision: expected }),
    });
    expect(unpubRes.status).toBe(409);
    expect(await unpubRes.text()).toContain("has not been pushed to origin yet");
  });

  test("manages remote project lifecycle, fs browse, attachments, streaming execution, and offline degradation", async () => {
    const hubDir = makeTempDir("wb-hub-node-");
    process.env.WORKBENCH_HUB_DIR = hubDir;

    const localWbRepo = makeGitRepo("wb-main");
    fs.writeFileSync(
      path.join(localWbRepo, "package.json"),
      JSON.stringify({ name: "workbench", version: "5.0.0" }),
    );
    execFileSync("git", ["add", "package.json"], { cwd: localWbRepo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "add pkg"], { cwd: localWbRepo, stdio: "ignore" });

    const remoteRootParent = makeTempDir("wb-wsl-home-");
    const remoteRepo = path.join(remoteRootParent, "work-service");
    fs.mkdirSync(remoteRepo, { recursive: true });
    execFileSync("git", ["init"], { cwd: remoteRepo, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: remoteRepo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: remoteRepo, stdio: "ignore" });
    fs.writeFileSync(path.join(remoteRepo, "app.ts"), "export const ok = true;\n");
    execFileSync("git", ["add", "app.ts"], { cwd: remoteRepo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: remoteRepo, stdio: "ignore" });

    const server = await startWorkbenchServer({
      root: localWbRepo,
      port: 0,
      writeDiscovery: false,
      hubMode: true,
    });
    servers.push(server);

    // Connect UI WebSocket to observe streamed events from the remote node.
    const uiEvents: Array<Record<string, unknown>> = [];
    const uiWs = new WebSocket(`${server.url.replace("http", "ws")}/ws?role=ui`);
    await new Promise<void>((resolve) => uiWs.addEventListener("open", () => resolve()));
    uiWs.addEventListener("message", (ev) => {
      uiEvents.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
    });

    try {
      const { password } = resetAuthPassword(hubDir);

      let syncedLang = "zh-CN";
      const remoteExecutor = new HubExecutor({
        nodeId: "wsl-work",
        initialHarnesses: mockHarnesses(),
        getHubPreferences: () => ({ outputLanguage: syncedLang as "zh-CN" | "en" | "auto" }),
        commandBuilder: (_target, ctx) => {
          const isCrashCase = ctx.prompt.includes("TRIGGER_CRASH");
          const script = isCrashCase
            ? "echo 'fatal error'; exit 139"
            : "echo 'REMOTE_NODE_EXEC_OK'; echo \"LANG=$WORKBENCH_OUTPUT_LANGUAGE\"";
          return {
            command: "bash",
            args: ["-c", script],
            displayCommand: "bash -c mock-remote-agent",
          };
        },
        onTelemetryOutcome: () => {
          // Forwarded by node_bridge test harness below? No — when executor is injected, test explicit client or hook:
        },
      });

      const nodeClient = startWorkbenchNodeClient({
        hubUrl: server.url,
        token: password,
        nodeId: "wsl-work",
        nodeName: "Windows WSL2",
        executor: remoteExecutor,
      });
      nodeClients.push(nodeClient);
      await nodeClient.waitUntilConnected(5_000);

      // 1. Hub state immediately exposes both local and wsl-work nodes + metadata from WS upgrade
      const state1 = (await (await fetch(`${server.url}/api/hub/state`)).json()) as {
        nodes: Array<{ nodeId: string; name: string; connected: boolean; isLocal: boolean; harnesses: HarnessInfo[] }>;
      };
      expect(state1.nodes.some((n) => n.nodeId === "local" && n.isLocal && n.connected)).toBe(true);
      let wslNode = state1.nodes.find((n) => n.nodeId === "wsl-work");
      expect(wslNode?.connected).toBe(true);
      expect(wslNode?.name).toBe("Windows WSL2");
      const helloDeadline = Date.now() + 2_000;
      while ((wslNode?.harnesses.length ?? 0) === 0 && Date.now() < helloDeadline) {
        await delay(20);
        const s = (await (await fetch(`${server.url}/api/hub/state`)).json()) as typeof state1;
        wslNode = s.nodes.find((n) => n.nodeId === "wsl-work");
      }
      expect(wslNode?.harnesses.length).toBeGreaterThan(0);

      // 2. Remote directory browse returns entries from WSL2 directory
      const browseRes = (await (
        await fetch(`${server.url}/api/fs/browse?node=wsl-work&path=${encodeURIComponent(remoteRootParent)}`)
      ).json()) as { currentPath: string; entries: Array<{ name: string; isGitRepo: boolean }> };
      expect(browseRes.currentPath).toBe(remoteRootParent);
      expect(browseRes.entries.some((e) => e.name === "work-service" && e.isGitRepo)).toBe(true);

      // 3. Add remote project with automatic local initialization
      const addRes = await fetch(`${server.url}/api/hub/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          root: remoteRepo,
          name: "work-service",
          nodeId: "wsl-work",
          initPrivacy: "local",
        }),
      });
      expect(addRes.status).toBe(201);
      const added = (await addRes.json()) as {
        project: { id: string; nodeId?: string; nodeName?: string; root: string };
      };
      expect(added.project.nodeId).toBe("wsl-work");
      expect(added.project.nodeName).toBe("Windows WSL2");
      expect(fs.existsSync(path.join(remoteRepo, ".workbench", "project.json"))).toBe(true);

      // Verify remote entry persists in hub.json even across readHubConfig() (never pruned by local fs.existsSync)
      const persistedCfg = readHubConfig();
      const persistedRemote = persistedCfg.projects.find((p) => p.id === added.project.id);
      expect(persistedRemote?.nodeId).toBe("wsl-work");

      // Verify same-path basename on local vs remote does not collide in ID
      const localSameDir = makeTempDir("wb-local-dup-");
      const localDup = path.join(localSameDir, "work-service");
      fs.mkdirSync(localDup);
      const { project: localDupProj } = registerHubProject(localDup, { activate: false });
      expect(localDupProj.id).not.toBe(added.project.id);

      // 4. Upload attachment scoped to remote project, create requirement, and download attachment bytes via proxy
      const form = new FormData();
      form.append("files", new Blob(["remote-attachment-bytes"], { type: "text/plain" }), "notes.txt");
      const upResp = await fetch(`${server.url}/api/uploads?project=${encodeURIComponent(added.project.id)}`, {
        method: "POST",
        body: form,
      });
      expect(upResp.status).toBe(201);
      const upBody = (await upResp.json()) as { attachments: Array<{ id: string }> };
      expect(upBody.attachments).toHaveLength(1);

      const reqCreateResp = await fetch(
        `${server.url}/api/requirements?project=${encodeURIComponent(added.project.id)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            goal: "在 WSL2 远程项目中完成验证",
            attachmentIds: [upBody.attachments[0]!.id],
          }),
        },
      );
      expect(reqCreateResp.status).toBe(201);
      const reqCreated = (await reqCreateResp.json()) as { detail: { state: { id: string } } };
      expect(reqCreated.detail.state.id).toBe("REQ-001");

      // Binary download of attachment over WS RPC proxy
      const attDownload = await fetch(
        `${server.url}/api/requirements/REQ-001/attachments/${encodeURIComponent(upBody.attachments[0]!.id)}?project=${encodeURIComponent(added.project.id)}`,
      );
      expect(attDownload.status).toBe(200);
      expect(await attDownload.text()).toBe("remote-attachment-bytes");

      // 5. Run agent on remote project and verify real-time WS streamed output reaches UI
      const runResp = await fetch(
        `${server.url}/api/requirements/REQ-001/run?project=${encodeURIComponent(added.project.id)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "design", harness: "codex", model: "gpt-6-astra" }),
        },
      );
      expect(runResp.status).toBe(202);
      const runStarted = (await runResp.json()) as { run: { id: string } };

      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (uiEvents.some((e) => e.type === "agent.run.finished" && e.runId === runStarted.run.id)) break;
        await delay(40);
      }
      const chunks = uiEvents
        .filter((e) => e.type === "agent.run.output" && e.runId === runStarted.run.id)
        .map((e) => String(e.chunk ?? ""))
        .join("");
      expect(chunks).toContain("REMOTE_NODE_EXEC_OK");
      expect(chunks).toContain("LANG=zh-CN");

      // 6. Fast-track REQ-001 past design gate, then run verification on remote project
      const fastTrackResp = await fetch(
        `${server.url}/api/requirements/REQ-001/fast-track?project=${encodeURIComponent(added.project.id)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      expect(fastTrackResp.status).toBe(200);

      const verifyResp = await fetch(
        `${server.url}/api/requirements/REQ-001/verify?project=${encodeURIComponent(added.project.id)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: "echo verify-wsl2-ok", criterionIds: [] }),
        },
      );
      expect(verifyResp.status).toBe(200);
      const verified = (await verifyResp.json()) as { runs: Array<{ passed: boolean; outputPreview: string }> };
      expect(verified.runs[0]?.passed).toBe(true);
      expect(verified.runs[0]?.outputPreview).toContain("verify-wsl2-ok");

      // 7. Disconnecting node surfaces clean offline status without dropping hub.json project
      nodeClient.stop();
      await delay(60);

      const offlineState = (await (await fetch(`${server.url}/api/hub/state`)).json()) as {
        projects: Array<{ id: string; nodeOnline?: boolean }>;
      };
      const projAfter = offlineState.projects.find((p) => p.id === added.project.id);
      expect(projAfter?.nodeOnline).toBe(false);

      const offlineProjResp = await fetch(
        `${server.url}/api/project?project=${encodeURIComponent(added.project.id)}`,
      );
      expect(offlineProjResp.status).toBe(500);
      const offlineErr = (await offlineProjResp.json()) as { error: { message: string } };
      expect(offlineErr.error.message).toContain("不在线");
    } finally {
      uiWs.close();
    }
  });

  test("LAN authentication protects non-loopback hosts while keeping Bearer token access for wb node", async () => {
    const hubDir = makeTempDir("wb-hub-auth-");
    process.env.WORKBENCH_HUB_DIR = hubDir;
    const repo = makeGitRepo("auth-repo");

    const server = await startWorkbenchServer({
      root: repo,
      port: 0,
      hostname: "0.0.0.0",
      writeDiscovery: false,
      hubMode: true,
    });
    servers.push(server);

    const { password } = resetAuthPassword(hubDir);
    const localBase = `http://127.0.0.1:${server.port}`;

    // Local Host header passes automatically
    const localAuth = (await (await fetch(`${localBase}/api/auth/status`)).json()) as {
      required: boolean;
      authenticated: boolean;
    };
    expect(localAuth.required).toBe(false);
    expect(localAuth.authenticated).toBe(true);

    // Non-loopback Host header (e.g. LAN / DNS rebinding) requires authentication
    const lanUnauthed = await fetch(`${localBase}/api/hub/state`, {
      headers: { Host: "192.168.1.10:4318" },
    });
    expect(lanUnauthed.status).toBe(401);

    // Bearer password grants access (as used by wb node)
    const bearerAuthed = await fetch(`${localBase}/api/hub/state`, {
      headers: { Host: "192.168.1.10:4318", Authorization: `Bearer ${password}` },
    });
    expect(bearerAuthed.status).toBe(200);

    // Cookie login succeeds with right password and fails with wrong password
    const badLogin = await fetch(`${localBase}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "192.168.1.10:4318" },
      body: JSON.stringify({ password: "wrong" }),
    });
    expect(badLogin.status).toBe(401);

    const goodLogin = await fetch(`${localBase}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "192.168.1.10:4318" },
      body: JSON.stringify({ password }),
    });
    expect(goodLogin.status).toBe(200);
    const setCookie = goodLogin.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("wb_session=");
    const cookiePair = setCookie.split(";")[0]!;

    const cookieAuthed = await fetch(`${localBase}/api/hub/state`, {
      headers: { Host: "192.168.1.10:4318", Cookie: cookiePair },
    });
    expect(cookieAuthed.status).toBe(200);
  });

  test("wb node service stores secret token privately in node.json and never leaks it to systemd unit", async () => {
    const root = makeTempDir("wb-node-svc-");
    const home = path.join(root, "home");
    const hubDir = path.join(root, "hub");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(hubDir, { recursive: true });

    const calls: Array<{ command: string; args: string[] }> = [];
    let active = false;
    const mgr = createNodeServiceManager({
      platform: "linux",
      home,
      hubDir,
      connectTimeoutMs: 50,
      env: { HOME: home, PATH: "/usr/bin:/bin", WSL_DISTRO_NAME: "Ubuntu-Work" },
      runCommand: async (command, args) => {
        calls.push({ command, args: [...args] });
        if (args[1] === "show-environment") return { exitCode: 0, stdout: "", stderr: "" };
        if (args[1] === "show") {
          return {
            exitCode: 0,
            stdout: `LoadState=loaded\nActiveState=${active ? "active" : "inactive"}\nMainPID=${active ? process.pid : 0}\n`,
            stderr: "",
          };
        }
        if (args[1] === "enable") active = true;
        if (args[1] === "stop" || args[1] === "disable") active = false;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const defaults = defaultNodeIdentity({ WSL_DISTRO_NAME: "Ubuntu-Work" });
    expect(defaults.nodeId).toBe("wsl-ubuntu-work");
    expect(defaults.nodeName).toContain("Ubuntu-Work");

    const secretToken = "super-secret-hub-password";
    const status = await mgr.installService({
      schemaVersion: 1,
      hubUrl: "http://192.168.1.50:4318",
      token: secretToken,
      nodeId: "wsl-work",
      nodeName: "Windows WSL2",
    });

    expect(status.installed).toBe(true);
    expect(status.active).toBe(true);
    expect(status.nodeId).toBe("wsl-work");
    expect(readNodeConfig(hubDir)?.token).toBe(secretToken);

    const installation = mgr.readInstallation()!;
    const unitText = fs.readFileSync(installation.definitionPath, "utf8");
    expect(unitText).toContain('"node" "connect"');
    expect(unitText).not.toContain(secretToken);
    expect(fs.statSync(path.join(hubDir, "node.json")).mode & 0o777).toBe(0o600);

    const newToken = "rotated-password";
    const mockHub = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname !== "/api/health") return new Response(null, { status: 404 });
        if (req.headers.get("authorization") !== `Bearer ${newToken}`) return new Response(null, { status: 401 });
        return Response.json({ ok: true, hubMode: true });
      },
    });
    try {
      const saved = writeNodeConfig({ ...readNodeConfig(hubDir)!, hubUrl: `ws://127.0.0.1:${mockHub.port}` }, hubDir);
      const callsBeforeReconnect = calls.length;
      await expect(mgr.reconnect(async () => "wrong-password")).rejects.toThrow("Hub 拒绝了访问密码");
      expect(readNodeConfig(hubDir)).toEqual(saved);
      expect(calls).toHaveLength(callsBeforeReconnect);

      await mgr.reconnect(async () => newToken);
      expect(readNodeConfig(hubDir)).toEqual({ ...saved, token: newToken });
      expect(fs.readFileSync(installation.definitionPath, "utf8")).toBe(unitText);
      expect(calls.slice(callsBeforeReconnect).map(({ args }) => args[1]).filter((arg) => arg !== "show"))
        .toEqual(["show-environment", "restart"]);

      fs.writeFileSync(nodeRuntimePath(hubDir), JSON.stringify({ nodeId: saved.nodeId, pid: process.pid, connected: true }));
      const callsBeforeOnline = calls.length;
      const online = await mgr.reconnect(async () => { throw new Error("already connected"); });
      expect(online.connected).toBe(true);
      expect(calls.slice(callsBeforeOnline).map(({ args }) => args[1])).toEqual(["show"]);
    } finally {
      fs.rmSync(nodeRuntimePath(hubDir), { force: true });
      await mockHub.stop(true);
    }

    // Uninstall removes unit and node-service.json cleanly
    const uninstalled = await mgr.controlService("uninstall");
    expect(uninstalled.installed).toBe(false);
    expect(fs.existsSync(installation.definitionPath)).toBe(false);
    // node.json can also be rewritten cleanly
    writeNodeConfig({ schemaVersion: 1, hubUrl: "http://192.168.1.50:4318", nodeId: "wsl-work", nodeName: "WSL" }, hubDir);
    expect(readNodeConfig(hubDir)?.nodeName).toBe("WSL");

    // Refuses to overwrite unknown or symlinked service definitions and rejects relative XDG_CONFIG_HOME
    fs.mkdirSync(path.dirname(installation.definitionPath), { recursive: true });
    fs.writeFileSync(installation.definitionPath, "[Unit]\nDescription=Foreign\n");
    await expect(
      mgr.installService({
        schemaVersion: 1,
        hubUrl: "http://192.168.1.50:4318",
        token: secretToken,
        nodeId: "wsl-work",
        nodeName: "Windows WSL2",
      }),
    ).rejects.toThrow("拒绝覆盖未知节点服务定义");
    fs.rmSync(installation.definitionPath, { force: true });

    const relXdgMgr = createNodeServiceManager({
      platform: "linux",
      home,
      hubDir,
      connectTimeoutMs: 50,
      env: { HOME: home, PATH: "/usr/bin:/bin", XDG_CONFIG_HOME: "relative/config" },
      runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    await expect(
      relXdgMgr.installService({
        schemaVersion: 1,
        hubUrl: "http://192.168.1.50:4318",
        nodeId: "wsl-work",
        nodeName: "Windows WSL2",
      }),
    ).rejects.toThrow("XDG_CONFIG_HOME 必须是绝对路径");
  });
});
