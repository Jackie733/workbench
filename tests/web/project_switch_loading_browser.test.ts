import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequirement, initProject } from "../../src/core/engine.ts";
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
} from "./e2e_helpers.ts";

const HAS_BROWSER = browserEnv !== null;

const tempDirs: string[] = [];
const servers: WorkbenchServerHandle[] = [];
const origHubDir = process.env.WORKBENCH_HUB_DIR;
let browser: BrowserInstance | null = null;

type ProjectSwitchTestWindow = Window & {
  __wbBetaRequirementsRequested: number;
  __wbReleaseBetaRequirements?: () => void;
};

describe.skipIf(!HAS_BROWSER)("REQ-027 项目切换加载态浏览器验证", () => {
  beforeAll(async () => {
    browser = await launchE2eBrowser();
  });

  afterEach(() => {
    cleanupE2eResources(servers, tempDirs, origHubDir);
  });

  afterAll(async () => {
    await closeE2eBrowser(browser);
  });

  test("切换项目时列表与中间工作区显示骨架，放行后切换为目标项目需求", async () => {
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-e2e-switch-loading-hub-"));
    tempDirs.push(hubDir);
    process.env.WORKBENCH_HUB_DIR = hubDir;

    const repoA = initGitRepoIn(tempDirs);
    const repoB = initGitRepoIn(tempDirs);
    await initProject(repoA, { name: "SwitchLoadingAlpha", privacyMode: "local" });
    await initProject(repoB, { name: "SwitchLoadingBeta", privacyMode: "local" });
    const reqA = await createRequirement(repoA, { goal: "Alpha 项目加载前需求", title: "Alpha 加载前需求" });
    const reqB = await createRequirement(repoB, { goal: "Beta 项目切换后需求", title: "Beta 切换后需求" });
    const alpha = registerHubProject(repoA, { name: "SwitchLoadingAlpha", activate: true }).project;
    const beta = registerHubProject(repoB, { name: "SwitchLoadingBeta", activate: false }).project;

    const server = await startWorkbenchServer({
      root: repoA,
      port: 0,
      writeDiscovery: false,
      hubMode: true,
    });
    servers.push(server);

    const page = await browser!.newPage();
    try {
      await page.setViewport({ width: 1280, height: 800 });
      await page.evaluateOnNewDocument((betaId: string) => {
        const w = window as unknown as ProjectSwitchTestWindow & { fetch: typeof fetch };
        const nativeFetch = w.fetch.bind(window);
        const pendingReleases: Array<() => void> = [];
        let released = false;
        w.__wbBetaRequirementsRequested = 0;

        w.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
          const raw = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
          const url = new URL(raw, window.location.href);
          if (
            url.pathname === "/api/requirements" &&
            url.searchParams.get("project") === betaId &&
            !released
          ) {
            w.__wbBetaRequirementsRequested += 1;
            const pending = nativeFetch(input as RequestInfo, init);
            return new Promise<Response>((resolve, reject) => {
              pendingReleases.push(() => pending.then(resolve, reject));
            });
          }
          return nativeFetch(input as RequestInfo, init);
        }) as typeof fetch;

        w.__wbReleaseBetaRequirements = () => {
          released = true;
          for (const release of pendingReleases.splice(0)) release();
        };
      }, beta.id);

      await page.goto(server.url, { waitUntil: "networkidle0" });
      await page.waitForSelector(`[data-testid="req-row-${reqA.state.id}"]`, { timeout: 10_000 });
      await page.waitForSelector('[data-testid="workspace-detail"]', { timeout: 10_000 });

      await clickReady(page, `[data-testid="hub-project-${beta.id}"]`);
      await page.waitForFunction(
        () => (window as unknown as ProjectSwitchTestWindow).__wbBetaRequirementsRequested > 0,
        { timeout: 10_000 },
      );
      await page.waitForSelector('[data-testid="req-list-loading"]', { timeout: 5_000 });
      await page.waitForSelector('.main-stage [data-testid="workspace-loading"]', { timeout: 5_000 });

      const loading = await page.evaluate((alphaTitle: string) => {
        const mainStage = document.querySelector(".main-stage") as HTMLElement | null;
        const listSkeleton = document.querySelector('[data-testid="req-list-loading"]') as HTMLElement | null;
        const workspaceSkeleton = document.querySelector('[data-testid="workspace-loading"]') as HTMLElement | null;
        const loadingCard = document.querySelector('[data-testid="workspace-loading-card"]') as HTMLElement | null;
        const sidebarText = document.querySelector('[data-testid="home-view"]')?.textContent ?? "";
        return {
          mainStageText: mainStage?.textContent ?? "",
          mutedParagraphs: mainStage?.querySelectorAll("p.muted").length ?? -1,
          listBusy: listSkeleton?.getAttribute("aria-busy") ?? "",
          listRows: listSkeleton?.querySelectorAll('[data-testid="req-row-skeleton"]').length ?? 0,
          listActionRows: listSkeleton?.querySelectorAll('[data-action="open-req"]').length ?? -1,
          workspaceBusy: workspaceSkeleton?.getAttribute("aria-busy") ?? "",
          loadingCardText: loadingCard?.textContent ?? "",
          oldRequirementVisible: sidebarText.includes(alphaTitle),
          docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      }, reqA.state.title);

      expect(loading.mutedParagraphs).toBe(0);
      expect(loading.listBusy).toBe("true");
      expect(loading.listRows).toBeGreaterThanOrEqual(3);
      expect(loading.listActionRows).toBe(0);
      expect(loading.workspaceBusy).toBe("true");
      expect(loading.loadingCardText).toContain("正在加载工作台…");
      expect(loading.mainStageText).toContain("正在准备工作区、需求列表与项目状态");
      expect(loading.oldRequirementVisible).toBe(false);
      expect(loading.docOverflowX).toBeLessThanOrEqual(1);

      await page.evaluate(() => {
        (window as unknown as ProjectSwitchTestWindow).__wbReleaseBetaRequirements?.();
      });
      await page.waitForSelector(`[data-testid="req-row-${reqB.state.id}"]`, { timeout: 10_000 });
      await page.waitForSelector('[data-testid="workspace-detail"]', { timeout: 10_000 });

      const settled = await page.evaluate((alphaTitle: string, betaTitle: string) => ({
        hasListSkeleton: Boolean(document.querySelector('[data-testid="req-list-loading"]')),
        hasWorkspaceSkeleton: Boolean(document.querySelector('[data-testid="workspace-loading"]')),
        hasBetaRow: Boolean(document.querySelector('[data-testid="req-list"]')?.textContent?.includes(betaTitle)),
        hasAlphaRow: Boolean(document.querySelector('[data-testid="req-list"]')?.textContent?.includes(alphaTitle)),
        hasDetail: Boolean(document.querySelector('[data-testid="workspace-detail"]')),
      }), reqA.state.title, reqB.state.title);

      expect(settled).toEqual({
        hasListSkeleton: false,
        hasWorkspaceSkeleton: false,
        hasBetaRow: true,
        hasAlphaRow: false,
        hasDetail: true,
      });
    } finally {
      await page.close();
    }
  }, 30_000);
});
