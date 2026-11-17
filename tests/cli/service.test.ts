import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createUserServiceManager, type ServiceCommandResult, type UserServiceManager, type UserServiceOptions } from "../../src/cli/service.ts";

interface Fixture {
  root: string;
  home: string;
  hubDir: string;
  env: NodeJS.ProcessEnv;
  calls: Array<{ command: string; args: string[] }>;
  manager: UserServiceManager;
  setFailure(action: string | null): void;
  setSessionFailure(value: boolean): void;
  setPid(value: number): void;
  setActive(value: boolean): void;
  dispose(): void;
}
const fixtures: Fixture[] = [];
const temporaryDirectories: string[] = [];
const cliPath = path.resolve(import.meta.dir, "../../src/cli/index.ts");
const serviceModule = path.resolve(import.meta.dir, "../../src/cli/service.ts");
const ok: ServiceCommandResult = { exitCode: 0, stdout: "", stderr: "" };

function tempDirectory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-user-service-"));
  temporaryDirectories.push(dir);
  return fs.realpathSync(dir);
}
function fixture(platform: "darwin" | "linux" = "darwin", extra: Partial<UserServiceOptions> = {}): Fixture {
  const root = tempDirectory();
  const home = path.join(root, "home with spaces");
  const hubDir = path.join(root, "hub");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(hubDir);
  const calls: Array<{ command: string; args: string[] }> = [];
  let loaded = false;
  let active = false;
  let server: Server<undefined> | null = null;
  let failAction: string | null = "install";
  let failSession = false;
  let pid = process.pid;
  let actualPort = 0;
  const env = { HOME: home, PATH: "/usr/bin:/bin:relative::/usr/bin", API_KEY: "must-not-be-persisted", WORKBENCH_ROOT: "/must-not-be-used" };
  const runCommand = async (command: string, args: string[]): Promise<ServiceCommandResult> => {
    calls.push({ command, args: [...args] });
    if (command === "git") return { ...ok, stdout: "git version test" };
    const action = command === "systemctl" ? args[1] : args[0];
    const session = (command === "launchctl" && action === "print" && args.length === 2 && !args[1]!.includes("com.workbench")) || action === "show-environment";
    if (session) return failSession ? { ...ok, exitCode: 1, stderr: "session bus unavailable" } : ok;
    if (action === "print") return loaded ? { ...ok, stdout: `state = ${active ? "running" : "not running"}\n pid = ${pid}\n` } : { ...ok, exitCode: 113, stderr: "Could not find service" };
    if (action === "show") return { ...ok, stdout: `LoadState=${loaded ? "loaded" : "not-found"}\nActiveState=${active ? "active" : "inactive"}\nMainPID=${active ? pid : 0}\n` };
    const starting = ["bootstrap", "kickstart", "enable", "start", "restart"].includes(action!);
    if (failAction === action || (failAction === "install" && starting)) return { ...ok, exitCode: 5, stderr: "manager refused test start" };
    if (starting) {
      const installation = JSON.parse(fs.readFileSync(path.join(hubDir, "service.json"), "utf8"));
      server?.stop(true);
      server = Bun.serve({ hostname: "127.0.0.1", port: installation.port, fetch: () => Response.json({ ok: true, hubMode: true, serverPid: process.pid }) });
      actualPort = server.port!;
      loaded = true;
      active = true;
      fs.writeFileSync(path.join(hubDir, "daemon.json"), JSON.stringify({ pid: process.pid, port: actualPort, url: `http://127.0.0.1:${actualPort}`, root: home, startedAt: new Date().toISOString(), version: "test" }));
    } else if (["bootout", "stop", "disable"].includes(action!)) {
      server?.stop(true);
      server = null;
      active = false;
      if (action === "bootout") loaded = false;
    }
    return ok;
  };
  const manager = createUserServiceManager({ platform, home, hubDir, env, cliPath, uid: 501, runCommand, ...extra });
  const f = {
    root, home, hubDir, env, calls, manager,
    setFailure(action: string | null) { failAction = action; },
    setSessionFailure(value: boolean) { failSession = value; },
    setPid(value: number) { pid = value; },
    setActive(value: boolean) { active = value; },
    dispose() { server?.stop(true); },
  };
  fixtures.push(f);
  return f;
}
async function unusedPort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = server.port!;
  server.stop(true);
  return port;
}
async function failedInstall(f: Fixture, port?: number) {
  const selected = port ?? await unusedPort();
  await expect(f.manager.installUserService({ port: selected })).rejects.toThrow("manager refused test start");
  return f.manager.readServiceInstallation()!;
}

afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose();
  for (const dir of temporaryDirectories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("native user service ownership and lifecycle", () => {
  for (const platform of ["darwin", "linux"] as const) {
    test(`${platform}: failed manager install retains owned, private diagnostic state`, async () => {
      const f = fixture(platform);
      const installation = await failedInstall(f);
      expect(installation.manager).toBe(platform === "darwin" ? "launchd" : "systemd");
      expect(installation.workingDirectory).toBe(f.home);
      expect(installation.hubDir).toBe(f.hubDir);
      expect(installation.path.split(":")).toEqual([...new Set(["/usr/bin", "/bin", path.dirname(fs.realpathSync(process.execPath))])]);
      expect(fs.statSync(path.join(f.hubDir, "service.json")).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(installation.definitionPath, "utf8")).not.toContain("API_KEY");
      expect(fs.readFileSync(installation.definitionPath, "utf8")).not.toContain("/must-not-be-used");
      const status = await f.manager.controlUserService("status");
      expect(status).toEqual({ installed: true, manager: installation.manager, id: installation.id, active: false, healthy: false, url: null, definitionPath: installation.definitionPath });
      expect(f.calls.every((call) => call.command === "git" || call.command === (platform === "darwin" ? "launchctl" : "systemctl"))).toBe(true);
    });

    test(`${platform}: healthy repeat install is idempotent; stop and uninstall retain user data`, async () => {
      const f = fixture(platform);
      f.setFailure(null);
      const port = await unusedPort();
      const first = await f.manager.installUserService({ port });
      expect(first.active).toBe(true);
      expect(first.healthy).toBe(true);
      const before = f.calls.length;
      expect(await f.manager.installUserService({ port })).toEqual(first);
      expect(f.calls.slice(before).some((call) => call.args.some((arg) => ["bootstrap", "kickstart", "enable", "start", "restart", "stop", "bootout"].includes(arg)))).toBe(false);
      const installation = f.manager.readServiceInstallation()!;
      fs.writeFileSync(path.join(f.hubDir, "hub.json"), "user projects");
      fs.writeFileSync(path.join(f.hubDir, "service.log"), "retained log");
      const project = path.join(f.root, "project", ".workbench");
      fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(path.join(project, "project.json"), "retained project");
      const stopped = await f.manager.controlUserService("stop");
      expect(stopped.active).toBe(false);
      expect(stopped.healthy).toBe(false);
      expect(fs.existsSync(installation.definitionPath)).toBe(true);
      expect(f.calls.some((call) => call.args.includes(platform === "darwin" ? "bootout" : "stop"))).toBe(true);
      expect((await f.manager.controlUserService("start")).healthy).toBe(true);
      expect((await f.manager.controlUserService("restart")).healthy).toBe(true);
      if (platform === "darwin") expect(f.calls.some((call) => call.args.includes("kickstart") && call.args.includes("-k"))).toBe(true);
      const removed = await f.manager.controlUserService("uninstall");
      expect(removed.installed).toBe(false);
      expect(fs.existsSync(installation.definitionPath)).toBe(false);
      expect(f.manager.readServiceInstallation()).toBeNull();
      expect(fs.readFileSync(path.join(f.hubDir, "hub.json"), "utf8")).toBe("user projects");
      expect(fs.readFileSync(path.join(f.hubDir, "service.log"), "utf8")).toBe("retained log");
      expect(fs.readFileSync(path.join(project, "project.json"), "utf8")).toBe("retained project");
      expect((await f.manager.controlUserService("uninstall")).installed).toBe(false);
    });

    test(`${platform}: unknown definition and changed owned definition are never overwritten`, async () => {
      const f = fixture(platform);
      const hash = createHash("sha256").update(f.hubDir).digest("hex").slice(0, 12);
      const target = platform === "darwin" ? path.join(f.home, "Library", "LaunchAgents", `com.workbench.hub-${hash}.plist`) : path.join(f.home, ".config", "systemd", "user", `workbench-hub-${hash}.service`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "unrelated user definition");
      await expect(f.manager.installUserService({ port: await unusedPort() })).rejects.toThrow("拒绝覆盖未知服务定义");
      expect(fs.readFileSync(target, "utf8")).toBe("unrelated user definition");
      fs.unlinkSync(target);
      const installed = await failedInstall(f);
      fs.appendFileSync(installed.definitionPath, "\n# external edit\n");
      await expect(f.manager.controlUserService("uninstall")).rejects.toThrow("拒绝修改");
      expect(fs.existsSync(path.join(f.hubDir, "service.json"))).toBe(true);
      expect(fs.readFileSync(target, "utf8")).toContain("# external edit");
    });

    test(`${platform}: manager unavailability is an error, never a detached fallback`, async () => {
      const f = fixture(platform);
      f.setSessionFailure(true);
      await expect(f.manager.installUserService({ port: await unusedPort() })).rejects.toThrow("session bus unavailable");
      expect(f.manager.readServiceInstallation()).toBeNull();
      f.setSessionFailure(false);
      await failedInstall(f);
      f.setSessionFailure(true);
      await expect(f.manager.controlUserService("start")).rejects.toThrow("session bus unavailable");
      expect(f.calls.every((call) => ["git", "launchctl", "systemctl"].includes(call.command))).toBe(true);
    });

    test(`${platform}: uninstall failure retains both owned installation files`, async () => {
      const f = fixture(platform);
      f.setFailure(null);
      await f.manager.installUserService({ port: await unusedPort() });
      const installed = f.manager.readServiceInstallation()!;
      f.setFailure(platform === "darwin" ? "bootout" : "disable");
      await expect(f.manager.controlUserService("uninstall")).rejects.toThrow("manager refused test start");
      expect(fs.existsSync(installed.definitionPath)).toBe(true);
      expect(f.manager.readServiceInstallation()!.id).toBe(installed.id);
    });

    test(`${platform}: manager activity is independent of PID-matched health`, async () => {
      const f = fixture(platform);
      f.setFailure(null);
      await f.manager.installUserService({ port: await unusedPort() });
      f.setPid(process.pid + 1);
      const stale = await f.manager.controlUserService("status");
      expect(stale.active).toBe(true);
      expect(stale.healthy).toBe(false);
      f.setPid(process.pid);
      f.setActive(false);
      const inactive = await f.manager.controlUserService("status");
      expect(inactive.active).toBe(false);
      expect(inactive.healthy).toBe(false);
    });
  }

  test("configuration changes stop the old service before replacing and restarting it", async () => {
    const f = fixture("linux");
    f.setFailure(null);
    const first = await f.manager.installUserService({ port: await unusedPort() });
    const before = f.calls.length;
    const newPort = await unusedPort();
    const next = await f.manager.installUserService({ port: newPort });
    const changes = f.calls.slice(before).map((call) => call.args[1]);
    expect(changes.indexOf("stop")).toBeLessThan(changes.indexOf("enable"));
    expect(next.id).toBe(first.id);
    expect(next.url).toBe(`http://127.0.0.1:${newPort}`);
  });

  test("a failed systemd reload can be repaired by repeating the same installation", async () => {
    const f = fixture("linux");
    f.setFailure("daemon-reload");
    const installed = await failedInstall(f);
    f.setFailure(null);
    expect((await f.manager.installUserService({ port: installed.port })).healthy).toBe(true);
    expect(f.calls.filter((call) => call.args.includes("daemon-reload"))).toHaveLength(2);
  });

  test("failed uninstall reload restores the stopped owned unit for a safe retry", async () => {
    const f = fixture("linux");
    f.setFailure(null);
    await f.manager.installUserService({ port: await unusedPort() });
    const installed = f.manager.readServiceInstallation()!;
    f.setFailure("daemon-reload");
    await expect(f.manager.controlUserService("uninstall")).rejects.toThrow("manager refused test start");
    expect(f.manager.readServiceInstallation()!.id).toBe(installed.id);
    expect((await f.manager.controlUserService("status")).active).toBe(false);
    f.setFailure(null);
    expect((await f.manager.controlUserService("uninstall")).installed).toBe(false);
  });

  test("missing, corrupt, platform-mismatched and symlinked installation records fail closed", async () => {
    const f = fixture();
    const s = await failedInstall(f);
    const config = path.join(f.hubDir, "service.json");
    fs.writeFileSync(config, "not JSON");
    expect(() => f.manager.readServiceInstallation()).toThrow("损坏");
    fs.writeFileSync(config, JSON.stringify({ ...s, manager: "systemd" }));
    expect(() => f.manager.readServiceInstallation()).toThrow("平台不匹配");
    fs.writeFileSync(config, JSON.stringify(s));
    fs.unlinkSync(s.definitionPath);
    expect(() => f.manager.readServiceInstallation()).toThrow("定义缺失");
    fs.unlinkSync(config);
    fs.symlinkSync(path.join(f.root, "missing-target"), config);
    expect(() => f.manager.readServiceInstallation()).toThrow("无效服务安装记录");
  });

  test("namespaces use canonical hub paths and cannot overwrite one another", async () => {
    const f = fixture();
    const first = await failedInstall(f);
    const secondHub = path.join(f.root, "second-hub");
    const second = createUserServiceManager({ platform: "darwin", home: f.home, hubDir: secondHub, env: f.env, cliPath, uid: 501, runCommand: async (command, args) => command === "git" || (args[0] === "print" && args[1] === "gui/501") ? ok : { ...ok, exitCode: 5, stderr: "manager refused test start" } });
    await expect(second.installUserService({ port: await unusedPort() })).rejects.toThrow("manager refused test start");
    const next = second.readServiceInstallation()!;
    expect(next.id).not.toBe(first.id);
    expect(next.definitionPath).not.toBe(first.definitionPath);
    const link = path.join(f.root, "hub-link");
    fs.symlinkSync(f.hubDir, link, "dir");
    const alias = createUserServiceManager({ platform: "darwin", home: f.home, hubDir: link, env: f.env, uid: 501 });
    expect(alias.readServiceInstallation()!.id).toBe(first.id);
  });

  test("systemd quotes spaces, quotes, backslashes, percent specifiers and dollars without a shell", async () => {
    const root = tempDirectory();
    const source = path.join(root, "source ' \" \\ % $name");
    const specialCli = path.join(source, "src", "cli", "index.ts");
    fs.mkdirSync(path.dirname(specialCli), { recursive: true });
    fs.mkdirSync(path.join(source, "src", "server"));
    fs.writeFileSync(specialCli, "");
    fs.writeFileSync(path.join(source, "src", "server", "index.ts"), "");
    fs.writeFileSync(path.join(source, "package.json"), "{}");
    const f = fixture("linux", { cliPath: specialCli });
    const installation = await failedInstall(f);
    const text = fs.readFileSync(installation.definitionPath, "utf8");
    const encoded = specialCli.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$");
    expect(text).toContain(`ExecStart="${fs.realpathSync(process.execPath)}" "run" "${encoded}" "serve" "--hub"`);
    expect(text).toContain(`WorkingDirectory=${f.home}`);
    expect(text).toContain("Restart=on-failure\nRestartSec=5\nTimeoutStopSec=15\nKillMode=control-group");
    expect(f.calls.some((call) => call.command === "sh" || call.command === "bash")).toBe(false);
  });

  test("launchd XML escapes special paths and uses bootstrap/bootout instead of process signals", async () => {
    const root = tempDirectory();
    const specialHome = path.join(root, "home & < > \" '");
    fs.mkdirSync(specialHome);
    const f = fixture("darwin", { home: specialHome });
    const installed = await failedInstall(f);
    const text = fs.readFileSync(installed.definitionPath, "utf8");
    expect(text).toContain("home &amp; &lt; &gt; &quot; &apos;");
    expect(text).toContain("<key>KeepAlive</key><true/>");
    expect(text).toContain("<key>ThrottleInterval</key><integer>5</integer>");
    expect(f.calls.some((call) => call.args[0] === "bootstrap" && call.args[1] === "gui/501" && call.args[2] === installed.definitionPath)).toBe(true);
  });

  test("unsupported native Windows, relative XDG directories and control characters are rejected", async () => {
    const windows = fixture("linux", { platform: "win32" });
    await expect(windows.manager.installUserService()).rejects.toThrow("WSL2");
    const relative = fixture("linux", { env: { PATH: "/usr/bin", XDG_CONFIG_HOME: "relative" } });
    await expect(relative.manager.installUserService()).rejects.toThrow("XDG_CONFIG_HOME");
    const bad = fixture("linux", { env: { PATH: "/usr/bin:/bad\npath" } });
    await expect(bad.manager.installUserService({ port: await unusedPort() })).rejects.toThrow("NUL、CR 或 LF");
    const wsl = fixture("linux", { env: { PATH: "/usr/bin", WSL_DISTRO_NAME: "Ubuntu" } });
    wsl.setSessionFailure(true);
    await expect(wsl.manager.installUserService({ port: await unusedPort() })).rejects.toThrow("learn.microsoft.com/en-us/windows/wsl/systemd");
  });

  test("port conflicts fail explicitly without creating installation records", async () => {
    const f = fixture();
    const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    try { await expect(f.manager.installUserService({ port: occupied.port! })).rejects.toThrow("不会自动换端口"); }
    finally { occupied.stop(true); }
    expect(f.manager.readServiceInstallation()).toBeNull();
  });

  test("port changes verify new port availability before stopping the active service", async () => {
    const f = fixture("linux");
    f.setFailure(null);
    const firstPort = await unusedPort();
    const first = await f.manager.installUserService({ port: firstPort });
    expect(first.healthy).toBe(true);
    const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const beforeCalls = f.calls.length;
    try {
      await expect(f.manager.installUserService({ port: occupied.port! })).rejects.toThrow("不会自动换端口");
      expect(f.calls.slice(beforeCalls).some((call) => call.args.includes("stop"))).toBe(false);
      expect((await f.manager.controlUserService("status")).healthy).toBe(true);
    } finally {
      occupied.stop(true);
    }
  });

  test("unmanaged healthy Hubs require an explicit stop before install", async () => {
    const f = fixture();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true, serverPid: process.pid, hubMode: true }) });
    try {
      fs.writeFileSync(path.join(f.hubDir, "daemon.json"), JSON.stringify({ pid: process.pid, port: server.port, url: `http://127.0.0.1:${server.port}` }));
      await expect(f.manager.installUserService({ port: await unusedPort() })).rejects.toThrow("请先运行 wb stop");
      expect(f.manager.readServiceInstallation()).toBeNull();
    } finally { server.stop(true); }
  });

  test("captures and renders proxy variables without persisting unrelated environment keys", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const f = fixture(platform);
      Object.assign(f.env, {
        http_proxy: "http://127.0.0.1:20890",
        HTTPS_PROXY: "http://user:pass@127.0.0.1:20890",
        all_proxy: "socks5://127.0.0.1:20890",
        NO_PROXY: "localhost,127.0.0.1",
      });
      const installation = await failedInstall(f);
      const expected = {
        HTTPS_PROXY: "http://user:pass@127.0.0.1:20890",
        NO_PROXY: "localhost,127.0.0.1",
        http_proxy: "http://127.0.0.1:20890",
        all_proxy: "socks5://127.0.0.1:20890",
      };
      expect(installation.proxyEnv).toEqual(expected);
      const record = JSON.parse(fs.readFileSync(path.join(f.hubDir, "service.json"), "utf8")) as { proxyEnv: unknown; API_KEY?: string };
      expect(record.proxyEnv).toEqual(expected);
      expect(record.API_KEY).toBeUndefined();
      const text = fs.readFileSync(installation.definitionPath, "utf8");
      expect(text).not.toContain("API_KEY");
      expect(text).not.toContain("must-not-be-persisted");
      if (platform === "linux") {
        expect(text).toContain('Environment="http_proxy=http://127.0.0.1:20890"');
        expect(text).toContain('Environment="HTTPS_PROXY=http://user:pass@127.0.0.1:20890"');
        expect(text).toContain('Environment="all_proxy=socks5://127.0.0.1:20890"');
        expect(text).toContain('Environment="NO_PROXY=localhost,127.0.0.1"');
      } else {
        expect(text).toContain("<key>http_proxy</key><string>http://127.0.0.1:20890</string>");
        expect(text).toContain("<key>HTTPS_PROXY</key><string>http://user:pass@127.0.0.1:20890</string>");
        expect(text).toContain("<key>all_proxy</key><string>socks5://127.0.0.1:20890</string>");
        expect(text).toContain("<key>NO_PROXY</key><string>localhost,127.0.0.1</string>");
      }
      expect(fs.statSync(installation.definitionPath).mode & 0o777).toBe(0o600);
    }
  });

  test("round-trips proxy records and keeps legacy records without proxyEnv readable", async () => {
    const f = fixture("linux");
    const legacy = await failedInstall(f);
    const config = path.join(f.hubDir, "service.json");
    const legacyConfig = fs.readFileSync(config);
    const legacyDefinition = fs.readFileSync(legacy.definitionPath);
    expect(legacy.proxyEnv).toBeUndefined();

    f.env.HTTPS_PROXY = "http://127.0.0.1:20890";
    const proxied = await failedInstall(f);
    expect(f.manager.readServiceInstallation()!.proxyEnv).toEqual({ HTTPS_PROXY: "http://127.0.0.1:20890" });
    expect(fs.readFileSync(proxied.definitionPath, "utf8")).toContain('Environment="HTTPS_PROXY=http://127.0.0.1:20890"');

    fs.writeFileSync(config, legacyConfig);
    fs.writeFileSync(legacy.definitionPath, legacyDefinition);
    const restored = f.manager.readServiceInstallation()!;
    expect(restored.proxyEnv).toBeUndefined();
    expect(fs.readFileSync(restored.definitionPath, "utf8")).toBe(legacyDefinition.toString("utf8"));
  });

  test("rejects control characters in proxy values and malformed proxy records", async () => {
    const badValue = fixture("linux");
    badValue.env.http_proxy = "http://proxy\nEnd";
    await expect(badValue.manager.installUserService({ port: await unusedPort() })).rejects.toThrow("NUL、CR 或 LF");
    expect(badValue.manager.readServiceInstallation()).toBeNull();

    const f = fixture("linux");
    const installation = await failedInstall(f);
    const config = path.join(f.hubDir, "service.json");
    fs.writeFileSync(config, JSON.stringify({ ...installation, proxyEnv: { API_KEY: "secret" } }));
    expect(() => f.manager.readServiceInstallation()).toThrow("proxyEnv.API_KEY");
    fs.writeFileSync(config, JSON.stringify({ ...installation, proxyEnv: { HTTPS_PROXY: "" } }));
    expect(() => f.manager.readServiceInstallation()).toThrow("proxyEnv.HTTPS_PROXY");
    fs.writeFileSync(config, JSON.stringify({ ...installation, proxyEnv: ["http://127.0.0.1:20890"] }));
    expect(() => f.manager.readServiceInstallation()).toThrow("proxyEnv");
  });

  test("adding a proxy to a healthy installation stops and rewrites the service", async () => {
    const f = fixture("linux");
    f.setFailure(null);
    const port = await unusedPort();
    const first = await f.manager.installUserService({ port });
    expect(first.healthy).toBe(true);
    expect(f.manager.readServiceInstallation()!.proxyEnv).toBeUndefined();
    expect(fs.readFileSync(first.definitionPath!, "utf8")).not.toContain("https_proxy");

    f.env.https_proxy = "http://127.0.0.1:20890";
    const before = f.calls.length;
    const next = await f.manager.installUserService({ port });
    expect(next.healthy).toBe(true);
    const actions = f.calls.slice(before).map((call) => call.args[1]);
    expect(actions).toContain("stop");
    expect(actions).toContain("enable");
    expect(actions.indexOf("stop")).toBeLessThan(actions.indexOf("enable"));
    expect(f.manager.readServiceInstallation()!.proxyEnv).toEqual({ https_proxy: "http://127.0.0.1:20890" });
    expect(fs.readFileSync(first.definitionPath!, "utf8")).toContain('Environment="https_proxy=http://127.0.0.1:20890"');
  });

  test("installations without proxy configuration keep the legacy definition and record shape", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const f = fixture(platform);
      const installation = await failedInstall(f);
      const record = JSON.parse(fs.readFileSync(path.join(f.hubDir, "service.json"), "utf8")) as Record<string, unknown>;
      expect("proxyEnv" in record).toBe(false);
      const text = fs.readFileSync(installation.definitionPath, "utf8");
      if (platform === "linux") {
        const environmentLines = text.split("\n").filter((line) => line.startsWith("Environment="));
        expect(environmentLines).toHaveLength(3);
        expect(environmentLines[0]!.startsWith('Environment="PATH=')).toBe(true);
        expect(environmentLines[1]!.startsWith(`Environment="HOME=`)).toBe(true);
        expect(environmentLines[2]!.startsWith('Environment="WORKBENCH_HUB_DIR=')).toBe(true);
        expect(environmentLines.join("\n")).not.toContain("PROXY");
      } else {
        const block = text.match(/<key>EnvironmentVariables<\/key><dict>(.*?)<\/dict>/)![1]!;
        expect([...block.matchAll(/<key>/g)]).toHaveLength(3);
        expect(block.indexOf("<key>PATH</key>")).toBeLessThan(block.indexOf("<key>HOME</key>"));
        expect(block.indexOf("<key>HOME</key>")).toBeLessThan(block.indexOf("<key>WORKBENCH_HUB_DIR</key>"));
        expect(block).not.toContain("PROXY");
      }
    }
  });
});

