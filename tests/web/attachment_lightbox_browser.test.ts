import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stageUpload } from "../../src/core/attachments.ts";
import { createRequirement, initProject } from "../../src/core/engine.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";
import {
  type BrowserInstance,
  type BrowserPage,
  cleanupE2eResources,
  clickReady,
  closeE2eBrowser,
  HAS_BROWSER,
  initGitRepoIn,
  launchE2eBrowser,
} from "./e2e_helpers.ts";

/** 1×1 PNG 灰度+Alpha 与 1×1 PNG RGBA，均为可被浏览器解码的真实图片。 */
const PNG_FIRST = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const PNG_SECOND = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** 连续 64 位十六进制字符加扩展名，用于验证窄屏灯箱标题的长词换行。 */
const LONG_IMAGE_NAME = `${"0123456789abcdef".repeat(4)}.png`;

const tempDirs: string[] = [];
const servers: WorkbenchServerHandle[] = [];
const origHubDir = process.env.WORKBENCH_HUB_DIR;
let browser: BrowserInstance | null = null;

function makeTempHub(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-lightbox-hub-"));
  tempDirs.push(dir);
  process.env.WORKBENCH_HUB_DIR = dir;
  return dir;
}

function formatBytes(bytes: number): string {
  return `${bytes} B`;
}

