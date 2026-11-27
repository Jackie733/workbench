import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequirement, finishAgentRun, initProject, propose, startAgentRun } from "../../src/core/engine.ts";
import { registerHubProject } from "../../src/hub/registry.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";
import {
  browserEnv,
  cleanupE2eResources,
  clickReady,
  closeE2eBrowser,
  initGitRepoIn,
  launchE2eBrowser,
  type BrowserInstance,
  type BrowserPage,
} from "./e2e_helpers.ts";

const HAS_BROWSER = browserEnv !== null;
const TOAST_SEL = '[data-slot="toast-root"]:not([data-ending-style])';

interface RequirementStubOptions {
  fail?: boolean;
  delayMs?: number;
}

const tempDirs: string[] = [];
const servers: WorkbenchServerHandle[] = [];
const origHubDir = process.env.WORKBENCH_HUB_DIR;
let browser: BrowserInstance | null = null;

async function startServer(): Promise<WorkbenchServerHandle> {
  const root = initGitRepoIn(tempDirs);
  await initProject(root, { name: "LoadingStateRepo", privacyMode: "local" });
  const server = await startWorkbenchServer({ root, port: 0, writeDiscovery: false });
  servers.push(server);
  return server;
}

/** 预置需求（可选方案）并启动服务，供标注与主操作切换场景使用。 */
async function startLoadedServer(options: { design?: boolean; hub?: boolean } = {}): Promise<WorkbenchServerHandle> {
  const root = initGitRepoIn(tempDirs);
  await initProject(root, { name: options.hub ? "LoadingHubRepo" : "LoadingLoadedRepo", privacyMode: "local" });
  await createRequirement(root, {
    goal: "# REQ-019 加载状态回归需求\n\n用于加载状态回归。",
    criteria: [{ id: "AC-1", description: "echo 验证", required: true, command: "echo ok" }],
  });
  if (options.design) {
    await propose(root, "REQ-001", { designMarkdown: "# 方案\n实现并验证。", actor: "agent" });
  }
  if (options.hub) {
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-loading-hub-"));
    tempDirs.push(hubDir);
    process.env.WORKBENCH_HUB_DIR = hubDir;
    registerHubProject(root, { name: "LoadingHub", activate: true });
  }
  const server = await startWorkbenchServer({
    root,
    port: 0,
    writeDiscovery: false,
    hubMode: Boolean(options.hub),
  });
  servers.push(server);
  return server;
}

/** 预置一个带失败运行的需求，供回退重试切换停止按钮场景使用。 */
async function startFailedRunServer(): Promise<WorkbenchServerHandle> {
  const root = initGitRepoIn(tempDirs);
  await initProject(root, { name: "LoadingRetryRepo", privacyMode: "local" });
  await createRequirement(root, {
    goal: "# REQ-019 回退重试回归需求\n\n用于停止按钮回归。",
    criteria: [{ id: "AC-1", description: "echo 验证", required: true, command: "echo ok" }],
  });
  const startedAt = Date.now();
  await startAgentRun(root, "REQ-001", {
    id: "run-failed-1",
    action: "design",
    harness: "omp",
    model: "opencode-go/deepseek-v4.1-flash",
    status: "running",
    startedAt,
    endedAt: null,
    exitCode: null,
    durationMs: 0,
    logPath: "",
  });
  await finishAgentRun(
    root,
    "REQ-001",
    "run-failed-1",
    {
      status: "failed",
      endedAt: startedAt + 1_000,
      exitCode: 1,
      durationMs: 1_000,
      rateLimited: true,
    },
    "",
  );
  const server = await startWorkbenchServer({ root, port: 0, writeDiscovery: false });
  servers.push(server);
  return server;
}

