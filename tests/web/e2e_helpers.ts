import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkbenchServerHandle } from "../../src/server/index.ts";
import { resolveTestBrowser } from "./browser_env.ts";

export interface BrowserPage {
  setViewport(vp: { width: number; height: number }): Promise<void>;
  goto(url: string, opts?: { waitUntil?: string }): Promise<unknown>;
  waitForSelector(sel: string, opts?: { timeout?: number }): Promise<unknown>;
  waitForFunction(
    fn: string | ((...args: unknown[]) => boolean),
    opts?: { timeout?: number },
    ...args: unknown[]
  ): Promise<unknown>;
  click(sel: string): Promise<void>;
  select(sel: string, ...values: string[]): Promise<string[]>;
  type(sel: string, text: string): Promise<void>;
  evaluate<T>(fn: (...args: any[]) => T, ...args: any[]): Promise<T>;
  evaluateOnNewDocument(fn: (...args: any[]) => void, ...args: any[]): Promise<unknown>;
  mouse: {
    move(x: number, y: number, opts?: { steps?: number }): Promise<void>;
    down(): Promise<void>;
    up(): Promise<void>;
  };
  keyboard: {
    press(key: string): Promise<void>;
  };
  on(ev: string, fn: (...args: any[]) => void): void;
  close(): Promise<void>;
}

export interface BrowserInstance {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

export const browserEnv = resolveTestBrowser();
export const HAS_BROWSER = browserEnv !== null;

export async function launchE2eBrowser(): Promise<BrowserInstance | null> {
  if (!browserEnv) return null;
  const mod = (await import(browserEnv.puppeteerPath)) as {
    default: { launch(opts: Record<string, unknown>): Promise<BrowserInstance> };
  };
  return await mod.default.launch({
    executablePath: browserEnv.chromePath,
    headless: browserEnv.headless,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
}

export async function closeE2eBrowser(browser: BrowserInstance | null): Promise<void> {
  if (browser) {
    await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 2000))]);
  }
}

