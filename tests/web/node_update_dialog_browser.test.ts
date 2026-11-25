import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";
import { browserEnv, cleanupE2eResources, closeE2eBrowser, initGitRepoIn, launchE2eBrowser, type BrowserInstance, type BrowserPage } from "./e2e_helpers.ts";

const HAS_BROWSER = browserEnv !== null;
const HUB_REVISION = "a".repeat(40);
const NODE_REVISION = "b".repeat(40);
const DIALOG_SEL = '[data-slot="alert-dialog-popup"]';
const TOAST_SEL = '[data-slot="toast-root"]:not([data-ending-style])';

const tempDirs: string[] = [];
const servers: WorkbenchServerHandle[] = [];
const origHubDir = process.env.WORKBENCH_HUB_DIR;
let browser: BrowserInstance | null = null;

function makeHubDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-req022-hub-"));
  tempDirs.push(dir);
  process.env.WORKBENCH_HUB_DIR = dir;
  return dir;
}

async function startServer(): Promise<WorkbenchServerHandle> {
  makeHubDir();
  const root = initGitRepoIn(tempDirs);
  const server = await startWorkbenchServer({ root, port: 0, writeDiscovery: false, hubMode: true });
  servers.push(server);
  return server;
}

interface NodeUpdateStubOptions {
  fail?: boolean;
  failFirstOnly?: boolean;
  triggerRunningRefresh?: boolean;
  disconnectOnFirstAttempt?: boolean;
}

