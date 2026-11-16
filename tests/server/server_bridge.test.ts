import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { executeWorkbenchTool } from "../../src/mcp/tools.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";
import { ensureServerForProject, removeServerDiscovery } from "../../src/server/runtime.ts";
import workbenchExtension, {
  executeBridgeDispatch,
  resolveDeliveryRejection,
} from "../../omp/index.ts";

const tempDirs: string[] = [];
const runningServers: WorkbenchServerHandle[] = [];

function initGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-srv-test-"));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "main.ts"), "export const ready = true;\n");
  execFileSync("git", ["add", "main.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

async function apiJson(url: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const resp = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await resp.json()) as Record<string, unknown>;
  return { status: resp.status, body };
}

afterEach(() => {
  while (runningServers.length > 0) {
    runningServers.pop()!.stop();
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("WB-04 local HTTP/WS server and omp bridge adapter", () => {
  test("serves REST API lifecycle, CAS conflict 409, verification, git diff, and WS broadcasts", async () => {
    const root = initGitRepo();
    const server = await startWorkbenchServer({ root, port: 0, writeDiscovery: false });
    runningServers.push(server);

    const uiEvents: Array<Record<string, unknown>> = [];
    const uiWs = new WebSocket(`${server.url.replace("http", "ws")}/ws?role=ui`);
    await new Promise<void>((resolve) => {
      uiWs.addEventListener("open", () => resolve());
    });
    uiWs.addEventListener("message", (ev) => {
      uiEvents.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
    });

    try {
      const preProject = await apiJson(`${server.url}/api/project`);
      expect(preProject.status).toBe(200);
      expect(preProject.body.initialized).toBe(false);

      const initRes = await apiJson(`${server.url}/api/project/init`, {
        method: "POST",
        body: JSON.stringify({ name: "srv-demo", privacyMode: "local" }),
      });
      expect(initRes.status).toBe(201);

      const createRes = await apiJson(`${server.url}/api/requirements`, {
        method: "POST",
        body: JSON.stringify({ goal: "添加服务端接口测试", dispatchAgent: true }),
      });
      expect(createRes.status).toBe(201);
      const createdDetail = createRes.body.detail as { state: { id: string; stage: string; revision: number } };
      expect(createdDetail.state.id).toBe("REQ-001");
      expect(createdDetail.state.stage).toBe("designing");
      // Without connected bridge, dispatch cleanly falls back to offline prompt
      expect((createRes.body.dispatch as { status: string; prompt: string }).status).toBe("offline");
      expect((createRes.body.dispatch as { prompt: string }).prompt).toContain("REQ-001");

      // CAS conflict returns 409
      const conflictRes = await apiJson(`${server.url}/api/requirements/REQ-001/spec`, {
        method: "PATCH",
        body: JSON.stringify({ title: "过期编辑", expectedRevision: 1 }),
      });
      expect(conflictRes.status).toBe(409);

      // External Agent tool mutation triggers fs.watch -> WS broadcast
      await executeWorkbenchTool(root, "wb_propose", {
        id: "REQ-001",
        criteria: [{ id: "AC-1", description: "脚本通过", required: true, command: "echo ok" }],
        design: "## API 方案\n增加测试覆盖。",
      });

      const approveRes = await apiJson(`${server.url}/api/requirements/REQ-001/approve`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(approveRes.status).toBe(200);

      fs.writeFileSync(path.join(root, "main.ts"), "export const ready = true;\nexport const tested = 1;\n");
      const diffRes = await apiJson(`${server.url}/api/requirements/REQ-001/diff`);
      expect(diffRes.status).toBe(200);
      expect((diffRes.body.changes as { diff: string }).diff).toContain("export const tested = 1");

      const verifyRes = await apiJson(`${server.url}/api/requirements/REQ-001/verify`, {
        method: "POST",
        body: JSON.stringify({ all: true }),
      });
      expect(verifyRes.status).toBe(200);

      const acceptRes = await apiJson(`${server.url}/api/requirements/REQ-001/accept`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(acceptRes.status).toBe(200);
      expect((acceptRes.body.detail as { state: { stage: string } }).state.stage).toBe("done");

      await new Promise((r) => setTimeout(r, 120));
      expect(uiEvents.some((e) => e.type === "workbench.updated")).toBe(true);
    } finally {
      uiWs.close();
    }
  });

  test("delivers prompts safely over live WS bridge and preserves drafts/busy/stale guards", async () => {
    const root = initGitRepo();
    const server = await startWorkbenchServer({ root, port: 0, writeDiscovery: false });
    runningServers.push(server);

    await apiJson(`${server.url}/api/project/init`, { method: "POST", body: JSON.stringify({}) });
    await apiJson(`${server.url}/api/requirements`, {
      method: "POST",
      body: JSON.stringify({ goal: "测试 WS 会话桥接" }),
    });

    let currentDraft = "";
    let isBusy = false;
    const sentPrompts: string[] = [];
    const prefilledPrompts: string[] = [];

    const bridgeWs = new WebSocket(`${server.url.replace("http", "ws")}/ws?role=bridge`);
    await new Promise<void>((resolve) => {
      bridgeWs.addEventListener("open", () => {
        bridgeWs.send(
          JSON.stringify({
            type: "bridge.hello",
            agent: "omp",
            sessionId: "sess-1",
            state: "idle",
            model: "test/model",
          }),
        );
        resolve();
      });
    });

    bridgeWs.addEventListener("message", async (ev) => {
      const msg = JSON.parse(String(ev.data)) as { type: string; dispatchId: string; mode: "send" | "prefill"; prompt: string };
      if (msg.type !== "bridge.dispatch") return;
      const ack = await executeBridgeDispatch(
        msg,
        { available: true, projectReady: true, identityFresh: true, busy: isBusy, draftText: currentDraft },
        {
          setEditorText: (t) => {
            currentDraft = t;
            prefilledPrompts.push(t);
          },
          sendUserMessage: async (t) => {
            sentPrompts.push(t);
          },
        },
      );
      bridgeWs.send(JSON.stringify(ack));
    });

    await new Promise((r) => setTimeout(r, 40));
    expect(server.getBridgeStatus().connected).toBe(true);
    expect(server.getBridgeStatus().sessionId).toBe("sess-1");

    // 1. Send when idle & empty draft succeeds
    const sendRes = await apiJson(`${server.url}/api/requirements/REQ-001/dispatch`, {
      method: "POST",
      body: JSON.stringify({ action: "design", mode: "send" }),
    });
    expect(sendRes.status).toBe(200);
    expect((sendRes.body.dispatch as { status: string }).status).toBe("submitted");
    expect(sentPrompts).toHaveLength(1);

    // 2. Whitespace draft is preserved and causes draft_conflict rejection
    currentDraft = " ";
    const conflictRes = await apiJson(`${server.url}/api/requirements/REQ-001/dispatch`, {
      method: "POST",
      body: JSON.stringify({ action: "design", mode: "prefill" }),
    });
    expect((conflictRes.body.dispatch as { status: string; reason: string }).status).toBe("rejected");
    expect((conflictRes.body.dispatch as { reason: string }).reason).toBe("draft_conflict");
    expect(prefilledPrompts).toHaveLength(0);

    // 3. Clearing draft allows prefill without sending
    currentDraft = "";
    const prefillRes = await apiJson(`${server.url}/api/requirements/REQ-001/dispatch`, {
      method: "POST",
      body: JSON.stringify({ action: "design", mode: "prefill" }),
    });
    expect((prefillRes.body.dispatch as { status: string }).status).toBe("prefilled");
    expect(prefilledPrompts).toHaveLength(1);
    expect(sentPrompts).toHaveLength(1);

    // 4. Busy session rejects dispatch
    currentDraft = "";
    isBusy = true;
    const busyRes = await apiJson(`${server.url}/api/requirements/REQ-001/dispatch`, {
      method: "POST",
      body: JSON.stringify({ action: "design", mode: "send" }),
    });
    expect((busyRes.body.dispatch as { reason: string }).reason).toBe("source_busy");

    // 5. Disconnecting bridge resets status to offline
    bridgeWs.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(server.getBridgeStatus().connected).toBe(false);
    expect(server.getBridgeStatus().state).toBe("offline");
  });

  test("omp extension unit guards and registers 5 native tools + /wb command", async () => {
    expect(
      resolveDeliveryRejection({ available: false, projectReady: true, identityFresh: true, busy: false, draftText: "" }),
    ).toBe("unsupported_source");
    expect(
      resolveDeliveryRejection({ available: true, projectReady: true, identityFresh: false, busy: false, draftText: "" }),
    ).toBe("source_changed");
    expect(
      resolveDeliveryRejection({ available: true, projectReady: true, identityFresh: true, busy: true, draftText: "" }),
    ).toBe("source_busy");
    expect(
      resolveDeliveryRejection({ available: true, projectReady: true, identityFresh: true, busy: false, draftText: "\n" }),
    ).toBe("draft_conflict");
    expect(
      resolveDeliveryRejection({ available: true, projectReady: true, identityFresh: true, busy: false, draftText: "" }),
    ).toBeNull();

    const root = initGitRepo();
    await apiJson(`${(await (async () => { const s = await startWorkbenchServer({ root, port: 0, writeDiscovery: false }); runningServers.push(s); return s; })()).url}/api/project/init`, {
      method: "POST",
      body: JSON.stringify({}),
    });

    const tools = new Map<string, ToolDefinition>();
    const commands = new Map<string, { description: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> | void }>();
    const mockPi: ExtensionAPI = {
      setLabel() {},
      registerCommand(name, opts) { commands.set(name, opts); },
      registerTool(def) { tools.set(def.name, def); },
      async sendUserMessage() {},
      getAllTools: () => Array.from(tools.keys()).map((name) => ({ name })),
      getActiveTools: () => Array.from(tools.keys()),
      on() {},
    };

    workbenchExtension(mockPi);
    expect(Array.from(tools.keys())).toEqual(["wb_list", "wb_get", "wb_propose", "wb_update_tasks", "wb_verify"]);
    expect(tools.get("wb_list")?.approval).toBe("read");
    expect(tools.get("wb_propose")?.approval).toBe("write");
    expect(tools.get("wb_verify")?.approval).toBe("exec");
    expect(commands.has("wb")).toBe(true);

    const fakeCtx = {
      agent: { kind: "main" },
      mode: "tui",
      hasUI: true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      getPendingPlanReview: () => undefined,
      setInterval: () => 0,
      clearTimer() {},
      shutdown() {},
      sessionManager: {
        getSessionId: () => "s-1",
        getCwd: () => root,
        getBranch: () => [],
      },
      ui: {
        supportsEditor: true,
        getEditorText: () => "",
        setEditorText() {},
        notify() {},
        setStatus() {},
        setTitle() {},
      },
    } as ExtensionContext;

    const listOut = await tools.get("wb_list")!.execute("call-1", {}, undefined, undefined, fakeCtx);
    expect(JSON.parse(listOut.content[0]!.text).total).toBe(0);
  });

  test("ensureServerForProject spawns a healthy background server and reuses it", async () => {
    const root = initGitRepo();
    const info1 = await ensureServerForProject(root);
    try {
      expect(info1.port).toBeGreaterThan(0);
      expect(info1.url).toContain("127.0.0.1:");
      const info2 = await ensureServerForProject(root);
      expect(info2.pid).toBe(info1.pid);
      expect(info2.url).toBe(info1.url);
      const health = await fetch(`${info1.url}/api/health`);
      expect(health.status).toBe(200);
    } finally {
      try { process.kill(info1.pid, "SIGTERM"); } catch { /* ignore */ }
      removeServerDiscovery(root, info1.pid);
    }
  });
});
