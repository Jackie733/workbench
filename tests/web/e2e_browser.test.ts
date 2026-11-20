import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  acceptRequirement,
  approveDesign,
  createRequirement,
  getRequirement,
  initProject,
  propose,
} from "../../src/core/engine.ts";
import { observeGitSnapshot } from "../../src/core/git.ts";
import { atomicWriteJson } from "../../src/core/fs.ts";
import { runVerification } from "../../src/core/runner.ts";
import type { RequirementState } from "../../src/core/types.ts";
import { HubExecutor } from "../../src/hub/executor.ts";
import { applyHubRoutingPreset, readHubConfig, registerHubProject } from "../../src/hub/registry.ts";
import { recordModelRunOutcome } from "../../src/hub/telemetry.ts";
import { executeWorkbenchTool } from "../../src/mcp/tools.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";
import { resetAuthPassword } from "../../src/server/auth.ts";
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
  evaluateOnNewDocument(fn: () => void): Promise<unknown>;
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

      // Scroll down inside sidebar requirement list to REQ-005, open it -> scroll position preserved & detail switches!
      await page.evaluate(() => {
        document.querySelector('[data-testid="req-row-REQ-005"]')?.scrollIntoView({ block: "center" });
      });
      const scrolledY = await page.evaluate(() => document.querySelector(".sb-req-scroll")?.scrollTop ?? 0);
      expect(scrolledY).toBeGreaterThan(100);
      await clickReady(page, '[data-testid="req-row-REQ-005"]');
      await page.waitForSelector('[data-testid="ws-stage-badge"]', { timeout: 5000 });
      await new Promise((r) => setTimeout(r, 80));
      const restoredY = await page.evaluate(() => document.querySelector(".sb-req-scroll")?.scrollTop ?? 0);
      expect(Math.abs(restoredY - scrolledY)).toBeLessThan(20);

      // Dedicated Code Changes tab + right drawer Diff tab
      await clickReady(page, '[data-testid="tab-diff"]');
      await page.waitForSelector('[data-testid="diff-viewer-panel"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="dock-diff-to-drawer-btn"]');
      await page.waitForSelector('[data-testid="drawer-diff-pane"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="toggle-drawer-btn"]');

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
      await page.waitForFunction(() => !document.querySelector("[data-sonner-toast]"), { timeout: 15000 });
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

      // Inspect Code Changes tab (split/unified/expand + isolated drawer) and Verify & Shots tab (shortcut + log)
      await page.click('[data-testid="tab-diff"]');
      await page.waitForSelector('[data-testid="diff-viewer-panel"] .diff-code', { timeout: 5000 });
      const gitDiffText = await page.evaluate(() => document.querySelector('[data-testid="diff-viewer-panel"] .diff-code')?.textContent ?? "");
      expect(gitDiffText).toContain("export const sub");
      await clickReady(page, '[data-testid="diff-view-mode-toggle"] button:nth-child(2)');
      await page.waitForSelector('[data-testid="diff-unified-list"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="diff-expand-height-btn"]');
      expect(
        await page.evaluate(() => document.querySelector('[data-testid="diff-unified-list"]')?.classList.contains("expanded")),
      ).toBe(true);
      await clickReady(page, '[data-testid="diff-expand-height-btn"]');
      await clickReady(page, '[data-testid="diff-view-mode-toggle"] button:nth-child(1)');

      await clickReady(page, '[data-testid="dock-diff-to-drawer-btn"]');
      await page.waitForSelector('[data-testid="drawer-diff-pane"]', { timeout: 5000 });
      expect(await page.evaluate(() => document.querySelectorAll('[data-testid="diff-view-mode-toggle"]').length)).toBe(1);
      expect(await page.evaluate(() => document.querySelectorAll('[data-testid="drawer-diff-view-mode-toggle"]').length)).toBe(1);
      await clickReady(page, '[data-testid="toggle-drawer-btn"]');

      await page.click('[data-testid="tab-changes"]');
      await page.waitForSelector('[data-testid="verify-diff-shortcut-card"]', { timeout: 5000 });
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

      // 1b. Sidebar project sorting, grouping, pin, and custom category persistence
      await clickReady(page, `[data-testid="pin-project-${alphaId}"]`);
      await page.waitForFunction(
        (id: unknown) => Boolean(document.querySelector(`[data-testid="pin-project-${String(id)}"]`)?.classList.contains("pinned")),
        { timeout: 5000 },
        alphaId,
      );
      await clickReady(page, `[data-testid="category-project-${alphaId}"]`);
      await page.waitForSelector(`[data-testid="category-input-${alphaId}"]`, { timeout: 5000 });
      await page.type(`[data-testid="category-input-${alphaId}"]`, "核心");
      await clickReady(page, `[data-testid="category-save-${alphaId}"]`);
      await page.waitForSelector(`[data-testid="project-cat-badge-${alphaId}"]`, { timeout: 5000 });
      await page.select('[data-testid="project-sort-select"]', "name");
      await page.select('[data-testid="project-group-select"]', "category");
      await page.waitForSelector('[data-testid="project-group-cat:核心"]', { timeout: 5000 });
      await page.select('[data-testid="project-group-select"]', "none");

      // 1c. Switching between projects does not jump/reorder the sidebar project queue
      const orderBeforeSwitch = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid="hub-project-list"] [data-action="switch-project"]')).map((el) =>
          el.getAttribute("data-id"),
        ),
      );
      const otherId = orderBeforeSwitch.find((id) => id && id !== alphaId)!;
      await page.select('[data-testid="project-sort-select"]', "recent");
      const orderOnRecentBefore = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid="hub-project-list"] [data-action="switch-project"]')).map((el) =>
          el.getAttribute("data-id"),
        ),
      );
      await clickReady(page, `[data-testid="hub-project-${otherId}"]`);
      await page.waitForSelector('[data-testid="empty-state"]', { timeout: 5000 });
      const orderAfterSwitch = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid="hub-project-list"] [data-action="switch-project"]')).map((el) =>
          el.getAttribute("data-id"),
        ),
      );
      expect(orderAfterSwitch).toEqual(orderOnRecentBefore);
      await page.select('[data-testid="project-sort-select"]', "attention");
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
      await clickReady(page, '[data-testid="toggle-drawer-btn"]');
      await page.waitForFunction(
        () => {
          const drawer = document.querySelector('[data-testid="right-drawer"]');
          return drawer?.getAttribute("aria-hidden") === "true" && Boolean(drawer?.classList.contains("settled"));
        },
        { timeout: 5000 },
      );
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

      await clickReady(page, '[data-testid="toggle-drawer-btn"]');
      await page.waitForFunction(
        () => {
          const drawer = document.querySelector('[data-testid="right-drawer"]');
          return drawer?.getAttribute("aria-hidden") === "true" && Boolean(drawer?.classList.contains("settled"));
        },
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

      // Seed one run outcome before opening Evolution Center so Telemetry tab renders action badge localization cleanly.
      recordModelRunOutcome({
        harness: "codex",
        model: "gpt-6.2-sol",
        action: "review",
        status: "succeeded",
        durationMs: 1200,
      });

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

      // Switch to Telemetry tab and verify action badge localization in both languages
      await clickReady(page, '[data-testid="evo-tab-telemetry"]');
      await page.waitForSelector('[data-testid="evo-pane-telemetry"]', { timeout: 5000 });
      await page.waitForSelector('[data-testid="telemetry-action-badge"]', { timeout: 5000 });
      expect(
        await page.evaluate(() => document.querySelector('[data-testid="telemetry-action-badge"]')?.textContent ?? ""),
      ).toBe("审查");
      await page.select('[data-testid="ui-language-select"]', "en");
      await page.waitForFunction(
        () => document.querySelector('[data-testid="telemetry-action-badge"]')?.textContent === "Review",
        { timeout: 5000 },
      );
      await page.select('[data-testid="ui-language-select"]', "zh-CN");
      await page.waitForFunction(
        () => document.querySelector('[data-testid="telemetry-action-badge"]')?.textContent === "审查",
        { timeout: 5000 },
      );

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
    for (let version = 1; version <= 16; version += 1) {
      await propose(repo, "REQ-001", {
        designMarkdown: `# Responsive layout design ${version}\n\nPreserve the active requirement and its history while panels adapt to available width.`,
        actor: "agent",
      });
    }

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

      // 6. Keep the active requirement, activity tab, and its scroll position across the full viewport matrix.
      await clickReady(page, '[data-testid="tab-timeline"]');
      await page.waitForSelector('[data-testid="workspace-tab-scroll"] .timeline-item', { timeout: 5000 });
      const startingScrollTop = await page.evaluate(() => {
        const scroller = document.querySelector('[data-testid="workspace-tab-scroll"]') as HTMLElement | null;
        if (!scroller) return 0;
        scroller.scrollTop = Math.min(240, scroller.scrollHeight - scroller.clientHeight);
        return scroller.scrollTop;
      });
      expect(startingScrollTop).toBeGreaterThan(0);

      const responsiveWidths = [1440, 1360, 1280, 1024, 821, 820, 768, 390, 375, 320, 1440];
      for (const width of responsiveWidths) {
        await page.setViewport({ width, height: 820 });
        await page.waitForFunction(
          () => {
            const workspace = document.querySelector(".hub-workspace");
            const drawer = document.querySelector('[data-testid="right-drawer"]');
            if (!workspace || !drawer) return false;
            const drawerWidth = Number.parseFloat(getComputedStyle(workspace).getPropertyValue("--drawer-w"));
            const mainWidth = workspace.clientWidth - (Number.isFinite(drawerWidth) ? drawerWidth : 0);
            return drawer.getAttribute("data-layout-mode") === (mainWidth >= 520 ? "column" : "overlay");
          },
          { timeout: 5000 },
        );
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const responsiveState = await page.evaluate(() => {
          const stage = document.querySelector(".main-stage")?.getBoundingClientRect();
          const scroller = document.querySelector('[data-testid="workspace-tab-scroll"]') as HTMLElement | null;
          return {
            overflow: document.documentElement.scrollWidth > window.innerWidth,
            layoutMode: document.querySelector('[data-testid="right-drawer"]')?.getAttribute("data-layout-mode") ?? "",
            mainWidth: stage?.width ?? 0,
            selectedRequirement: document.querySelector(".app-req-id")?.textContent?.trim() ?? "",
            timelineActive: Boolean(document.querySelector('[data-testid="tab-timeline"]')?.classList.contains("active")),
            scrollTop: scroller?.scrollTop ?? -1,
          };
        });
        expect(responsiveState.overflow).toBe(false);
        expect(responsiveState.mainWidth).toBeGreaterThan(250);
        expect(responsiveState.selectedRequirement).toBe("REQ-001");
        expect(responsiveState.timelineActive).toBe(true);
        expect(Math.abs(responsiveState.scrollTop - startingScrollTop)).toBeLessThan(20);
        if ([320, 375, 390].includes(width)) {
          const narrowContentVisibility = await page.evaluate(() => {
            const header = document.querySelector('[data-testid="app-header"]');
            const headerRect = header?.getBoundingClientRect() ?? null;
            const controls = Array.from(
              header?.querySelectorAll<HTMLElement>(".topbar-left button, .topbar-right button, .topbar-right select") ?? [],
            ).filter((control) => {
              const rect = control.getBoundingClientRect();
              const style = getComputedStyle(control);
              return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
            });
            const stepper = document.querySelector('[data-testid="stage-stepper"]');
            const stepperRect = stepper?.getBoundingClientRect() ?? null;
            const steps = Array.from(stepper?.querySelectorAll<HTMLElement>(".step-item") ?? []);
            const rectWithin = (child: DOMRect | null, parent: DOMRect | null) =>
              Boolean(
                child &&
                  parent &&
                  child.left >= parent.left - 0.5 &&
                  child.right <= parent.right + 0.5 &&
                  child.top >= parent.top - 0.5 &&
                  child.bottom <= parent.bottom + 0.5,
              );
            const components = steps.flatMap((step, index) => {
              const dot = step.querySelector<HTMLElement>(".step-dot");
              const label = dot?.nextElementSibling as HTMLElement | null;
              return [
                ...(dot ? [{ step, index, name: "dot", element: dot }] : []),
                ...(label ? [{ step, index, name: "label", element: label }] : []),
              ];
            });
            const visibleControls = controls.map((control) => {
              const rect = control.getBoundingClientRect();
              const x = (rect.left + rect.right) / 2;
              const y = (rect.top + rect.bottom) / 2;
              const hit = document.elementFromPoint(x, y);
              const hitControl = hit?.closest("button, select") ?? null;
              return {
                id: control.dataset.testid ?? control.dataset.action ?? control.tagName.toLowerCase(),
                withinHeader: Boolean(
                  headerRect && rect.top >= headerRect.top - 0.5 && rect.bottom <= headerRect.bottom + 0.5,
                ),
                withinViewport: rect.left >= 0 && rect.right <= window.innerWidth,
                centerHitsControl: hitControl === control,
              };
            });
            const overlaps: Array<{ control: string; step: string; part: string; width: number; height: number }> = [];
            for (const control of controls) {
              const controlRect = control.getBoundingClientRect();
              for (const component of components) {
                const componentRect = component.element.getBoundingClientRect();
                const overlapWidth = Math.min(controlRect.right, componentRect.right) - Math.max(controlRect.left, componentRect.left);
                const overlapHeight = Math.min(controlRect.bottom, componentRect.bottom) - Math.max(controlRect.top, componentRect.top);
                if (overlapWidth > 0.5 && overlapHeight > 0.5) {
                  overlaps.push({
                    control: control.dataset.testid ?? control.dataset.action ?? control.tagName.toLowerCase(),
                    step: component.step.textContent?.trim() ?? `step-${component.index + 1}`,
                    part: component.name,
                    width: overlapWidth,
                    height: overlapHeight,
                  });
                }
              }
            }
            const hitTests: Array<{ step: string; part: string; withinStep: boolean; topbar: boolean }> = [];
            for (const component of components) {
              const rect = component.element.getBoundingClientRect();
              const visibleLeft = Math.max(rect.left, stepperRect?.left ?? 0, 0);
              const visibleRight = Math.min(rect.right, stepperRect?.right ?? window.innerWidth, window.innerWidth);
              const visibleTop = Math.max(rect.top, stepperRect?.top ?? 0, 0);
              const visibleBottom = Math.min(rect.bottom, stepperRect?.bottom ?? window.innerHeight, window.innerHeight);
              if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) continue;
              const fractions = component.name === "dot" ? [0.5] : [0.05, 0.25, 0.5, 0.75, 0.95];
              for (const fraction of fractions) {
                const x = visibleLeft + (visibleRight - visibleLeft) * fraction;
                const y = (visibleTop + visibleBottom) / 2;
                const hit = document.elementFromPoint(x, y);
                hitTests.push({
                  step: component.step.textContent?.trim() ?? `step-${component.index + 1}`,
                  part: component.name,
                  withinStep: hit?.closest(".step-item") === component.step,
                  topbar: Boolean(hit?.closest('[data-testid="app-header"]')),
                });
              }
            }
            const firstStep = steps[0] ?? null;
            const firstDot = firstStep?.querySelector<HTMLElement>(".step-dot") ?? null;
            const firstLabel = firstDot?.nextElementSibling as HTMLElement | null;
            const firstStepFullyVisible = Boolean(
              firstDot &&
                firstLabel &&
                rectWithin(firstDot.getBoundingClientRect(), stepperRect) &&
                rectWithin(firstLabel.getBoundingClientRect(), stepperRect) &&
                firstLabel.getBoundingClientRect().left >= 0 &&
                firstLabel.getBoundingClientRect().right <= window.innerWidth,
            );
            return {
              viewportWidth: window.innerWidth,
              documentWidth: document.documentElement.scrollWidth,
              firstStepLabel: firstLabel?.textContent?.trim() ?? "",
              firstStepFullyVisible,
              stepperStartsBelowHeader: Boolean(headerRect && stepperRect && stepperRect.top >= headerRect.bottom - 0.5),
              controlHits: visibleControls,
              overlaps,
              hitTests,
            };
          });
          expect(narrowContentVisibility.documentWidth).toBeLessThanOrEqual(narrowContentVisibility.viewportWidth);
          expect(narrowContentVisibility.firstStepLabel).toBe("1. 需求草稿");
          expect(narrowContentVisibility.firstStepFullyVisible).toBe(true);
          expect(narrowContentVisibility.stepperStartsBelowHeader).toBe(true);
          for (const requiredControl of [
            "ui-language-select",
            "topbar-insights-btn",
            "open-evolution-btn",
            "open-quick-report-btn",
            "open-routing-btn",
            "toggle-drawer-btn",
          ]) {
            expect(narrowContentVisibility.controlHits.map((control) => control.id)).toContain(requiredControl);
          }
          expect(narrowContentVisibility.controlHits.length).toBeGreaterThan(0);
          expect(narrowContentVisibility.controlHits.every((control) => control.withinHeader && control.withinViewport && control.centerHitsControl)).toBe(true);
          expect(narrowContentVisibility.overlaps).toEqual([]);
          expect(narrowContentVisibility.hitTests.length).toBeGreaterThan(0);
          expect(narrowContentVisibility.hitTests.every((hit) => hit.withinStep && !hit.topbar)).toBe(true);
        }
        if (width === 1440) expect(responsiveState.layoutMode).toBe("column");
        if ([1360, 1280, 1024].includes(width)) {
          expect(responsiveState.layoutMode).toBe("overlay");
          await clickReady(page, '[data-testid="toggle-drawer-btn"]');
          await page.waitForSelector('[data-testid="right-drawer"].open', { timeout: 5000 });
          const overlayCloseButton = await page.evaluate(() => {
            const button = document.querySelector('[data-testid="right-drawer"] [data-testid="drawer-close-btn"]') as HTMLElement | null;
            const rect = button?.getBoundingClientRect();
            return {
              visible: Boolean(button && getComputedStyle(button).display !== "none" && rect && rect.width > 0 && rect.height > 0),
              width: rect?.width ?? 0,
              height: rect?.height ?? 0,
              overflow: document.documentElement.scrollWidth > window.innerWidth,
            };
          });
          expect(overlayCloseButton.visible).toBe(true);
          expect(overlayCloseButton.width).toBeGreaterThanOrEqual(44);
          expect(overlayCloseButton.height).toBeGreaterThanOrEqual(44);
          expect(overlayCloseButton.overflow).toBe(false);
          await clickReady(page, '[data-testid="drawer-close-btn"]');
          await page.waitForFunction(
            () => {
              const drawer = document.querySelector('[data-testid="right-drawer"]');
              return drawer?.getAttribute("aria-hidden") === "true" && Boolean(drawer?.classList.contains("settled"));
            },
            { timeout: 5000 },
          );
        }
      }

      // 6b. At 320px the drawer fills the viewport, so close it from its own 44px header control.
      await page.setViewport({ width: 320, height: 820 });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await page.waitForFunction(
        () => document.querySelector('[data-testid="right-drawer"]')?.getAttribute("data-layout-mode") === "overlay",
        { timeout: 5000 },
      );
      await clickReady(page, '[data-testid="toggle-drawer-btn"]');
      await page.waitForSelector('[data-testid="right-drawer"].open', { timeout: 5000 });
      const closeButtonBox = await page.evaluate(() => {
        const drawer = document.querySelector('[data-testid="right-drawer"]');
        const button = drawer?.querySelector('[data-testid="drawer-close-btn"]') as HTMLElement | null;
        const rect = button?.getBoundingClientRect();
        return {
          inHeader: Boolean(drawer?.querySelector(".drawer-head")?.contains(button ?? null)),
          visible: Boolean(button && getComputedStyle(button).display !== "none" && rect && rect.width > 0 && rect.height > 0),
          width: rect?.width ?? 0,
          height: rect?.height ?? 0,
          overflow: document.documentElement.scrollWidth > window.innerWidth,
        };
      });
      expect(closeButtonBox.inHeader).toBe(true);
      expect(closeButtonBox.visible).toBe(true);
      expect(closeButtonBox.width).toBeGreaterThanOrEqual(44);
      expect(closeButtonBox.height).toBeGreaterThanOrEqual(44);
      expect(closeButtonBox.overflow).toBe(false);
      await clickReady(page, '[data-testid="drawer-close-btn"]');
      await page.waitForFunction(
        () => {
          const drawer = document.querySelector('[data-testid="right-drawer"]');
          return drawer?.getAttribute("aria-hidden") === "true" && Boolean(drawer?.classList.contains("settled"));
        },
        { timeout: 5000 },
      );
      await clickReady(page, '[data-testid="tab-spec"]');
      await clickReady(page, '[data-testid="tab-timeline"]');
      const closedDrawerState = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        selectedRequirement: document.querySelector(".app-req-id")?.textContent?.trim() ?? "",
        timelineActive: Boolean(document.querySelector('[data-testid="tab-timeline"]')?.classList.contains("active")),
      }));
      expect(closedDrawerState.overflow).toBe(false);
      expect(closedDrawerState.selectedRequirement).toBe("REQ-001");
      expect(closedDrawerState.timelineActive).toBe(true);

      await clickReady(page, '[data-testid="toggle-drawer-btn"]');
      await page.waitForSelector('[data-testid="right-drawer"].open', { timeout: 5000 });
      const reopenedDrawerState = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        selectedRequirement: document.querySelector(".app-req-id")?.textContent?.trim() ?? "",
        timelineActive: Boolean(document.querySelector('[data-testid="tab-timeline"]')?.classList.contains("active")),
        closeVisible: getComputedStyle(document.querySelector('[data-testid="drawer-close-btn"]') as HTMLElement).display !== "none",
      }));
      expect(reopenedDrawerState.overflow).toBe(false);
      expect(reopenedDrawerState.selectedRequirement).toBe("REQ-001");
      expect(reopenedDrawerState.timelineActive).toBe(true);
      expect(reopenedDrawerState.closeVisible).toBe(true);
      await clickReady(page, '[data-testid="drawer-close-btn"]');
      await page.waitForFunction(
        () => document.querySelector('[data-testid="right-drawer"]')?.getAttribute("aria-hidden") === "true",
        { timeout: 5000 },
      );

      // 7. On mobile, opening the sidebar while the drawer is open closes the drawer instead of stacking overlays.
      await page.setViewport({ width: 820, height: 820 });
      await clickReady(page, '[data-testid="toggle-drawer-btn"]');
      await page.waitForSelector('[data-testid="right-drawer"].open', { timeout: 5000 });
      await clickReady(page, '[data-testid="toggle-sidebar-btn"]');
      await page.waitForSelector('[data-testid="hub-sidebar"].open', { timeout: 5000 });
      const mobilePanelState = await page.evaluate(() => ({
        sidebarOpen: Boolean(document.querySelector('[data-testid="hub-sidebar"].open')),
        drawerOpen: Boolean(document.querySelector('[data-testid="right-drawer"].open')),
      }));
      expect(mobilePanelState).toEqual({ sidebarOpen: true, drawerOpen: false });
      await page.click(".sidebar-backdrop");
      await page.waitForFunction(() => !document.querySelector('[data-testid="hub-sidebar"].open'), { timeout: 5000 });

      // 8. An in-progress design draft survives further narrow/wide transitions; routing settings stay inside the viewport.
      await page.setViewport({ width: 1440, height: 820 });
      await clickReady(page, '[data-testid="tab-spec"]');
      await clickReady(page, '[data-testid="start-edit-design-btn"]');
      await page.waitForSelector('[data-testid="design-body-input"]', { timeout: 5000 });
      await page.type('[data-testid="design-body-input"]', "\nResponsive draft preserved across resize.");
      for (const width of [390, 320, 1440]) {
        await page.setViewport({ width, height: 820 });
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const draft = await page.evaluate(
          () => (document.querySelector('[data-testid="design-body-input"]') as HTMLTextAreaElement | null)?.value ?? "",
        );
        expect(draft).toContain("Responsive draft preserved across resize.");
      }
      await clickReady(page, '[data-testid="save-design-btn"]');
      await page.waitForFunction(() => !document.querySelector('[data-testid="design-body-input"]'), { timeout: 5000 });
      await page.setViewport({ width: 390, height: 820 });
      await clickReady(page, '[data-testid="open-routing-btn"]');
      await page.waitForSelector('[data-testid="routing-modal"]', { timeout: 5000 });
      const routingBounds = await page.evaluate(() => {
        const rect = document.querySelector('[data-testid="routing-modal"]')?.getBoundingClientRect();
        return { left: rect?.left ?? -1, right: rect?.right ?? -1, width: rect?.width ?? 0 };
      });
      expect(routingBounds.left).toBeGreaterThanOrEqual(0);
      expect(routingBounds.right).toBeLessThanOrEqual(390);
      expect(routingBounds.width).toBeGreaterThan(200);
      await clickReady(page, '[data-testid="routing-modal"] button:not([data-testid])');
      await page.waitForFunction(() => !document.querySelector('[data-testid="routing-modal"]'), { timeout: 5000 });

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

      // Tabs 栏不能被内容区挤压成细条，四个按钮必须完整位于栏内且仍可点击。
      expect(before.buttons.map((b) => b.text)).toEqual(["规范与方案", "代码变更", "验证与截图", "时间线与运行"]);
      expect(before.tabsHeight).toBeGreaterThan(30);
      for (const button of before.buttons) {
        expect(button.height).toBeGreaterThan(30);
        expect(button.width).toBeGreaterThan(0);
        expect(button.fullyInside).toBe(true);
        expect(button.hittable).toBe(true);
      }
      // Tabs 栏与下方滚动内容不重叠，滚动条出现在内容区而不是覆盖按钮。
      expect(before.tabsBottom).toBeLessThanOrEqual(before.scrollTop + 0.5);

      for (const tab of ["tab-diff", "tab-changes", "tab-timeline", "tab-spec"] as const) {
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
      await clickReady(page, '[data-testid="toggle-drawer-btn"]');
      await page.waitForFunction(
        () => {
          const drawer = document.querySelector('[data-testid="right-drawer"]');
          return drawer?.getAttribute("aria-hidden") === "true" && Boolean(drawer?.classList.contains("settled"));
        },
        { timeout: 5000 },
      );
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

      // 4. Console run selector and Timeline runs badge localize action & status cleanly across language switches.
      await page.waitForSelector('[data-testid="console-pane"] select option', { timeout: 5000 });
      const zhOptionText = await page.evaluate(
        () => document.querySelector('[data-testid="console-pane"] select option')?.textContent ?? "",
      );
      expect(zhOptionText).toContain("设计 ·");
      expect(zhOptionText).toContain("(已完成)");

      await clickReady(page, '[data-testid="tab-timeline"]');
      await page.waitForFunction(
        () => (document.querySelector('[data-testid="workspace-tab-scroll"]')?.textContent ?? "").includes("设计 · 已完成"),
        { timeout: 5000 },
      );

      await page.select('[data-testid="ui-language-select"]', "en");
      await page.waitForFunction(
        () =>
          (document.querySelector('[data-testid="console-pane"] select option')?.textContent ?? "").includes(
            "Design ·",
          ) &&
          (document.querySelector('[data-testid="console-pane"] select option')?.textContent ?? "").includes(
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

  test("REQ-004: 执行终端适配亮暗主题、折叠次要上下文、切换结构/原始视图并自动加载历史 Run 日志", async () => {
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-e2e-console-hub-"));
    tempDirs.push(hubDir);
    process.env.WORKBENCH_HUB_DIR = hubDir;

    const repo = initGitRepo();
    await initProject(repo, { name: "ConsoleRepo", privacyMode: "local" });
    await createRequirement(repo, {
      goal: "优化执行终端主题与结构化输出",
      criteria: [{ id: "AC-1", description: "测试通过", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", {
      designMarkdown: "# 方案\n结构化终端输出。",
      actor: "agent",
    });

    const richOutputScript = [
      "cat <<'EOF'",
      "OpenAI Codex v0.114.0 (research preview)",
      "--------",
      "workdir: /repo",
      "model: gpt-6-astra",
      "--------",
      "user",
      "请接力执行工作台需求 REQ-001",
      "SECRET_PROMPT_BODY_ONLY_WHEN_EXPANDED",
      "hook: SessionStart",
      "hook: UserPromptSubmit",
      "thinking",
      "先分析终端渲染层次",
      "SECRET_THINKING_LINE_2",
      "exec",
      "/bin/bash -lc 'ls' in /repo succeeded in 12ms:",
      "line-1",
      "line-2",
      "line-3",
      "line-4",
      "line-5",
      "line-6",
      "line-7",
      "codex",
      "核心回复：终端渲染已完成。",
      "[spawn error] 模拟错误告警",
      "EOF",
    ].join("\n");

    const executor = new HubExecutor({
      initialHarnesses: [
        {
          id: "codex",
          label: "Codex CLI",
          subscription: "ChatGPT Plus",
          installed: true,
          executable: "codex",
          models: [{ id: "gpt-6-astra", tier: "sota", source: "detected" }],
          defaultModel: "gpt-6-astra",
          detectedAt: Date.now(),
        },
      ],
      commandBuilder: () => ({
        command: "bash",
        args: ["-c", richOutputScript],
        displayCommand: "codex exec -C /repo (model=gpt-6-astra)",
      }),
    });

    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, hubMode: true, executor });
    servers.push(server);

    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));

    try {
      await page.setViewport({ width: 1360, height: 860 });
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="action-approve_only"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="action-approve_only"]');
      await page.waitForSelector('[data-testid="run-selected-model-btn"]', { timeout: 5000 });

      await clickReady(page, '[data-testid="run-selected-model-btn"]');
      await page.waitForFunction(
        () =>
          Boolean(document.querySelector('[data-testid="console-log-output"]')?.textContent?.includes("核心回复：终端渲染已完成")) &&
          !document.querySelector('[data-testid="live-agent-banner"]'),
        { timeout: 8000 },
      );

      // 1. 浅色与深色主题下的背景与文本对比适配
      const lightColors = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="console-log-output"]')!;
        const cs = getComputedStyle(el);
        return {
          theme: document.documentElement.getAttribute("data-theme"),
          bg: cs.backgroundColor,
          color: cs.color,
        };
      });
      expect(lightColors.bg).toBe("rgb(248, 250, 252)");
      expect(lightColors.color).toBe("rgb(30, 41, 59)");

      await clickReady(page, '[data-action="toggle-theme"]');
      const darkColors = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="console-log-output"]')!;
        const cs = getComputedStyle(el);
        return {
          theme: document.documentElement.getAttribute("data-theme"),
          bg: cs.backgroundColor,
          color: cs.color,
        };
      });
      expect(darkColors.theme).toBe("dark");
      expect(darkColors.bg).toBe("rgb(15, 19, 26)");
      expect(darkColors.color).toBe("rgb(226, 232, 240)");

      // 2. 次要区块默认折叠，主要回复与错误告警默认展开
      const initialState = await page.evaluate(() => {
        const out = document.querySelector('[data-testid="console-log-output"]')?.textContent ?? "";
        const foldStates = Array.from(document.querySelectorAll('[data-testid^="console-fold-"]')).map((el) => ({
          testid: el.getAttribute("data-testid"),
          expanded: el.getAttribute("aria-expanded"),
        }));
        return { out, foldStates };
      });
      expect(initialState.out).toContain("核心回复：终端渲染已完成");
      expect(initialState.out).toContain("[spawn error] 模拟错误告警");
      expect(initialState.out).not.toContain("SECRET_PROMPT_BODY_ONLY_WHEN_EXPANDED");
      expect(initialState.out).not.toContain("SECRET_THINKING_LINE_2");
      for (const f of initialState.foldStates) {
        expect(f.expanded).toBe("false");
      }

      // 3. 单独展开提示词折叠块，并验证一键展开全部 / 收起次要
      await clickReady(page, '[data-testid="console-fold-prompt_context"]');
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="console-fold-prompt_context"]')?.getAttribute("aria-expanded") === "true" &&
          Boolean(document.querySelector('[data-testid="console-log-output"]')?.textContent?.includes("SECRET_PROMPT_BODY_ONLY_WHEN_EXPANDED")),
        { timeout: 3000 },
      );

      await clickReady(page, '[data-testid="console-toggle-secondary-btn"]');
      const allExpanded = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid^="console-fold-"]')).every(
          (el) => el.getAttribute("aria-expanded") === "true",
        ),
      );
      expect(allExpanded).toBe(true);
      expect(
        await page.evaluate(() => document.querySelector('[data-testid="console-log-output"]')?.textContent ?? ""),
      ).toContain("SECRET_THINKING_LINE_2");

      await clickReady(page, '[data-testid="console-toggle-secondary-btn"]');
      const allCollapsed = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid^="console-fold-"]')).every(
          (el) => el.getAttribute("aria-expanded") === "false",
        ),
      );
      expect(allCollapsed).toBe(true);

      // 4. 切换原始输出与结构视图
      await clickReady(page, '[data-testid="console-mode-raw"]');
      await page.waitForSelector('[data-testid="console-raw-pre"]', { timeout: 3000 });
      const rawText = await page.evaluate(() => document.querySelector('[data-testid="console-raw-pre"]')?.textContent ?? "");
      expect(rawText).toContain("SECRET_PROMPT_BODY_ONLY_WHEN_EXPANDED");
      expect(rawText).toContain("hook: SessionStart");

      await clickReady(page, '[data-testid="console-mode-structured"]');
      await page.waitForSelector('[data-testid="console-blocks"]', { timeout: 3000 });

      // 5. 页面刷新后重新进入需求并切到「执行终端」页签，自动加载历史 Run 日志
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="ws-stage-badge"]', { timeout: 5000 });
      const drawerHidden = await page.evaluate(
        () => document.querySelector('[data-testid="right-drawer"]')?.getAttribute("aria-hidden") === "true",
      );
      if (drawerHidden) {
        await clickReady(page, '[data-testid="toggle-drawer-btn"]');
        await page.waitForSelector('[data-testid="right-drawer"].open', { timeout: 5000 });
      }
      await clickReady(page, '[data-testid="drawer-tab-console"]');
      await page.waitForFunction(
        () =>
          Boolean(document.querySelector('[data-testid="console-log-output"]')?.textContent?.includes("核心回复：终端渲染已完成")),
        { timeout: 5000 },
      );

      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("REQ-005: 「更多」下拉菜单宽度随内容自适应且菜单项整行填满", async () => {
    const repo = initGitRepo();
    await initProject(repo, { name: "MenuWidthRepo", privacyMode: "local" });
    await createRequirement(repo, {
      goal: "修复更多下拉菜单宽度异常",
      criteria: [{ id: "AC-1", description: "菜单宽度随内容自适应", required: true, command: "echo ok" }],
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
      await Bun.sleep(300); // 等待 Radix 定位与入场动画（scale 0.96→1）结束再测量
    };

    try {
      await page.setViewport({ width: 1360, height: 860 });
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="more-menu-btn"]', { timeout: 5000 });

      for (const viewport of [
        { width: 1280, height: 800 },
        { width: 2514, height: 1348 },
      ]) {
        await page.setViewport(viewport);
        await Bun.sleep(100);
        await openMenu();
        const metrics = await page.evaluate(() => {
          const menu = document.querySelector('[data-testid="more-menu"]') as HTMLElement;
          const trigger = document.querySelector('[data-testid="more-menu-btn"]')!.getBoundingClientRect();
          const rect = menu.getBoundingClientRect();
          const style = getComputedStyle(menu);
          const contentWidth =
            menu.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
          const items = Array.from(menu.querySelectorAll("button")).map((b) => (b as HTMLElement).offsetWidth);
          return {
            width: rect.width,
            right: rect.right,
            triggerRight: trigger.right,
            contentWidth,
            items,
            viewportWidth: window.innerWidth,
          };
        });
        // 菜单宽度随内容自适应：保留 170px 下限，最长菜单项量级不超过 320px，绝不 stretch 到视口宽度。
        expect(metrics.width).toBeGreaterThanOrEqual(170);
        expect(metrics.width).toBeLessThanOrEqual(320);
        expect(metrics.width).toBeLessThan(metrics.viewportWidth / 2);
        // 沿用 REQ-012 的右缘对齐约定。
        expect(Math.abs(metrics.right - metrics.triggerRight)).toBeLessThan(4);
        // 整行 hover 高亮依赖菜单项填满菜单内容宽度。
        expect(metrics.items.length).toBeGreaterThanOrEqual(6);
        for (const itemWidth of metrics.items) {
          expect(Math.abs(itemWidth - metrics.contentWidth)).toBeLessThanOrEqual(1);
        }
        await page.keyboard.press("Escape");
        await menuGone();
      }

      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("REQ-005: 侧栏节点徽标与算力路由配置按钮单行显示", async () => {
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-e2e-hub-"));
    tempDirs.push(hubDir);
    process.env.WORKBENCH_HUB_DIR = hubDir;

    const remoteRepo = initGitRepo();
    const localRepo = initGitRepo();
    await initProject(localRepo, { name: "Workbench-Node", privacyMode: "local" });
    registerHubProject(localRepo, { name: "Workbench-Node" });
    registerHubProject(remoteRepo, {
      name: "deepmdt-frontend-pc",
      nodeId: "wsl-work",
      nodeName: "Windows WSL2",
      activate: true,
    });

    const server = await startWorkbenchServer({ root: localRepo, port: 0, writeDiscovery: false, hubMode: true });
    servers.push(server);

    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));

    try {
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="hub-sidebar"]', { timeout: 5000 });
      await page.waitForSelector('[data-testid="sidebar-routing-btn"]', { timeout: 5000 });
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll('[data-action="switch-project"]')).some((row) =>
            (row.textContent ?? "").includes("deepmdt-frontend-pc"),
          ),
        { timeout: 5000 },
      );
      await Bun.sleep(150);

      const metrics = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('[data-action="switch-project"]'));
        const remoteRow = rows.find((row) => (row.textContent ?? "").includes("deepmdt-frontend-pc"));
        const badge = remoteRow?.querySelector(".sb-item-badges .sb-badge") as HTMLElement | null;
        const projectName = remoteRow?.querySelector(".sb-item-name") as HTMLElement | null;
        const routingBtn = document.querySelector('[data-testid="sidebar-routing-btn"]') as HTMLElement | null;
        const routingHead = routingBtn?.closest(".sb-head") as HTMLElement | null;
        const routingTitle = routingHead?.querySelector("span") as HTMLElement | null;
        const height = (el: HTMLElement | null) => (el ? el.getBoundingClientRect().height : -1);
        return {
          badgeText: badge?.textContent ?? "",
          badgeHeight: height(badge),
          projectNameHeight: height(projectName),
          routingBtnHeight: height(routingBtn),
          routingTitleText: routingTitle?.textContent ?? "",
          routingTitleHeight: height(routingTitle),
        };
      });

      // 远程节点徽标单行（离线节点场景，修复前为两行 35px）。
      expect(metrics.badgeText).toContain("Windows WSL2");
      expect(metrics.badgeHeight).toBeGreaterThan(0);
      expect(metrics.badgeHeight).toBeLessThanOrEqual(24);
      // 项目名继续单行省略，不被徽标挤压换行。
      expect(metrics.projectNameHeight).toBeLessThanOrEqual(24);
      // 路由区头标题含长节点后缀仍单行（修复前两行 35px）。
      expect(metrics.routingTitleText).toContain("Windows WSL2");
      expect(metrics.routingTitleHeight).toBeLessThanOrEqual(24);
      // 配置按钮图标与文本单行横排（修复前逐字竖排 46px）。
      expect(metrics.routingBtnHeight).toBeGreaterThan(0);
      expect(metrics.routingBtnHeight).toBeLessThanOrEqual(32);

      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

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
      await page.select('[data-testid="ui-language-select"]', lang);
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
            document.querySelectorAll(`[data-testid="${tid}"] .modal-actions button`),
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
        "Awaiting approval",
      );

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
        "待批准",
      );
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
      await clickReady(page, '[data-testid="open-quick-report-btn"]');
      await page.waitForSelector('[data-testid="quick-report-modal"]', { timeout: 5000 });
      expect(await bodyText()).toContain("随手报修与自进化反馈");
      expect(await bodyText()).toContain("UI 异常 / 布局交互问题");
      await clickModalAction("quick-report-modal", "取消");
      await page.waitForFunction(() => !document.querySelector('[data-testid="quick-report-modal"]'), {
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
          () => (document.querySelector('[data-testid="project-output-language-select"]') as HTMLSelectElement | null)?.value,
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
          Array.from(document.querySelectorAll("[data-sonner-toast]")).some((el) =>
            (el.textContent ?? "").includes("Invalid Git branch name"),
          ),
        { timeout: 10_000 },
      );
      const branchToast = await page.evaluate(
        () =>
          Array.from(document.querySelectorAll("[data-sonner-toast]"))
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
          Array.from(document.querySelectorAll("[data-sonner-toast]")).some((el) =>
            (el.textContent ?? "").includes("Invalid GitHub repository slug"),
          ),
        { timeout: 10_000 },
      );
      const repoToast = await page.evaluate(
        () =>
          Array.from(document.querySelectorAll("[data-sonner-toast]"))
            .map((el) => el.textContent ?? "")
            .find((txt) => txt.includes("Invalid GitHub repository slug")) ?? "",
      );
      expect(/[\u4e00-\u9fff]/.test(repoToast)).toBe(false);
      await selectLang("zh-CN");
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll("[data-sonner-toast]")).some((el) =>
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
          Array.from(document.querySelectorAll("[data-sonner-toast]")).some((el) =>
            (el.textContent ?? "").includes("Please enter a valid GitHub Issue number"),
          ),
        { timeout: 10_000 },
      );
      const ghImportToast = await page.evaluate(
        () =>
          Array.from(document.querySelectorAll("[data-sonner-toast]"))
            .map((el) => el.textContent ?? "")
            .find((txt) => txt.includes("Please enter a valid GitHub Issue number")) ?? "",
      );
      expect(/[\u4e00-\u9fff]/.test(ghImportToast)).toBe(false);
      await clickModalAction("new-req-modal", "Cancel");
      await page.waitForFunction(() => !document.querySelector('[data-testid="new-req-modal"]'), { timeout: 5000 });
      await clickReady(page, '[data-testid="open-quick-report-btn"]');
      await page.waitForSelector('[data-testid="quick-report-modal"]', { timeout: 5000 });
      expect(await bodyText()).toContain("Quick report & self-evolution feedback");
      expect(await bodyText()).toContain("UI anomaly / layout interaction");
      await clickModalAction("quick-report-modal", "Cancel");
      await page.waitForFunction(() => !document.querySelector('[data-testid="quick-report-modal"]'), { timeout: 5000 });
      expect(await readDocumentLanguages()).toEqual(docLanguagesBefore);

      // 9. 客户端错误反馈在英文界面下本地化。
      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="tab-changes"]', { timeout: 5000 });
      await page.click('[data-testid="tab-changes"]');
      await clickReady(page, '[data-testid="manual-verify-btn"]');
      await page.waitForFunction(
        () =>
          (document.querySelector("[data-sonner-toast]")?.textContent ?? "").includes(
            "Enter a verification command first",
          ),
        { timeout: 5000 },
      );
      // 9b. 已显示的即时错误提示随语言切换重新渲染为当前语言。
      await selectLang("zh-CN");
      await page.waitForFunction(
        () =>
          (document.querySelector("[data-sonner-toast]")?.textContent ?? "").includes(
            "请先输入验证命令",
          ),
        { timeout: 5000 },
      );
      await selectLang("en");
      await page.waitForFunction(
        () =>
          (document.querySelector("[data-sonner-toast]")?.textContent ?? "").includes(
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
            (document.querySelector("[data-sonner-toast]")?.textContent ?? "").includes(
              "does not exist",
            ),
          { timeout: 5000 },
        );
        await selectLang("zh-CN");
        await page.waitForFunction(
          () =>
            (document.querySelector("[data-sonner-toast]")?.textContent ?? "").includes(
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
      await page.select('[data-testid="ui-language-select"]', "zh-CN");
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
        await blockedPage.select('[data-testid="ui-language-select"]', "en");
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
  }, 60_000);

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
        () => {
          const drawer = document.querySelector('[data-testid="right-drawer"]');
          const input = drawer?.querySelector('[data-testid="drawer-diff-file-search"]') as HTMLElement | null;
          return Boolean(
            drawer?.classList.contains("open") &&
            input &&
            getComputedStyle(input).visibility === "visible" &&
            getComputedStyle(input).pointerEvents !== "none" &&
            input.getBoundingClientRect().width > 0,
          );
        },
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
