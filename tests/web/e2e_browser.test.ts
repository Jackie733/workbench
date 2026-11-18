import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequirement, getRequirement, initProject, propose } from "../../src/core/engine.ts";
import { HubExecutor } from "../../src/hub/executor.ts";
import { applyHubRoutingPreset, readHubConfig } from "../../src/hub/registry.ts";
import { executeWorkbenchTool } from "../../src/mcp/tools.ts";
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
  select(sel: string, ...values: string[]): Promise<string[]>;
  type(sel: string, text: string): Promise<void>;
  evaluate<T>(fn: (...args: any[]) => T, ...args: any[]): Promise<T>;
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

interface BrowserInstance {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

const tempDirs: string[] = [];
const servers: WorkbenchServerHandle[] = [];
const origHubDir = process.env.WORKBENCH_HUB_DIR;
let browser: BrowserInstance | null = null;

function initGitRepo(): string {
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

async function clickReady(page: BrowserPage, selector: string, timeout = 5000): Promise<void> {
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

suite("WB-05 & WB-06 real Chromium E2E flows", () => {
  test("WB-05: project init, zero-noise home list/board, search, theme, narrow width, and scroll restoration", async () => {
    const root = initGitRepo();
    const server = await startWorkbenchServer({ root, port: 0, writeDiscovery: false });
    servers.push(server);

    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));

    try {
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(server.url, { waitUntil: "networkidle0" });

      // 1. Initialize project in browser
      await page.waitForSelector('[data-testid="init-card"]', { timeout: 5000 });
      await page.click('[data-testid="init-submit-btn"]');
      await page.waitForSelector('[data-testid="new-req-btn"]', { timeout: 5000 });

      // 2. Create requirements via UI modal (1..3) and seed 4..22 for scroll restoration
      for (let i = 1; i <= 3; i++) {
        await clickReady(page, '[data-testid="new-req-btn"]');
        await page.waitForSelector('[data-testid="new-req-goal"]', { timeout: 5000 });
        await page.type('[data-testid="new-req-goal"]', `需求条目 ${i}：测试 UI 创建`);
        await clickReady(page, '[data-testid="save-draft-btn"]');
        await clickReady(page, '[data-testid="back-home-btn"]');
        await page.waitForSelector('[data-testid="req-list"]', { timeout: 5000 });
      }
      for (let i = 4; i <= 22; i++) {
        await page.evaluate(async (idx: number, alpha: boolean) => {
          await fetch("/api/requirements", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ goal: `需求条目 ${idx}：测试列表滚动与搜索 ${alpha ? "特殊关键字Alpha" : ""}` }),
          });
        }, i, i === 5);
      }
      await page.waitForFunction(() => document.querySelectorAll(".req-row").length === 22, { timeout: 5000 });

      // Verify zero UUID/SHA/disclaimer noise on home screen
      const homeText = await page.evaluate(() => document.body.innerText);
      expect(homeText).not.toMatch(/[0-9a-f]{32,}/i);
      expect(homeText).not.toContain("revision");
      expect(homeText).not.toContain("sha256");

      const subText = await page.evaluate(
        () => document.querySelector('[data-testid="req-row-REQ-001"] .req-sub')?.textContent?.trim() ?? "",
      );
      expect(subText).toBe("草稿"); // 仅徽章一次，无重复进度文本

      // Search filters to REQ-005, then empty-search shows clear-search recovery
      await page.type('[data-testid="search-input"]', "Alpha");
      const filteredRows = await page.evaluate(() => document.querySelectorAll(".req-row").length);
      expect(filteredRows).toBe(1);
      await page.type('[data-testid="search-input"]', "NoMatchZZZ");
      await page.waitForSelector('[data-action="clear-search"]', { timeout: 5000 });
      await page.click('[data-action="clear-search"]');
      const allRows = await page.evaluate(() => document.querySelectorAll(".req-row").length);
      expect(allRows).toBe(22);

      // Scroll down to REQ-005, open it, return home -> scroll position preserved!
      await page.evaluate(() => {
        document.querySelector('[data-testid="req-row-REQ-005"]')?.scrollIntoView({ block: "center" });
      });
      const scrolledY = await page.evaluate(() => window.scrollY);
      expect(scrolledY).toBeGreaterThan(200);
      await clickReady(page, '[data-testid="req-row-REQ-005"]');
      await page.waitForSelector('[data-testid="ws-stage-badge"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="back-home-btn"]');
      await page.waitForSelector('[data-testid="req-list"]');
      await new Promise((r) => setTimeout(r, 80));
      const restoredY = await page.evaluate(() => window.scrollY);
      expect(Math.abs(restoredY - scrolledY)).toBeLessThan(20);

      // Switch to 4-column board view
      await page.click('[data-action="set-layout"][data-value="board"]');
      await page.waitForSelector('[data-testid="req-board"]');
      const colTitles = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".board-col-head span:first-child")).map((el) => el.textContent),
      );
      expect(colTitles).toEqual(["准备中", "执行中", "待验收", "已完成"]);

      // Toggle dark theme and verify 375px narrow width has no horizontal page overflow
      await page.click('[data-action="toggle-theme"]');
      const themeAttr = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
      expect(themeAttr).toBe("dark");
      await page.setViewport({ width: 375, height: 720 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(overflow).toBe(false);

      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("WB-06: completes Plan-First and Fast-Track end-to-end loops with real Agent tools, Git diff, stale gate, and acceptance", async () => {
    const root = initGitRepo();
    const server = await startWorkbenchServer({ root, port: 0, writeDiscovery: false });
    servers.push(server);

    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));

    try {
      await page.setViewport({ width: 1280, height: 860 });
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await page.click('[data-testid="init-submit-btn"]');
      await page.waitForSelector('[data-testid="new-req-btn"]');

      // --- LOOP 1: Plan-First ---
      await page.click('[data-testid="new-req-btn"]');
      await page.waitForSelector('[data-testid="new-req-goal"]');
      await page.type('[data-testid="new-req-goal"]', "为 calc.ts 增加减法函数并验证");
      await page.click('[data-testid="save-draft-btn"]');
      await page.waitForSelector('[data-testid="ws-stage-badge"]');

      // Agent submits design v1, then v2 with required criterion
      await executeWorkbenchTool(root, "wb_propose", {
        id: "REQ-001",
        design: "# 方案 v1\n初步实现 sub。",
        criteria: [{ id: "AC-1", description: "calc 导出 sub 并通过校验", required: true, command: "bun -e 'import { sub } from \"./calc.ts\"; if (sub(5,2)!==3) process.exit(1)'" }],
      });
      await executeWorkbenchTool(root, "wb_propose", {
        id: "REQ-001",
        design: "# 方案 v2\n导出 `sub(a, b)` 并补充边界测试。",
      });

      // Wait for WS live push to update Action Banner to approve_and_implement
      await page.waitForSelector('[data-testid="action-approve_and_implement"]', { timeout: 5000 });

      // Verify design version diff toggle works
      // 初始化/创建提示会在右下角短暂堆叠，等其自动消失后再点击底部按钮，避免被提示遮挡。
      await page.waitForFunction(() => !document.querySelector("[data-sonner-toast]"), { timeout: 6000 });
      await page.click('[data-action="toggle-design-diff"]');
      await page.waitForSelector(".diff-code", { timeout: 5000 });
      const diffHtml = await page.evaluate(() => document.querySelector(".diff-code")?.textContent ?? "");
      expect(diffHtml).toContain("初步实现");
      expect(diffHtml).toContain("导出");
      await page.click('[data-action="toggle-design-diff"]');

      // Approve & implement (offline fallback modal appears, close it)
      await clickReady(page, '[data-testid="action-approve_and_implement"]');
      await page.waitForSelector('[data-testid="prompt-fallback-modal"]', { timeout: 5000 });
      await clickReady(page, '[data-action="close-modal"]');

      // Agent implements code, runs verification, and marks tasks ready
      fs.writeFileSync(
        path.join(root, "calc.ts"),
        "export const add = (a: number, b: number) => a + b;\nexport const sub = (a: number, b: number) => a - b;\n",
      );
      await executeWorkbenchTool(root, "wb_verify", {
        id: "REQ-001",
        command: "bun -e 'import { sub } from \"./calc.ts\"; if (sub(5,2)!==3) process.exit(1)'",
        criterionIds: ["AC-1"],
      });
      await executeWorkbenchTool(root, "wb_update_tasks", {
        id: "REQ-001",
        tasks: [{ title: "实现 sub 并验证", status: "done" }],
        readyForAcceptance: true,
      });

      await page.waitForSelector('[data-testid="action-accept"]', { timeout: 5000 });

      // Inspect Changes & Verification tab + Diff + Log
      await page.click('[data-testid="tab-changes"]');
      await page.waitForSelector(".diff-code", { timeout: 5000 });
      const gitDiffText = await page.evaluate(() => document.querySelector(".diff-code")?.textContent ?? "");
      expect(gitDiffText).toContain("export const sub");
      await page.click('[data-action="toggle-log"]');
      await page.waitForSelector(".evidence-log", { timeout: 5000 });

      // Edit code behind the scenes -> live stale detection disables immediate acceptance!
      fs.appendFileSync(path.join(root, "calc.ts"), "// post-verify edit\n");
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await page.waitForFunction(
        () =>
          !document.querySelector('[data-testid="action-accept"]') &&
          Boolean(document.querySelector('[data-testid="action-run_all_verifications"]')),
        { timeout: 5000 },
      );

      // Re-run verification right from the browser UI, then accept!
      await clickReady(page, '[data-testid="action-run_all_verifications"]');
      await clickReady(page, '[data-testid="action-accept"]');
      await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="ws-stage-badge"]')?.textContent?.includes("已完成")), { timeout: 5000 });

      // Timeline tab shows full human history
      await page.click('[data-testid="tab-timeline"]');
      await page.waitForSelector(".timeline-item", { timeout: 5000 });
      const timelineText = await page.evaluate(() => document.body.innerText);
      expect(timelineText).toContain("人工验收通过");

      // --- LOOP 2: Fast-Track & Zero-Criteria Gate ---
      await page.click('[data-testid="back-home-btn"]');
      await page.waitForSelector('[data-testid="new-req-btn"]', { timeout: 5000 });
      await page.click('[data-testid="new-req-btn"]');
      await page.waitForSelector('[data-testid="new-req-goal"]', { timeout: 5000 });
      await page.type('[data-testid="new-req-goal"]', "快速通道直接修复常量");
      await page.click('[data-testid="save-draft-btn"]');
      await page.waitForSelector('[data-testid="action-authorize_fast_track"]', { timeout: 5000 });

      // Authorize fast-track with zero criteria -> verify cannot accept (0/0 blocked!)
      await page.click('[data-testid="action-authorize_fast_track"]');
      await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="ws-stage-badge"]')?.textContent?.includes("实施中")), { timeout: 5000 });
      expect(await page.evaluate(() => Boolean(document.querySelector('[data-testid="action-accept"]')))).toBe(false);
      const gateResp = await page.evaluate(async () => {
        const r = await fetch("/api/requirements/REQ-002/accept", { method: "POST", body: "{}" });
        return r.status;
      });
      expect(gateResp).toBe(409);

      // Edit spec inline in browser to add required criterion, re-authorize fast-track, run verification, accept!
      await clickReady(page, '[data-action="start-edit-spec"]');
      await page.waitForSelector('[data-testid="spec-editor"]', { timeout: 5000 });
      await clickReady(page, '[data-action="add-criterion"]');
      await page.type('[data-criterion-idx="0"] [data-crit-field="description"]', "快速通道脚本通过");
      await page.type('[data-criterion-idx="0"] [data-crit-field="command"]', "echo fast-ok");
      await clickReady(page, '[data-testid="save-spec-btn"]');
      await page.waitForFunction(() => !document.querySelector('[data-testid="spec-editor"]'), { timeout: 5000 });
      await clickReady(page, '[data-testid="action-authorize_fast_track"]');
      await clickReady(page, '[data-testid="action-run_all_verifications"]');
      await clickReady(page, '[data-testid="action-accept"]');
      await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="ws-stage-badge"]')?.textContent?.includes("已完成")), { timeout: 5000 });

      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("WB-11 & WB-12: three-column Hub UI, multi-project switching, routing center, co-design Ask/Refine, and live console review", async () => {
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-e2e-hub-"));
    tempDirs.push(hubDir);
    process.env.WORKBENCH_HUB_DIR = hubDir;

    const repoA = initGitRepo();
    const repoB = initGitRepo();
    await initProject(repoA, { name: "Project-Alpha", privacyMode: "local" });
    await createRequirement(repoA, {
      goal: "Alpha Core Goal",
      criteria: [{ id: "AC-1", description: "passes quick echo", required: true, command: "echo ok" }],
    });
    await propose(repoA, "REQ-001", {
      designMarkdown: "# Architecture\nUse atomic file locks for safety.",
      actor: "agent",
    });

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
            { id: "codex-auto-review", tier: "review", source: "detected" },
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
          models: [{ id: "Qwen4-Max", tier: "sota", source: "detected" }],
          defaultModel: "Qwen4-Max",
          detectedAt: Date.now(),
        },
        {
          id: "opencode",
          label: "OpenCode",
          subscription: "OpenCode Go",
          installed: true,
          executable: "opencode",
          models: [{ id: "opencode/deepseek-v4.1-flash-free", tier: "fast", source: "detected" }],
          defaultModel: "opencode/deepseek-v4.1-flash-free",
          detectedAt: Date.now(),
        },
      ],
      commandBuilder: (_target, ctx) => {
        if (ctx.action === "ask") {
          return { command: "bash", args: ["-c", "echo '使用文件锁可以避免多进程并发写冲突。'"], displayCommand: "ask-mock" };
        }
        if (ctx.action === "review") {
          return {
            command: "bash",
            args: [
              "-c",
              `cat <<'EOF'\n审查完成，未发现缺陷。\n\`\`\`json\n{"verdict":"pass","summary":"跨模型审查通过"}\n\`\`\`\nEOF`,
            ],
            displayCommand: "review-mock",
          };
        }
        return { command: "bash", args: ["-c", "echo 'model run finished ok'"], displayCommand: "exec-mock" };
      },
    });

    const server = await startWorkbenchServer({ root: repoA, port: 0, writeDiscovery: false, hubMode: true, executor });
    servers.push(server);

    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));

    try {
      await page.setViewport({ width: 1360, height: 860 });
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="hub-sidebar"]', { timeout: 5000 });

      // 1. Add second project via Directory Browser Modal and verify project isolation
      await clickReady(page, '[data-testid="add-project-btn"]');
      await page.waitForSelector('[data-testid="add-project-modal"]', { timeout: 5000 });
      await page.evaluate((p: string) => {
        const input = document.getElementById("add-project-path") as HTMLInputElement;
        input.value = p;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, repoB);
      await clickReady(page, '[data-testid="browse-go-btn"]');
      await clickReady(page, '[data-testid="submit-add-project-btn"]');
      await page.waitForFunction(() => document.querySelectorAll('[data-action="switch-project"]').length === 2, { timeout: 5000 });

      // Switch back to Project-Alpha and verify REQ-001 appears
      const alphaId = await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll('[data-action="switch-project"]')).find((x) =>
          x.textContent?.includes("Project-Alpha"),
        );
        return el?.getAttribute("data-id") ?? "";
      });
      await clickReady(page, `[data-testid="hub-project-${alphaId}"]`);
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 5000 });

      // 2. Routing Center: switch preset + set effort + save
      await clickReady(page, '[data-testid="open-routing-btn"]');
      await page.waitForSelector('[data-testid="routing-modal"]', { timeout: 5000 });
      expect(await page.evaluate(() => Boolean(document.querySelector('[data-testid="custom-model-input"]')))).toBe(false);
      await page.select('[data-testid="hub-output-language-select"]', "en");
      await clickReady(page, '[data-testid="settings-tab-project"]');
      await page.waitForSelector('[data-testid="project-github-repo-input"]', { timeout: 5000 });
      const inheritLabel = await page.evaluate(
        () =>
          document.querySelector('[data-testid="project-output-language-select"] option[value="inherit"]')?.textContent ?? "",
      );
      expect(inheritLabel).toContain("当前：zh-CN"); // 已持久化的全局语言，而非未保存草稿
      await clickReady(page, '[data-testid="settings-tab-global"]');
      await page.waitForSelector('[data-testid="routing-presets"]', { timeout: 5000 });
      await page.select('[data-testid="hub-output-language-select"]', "zh-CN");
      await clickReady(page, '[data-testid="preset-quota_saver"]');
      await page.select('[data-testid="route-effort-design"]', "xhigh");
      await clickReady(page, '[data-testid="save-routing-btn"]');
      await page.waitForFunction(() => !document.querySelector('[data-testid="routing-modal"]'), { timeout: 5000 });

      // Reopen immediately and verify saved preset/effort persisted, then customize model+effort, save, reopen & reload
      await clickReady(page, '[data-testid="open-routing-btn"]');
      await page.waitForSelector('[data-testid="routing-modal"]', { timeout: 5000 });
      const firstReopen = await page.evaluate(() => ({
        designModel: (document.querySelector('[data-testid="route-select-design"]') as HTMLSelectElement)?.value,
        designEffort: (document.querySelector('[data-testid="route-effort-design"]') as HTMLSelectElement)?.value,
      }));
      expect(firstReopen).toEqual({ designModel: "qodercn::Qwen4-Max", designEffort: "xhigh" });

      await page.select('[data-testid="route-select-design"]', "codex::gpt-6-astra");
      await page.select('[data-testid="route-effort-design"]', "high");
      await page.select('[data-testid="route-select-implement"]', "opencode::opencode/deepseek-v4.1-flash-free");
      await page.select('[data-testid="route-effort-implement"]', "medium");
      await clickReady(page, '[data-testid="save-routing-btn"]');
      await page.waitForFunction(() => !document.querySelector('[data-testid="routing-modal"]'), { timeout: 5000 });

      await clickReady(page, '[data-testid="open-routing-btn"]');
      await page.waitForSelector('[data-testid="routing-modal"]', { timeout: 5000 });
      const secondReopen = await page.evaluate(() => ({
        designModel: (document.querySelector('[data-testid="route-select-design"]') as HTMLSelectElement)?.value,
        designEffort: (document.querySelector('[data-testid="route-effort-design"]') as HTMLSelectElement)?.value,
        implementModel: (document.querySelector('[data-testid="route-select-implement"]') as HTMLSelectElement)?.value,
        implementEffort: (document.querySelector('[data-testid="route-effort-implement"]') as HTMLSelectElement)?.value,
      }));
      expect(secondReopen).toEqual({
        designModel: "codex::gpt-6-astra",
        designEffort: "high",
        implementModel: "opencode::opencode/deepseek-v4.1-flash-free",
        implementEffort: "medium",
      });

      await page.goto(server.url, { waitUntil: "networkidle0" });
      await clickReady(page, `[data-testid="hub-project-${alphaId}"]`);
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="open-routing-btn"]');
      await page.waitForSelector('[data-testid="routing-modal"]', { timeout: 5000 });
      const afterReload = await page.evaluate(() => ({
        designModel: (document.querySelector('[data-testid="route-select-design"]') as HTMLSelectElement)?.value,
        designEffort: (document.querySelector('[data-testid="route-effort-design"]') as HTMLSelectElement)?.value,
        implementModel: (document.querySelector('[data-testid="route-select-implement"]') as HTMLSelectElement)?.value,
        implementEffort: (document.querySelector('[data-testid="route-effort-implement"]') as HTMLSelectElement)?.value,
      }));
      expect(afterReload).toEqual(secondReopen);
      await clickReady(page, '[data-testid="routing-modal"] button:not([data-testid])');
      await page.waitForFunction(() => !document.querySelector('[data-testid="routing-modal"]'), { timeout: 5000 });

      // 3. Open REQ-001: test section annotation + Ask mode (read-only Q&A) + direct design editing
      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="stage-stepper"]', { timeout: 5000 });

      await clickReady(page, '[data-action="annotate-anchor"]');
      await page.waitForSelector('[data-testid="annotate-modal"]', { timeout: 5000 });
      await page.type('[data-testid="annotate-msg"]', "为什么这里要用文件锁？");
      await clickReady(page, '[data-testid="annotate-ask-btn"]');

      // Right drawer opens automatically and streams agent reply into discuss-thread without leaving awaiting_approval
      await page.waitForFunction(
        () =>
          Boolean(document.querySelector('[data-testid="discuss-thread"]')?.textContent?.includes("多进程并发写冲突")) &&
          !document.querySelector('[data-testid="discuss-stream-card"]'),
        { timeout: 5000 },
      );
      const stageAfterAsk = await page.evaluate(() => document.querySelector('[data-testid="ws-stage-badge"]')?.textContent ?? "");
      expect(stageAfterAsk).toContain("待批准");

      // Direct human design.md editing
      await clickReady(page, '[data-testid="start-edit-design-btn"]');
      await page.waitForSelector('[data-testid="design-body-input"]', { timeout: 5000 });
      await page.type('[data-testid="design-body-input"]', "\n补充人工微调条目。");
      await clickReady(page, '[data-testid="save-design-btn"]');
      await page.waitForFunction(() => !document.querySelector('[data-testid="design-editor"]'), { timeout: 5000 });

      // Approve only -> trigger live model execution + effort selection + cross-model review
      await clickReady(page, '[data-testid="action-approve_only"]');
      await page.waitForSelector('[data-testid="run-review-btn"]', { timeout: 5000 });
      await page.waitForSelector('[data-testid="banner-runner-select-trigger"]', { timeout: 5000 });
      await page.select('[data-testid="banner-runner-select-effort"]', "high");
      await clickReady(page, '[data-testid="run-selected-model-btn"]');
      await page.waitForFunction(
        () =>
          Boolean(document.querySelector('[data-testid="console-log-output"]')?.textContent?.includes("model run finished ok")) &&
          !document.querySelector('[data-testid="live-agent-banner"]'),
        { timeout: 5000 },
      );

      await clickReady(page, '[data-testid="run-review-btn"]');
      await page.waitForFunction(
        () => Boolean(document.querySelector('[data-testid="review-report-card"]')?.textContent?.includes("跨模型审查通过")),
        { timeout: 5000 },
      );

      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("Self-Evolving & RSI: quick report modal, evolution center tabs, playbook editor, and sandbox promotion", async () => {
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-e2e-evo-hub-"));
    tempDirs.push(hubDir);
    process.env.WORKBENCH_HUB_DIR = hubDir;

    const wbRepo = initGitRepo();
    fs.writeFileSync(path.join(wbRepo, "package.json"), JSON.stringify({ name: "workbench", version: "5.0.0" }, null, 2));
    execFileSync("git", ["add", "package.json"], { cwd: wbRepo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "add package.json"], { cwd: wbRepo, stdio: "ignore" });
    await initProject(wbRepo, { name: "workbench", privacyMode: "local" });

    const server = await startWorkbenchServer({ root: wbRepo, port: 0, writeDiscovery: false, hubMode: true });
    servers.push(server);

    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));

    try {
      await page.setViewport({ width: 1360, height: 860 });
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="open-quick-report-btn"]', { timeout: 5000 });

      // 1. Open quick report from Topbar, test interactive DOM element picker, and submit an issue
      await clickReady(page, '[data-testid="open-quick-report-btn"]');
      await page.waitForSelector('[data-testid="quick-report-modal"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="pick-element-btn"]');
      await page.waitForSelector('[data-testid="pick-element-banner"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="new-req-btn"]');
      await page.waitForSelector('[data-testid="quick-report-modal"]', { timeout: 5000 });
      const pickedSel = await page.evaluate(
        () => (document.querySelector('[data-testid="quick-report-selector"]') as HTMLInputElement)?.value ?? "",
      );
      expect(pickedSel).toBe('[data-testid="new-req-btn"]');
      await page.type('[data-testid="quick-report-title"]', "窄屏下工具栏按钮间距略紧");
      await page.type('[data-testid="quick-report-detail"]', "在 390px 宽度下建议增加 gap");
      await clickReady(page, '[data-testid="submit-quick-report-btn"]');
      await page.waitForFunction(() => !document.querySelector('[data-testid="quick-report-modal"]'), { timeout: 5000 });

      // 2. Open Evolution Center from HubSidebar -> verify Inbox, Playbook, Telemetry tabs
      await clickReady(page, '[data-testid="open-evolution-btn"]');
      await page.waitForSelector('[data-testid="evolution-modal"]', { timeout: 5000 });
      await page.waitForFunction(
        () => Boolean(document.querySelector('[data-testid="evo-pane-inbox"]')?.textContent?.includes("窄屏下工具栏按钮间距略紧")),
        { timeout: 5000 },
      );

      // Verify apply-sandbox-btn is NOT shown on unaccepted pain points
      expect(await page.evaluate(() => Boolean(document.querySelector('[data-testid^="apply-pain-sandbox-"]')))).toBe(false);

      // Switch to Playbook tab and save a rule
      await clickReady(page, '[data-testid="evo-tab-playbook"]');
      await page.waitForSelector('[data-testid="playbook-editor"]', { timeout: 5000 });
      await page.type('[data-testid="playbook-editor"]', "- [规范] 所有图标必须使用 Icon 包装器\n");
      await clickReady(page, '[data-testid="save-playbook-btn"]');
      await page.waitForFunction(
        () => Boolean(document.querySelector('[data-testid="evo-tab-playbook"]')?.textContent?.includes("(1)")),
        { timeout: 5000 },
      );

      // Switch to Telemetry tab
      await clickReady(page, '[data-testid="evo-tab-telemetry"]');
      await page.waitForSelector('[data-testid="evo-pane-telemetry"]', { timeout: 5000 });

      // Switch back to Inbox tab and promote pain point to a sandboxed requirement
      await clickReady(page, '[data-testid="evo-tab-inbox"]');
      const promoteBtnSel = await page.evaluate(() => {
        const btn = document.querySelector('[data-testid^="promote-pain-"]');
        return btn ? `[data-testid="${btn.getAttribute("data-testid")}"]` : "";
      });
      expect(promoteBtnSel).not.toBe("");
      await clickReady(page, promoteBtnSel);

      // Modal closes, switches to REQ-001 in draft stage with active sandbox badge and no apply button before acceptance
      await page.waitForSelector('[data-testid="sandbox-active-badge"]', { timeout: 5000 });
      const stageBadge = await page.evaluate(() => document.querySelector('[data-testid="ws-stage-badge"]')?.textContent ?? "");
      expect(stageBadge).toContain("草稿");
      expect(await page.evaluate(() => Boolean(document.querySelector('[data-testid="apply-sandbox-btn"]')))).toBe(false);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(overflow).toBe(false);
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("附件上传：新建需求与报修弹窗均可上传图片并在详情/收集箱中回显", async () => {
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-e2e-att-hub-"));
    tempDirs.push(hubDir);
    process.env.WORKBENCH_HUB_DIR = hubDir;

    const wbRepo = initGitRepo();
    await initProject(wbRepo, { name: "附件 E2E", privacyMode: "local" });
    const server = await startWorkbenchServer({ root: wbRepo, port: 0, writeDiscovery: false, hubMode: true });
    servers.push(server);

    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));

    const injectFile = async (scopeSelector: string, fileName: string) => {
      await page.evaluate(
        (scope: string, name: string) => {
          const root = document.querySelector(scope) ?? document;
          const input = root.querySelector('[data-testid="attachment-input"]') as HTMLInputElement | null;
          if (!input) throw new Error("attachment input not found");
          const dt = new DataTransfer();
          dt.items.add(
            new File([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])], name, { type: "image/png" }),
          );
          input.files = dt.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        },
        scopeSelector,
        fileName,
      );
    };

    try {
      await page.setViewport({ width: 1360, height: 900 });
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="new-req-btn"]', { timeout: 5000 });

      // 新建需求：上传截图并保存草稿，详情页展示缩略图
      await clickReady(page, '[data-testid="new-req-btn"]');
      await page.waitForSelector('[data-testid="new-req-goal"]', { timeout: 5000 });
      await page.type('[data-testid="new-req-goal"]', "E2E 附件需求：验证详情页缩略图");
      await injectFile('[data-testid="new-req-modal"]', "需求截图.png");
      await page.waitForSelector('[data-testid="attachment-pending-list"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="save-draft-btn"]');
      await page.waitForFunction(() => !document.querySelector('[data-testid="new-req-modal"]'), { timeout: 8000 });
      await page.waitForSelector('[data-testid="requirement-attachments-card"]', { timeout: 8000 });
      await page.waitForSelector('[data-testid="attachment-image"] img', { timeout: 8000 });
      const imageSrc = await page.evaluate(
        () => (document.querySelector('[data-testid="attachment-image"] img') as HTMLImageElement | null)?.src ?? "",
      );
      expect(imageSrc).toContain("/attachments/");

      // 报修：上传截图后收集箱详情回显
      await clickReady(page, '[data-testid="open-quick-report-btn"]');
      await page.waitForSelector('[data-testid="quick-report-modal"]', { timeout: 5000 });
      await page.type('[data-testid="quick-report-title"]', "E2E 附件报修：收集箱缩略图");
      await page.type('[data-testid="quick-report-detail"]', "附带一张截图用于复现");
      await injectFile('[data-testid="quick-report-modal"]', "报修截图.png");
      await page.waitForSelector('[data-testid="quick-report-modal"] [data-testid="attachment-pending-list"]', {
        timeout: 5000,
      });
      await clickReady(page, '[data-testid="submit-quick-report-btn"]');
      await page.waitForFunction(() => !document.querySelector('[data-testid="quick-report-modal"]'), { timeout: 8000 });

      await clickReady(page, '[data-testid="open-evolution-btn"]');
      await page.waitForSelector('[data-testid="evolution-modal"]', { timeout: 5000 });
      await page.waitForFunction(
        () =>
          Boolean(
            document.querySelector('[data-testid="evo-pane-inbox"]')?.textContent?.includes("E2E 附件报修：收集箱缩略图"),
          ),
        { timeout: 8000 },
      );
      await page.waitForSelector('[data-testid="evolution-modal"] [data-testid="attachment-image"] img', {
        timeout: 8000,
      });
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 40_000);

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

      // 1. Global Header spans full width above the 3 columns, and drawer button is disabled on HomeView
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
      expect(headerBox.sidebarWidth).toBe(240);
      expect(headerBox.drawerBtnDisabled).toBe(true);

      // 2. Desktop left sidebar collapses cleanly to 0px and expands back to 240px
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

      // 4. Drag resizer left to reach 50% equal width (840px on 1920px viewport with 240px sidebar)
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
      // Clamped at 50% of hub-workspace (1680 * 0.5 = 840), matching main-stage width
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

      // Tabs 栏不能被内容区挤压成细条，三个按钮必须完整位于栏内且仍可点击。
      expect(before.buttons.map((b) => b.text)).toEqual(["规范与方案", "变更与验证", "时间线与运行"]);
      expect(before.tabsHeight).toBeGreaterThan(30);
      for (const button of before.buttons) {
        expect(button.height).toBeGreaterThan(30);
        expect(button.width).toBeGreaterThan(0);
        expect(button.fullyInside).toBe(true);
        expect(button.hittable).toBe(true);
      }
      // Tabs 栏与下方滚动内容不重叠，滚动条出现在内容区而不是覆盖按钮。
      expect(before.tabsBottom).toBeLessThanOrEqual(before.scrollTop + 0.5);

      for (const tab of ["tab-changes", "tab-timeline", "tab-spec"] as const) {
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
    await initProject(repo, { name: "PickerRepo", privacyMode: "local" });
    await createRequirement(repo, {
      goal: "在原生续接时保持所选模型与推理强度",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    // The stage preset deliberately disagrees with the model picked in the picker below.
    applyHubRoutingPreset("quota_saver");
    const presetDesign = readHubConfig().routing.stages.design.primary;

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
          models: [{ id: "DeepSeek-V4-Pro", tier: "sota", source: "detected" }],
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
        const item = Array.from(document.querySelectorAll("[cmdk-item]")).find((el) => (el.textContent ?? "").includes(text));
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

      // 1. Automatic mode sends no explicit selection and dispatches the stage preset.
      expect(await readHiddenSelect()).toBe(`${presetDesign.harness}::${presetDesign.model}`);
      expect(await readTriggerLabel()).toContain(`自动 (${presetDesign.harness}/${presetDesign.model})`);
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
      await page.waitForSelector('[cmdk-item]', { timeout: 5000 });
      await pickVisibleItem("gpt-6.1-sol");
      await page.waitForFunction(
        () => (document.querySelector('[data-testid="banner-runner-select"]') as HTMLSelectElement)?.value === "codex::gpt-6.1-sol",
        { timeout: 5000 },
      );
      expect(await readTriggerLabel()).toContain("codex/gpt-6.1-sol");
      // page.select waits with puppeteer's 30s default; bound it so a missing control fails fast.
      await page.waitForSelector('[data-testid="banner-runner-select-effort"]', { timeout: 5000 });
      await page.select('[data-testid="banner-runner-select-effort"]', "medium");

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

      // 3. Returning to automatic routing through the same picker drops the override entirely.
      await clickReady(page, '[data-testid="banner-runner-select-trigger"]');
      await page.waitForSelector('[cmdk-item]', { timeout: 5000 });
      await pickVisibleItem("自动路由");
      await page.waitForFunction(
        () => (document.querySelector('[data-testid="banner-runner-select-trigger"]')?.textContent ?? "").includes("自动 ("),
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
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 45_000);

  test("REQ-012: 「更多」下拉菜单点击外部区域、Esc 与再次点击触发器均可自动关闭", async () => {
    const repo = initGitRepo();
    await initProject(repo, { name: "MoreMenuRepo", privacyMode: "local" });
    await createRequirement(repo, {
      goal: "更多展开的下拉菜单需要支持点击外部区域自动关闭",
      criteria: [{ id: "AC-1", description: "点击外部区域后菜单关闭", required: true, command: "echo ok" }],
    });

    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false });
    servers.push(server);

    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));

    const menuGone = () =>
      page.waitForFunction(() => !document.querySelector('[data-testid="more-menu"]'), { timeout: 5000 });
    const openMenu = async () => {
      await clickReady(page, '[data-testid="more-menu-btn"]');
      await page.waitForSelector('[data-testid="more-menu"]', { timeout: 5000 });
    };
    const clickMenuItem = (label: string) =>
      page.evaluate((text: string) => {
        const buttons = Array.from(document.querySelectorAll('[data-testid="more-menu"] button'));
        const target = buttons.find((b) => (b.textContent ?? "").includes(text));
        if (!target) throw new Error(`menu item not found: ${text}`);
        (target as HTMLButtonElement).click();
      }, label);

    try {
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="more-menu-btn"]', { timeout: 5000 });
      expect(await page.evaluate(() => document.querySelector('[data-testid="more-menu"]'))).toBeNull();

      // 1. 打开菜单：Portal 渲染并锚定在触发器下方、右缘对齐。
      await openMenu();
      const anchor = await page.evaluate(() => {
        const trigger = document.querySelector('[data-testid="more-menu-btn"]')!.getBoundingClientRect();
        const menu = document.querySelector('[data-testid="more-menu"]')!.getBoundingClientRect();
        return { triggerBottom: trigger.bottom, triggerRight: trigger.right, menuTop: menu.top, menuRight: menu.right };
      });
      expect(anchor.menuTop).toBeGreaterThanOrEqual(anchor.triggerBottom);
      expect(Math.abs(anchor.menuRight - anchor.triggerRight)).toBeLessThan(4);

      // 2. 核心回归：真实鼠标点击菜单外部区域后菜单自动关闭。
      await page.click(".ws-title");
      await menuGone();

      // 3. Esc 键关闭。
      await openMenu();
      await page.keyboard.press("Escape");
      await menuGone();

      // 4. 再次点击触发器切换关闭。
      await openMenu();
      await clickReady(page, '[data-testid="more-menu-btn"]');
      await menuGone();

      // 5. 选择菜单项后菜单关闭，且动作正常打开 Radix Dialog（交接简报弹窗）。
      await openMenu();
      await clickMenuItem("查看交接简报");
      await menuGone();
      await page.waitForSelector('[data-testid="handoff-modal"]', { timeout: 5000 });
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('[data-testid="handoff-modal"] button'));
        (buttons.find((b) => (b.textContent ?? "").includes("关闭")) as HTMLButtonElement | undefined)?.click();
      });
      await page.waitForFunction(() => !document.querySelector('[data-testid="handoff-modal"]'), { timeout: 5000 });

      // 6. 编辑动作同样先关菜单再进入编辑态，可反复开合不残留状态。
      await openMenu();
      await clickMenuItem("编辑需求与验收条件");
      await menuGone();
      await page.waitForSelector('[data-testid="spec-editor"]', { timeout: 5000 });
      await openMenu();
      await page.click(".ws-title");
      await menuGone();

      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);
});
