import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HarnessInfo, RoutingConfig } from "../../src/hub/types.ts";
import { createRequirement, initProject } from "../../src/core/engine.ts";
import { HubExecutor } from "../../src/hub/executor.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";
import { resolveTestBrowser } from "./browser_env.ts";
import { selectUiOption } from "./coss_select_helper.ts";

const browserEnv = resolveTestBrowser();
const HAS_BROWSER = browserEnv !== null;

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
  select(sel: string, ...values: string[]): Promise<string[]>;
  evaluate<T>(fn: (...args: any[]) => T, ...args: any[]): Promise<T>;
  keyboard: { press(key: string): Promise<void> };
  on(ev: string, fn: (...args: any[]) => void): void;
  close(): Promise<void>;
}

interface BrowserInstance {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

const FAVORITE_KEY_PREFIX = "wb-model-favorite::";
const tempDirs: string[] = [];
const servers: WorkbenchServerHandle[] = [];
const origHubDir = process.env.WORKBENCH_HUB_DIR;
let browser: BrowserInstance | null = null;

function initGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-fav-e2e-"));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "calc.ts"), "export const add = (a: number, b: number) => a + b;\n");
  execFileSync("git", ["add", "calc.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });
  return dir;
}

async function startScenario(
  harnesses: HarnessInfo[],
  routing?: RoutingConfig,
): Promise<{ page: BrowserPage; server: WorkbenchServerHandle; pageErrors: string[]; harnesses: HarnessInfo[] }> {
  const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-fav-hub-"));
  tempDirs.push(hubDir);
  process.env.WORKBENCH_HUB_DIR = hubDir;

  const repo = initGitRepo();
  await initProject(repo, { name: "FavRepo", privacyMode: "local", ...(routing ? { routing } : {}) });
  await createRequirement(repo, {
    goal: "验证模型收藏偏好",
    criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
  });

  const liveHarnesses = structuredClone(harnesses);
  const executor = new HubExecutor({ initialHarnesses: liveHarnesses });
  const server = await startWorkbenchServer({
    root: repo,
    port: 0,
    writeDiscovery: false,
    hubMode: true,
    executor,
  });
  servers.push(server);

  const page = await browser!.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (err: Error) => pageErrors.push(err.message));
  await page.setViewport({ width: 1360, height: 900 });
  return { page, server, pageErrors, harnesses: liveHarnesses };
}

async function openRequirement(page: BrowserPage, server: WorkbenchServerHandle): Promise<void> {
  await page.goto(server.url, { waitUntil: "networkidle0" });
  await page.waitForSelector('[data-testid="hub-sidebar"]', { timeout: 5000 });
  await clickReady(page, '[data-testid="req-row-REQ-001"]');
  await page.waitForSelector('[data-testid="workspace-detail"]', { timeout: 5000 });
}

async function clickReady(page: BrowserPage, selector: string, timeout = 5000): Promise<void> {
  await page.waitForSelector(`${selector}:not([disabled])`, { timeout });
  await page.click(selector);
}

async function waitAriaPressed(page: BrowserPage, selector: string, pressed: boolean): Promise<void> {
  await page.waitForFunction(
    (sel: string, expected: string) =>
      document.querySelector(sel)?.getAttribute("aria-pressed") === expected,
    { timeout: 5000 },
    selector,
    String(pressed),
  );
}

async function openRunnerPicker(page: BrowserPage): Promise<void> {
  await page.waitForSelector('[data-testid="banner-runner-select-trigger"]', { timeout: 5000 });
  await clickReady(page, '[data-testid="banner-runner-select-trigger"]');
  await page.waitForSelector('[data-testid="banner-runner-select-search"]', { timeout: 5000 });
}

async function openRoutingPicker(page: BrowserPage): Promise<void> {
  await page.waitForSelector('[data-testid="routing-modal"]', { timeout: 5000 });
  await clickReady(page, '[data-testid="route-select-defaultLead-trigger"]');
  await page.waitForSelector('[data-testid="route-select-defaultLead-search"]', { timeout: 5000 });
}

async function openRoutingStagePicker(page: BrowserPage, stage: string): Promise<void> {
  await clickReady(page, `[data-testid="route-select-${stage}-trigger"]`);
  await page.waitForSelector(`[data-testid="route-select-${stage}-search"]`, { timeout: 5000 });
}

async function waitRoutingStagePickerClosed(page: BrowserPage, stage: string): Promise<void> {
  await page.waitForFunction(
    (id: string) => !document.querySelector(`[data-testid="${id}-search"]`),
    { timeout: 5000 },
    `route-select-${stage}`,
  );
}

async function readSelectValue(page: BrowserPage, testId: string): Promise<string> {
  return page.evaluate((id: string) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return "";
    if (el.tagName === "SELECT") return (el as HTMLSelectElement).value ?? "";
    return el.getAttribute("data-value") ?? "";
  }, testId);
}

