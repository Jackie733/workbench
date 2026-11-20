import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initProject } from "../../src/core/engine.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";
import { resolveTestBrowser } from "./browser_env.ts";

const browserEnv = resolveTestBrowser();
const HAS_BROWSER = browserEnv !== null;

interface BrowserPage {
  setViewport(vp: { width: number; height: number }): Promise<void>;
  goto(url: string, opts?: { waitUntil?: string }): Promise<unknown>;
  waitForSelector(sel: string, opts?: { timeout?: number }): Promise<unknown>;
  waitForFunction(fn: string | ((...args: unknown[]) => boolean), opts?: { timeout?: number }, ...args: unknown[]): Promise<unknown>;
  click(sel: string): Promise<void>;
  type(sel: string, text: string): Promise<void>;
  evaluate<T>(fn: (...args: any[]) => T, ...args: any[]): Promise<T>;
  mouse: { move(x: number, y: number): Promise<void> };
  keyboard: { press(key: string): Promise<void> };
  on(ev: string, fn: (...args: any[]) => void): void;
  close(): Promise<void>;
}

interface BrowserInstance {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

const tempDirs: string[] = [];
const servers: WorkbenchServerHandle[] = [];
let browser: BrowserInstance | null = null;

const TOAST_SEL = '[data-sonner-toast]:not([data-removed="true"])';

function initGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-toast-"));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "calc.ts"), "export const add = (a: number, b: number) => a + b;\n");
  execFileSync("git", ["add", "calc.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });
  return dir;
}

async function startServer(preInit: boolean): Promise<WorkbenchServerHandle> {
  const root = initGitRepo();
  if (preInit) await initProject(root, { name: "ToastRepo", privacyMode: "local" });
  const server = await startWorkbenchServer({ root, port: 0, writeDiscovery: false });
  servers.push(server);
  return server;
}

async function newPage(server: WorkbenchServerHandle, width = 1280, height = 860): Promise<BrowserPage> {
  const page = await browser!.newPage();
  await page.setViewport({ width, height });
  await page.goto(server.url, { waitUntil: "networkidle0" });
  return page;
}

/** 打开新建需求弹窗并以空目标保存，触发错误提示「请先输入需求描述」。 */
async function triggerErrorToast(page: BrowserPage): Promise<void> {
  const target = await page.evaluate(() => {
    const emptyBtn = document.querySelector('[data-testid="empty-new-req-btn"]') as HTMLElement | null;
    if (emptyBtn) {
      const r = emptyBtn.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return "empty";
    }
    const sbBtn = document.querySelector('[data-testid="new-req-btn"]') as HTMLElement | null;
    if (sbBtn) {
      const r = sbBtn.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return "sidebar-visible";
    }
    return "open-mobile-sidebar";
  });
  if (target === "empty") {
    await page.click('[data-testid="empty-new-req-btn"]');
  } else {
    if (target === "open-mobile-sidebar") {
      await page.click('[data-testid="toggle-sidebar-btn"]');
      await page.waitForSelector('[data-testid="hub-sidebar"].open', { timeout: 5000 });
    }
    await page.click('[data-testid="new-req-btn"]');
  }
  await page.waitForSelector('[data-testid="new-req-goal"]', { timeout: 5000 });
  await page.click('[data-testid="save-draft-btn"]');
  await page.waitForSelector(TOAST_SEL, { timeout: 5000 });
}

async function toastTexts(page: BrowserPage): Promise<string[]> {
  return page.evaluate((sel: string) => Array.from(document.querySelectorAll(sel)).map((el) => el.textContent ?? ""), TOAST_SEL);
}

async function waitToastsGone(page: BrowserPage, timeout = 6000): Promise<void> {
  await page.waitForFunction(() => !document.querySelector("[data-sonner-toast]"), { timeout });
}

beforeAll(async () => {
  if (!browserEnv) return;
  const mod = (await import(browserEnv.puppeteerPath)) as {
    default: { launch(opts: Record<string, unknown>): Promise<BrowserInstance> };
  };
  browser = await mod.default.launch({
    executablePath: browserEnv.chromePath,
    headless: browserEnv.headless,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
}, 15_000);

afterEach(() => {
  while (servers.length > 0) servers.pop()!.stop();
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

afterAll(async () => {
  if (browser) {
    await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 2000))]);
  }
}, 15_000);

const suite = HAS_BROWSER ? describe : describe.skip;

suite("REQ-001 Sonner 消息提示真实浏览器回归", () => {
  test("连续提示共存、普通/错误分类、单独关闭与约四秒自动消失", async () => {
    const server = await startServer(true);
    const page = await newPage(server);
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));

    try {
      await triggerErrorToast(page);
      const first = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        return { text: el?.textContent ?? "", type: el?.getAttribute("data-type") ?? "" };
      }, TOAST_SEL);
      expect(first.text).toContain("请先输入需求描述");
      expect(first.type).toBe("error");

      // 等待滑入落定后悬停提示区域：Sonner 悬停暂停计时，使两条提示确定性共存。
      await page.waitForFunction(
        (sel: unknown) => {
          const el = document.querySelector(String(sel));
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.top >= 0 && r.bottom <= window.innerHeight;
        },
        { timeout: 5000 },
        TOAST_SEL,
      );
      const center = await page.evaluate((sel: string) => {
        const r = document.querySelector(sel)!.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, TOAST_SEL);
      await page.mouse.move(center.x, center.y);

      // 第二条不同提示：保存草稿成功。用合成点击保持鼠标悬停，两条必须同时在队列中。
      await page.type('[data-testid="new-req-goal"]', "Toast 堆叠回归需求");
      await page.evaluate(() => {
        (document.querySelector('[data-testid="save-draft-btn"]') as HTMLButtonElement | null)?.click();
      });
      await page.waitForFunction(
        (sel: unknown) => document.querySelectorAll(String(sel)).length === 2,
        { timeout: 8000 },
        TOAST_SEL,
      );
      const both = await page.evaluate((sel: string) => {
        return Array.from(document.querySelectorAll(sel)).map((el) => ({
          text: el.textContent ?? "",
          type: el.getAttribute("data-type") ?? "",
        }));
      }, TOAST_SEL);
      expect(both).toHaveLength(2);
      const errToast = both.find((t) => t.text.includes("请先输入需求描述"));
      const okToast = both.find((t) => t.text.includes("已创建需求 REQ-001"));
      expect(errToast?.type).toBe("error");
      expect(okToast).toBeTruthy();
      expect(okToast!.type).not.toBe("error");

      // 单独关闭错误提示：通过其自身关闭按钮，另一条不受影响。
      await page.evaluate((sel: string) => {
        const el = Array.from(document.querySelectorAll(sel)).find((n) => (n.textContent ?? "").includes("请先输入需求描述"));
        const btn = el?.querySelector("[data-close-button]") as HTMLButtonElement | null;
        if (!btn) throw new Error("error toast close button not found");
        btn.click();
      }, TOAST_SEL);
      await page.waitForFunction(
        (sel: unknown) => document.querySelectorAll(String(sel)).length === 1,
        { timeout: 5000 },
        TOAST_SEL,
      );
      const remaining = await toastTexts(page);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]).toContain("已创建需求 REQ-001");

      // 鼠标移开恢复计时；剩余提示应在约四秒后自动消失。
      await page.mouse.move(5, 5);
      const t0 = Date.now();
      await waitToastsGone(page);
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeGreaterThanOrEqual(3000);
      expect(elapsed).toBeLessThanOrEqual(5800);
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("通知语义、关闭控件可访问名称与键盘操作", async () => {
    const server = await startServer(true);
    const page = await newPage(server);
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));

    try {
      await triggerErrorToast(page);

      const aria = await page.evaluate(() => {
        const ol = document.querySelector("[data-sonner-toaster]");
        const section = ol?.closest("section");
        const btn = document.querySelector("[data-sonner-toast] [data-close-button]") as HTMLButtonElement | null;
        return {
          live: section?.getAttribute("aria-live") ?? "",
          relevant: section?.getAttribute("aria-relevant") ?? "",
          label: section?.getAttribute("aria-label") ?? "",
          closeTag: btn?.tagName ?? "",
          closeLabel: btn?.getAttribute("aria-label") ?? "",
        };
      });
      expect(aria.live).toBe("polite");
      expect(aria.relevant).toContain("additions");
      expect(aria.label.length).toBeGreaterThan(0);
      expect(aria.closeTag).toBe("BUTTON");
      expect(aria.closeLabel.length).toBeGreaterThan(0);

      // 键盘关闭：先关闭弹窗（模态焦点陷阱是弹窗标准行为），再聚焦关闭按钮按 Enter。
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector('[data-testid="new-req-goal"]'), { timeout: 5000 });
      const focused = await page.evaluate(() => {
        const btn = document.querySelector("[data-sonner-toast] [data-close-button]") as HTMLButtonElement | null;
        if (!btn) return false;
        btn.focus();
        return document.activeElement === btn;
      });
      expect(focused).toBe(true);
      await page.keyboard.press("Enter");
      await waitToastsGone(page, 5000);

      // 第二条提示用空格键关闭，验证键盘操作可重复。
      await triggerErrorToast(page);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector('[data-testid="new-req-goal"]'), { timeout: 5000 });
      await page.evaluate(() => {
        (document.querySelector("[data-sonner-toast] [data-close-button]") as HTMLButtonElement | null)?.focus();
      });
      await page.keyboard.press("Space");
      await waitToastsGone(page, 5000);
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("浅色与深色主题下提示可读且错误提示可区分", async () => {
    const server = await startServer(false);
    const page = await newPage(server);
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));

