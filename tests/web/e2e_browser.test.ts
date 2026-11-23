import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { approveDesign, createRequirement, initProject, propose } from "../../src/core/engine.ts";
import { HubExecutor } from "../../src/hub/executor.ts";
import { applyHubRoutingPreset, registerHubProject } from "../../src/hub/registry.ts";
import { recordModelRunOutcome } from "../../src/hub/telemetry.ts";
import { executeWorkbenchTool } from "../../src/mcp/tools.ts";
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
});