async function readStoredFavorites(page: BrowserPage): Promise<string[]> {
  return page.evaluate((prefix: string) => {
    const favorites: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) favorites.push(key.slice(prefix.length));
    }
    return favorites.sort();
  }, FAVORITE_KEY_PREFIX);
}

const BASE_HARNESSES: HarnessInfo[] = [
  {
    id: "codex",
    label: "Codex CLI",
    subscription: "ChatGPT Plus",
    installed: true,
    executable: "codex",
    models: [
      { id: "gpt-6-astra", tier: "sota", source: "detected" },
      { id: "gpt-6.1-sol", tier: "sota", source: "detected", provider: "openai" },
      { id: "gpt-6.1-mini", tier: "fast", source: "detected" },
    ],
    defaultModel: "gpt-6-astra",
    detectedAt: Date.now(),
  },
  {
    id: "omp",
    label: "Oh My Pi",
    subscription: "OMP",
    installed: true,
    executable: "omp",
    models: [
      { id: "gpt-6.1-sol", label: "Sol via OMP", tier: "sota", source: "detected" },
      { id: "claude-x", tier: "review", source: "detected" },
    ],
    defaultModel: "gpt-6.1-sol",
    detectedAt: Date.now(),
  },
  {
    id: "opencode",
    label: "OpenCode",
    subscription: "Free",
    installed: false,
    executable: null,
    models: [{ id: "free-model", label: "免费模型", tier: "fast", source: "builtin" }],
    defaultModel: "free-model",
    detectedAt: Date.now(),
  },
];

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
  if (origHubDir === undefined) delete process.env.WORKBENCH_HUB_DIR;
  else process.env.WORKBENCH_HUB_DIR = origHubDir;
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

afterAll(async () => {
  if (browser) {
    await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 2000))]);
  }
}, 15_000);

const suite = HAS_BROWSER ? describe : describe.skip;

