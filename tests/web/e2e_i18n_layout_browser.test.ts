import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acceptRequirement, approveDesign, createRequirement, getRequirement, initProject, propose } from "../../src/core/engine.ts";
import { atomicWriteJson } from "../../src/core/fs.ts";
import { observeGitSnapshot } from "../../src/core/git.ts";
import { runVerification } from "../../src/core/runner.ts";
import type { RequirementState } from "../../src/core/types.ts";
import { HubExecutor } from "../../src/hub/executor.ts";
import { registerHubProject } from "../../src/hub/registry.ts";
import { resetAuthPassword } from "../../src/server/auth.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";
import {
  type BrowserInstance,
  cleanupE2eResources,
  clickReady,
  closeE2eBrowser,
  HAS_BROWSER,
  initGitRepoIn,
  launchE2eBrowser,
} from "./e2e_helpers.ts";
import { selectUiOption } from "./coss_select_helper.ts";

const tempDirs: string[] = [];
const servers: WorkbenchServerHandle[] = [];
const origHubDir = process.env.WORKBENCH_HUB_DIR;
let browser: BrowserInstance | null = null;
const initGitRepo = () => initGitRepoIn(tempDirs);

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

suite("Web E2E layout, routing picker, and bilingual UI flows", () => {
  test("Hub started on home directory shows empty sidebar and onboarding card until a project is manually added", async () => {
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-e2e-empty-hub-"));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-e2e-home-root-"));
    tempDirs.push(hubDir, homeDir);
    process.env.WORKBENCH_HUB_DIR = hubDir;

    const repo = initGitRepo();
    await initProject(repo, { name: "ManualRepo", privacyMode: "local" });

    const server = await startWorkbenchServer({ root: homeDir, port: 0, writeDiscovery: false, hubMode: true });
    servers.push(server);

    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));

    try {
      await page.setViewport({ width: 1360, height: 860 });
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="hub-sidebar"]', { timeout: 5000 });
      await page.waitForSelector('[data-testid="empty-hub-card"]', { timeout: 5000 });

      const sidebarText = await page.evaluate(() => document.querySelector('[data-testid="hub-sidebar"]')?.textContent ?? "");
      expect(sidebarText).toContain("本地项目 (0)");
      expect(sidebarText).toContain("暂无纳管项目");
      expect(sidebarText).not.toContain(path.basename(homeDir));
      expect(await page.evaluate(() => document.querySelectorAll('[data-action="switch-project"]').length)).toBe(0);
      expect(await page.evaluate(() => Boolean(document.querySelector('[data-testid="init-card"]')))).toBe(false);

      // Manually add a project from the empty-hub CTA
      await clickReady(page, '[data-testid="empty-hub-add-btn"]');
      await page.waitForSelector('[data-testid="add-project-modal"]', { timeout: 5000 });
      await page.evaluate((p: string) => {
        const input = document.getElementById("add-project-path") as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, p);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, repo);
      await clickReady(page, '[data-testid="submit-add-project-btn"]');
      await page.waitForSelector('[data-testid="home-view"]', { timeout: 5000 });

      const sidebarAfter = await page.evaluate(() => document.querySelector('[data-testid="hub-sidebar"]')?.textContent ?? "");
      expect(sidebarAfter).toContain("本地项目 (1)");
      expect(sidebarAfter).toContain("ManualRepo");
      expect(sidebarAfter).not.toContain(path.basename(homeDir));
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("Global Header, collapsible left/right sidebars, 720px default drawer, and resizable 50% equal-width split", async () => {
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-e2e-layout-hub-"));
    tempDirs.push(hubDir);
    process.env.WORKBENCH_HUB_DIR = hubDir;

    const repo = initGitRepo();
    await initProject(repo, { name: "LayoutRepo", privacyMode: "local" });
    await createRequirement(repo, { goal: "Test global header and resizable sidebars" });

    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, hubMode: true });
    servers.push(server);

    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));

    try {
      await page.setViewport({ width: 1920, height: 1080 });
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="app-header"]', { timeout: 5000 });
      await page.waitForSelector('[data-testid="hub-sidebar"]', { timeout: 5000 });

      // 1. Global Header spans full width above the 3 columns, and drawer button is enabled once default requirement is selected
      const headerBox = await page.evaluate(() => {
        const h = document.querySelector('[data-testid="app-header"]')?.getBoundingClientRect();
        const sb = document.querySelector('[data-testid="hub-sidebar"]')?.getBoundingClientRect();
        const btn = document.querySelector('[data-testid="toggle-drawer-btn"]') as HTMLButtonElement | null;
        return {
          headerWidth: h?.width ?? 0,
          headerBottom: h?.bottom ?? 0,
          sidebarTop: sb?.top ?? 0,
          sidebarWidth: sb?.width ?? 0,
          drawerBtnDisabled: Boolean(btn?.disabled),
        };
      });
      expect(headerBox.headerWidth).toBeGreaterThanOrEqual(1900);
      expect(headerBox.sidebarTop).toBeGreaterThanOrEqual(headerBox.headerBottom - 1);
      expect(headerBox.sidebarWidth).toBe(360);
      expect(headerBox.drawerBtnDisabled).toBe(false);

      // 1b. Drag left sidebar resizer to adjust width and double-click to reset to 360px
      const sbResizer = await page.evaluate(() => {
        const r = document.querySelector('[data-testid="sidebar-resizer"]')?.getBoundingClientRect();
        return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
      });
      expect(sbResizer).not.toBeNull();
      await page.mouse.move(sbResizer!.x, sbResizer!.y);
      await page.mouse.down();
      await page.mouse.move(sbResizer!.x + 80, sbResizer!.y, { steps: 5 });
      await page.mouse.up();
      await new Promise((r) => setTimeout(r, 80));
      const resizedSidebar = await page.evaluate(() => ({
        width: Math.round(document.querySelector('[data-testid="hub-sidebar"]')?.getBoundingClientRect().width ?? 0),
        saved: localStorage.getItem("wb-sidebar-width"),
      }));
      expect(resizedSidebar.width).toBe(440);
      expect(resizedSidebar.saved).toBe("440");

      await page.evaluate(() => {
        document.querySelector('[data-testid="sidebar-resizer"]')?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      });
      await page.waitForFunction(
        () => Math.round(document.querySelector('[data-testid="hub-sidebar"]')?.getBoundingClientRect().width ?? 0) === 360,
        { timeout: 5000 },
      );

      // 2. Desktop left sidebar collapses cleanly to 0px and expands back to 360px
      await clickReady(page, '[data-testid="toggle-sidebar-btn"]');
      await page.waitForFunction(
        () => Boolean(document.querySelector('[data-testid="hub-sidebar"]')?.classList.contains("settled")),
        { timeout: 5000 },
      );
      await page.waitForFunction(
        () => (document.querySelector('[data-testid="hub-sidebar"]')?.getBoundingClientRect().width ?? -1) === 0,
        { timeout: 5000 },
      );
      const collapsedSidebarW = await page.evaluate(
        () => document.querySelector('[data-testid="hub-sidebar"]')?.getBoundingClientRect().width ?? -1,
      );
      expect(collapsedSidebarW).toBe(0);

      await clickReady(page, '[data-testid="toggle-sidebar-btn"]');
      await page.waitForFunction(
        () => Boolean(document.querySelector('[data-testid="hub-sidebar"]')?.classList.contains("desktop-open")),
        { timeout: 5000 },
      );

      const bottomPinned = await page.evaluate(() => {
        const sb = document.querySelector('[data-testid="hub-sidebar"]')!.getBoundingClientRect();
        const sec = document.querySelector('[data-testid="hub-sidebar"] .sb-section-bottom')!.getBoundingClientRect();
        const brand = document.querySelector(".app-brand-btn")!.getBoundingClientRect();
        const toggle = document.querySelector('[data-testid="toggle-sidebar-btn"]')!.getBoundingClientRect();
        return { pinned: sb.bottom - sec.bottom < 40, toggleAfterBrand: toggle.left > brand.left };
      });
      expect(bottomPinned.pinned).toBe(true);
      expect(bottomPinned.toggleAfterBrand).toBe(true);

      // 3. Open REQ-001 -> open RightDrawer via Header -> verify 720px default and no X close button inside drawer
      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="ws-stage-badge"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="toggle-drawer-btn"]');
      await page.waitForSelector('[data-testid="right-drawer"].open', { timeout: 5000 });
      await page.waitForFunction(
        () => Math.round(document.querySelector('[data-testid="right-drawer"]')?.getBoundingClientRect().width ?? 0) === 720,
        { timeout: 3000 },
      );

      const initialDrawer = await page.evaluate(() => {
        const drawer = document.querySelector('[data-testid="right-drawer"]');
        const headX = drawer?.querySelector('.drawer-head [aria-label="收起右侧栏"]');
        return {
          width: Math.round(drawer?.getBoundingClientRect().width ?? 0),
          hasHeadCloseX: Boolean(headX),
        };
      });
      expect(initialDrawer.width).toBe(720);
      expect(initialDrawer.hasHeadCloseX).toBe(false);

      // 4. Drag resizer left to reach 50% equal width (780px on 1920px viewport with 360px sidebar)
      const resizerRect = await page.evaluate(() => {
        const r = document.querySelector('[data-testid="drawer-resizer"]')?.getBoundingClientRect();
        return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
      });
      expect(resizerRect).not.toBeNull();
      await page.mouse.move(resizerRect!.x, resizerRect!.y);
      await page.mouse.down();
      await page.mouse.move(resizerRect!.x - 300, resizerRect!.y, { steps: 6 });
      await page.mouse.up();

      await new Promise((r) => setTimeout(r, 80));
      const resizedMetrics = await page.evaluate(() => {
        const ws = document.querySelector(".hub-workspace")?.getBoundingClientRect();
        const main = document.querySelector(".main-stage")?.getBoundingClientRect();
        const drawer = document.querySelector('[data-testid="right-drawer"]')?.getBoundingClientRect();
        return {
          wsWidth: Math.round(ws?.width ?? 0),
          mainWidth: Math.round(main?.width ?? 0),
          drawerWidth: Math.round(drawer?.width ?? 0),
          saved: localStorage.getItem("wb-drawer-width"),
        };
      });
      // Clamped at 50% of hub-workspace (1560 * 0.5 = 780), matching main-stage width
      expect(resizedMetrics.drawerWidth).toBe(Math.floor(resizedMetrics.wsWidth * 0.5));
      expect(Math.abs(resizedMetrics.drawerWidth - resizedMetrics.mainWidth)).toBeLessThanOrEqual(2);
      expect(resizedMetrics.saved).toBe(String(resizedMetrics.drawerWidth));

      // 5. Header toggle collapses RightDrawer cleanly
      await clickReady(page, '[data-testid="toggle-drawer-btn"]');
      await page.waitForFunction(
        () => Boolean(document.querySelector('[data-testid="right-drawer"]')?.classList.contains("settled")),
        { timeout: 5000 },
      );
      await page.waitForFunction(
        () => (document.querySelector('[data-testid="right-drawer"]')?.getBoundingClientRect().width ?? -1) === 0,
        { timeout: 5000 },
      );
      const closedDrawerW = await page.evaluate(
        () => document.querySelector('[data-testid="right-drawer"]')?.getBoundingClientRect().width ?? -1,
      );
      expect(closedDrawerW).toBe(0);
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("REQ-009: 需求详情固定顶部区域，仅 Tabs 下方内容拥有独立垂直滚动", async () => {
    const repo = initGitRepo();
    await initProject(repo, { name: "ScrollLayoutRepo", privacyMode: "local" });

    const longSection = Array.from({ length: 80 }, (_, i) =>
      [
        `### 第 ${i + 1} 节：长内容用于验证局部滚动`,
        "",
        `这是第 ${i + 1} 节正文，重复内容只用于撑高规范与方案页面，以确认需求详情页不会出现全局垂直滚动条。`,
        "",
      ].join("\n"),
    ).join("\n");
    await createRequirement(repo, {
      goal: "需求详情页需要固定顶部状态区并让 Tabs 内容独立滚动",
      criteria: [{ id: "AC-1", description: "局部滚动布局生效", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", {
      specMarkdown: `# 长规范\n\n${longSection}`,
      designMarkdown: `# 长技术方案\n\n${longSection}`,
      actor: "agent",
    });

    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false });
    servers.push(server);

    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));

    try {
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="workspace-detail"]', { timeout: 5000 });
      await page.waitForFunction(
        () => {
          const el = document.querySelector('[data-testid="workspace-tab-scroll"]');
          return Boolean(el && el.scrollHeight > el.clientHeight + 100);
        },
        { timeout: 5000 },
      );

      const readLayout = () =>
        page.evaluate(() => {
          const scroll = document.querySelector('[data-testid="workspace-tab-scroll"]') as HTMLElement | null;
          const pinned = document.querySelector('[data-testid="workspace-pinned"]') as HTMLElement | null;
          const stepper = document.querySelector('[data-testid="stage-stepper"]') as HTMLElement | null;
          const tabs = document.querySelector('[data-testid="workspace-tabs"]') as HTMLElement | null;
          const banner = document.querySelector('[data-testid="action-banner"]') as HTMLElement | null;
          const root = document.scrollingElement ?? document.documentElement;
          return {
            windowScrollY: window.scrollY,
            documentScrollHeight: root.scrollHeight,
            documentClientHeight: root.clientHeight,
            innerHeight: window.innerHeight,
            scrollTop: scroll?.scrollTop ?? -1,
            scrollHeight: scroll?.scrollHeight ?? -1,
            scrollClientHeight: scroll?.clientHeight ?? -1,
            scrollBottom: scroll?.getBoundingClientRect().bottom ?? -1,
            pinnedTop: pinned?.getBoundingClientRect().top ?? -1,
            stepperTop: stepper?.getBoundingClientRect().top ?? -1,
            tabsTop: tabs?.getBoundingClientRect().top ?? -1,
            bannerTop: banner?.getBoundingClientRect().top ?? -1,
          };
        });

      const before = await readLayout();
      expect(before.windowScrollY).toBe(0);
      // 详情页自身不能产生全局垂直滚动条，滚动区域必须位于视口内。
      expect(before.documentScrollHeight).toBeLessThanOrEqual(before.documentClientHeight + 1);
      expect(before.scrollBottom).toBeLessThanOrEqual(before.innerHeight + 1);
      expect(before.scrollHeight).toBeGreaterThan(before.scrollClientHeight + 100);

      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="workspace-tab-scroll"]') as HTMLElement | null;
        if (el) el.scrollTop = Math.min(320, el.scrollHeight - el.clientHeight);
      });
      await new Promise((r) => setTimeout(r, 100));

      const after = await readLayout();
      expect(after.scrollTop).toBeGreaterThan(0);
      // 滚动 Tabs 内容时，窗口与顶部需求进度/状态/模型执行区域保持不动。
      expect(after.windowScrollY).toBe(0);
      expect(after.documentScrollHeight).toBeLessThanOrEqual(after.documentClientHeight + 1);
      expect(after.pinnedTop).toBe(before.pinnedTop);
      expect(after.stepperTop).toBe(before.stepperTop);
      expect(after.bannerTop).toBe(before.bannerTop);
      expect(after.tabsTop).toBe(before.tabsTop);

      // 切换 Tabs 后局部滚动容器仍然存在且保持独立滚动能力。
      await page.click('[data-testid="tab-changes"]');
      await page.waitForSelector('[data-testid="workspace-tab-scroll"]', { timeout: 5000 });
      const afterSwitch = await readLayout();
      expect(afterSwitch.windowScrollY).toBe(0);
      expect(afterSwitch.documentScrollHeight).toBeLessThanOrEqual(afterSwitch.documentClientHeight + 1);
      expect(afterSwitch.tabsTop).toBe(before.tabsTop);

      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("REQ-010: 长内容出现滚动条时 Tabs 切换按钮保持完整高度且不被内容遮挡", async () => {
    const repo = initGitRepo();
    await initProject(repo, { name: "TabsOverlapRepo", privacyMode: "local" });

    const longSection = Array.from({ length: 90 }, (_, i) =>
      [
        `### 第 ${i + 1} 节：长文本用于触发 Tabs 内容区滚动`,
        "",
        `这是第 ${i + 1} 节正文，重复的段落会把规范与方案页面撑高，以便验证滚动条出现时 Tabs 切换按钮仍然完整可见。`,
        "",
      ].join("\n"),
    ).join("\n");
    await createRequirement(repo, {
      goal: "长文本内容下 Tabs 切换按钮不被滚动条遮挡或压缩",
      criteria: Array.from({ length: 12 }, (_, i) => ({
        id: `AC-${i + 1}`,
        description: `验证项 ${i + 1} 用于撑高顶部固定区域`,
        required: true,
        command: "echo ok",
      })),
    });
    await propose(repo, "REQ-001", {
      specMarkdown: `# 长规范\n\n${longSection}`,
      designMarkdown: `# 长技术方案\n\n${longSection}`,
      actor: "agent",
    });

    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false });
    servers.push(server);

    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));

    try {
      await page.setViewport({ width: 2514, height: 1348 });
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="workspace-detail"]', { timeout: 5000 });
      await page.waitForFunction(
        () => {
          const el = document.querySelector('[data-testid="workspace-tab-scroll"]') as HTMLElement | null;
          return Boolean(el && el.scrollHeight > el.clientHeight + 100);
        },
        { timeout: 5000 },
      );

      const readTabs = () =>
        page.evaluate(() => {
          const tabs = document.querySelector('[data-testid="workspace-tabs"]') as HTMLElement | null;
          const scroll = document.querySelector('[data-testid="workspace-tab-scroll"]') as HTMLElement | null;
          const root = document.scrollingElement ?? document.documentElement;
          const tabsRect = tabs?.getBoundingClientRect();
          const scrollRect = scroll?.getBoundingClientRect();
          const buttons = Array.from(tabs?.querySelectorAll("button") ?? []).map((button) => {
            const rect = button.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            return {
              text: (button.textContent ?? "").trim(),
              height: rect.height,
              width: rect.width,
              top: rect.top,
              bottom: rect.bottom,
              fullyInside: Boolean(
                tabsRect && rect.top >= tabsRect.top - 0.5 && rect.bottom <= tabsRect.bottom + 0.5,
              ),
              hittable: hit === button || Boolean(hit?.closest("button") === button),
            };
          });
          return {
            windowScrollY: window.scrollY,
            documentScrollHeight: root.scrollHeight,
            documentClientHeight: root.clientHeight,
            tabsHeight: tabsRect?.height ?? -1,
            tabsTop: tabsRect?.top ?? -1,
            tabsBottom: tabsRect?.bottom ?? -1,
            scrollTop: scrollRect?.top ?? -1,
            scrollHeight: scroll?.scrollHeight ?? -1,
            scrollClientHeight: scroll?.clientHeight ?? -1,
            buttons,
          };
        });

      const before = await readTabs();
      // 内容区确实出现垂直滚动条，复现「长文本 + 滚动条」现场。
      expect(before.scrollHeight).toBeGreaterThan(before.scrollClientHeight + 100);
      expect(before.windowScrollY).toBe(0);
      expect(before.documentScrollHeight).toBeLessThanOrEqual(before.documentClientHeight + 1);

      // Tabs 栏不能被内容区挤压成细条，五个按钮必须完整位于栏内且仍可点击。
      expect(before.buttons.map((b) => b.text)).toEqual([
        "规范与方案",
        "代码变更",
        "验证与截图",
        "时间线与运行",
        "统计与审计",
      ]);
      expect(before.tabsHeight).toBeGreaterThan(30);
      for (const button of before.buttons) {
        expect(button.height).toBeGreaterThan(30);
        expect(button.width).toBeGreaterThan(0);
        expect(button.fullyInside).toBe(true);
        expect(button.hittable).toBe(true);
      }
      // Tabs 栏与下方滚动内容不重叠，滚动条出现在内容区而不是覆盖按钮。
      expect(before.tabsBottom).toBeLessThanOrEqual(before.scrollTop + 0.5);

      for (const tab of ["tab-diff", "tab-changes", "tab-timeline", "tab-audit", "tab-spec"] as const) {
        await page.click(`[data-testid="${tab}"]`);
        await new Promise((r) => setTimeout(r, 100));
        const after = await readTabs();
        expect(after.tabsTop).toBe(before.tabsTop);
        expect(after.tabsHeight).toBeGreaterThan(30);
        for (const button of after.buttons) {
          expect(button.height).toBeGreaterThan(30);
          expect(button.fullyInside).toBe(true);
          expect(button.hittable).toBe(true);
        }
        expect(after.tabsBottom).toBeLessThanOrEqual(after.scrollTop + 0.5);
      }

      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("REQ-008: the visible model picker, the /run request, the executor target, and the persisted record agree", async () => {
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-e2e-picker-hub-"));
    tempDirs.push(hubDir);
    process.env.WORKBENCH_HUB_DIR = hubDir;

    const repo = initGitRepo();
    const presetDesign = { harness: "opencode" as const, model: "opencode/deepseek-v4.1-flash-free" };
    await initProject(repo, {
      name: "PickerRepo",
      privacyMode: "local",
      routing: {
        defaultLead: { primary: presetDesign, fallbacks: [] },
        sotaLead: { primary: { harness: "codex", model: "gpt-6-astra" }, fallbacks: [] },
        reviewer: { primary: { harness: "codex", model: "gpt-6-astra" }, fallbacks: [] },
        autoReview: false,
        autoHeal: false,
      },
    });
    await createRequirement(repo, {
      goal: "在原生续接时保持所选模型与推理强度",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });

    const startedEvents: Array<{ runId: string; harness?: string; model?: string }> = [];
    const finishedRunIds = new Set<string>();
    const executor = new HubExecutor({
      initialHarnesses: [
        {
          id: "codex",
          label: "Codex CLI",
          subscription: "ChatGPT Plus",
          installed: true,
          executable: "codex",
          models: [
            { id: "gpt-6-astra", tier: "sota", source: "detected" },
            { id: "gpt-6.1-sol", tier: "sota", source: "detected", supportedEfforts: ["low", "medium", "high", "xhigh"] },
          ],
          defaultModel: "gpt-6-astra",
          detectedAt: Date.now(),
        },
        {
          id: "qodercn",
          label: "QoderCN",
          subscription: "QoderCN",
          installed: true,
          executable: "qodercn",
          models: [
            { id: "Qwen4-Max", tier: "sota", source: "detected" },
            { id: "DeepSeek-V4-Pro", tier: "sota", source: "detected" },
          ],
          defaultModel: "DeepSeek-V4-Pro",
          detectedAt: Date.now(),
        },
      ],
      commandBuilder: (target) => ({
        command: "bash",
        args: [
          "-c",
          `printf 'dispatch harness=%s model=%s effort=%s\\n' '${target.harness}' '${target.model}' '${target.reasoningEffort ?? "none"}'`,
        ],
        displayCommand: `picker-mock ${target.harness}/${target.model}`,
      }),
    });
    executor.subscribe((ev) => {
      if (ev.type === "agent.run.started") startedEvents.push({ runId: ev.runId, harness: ev.harness, model: ev.model });
      if (ev.type === "agent.run.finished") finishedRunIds.add(ev.runId);
    });

    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, hubMode: true, executor });
    servers.push(server);

    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));

    interface RunCall {
      body: Record<string, unknown>;
      target: { harness?: string; model?: string; reasoningEffort?: string } | null;
    }
    const runCalls: RunCall[] = [];
    const readHiddenSelect = () =>
      page.evaluate(() => (document.querySelector('[data-testid="banner-runner-select"]') as HTMLSelectElement)?.value ?? null);
    const readTriggerLabel = () =>
      page.evaluate(() => document.querySelector('[data-testid="banner-runner-select-trigger"]')?.textContent ?? "");
    const pickVisibleItem = async (needle: string) => {
      const found = await page.evaluate((text: string) => {
        document.querySelectorAll("[data-e2e-pick]").forEach((el) => el.removeAttribute("data-e2e-pick"));
        const item = Array.from(document.querySelectorAll('[data-slot="command-item"]')).find((el) => (el.textContent ?? "").includes(text));
        if (!item) return false;
        item.setAttribute("data-e2e-pick", "1");
        return true;
      }, needle);
      expect(found).toBe(true);
      await clickReady(page, "[data-e2e-pick]");
    };
    const waitRecordSettled = async (index: number) => {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const record = getRequirement(repo, "REQ-001").state.agentRuns?.[index];
        if (record && record.status !== "running") return record;
        if (Date.now() > deadline) throw new Error(`agent run #${index + 1} never settled`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    const runWithCurrentSelection = async (expectedRuns: number) => {
      await clickReady(page, '[data-testid="run-selected-model-btn"]');
      await page.waitForFunction(
        (count: unknown) => {
          const calls = (window as unknown as { __wbRunCalls?: RunCall[] }).__wbRunCalls;
          return Boolean(calls && calls.length === Number(count) && calls.every((c) => c.target !== null));
        },
        { timeout: 8000 },
        expectedRuns,
      );
      const captured = await page.evaluate((count: number) =>
        (window as unknown as { __wbRunCalls: RunCall[] }).__wbRunCalls.slice(0, count),
        expectedRuns);
      runCalls.splice(0, runCalls.length, ...captured);
      await waitRecordSettled(expectedRuns - 1);
    };

    try {
      await page.setViewport({ width: 1360, height: 900 });
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="hub-sidebar"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="banner-runner-select-trigger"]', { timeout: 5000 });

      // Record every /run request body together with the executor-resolved target in its response.
      await page.evaluate(() => {
        const w = window as unknown as { __wbRunCalls: RunCall[] };
        w.__wbRunCalls = [];
        const originalFetch = window.fetch.bind(window);
        const spy = (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
          const entry: RunCall | null =
            init?.method === "POST" && url.includes("/run")
              ? { body: JSON.parse(String(init.body)) as Record<string, unknown>, target: null }
              : null;
          return originalFetch(input, init).then((response) => {
            if (entry) {
              w.__wbRunCalls.push(entry);
              void response
                .clone()
                .json()
                .then((json: { target?: RunCall["target"] }) => {
                  entry.target = json?.target ?? null;
                })
                .catch(() => undefined);
            }
            return response;
          });
        };
        window.fetch = spy as unknown as typeof fetch;
      });

      // 1. Default route mode sends no explicit selection and dispatches the stage preset.
      expect(await readHiddenSelect()).toBe(`${presetDesign.harness}::${presetDesign.model}`);
      expect(await readTriggerLabel()).toContain(`默认 (${presetDesign.harness}/${presetDesign.model})`);
      await runWithCurrentSelection(1);
      expect(runCalls[0]!.body.action).toBe("design");
      expect(runCalls[0]!.body.harness).toBeUndefined();
      expect(runCalls[0]!.body.model).toBeUndefined();
      expect(runCalls[0]!.target).toEqual({ harness: presetDesign.harness, model: presetDesign.model });
      expect(startedEvents[0]).toEqual({ runId: startedEvents[0]!.runId, harness: presetDesign.harness, model: presetDesign.model });
      expect(getRequirement(repo, "REQ-001").state.agentRuns?.[0]).toMatchObject({
        harness: presetDesign.harness,
        model: presetDesign.model,
        status: "succeeded",
      });
      expect(executor.getLiveLog(startedEvents[0]!.runId)).toContain(
        `dispatch harness=${presetDesign.harness} model=${presetDesign.model} effort=none`,
      );

      // 2. Picking a model in the visible popover drives the hidden select, the request, the target, and the record.
      await clickReady(page, '[data-testid="banner-runner-select-trigger"]');
      await page.waitForSelector('[data-slot="command-item"]', { timeout: 5000 });
      await pickVisibleItem("gpt-6.1-sol");
      await page.waitForFunction(
        () => (document.querySelector('[data-testid="banner-runner-select"]') as HTMLSelectElement)?.value === "codex::gpt-6.1-sol",
        { timeout: 5000 },
      );
      expect(await readTriggerLabel()).toContain("codex/gpt-6.1-sol");
      // page.select waits with puppeteer's 30s default; bound it so a missing control fails fast.
      await page.waitForSelector('[data-testid="banner-runner-select-effort"]', { timeout: 5000 });
      await selectUiOption(page, '[data-testid="banner-runner-select-effort"]', "medium");

      await runWithCurrentSelection(2);
      expect(runCalls[1]!.body).toMatchObject({ action: "design", harness: "codex", model: "gpt-6.1-sol", reasoningEffort: "medium" });
      expect(runCalls[1]!.target).toEqual({ harness: "codex", model: "gpt-6.1-sol", reasoningEffort: "medium" });
      expect(startedEvents[1]).toEqual({ runId: startedEvents[1]!.runId, harness: "codex", model: "gpt-6.1-sol" });
      expect(getRequirement(repo, "REQ-001").state.agentRuns?.[1]).toMatchObject({
        harness: "codex",
        model: "gpt-6.1-sol",
        reasoningEffort: "medium",
        status: "succeeded",
      });
      expect(executor.getLiveLog(startedEvents[1]!.runId)).toContain("dispatch harness=codex model=gpt-6.1-sol effort=medium");

      // 3. Returning to default routing through the same picker drops the override entirely.
      await clickReady(page, '[data-testid="banner-runner-select-trigger"]');
      await page.waitForSelector('[data-slot="command-item"]', { timeout: 5000 });
      await pickVisibleItem("默认路由");
      await page.waitForFunction(
        () => (document.querySelector('[data-testid="banner-runner-select-trigger"]')?.textContent ?? "").includes("默认 ("),
        { timeout: 5000 },
      );
      expect(await readTriggerLabel()).not.toContain("gpt-6.1-sol");
      expect(await readHiddenSelect()).toBe(`${presetDesign.harness}::${presetDesign.model}`);
      expect(await page.evaluate(() => (document.querySelector('[data-testid="banner-runner-select-effort"]') as HTMLSelectElement)?.value)).toBe("");

      await runWithCurrentSelection(3);
      expect(runCalls[2]!.body.harness).toBeUndefined();
      expect(runCalls[2]!.body.model).toBeUndefined();
      expect(runCalls[2]!.body.reasoningEffort).toBeUndefined();
      expect(runCalls[2]!.target).toEqual({ harness: presetDesign.harness, model: presetDesign.model });
      expect(getRequirement(repo, "REQ-001").state.agentRuns?.[2]).toMatchObject({
        harness: presetDesign.harness,
        model: presetDesign.model,
        status: "succeeded",
      });
      expect(executor.getLiveLog(startedEvents[2]!.runId)).toContain(
        `dispatch harness=${presetDesign.harness} model=${presetDesign.model} effort=none`,
      );
      expect(getRequirement(repo, "REQ-001").state.agentRuns?.[2]?.reasoningEffort).toBeUndefined();
      expect(startedEvents.map((e) => `${e.harness}/${e.model}`)).toEqual([
        `${presetDesign.harness}/${presetDesign.model}`,
        "codex/gpt-6.1-sol",
        `${presetDesign.harness}/${presetDesign.model}`,
      ]);

      // 4. Console run selector and Timeline runs badge localize action & status cleanly across language switches.
      await page.waitForSelector('[data-testid="console-pane"] [data-testid="console-run-select"]', { timeout: 5000 });
      const zhOptionText = await page.evaluate(
        () => document.querySelector('[data-testid="console-pane"] [data-testid="console-run-select"]')?.textContent ?? "",
      );
      expect(zhOptionText).toContain("设计 ·");
      expect(zhOptionText).toContain("(已完成)");

      await clickReady(page, '[data-testid="tab-timeline"]');
      await page.waitForFunction(
        () => (document.querySelector('[data-testid="workspace-tab-scroll"]')?.textContent ?? "").includes("设计 · 已完成"),
        { timeout: 5000 },
      );

      await selectUiOption(page, '[data-testid="ui-language-select"]', "en");
      await page.waitForFunction(
        () =>
          (document.querySelector('[data-testid="console-pane"] [data-testid="console-run-select"]')?.textContent ?? "").includes(
            "Design ·",
          ) &&
          (document.querySelector('[data-testid="console-pane"] [data-testid="console-run-select"]')?.textContent ?? "").includes(
            "(Completed)",
          ) &&
          (document.querySelector('[data-testid="workspace-tab-scroll"]')?.textContent ?? "").includes(
            "Design · Completed",
          ),
        { timeout: 5000 },
      );
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 45_000);

  test("REQ-003: bilingual interface keeps session, project, requirement, draft, and document language", async () => {
    const root = initGitRepo();
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-e2e-i18n-hub-"));
    tempDirs.push(hubDir);
    process.env.WORKBENCH_HUB_DIR = hubDir;
    await initProject(root, { name: "BilingualRepo", privacyMode: "local", outputLanguage: "en" });
    await createRequirement(root, {
      goal: "中文需求正文保留测试",
      criteria: [{ id: "AC-1", description: "中文验收条件原文", required: true, command: "echo ok" }],
    });
    await propose(root, "REQ-001", { designMarkdown: "# 中文方案标题\n\n方案正文原文保留。", actor: "agent" });
    // 已验收需求：用于在英文界面打开已固化验收证据，并确认中文历史原文保持可读。
    await createRequirement(root, {
      goal: "已验收证据中文原文",
      criteria: [
        { id: "AC-1", description: "验收通过并保留中文输出", required: true, command: "echo 中文历史证据原文" },
      ],
    });
    await propose(root, "REQ-002", { designMarkdown: "# 已验收方案", actor: "agent" });
    const acceptBaseline = await observeGitSnapshot(root);
    await approveDesign(root, "REQ-002", { baseline: acceptBaseline });
    await runVerification(root, "REQ-002", {
      command: "echo 中文历史证据原文",
      criterionIds: ["AC-1"],
    });
    const acceptedSnapshot = await observeGitSnapshot(root);
    await acceptRequirement(root, "REQ-002", { currentCodeSnapshotHash: acceptedSnapshot!.fingerprint });

    // 旧版已验收需求：验收记录缺少快照，用于英文界面下断言历史原文保留。
    await createRequirement(root, {
      goal: "旧版验收中文原文",
      criteria: [{ id: "AC-1", description: "旧版验收条件原文", required: true, command: "echo 旧版历史证据原文" }],
    });
    await propose(root, "REQ-003", { designMarkdown: "# 旧版中文方案", actor: "agent" });
    await approveDesign(root, "REQ-003", { baseline: acceptedSnapshot });
    await runVerification(root, "REQ-003", { command: "echo 旧版历史证据原文", criterionIds: ["AC-1"] });
    const legacyDone = await acceptRequirement(root, "REQ-003", {
      currentCodeSnapshotHash: acceptedSnapshot!.fingerprint,
    });
    const legacyState: RequirementState = {
      ...legacyDone.state,
      acceptance: {
        acceptedAt: legacyDone.state.acceptance!.acceptedAt,
        specHash: legacyDone.state.acceptance!.specHash,
        codeSnapshotHash: legacyDone.state.acceptance!.codeSnapshotHash,
        verificationIds: legacyDone.state.acceptance!.verificationIds,
      },
    };
    atomicWriteJson(path.join(root, ".workbench/items/REQ-003/state.json"), legacyState);

    // 实施中需求：用于验证英文界面下截图跳过原因的本地化即时提示。
    await createRequirement(root, {
      goal: "截图跳过英文提示",
      criteria: [{ id: "AC-1", description: "截图提示用例", required: true, command: "echo shot" }],
    });
    await propose(root, "REQ-004", { designMarkdown: "# 截图用例方案", actor: "agent" });
    await approveDesign(root, "REQ-004", { baseline: acceptedSnapshot });

    const server = await startWorkbenchServer({ root, port: 0, writeDiscovery: false, hostname: "0.0.0.0" });
    servers.push(server);
    const { password } = resetAuthPassword(hubDir);
    const lanUrl = `http://${os.hostname()}:${server.port}`;

    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));

    const readLang = () => page.evaluate(() => document.documentElement.lang);
    const readTitle = () => page.evaluate(() => document.title);
    const bodyText = () => page.evaluate(() => document.body.innerText);
    const selectLang = async (lang: string) => {
      await selectUiOption(page, '[data-testid="ui-language-select"]', lang);
      await page.waitForFunction(
        (expected) => document.documentElement.lang === (expected as string),
        { timeout: 5000 },
        lang,
      );
    };
    const clickModalAction = (testId: string, label: string) =>
      page.evaluate(
        (tid: string, text: string) => {
          const buttons = Array.from(
            document.querySelectorAll(`[data-testid="${tid}"] [data-slot="dialog-footer"] [data-slot="button"]`),
          ) as HTMLButtonElement[];
          const target = buttons.find((b) => (b.textContent ?? "").includes(text));
          if (!target) throw new Error(`modal action not found: ${text}`);
          target.click();
        },
        testId,
        label,
      );
    const readDocumentLanguages = () =>
      page.evaluate(async () => {
        const hub = (await (await fetch("/api/hub/state")).json()) as { outputLanguage?: string };
        const project = (await (await fetch("/api/project")).json()) as {
          project?: { outputLanguage?: string } | null;
        };
        return { hub: hub.outputLanguage ?? null, project: project.project?.outputLanguage ?? null };
      });

    try {
      await page.setViewport({ width: 1280, height: 860 });
      await page.goto(lanUrl, { waitUntil: "networkidle0" });

      // 1. 默认简体中文（登录门禁前）。
      expect(await readLang()).toBe("zh-CN");
      expect(await readTitle()).toContain("规范与验证");
      await page.waitForSelector('[data-testid="login-view"]', { timeout: 5000 });
      expect(await bodyText()).toContain("登录工作台");
      expect(
        await page.evaluate(() =>
          document.querySelector('[data-testid="ui-language-select"]')?.getAttribute("aria-label"),
        ),
      ).toBe("切换界面语言");

      // 2. 登录前切换英文并即时生效。
      await selectLang("en");
      expect(await readTitle()).toContain("Spec & Verification");
      expect(await bodyText()).toContain("Sign in");
      expect(
        await page.evaluate(() =>
          document.querySelector('[data-testid="ui-language-select"]')?.getAttribute("aria-label"),
        ),
      ).toBe("Switch interface language");

      // 2b. 已显示的登录错误随界面语言切换即时更新，而不是停留在请求失败时的语言。
      const wrongPin = password === "000000" ? "111111" : "000000";
      await page.type('[data-testid="login-password-input"]', wrongPin);
      await clickReady(page, '[data-testid="login-submit-btn"]');
      await page.waitForFunction(
        () =>
          (document.querySelector('[data-testid="login-error"]')?.textContent ?? "").includes(
            "Incorrect access PIN",
          ),
        { timeout: 5000 },
      );
      await selectLang("zh-CN");
      await page.waitForFunction(
        () =>
          (document.querySelector('[data-testid="login-error"]')?.textContent ?? "").includes(
            "访问密码错误，请重试",
          ),
        { timeout: 5000 },
      );

      // 3. 重新加载清空错误与输入，切到英文后登录，并记录模型文档语言设置。
      await page.goto(lanUrl, { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="login-view"]', { timeout: 5000 });
      await selectLang("en");
      await page.type('[data-testid="login-password-input"]', password);
      await clickReady(page, '[data-testid="login-submit-btn"]');
      await page.waitForSelector('[data-testid="req-list"]', { timeout: 5000 });
      expect(await bodyText()).toContain("New requirement");
      const docLanguagesBefore = await readDocumentLanguages();
      expect(docLanguagesBefore.project).toBe("en");

      // 4. 英文界面下保留中文需求正文，并渲染英文状态横幅/验证反馈/批注控件。
      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="action-banner"]', { timeout: 5000 });
      const workspaceText = await bodyText();
      expect(workspaceText).toContain("中文需求正文保留测试");
      expect(workspaceText).toContain("中文验收条件原文");
      expect(workspaceText).toContain("中文方案标题");
      expect(workspaceText).toContain("submitted design v1");
      expect(workspaceText).toContain("Verification has not run yet");
      expect(workspaceText).toContain("Annotate");
      expect(await page.evaluate(() => document.querySelector('[data-testid="ws-stage-badge"]')?.textContent)).toBe(
        "Planning",
      );
      expect(
        await page.evaluate(() => document.querySelector('[data-testid="ws-derived-status-badge"]')?.textContent),
      ).toBe("Awaiting approval");

      // 4b. 英文界面下的批注弹窗与控件。
      await page.click('[data-action="annotate-anchor"]');
      await page.waitForSelector('[data-testid="annotate-modal"]', { timeout: 5000 });
      expect(await bodyText()).toContain("Section annotation & question");
      expect(await bodyText()).toContain("Add & ask now");
      expect(
        await page.evaluate(
          () => (document.querySelector('[data-testid="annotate-msg"]') as HTMLTextAreaElement | null)?.placeholder,
        ),
      ).toContain("Enter a question about this section");
      await clickModalAction("annotate-modal", "Cancel");
      await page.waitForFunction(() => !document.querySelector('[data-testid="annotate-modal"]'), {
        timeout: 5000,
      });

      // 5. 编辑草稿在切换语言后保留，当前需求与视图不丢失。
      await clickReady(page, '[data-testid="start-edit-design-btn"]');
      await page.type('[data-testid="design-body-input"]', "\n未提交的设计草稿保留");
      await selectLang("zh-CN");
      expect(await readTitle()).toContain("规范与验证");
      expect(await bodyText()).toContain("Agent 已提交技术方案 v1");
      expect(await bodyText()).toContain("尚未运行验证");
      expect(await page.evaluate(() => document.querySelector('[data-testid="ws-stage-badge"]')?.textContent)).toBe(
        "规划中",
      );
      expect(
        await page.evaluate(() => document.querySelector('[data-testid="ws-derived-status-badge"]')?.textContent),
      ).toBe("待批准");
      // 5b. 中文界面下的批注、设置与报修文案同样完整。
      await page.click('[data-action="annotate-anchor"]');
      await page.waitForSelector('[data-testid="annotate-modal"]', { timeout: 5000 });
      expect(await bodyText()).toContain("段落批注与提问");
      expect(await bodyText()).toContain("加入并立即提问");
      await clickModalAction("annotate-modal", "取消");
      await page.waitForFunction(() => !document.querySelector('[data-testid="annotate-modal"]'), {
        timeout: 5000,
      });
      await clickReady(page, '[data-testid="open-routing-btn"]');
      await page.waitForSelector('[data-testid="routing-modal"]', { timeout: 5000 });
      expect(await bodyText()).toContain("工作台设置");
      await clickModalAction("routing-modal", "取消");
      await page.waitForFunction(() => !document.querySelector('[data-testid="routing-modal"]'), {
        timeout: 5000,
      });
      const draftValue = await page.evaluate(
        () => (document.querySelector('[data-testid="design-body-input"]') as HTMLTextAreaElement | null)?.value ?? "",
      );
      expect(draftValue).toContain("未提交的设计草稿保留");
      expect(await page.evaluate(() => document.querySelector(".app-req-id")?.textContent)).toBe("REQ-001");

      // 6. 切回英文后刷新：偏好持久化，界面与标题恢复英文。
      await selectLang("en");
      expect(await page.evaluate(() => localStorage.getItem("wb-ui-language"))).toBe("en");
      await page.goto(lanUrl, { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="req-list"]', { timeout: 5000 });
      expect(await readLang()).toBe("en");
      expect(await readTitle()).toContain("Spec & Verification");

      // 7. 非法偏好回退简体中文。
      await page.evaluate(() => localStorage.setItem("wb-ui-language", "fr"));
      await page.goto(lanUrl, { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="req-list"]', { timeout: 5000 });
      expect(await readLang()).toBe("zh-CN");
      expect(await readTitle()).toContain("规范与验证");

      // 7b. 英文界面打开已固化的验收证据：界面标题本地化，中文历史命令与输出原文保留。
      await selectLang("en");
      await page.click('[data-action="set-scope"][data-value="done"]');
      await page.waitForSelector('[data-testid="req-row-REQ-002"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="req-row-REQ-002"]');
      await page.waitForSelector('[data-testid="tab-changes"]', { timeout: 5000 });
      await page.click('[data-testid="tab-changes"]');
      await page.waitForSelector('[data-testid^="ev-"]', { timeout: 5000 });
      const acceptedEvidenceText = await bodyText();
      expect(acceptedEvidenceText).toContain("Frozen acceptance snapshot");
      expect(acceptedEvidenceText).toContain("echo 中文历史证据原文");
      expect(acceptedEvidenceText).toContain("中文历史证据原文");
      await page.click('[data-action="toggle-log"]');
      await page.waitForFunction(
        () =>
          Boolean(
            document
              .querySelector(".evidence-log")
              ?.textContent?.includes("中文历史证据原文"),
          ),
        { timeout: 5000 },
      );
      await clickReady(page, '[data-testid="back-home-btn"]');
      // 7c. 英文界面打开旧版验收记录：界面标题本地化，中文历史命令与输出原文保留。
      await page.waitForSelector('[data-testid="req-row-REQ-003"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="req-row-REQ-003"]');
      await page.waitForSelector('[data-testid="evidence-provenance-banner"]', { timeout: 5000 });
      expect(await bodyText()).toContain("Legacy acceptance record (no diff snapshot)");
      await page.click('[data-testid="tab-diff"]');
      await page.waitForSelector('[data-testid="diff-unavailable-notice"]', { timeout: 5000 });
      const legacyEvidenceText = await bodyText();
      expect(legacyEvidenceText).toContain("Historical code diff unavailable");
      await page.click('[data-testid="tab-changes"]');
      await page.waitForSelector('[data-testid^="ev-"]', { timeout: 5000 });
      const legacyVerifyText = await bodyText();
      expect(legacyVerifyText).toContain("echo 旧版历史证据原文");
      expect(legacyVerifyText).toContain("旧版历史证据原文");
      await page.click('[data-action="toggle-log"]');
      await page.waitForFunction(
        () =>
          Boolean(
            document
              .querySelector(".evidence-log")
              ?.textContent?.includes("旧版历史证据原文"),
          ),
        { timeout: 5000 },
      );
      await clickReady(page, '[data-testid="back-home-btn"]');
      await page.click('[data-action="set-scope"][data-value="active"]');
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 5000 });

      // 8. 设置与报修弹窗随界面语言呈现，模型文档语言保持不变。
      await selectLang("en");
      await clickReady(page, '[data-testid="open-routing-btn"]');
      await page.waitForSelector('[data-testid="routing-modal"]', { timeout: 5000 });
      expect(await bodyText()).toContain("Workspace settings");
      await page.click('[data-testid="settings-tab-project"]');
      expect(
        await page.evaluate(
          () => document.querySelector('[data-testid="project-output-language-select"]')?.getAttribute("data-value") ?? "",
        ),
      ).toBe("en");
      await page.click('[data-testid="project-provider-gitee"]');
      await page.waitForSelector('[data-testid="project-provider-status"]', { timeout: 15_000 });
      const giteeStatusText = await page.evaluate(
        () => document.querySelector('[data-testid="project-provider-status"]')?.textContent ?? "",
      );
      expect(giteeStatusText.length).toBeGreaterThan(0);
      expect(/[\u4e00-\u9fff]/.test(giteeStatusText)).toBe(false);
      await page.type('[data-testid="project-gitee-base-input"]', " bad");
      await page.click('[data-testid="save-project-btn"]');
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll('[data-slot="toast-root"]')).some((el) =>
            (el.textContent ?? "").includes("Invalid Git branch name"),
          ),
        { timeout: 10_000 },
      );
      const branchToast = await page.evaluate(
        () =>
          Array.from(document.querySelectorAll('[data-slot="toast-root"]'))
            .map((el) => el.textContent ?? "")
            .find((txt) => txt.includes("Invalid Git branch name")) ?? "",
      );
      expect(/[\u4e00-\u9fff]/.test(branchToast)).toBe(false);
      await page.click('[data-testid="project-provider-github"]');
      await page.waitForSelector('[data-testid="project-provider-status"]', { timeout: 15_000 });
      const githubStatusText = await page.evaluate(
        () => document.querySelector('[data-testid="project-provider-status"]')?.textContent ?? "",
      );
      expect(githubStatusText.length).toBeGreaterThan(0);
      expect(/[\u4e00-\u9fff]/.test(githubStatusText)).toBe(false);
      await page.type('[data-testid="project-github-repo-input"]', "bad repo");
      await page.click('[data-testid="save-project-btn"]');
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll('[data-slot="toast-root"]')).some((el) =>
            (el.textContent ?? "").includes("Invalid GitHub repository slug"),
          ),
        { timeout: 10_000 },
      );
      const repoToast = await page.evaluate(
        () =>
          Array.from(document.querySelectorAll('[data-slot="toast-root"]'))
            .map((el) => el.textContent ?? "")
            .find((txt) => txt.includes("Invalid GitHub repository slug")) ?? "",
      );
      expect(/[\u4e00-\u9fff]/.test(repoToast)).toBe(false);
      await selectLang("zh-CN");
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll('[data-slot="toast-root"]')).some((el) =>
            (el.textContent ?? "").includes("无效的 GitHub 仓库标识"),
          ),
        { timeout: 10_000 },
      );
      await selectLang("en");
      await clickModalAction("routing-modal", "Cancel");
      await page.waitForFunction(() => !document.querySelector('[data-testid="routing-modal"]'), { timeout: 5000 });

      // 8b. 英文界面导入无效 GitHub Issue 编号时返回本地化校验提示。
      await clickReady(page, '[data-testid="new-req-btn"]');
      await page.waitForSelector('[data-testid="new-req-mode-import"]', { timeout: 5000 });
      await page.click('[data-testid="new-req-mode-import"]');
      await page.waitForSelector('[data-testid="import-issue-ref"]', { timeout: 5000 });
      await page.type('[data-testid="import-issue-ref"]', "bad-gh-ref!!");
      await clickReady(page, '[data-testid="import-issue-draft-btn"]');
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll('[data-slot="toast-root"]')).some((el) =>
            (el.textContent ?? "").includes("Please enter a valid GitHub Issue number"),
          ),
        { timeout: 10_000 },
      );
      const ghImportToast = await page.evaluate(
        () =>
          Array.from(document.querySelectorAll('[data-slot="toast-root"]'))
            .map((el) => el.textContent ?? "")
            .find((txt) => txt.includes("Please enter a valid GitHub Issue number")) ?? "",
      );
      expect(/[\u4e00-\u9fff]/.test(ghImportToast)).toBe(false);
      await clickModalAction("new-req-modal", "Cancel");
      await page.waitForFunction(() => !document.querySelector('[data-testid="new-req-modal"]'), { timeout: 5000 });
      await clickReady(page, '[data-testid="open-routing-btn"]');
      await page.waitForSelector('[data-testid="routing-modal"]', { timeout: 5000 });
      expect(await bodyText()).toContain("Workspace settings");
      await clickModalAction("routing-modal", "Cancel");
      await page.waitForFunction(() => !document.querySelector('[data-testid="routing-modal"]'), { timeout: 5000 });
      expect(await readDocumentLanguages()).toEqual(docLanguagesBefore);

      // 9. 客户端错误反馈在英文界面下本地化。
      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="tab-changes"]', { timeout: 5000 });
      await page.click('[data-testid="tab-changes"]');
      await clickReady(page, '[data-testid="manual-verify-btn"]');
      await page.waitForFunction(
        () =>
          (document.querySelector('[data-slot="toast-root"]')?.textContent ?? "").includes(
            "Enter a verification command first",
          ),
        { timeout: 5000 },
      );
      // 9b. 已显示的即时错误提示随语言切换重新渲染为当前语言。
      await selectLang("zh-CN");
      await page.waitForFunction(
        () =>
          (document.querySelector('[data-slot="toast-root"]')?.textContent ?? "").includes(
            "请先输入验证命令",
          ),
        { timeout: 5000 },
      );
      await selectLang("en");
      await page.waitForFunction(
        () =>
          (document.querySelector('[data-slot="toast-root"]')?.textContent ?? "").includes(
            "Enter a verification command first",
          ),
        { timeout: 5000 },
      );

      // 9c. 英文界面下截图跳过原因显示本地化即时提示，且随语言切换更新；历史批次原文不受影响。
      await clickReady(page, '[data-testid="back-home-btn"]');
      await page.click('[data-action="set-scope"][data-value="active"]');
      await page.waitForSelector('[data-testid="req-row-REQ-004"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="req-row-REQ-004"]');
      await page.waitForSelector('[data-testid="tab-changes"]', { timeout: 5000 });
      await page.click('[data-testid="tab-changes"]');
      const originalChromePath = process.env.WORKBENCH_CHROME_PATH;
      process.env.WORKBENCH_CHROME_PATH = "/definitely/missing/chrome";
      try {
        await clickReady(page, '[data-testid="screenshot-recapture"]');
        await page.waitForFunction(
          () =>
            (document.querySelector('[data-slot="toast-root"]')?.textContent ?? "").includes(
              "does not exist",
            ),
          { timeout: 5000 },
        );
        await selectLang("zh-CN");
        await page.waitForFunction(
          () =>
            (document.querySelector('[data-slot="toast-root"]')?.textContent ?? "").includes(
              "指向的浏览器不存在",
            ),
          { timeout: 5000 },
        );
      } finally {
        if (originalChromePath === undefined) delete process.env.WORKBENCH_CHROME_PATH;
        else process.env.WORKBENCH_CHROME_PATH = originalChromePath;
      }
      await selectLang("en");

      // 10. 窄屏仍可使用语言入口；存储不可用时本会话仍可切换。
      await page.setViewport({ width: 375, height: 720 });
      const languageBox = await page.evaluate(() => {
        const sel = document.querySelector('[data-testid="ui-language-select"]');
        const rect = sel?.getBoundingClientRect();
        return { width: rect?.width ?? 0, overflow: document.documentElement.scrollWidth > window.innerWidth };
      });
      expect(languageBox.width).toBeGreaterThan(0);
      expect(languageBox.overflow).toBe(false);
      await page.evaluate(() => {
        const proto = Storage.prototype;
        (proto as unknown as Record<string, unknown>).__origGet = proto.getItem;
        (proto as unknown as Record<string, unknown>).__origSet = proto.setItem;
        proto.getItem = () => {
          throw new Error("storage blocked");
        };
        proto.setItem = () => {
          throw new Error("storage blocked");
        };
      });
      await selectUiOption(page, '[data-testid="ui-language-select"]', "zh-CN");
      await page.waitForFunction(() => document.documentElement.lang === "zh-CN", { timeout: 5000 });
      expect(await bodyText()).toContain("验证与截图");
      await page.evaluate(() => {
        const proto = Storage.prototype as unknown as Record<string, unknown>;
        proto.getItem = proto.__origGet as typeof Storage.prototype.getItem;
        proto.setItem = proto.__origSet as typeof Storage.prototype.setItem;
      });

      // 11. 启动前即禁用/拒绝读取 browser localStorage 时仍能以简体中文正常启动并在当前会话切换到英文。
      const blockedPage = await browser!.newPage();
      const blockedErrors: string[] = [];
      blockedPage.on("pageerror", (err: Error) => blockedErrors.push(err.message));
      try {
        await blockedPage.evaluateOnNewDocument(() => {
          Object.defineProperty(window, "localStorage", {
            configurable: true,
            get() {
              throw new DOMException("Storage access denied", "SecurityError");
            },
          });
        });
        await blockedPage.setViewport({ width: 1360, height: 860 });
        await blockedPage.goto(`http://127.0.0.1:${server.port}`, { waitUntil: "networkidle0" });
        expect(blockedErrors).toEqual([]);
        await blockedPage.waitForSelector('[data-testid="ui-language-select"]', { timeout: 10_000 });
        expect(await blockedPage.evaluate(() => document.documentElement.lang)).toBe("zh-CN");
        await selectUiOption(blockedPage, '[data-testid="ui-language-select"]', "en");
        await blockedPage.waitForFunction(() => document.documentElement.lang === "en", { timeout: 5000 });
        expect(await blockedPage.evaluate(() => document.body.innerText)).toContain("Workbench");
        expect(blockedErrors).toEqual([]);
      } finally {
        await blockedPage.close();
      }

      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 90_000);

  test("IDE 侧栏待拍板过滤无裁剪、Diff 多文件搜索隔离与 backHome 非破坏性编辑保护", async () => {
    const root = initGitRepo();
    await initProject(root, { name: "ReviewFixRepo", privacyMode: "local" });
    await createRequirement(root, {
      goal: "待拍板与多文件 Diff 测试",
      criteria: [{ id: "AC-1", description: "passes", required: true, command: "echo ok" }],
    });
    await propose(root, "REQ-001", {
      designMarkdown: "# 多文件变更方案\n",
      actor: "agent",
    });
    await createRequirement(root, { goal: "普通草稿需求" });

    // Edit 4 files so DiffViewerPanel displays diff-file-search
    for (const file of ["alpha.ts", "beta.ts", "gamma.ts", "delta.ts"]) {
      fs.writeFileSync(path.join(root, file), `export const name = "${file}";\n`);
    }

    const server = await startWorkbenchServer({ root, port: 0, writeDiscovery: false });
    servers.push(server);
    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));

    try {
      await page.setViewport({ width: 1360, height: 860 });
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="scope-tabs"]', { timeout: 5000 });

      // 1. All 4 scope tabs (including "待拍板 (1)") fit cleanly inside the 310px sidebar without overflow/clipping
      const tabsFit = await page.evaluate(() => {
        const container = document.querySelector('[data-testid="scope-tabs"]') as HTMLElement | null;
        if (!container) return null;
        const cr = container.getBoundingClientRect();
        const btns = Array.from(container.querySelectorAll("button")).map((b) => {
          const r = b.getBoundingClientRect();
          return {
            text: b.textContent?.trim() ?? "",
            role: b.getAttribute("role"),
            overflowX: b.scrollWidth > b.clientWidth + 1,
            outside: r.right > cr.right + 1 || r.left < cr.left - 1,
          };
        });
        return { containerOverflow: container.scrollWidth > container.clientWidth + 1, btns };
      });
      expect(tabsFit?.containerOverflow).toBe(false);
      expect(tabsFit?.btns.every((b) => b.role === "tab" && !b.overflowX && !b.outside)).toBe(true);

      // 2. "decisions" scope tab filters to only pending-decision REQ-001, and REQ-001 appears only once in unified list
      expect(await page.evaluate(() => document.querySelectorAll('[data-testid="req-row-REQ-001"]').length)).toBe(1);
      expect(await page.evaluate(() => Boolean(document.querySelector('[data-testid="req-decision-badge-REQ-001"]')))).toBe(true);
      await clickReady(page, '[data-action="set-scope"][data-value="decisions"]');
      await page.waitForFunction(() => document.querySelectorAll(".req-row").length === 1, { timeout: 5000 });
      expect(
        await page.evaluate(() => document.querySelector(".req-row")?.getAttribute("data-testid")),
      ).toBe("req-row-REQ-001");
      await clickReady(page, '[data-action="set-scope"][data-value="active"]');

      // 3. Multi-file diff filtering, zero-match empty state, and independent drawer filter state
      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await clickReady(page, '[data-testid="tab-diff"]');
      await page.waitForSelector('[data-testid="diff-file-search"]', { timeout: 5000 });
      await page.type('[data-testid="diff-file-search"]', "beta");
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="diff-viewer-panel"] .diff-file-btn').length === 1,
        { timeout: 5000 },
      );
      expect(
        await page.evaluate(() => document.querySelector('[data-testid="diff-viewer-panel"] .diff-code')?.textContent ?? ""),
      ).toContain("beta.ts");

      await page.type('[data-testid="diff-file-search"]', "zzz-nonexistent");
      await page.waitForSelector('[data-testid="diff-empty-filter"]', { timeout: 5000 });
      expect(
        await page.evaluate(() => Boolean(document.querySelector('[data-testid="diff-viewer-panel"] .diff-code'))),
      ).toBe(false);
      await clickReady(page, '[data-testid="diff-clear-filter-btn"]');
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="diff-viewer-panel"] .diff-file-btn').length === 4,
        { timeout: 5000 },
      );

      await clickReady(page, '[data-testid="dock-diff-to-drawer-btn"]');
      await page.waitForFunction(
        () => (document.querySelector('[data-testid="drawer-diff-panel"]')?.getBoundingClientRect().width ?? 0) >= 300,
        { timeout: 5000 },
      );
      await clickReady(page, '[data-testid="drawer-diff-file-search"]');
      await page.type('[data-testid="drawer-diff-file-search"]', "gamma");
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="drawer-diff-panel"] .diff-file-btn').length === 1,
        { timeout: 5000 },
      );
      expect(
        await page.evaluate(() => document.querySelectorAll('[data-testid="diff-viewer-panel"] .diff-file-btn').length),
      ).toBe(4);
      await clickReady(page, '[data-testid="toggle-drawer-btn"]');

      // 4. Clicking back-home-btn preserves in-progress design editing draft
      await clickReady(page, '[data-testid="tab-spec"]');
      await page.waitForSelector('[data-testid="start-edit-design-btn"]', { timeout: 5000 });
      await page.evaluate(() => {
        document.querySelector('[data-testid="start-edit-design-btn"]')?.scrollIntoView({ block: "center" });
      });
      await clickReady(page, '[data-testid="start-edit-design-btn"]');
      await page.waitForSelector('[data-testid="save-design-btn"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="back-home-btn"]');
      expect(await page.evaluate(() => Boolean(document.querySelector('[data-testid="save-design-btn"]')))).toBe(true);

      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 40_000);
});
