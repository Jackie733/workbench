import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createRequirement, initProject } from "../../src/core/engine.ts";
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

type MediaEmulationPage = BrowserPage & {
  emulateMediaFeatures(features: Array<{ name: string; value: string }>): Promise<void>;
};

const tempDirs: string[] = [];
const servers: WorkbenchServerHandle[] = [];
const origHubDir = process.env.WORKBENCH_HUB_DIR;
let browser: BrowserInstance | null = null;

async function startProjectServer(): Promise<WorkbenchServerHandle> {
  const root = initGitRepoIn(tempDirs);
  await initProject(root, { name: "WorkspaceLoadingRepo", privacyMode: "local" });
  await createRequirement(root, {
    goal: "# REQ-001 加载态测试需求\n\n验证需求详情加载态居中布局与错误重试。",
    criteria: [{ id: "AC-1", description: "验证命令", required: true, command: "echo ok" }],
  });
  const server = await startWorkbenchServer({ root, port: 0, writeDiscovery: false });
  servers.push(server);
  return server;
}

/** 拦截需求详情 GET 请求：支持挂起放行、或首轮返回 500 后重试恢复。 */
async function installDetailFetchInterceptor(
  page: BrowserPage,
  mode: { kind: "hold" } | { kind: "failOnce"; errorMessage: string },
): Promise<void> {
  await page.evaluateOnNewDocument((cfg: { kind: "hold" } | { kind: "failOnce"; errorMessage: string }) => {
    const w = window as unknown as {
      fetch: typeof fetch;
      __wbDetailCalls: number;
      __wbReleaseDetail: () => void;
    };
    const nativeFetch = w.fetch.bind(window);
    const pendingReleases: Array<() => void> = [];
    let released = false;
    w.__wbDetailCalls = 0;

    w.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      const url = new URL(raw, window.location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (method === "GET" && /^\/api\/requirements\/REQ-\d+$/.test(url.pathname)) {
        w.__wbDetailCalls += 1;
        if (cfg.kind === "hold" && !released) {
          const pending = nativeFetch(input as RequestInfo, init);
          return new Promise<Response>((resolve, reject) => {
            pendingReleases.push(() => pending.then(resolve, reject));
          });
        }
        if (cfg.kind === "failOnce" && w.__wbDetailCalls === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: { code: "execution_failed", message: cfg.errorMessage },
              }),
              {
                status: 500,
                headers: { "Content-Type": "application/json" },
              },
            ),
          );
        }
      }
      return nativeFetch(input as RequestInfo, init);
    }) as typeof fetch;

    w.__wbReleaseDetail = () => {
      released = true;
      for (const release of pendingReleases.splice(0)) release();
    };
  }, mode);
}