async function installNodeUpdateStub(page: BrowserPage, options: NodeUpdateStubOptions = {}): Promise<void> {
  await page.evaluateOnNewDocument(
    (opts: NodeUpdateStubOptions & { hubRevision: string; nodeRevision: string }) => {
      const w = window as unknown as {
        fetch: typeof fetch;
        confirm: (message?: string) => boolean;
        WebSocket: typeof WebSocket;
        __wbSockets: WebSocket[];
        __wbEmitHubUpdated: () => void;
        __wbSetNodeState: (patch: { connected?: boolean; inFlight?: boolean; failed?: boolean }) => void;
        __wbUpdateCalls: Array<{ revision?: string }>;
        __wbConfirmCalls: number;
        __wbUpdateShouldFail: boolean;
        __wbUpdateAttempts: number;
        __wbUpdateInFlight: boolean;
        __wbUpdateFailed: boolean;
        __wbNodeConnected: boolean;
      };
      const nativeFetch = w.fetch.bind(window);
      w.__wbUpdateCalls = [];
      w.__wbConfirmCalls = 0;
      w.__wbUpdateShouldFail = opts.fail === true;
      w.__wbUpdateAttempts = 0;
      w.__wbUpdateInFlight = false;
      w.__wbUpdateFailed = false;
      w.__wbNodeConnected = true;
      w.confirm = () => {
        w.__wbConfirmCalls += 1;
        return false;
      };

      const NativeWebSocket = w.WebSocket;
      w.__wbSockets = [];
      function WrappedWebSocket(url: string | URL, protocols?: string | string[]): WebSocket {
        const socket = new NativeWebSocket(url, protocols);
        w.__wbSockets.push(socket);
        return socket;
      }
      WrappedWebSocket.prototype = NativeWebSocket.prototype;
      Object.assign(WrappedWebSocket, {
        CONNECTING: NativeWebSocket.CONNECTING,
        OPEN: NativeWebSocket.OPEN,
        CLOSING: NativeWebSocket.CLOSING,
        CLOSED: NativeWebSocket.CLOSED,
      });
      w.WebSocket = WrappedWebSocket as unknown as typeof WebSocket;
      w.__wbEmitHubUpdated = () => {
        for (const socket of w.__wbSockets) {
          socket.dispatchEvent(
            new MessageEvent("message", { data: JSON.stringify({ type: "hub.updated" }) }),
          );
        }
      };
      w.__wbSetNodeState = (patch) => {
        if (typeof patch.connected === "boolean") w.__wbNodeConnected = patch.connected;
        if (typeof patch.inFlight === "boolean") w.__wbUpdateInFlight = patch.inFlight;
        if (typeof patch.failed === "boolean") w.__wbUpdateFailed = patch.failed;
        w.__wbEmitHubUpdated();
      };

      w.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const raw = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
        const url = new URL(raw, window.location.href);
        if (url.pathname === "/api/hub/state") {
          return nativeFetch(input as RequestInfo, init).then(async (response) => {
            const data = (await response.json()) as {
              hubMode?: boolean;
              nodes?: Array<Record<string, unknown>>;
            };
            const nodes = data.nodes ?? [];
            const local = nodes.find((node) => node.isLocal === true);
            if (local) local.revision = opts.hubRevision;
            const update = w.__wbUpdateInFlight
              ? { phase: "running", revision: opts.hubRevision }
              : w.__wbUpdateFailed
                ? { phase: "failed", revision: opts.hubRevision, message: "boom" }
                : undefined;
            nodes.push({
              nodeId: "wsl-test",
              name: "WSL2-Test",
              isLocal: false,
              hostname: "wsl-test-host",
              platform: "linux",
              connected: w.__wbNodeConnected,
              connectedAt: Date.now(),
              lastSeenAt: Date.now(),
              harnesses: [],
              activeRuns: [],
              workbenchVersion: "5.0.0",
              revision: opts.nodeRevision,
              updateEnabled: true,
              ...(update ? { update } : {}),
            });
            data.hubMode = true;
            data.nodes = nodes;
            return new Response(JSON.stringify(data), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          });
        }
        if (url.pathname === "/api/hub/nodes/wsl-test/update" && (init?.method ?? "GET").toUpperCase() === "POST") {
          const body = init?.body ? (JSON.parse(String(init.body)) as { revision?: string }) : {};
          w.__wbUpdateCalls.push(body);
          w.__wbUpdateAttempts += 1;
          const disconnectNow = opts.disconnectOnFirstAttempt === true && w.__wbUpdateAttempts === 1;
          const shouldFail =
            w.__wbUpdateShouldFail || disconnectNow || (opts.failFirstOnly === true && w.__wbUpdateAttempts === 1);
          if (opts.triggerRunningRefresh === true) {
            w.__wbUpdateInFlight = true;
            w.__wbEmitHubUpdated();
          }
          if (disconnectNow) {
            w.__wbNodeConnected = false;
            w.__wbUpdateInFlight = false;
            w.__wbUpdateFailed = true;
            w.__wbEmitHubUpdated();
          }
          return new Promise<Response>((resolve) => {
            setTimeout(() => {
              w.__wbUpdateInFlight = false;
              if (shouldFail) {
                w.__wbUpdateFailed = true;
                resolve(
                  new Response(JSON.stringify({ error: { code: "execution_failed", message: disconnectNow ? "node disconnected" : "boom" } }), {
                    status: 500,
                    headers: { "content-type": "application/json" },
                  }),
                );
                return;
              }
              w.__wbUpdateFailed = false;
              resolve(
                new Response(JSON.stringify({ phase: "running", revision: opts.hubRevision, message: null }), {
                  status: 202,
                  headers: { "content-type": "application/json" },
                }),
              );
            }, opts.triggerRunningRefresh === true ? 1_000 : 350);
          });
        }
        return nativeFetch(input as RequestInfo, init);
      }) as typeof fetch;
    },
    { hubRevision: HUB_REVISION, nodeRevision: NODE_REVISION, ...options },
  );
}

async function newPage(
  server: WorkbenchServerHandle,
  width = 1280,
  height = 860,
  options: NodeUpdateStubOptions = {},
): Promise<BrowserPage> {
  const page = await browser!.newPage();
  await page.setViewport({ width, height });
  await installNodeUpdateStub(page, options);
  await page.goto(server.url, { waitUntil: "networkidle0" });
  return page;
}

async function openUpdateDialog(page: BrowserPage): Promise<void> {
  await page.waitForSelector('[data-testid="node-update-wsl-test"]', { timeout: 10_000 });
  await page.click('[data-testid="node-update-wsl-test"]');
  await page.waitForSelector(DIALOG_SEL, { timeout: 5_000 });
}

async function waitDialogGone(page: BrowserPage): Promise<void> {
  await page.waitForFunction(() => !document.querySelector('[data-slot="alert-dialog-popup"]'), { timeout: 5_000 });
}

async function updateCallCount(page: BrowserPage): Promise<number> {
  return page.evaluate(() => (window as unknown as { __wbUpdateCalls: unknown[] }).__wbUpdateCalls.length);
}

beforeAll(async () => {
  if (!browserEnv) return;
  browser = await launchE2eBrowser();
}, 15_000);

afterEach(() => {
  cleanupE2eResources(servers, tempDirs, origHubDir);
});

afterAll(async () => {
  await closeE2eBrowser(browser);
}, 15_000);