/** 在页面侧挂起运行调度响应，直到测试显式释放。 */
async function installRunHoldStub(page: BrowserPage): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    const w = window as unknown as {
      fetch: typeof fetch;
      __wbRunHoldCount: number;
      __wbRunHeld: boolean;
      __wbRunSettled: boolean;
      __wbReqRefreshDone: number;
      __wbReleaseRun: () => void;
    };
    const nativeFetch = w.fetch.bind(window);
    let release: (() => void) | null = null;
    w.__wbRunHoldCount = 0;
    w.__wbRunHeld = false;
    w.__wbRunSettled = false;
    w.__wbReqRefreshDone = 0;
    w.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      const url = new URL(raw, window.location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (method === "POST" && /\/api\/requirements\/[^/]+\/run$/.test(url.pathname)) {
        w.__wbRunHoldCount += 1;
        w.__wbRunHeld = true;
        const pending = nativeFetch(input as RequestInfo, init);
        void pending.then(() => {
          w.__wbRunSettled = true;
        });
        return new Promise<Response>((resolve, reject) => {
          release = () => pending.then(resolve, reject);
        });
      }
      if (
        method === "GET" &&
        /\/api\/requirements\/[^/]+$/.test(url.pathname) &&
        w.__wbRunSettled
      ) {
        return nativeFetch(input as RequestInfo, init).then((response) => {
          w.__wbReqRefreshDone += 1;
          return response;
        });
      }
      return nativeFetch(input as RequestInfo, init);
    }) as typeof fetch;
    w.__wbReleaseRun = () => {
      w.__wbRunHeld = false;
      release?.();
      release = null;
    };
  });
}

/** 让调度 POST 正常返回，但挂起随后触发的需求详情刷新，用于验证按钮切换后的局部状态。 */
async function installRequirementRefreshHoldStub(page: BrowserPage): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    const w = window as unknown as {
      fetch: typeof fetch;
      __wbRetryPostCount: number;
      __wbReqRefreshHeld: number;
      __wbReleaseReqRefresh: () => void;
    };
    const nativeFetch = w.fetch.bind(window);
    let release: (() => void) | null = null;
    let holdNextRequirementGet = false;
    w.__wbRetryPostCount = 0;
    w.__wbReqRefreshHeld = 0;
    w.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      const url = new URL(raw, window.location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (method === "POST" && /\/api\/requirements\/[^/]+\/run$/.test(url.pathname)) {
        w.__wbRetryPostCount += 1;
        holdNextRequirementGet = true;
        return nativeFetch(input as RequestInfo, init);
      }
      if (method === "GET" && /\/api\/requirements\/[^/]+$/.test(url.pathname) && holdNextRequirementGet) {
        holdNextRequirementGet = false;
        w.__wbReqRefreshHeld += 1;
        const pending = nativeFetch(input as RequestInfo, init);
        return new Promise<Response>((resolve, reject) => {
          release = () => pending.then(resolve, reject);
        });
      }
      return nativeFetch(input as RequestInfo, init);
    }) as typeof fetch;
    w.__wbReleaseReqRefresh = () => {
      release?.();
      release = null;
    };
  });
}

interface PricingStubOptions {
  saveDelayMs?: number;
}

/** 清理请求完成后挂起定价查询刷新，并延迟保存请求，用于验证互斥按钮不会同时转圈。 */
async function installPricingHoldStub(page: BrowserPage, options: PricingStubOptions = {}): Promise<void> {
  await page.evaluateOnNewDocument(
    (opts: PricingStubOptions & { saveDelayMs: number }) => {
      const w = window as unknown as {
        fetch: typeof fetch;
        __wbHoldPricingGet: boolean;
        __wbPricingGetHeld: number;
        __wbSavePricingCount: number;
        __wbReleasePricingGet: () => void;
      };
      const nativeFetch = w.fetch.bind(window);
      const pendingReleases: Array<() => void> = [];
      w.__wbHoldPricingGet = false;
      w.__wbPricingGetHeld = 0;
      w.__wbSavePricingCount = 0;
      w.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const raw = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
        const url = new URL(raw, window.location.href);
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        if (url.pathname === "/api/hub/insights/prune" && method === "POST") {
          return nativeFetch(input as RequestInfo, init).then((response) => {
            w.__wbHoldPricingGet = true;
            return response;
          });
        }
        if (url.pathname === "/api/hub/insights/pricing" && method === "GET" && w.__wbHoldPricingGet) {
          w.__wbPricingGetHeld += 1;
          const pending = nativeFetch(input as RequestInfo, init);
          return new Promise<Response>((resolve, reject) => {
            pendingReleases.push(() => pending.then(resolve, reject));
          });
        }
        if (url.pathname === "/api/hub/insights/pricing" && method === "PUT") {
          w.__wbSavePricingCount += 1;
          const pending = nativeFetch(input as RequestInfo, init);
          return new Promise<Response>((resolve, reject) => {
            setTimeout(() => pending.then(resolve, reject), opts.saveDelayMs);
          });
        }
        return nativeFetch(input as RequestInfo, init);
      }) as typeof fetch;
      w.__wbReleasePricingGet = () => {
        w.__wbHoldPricingGet = false;
        for (const release of pendingReleases.splice(0)) release();
      };
    },
    { saveDelayMs: 800, ...options },
  );
}

