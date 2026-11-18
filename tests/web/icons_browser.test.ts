import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { approveDesign, createRequirement, initProject, propose, updateTasks } from "../../src/core/engine.ts";
import { runVerification } from "../../src/core/runner.ts";
import { HubExecutor } from "../../src/hub/executor.ts";
import { registerHubProject } from "../../src/hub/registry.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";

import { CHROME_PATH, HAS_BROWSER, PUPPETEER_PATH } from "./browser_env.ts";
const SCREENSHOT_DIR = "/tmp/opencode/req-001-visual";

const DESIGN_MD = [
  "# 图标验收设计",
  "",
  "正文段落保留 <b>原始内容</b> 与 `inline code`。",
  "",
  "## 安全 <b>转义</b> & 注入",
  "",
  '用户文本 data-icon-slot="annotate" 不得生成应用插槽。',
  "",
  '### data-icon-slot="annotate"',
  "",
  "最终小节。",
].join("\n");

interface BrowserPage {
  setViewport(vp: { width: number; height: number }): Promise<void>;
  goto(url: string, opts?: { waitUntil?: string }): Promise<unknown>;
  waitForSelector(sel: string, opts?: { timeout?: number }): Promise<unknown>;
  waitForFunction(
    fn: string | ((...args: any[]) => boolean),
    opts?: { timeout?: number },
    ...args: unknown[]
  ): Promise<unknown>;
  click(sel: string): Promise<void>;
  type(sel: string, text: string): Promise<void>;
  evaluate<T>(fn: (...args: any[]) => T, ...args: any[]): Promise<T>;
  keyboard: { press(key: string): Promise<void> };
  screenshot(opts: { path: string; fullPage?: boolean }): Promise<unknown>;
  on(ev: string, fn: (...args: any[]) => void): void;
  close(): Promise<void>;
}

// Real mouse click on the generated annotation SVG path. Waits until the path is
// the topmost element at its own click point so transient toasts cannot swallow it.
async function clickAnnotationIcon(page: BrowserPage): Promise<void> {
  await page.waitForSelector(".md-annot-btn svg path", { timeout: 5000 });
  await page.waitForFunction(
    () => {
      const path = document.querySelector(".md-annot-btn svg path") as SVGPathElement | null;
      if (!path) return false;
      path.scrollIntoView({ block: "center" });
      const rect = path.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return Boolean(hit && path.closest(".md-annot-btn")?.contains(hit));
    },
    { timeout: 8000 },
  );
  await page.click(".md-annot-btn svg path");
}

interface BrowserInstance {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

const tempDirs: string[] = [];
const servers: WorkbenchServerHandle[] = [];
const origHubDir = process.env.WORKBENCH_HUB_DIR;
let browser: BrowserInstance | null = null;

function initGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-icons-e2e-"));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "calc.ts"), "export const add = (a: number, b: number) => a + b;\n");
  execFileSync("git", ["add", "calc.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });
  return dir;
}

async function seedRequirement(root: string): Promise<void> {
  await initProject(root, { name: "Icons E2E", privacyMode: "local" });
  await createRequirement(root, {
    goal: "图标组件库可访问性与交互验证",
    criteria: [
      { id: "AC-1", description: "通过状态", required: true, command: "sleep 0.4; echo icon-ok" },
      { id: "AC-2", description: "失败状态", required: false, command: "sh -c 'exit 1'" },
      { id: "AC-3", description: "过期状态", required: false, command: "echo stale-seed" },
      { id: "AC-4", description: "未验证状态", required: false },
    ],
  });
  await propose(root, "REQ-001", { designMarkdown: DESIGN_MD, actor: "agent" });
  await approveDesign(root, "REQ-001");
  await updateTasks(root, "REQ-001", {
    tasks: [
      { title: "待开始步骤", status: "pending" },
      { title: "进行中步骤", status: "in_progress" },
      { title: "已完成步骤", status: "done" },
      { title: "受阻步骤", status: "blocked" },
    ],
  });

  // Create one of each coverage state: passed / failed / stale / unverified.
  await runVerification(root, "REQ-001", { command: "sleep 0.4; echo icon-ok", criterionIds: ["AC-1"] });
  await runVerification(root, "REQ-001", { command: "sh -c 'exit 1'", criterionIds: ["AC-2"] });
  await runVerification(root, "REQ-001", { command: "echo stale-seed", criterionIds: ["AC-3"] });

  // Changing code makes AC-3 stale. Re-run only AC-1/AC-2 so the four states coexist.
  fs.appendFileSync(path.join(root, "calc.ts"), "// icon e2e snapshot change\n");
  await runVerification(root, "REQ-001", { command: "sleep 0.4; echo icon-ok", criterionIds: ["AC-1"] });
  await runVerification(root, "REQ-001", { command: "sh -c 'exit 1'", criterionIds: ["AC-2"] });
}

async function setup(): Promise<{ server: WorkbenchServerHandle; page: BrowserPage; root: string }> {
  const root = initGitRepo();
  await seedRequirement(root);

  const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-icons-hub-"));
  tempDirs.push(hubDir);
  process.env.WORKBENCH_HUB_DIR = hubDir;
  registerHubProject(root, { name: "Icons E2E", activate: true });

  const executor = new HubExecutor({
    initialHarnesses: [
      {
        id: "opencode",
        label: "OpenCode",
        subscription: "Test",
        installed: true,
        executable: "opencode",
        models: [{ id: "deepseek-v4.1-flash-free", tier: "fast", source: "detected" }],
        defaultModel: "deepseek-v4.1-flash-free",
        detectedAt: Date.now(),
      },
    ],
    commandBuilder: () => ({
      command: "bash",
      args: ["-c", "echo mock-model-run"],
      displayCommand: "mock-model-run",
    }),
  });

  const server = await startWorkbenchServer({
    root,
    port: 0,
    writeDiscovery: false,
    hubMode: true,
    executor,
  });
  servers.push(server);

  const page = await browser!.newPage();
  await page.setViewport({ width: 1360, height: 860 });
  await page.goto(server.url, { waitUntil: "networkidle0" });
  await page.waitForSelector('[data-testid="hub-sidebar"]', { timeout: 10_000 });
  await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 10_000 });
  await page.click('[data-testid="req-row-REQ-001"]');
  await page.waitForSelector('[data-testid="ws-stage-badge"]', { timeout: 10_000 });
  return { server, page, root };
}