const suite = HAS_BROWSER ? describe : describe.skip;

suite("REQ-022 节点更新确认弹窗真实浏览器回归", () => {
  test("打开 coss AlertDialog、展示节点与 revision，取消或 Esc 不发起请求且点击遮罩不关闭", async () => {
    const server = await startServer();
    const page = await newPage(server);
    try {
      await openUpdateDialog(page);

      const dialog = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        return {
          text: el?.textContent ?? "",
          slotTitle: Boolean(el?.querySelector('[data-slot="alert-dialog-title"]')),
          slotDescription: Boolean(el?.querySelector('[data-slot="alert-dialog-description"]')),
          confirmCalls: (window as unknown as { __wbConfirmCalls: number }).__wbConfirmCalls,
        };
      }, DIALOG_SEL);
      expect(dialog.text).toContain("更新远程节点");
      expect(dialog.text).toContain("WSL2-Test");
      expect(dialog.text).toContain(HUB_REVISION.slice(0, 7));
      expect(dialog.slotTitle).toBe(true);
      expect(dialog.slotDescription).toBe(true);
      expect(dialog.confirmCalls).toBe(0);

      // 点击遮罩不关闭：AlertDialog 保留显式确认语义。
      await page.mouse.move(5, 5);
      await page.mouse.down();
      await page.mouse.up();
      await Bun.sleep(150);
      expect(await page.evaluate((sel: string) => Boolean(document.querySelector(sel)), DIALOG_SEL)).toBe(true);

      await page.click('[data-testid="node-update-cancel"]');
      await waitDialogGone(page);
      expect(await updateCallCount(page)).toBe(0);

      await openUpdateDialog(page);
      await page.keyboard.press("Escape");
      await waitDialogGone(page);
      expect(await updateCallCount(page)).toBe(0);
      expect(
        await page.evaluate(() => (window as unknown as { __wbConfirmCalls: number }).__wbConfirmCalls),
      ).toBe(0);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("确认后展示加载态、发送目标 revision，并在成功后关闭弹窗", async () => {
    const server = await startServer();
    const page = await newPage(server);
    try {
      await openUpdateDialog(page);
      await page.click('[data-testid="node-update-confirm"]');

      await page.waitForFunction(
        () => {
          const button = document.querySelector('[data-testid="node-update-confirm"]') as HTMLButtonElement | null;
          return Boolean(button?.hasAttribute("data-loading") || button?.disabled);
        },
        { timeout: 2_000 },
      );

      await waitDialogGone(page);
      const calls = await page.evaluate(
        () => (window as unknown as { __wbUpdateCalls: Array<{ revision?: string }> }).__wbUpdateCalls,
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.revision).toBe(HUB_REVISION);
      expect(
        await page.evaluate(() => (window as unknown as { __wbConfirmCalls: number }).__wbConfirmCalls),
      ).toBe(0);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("更新失败时保留弹窗并展示既有错误提示，可直接取消", async () => {
    const server = await startServer();
    const page = await newPage(server, 1280, 860, { fail: true });
    try {
      await openUpdateDialog(page);
      await page.click('[data-testid="node-update-confirm"]');

      await page.waitForSelector(TOAST_SEL, { timeout: 5_000 });
      expect(await page.evaluate((sel: string) => Boolean(document.querySelector(sel)), DIALOG_SEL)).toBe(true);
      expect(await updateCallCount(page)).toBe(1);

      await page.click('[data-testid="node-update-cancel"]');
      await waitDialogGone(page);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("节点状态先刷新为正在更新、随后请求失败时弹窗仍打开并可重试", async () => {
    const server = await startServer();
    const page = await newPage(server, 1280, 860, { failFirstOnly: true, triggerRunningRefresh: true });
    try {
      await openUpdateDialog(page);
      await page.click('[data-testid="node-update-confirm"]');

      // 服务端先广播 running、再等待远程节点响应；弹窗必须保留。
      await page.waitForFunction(() => (document.body.textContent ?? "").includes("正在更新至"), { timeout: 3_000 });
      expect(await page.evaluate((sel: string) => Boolean(document.querySelector(sel)), DIALOG_SEL)).toBe(true);

      await page.waitForSelector(TOAST_SEL, { timeout: 5_000 });
      await page.waitForFunction(() => {
        const button = document.querySelector('[data-testid="node-update-confirm"]') as HTMLButtonElement | null;
        return Boolean(button && !button.disabled && !button.hasAttribute("data-loading"));
      }, { timeout: 2_000 });
      expect(await page.evaluate((sel: string) => Boolean(document.querySelector(sel)), DIALOG_SEL)).toBe(true);
      expect(await updateCallCount(page)).toBe(1);

      // 失败后保留的弹窗可直接重试，第二次请求成功并关闭弹窗。
      await page.click('[data-testid="node-update-confirm"]');
      await waitDialogGone(page);
      expect(await updateCallCount(page)).toBe(2);
      expect(
        await page.evaluate(() => (window as unknown as { __wbConfirmCalls: number }).__wbConfirmCalls),
      ).toBe(0);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("请求期间节点断连失败时保留弹窗并禁用确认，重连后恢复可重试；其他会话触发更新则关闭未提交弹窗", async () => {
    const server = await startServer();
    const page = await newPage(server, 1280, 860, { disconnectOnFirstAttempt: true });
    try {
      // 场景 A：尚未提交时其他会话启动了更新（running），弹窗应自动关闭且不发请求。
      await openUpdateDialog(page);
      await page.evaluate(() => {
        (window as unknown as { __wbSetNodeState: (p: { inFlight?: boolean }) => void }).__wbSetNodeState({
          inFlight: true,
        });
      });
      await waitDialogGone(page);
      expect(await updateCallCount(page)).toBe(0);

      // 恢复可更新状态，进入场景 B：请求期间节点断连失败。
      await page.evaluate(() => {
        (window as unknown as { __wbSetNodeState: (p: { inFlight?: boolean; connected?: boolean }) => void }).__wbSetNodeState({
          inFlight: false,
          connected: true,
        });
      });
      await openUpdateDialog(page);
      await page.click('[data-testid="node-update-confirm"]');

      await page.waitForSelector(TOAST_SEL, { timeout: 5_000 });
      await page.waitForFunction(() => {
        const button = document.querySelector('[data-testid="node-update-confirm"]') as HTMLButtonElement | null;
        return Boolean(button && button.disabled && !button.hasAttribute("data-loading"));
      }, { timeout: 3_000 });
      expect(await page.evaluate((sel: string) => Boolean(document.querySelector(sel)), DIALOG_SEL)).toBe(true);
      expect(await updateCallCount(page)).toBe(1);

      // 节点恢复在线后，确认按钮重新可用，点击重试成功并关闭弹窗。
      await page.evaluate(() => {
        (window as unknown as { __wbSetNodeState: (p: { connected?: boolean; failed?: boolean }) => void }).__wbSetNodeState({
          connected: true,
          failed: false,
        });
      });
      await page.waitForFunction(() => {
        const button = document.querySelector('[data-testid="node-update-confirm"]') as HTMLButtonElement | null;
        return Boolean(button && !button.disabled && !button.hasAttribute("data-loading"));
      }, { timeout: 3_000 });
      await page.click('[data-testid="node-update-confirm"]');
      await waitDialogGone(page);
      expect(await updateCallCount(page)).toBe(2);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("窄屏下打开侧栏与弹窗不产生横向溢出，按钮可点击", async () => {
    const server = await startServer();
    const page = await newPage(server, 375, 720);
    try {
      await page.click('[data-testid="toggle-sidebar-btn"]');
      await page.waitForSelector('[data-testid="hub-sidebar"].open', { timeout: 5_000 });
      await openUpdateDialog(page);

      const layout = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const confirm = document.querySelector('[data-testid="node-update-confirm"]') as HTMLButtonElement | null;
        const cancel = document.querySelector('[data-testid="node-update-cancel"]') as HTMLButtonElement | null;
        return {
          left: rect.left,
          right: rect.right,
          overflow: document.documentElement.scrollWidth > window.innerWidth,
          confirmInside: Boolean(confirm && confirm.getBoundingClientRect().right <= window.innerWidth),
          cancelInside: Boolean(cancel && cancel.getBoundingClientRect().left >= 0),
        };
      }, DIALOG_SEL);
      expect(layout).not.toBeNull();
      expect(layout!.left).toBeGreaterThanOrEqual(0);
      expect(layout!.right).toBeLessThanOrEqual(375);
      expect(layout!.overflow).toBe(false);
      expect(layout!.confirmInside).toBe(true);
      expect(layout!.cancelInside).toBe(true);

      await page.click('[data-testid="node-update-cancel"]');
      await waitDialogGone(page);
    } finally {
      await page.close();
    }
  }, 30_000);
});