async function openRequirementPage(page: BrowserPage, id = "REQ-001"): Promise<void> {
  await page.waitForSelector(`[data-testid="req-row-${id}"]`, { timeout: 10_000 });
  await clickReady(page, `[data-testid="req-row-${id}"]`);
  await page.waitForSelector('[data-testid="tab-spec"]', { timeout: 5_000 });
  await clickReady(page, '[data-testid="tab-spec"]');
}

/** 延迟 POST /api/requirements 的响应，记录请求次数，并收集未处理的 Promise 拒绝。 */
async function installRequirementStub(
  page: BrowserPage,
  options: RequirementStubOptions = {},
): Promise<void> {
  await page.evaluateOnNewDocument(
    (opts: RequirementStubOptions & { delayMs: number }) => {
      const w = window as unknown as {
        fetch: typeof fetch;
        __wbReqPostCount: number;
        __wbUnhandledRejections: string[];
      };
      const nativeFetch = w.fetch.bind(window);
      w.__wbReqPostCount = 0;
      w.__wbUnhandledRejections = [];
      window.addEventListener("unhandledrejection", (event) => {
        w.__wbUnhandledRejections.push(String(event.reason));
      });

      w.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const raw = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
        const url = new URL(raw, window.location.href);
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        if (url.pathname === "/api/requirements" && method === "POST") {
          w.__wbReqPostCount += 1;
          if (opts.fail) {
            return new Promise<Response>((resolve) => {
              setTimeout(() => {
                resolve(
                  new Response(JSON.stringify({ error: { code: "execution_failed", message: "boom" } }), {
                    status: 500,
                    headers: { "content-type": "application/json" },
                  }),
                );
              }, opts.delayMs);
            });
          }
          const pending = nativeFetch(input as RequestInfo, init);
          return new Promise<Response>((resolve, reject) => {
            setTimeout(() => pending.then(resolve, reject), opts.delayMs);
          });
        }
        return nativeFetch(input as RequestInfo, init);
      }) as typeof fetch;
    },
    { delayMs: 900, ...options },
  );
}

async function newPage(server: WorkbenchServerHandle, options: RequirementStubOptions = {}): Promise<BrowserPage> {
  const page = await browser!.newPage();
  await page.setViewport({ width: 1280, height: 860 });
  await installRequirementStub(page, options);
  await page.goto(server.url, { waitUntil: "networkidle0" });
  return page;
}

async function openNewRequirementModal(page: BrowserPage): Promise<void> {
  const target = await page.evaluate(() => {
    const empty = document.querySelector('[data-testid="empty-new-req-btn"]') as HTMLElement | null;
    if (empty) {
      const r = empty.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return "empty";
    }
    return "sidebar";
  });
  if (target === "empty") {
    await page.click('[data-testid="empty-new-req-btn"]');
  } else {
    await page.click('[data-testid="new-req-btn"]');
  }
  await page.waitForSelector('[data-testid="new-req-goal"]', { timeout: 10_000 });
}

