import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequirement, initProject, propose } from "../../src/core/engine.ts";
import { HubExecutor } from "../../src/hub/executor.ts";
import { executeWorkbenchTool } from "../../src/mcp/tools.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";

const CHROME_PATH = "/home/jackie/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome";
const PUPPETEER_PATH = "/home/jackie/.bun/install/global/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js";
const HAS_BROWSER = fs.existsSync(CHROME_PATH) && fs.existsSync(PUPPETEER_PATH);

interface BrowserPage {
  setViewport(vp: { width: number; height: number }): Promise<void>;
  goto(url: string, opts?: { waitUntil?: string }): Promise<unknown>;
  waitForSelector(sel: string, opts?: { timeout?: number }): Promise<unknown>;
  waitForFunction(fn: string | ((...args: unknown[]) => boolean), opts?: { timeout?: number }, ...args: unknown[]): Promise<unknown>;
  click(sel: string): Promise<void>;
  type(sel: string, text: string): Promise<void>;
  evaluate<T>(fn: (...args: any[]) => T, ...args: any[]): Promise<T>;
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
  if (!HAS_BROWSER) return;
  const mod = (await import(PUPPETEER_PATH)) as {
    default: { launch(opts: Record<string, unknown>): Promise<BrowserInstance> };
  };
  browser = await mod.default.launch({
    executablePath: CHROME_PATH,
    headless: true,
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
      await page.click('[data-action="refresh"]');
      await page.waitForFunction(() => document.querySelectorAll(".req-row").length === 22, { timeout: 5000 });

      // Verify zero UUID/SHA/disclaimer noise on home screen
      const homeText = await page.evaluate(() => document.body.innerText);
      expect(homeText).not.toMatch(/[0-9a-f]{32,}/i);
      expect(homeText).not.toContain("revision");
      expect(homeText).not.toContain("sha256");

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
      await page.click('[data-action="refresh"]');
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

      // 2. Routing Center: switch preset + add custom model + save
      await clickReady(page, '[data-testid="open-routing-btn"]');
      await page.waitForSelector('[data-testid="routing-modal"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="preset-quota_saver"]');
      await page.type('[data-testid="custom-model-input"]', "opencode-go/my-pro");
      await clickReady(page, '[data-testid="add-custom-model-btn"]');
      await clickReady(page, '[data-testid="save-routing-btn"]');
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

      // Approve only -> trigger live model execution + cross-model review
      await clickReady(page, '[data-testid="action-approve_only"]');
      await page.waitForSelector('[data-testid="run-review-btn"]', { timeout: 5000 });
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
});