    const readToastStyle = () =>
      page.evaluate((sel: string) => {
        const ol = document.querySelector("[data-sonner-toaster]");
        const el = document.querySelector(sel);
        if (!ol || !el) return null;
        const cs = getComputedStyle(el);
        return {
          theme: ol.getAttribute("data-sonner-theme") ?? "",
          type: el.getAttribute("data-type") ?? "",
          bg: cs.backgroundColor,
          color: cs.color,
        };
      }, TOAST_SEL);

    try {
      // 初始化完成提示（浅色主题下的普通提示）。
      await page.click('[data-testid="init-submit-btn"]');
      await page.waitForSelector(TOAST_SEL, { timeout: 5000 });
      const light = await readToastStyle();
      expect(light).not.toBeNull();
      expect(light!.theme).toBe("light");
      expect(light!.type).not.toBe("error");
      expect(light!.bg).toBe("rgb(255, 255, 255)");
      await waitToastsGone(page);

      // 切换深色主题后创建需求，普通提示应跟随主题变量。
      await page.click('[data-action="toggle-theme"]');
      expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe("dark");
      await page.click('[data-testid="new-req-btn"]');
      await page.waitForSelector('[data-testid="new-req-goal"]', { timeout: 10_000 });
      await page.type('[data-testid="new-req-goal"]', "深色主题提示回归");
      await page.click('[data-testid="save-draft-btn"]');
      await page.waitForSelector(TOAST_SEL, { timeout: 10_000 });
      const dark = await readToastStyle();
      expect(dark).not.toBeNull();
      expect(dark!.theme).toBe("dark");
      expect(dark!.bg).toBe("rgb(19, 23, 34)");
      expect(dark!.color).not.toBe(light!.color);
      await waitToastsGone(page);

      // 深色主题下错误提示与普通提示背景可区分。
      await page.click('[data-testid="back-home-btn"]');
      await page.waitForSelector('[data-testid="new-req-btn"]', { timeout: 5000 });
      await triggerErrorToast(page);
      const darkError = await page.evaluate((sel: string) => {
        const el = document.querySelector(`${sel}[data-type="error"]`);
        return el ? getComputedStyle(el).backgroundColor : "";
      }, TOAST_SEL);
      expect(darkError.length).toBeGreaterThan(0);
      expect(darkError).not.toBe(dark!.bg);
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 40_000);