async function reqPostCount(page: BrowserPage): Promise<number> {
  return page.evaluate(() => (window as unknown as { __wbReqPostCount: number }).__wbReqPostCount);
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

suite("REQ-019 loading 状态真实浏览器回归", () => {
  test("新建需求保存草稿时只显示局部 loading，连点只发一次请求，完成后恢复", async () => {
    const server = await startServer();
    const page = await newPage(server);
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));
    try {
      await openNewRequirementModal(page);
      await page.type('[data-testid="new-req-goal"]', "REQ-019 局部 loading 浏览器回归");

      // 在同一次同步调用中连续触发两次 onClick，此时 React 尚未提交禁用态，
      // 只有 pendingRef 同步防重入能拦住第二次动作。
      const duplicateClick = await page.evaluate(() => {
        const button = document.querySelector('[data-testid="save-draft-btn"]') as
          | (HTMLButtonElement & Record<string, unknown>)
          | null;
        if (!button) return { found: false, called: 0 };
        const propsKey = Object.keys(button).find((key) => key.startsWith("__reactProps$"));
        if (!propsKey) return { found: false, called: 0 };
        const props = button[propsKey] as { onClick?: (event: MouseEvent) => unknown };
        if (!props.onClick) return { found: false, called: 0 };
        const event = new MouseEvent("click", { bubbles: true, cancelable: true });
        props.onClick(event);
        props.onClick(event);
        return { found: true, called: 2 };
      });
      expect(duplicateClick).toEqual({ found: true, called: 2 });

      await page.waitForFunction(
        () => {
          const draft = document.querySelector('[data-testid="save-draft-btn"]') as HTMLButtonElement | null;
          const dispatch = document.querySelector(
            '[data-testid="create-and-dispatch-btn"]',
          ) as HTMLButtonElement | null;
          if (!draft || !dispatch) return false;
          const loading =
            draft.hasAttribute("data-loading") &&
            draft.disabled &&
            draft.getAttribute("aria-busy") === "true" &&
            Boolean(draft.querySelector('[data-slot="button-loading-indicator"]')) &&
            dispatch.disabled &&
            !dispatch.hasAttribute("data-loading") &&
            !dispatch.querySelector('[data-slot="button-loading-indicator"]');
          if (!loading) return false;
          // 在观测到 loading 的同一时刻固化计算样式，避免请求快速完成后弹窗关闭导致读取到 null。
          const w = window as unknown as {
            __wbLoadingVisuals?: { iconOpacity: string; spinnerOpacity: string; buttonOpacity: string };
          };
          const icon = draft.querySelector("svg:not([data-slot='button-loading-indicator'])");
          const spinner = draft.querySelector('[data-slot="button-loading-indicator"]');
          w.__wbLoadingVisuals = {
            iconOpacity: icon ? getComputedStyle(icon).opacity : "",
            spinnerOpacity: spinner ? getComputedStyle(spinner).opacity : "",
            buttonOpacity: getComputedStyle(draft).opacity,
          };
          return true;
        },
        { timeout: 3_000 },
      );

      expect(await reqPostCount(page)).toBe(1);

      const loadingVisuals = await page.evaluate(
        () => (window as unknown as { __wbLoadingVisuals?: Record<string, string> }).__wbLoadingVisuals ?? null,
      );
      expect(loadingVisuals).not.toBeNull();
      expect(loadingVisuals!.iconOpacity).toBe("0");
      expect(Number(loadingVisuals!.spinnerOpacity)).toBeGreaterThan(0);
      expect(loadingVisuals!.buttonOpacity).toBe("1");

      await page.waitForFunction(
        () => !document.querySelector('[data-testid="new-req-modal"]'),
        { timeout: 10_000 },
      );
      expect(await reqPostCount(page)).toBe(1);
      expect(
        await page.evaluate(
          () => !document.querySelector('[data-testid="save-draft-btn"]') && !document.querySelector("[data-loading]"),
        ),
      ).toBe(true);
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("新建需求失败时按钮恢复可点击、弹窗保留且沿用错误提示", async () => {
    const server = await startServer();
    const page = await newPage(server, { fail: true });
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));
    try {
      await openNewRequirementModal(page);
      await page.type('[data-testid="new-req-goal"]', "REQ-019 失败恢复回归");
      await page.click('[data-testid="save-draft-btn"]');

      await page.waitForFunction(
        () => {
          const button = document.querySelector('[data-testid="save-draft-btn"]') as HTMLButtonElement | null;
          return Boolean(button?.hasAttribute("data-loading"));
        },
        { timeout: 3_000 },
      );

      await page.waitForSelector(TOAST_SEL, { timeout: 5_000 });
      await page.waitForFunction(
        () => {
          const button = document.querySelector('[data-testid="save-draft-btn"]') as HTMLButtonElement | null;
          return Boolean(
            button &&
              !button.disabled &&
              !button.hasAttribute("data-loading") &&
              !button.querySelector('[data-slot="button-loading-indicator"]'),
          );
        },
        { timeout: 3_000 },
      );

      expect(await reqPostCount(page)).toBe(1);
      expect(
        await page.evaluate(() => Boolean(document.querySelector('[data-testid="new-req-modal"]'))),
      ).toBe(true);
      expect(
        await page.evaluate(
          () => (window as unknown as { __wbUnhandledRejections: string[] }).__wbUnhandledRejections.length,
        ),
      ).toBe(0);
      expect(pageErrors).toEqual([]);

      await page.click('[data-testid="save-draft-btn"]');
      await page.waitForFunction(
        () => Boolean((document.querySelector('[data-testid="save-draft-btn"]') as HTMLButtonElement | null)?.hasAttribute("data-loading")),
        { timeout: 3_000 },
      );
      expect(await reqPostCount(page)).toBe(2);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("标注提问在延迟调度期间保持弹窗与按钮 loading，请求结束后才切换讨论区", async () => {
    const server = await startLoadedServer();
    const page = await browser!.newPage();
    await page.setViewport({ width: 1280, height: 860 });
    await installRunHoldStub(page);
    await page.goto(server.url, { waitUntil: "networkidle0" });
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));
    try {
      await openRequirementPage(page);
      await page.waitForSelector('[data-action="annotate-anchor"]', { timeout: 5_000 });
      await clickReady(page, '[data-action="annotate-anchor"]');
      await page.waitForSelector('[data-testid="annotate-modal"]', { timeout: 5_000 });
      await page.type('[data-testid="annotate-msg"]', "延迟响应期间保持 loading");

      await clickReady(page, '[data-testid="annotate-ask-btn"]');
      await page.waitForFunction(
        () => {
          const button = document.querySelector('[data-testid="annotate-ask-btn"]') as HTMLButtonElement | null;
          return Boolean(
            button?.hasAttribute("data-loading") &&
              button.disabled &&
              document.querySelector('[data-testid="annotate-modal"]'),
          );
        },
        { timeout: 3_000 },
      );
      expect(
        await page.evaluate(() => (window as unknown as { __wbRunHoldCount: number }).__wbRunHoldCount),
      ).toBe(1);

      // 延迟响应期间弹窗和所点击按钮都必须保留。
      await Bun.sleep(300);
      const held = await page.evaluate(() => {
        const button = document.querySelector('[data-testid="annotate-ask-btn"]') as HTMLButtonElement | null;
        return {
          modal: Boolean(document.querySelector('[data-testid="annotate-modal"]')),
          loading: Boolean(button?.hasAttribute("data-loading")),
          spinner: Boolean(button?.querySelector('[data-slot="button-loading-indicator"]')),
        };
      });
      expect(held).toEqual({ modal: true, loading: true, spinner: true });

      await page.evaluate(() => (window as unknown as { __wbReleaseRun: () => void }).__wbReleaseRun());
      await page.waitForFunction(() => !document.querySelector('[data-testid="annotate-modal"]'), {
        timeout: 10_000,
      });
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("旧请求完成后不会关闭用户重新打开的新需求弹窗", async () => {
    const server = await startLoadedServer();
    const page = await browser!.newPage();
    await page.setViewport({ width: 1280, height: 860 });
    await installRunHoldStub(page);
    await page.goto(server.url, { waitUntil: "networkidle0" });
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));
    try {
      await openRequirementPage(page);
      await page.waitForSelector('[data-action="annotate-anchor"]', { timeout: 5_000 });
      await clickReady(page, '[data-action="annotate-anchor"]');
      await page.waitForSelector('[data-testid="annotate-modal"]', { timeout: 5_000 });
      await page.type('[data-testid="annotate-msg"]', "旧请求关闭新弹窗回归");
      await clickReady(page, '[data-testid="annotate-ask-btn"]');
      await page.waitForFunction(
        () => (window as unknown as { __wbRunHoldCount: number }).__wbRunHoldCount >= 1,
        { timeout: 5_000 },
      );

      // 用户取消原标注弹窗，再打开新建需求并输入草稿。
      await clickReady(page, '[data-testid="annotate-cancel-btn"]');
      await page.waitForFunction(() => !document.querySelector('[data-testid="annotate-modal"]'), {
        timeout: 5_000,
      });
      await clickReady(page, '[data-testid="new-req-btn"]');
      await page.waitForSelector('[data-testid="new-req-goal"]', { timeout: 5_000 });
      await page.type('[data-testid="new-req-goal"]', "新弹窗草稿必须保留");

      await page.evaluate(() => (window as unknown as { __wbReleaseRun: () => void }).__wbReleaseRun());
      await page.waitForFunction(
        () => (window as unknown as { __wbReqRefreshDone: number }).__wbReqRefreshDone > 0,
        { timeout: 10_000 },
      );
      await Bun.sleep(150);

      const preserved = await page.evaluate(() => {
        const modal = document.querySelector('[data-testid="new-req-modal"]');
        const goal = document.querySelector('[data-testid="new-req-goal"]') as HTMLTextAreaElement | null;
        return {
          modal: Boolean(modal),
          goal: goal?.value ?? "",
        };
      });
      expect(preserved).toEqual({ modal: true, goal: "新弹窗草稿必须保留" });
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("回退重试启动新运行后，停止按钮不继承加载状态且可点击", async () => {
    const server = await startFailedRunServer();
    const page = await browser!.newPage();
    await page.setViewport({ width: 1280, height: 860 });
    await installRequirementRefreshHoldStub(page);
    await page.goto(server.url, { waitUntil: "networkidle0" });
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));
    try {
      await openRequirementPage(page);
      await clickReady(page, '[data-testid="tab-timeline"]');
      await page.waitForSelector('[data-testid="view-run-output-btn-run-failed-1"]', { timeout: 8_000 });
      await clickReady(page, '[data-testid="view-run-output-btn-run-failed-1"]');
      await page.waitForSelector('[data-testid="retry-fallback-btn"]', { timeout: 8_000 });

      await clickReady(page, '[data-testid="retry-fallback-btn"]');
      await page.waitForFunction(
        () => {
          const w = window as unknown as { __wbReqRefreshHeld: number; __wbRetryPostCount: number };
          const cancel = document.querySelector('[data-testid="cancel-run-btn"]') as HTMLButtonElement | null;
          return Boolean(
            w.__wbRetryPostCount === 1 &&
              w.__wbReqRefreshHeld > 0 &&
              cancel &&
              !cancel.disabled &&
              !cancel.hasAttribute("data-loading") &&
              !cancel.querySelector('[data-slot="button-loading-indicator"]'),
          );
        },
        { timeout: 10_000 },
      );

      expect(
        await page.evaluate(() => !document.querySelector('[data-testid="retry-fallback-btn"]')),
      ).toBe(true);
      expect(pageErrors).toEqual([]);

      await page.evaluate(() =>
        (window as unknown as { __wbReleaseReqRefresh: () => void }).__wbReleaseReqRefresh(),
      );
    } finally {
      await page.close();
    }
  }, 30_000);

  test("批准后主操作切换不会继承上一动作的 loading，仅保留新按钮的禁用态", async () => {
    const server = await startLoadedServer({ design: true });
    const page = await browser!.newPage();
    await page.setViewport({ width: 1280, height: 860 });
    await installRunHoldStub(page);
    await page.goto(server.url, { waitUntil: "networkidle0" });
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));
    try {
      await openRequirementPage(page);
      await page.waitForSelector('[data-testid="action-approve_and_implement"]', { timeout: 8_000 });
      await clickReady(page, '[data-testid="action-approve_and_implement"]');

      await page.waitForFunction(
        () => (window as unknown as { __wbRunHoldCount: number }).__wbRunHoldCount >= 1,
        { timeout: 10_000 },
      );
      await page.waitForSelector('[data-testid="action-dispatch_implement"]', { timeout: 10_000 });

      const switched = await page.evaluate(() => {
        const button = document.querySelector(
          '[data-testid="action-dispatch_implement"]',
        ) as HTMLButtonElement | null;
        return {
          oldGone: !document.querySelector('[data-testid="action-approve_and_implement"]'),
          loading: Boolean(button?.hasAttribute("data-loading")),
          spinner: Boolean(button?.querySelector('[data-slot="button-loading-indicator"]')),
          disabled: Boolean(button?.disabled),
        };
      });
      expect(switched.oldGone).toBe(true);
      expect(switched.loading).toBe(false);
      expect(switched.spinner).toBe(false);
      // 调度请求仍在途时，新按钮只应因全局互斥被禁用，而不是继承旧动作的 loading。
      expect(switched.disabled).toBe(true);

      await page.evaluate(() => (window as unknown as { __wbReleaseRun: () => void }).__wbReleaseRun());
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("定价清理请求结束即停止 loading，刷新挂起时保存按钮不会与其同时转圈", async () => {
    const server = await startLoadedServer({ hub: true });
    const page = await browser!.newPage();
    await page.setViewport({ width: 1280, height: 860 });
    await installPricingHoldStub(page);
    await page.goto(server.url, { waitUntil: "networkidle0" });
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));
    try {
      await clickReady(page, '[data-testid="topbar-insights-btn"]');
      await page.waitForSelector('[data-testid="insights-view"]', { timeout: 8_000 });
      await clickReady(page, '[data-testid="insights-pricing-btn"]');
      await page.waitForSelector('[data-testid="prune-traces-now-btn"]', { timeout: 8_000 });

      await clickReady(page, '[data-testid="prune-traces-now-btn"]');
      await page.waitForFunction(
        () => {
          const w = window as unknown as { __wbPricingGetHeld: number };
          const prune = document.querySelector('[data-testid="prune-traces-now-btn"]') as HTMLButtonElement | null;
          return Boolean(
            w.__wbPricingGetHeld > 0 &&
              prune &&
              !prune.disabled &&
              !prune.hasAttribute("data-loading") &&
              !prune.querySelector('[data-slot="button-loading-indicator"]'),
          );
        },
        { timeout: 10_000 },
      );

      await clickReady(page, '[data-testid="save-pricing-btn"]');
      await page.waitForFunction(
        () => {
          const save = document.querySelector('[data-testid="save-pricing-btn"]') as HTMLButtonElement | null;
          return Boolean(save?.hasAttribute("data-loading") && save.disabled);
        },
        { timeout: 3_000 },
      );

      const simultaneous = await page.evaluate(() => {
        const save = document.querySelector('[data-testid="save-pricing-btn"]') as HTMLButtonElement | null;
        const prune = document.querySelector('[data-testid="prune-traces-now-btn"]') as HTMLButtonElement | null;
        return {
          saveLoading: Boolean(save?.hasAttribute("data-loading")),
          pruneLoading: Boolean(prune?.hasAttribute("data-loading")),
          pruneDisabled: Boolean(prune?.disabled),
          saveCount: (window as unknown as { __wbSavePricingCount: number }).__wbSavePricingCount,
        };
      });
      expect(simultaneous.saveLoading).toBe(true);
      expect(simultaneous.pruneLoading).toBe(false);
      expect(simultaneous.pruneDisabled).toBe(true);
      expect(simultaneous.saveCount).toBe(1);

      await page.evaluate(() => (window as unknown as { __wbReleasePricingGet: () => void }).__wbReleasePricingGet());
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);
});