describe("service-aware CLI routing in isolated child environments", () => {
  async function child(commands: string[][], failure = false) {
    const root = tempDirectory();
    const home = path.join(root, "home");
    const hub = path.join(root, "hub");
    fs.mkdirSync(home);
    fs.mkdirSync(hub);
    const port = await unusedPort();
    const script = `
      import * as fs from "node:fs";
      import { createUserServiceManager } from ${JSON.stringify(serviceModule)};
      import { runCli } from ${JSON.stringify(cliPath)};
      const calls = [];
      let active = false, loaded = false, server;
      const manager = createUserServiceManager({ platform: "darwin", home: process.env.HOME, hubDir: process.env.WORKBENCH_HUB_DIR, uid: 501,
        runCommand: async (command, args) => {
          calls.push([command, ...args]);
          const ok = { exitCode: 0, stdout: "", stderr: "" };
          if (command === "git" || (args[0] === "print" && args[1] === "gui/501")) return ok;
          if (args[0] === "print") return loaded ? { ...ok, stdout: "state = " + (active ? "running" : "stopped") + "\\n pid = " + process.pid } : { ...ok, exitCode: 113, stderr: "Could not find service" };
          if (["bootstrap", "kickstart"].includes(args[0])) {
            if (${JSON.stringify(failure)}) return { ...ok, exitCode: 5, stderr: "test manager unavailable" };
            server?.stop(true);
            server = Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => Response.json({ ok: true, hubMode: true, serverPid: process.pid }) });
            active = loaded = true;
            fs.writeFileSync(process.env.WORKBENCH_HUB_DIR + "/daemon.json", JSON.stringify({ pid: process.pid, port: ${port}, url: "http://127.0.0.1:${port}", root: process.env.HOME }));
          }
          if (args[0] === "bootout") { server?.stop(true); server = null; active = loaded = false; }
          return ok;
        }
      });
      const results = [];
      try { await manager.installUserService({ port: ${port} }); } catch (e) { if (!${JSON.stringify(failure)}) throw e; }
      const commands = ${JSON.stringify(commands)};
      for (const command of commands) results.push(await runCli([...(command[0] === "service" ? [] : ["--root", ${JSON.stringify(root)}]), "--json", ...command.map(arg => arg === "INSTALLED_PORT" ? "${port}" : arg)], manager));
      server?.stop(true);
      process.stdout.write("RESULT=" + JSON.stringify({ results, calls }) + "\\n");
    `;
    const proc = Bun.spawn([process.execPath, "--eval", script], { cwd: root, env: { ...process.env, HOME: home, WORKBENCH_HUB_DIR: hub, WORKBENCH_ROOT: path.join(root, "nonexistent-project") }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(exit).toBe(0);
    const line = stdout.split("\n").find((value) => value.startsWith("RESULT="));
    expect(line).toBeDefined();
    return { ...(JSON.parse(line!.slice(7)) as { results: number[]; calls: string[][] }), stdout, stderr };
  }

  test("start/restart preserve the installed port and stop unloads the manager service", async () => {
    const result = await child([["start"], ["restart"], ["stop"], ["status"]]);
    expect(result.results).toEqual([0, 0, 0, 0]);
    expect(result.calls.some((call) => call[1] === "kickstart" && call.includes("-k"))).toBe(true);
    expect(result.calls.some((call) => call[1] === "bootout")).toBe(true);
    expect(result.stdout).toContain('"service": {');
    expect(result.stdout).toContain('"active": false');
  });

  test("service subcommands ignore project root overrides and use the installed native manager", async () => {
    const result = await child([["service", "status"], ["service", "install", "--port", "INSTALLED_PORT"], ["service", "stop"], ["service", "start"], ["service", "restart"], ["service", "uninstall"], ["service", "uninstall"]]);
    expect(result.results).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(result.stdout).toContain('"installed": false');
    expect(result.calls.filter((call) => call[1] === "bootstrap")).toHaveLength(2);
    const withRoot = await child([["service", "status", "--root", "/tmp"]]);
    expect(withRoot.results).toEqual([0]);
  });

  test("managed lifecycle rejects conflicting explicit host/port instead of silently reverting defaults", async () => {
    const result = await child([["start", "--port", "1"], ["restart", "--port", "1"], ["open", "--host", "0.0.0.0"], ["start", "--host", "0.0.0.0"]]);
    expect(result.results).toEqual([1, 1, 1, 1]);
    expect(result.stderr).toContain("service install --port");
    expect(result.calls.filter((call) => ["bootstrap", "kickstart", "bootout"].includes(call[1]!))).toHaveLength(1);
  });

  test("start/open failures remain manager failures and never launch detached or open a browser", async () => {
    const result = await child([["start"], ["open"], ["restart"]], true);
    expect(result.results).toEqual([1, 1, 1]);
    expect(result.stderr).toContain("test manager unavailable");
    expect(result.calls.filter((call) => call[1] === "bootstrap")).toHaveLength(4);
  });

  test("service commands reject unknown actions, arguments, extra positionals and invalid ports", async () => {
    const result = await child([["service", "unknown"], ["service", "install", "--host", "127.0.0.1"], ["service", "install", "--port", "0"], ["service", "install", "--port", "65536"], ["service", "install", "--port"], ["service", "install", "--port", "2.5"], ["service", "status", "extra"]]);
    expect(result.results).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(result.stderr).toContain('"code": "invalid_input"');
  });
});