  test("窄屏无横向溢出、提示位于弹窗之上且弹窗仍可操作", async () => {
    const server = await startServer(true);
    const page = await newPage(server, 375, 720);
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));

    try {
      await triggerErrorToast(page);
      // 等待滑入动画落定，提示完全进入视口后再测量。
      await page.waitForFunction(
        (sel: unknown) => {
          const el = document.querySelector(String(sel));
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.top >= 0 && r.bottom <= window.innerHeight;
        },
        { timeout: 5000 },
        TOAST_SEL,
      );

      const narrow = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          left: r.left,
          right: r.right,
          width: r.width,
          overflow: document.documentElement.scrollWidth > window.innerWidth,
          hitInsideToast: Boolean(hit && el.contains(hit)),
          modalOpen: Boolean(document.querySelector('[data-testid="new-req-goal"]')),
          innerWidth: window.innerWidth,
        };
      }, TOAST_SEL);
      expect(narrow).not.toBeNull();
      expect(narrow!.left).toBeGreaterThanOrEqual(0);
      expect(narrow!.right).toBeLessThanOrEqual(375);
      expect(narrow!.overflow).toBe(false);
      // 提示层级高于弹窗遮罩，且弹窗仍然打开。
      expect(narrow!.hitInsideToast).toBe(true);
      expect(narrow!.modalOpen).toBe(true);

      // 悬停第一条提示暂停 4s 自动消失计时，避免并发高负载下与第二条提示创建竞态。
      const hoverPt = await page.evaluate((sel: string) => {
        const r = document.querySelector(sel)!.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, TOAST_SEL);
      await page.mouse.move(hoverPt.x, hoverPt.y);

      // 提示可见时弹窗内输入与保存仍然可用；成功后两条提示在窄屏共存且不溢出。
      await page.type('[data-testid="new-req-goal"]', "窄屏弹窗交互回归");
      await page.evaluate(() => {
        (document.querySelector('[data-testid="save-draft-btn"]') as HTMLButtonElement | null)?.click();
      });
      await page.waitForSelector('[data-testid="ws-stage-badge"]', { timeout: 10_000 });
      await page.waitForFunction(
        (sel: unknown) => document.querySelectorAll(String(sel)).length === 2,
        { timeout: 10_000 },
        TOAST_SEL,
      );
      await page.waitForFunction(
        (sel: unknown) =>
          Array.from(document.querySelectorAll(String(sel))).every((el) => {
            const r = el.getBoundingClientRect();
            return r.top >= 0 && r.bottom <= window.innerHeight;
          }),
        { timeout: 5000 },
        TOAST_SEL,
      );
      const stacked = await page.evaluate((sel: string) => {
        const rects = Array.from(document.querySelectorAll(sel)).map((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right };
        });
        return {
          count: rects.length,
          overflow: document.documentElement.scrollWidth > window.innerWidth,
          allInside: rects.every((r) => r.left >= 0 && r.right <= window.innerWidth),
        };
      }, TOAST_SEL);
      expect(stacked.count).toBe(2);
      expect(stacked.overflow).toBe(false);
      expect(stacked.allInside).toBe(true);
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);
});