suite("REQ-002 模型收藏真实浏览器交互", () => {
  test("工作台与配置弹窗共享收藏、搜索、键盘与持久化，且不改变选择与草稿", async () => {
    const presetDesign = { harness: "opencode" as const, model: "opencode/deepseek-v4.1-flash-free" };
    const { page, server, pageErrors, harnesses: liveHarnesses } = await startScenario(BASE_HARNESSES, {
      defaultLead: { primary: presetDesign, fallbacks: [] },
      sotaLead: { primary: { harness: "codex", model: "gpt-6-astra" }, fallbacks: [] },
      reviewer: { primary: { harness: "codex", model: "gpt-6-astra" }, fallbacks: [] },
      autoReview: false,
      autoHeal: false,
    });
    expect(HAS_BROWSER).toBe(true);

    try {
      await openRequirement(page, server);
      await page.waitForSelector('[data-testid="workspace-detail"]', { timeout: 5000 });

      // 初始状态下没有收藏分组
      await openRunnerPicker(page);
      expect(
        await page.evaluate(() => Boolean(document.querySelector('[data-testid="banner-runner-select-favorites"]'))),
      ).toBe(false);
      const initialRunnerValue = await readSelectValue(page, "banner-runner-select");

      // 收藏不改变当前选择与推理强度，且面板保持打开
      await clickReady(page, '[data-testid="banner-runner-select-fav-codex::gpt-6.1-sol"]');
      await waitAriaPressed(page, '[data-testid="banner-runner-select-fav-codex::gpt-6.1-sol"]', true);
      expect(
        await page.evaluate(() => Boolean(document.querySelector('[data-testid="banner-runner-select-search"]'))),
      ).toBe(true);
      expect(await readSelectValue(page, "banner-runner-select")).toBe(initialRunnerValue);
      expect(await readSelectValue(page, "banner-runner-select-effort")).toBe("");

      const runnerFavorites = await page.evaluate(() => {
        const group = document.querySelector('[data-testid="banner-runner-select-favorites"]');
        const inFavorites = Boolean(
          group?.querySelector('[data-testid="banner-runner-select-option-codex::gpt-6.1-sol"]'),
        );
        const inNormal = Boolean(
          document.querySelector(
            '[data-testid="banner-runner-select-group-codex"] [data-testid="banner-runner-select-option-codex::gpt-6.1-sol"]',
          ),
        );
        return { inFavorites, inNormal };
      });
      expect(runnerFavorites).toEqual({ inFavorites: true, inNormal: false });
      expect(await readStoredFavorites(page)).toContain("codex::gpt-6.1-sol");

      // 键盘操作：聚焦收藏按钮后回车/空格切换收藏且不触发模型选择
      await page.evaluate(() => {
        (document.querySelector('[data-testid="banner-runner-select-fav-omp::gpt-6.1-sol"]') as HTMLElement | null)?.focus();
      });
      await page.keyboard.press("Enter");
      await waitAriaPressed(page, '[data-testid="banner-runner-select-fav-omp::gpt-6.1-sol"]', true);
      expect(await readSelectValue(page, "banner-runner-select")).toBe(initialRunnerValue);
      await page.keyboard.press(" ");
      await waitAriaPressed(page, '[data-testid="banner-runner-select-fav-omp::gpt-6.1-sol"]', false);
      await page.keyboard.press("Enter");
      await waitAriaPressed(page, '[data-testid="banner-runner-select-fav-omp::gpt-6.1-sol"]', true);
      expect(await readSelectValue(page, "banner-runner-select")).toBe(initialRunnerValue);
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="banner-runner-select-search"]'),
        { timeout: 5000 },
      );

      // 配置弹窗共享同一份收藏，并保留未安装 Harness 与列表外当前配置
      await clickReady(page, '[data-testid="open-routing-btn"]');
      await page.waitForSelector('[data-testid="routing-modal"]', { timeout: 5000 });
      const routeDraftBefore = {
        model: await readSelectValue(page, "route-select-defaultLead"),
        effort: await readSelectValue(page, "route-effort-defaultLead"),
      };
      expect(routeDraftBefore.model).toBe(`${presetDesign.harness}::${presetDesign.model}`);

      await openRoutingPicker(page);
      const shared = await page.evaluate(() => ({
        codexFavorited:
          document
            .querySelector('[data-testid="route-select-defaultLead-fav-codex::gpt-6.1-sol"]')
            ?.getAttribute("aria-pressed") === "true",
        ompFavorited:
          document
            .querySelector('[data-testid="route-select-defaultLead-fav-omp::gpt-6.1-sol"]')
            ?.getAttribute("aria-pressed") === "true",
      }));
      expect(shared).toEqual({ codexFavorited: true, ompFavorited: true });
      expect(
        await page.evaluate(() =>
          Boolean(document.querySelector('[data-testid="route-select-defaultLead-group-opencode"]')),
        ),
      ).toBe(true);
      expect(
        await page.evaluate(
          () => document.querySelector('[data-testid="route-select-defaultLead-group-opencode"]')?.textContent ?? "",
        ),
      ).toContain("未安装");
      expect(
        await page.evaluate(
          (key: string) =>
            document.querySelector(`[data-testid="route-select-defaultLead-option-${key}"]`)?.textContent ?? "",
          `${presetDesign.harness}::${presetDesign.model}`,
        ),
      ).toContain("保留");

      // 搜索只匹配收藏/普通模型，取消收藏后选择与草稿保持不变
      await page.type('[data-testid="route-select-defaultLead-search"]', "claude-x");
      await page.waitForFunction(
        () =>
          Boolean(document.querySelector('[data-testid="route-select-defaultLead-option-omp::claude-x"]')) &&
          !document.querySelector('[data-testid="route-select-defaultLead-favorites"]'),
        { timeout: 5000 },
      );
      for (let i = 0; i < "claude-x".length; i += 1) await page.keyboard.press("Backspace");
      await page.waitForFunction(
        () => Boolean(document.querySelector('[data-testid="route-select-defaultLead-favorites"]')),
        { timeout: 5000 },
      );

      await clickReady(page, '[data-testid="route-select-defaultLead-fav-codex::gpt-6.1-sol"]');
      await waitAriaPressed(page, '[data-testid="route-select-defaultLead-fav-codex::gpt-6.1-sol"]', false);
      const routeDraftAfter = {
        model: await readSelectValue(page, "route-select-defaultLead"),
        effort: await readSelectValue(page, "route-effort-defaultLead"),
      };
      expect(routeDraftAfter).toEqual(routeDraftBefore);
      expect(await readStoredFavorites(page)).not.toContain("codex::gpt-6.1-sol");

      // 收藏配置弹窗中的未安装模型：工作台入口隐藏但记录保留
      await clickReady(page, '[data-testid="route-select-defaultLead-fav-opencode::free-model"]');
      await waitAriaPressed(page, '[data-testid="route-select-defaultLead-fav-opencode::free-model"]', true);
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="route-select-defaultLead-search"]'),
        { timeout: 5000 },
      );
      await clickReady(page, '[data-testid="routing-modal"] button:not([data-testid])');
      await page.waitForFunction(() => !document.querySelector('[data-testid="routing-modal"]'), { timeout: 5000 });

      await openRunnerPicker(page);
      const hiddenFavorite = await page.evaluate(() => ({
        groupExists: Boolean(document.querySelector('[data-testid="banner-runner-select-favorites"]')),
        opencodeShown: Boolean(
          document.querySelector('[data-testid="banner-runner-select-fav-opencode::free-model"]'),
        ),
      }));
      expect(hiddenFavorite.opencodeShown).toBe(false);
      expect(await readStoredFavorites(page)).toContain("opencode::free-model");
      expect(
        await page.evaluate(() =>
          Boolean(
            document.querySelector(
              '[data-testid="banner-runner-select-favorites"] [data-testid="banner-runner-select-option-omp::gpt-6.1-sol"]',
            ),
          ),
        ),
      ).toBe(true);
      await page.keyboard.press("Escape");

      // 刷新后收藏仍存在
      await openRequirement(page, server);
      await openRunnerPicker(page);
      await waitAriaPressed(page, '[data-testid="banner-runner-select-fav-omp::gpt-6.1-sol"]', true);

      // 跨标签页并发：两页均加载后同时收藏不同模型，双方与刷新后状态一致
      const pageB = await browser!.newPage();
      try {
        await pageB.setViewport({ width: 1360, height: 900 });
        await openRequirement(pageB, server);
        await openRunnerPicker(pageB);

        await Promise.all([
          page.evaluate(() => {
            (document.querySelector('[data-testid="banner-runner-select-fav-codex::gpt-6.1-sol"]') as HTMLButtonElement | null)?.click();
          }),
          pageB.evaluate(() => {
            (document.querySelector('[data-testid="banner-runner-select-fav-omp::claude-x"]') as HTMLButtonElement | null)?.click();
          }),
        ]);

        for (const target of [page, pageB]) {
          await waitAriaPressed(target, '[data-testid="banner-runner-select-fav-codex::gpt-6.1-sol"]', true);
          await waitAriaPressed(target, '[data-testid="banner-runner-select-fav-omp::claude-x"]', true);
        }
        expect(await readStoredFavorites(page)).toEqual(
          expect.arrayContaining([
            "codex::gpt-6.1-sol",
            "omp::gpt-6.1-sol",
            "omp::claude-x",
            "opencode::free-model",
          ]),
        );
      } finally {
        await pageB.close();
      }

      await openRequirement(page, server);
      await openRunnerPicker(page);
      await waitAriaPressed(page, '[data-testid="banner-runner-select-fav-codex::gpt-6.1-sol"]', true);
      await waitAriaPressed(page, '[data-testid="banner-runner-select-fav-omp::claude-x"]', true);
      await page.keyboard.press("Escape");

      // 恢复此前被隐藏的收藏项可用性后，在同一工作台入口重新出现在收藏分组中
      liveHarnesses[2]!.installed = true;
      liveHarnesses[2]!.executable = "opencode";
      await openRequirement(page, server);
      await openRunnerPicker(page);
      await page.waitForSelector(
        '[data-testid="banner-runner-select-favorites"] [data-testid="banner-runner-select-option-opencode::free-model"]',
        { timeout: 5000 },
      );
      await waitAriaPressed(page, '[data-testid="banner-runner-select-fav-opencode::free-model"]', true);
      await page.keyboard.press("Escape");

      // 切换英文界面时收藏分组标题与收藏按钮无障碍文本同步本地化
      await selectUiOption(page, '[data-testid="ui-language-select"]', "en");
      await page.waitForFunction(() => document.documentElement.lang === "en", { timeout: 5000 });
      await openRunnerPicker(page);
      const enPickerText = await page.evaluate(() => ({
        heading: document.querySelector('[data-testid="banner-runner-select-favorites"]')?.textContent ?? "",
        favLabel:
          document.querySelector('[data-testid="banner-runner-select-fav-codex::gpt-6.1-sol"]')?.getAttribute("aria-label") ?? "",
      }));
      expect(enPickerText.heading).toContain("Favorites");
      expect(enPickerText.favLabel).toContain("Unfavorite");
      await page.keyboard.press("Escape");

      // 工作台模型选择器选中模型并设置推理强度后，重复点选同一模型保留已选推理强度
      await openRunnerPicker(page);
      await clickReady(page, '[data-testid="banner-runner-select-option-codex::gpt-6.1-sol"]');
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="banner-runner-select-search"]'),
        { timeout: 5000 },
      );
      expect(await readSelectValue(page, "banner-runner-select")).toBe("codex::gpt-6.1-sol");
      await page.waitForSelector('[data-testid="banner-runner-select-effort"]', { timeout: 5000 });
      await selectUiOption(page, '[data-testid="banner-runner-select-effort"]', "medium");
      expect(await readSelectValue(page, "banner-runner-select-effort")).toBe("medium");

      await openRunnerPicker(page);
      await clickReady(page, '[data-testid="banner-runner-select-option-codex::gpt-6.1-sol"]');
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="banner-runner-select-search"]'),
        { timeout: 5000 },
      );
      expect(await readSelectValue(page, "banner-runner-select")).toBe("codex::gpt-6.1-sol");
      expect(await readSelectValue(page, "banner-runner-select-effort")).toBe("medium");

      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 90_000);

  test("配置弹窗可见菜单：未安装模型可选、推理强度保留/清除、同键点选不改草稿", async () => {
    const { page, server, pageErrors } = await startScenario(
      [
        {
          id: "codex",
          label: "Codex CLI",
          subscription: "ChatGPT Plus",
          installed: true,
          executable: "codex",
          models: [
            { id: "gpt-6.1-sol", tier: "sota", source: "detected", supportedEfforts: ["low", "medium", "high"] },
            {
              id: "gpt-6-astra",
              tier: "sota",
              source: "detected",
              supportedEfforts: ["low", "medium", "high", "xhigh"],
            },
          ],
          defaultModel: "gpt-6.1-sol",
          detectedAt: Date.now(),
        },
        {
          id: "omp",
          label: "Oh My Pi",
          subscription: "OMP",
          installed: true,
          executable: "omp",
          models: [{ id: "gpt-6.1-sol", label: "Sol via OMP", tier: "sota", source: "detected" }],
          defaultModel: "gpt-6.1-sol",
          detectedAt: Date.now(),
        },
        {
          id: "opencode",
          label: "OpenCode",
          subscription: "Free",
          installed: false,
          executable: null,
          models: [{ id: "free-model", label: "免费模型", tier: "fast", source: "builtin" }],
          defaultModel: "free-model",
          detectedAt: Date.now(),
        },
      ],
      {
        defaultLead: {
          primary: {
            harness: "codex",
            model: "gpt-6.1-sol",
            reasoningEffort: "xhigh",
          },
          fallbacks: [],
        },
        sotaLead: {
          primary: {
            harness: "codex",
            model: "gpt-6-astra",
            reasoningEffort: "xhigh",
          },
          fallbacks: [],
        },
        reviewer: {
          primary: {
            harness: "codex",
            model: "gpt-6-astra",
          },
          fallbacks: [],
        },
        autoReview: false,
        autoHeal: false,
      },
    );

    try {
      await openRequirement(page, server);
      await clickReady(page, '[data-testid="open-routing-btn"]');
      await page.waitForSelector('[data-testid="routing-modal"]', { timeout: 5000 });

      expect(await readSelectValue(page, "route-select-defaultLead")).toBe("codex::gpt-6.1-sol");
      expect(await readSelectValue(page, "route-select-sotaLead")).toBe("codex::gpt-6-astra");

      // 同键点选当前模型：仅关闭面板，不触发变更
      await openRoutingStagePicker(page, "defaultLead");
      await clickReady(page, '[data-testid="route-select-defaultLead-option-codex::gpt-6.1-sol"]');
      await waitRoutingStagePickerClosed(page, "defaultLead");
      expect(await readSelectValue(page, "route-select-defaultLead")).toBe("codex::gpt-6.1-sol");

      // 可见菜单选择未安装 Harness 模型；目标不支持 xhigh，强度被清除；保存并重开确认未安装模型已持久化
      await openRoutingStagePicker(page, "sotaLead");
      await clickReady(page, '[data-testid="route-select-sotaLead-option-opencode::free-model"]');
      await waitRoutingStagePickerClosed(page, "sotaLead");
      expect(await readSelectValue(page, "route-select-sotaLead")).toBe("opencode::free-model");
      expect(await readSelectValue(page, "route-effort-sotaLead")).toBe("");

      await clickReady(page, '[data-testid="save-routing-btn"]');
      await page.waitForFunction(() => !document.querySelector('[data-testid="routing-modal"]'), { timeout: 5000 });
      await clickReady(page, '[data-testid="open-routing-btn"]');
      await page.waitForSelector('[data-testid="routing-modal"]', { timeout: 5000 });
      expect(await readSelectValue(page, "route-select-sotaLead")).toBe("opencode::free-model");
      expect(await readSelectValue(page, "route-effort-sotaLead")).toBe("");

      // 设置兼容强度后切换到同样支持 high 的模型：强度保留
      await selectUiOption(page, '[data-testid="route-effort-sotaLead"]', "high");
      await openRoutingStagePicker(page, "sotaLead");
      await clickReady(page, '[data-testid="route-select-sotaLead-option-omp::gpt-6.1-sol"]');
      await waitRoutingStagePickerClosed(page, "sotaLead");
      expect(await readSelectValue(page, "route-select-sotaLead")).toBe("omp::gpt-6.1-sol");
      expect(await readSelectValue(page, "route-effort-sotaLead")).toBe("high");

      // 保存后确认同键点选未清除 defaultLead 既有的 xhigh
      await clickReady(page, '[data-testid="save-routing-btn"]');
      await page.waitForFunction(() => !document.querySelector('[data-testid="routing-modal"]'), { timeout: 5000 });

      // 重新打开确认可见菜单选择与强度均已持久化
      await clickReady(page, '[data-testid="open-routing-btn"]');
      await page.waitForSelector('[data-testid="routing-modal"]', { timeout: 5000 });
      expect(await readSelectValue(page, "route-select-defaultLead")).toBe("codex::gpt-6.1-sol");
      expect(await readSelectValue(page, "route-select-sotaLead")).toBe("omp::gpt-6.1-sol");
      expect(await readSelectValue(page, "route-effort-sotaLead")).toBe("high");

      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 90_000);
});