describe.skipIf(!HAS_BROWSER)("workspace detail loading state browser E2E", () => {
  beforeAll(async () => {
    browser = await launchE2eBrowser();
  });

  afterEach(() => {
    cleanupE2eResources(servers, tempDirs, origHubDir);
  });

  afterAll(async () => {
    await closeE2eBrowser(browser);
  });

  test("renders centered loading card with skeleton during slow fetch and switches seamlessly to detail", async () => {
    const server = await startProjectServer();
    const page = await browser!.newPage();
    try {
      await page.setViewport({ width: 1280, height: 800 });
      await installDetailFetchInterceptor(page, { kind: "hold" });

      await page.goto(server.url, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="workspace-loading"]', { timeout: 10_000 });
      await page.waitForSelector('[data-testid="workspace-loading-card"]', { timeout: 5_000 });

      const loadingMetrics = await page.evaluate(() => {
        const loadingEl = document.querySelector('[data-testid="workspace-loading"]') as HTMLElement | null;
        const cardEl = document.querySelector('[data-testid="workspace-loading-card"]') as HTMLElement | null;
        const idEl = document.querySelector('[data-testid="workspace-loading-id"]') as HTMLElement | null;
        const detailEl = document.querySelector('[data-testid="workspace-detail"]');
        if (!loadingEl || !cardEl) return null;
        const containerRect = loadingEl.getBoundingClientRect();
        const cardRect = cardEl.getBoundingClientRect();
        return {
          hasDetail: Boolean(detailEl),
          role: loadingEl.getAttribute("role"),
          ariaBusy: loadingEl.getAttribute("aria-busy"),
          idText: idEl?.textContent?.trim() ?? "",
          cardText: cardEl.textContent?.trim() ?? "",
          skeletonCount: loadingEl.querySelectorAll('[data-slot="skeleton"]').length,
          containerLeft: containerRect.left,
          containerTop: containerRect.top,
          containerCenterX: containerRect.left + containerRect.width / 2,
          cardLeft: cardRect.left,
          cardTop: cardRect.top,
          cardCenterX: cardRect.left + cardRect.width / 2,
          docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          loadingOverflowX: loadingEl.scrollWidth - loadingEl.clientWidth,
        };
      });

      expect(loadingMetrics).not.toBeNull();
      expect(loadingMetrics!.hasDetail).toBe(false);
      expect(loadingMetrics!.role).toBe("status");
      expect(loadingMetrics!.ariaBusy).toBe("true");
      expect(loadingMetrics!.idText).toBe("REQ-001");
      expect(loadingMetrics!.cardText).toContain("正在加载需求详情…");
      expect(loadingMetrics!.skeletonCount).toBeGreaterThanOrEqual(8);

      // Centered horizontally and clearly detached from the top-left corner.
      expect(Math.abs(loadingMetrics!.cardCenterX - loadingMetrics!.containerCenterX)).toBeLessThanOrEqual(16);
      expect(loadingMetrics!.cardLeft - loadingMetrics!.containerLeft).toBeGreaterThan(40);
      expect(loadingMetrics!.cardTop - loadingMetrics!.containerTop).toBeGreaterThan(80);
      expect(loadingMetrics!.docOverflowX).toBeLessThanOrEqual(1);
      expect(loadingMetrics!.loadingOverflowX).toBeLessThanOrEqual(1);

      // Verify narrow viewport + dark theme has zero horizontal overflow while loading.
      await page.evaluate(() => {
        document.documentElement.setAttribute("data-theme", "dark");
      });
      await page.setViewport({ width: 480, height: 720 });
      const narrowMetrics = await page.evaluate(() => {
        const loadingEl = document.querySelector('[data-testid="workspace-loading"]') as HTMLElement | null;
        const cardEl = document.querySelector('[data-testid="workspace-loading-card"]') as HTMLElement | null;
        if (!loadingEl || !cardEl) return null;
        const containerRect = loadingEl.getBoundingClientRect();
        const cardRect = cardEl.getBoundingClientRect();
        return {
          centerDelta: Math.abs((cardRect.left + cardRect.width / 2) - (containerRect.left + containerRect.width / 2)),
          docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          loadingOverflowX: loadingEl.scrollWidth - loadingEl.clientWidth,
        };
      });
      expect(narrowMetrics).not.toBeNull();
      expect(narrowMetrics!.centerDelta).toBeLessThanOrEqual(16);
      expect(narrowMetrics!.docOverflowX).toBeLessThanOrEqual(1);
      expect(narrowMetrics!.loadingOverflowX).toBeLessThanOrEqual(1);

      // Release detail response and confirm smooth switch to real detail view.
      await page.evaluate(() => {
        (window as unknown as { __wbReleaseDetail: () => void }).__wbReleaseDetail();
      });
      await page.waitForSelector('[data-testid="workspace-detail"]', { timeout: 10_000 });
      const afterLoaded = await page.evaluate(() => ({
        hasLoading: Boolean(document.querySelector('[data-testid="workspace-loading"]')),
        hasDetail: Boolean(document.querySelector('[data-testid="workspace-detail"]')),
      }));
      expect(afterLoaded).toEqual({ hasLoading: false, hasDetail: true });
    } finally {
      await page.close();
    }
  }, 30_000);

  test("shows centered error fallback on 500 failure and recovers when clicking retry", async () => {
    const server = await startProjectServer();
    const page = await browser!.newPage();
    try {
      await page.setViewport({ width: 1280, height: 800 });
      await installDetailFetchInterceptor(page, {
        kind: "failOnce",
        errorMessage: "Simulated temporary 500 error",
      });

      await page.goto(server.url, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="workspace-load-error"]', { timeout: 10_000 });
      await page.waitForSelector('[data-testid="workspace-retry-btn"]', { timeout: 5_000 });

      const errState = await page.evaluate(() => {
        const root = document.querySelector('[data-testid="workspace-load-error"]') as HTMLElement | null;
        const card = document.querySelector('[data-testid="workspace-load-error-card"]') as HTMLElement | null;
        const msg = document.querySelector('[data-testid="workspace-load-error-message"]') as HTMLElement | null;
        if (!root || !card) return null;
        const rootRect = root.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        return {
          role: root.getAttribute("role"),
          hasDetail: Boolean(document.querySelector('[data-testid="workspace-detail"]')),
          message: msg?.textContent ?? "",
          centerDelta: Math.abs((cardRect.left + cardRect.width / 2) - (rootRect.left + rootRect.width / 2)),
        };
      });

      expect(errState).not.toBeNull();
      expect(errState!.role).toBe("alert");
      expect(errState!.hasDetail).toBe(false);
      expect(errState!.message).toContain("Simulated temporary 500 error");
      expect(errState!.centerDelta).toBeLessThanOrEqual(16);

      await clickReady(page, '[data-testid="workspace-retry-btn"]');
      await page.waitForSelector('[data-testid="workspace-detail"]', { timeout: 10_000 });
      const recovered = await page.evaluate(() => ({
        hasError: Boolean(document.querySelector('[data-testid="workspace-load-error"]')),
        hasDetail: Boolean(document.querySelector('[data-testid="workspace-detail"]')),
      }));
      expect(recovered).toEqual({ hasError: false, hasDetail: true });
    } finally {
      await page.close();
    }
  }, 30_000);

  test("keeps loading card visible and retry button reachable on low-height viewports with enlarged text and long errors", async () => {
    const server = await startProjectServer();

    // Part A: short viewport during slow loading collapses top decorative skeleton and keeps status card visible.
    const loadingPage = await browser!.newPage();
    try {
      await loadingPage.setViewport({ width: 844, height: 390 });
      await installDetailFetchInterceptor(loadingPage, { kind: "hold" });
      await loadingPage.goto(server.url, { waitUntil: "domcontentloaded" });
      await loadingPage.waitForSelector('[data-testid="workspace-loading-card"]', { timeout: 10_000 });

      const shortLoading = await loadingPage.evaluate(() => {
        const pinned = document.querySelector(".ws-loading-pinned") as HTMLElement | null;
        const card = document.querySelector('[data-testid="workspace-loading-card"]') as HTMLElement | null;
        if (!pinned || !card) return null;
        const rect = card.getBoundingClientRect();
        return {
          pinnedDisplay: getComputedStyle(pinned).display,
          cardTop: rect.top,
          cardBottom: rect.bottom,
          viewportHeight: window.innerHeight,
          docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      expect(shortLoading).not.toBeNull();
      expect(shortLoading!.pinnedDisplay).toBe("none");
      expect(shortLoading!.cardTop).toBeGreaterThanOrEqual(0);
      expect(shortLoading!.cardBottom).toBeLessThanOrEqual(shortLoading!.viewportHeight);
      expect(shortLoading!.docOverflowX).toBeLessThanOrEqual(1);
    } finally {
      await loadingPage.close();
    }

    // Part B: short viewport + enlarged typography + long error message remains scrollable and retryable.
    const errorPage = await browser!.newPage();
    try {
      await errorPage.setViewport({ width: 640, height: 360 });
      const longMessage =
        "Detailed backend timeout diagnostic: " +
        Array.from({ length: 12 }, (_, i) => `segment_${i}_failed_to_read_snapshot_state_from_remote_storage`).join(" ");
      await installDetailFetchInterceptor(errorPage, { kind: "failOnce", errorMessage: longMessage });
      await errorPage.goto(server.url, { waitUntil: "domcontentloaded" });
      await errorPage.waitForSelector('[data-testid="workspace-retry-btn"]', { timeout: 10_000 });

      // Simulate user text zoom (135% root font size) and verify no horizontal overflow and reachable retry action.
      await errorPage.evaluate(() => {
        document.documentElement.style.fontSize = "135%";
        const btn = document.querySelector('[data-testid="workspace-retry-btn"]') as HTMLElement | null;
        btn?.scrollIntoView({ block: "center" });
      });

      const scrollCheck = await errorPage.evaluate(() => {
        const root = document.querySelector('[data-testid="workspace-load-error"]') as HTMLElement | null;
        const btn = document.querySelector('[data-testid="workspace-retry-btn"]') as HTMLElement | null;
        if (!root || !btn) return null;
        const rect = btn.getBoundingClientRect();
        return {
          overflowY: getComputedStyle(root).overflowY,
          rootOverflowX: root.scrollWidth - root.clientWidth,
          docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          btnTop: rect.top,
          btnBottom: rect.bottom,
          viewportHeight: window.innerHeight,
        };
      });
      expect(scrollCheck).not.toBeNull();
      expect(["auto", "scroll"]).toContain(scrollCheck!.overflowY);
      expect(scrollCheck!.rootOverflowX).toBeLessThanOrEqual(1);
      expect(scrollCheck!.docOverflowX).toBeLessThanOrEqual(1);
      expect(scrollCheck!.btnTop).toBeGreaterThanOrEqual(0);
      expect(scrollCheck!.btnBottom).toBeLessThanOrEqual(scrollCheck!.viewportHeight);

      await clickReady(errorPage, '[data-testid="workspace-retry-btn"]');
      await errorPage.waitForSelector('[data-testid="workspace-detail"]', { timeout: 10_000 });
    } finally {
      await errorPage.close();
    }
  }, 30_000);

  test("disables animations under prefers-reduced-motion: reduce", async () => {
    const server = await startProjectServer();
    const page = (await browser!.newPage()) as MediaEmulationPage;
    try {
      await page.setViewport({ width: 1280, height: 800 });
      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      await installDetailFetchInterceptor(page, { kind: "hold" });

      await page.goto(server.url, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="workspace-loading-card"]', { timeout: 10_000 });

      const motion = await page.evaluate(() => {
        const root = document.querySelector('[data-testid="workspace-loading"]') as HTMLElement | null;
        const spinner = document.querySelector(".ws-loading-spinner") as HTMLElement | null;
        const barThumb = document.querySelector(".ws-loading-bar-thumb") as HTMLElement | null;
        const skel = document.querySelector(".ws-skeleton") as HTMLElement | null;
        const orbit = document.querySelector(".ws-loading-orbit") as HTMLElement | null;
        if (!root || !spinner || !barThumb || !skel || !orbit) return null;
        return {
          rootAnim: getComputedStyle(root).animationName,
          spinnerAnim: getComputedStyle(spinner).animationName,
          barThumbAnim: getComputedStyle(barThumb).animationName,
          skelAfterAnim: getComputedStyle(skel, "::after").animationName,
          skelAfterOpacity: getComputedStyle(skel, "::after").opacity,
          orbitBeforeAnim: getComputedStyle(orbit, "::before").animationName,
          orbitBeforeOpacity: getComputedStyle(orbit, "::before").opacity,
        };
      });

      expect(motion).not.toBeNull();
      expect(motion!.rootAnim).toBe("none");
      expect(motion!.spinnerAnim).toBe("none");
      expect(motion!.barThumbAnim).toBe("none");
      expect(motion!.skelAfterAnim).toBe("none");
      expect(motion!.skelAfterOpacity).toBe("0");
      expect(motion!.orbitBeforeAnim).toBe("none");
      expect(motion!.orbitBeforeOpacity).toBe("0");
    } finally {
      await page.close();
    }
  }, 30_000);
});