async function openFirstAttachment(page: BrowserPage): Promise<void> {
  await page.waitForSelector('[data-testid="attachment-open"]', { timeout: 5000 });
  // 详情页位于内部滚动容器中，先居中滚动并等待布局稳定，再按实际坐标点击。
  const target = await page.evaluate(async () => {
    const button = document.querySelector('[data-testid="attachment-open"]') as HTMLElement;
    button.scrollIntoView({ block: "center" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(target.x, target.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForSelector('[data-testid="attachment-lightbox"]', { timeout: 5000 });
  await page.waitForFunction(
    () => {
      const img = document.querySelector('[data-testid="attachment-lightbox-image"]');
      return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
    },
    { timeout: 5000 },
  );
}

function lightboxText(page: BrowserPage): Promise<{ title: string; counter: string }> {
  return page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="attachment-lightbox"]');
    return {
      title: dialog?.querySelector('[data-slot="dialog-title"]')?.textContent?.trim() ?? "",
      counter: dialog?.querySelector('[data-slot="dialog-description"]')?.textContent?.trim() ?? "",
    };
  });
}

beforeAll(async () => {
  browser = await launchE2eBrowser();
}, 15_000);

afterEach(() => {
  cleanupE2eResources(servers, tempDirs, origHubDir);
});

afterAll(async () => {
  await closeE2eBrowser(browser);
}, 15_000);

const suite = HAS_BROWSER ? describe : describe.skip;

suite("图片附件当前页灯箱（Chromium）", () => {
  test("点击图片附件在需求详情页内打开灯箱，支持多图切换、Esc 关闭与移动端布局", async () => {
    makeTempHub();
    const repo = initGitRepoIn(tempDirs);
    await initProject(repo, { name: "附件灯箱 E2E", privacyMode: "local" });
    const metas = stageUpload([
      { name: "first-shot.png", bytes: PNG_FIRST },
      { name: "second-shot.png", bytes: PNG_SECOND },
      { name: "notes.txt", bytes: Buffer.from("非图片附件仍应直接下载。\n") },
    ]);
    await createRequirement(repo, {
      goal: "图片附件应在当前页面灯箱中查看，而不是打开新标签页",
      attachmentIds: metas.map((meta) => meta.id),
    });

    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false });
    servers.push(server);

    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));
    await page.evaluateOnNewDocument(() => {
      const w = window as unknown as { open: (...args: unknown[]) => Window | null; __wbOpenCount: number };
      w.__wbOpenCount = 0;
      w.open = () => {
        w.__wbOpenCount += 1;
        return null;
      };
    });

    try {
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="attachment-image"] img', { timeout: 8000 });

      const entry = await page.evaluate(() => {
        const openButton = document.querySelector('[data-testid="attachment-open"]');
        return {
          tagName: openButton?.tagName ?? "",
          blankAnchors: document.querySelectorAll('[data-testid="attachment-gallery"] a[target="_blank"]').length,
          openCount: (window as unknown as { __wbOpenCount: number }).__wbOpenCount,
        };
      });
      expect(entry.tagName).toBe("BUTTON");
      expect(entry.blankAnchors).toBe(0);
      expect(entry.openCount).toBe(0);

      // 非图片附件继续使用 download 链接直接下载，不打开新标签页。
      const fileLink = await page.evaluate(() => {
        const link = document.querySelector('[data-testid="attachment-file"] a[download]');
        return {
          href: link?.getAttribute("href") ?? "",
          download: link?.getAttribute("download") ?? "",
          target: link?.getAttribute("target") ?? null,
        };
      });
      expect(fileLink.href).toContain("/api/requirements/REQ-001/attachments/");
      expect(fileLink.download).toBe("notes.txt");
      expect(fileLink.target).toBeNull();

      const detailUrl = await page.evaluate(() => window.location.href);
      await openFirstAttachment(page);
      expect(await page.evaluate(() => window.location.href)).toBe(detailUrl);
      expect(await page.evaluate(() => (window as unknown as { __wbOpenCount: number }).__wbOpenCount)).toBe(0);

      const first = await lightboxText(page);
      expect(first.title).toBe("first-shot.png");
      expect(first.counter).toContain("第 1/2 张");
      expect(first.counter).toContain(formatBytes(PNG_FIRST.length));

      await page.click('[data-testid="attachment-lightbox-next"]');
      await page.waitForFunction(
        () =>
          document.querySelector('[data-slot="dialog-title"]')?.textContent?.includes("second-shot.png") === true,
        { timeout: 5000 },
      );
      const second = await lightboxText(page);
      expect(second.title).toBe("second-shot.png");
      expect(second.counter).toContain("第 2/2 张");
      expect(second.counter).toContain(formatBytes(PNG_SECOND.length));

      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(
        () => document.querySelector('[data-slot="dialog-title"]')?.textContent?.includes("first-shot.png") === true,
        { timeout: 5000 },
      );
      expect((await lightboxText(page)).counter).toContain("第 1/2 张");

      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector('[data-testid="attachment-lightbox"]'), {
        timeout: 5000,
      });
      expect(await page.evaluate(() => window.location.href)).toBe(detailUrl);
      expect(pageErrors).toEqual([]);

      await page.setViewport({ width: 375, height: 720 });
      await openFirstAttachment(page);
      const mobile = await page.evaluate(() => {
        const popup = document.querySelector('[data-testid="attachment-lightbox"]');
        const body = document.querySelector(".attachment-lightbox-body");
        const prev = document.querySelector('[data-testid="attachment-lightbox-prev"]');
        const next = document.querySelector('[data-testid="attachment-lightbox-next"]');
        const close = Array.from(document.querySelectorAll('[data-testid="attachment-lightbox"] button')).find((btn) =>
          (btn.textContent ?? "").includes("关闭"),
        );
        const rect = (el: Element | null) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
        };
        return {
          documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          bodyOverflow: body ? body.scrollWidth > body.clientWidth + 1 : true,
          popup: rect(popup),
          prev: rect(prev),
          next: rect(next),
          close: rect(close ?? null),
        };
      });
      expect(mobile.documentOverflow).toBe(false);
      expect(mobile.bodyOverflow).toBe(false);
      for (const control of [mobile.popup, mobile.prev, mobile.next, mobile.close]) {
        expect(control).not.toBeNull();
        expect(control!.width).toBeGreaterThan(0);
        expect(control!.left).toBeGreaterThanOrEqual(0);
        expect(control!.right).toBeLessThanOrEqual(375);
        expect(control!.top).toBeGreaterThanOrEqual(0);
        expect(control!.bottom).toBeLessThanOrEqual(720);
      }

      await clickReady(page, '[data-testid="attachment-lightbox-next"]');
      await page.waitForFunction(
        () =>
          document.querySelector('[data-slot="dialog-title"]')?.textContent?.includes("second-shot.png") === true,
        { timeout: 5000 },
      );
      expect((await lightboxText(page)).counter).toContain("第 2/2 张");

      // 三种关闭入口：关闭按钮、点击遮罩区域。
      await clickReady(page, '[data-testid="attachment-lightbox"] button[aria-label="Close"]');
      await page.waitForFunction(() => !document.querySelector('[data-testid="attachment-lightbox"]'), {
        timeout: 5000,
      });

      await openFirstAttachment(page);
      await page.mouse.move(8, 8);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForFunction(() => !document.querySelector('[data-testid="attachment-lightbox"]'), {
        timeout: 5000,
      });
      expect(await page.evaluate(() => window.location.href)).toBe(detailUrl);
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("窄屏灯箱对 64 位十六进制长文件名换行且不遮挡关闭按钮", async () => {
    makeTempHub();
    const repo = initGitRepoIn(tempDirs);
    await initProject(repo, { name: "长文件名灯箱 E2E", privacyMode: "local" });
    const [meta] = stageUpload([{ name: LONG_IMAGE_NAME, bytes: PNG_FIRST }]);
    await createRequirement(repo, {
      goal: "长文件名图片附件应在窄屏灯箱内完整换行显示",
      attachmentIds: [meta!.id],
    });

    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false });
    servers.push(server);

    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));

    try {
      // 先在桌面宽度打开需求详情，再缩到 375px，避免移动端侧栏折叠影响导航。
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="attachment-image"] img', { timeout: 8000 });
      await page.setViewport({ width: 375, height: 720 });
      await openFirstAttachment(page);

      const layout = await page.evaluate((longName: string) => {
        const popup = document.querySelector('[data-testid="attachment-lightbox"]');
        const title = popup?.querySelector('[data-slot="dialog-title"]') ?? null;
        const close = popup?.querySelector('button[aria-label="Close"]') ?? null;
        const rect = (el: Element | null) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
        };
        const titleRect = rect(title);
        const closeRect = rect(close);
        let textRight = Number.POSITIVE_INFINITY;
        if (title) {
          const range = document.createRange();
          range.selectNodeContents(title);
          textRight = range.getBoundingClientRect().right;
        }
        const titleStyle = title ? getComputedStyle(title) : null;
        return {
          titleText: title?.textContent?.trim() ?? "",
          titleOverflow: title ? title.scrollWidth - title.clientWidth : -1,
          titleRect,
          closeRect,
          textRight,
          overflowWrap: titleStyle?.overflowWrap ?? "",
          paddingRight: titleStyle ? Number.parseFloat(titleStyle.paddingRight) : 0,
          documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          expectedName: longName,
        };
      }, LONG_IMAGE_NAME);

      expect(layout.titleText).toBe(LONG_IMAGE_NAME);
      expect(layout.titleOverflow).toBeLessThanOrEqual(1);
      expect(layout.overflowWrap).toBe("anywhere");
      expect(layout.paddingRight).toBeGreaterThanOrEqual(32);
      expect(layout.titleRect).not.toBeNull();
      expect(layout.closeRect).not.toBeNull();
      // 文本实际绘制区域必须停在右上角关闭按钮左侧，不能侵入按钮命中区域。
      expect(layout.textRight).toBeLessThanOrEqual(layout.closeRect!.left + 1);
      expect(layout.closeRect!.right).toBeLessThanOrEqual(375);
      expect(layout.closeRect!.bottom).toBeLessThanOrEqual(720);
      expect(layout.documentOverflow).toBe(false);

      await clickReady(page, '[data-testid="attachment-lightbox"] button[aria-label="Close"]');
      await page.waitForFunction(() => !document.querySelector('[data-testid="attachment-lightbox"]'), {
        timeout: 5000,
      });
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
});