beforeAll(async () => {
  if (!HAS_BROWSER) {
    throw new Error(
      `Browser prerequisites missing (chromium=${CHROME_PATH}, puppeteer=${PUPPETEER_PATH}); ` +
        "REQ-001 browser criteria require real browser execution and must not be skipped.",
    );
  }
  const mod = (await import(PUPPETEER_PATH)) as {
    default: { launch(opts: Record<string, unknown>): Promise<BrowserInstance> };
  };
  browser = await mod.default.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
}, 20_000);

afterEach(() => {
  while (servers.length > 0) servers.pop()!.stop();
  if (origHubDir === undefined) delete process.env.WORKBENCH_HUB_DIR;
  else process.env.WORKBENCH_HUB_DIR = origHubDir;
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

afterAll(async () => {
  if (browser) {
    await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 2000))]);
  }
}, 15_000);

describe("REQ-001 real browser icon behavior", () => {
  test("AC-3: icon-only controls, decorative SVGs, status text, and core interactions", async () => {
    const { page } = await setup();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));

    try {
      expect(await page.evaluate(() => document.querySelector('[data-testid="ws-stage-badge"]')?.textContent)).toContain(
        "实施中",
      );

      const svgReport = await page.evaluate(() => {
        const svgs = Array.from(document.querySelectorAll("svg.ui-icon")) as SVGElement[];
        const iconOnly = Array.from(document.querySelectorAll("button"))
          .filter((button) => (button.textContent ?? "").trim() === "" && button.querySelector("svg.ui-icon"))
          .map((button) => {
            const el = button as HTMLElement;
            return {
              name: el.getAttribute("aria-label") || el.getAttribute("title") || "",
              testid: el.getAttribute("data-testid") || "",
              action: el.getAttribute("data-action") || "",
            };
          });
        return {
          count: svgs.length,
          badHidden: svgs.filter(
            (svg) => svg.getAttribute("aria-hidden") !== "true" || svg.getAttribute("focusable") !== "false",
          ).length,
          iconOnly,
          optionsWithSvg: document.querySelectorAll("option svg").length,
        };
      });

      expect(svgReport.count).toBeGreaterThan(15);
      expect(svgReport.badHidden).toBe(0);
      expect(svgReport.optionsWithSvg).toBe(0);
      expect(svgReport.iconOnly.length).toBeGreaterThan(0);
      for (const control of svgReport.iconOnly) {
        expect(control.name, `icon-only control ${control.testid || control.action} needs an accessible name`).not.toBe(
          "",
        );
      }

      for (const [cid, label] of [
        ["AC-1", "通过"],
        ["AC-2", "失败"],
        ["AC-3", "需重跑"],
        ["AC-4", "未验证"],
      ] as const) {
        const row = await page.evaluate(
          (id: string) => document.querySelector(`[data-testid="crit-${id}"]`)?.textContent ?? "",
          cid,
        );
        expect(row, `${cid} must keep its textual status label`).toContain(label);
        const iconCount = await page.evaluate(
          (id: string) => document.querySelectorAll(`[data-testid="crit-${id}"] .badge svg.ui-icon`).length,
          cid,
        );
        expect(iconCount).toBe(1);
      }

      // Task/coverage metadata keeps readable labels next to bitmap-free icons.
      await page.click('[data-testid="tab-changes"]');
      await page.waitForSelector(".task-row", { timeout: 5000 });
      const taskLabels = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".task-row .badge")).map((el) => ({
          text: el.textContent ?? "",
          icons: el.querySelectorAll("svg.ui-icon").length,
        })),
      );
      expect(taskLabels.map((t) => t.text.trim())).toEqual(["待开始", "进行中", "已完成", "受阻"]);
      expect(taskLabels.every((t) => t.icons === 1)).toBe(true);

      // Drawer discussion/terminal tabs and close control keep their original interaction.
      await page.click('[data-testid="toggle-drawer-btn"]');
      await page.waitForSelector('[data-testid="right-drawer"].open', { timeout: 5000 });
      await page.click('[data-testid="drawer-tab-console"]');
      await page.waitForSelector('[data-testid="console-pane"]', { timeout: 5000 });
      expect(await page.evaluate(() => Boolean(document.querySelector('[data-testid="discuss-pane"]')))).toBe(false);
      await page.click('[data-testid="drawer-tab-discuss"]');
      await page.waitForSelector('[data-testid="discuss-pane"]', { timeout: 5000 });
      await page.click('[aria-label="收起右侧栏"]');
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="right-drawer"]')?.classList.contains("open"),
        { timeout: 5000 },
      );

      // Theme controls stay interactive and expose their accessible names.
      const beforeTheme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
      const themeLabel = await page.evaluate(() =>
        document.querySelector('[data-action="toggle-theme"]')?.getAttribute("aria-label"),
      );
      expect(themeLabel).toMatch(/^切换到(浅色|深色)主题$/);
      await page.click('[data-action="toggle-theme"]');
      await page.waitForFunction(
        (prev: string | null) => document.documentElement.getAttribute("data-theme") !== prev,
        { timeout: 5000 },
        beforeTheme,
      );

      // Mobile menu opens the hub sidebar and its close button collapses it again.
      await page.setViewport({ width: 390, height: 844 });
      await page.click('[aria-label="项目与算力侧栏"]');
      await page.waitForSelector('[data-testid="hub-sidebar"].open', { timeout: 5000 });
      await page.click('[aria-label="收起侧边栏"]');
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="hub-sidebar"]')?.classList.contains("open"),
        { timeout: 5000 },
      );

      // Run action: disabled while verification is busy, then enabled again.
      await page.setViewport({ width: 1360, height: 860 });
      await page.click('[data-testid="tab-changes"]');
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll("button")).some((button) => button.textContent?.trim() === "运行全部验证"),
        { timeout: 5000 },
      );
      await page.evaluate(() => {
        const button = Array.from(document.querySelectorAll("button")).find(
          (candidate) => candidate.textContent?.trim() === "运行全部验证",
        ) as HTMLButtonElement | undefined;
        button?.click();
      });
      await page.waitForFunction(
        () =>
          (Array.from(document.querySelectorAll("button")).find(
            (candidate) => candidate.textContent?.trim() === "运行全部验证",
          ) as HTMLButtonElement | undefined)?.disabled === true,
        { timeout: 3000 },
      );
      await page.waitForFunction(
        () =>
          (Array.from(document.querySelectorAll("button")).find(
            (candidate) => candidate.textContent?.trim() === "运行全部验证",
          ) as HTMLButtonElement | undefined)?.disabled === false,
        { timeout: 15_000 },
      );
      await page.waitForSelector(".evidence-card", { timeout: 5000 });

      // Every visible icon-only control remains keyboard-focusable.
      const focusable = await page.evaluate(() => {
        const controls = Array.from(document.querySelectorAll("button"))
          .filter((button) => (button.textContent ?? "").trim() === "" && button.querySelector("svg.ui-icon"))
          .filter((button) => {
            const rect = button.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
        return controls.map((el) => {
          const button = el as HTMLButtonElement;
          button.focus();
          return document.activeElement === button && button.tabIndex >= 0;
        });
      });
      expect(focusable.length).toBeGreaterThan(0);
      expect(focusable.every(Boolean)).toBe(true);

      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 45_000);

  test("AC-4: Markdown annotation icon portals survive edits/unmount, escape user content, and avoid clipping", async () => {
    const { page } = await setup();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

    const modalOpen = async () => Boolean(await page.evaluate(() => document.querySelector('[data-testid="annotate-modal"]')));
    const closeModal = async () => {
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('[data-testid="annotate-modal"] button'));
        const cancel = buttons.find((button) => (button.textContent ?? "").trim() === "取消");
        (cancel as HTMLButtonElement | undefined)?.click();
      });
      await page.waitForFunction(() => !document.querySelector('[data-testid="annotate-modal"]'), { timeout: 5000 });
    };

    try {
      await page.waitForSelector(".md-annot-row", { timeout: 5000 });

      const initial = await page.evaluate(() => ({
        rows: document.querySelectorAll(".md-annot-row").length,
        slots: document.querySelectorAll('[data-icon-slot="annotate"]').length,
        icons: document.querySelectorAll(".md-annot-icon svg.ui-icon").length,
        duplicateSlots: Array.from(document.querySelectorAll(".md-annot-icon")).filter(
          (el) => el.querySelectorAll("svg").length !== 1,
        ).length,
        escapedBold: document.querySelectorAll(".md-body h1 b").length,
        leakedImages: document.querySelectorAll(".md-body img").length,
        bodyText: Array.from(document.querySelectorAll(".md-body"))
          .filter((el) => el.querySelector(".md-annot-row"))
          .map((el) => el.textContent ?? "")
          .join("\n"),
        svgHidden: Array.from(document.querySelectorAll(".md-annot-icon svg")).every(
          (svg) => svg.getAttribute("aria-hidden") === "true" && svg.getAttribute("focusable") === "false",
        ),
      }));
      expect(initial.rows).toBe(3);
      expect(initial.slots).toBe(3);
      expect(initial.icons).toBe(3);
      expect(initial.duplicateSlots).toBe(0);
      expect(initial.escapedBold).toBe(0);
      expect(initial.leakedImages).toBe(0);
      expect(initial.bodyText).toContain("<b>转义</b>");
      expect(initial.svgHidden).toBe(true);

      // A real click on the SVG path must reach the delegated annotation handler.
      await clickAnnotationIcon(page);
      await page.waitForSelector('[data-testid="annotate-modal"]', { timeout: 5000 });
      expect(await page.evaluate(() => document.querySelector('[data-testid="annotate-modal"]')?.textContent ?? "")).toContain(
        "design.md#图标验收设计",
      );
      await closeModal();

      // Keyboard activation keeps working for the generated annotation control.
      await page.evaluate(() => {
        const button = document.querySelector(".md-annot-btn") as HTMLButtonElement | null;
        button?.focus();
      });
      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-testid="annotate-modal"]', { timeout: 5000 });
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector('[data-testid="annotate-modal"]'), { timeout: 5000 });

      // Repeated edits must replace portal targets, not duplicate icons.
      await page.click('[data-testid="start-edit-design-btn"]');
      await page.waitForSelector('[data-testid="design-editor"]', { timeout: 5000 });
      await page.evaluate(() => {
        const textarea = document.querySelector('[data-testid="design-body-input"]') as HTMLTextAreaElement | null;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      });
      await page.type('[data-testid="design-body-input"]', "\n## 新增小节\n\n新增正文。");
      await page.click('[data-testid="save-design-btn"]');
      await page.waitForFunction(() => !document.querySelector('[data-testid="design-editor"]'), { timeout: 5000 });
      await page.waitForFunction(() => document.querySelectorAll(".md-annot-row").length === 4, { timeout: 5000 });

      const afterEdit = await page.evaluate(() => ({
        rows: document.querySelectorAll(".md-annot-row").length,
        slots: document.querySelectorAll('[data-icon-slot="annotate"]').length,
        icons: document.querySelectorAll(".md-annot-icon svg.ui-icon").length,
        duplicateSlots: Array.from(document.querySelectorAll(".md-annot-icon")).filter(
          (el) => el.querySelectorAll("svg").length !== 1,
        ).length,
      }));
      expect(afterEdit).toEqual({ rows: 4, slots: 4, icons: 4, duplicateSlots: 0 });

      await page.evaluate(() => {
        const fourthPath = document.querySelectorAll(".md-annot-btn")[3]?.querySelector("svg path");
        fourthPath?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      await page.waitForSelector('[data-testid="annotate-modal"]', { timeout: 5000 });
      expect(await page.evaluate(() => document.querySelector('[data-testid="annotate-modal"]')?.textContent ?? "")).toContain(
        "design.md#新增小节",
      );
      await closeModal();

      // Unmount/reopen the workspace: portals must be recreated exactly once per slot.
      await page.click('[data-testid="back-home-btn"]');
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 5000 });
      await page.click('[data-testid="req-row-REQ-001"]');
      await page.waitForSelector(".md-annot-row", { timeout: 5000 });
      const afterRemount = await page.evaluate(() => ({
        rows: document.querySelectorAll(".md-annot-row").length,
        icons: document.querySelectorAll(".md-annot-icon svg.ui-icon").length,
        duplicateSlots: Array.from(document.querySelectorAll(".md-annot-icon")).filter(
          (el) => el.querySelectorAll("svg").length !== 1,
        ).length,
      }));
      expect(afterRemount).toEqual({ rows: 4, icons: 4, duplicateSlots: 0 });
      await clickAnnotationIcon(page);
      await page.waitForSelector('[data-testid="annotate-modal"]', { timeout: 5000 });
      await closeModal();

      // Theme × viewport matrix: no horizontal overflow and no icon clipping.
      for (const [width, height] of [
        [1360, 860],
        [390, 844],
      ] as const) {
        await page.setViewport({ width, height });
        for (const theme of ["light", "dark"] as const) {
          const current = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
          if (current !== theme) {
            await page.click('[data-action="toggle-theme"]');
            await page.waitForFunction(
              (next: string) => document.documentElement.getAttribute("data-theme") === next,
              { timeout: 5000 },
              theme,
            );
          }
          await page.evaluate(() => window.scrollTo(0, 0));
          await new Promise((r) => setTimeout(r, 80));
          const layout = await page.evaluate(() => {
            const iconControls = Array.from(document.querySelectorAll("button"))
              .filter((button) => button.querySelector("svg.ui-icon"))
              .map((button) => {
                const el = button as HTMLElement;
                const rect = el.getBoundingClientRect();
                return {
                  label: el.getAttribute("aria-label") || el.textContent?.trim() || "",
                  visible: rect.width > 0 && rect.height > 0,
                  clipped:
                    rect.width > 0 &&
                    (rect.left < -1 || rect.right > window.innerWidth + 1),
                };
              });
            const annotationIcons = Array.from(document.querySelectorAll(".md-annot-icon svg")).map((svg) => {
              const rect = svg.getBoundingClientRect();
              return { width: rect.width, height: rect.height, clippedToButton: rect.width > 0 && rect.height > 0 };
            });
            return {
              overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
              clippedControls: iconControls.filter((control) => control.visible && control.clipped),
              badAnnotationIcons: annotationIcons.filter((icon) => !icon.clippedToButton),
            };
          });
          expect(layout.overflow, `horizontal overflow at ${width}x${height} ${theme}`).toBe(false);
          expect(layout.clippedControls, `clipped icon controls at ${width}x${height} ${theme}`).toEqual([]);
          expect(layout.badAnnotationIcons).toEqual([]);

          await page.screenshot({
            path: path.join(SCREENSHOT_DIR, `req-001-workspace-${width}x${height}-${theme}.png`),
          });
        }
      }

      // Additional opened-state evidence: modal at wide dark, sidebar at narrow light.
      await page.setViewport({ width: 1360, height: 860 });
      if ((await page.evaluate(() => document.documentElement.getAttribute("data-theme"))) !== "dark") {
        await page.click('[data-action="toggle-theme"]');
      }
      await clickAnnotationIcon(page);
      await page.waitForSelector('[data-testid="annotate-modal"]', { timeout: 5000 });
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "req-001-modal-1360x860-dark.png") });
      await closeModal();

      await page.setViewport({ width: 390, height: 844 });
      if ((await page.evaluate(() => document.documentElement.getAttribute("data-theme"))) !== "light") {
        await page.click('[data-action="toggle-theme"]');
      }
      await page.click('[aria-label="项目与算力侧栏"]');
      await page.waitForSelector('[data-testid="hub-sidebar"].open', { timeout: 5000 });
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "req-001-sidebar-390x844-light.png") });

      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
});