export function initGitRepoIn(tempDirs: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-e2e-"));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "calc.ts"), "export const add = (a: number, b: number) => a + b;\n");
  execFileSync("git", ["add", "calc.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });
  return dir;
}

export function cleanupE2eResources(
  servers: WorkbenchServerHandle[],
  tempDirs: string[],
  origHubDir: string | undefined,
): void {
  while (servers.length > 0) servers.pop()!.stop();
  if (origHubDir === undefined) delete process.env.WORKBENCH_HUB_DIR;
  else process.env.WORKBENCH_HUB_DIR = origHubDir;
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
}

export async function clickReady(page: BrowserPage, selector: string, timeout = 5000): Promise<void> {
  const readySel = `${selector}:not([disabled])`;
  await page.waitForSelector(readySel, { timeout });
  // 右下角 Sonner 提示可能短暂遮挡按钮中心；元素已在视口内时等待其真正可命中。
  // Radix 弹窗/菜单打开时 body 为 pointer-events:none，命中检测不适用，直接放行。
  await page.waitForFunction(
    (sel: unknown) => {
      const el = document.querySelector(String(sel));
      if (!el) return false;
      if (getComputedStyle(document.body).pointerEvents === "none") return true;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return true;
      const hit = document.elementFromPoint(cx, cy);
      return hit === el || el.contains(hit);
    },
    { timeout },
    readySel,
  );
  try {
    await page.click(readySel);
  } catch (err) {
    if (err instanceof Error && err.message.includes("detached")) {
      await page.waitForSelector(readySel, { timeout });
      await page.click(readySel);
      return;
    }
    throw err;
  }
}

/** 由测试写入标记文件决定结束时机，避免固定时长等待与真实模型依赖。 */
export function controlledRunScript(doneFile: string, codeFile: string): string {
  const q = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;
  return `echo active-run-started; while [ ! -f ${q(doneFile)} ]; do sleep 0.05; done; exit "$(cat ${q(codeFile)} 2>/dev/null || echo 0)"`;
}

export function installedCodexHarness() {
  return {
    id: "codex" as const,
    label: "Codex CLI",
    subscription: "ChatGPT Plus",
    installed: true,
    executable: "codex",
    models: [{ id: "gpt-6-astra", tier: "sota" as const, source: "detected" as const }],
    defaultModel: "gpt-6-astra",
    detectedAt: Date.now(),
  };
}

/** 首次连接前阻止 WebSocket 建连，用于验证连接后的运行快照校正。 */
export async function installBlockedWebSocket(page: BrowserPage, initiallyBlocked = true): Promise<void> {
  await page.evaluateOnNewDocument((blocked: boolean) => {
    const w = window as unknown as {
      WebSocket: typeof WebSocket;
      __wbSockets: WebSocket[];
      __wbBlockSockets: boolean;
    };
    const Native = w.WebSocket;
    const sockets: WebSocket[] = [];
    function Wrapped(url: string, protocols?: string | string[]) {
      if (w.__wbBlockSockets) {
        const listeners: Record<string, Array<() => void>> = {};
        const fake = {
          readyState: 3,
          addEventListener(type: string, fn: () => void) {
            (listeners[type] ??= []).push(fn);
            if (type === "close") setTimeout(() => (listeners.close ?? []).forEach((cb) => cb()), 0);
          },
          removeEventListener() {},
          close() {
            (listeners.close ?? []).forEach((cb) => cb());
          },
        };
        return fake;
      }
      const ws = new Native(url, protocols);
      sockets.push(ws);
      return ws;
    }
    Wrapped.prototype = Native.prototype;
    Object.assign(Wrapped, {
      CONNECTING: Native.CONNECTING,
      OPEN: Native.OPEN,
      CLOSING: Native.CLOSING,
      CLOSED: Native.CLOSED,
    });
    w.WebSocket = Wrapped as unknown as typeof WebSocket;
    w.__wbSockets = sockets;
    w.__wbBlockSockets = blocked;
  }, initiallyBlocked);
}

/** 将 Hub 状态响应在页面侧挂起直到释放：请求已生成快照，仅延迟把响应交给页面。 */
export async function installHeldHubState(page: BrowserPage, initiallyHeld = true): Promise<void> {
  await page.evaluateOnNewDocument((held: boolean) => {
    const w = window as unknown as {
      fetch: typeof fetch;
      __wbHubStateRequests: number;
      __wbHubStateHeld: boolean;
      __wbHoldHubState: () => void;
      __wbReleaseHubState: () => void;
    };
    const native = w.fetch.bind(window);
    const pendingReleases: Array<() => void> = [];
    w.__wbHubStateRequests = 0;
    w.__wbHubStateHeld = held;
    w.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      if (url.includes("/api/hub/state")) {
        w.__wbHubStateRequests += 1;
        if (w.__wbHubStateHeld) {
          const pending = native(input as RequestInfo, init);
          return new Promise<Response>((resolve, reject) => {
            pendingReleases.push(() => pending.then(resolve, reject));
          });
        }
      }
      return native(input as RequestInfo, init);
    }) as typeof fetch;
    w.__wbHoldHubState = () => {
      w.__wbHubStateHeld = true;
    };
    w.__wbReleaseHubState = () => {
      w.__wbHubStateHeld = false;
      for (const release of pendingReleases.splice(0)) release();
    };
  }, initiallyHeld);
}

/** 将首个 Agent 调度响应在页面侧挂起，模拟迟到的调度响应。 */
export async function installHeldRunStart(page: BrowserPage): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    const w = window as unknown as {
      fetch: typeof fetch;
      __wbRunStartHeld: boolean;
      __wbRunStartPending: boolean;
      __wbReleaseRunStart: () => void;
    };
    const native = w.fetch.bind(window);
    let release: (() => void) | null = null;
    w.__wbRunStartHeld = true;
    w.__wbRunStartPending = false;
    w.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (w.__wbRunStartHeld && method === "POST" && /\/api\/requirements\/[^/]+\/run(?:\?|$)/.test(url)) {
        w.__wbRunStartHeld = false;
        w.__wbRunStartPending = true;
        const pending = native(input as RequestInfo, init);
        return new Promise<Response>((resolve, reject) => {
          release = () => pending.then(resolve, reject);
        });
      }
      return native(input as RequestInfo, init);
    }) as typeof fetch;
    w.__wbReleaseRunStart = () => {
      w.__wbRunStartPending = false;
      release?.();
      release = null;
    };
  });
}
