import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { approveDesign, cancelRequirement, createRequirement, initProject, propose } from "../../src/core/engine.ts";
import { resolveCodeRoot } from "../../src/core/sandbox.ts";
import { HubExecutor } from "../../src/hub/executor.ts";
import { readHubConfig, registerHubProject } from "../../src/hub/registry.ts";
import { executeWorkbenchTool } from "../../src/mcp/tools.ts";
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
import { selectUiOption } from "./coss_select_helper.ts";

const tempDirs: string[] = [];
const servers: WorkbenchServerHandle[] = [];
const origHubDir = process.env.WORKBENCH_HUB_DIR;
let browser: BrowserInstance | null = null;
const initGitRepo = () => initGitRepoIn(tempDirs);

async function measureControlRow(
  page: BrowserPage,
  selectors: string[],
): Promise<Array<{ selector: string; height: number; singleLine: boolean }>> {
  return page.evaluate((items: string[]) =>
    items.map((selector) => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) return { selector, height: -1, singleLine: false };
      const rect = el.getBoundingClientRect();
      return {
        selector,
        height: rect.height,
        singleLine: el.scrollWidth <= el.clientWidth + 1,
      };
    }),
  selectors);
}

async function expectControlsAligned(page: BrowserPage, selectors: string[], expectedHeight?: number): Promise<void> {
  const controls = await measureControlRow(page, selectors);
  for (const control of controls) {
    expect(control.height, `${control.selector} must be rendered`).toBeGreaterThan(0);
    expect(control.singleLine, `${control.selector} must stay on one line`).toBe(true);
    if (expectedHeight !== undefined) {
      expect(Math.abs(control.height - expectedHeight), `${control.selector} height`).toBeLessThanOrEqual(1);
    }
  }
  const heights = controls.map((control) => control.height);
  expect(Math.max(...heights) - Math.min(...heights), `${selectors.join(", ")} must share one height`).toBeLessThanOrEqual(1);
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
      expect(subText).toBe("规划中"); // 仅徽章一次，无重复进度文本

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
  }, 90_000);

  test("WB-06: completes Plan-First and Fast-Track end-to-end loops with real Agent tools, Git diff, stale gate, and acceptance", async () => {
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-e2e-wb06-hub-"));
    tempDirs.push(hubDir);
    process.env.WORKBENCH_HUB_DIR = hubDir;
    const root = initGitRepo();
    const executor = new HubExecutor({
      initialHarnesses: [
        {
          id: "qodercn",
          label: "QoderCN",
          subscription: "QoderCN",
          installed: true,
          executable: "qodercn",
          models: [{ id: "Qwen4-Max", tier: "balanced", source: "detected" }],
          defaultModel: "Qwen4-Max",
          detectedAt: Date.now(),
        },
      ],
      commandBuilder: () => ({ command: "bash", args: ["-c", "echo ok"], displayCommand: "wb06-mock" }),
    });
    const server = await startWorkbenchServer({ root, port: 0, writeDiscovery: false, executor });
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
      await page.waitForFunction(() => !document.querySelector('[data-slot="toast-root"]'), { timeout: 15000 });
      await clickReady(page, '[data-action="toggle-design-diff"]', 10000);
      await page.waitForSelector(".diff-code", { timeout: 10000 });
      const diffHtml = await page.evaluate(() => document.querySelector(".diff-code")?.textContent ?? "");
      expect(diffHtml).toContain("初步实现");
      expect(diffHtml).toContain("导出");
      await page.click('[data-action="toggle-design-diff"]');

      // Approve design and transition to coding stage
      await clickReady(page, '[data-testid="action-approve_only"]');
      await page.waitForFunction(
        () => Boolean(document.querySelector('[data-testid="ws-stage-badge"]')?.textContent?.includes("研发中")),
        { timeout: 5000 },
      );

      // Agent implements code inside the active codeRoot (auto-isolated worktree sandbox) and runs verification
      const req1CodeRoot = resolveCodeRoot(root, "REQ-001");
      fs.writeFileSync(
        path.join(req1CodeRoot, "calc.ts"),
        "export const add = (a: number, b: number) => a + b;\nexport const sub = (a: number, b: number) => a - b;\n",
      );
      await executeWorkbenchTool(root, "wb_verify", {
        id: "REQ-001",
        command: "bun -e 'import { sub } from \"./calc.ts\"; if (sub(5,2)!==3) process.exit(1)'",
        criterionIds: ["AC-1"],
      });

      await page.waitForSelector('[data-testid="action-accept"]', { timeout: 5000 });

      // Inspect Code Changes tab (split/unified/expand + isolated drawer) and Verify & Shots tab (shortcut + log)
      await page.click('[data-testid="tab-diff"]');
      await page.waitForSelector('[data-testid="diff-viewer-panel"] .diff-code', { timeout: 5000 });
      const gitDiffText = await page.evaluate(() => document.querySelector('[data-testid="diff-viewer-panel"] .diff-code')?.textContent ?? "");
      expect(gitDiffText).toContain("export const sub");
      // REQ-015: 需求详情「更多」按钮与 Diff 工具栏紧凑控件统一为 28px 单行。
      await expectControlsAligned(page, ['[data-testid="more-menu-btn"]'], 28);
      await expectControlsAligned(
        page,
        [
          '[data-testid="diff-view-mode-toggle"]',
          '[data-testid="diff-expand-height-btn"]',
          '[data-testid="dock-diff-to-drawer-btn"]',
        ],
        28,
      );
      await clickReady(page, '[data-testid="diff-view-mode-toggle"] [role="radio"]:nth-of-type(2)');
      await page.waitForSelector('[data-testid="diff-unified-list"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="diff-expand-height-btn"]');
      expect(
        await page.evaluate(() => document.querySelector('[data-testid="diff-unified-list"]')?.classList.contains("expanded")),
      ).toBe(true);
      await clickReady(page, '[data-testid="diff-expand-height-btn"]');
      await clickReady(page, '[data-testid="diff-view-mode-toggle"] [role="radio"]:nth-of-type(1)');

      await clickReady(page, '[data-testid="dock-diff-to-drawer-btn"]');
      await page.waitForSelector('[data-testid="drawer-diff-pane"]', { timeout: 5000 });
      expect(await page.evaluate(() => document.querySelectorAll('[data-testid="diff-view-mode-toggle"]').length)).toBe(1);
      expect(await page.evaluate(() => document.querySelectorAll('[data-testid="drawer-diff-view-mode-toggle"]').length)).toBe(1);
      await clickReady(page, '[data-testid="toggle-drawer-btn"]');
      await page.waitForSelector('[data-testid="toggle-drawer-btn"][aria-expanded="false"]', { timeout: 5000 });

      await clickReady(page, '[data-testid="tab-changes"]');
      await page.waitForSelector('[data-testid="verify-diff-shortcut-card"]', { timeout: 10000 });
      // REQ-015: 手动验证命令输入、条件输入与运行按钮严格等高 32px 且单行。
      await expectControlsAligned(
        page,
        [
          '[data-slot="input-control"]:has(#manual-verify-cmd)',
          '[data-slot="input-control"]:has(#manual-verify-criteria)',
          '[data-testid="manual-verify-btn"]',
        ],
        32,
      );
      // REQ-015 审查修复：窄屏证据卡片信息区保留弹性基准，长命令可在任意位置换行，操作组另起一行。
      await page.waitForSelector(".evidence-card", { timeout: 5000 });
      await page.setViewport({ width: 390, height: 844 });
      await Bun.sleep(150);
      const narrowEvidence = await page.evaluate(() => {
        const rect = (el: HTMLElement | null) => {
          if (!el) return { left: -1, right: -1, top: -1, bottom: -1, width: -1, height: -1 };
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
        };
        const head = document.querySelector(".evidence-head") as HTMLElement | null;
        const info = head?.querySelector(".evidence-info") as HTMLElement | null;
        const actions = head?.querySelector(".evidence-actions") as HTMLElement | null;
        const command = head?.querySelector(".evidence-command") as HTMLElement | null;
        const commandStyle = command ? getComputedStyle(command) : null;
        return {
          head: rect(head),
          info: rect(info),
          actions: rect(actions),
          command: rect(command),
          headOverflow: head ? head.scrollWidth - head.clientWidth : -1,
          infoOverflow: info ? info.scrollWidth - info.clientWidth : -1,
          commandOverflow: command ? command.scrollWidth - command.clientWidth : -1,
          commandOverflowWrap: commandStyle?.overflowWrap ?? "",
        };
      });
      expect(narrowEvidence.headOverflow).toBeLessThanOrEqual(1);
      expect(narrowEvidence.infoOverflow).toBeLessThanOrEqual(1);
      expect(narrowEvidence.commandOverflow).toBeLessThanOrEqual(1);
      expect(narrowEvidence.command.right).toBeLessThanOrEqual(narrowEvidence.info.right + 1);
      expect(narrowEvidence.commandOverflowWrap).toBe("anywhere");
      const evidenceActionsSeparated =
        narrowEvidence.actions.left >= narrowEvidence.info.right - 1 ||
        narrowEvidence.actions.top >= narrowEvidence.info.bottom - 1;
      expect(evidenceActionsSeparated).toBe(true);
      expect(narrowEvidence.actions.right).toBeLessThanOrEqual(narrowEvidence.head.right + 1);
      await page.setViewport({ width: 1280, height: 860 });
      await Bun.sleep(150);
      await page.click('[data-action="toggle-log"]');
      await page.waitForSelector(".evidence-log", { timeout: 5000 });

      // Edit code behind the scenes -> live stale detection disables immediate acceptance!
      fs.appendFileSync(path.join(req1CodeRoot, "calc.ts"), "// post-verify edit\n");
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

      // Authorize fast-track with zero criteria -> wait for initial run to settle, verify cannot accept (0/0 blocked!)
      const firstRunFinished = new Promise<void>((resolve) => {
        const unsub = executor.subscribe((ev) => {
          if (ev.type === "agent.run.finished" && ev.requirementId === "REQ-002") {
            unsub();
            resolve();
          }
        });
      });
      await page.click('[data-testid="action-authorize_fast_track"]');
      await firstRunFinished;
      await page.waitForFunction(
        () =>
          Boolean(document.querySelector('[data-testid="ws-stage-badge"]')?.textContent?.includes("研发中")) &&
          !document.querySelector('[data-testid="live-agent-banner"]'),
        { timeout: 5000 },
      );
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
      const secondRunFinished = new Promise<void>((resolve) => {
        const unsub = executor.subscribe((ev) => {
          if (ev.type === "agent.run.finished" && ev.requirementId === "REQ-002") {
            unsub();
            resolve();
          }
        });
      });
      await clickReady(page, '[data-testid="action-authorize_fast_track"]');
      await secondRunFinished;
      await page.waitForFunction(() => !document.querySelector('[data-testid="live-agent-banner"]'), { timeout: 5000 });
      await clickReady(page, '[data-testid="action-run_all_verifications"]');
      await clickReady(page, '[data-testid="action-accept"]');
      await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="ws-stage-badge"]')?.textContent?.includes("已完成")), { timeout: 5000 });

      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 90_000);

  test("Hub project pin feedback and active requirement empty states", async () => {
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-e2e-project-nav-"));
    tempDirs.push(hubDir);
    process.env.WORKBENCH_HUB_DIR = hubDir;

    const activeRoot = initGitRepo();
    const historyRoot = initGitRepo();
    const emptyRoot = initGitRepo();
    await initProject(activeRoot, { name: "Alpha", privacyMode: "local" });
    await initProject(historyRoot, { name: "History", privacyMode: "local" });
    await initProject(emptyRoot, { name: "Zulu", privacyMode: "local" });
    const activeReq = await createRequirement(activeRoot, { goal: "Active goal" });
    const historyReq = await createRequirement(historyRoot, { goal: "Historical goal" });
    await cancelRequirement(historyRoot, historyReq.state.id, { reason: "Kept for reference" });
    const active = registerHubProject(activeRoot).project;
    const history = registerHubProject(historyRoot, { activate: false }).project;
    const empty = registerHubProject(emptyRoot, { activate: false }).project;

    const server = await startWorkbenchServer({ root: activeRoot, port: 0, writeDiscovery: false, hubMode: true });
    servers.push(server);
    const page = await browser!.newPage();
    type ProjectNavTestWindow = Window & {
      __wbReleasePin?: (ok: boolean) => void;
      __wbReleaseRequirements?: () => void;
    };
    const pin = `[data-testid="pin-project-${history.id}"]`;
    const project = (id: string) => `[data-testid="hub-project-${id}"]`;
    const activeTab = '[data-action="set-scope"][data-value="active"]';
    const allTab = '[data-action="set-scope"][data-value="all"]';
    const emptyState = '[data-testid="empty-state"]';
    const newButton = '[data-testid="empty-new-req-btn"]';
    const viewAll = '[data-testid="empty-view-all-req-btn"]';
    const workspace = '[data-testid="workspace-detail"]';
    const order = () => page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="hub-project-list"] [data-action="switch-project"]'))
        .map((el) => el.getAttribute("data-id")),
    );
    const star = () => page.evaluate((selector: string) => {
      const style = getComputedStyle(document.querySelector(`${selector} svg`)!);
      return { fill: style.fill, stroke: style.stroke };
    }, pin);
    const releasePin = async (ok: boolean) => {
      await page.waitForFunction(() => Boolean((window as ProjectNavTestWindow).__wbReleasePin));
      await page.evaluate((saved: boolean) => {
        const w = window as ProjectNavTestWindow;
        const release = w.__wbReleasePin!;
        delete w.__wbReleasePin;
        release(saved);
      }, ok);
    };

    try {
      await page.evaluateOnNewDocument((historyId: string) => {
        const w = window as ProjectNavTestWindow;
        const realFetch = w.fetch.bind(w);
        w.fetch = async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input), location.href);
          if (url.pathname === "/api/hub/projects/meta") {
            const ok = await new Promise<boolean>((resolve) => { w.__wbReleasePin = resolve; });
            if (!ok) return Response.json({ error: "Pin write failed" }, { status: 500 });
          }
          if (
            url.pathname === "/api/requirements" &&
            url.searchParams.get("project") === historyId &&
            url.searchParams.get("scope") === "all" &&
            !w.__wbReleaseRequirements
          ) {
            await new Promise<void>((resolve) => { w.__wbReleaseRequirements = resolve; });
          }
          return realFetch(input, init);
        };
      }, history.id);
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await page.waitForSelector(workspace);
      await page.waitForSelector(`[data-testid="req-row-${activeReq.state.id}"]`);
      await selectUiOption(page, '[data-testid="project-group-select"]', "none");
      await selectUiOption(page, '[data-testid="project-sort-select"]', "name");
      const initialOrder = [active.id, history.id, empty.id];
      expect(await order()).toEqual(initialOrder);
      const initialStar = await star();
      expect(initialStar.fill).toBe("none");

      await clickReady(page, pin);
      await page.waitForSelector(`${pin}[aria-busy="true"][aria-pressed="true"]`);
      const filledStar = await star();
      expect(filledStar.fill).toBe(filledStar.stroke);
      expect(filledStar.stroke).not.toBe(initialStar.stroke);
      expect(await order()).toEqual(initialOrder);
      await page.click(pin); // A second press while saving must not switch to the project row.
      expect(await page.evaluate((selector: string) => document.querySelector(selector)?.classList.contains("active"), project(active.id))).toBe(true);
      await releasePin(false);
      await page.waitForSelector(`${pin}:not([aria-busy])[aria-pressed="false"]`);
      await page.waitForFunction(() => Boolean(document.querySelector('[data-slot="toast-title"]')?.textContent?.includes("置顶失败")));
      expect(await star()).toEqual(initialStar);
      expect(await order()).toEqual(initialOrder);

      await clickReady(page, pin);
      await page.waitForSelector(`${pin}[aria-busy="true"][aria-pressed="true"]`);
      await releasePin(true);
      await page.waitForSelector(`${pin}:not([aria-busy])[aria-pressed="true"]`);
      expect(await order()).toEqual([history.id, active.id, empty.id]);
      expect(readHubConfig().projects.find((item) => item.id === history.id)?.pinned).toBe(true);
      await clickReady(page, pin);
      await page.waitForSelector(`${pin}[aria-busy="true"][aria-pressed="false"]`);
      expect(await star()).toEqual(initialStar);
      expect(await order()).toEqual([history.id, active.id, empty.id]);
      await releasePin(true);
      await page.waitForSelector(`${pin}:not([aria-busy])[aria-pressed="false"]`);
      expect(await order()).toEqual(initialOrder);

      await clickReady(page, project(history.id));
      await page.waitForFunction(() => Boolean((window as ProjectNavTestWindow).__wbReleaseRequirements));
      await page.waitForSelector('.main-stage [role="status"]');
      expect(await page.evaluate((selector: string) => document.querySelector(selector), emptyState)).toBeNull();
      await page.evaluate(() => (window as ProjectNavTestWindow).__wbReleaseRequirements!());
      await page.waitForSelector(`${activeTab}[aria-checked="true"]`);
      await page.waitForSelector(viewAll);
      expect(await page.evaluate((selector: string) => document.querySelector(selector)?.textContent, emptyState)).toContain("暂无活跃需求");
      expect(await page.evaluate((selector: string) => document.querySelector(selector)?.textContent?.trim(), newButton)).toBe("新建需求");
      expect(await page.evaluate((selector: string) => document.querySelector(selector), workspace)).toBeNull();
      await clickReady(page, newButton);
      await page.waitForSelector('[data-testid="new-req-goal"]');
      await page.keyboard.press("Escape");

      await clickReady(page, viewAll);
      await page.waitForSelector(`${allTab}[aria-checked="true"]`);
      await clickReady(page, `[data-testid="req-row-${historyReq.state.id}"]`);
      await page.waitForSelector(workspace);
      await clickReady(page, activeTab);
      await clickReady(page, project(empty.id));
      await page.waitForSelector(newButton);
      await page.waitForSelector(`${activeTab}[aria-checked="true"]`);
      expect(await page.evaluate((selector: string) => document.querySelector(selector)?.textContent?.trim(), newButton)).toBe("新建第一条需求");
      expect(await page.evaluate((selector: string) => document.querySelector(selector), viewAll)).toBeNull();
    } finally {
      await page.close();
    }
  }, 20_000);

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
            {
              id: "gpt-6.2-xhigh-locked-variant-with-extra-long-name",
              label: "GPT-6.2 XHigh 锁定超长变体名称",
              tier: "sota",
              source: "detected",
              supportedEfforts: ["xhigh"],
              defaultEffort: "xhigh",
              effortLocked: true,
            },
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
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, p);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, repoB);
      await clickReady(page, '[data-testid="browse-go-btn"]');
      await page.waitForFunction(
        (expected: unknown) =>
          Boolean(document.querySelector('[data-testid="fs-browse-list"]')?.textContent?.includes(String(expected))),
        { timeout: 5000 },
        repoB,
      );
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
        (id: unknown) => Boolean(document.querySelector(`[data-testid="pin-project-${String(id)}"][aria-pressed="true"]:not([aria-busy])`)),
        { timeout: 5000 },
        alphaId,
      );
      await clickReady(page, `[data-testid="category-project-${alphaId}"]`);
      await page.waitForSelector(`[data-testid="category-input-${alphaId}"]`, { timeout: 5000 });
      await page.type(`[data-testid="category-input-${alphaId}"]`, "核心");
      await clickReady(page, `[data-testid="category-save-${alphaId}"]`);
      await page.waitForSelector(`[data-testid="project-cat-badge-${alphaId}"]`, { timeout: 5000 });
      await selectUiOption(page, '[data-testid="project-sort-select"]', "name");
      await selectUiOption(page, '[data-testid="project-group-select"]', "category");
      await page.waitForSelector('[data-testid="project-group-cat:核心"]', { timeout: 5000 });
      await selectUiOption(page, '[data-testid="project-group-select"]', "none");

      // 1c. Switching between projects does not jump/reorder the sidebar project queue
      const orderBeforeSwitch = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid="hub-project-list"] [data-action="switch-project"]')).map((el) =>
          el.getAttribute("data-id"),
        ),
      );
      const otherId = orderBeforeSwitch.find((id) => id && id !== alphaId)!;
      await selectUiOption(page, '[data-testid="project-sort-select"]', "recent");
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
      await selectUiOption(page, '[data-testid="project-sort-select"]', "attention");
      await clickReady(page, `[data-testid="hub-project-${alphaId}"]`);
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 5000 });

      // 2. Routing Center: hub/project preferences + 3-role routing + effort + save
      await clickReady(page, '[data-testid="open-routing-btn"]');
      await page.waitForSelector('[data-testid="routing-modal"]', { timeout: 5000 });
      expect(await page.evaluate(() => Boolean(document.querySelector('[data-testid="custom-model-input"]')))).toBe(false);
      await clickReady(page, '[data-testid="settings-tab-project"]');
      await page.waitForSelector('[data-testid="hub-output-language-select"]', { timeout: 5000 });
      await selectUiOption(page, '[data-testid="hub-output-language-select"]', "en");
      await page.waitForSelector('[data-testid="project-github-repo-input"]', { timeout: 5000 });
      const inheritLabel = await page.evaluate(
        () =>
          document.querySelector('[data-testid="project-output-language-select"]')?.textContent ?? "",
      );
      expect(inheritLabel).toContain("当前：zh-CN"); // 已持久化的全局语言，而非未保存草稿
      await selectUiOption(page, '[data-testid="hub-output-language-select"]', "zh-CN");
      await clickReady(page, '[data-testid="settings-tab-routing"]');
      // REQ-015 审查修复：长模型名在路由选择器中内部省略，锁定推理强度标签保持 28px 单行且悬浮提示展示完整值。
      await page.select('[data-testid="route-select-defaultLead"]', "codex::gpt-6.2-xhigh-locked-variant-with-extra-long-name");
      await page.waitForSelector('[data-testid="route-effort-defaultLead-locked"]', { timeout: 5000 });
      const lockedEffortMetrics = await page.evaluate(() => {
        const picker = document.querySelector('[data-testid="route-select-defaultLead-trigger"]') as HTMLElement | null;
        const pickerText = picker?.querySelector(".truncate") as HTMLElement | null;
        const locked = document.querySelector('[data-testid="route-effort-defaultLead-locked"]') as HTMLElement | null;
        const lockedText = locked?.querySelector(".truncate") as HTMLElement | null;
        const pickerStyle = picker ? getComputedStyle(picker) : null;
        const lockedTextStyle = lockedText ? getComputedStyle(lockedText) : null;
        return {
          pickerHeight: picker?.getBoundingClientRect().height ?? -1,
          pickerFlexShrink: pickerStyle?.flexShrink ?? "",
          pickerMinWidth: pickerStyle?.minWidth ?? "",
          pickerTextTruncated: pickerText ? pickerText.scrollWidth > pickerText.clientWidth : false,
          lockedHeight: locked?.getBoundingClientRect().height ?? -1,
          lockedWhiteSpace: lockedTextStyle?.whiteSpace ?? "",
          lockedTextOverflow: lockedTextStyle?.textOverflow ?? "",
          lockedVerticalOverflow: locked ? locked.scrollHeight > locked.clientHeight + 1 : true,
          lockedTitle: locked?.getAttribute("title") ?? "",
        };
      });
      expect(lockedEffortMetrics.pickerFlexShrink).toBe("1");
      expect(lockedEffortMetrics.pickerMinWidth).toBe("0px");
      expect(lockedEffortMetrics.pickerHeight).toBeLessThanOrEqual(29);
      expect(lockedEffortMetrics.pickerTextTruncated).toBe(true);
      expect(Math.abs(lockedEffortMetrics.lockedHeight - 28)).toBeLessThanOrEqual(1);
      expect(lockedEffortMetrics.lockedWhiteSpace).toBe("nowrap");
      expect(lockedEffortMetrics.lockedTextOverflow).toBe("ellipsis");
      expect(lockedEffortMetrics.lockedVerticalOverflow).toBe(false);
      expect(lockedEffortMetrics.lockedTitle).toContain("XHigh (极高)");
      await page.select('[data-testid="route-select-defaultLead"]', "qodercn::Qwen4-Max");
      await selectUiOption(page, '[data-testid="route-effort-defaultLead"]', "xhigh");
      await clickReady(page, '[data-testid="save-routing-btn"]');
      await page.waitForFunction(() => !document.querySelector('[data-testid="routing-modal"]'), { timeout: 5000 });

      // Reopen immediately and verify saved routing/effort persisted, then customize model+effort, save, reopen & reload
      await clickReady(page, '[data-testid="open-routing-btn"]');
      await page.waitForSelector('[data-testid="routing-modal"]', { timeout: 5000 });
      const firstReopen = await page.evaluate(() => ({
        defaultLeadModel: (document.querySelector('[data-testid="route-select-defaultLead"]') as HTMLSelectElement)?.value,
        defaultLeadEffort: document.querySelector('[data-testid="route-effort-defaultLead"]')?.getAttribute("data-value") ?? "",
      }));
      expect(firstReopen).toEqual({ defaultLeadModel: "qodercn::Qwen4-Max", defaultLeadEffort: "xhigh" });

      await page.select('[data-testid="route-select-defaultLead"]', "codex::gpt-6-astra");
      await selectUiOption(page, '[data-testid="route-effort-defaultLead"]', "high");
      await page.select('[data-testid="route-select-sotaLead"]', "opencode::opencode/deepseek-v4.1-flash-free");
      await selectUiOption(page, '[data-testid="route-effort-sotaLead"]', "medium");
      await clickReady(page, '[data-testid="save-routing-btn"]');
      await page.waitForFunction(() => !document.querySelector('[data-testid="routing-modal"]'), { timeout: 5000 });

      await clickReady(page, '[data-testid="open-routing-btn"]');
      await page.waitForSelector('[data-testid="routing-modal"]', { timeout: 5000 });
      const secondReopen = await page.evaluate(() => ({
        defaultLeadModel: (document.querySelector('[data-testid="route-select-defaultLead"]') as HTMLSelectElement)?.value,
        defaultLeadEffort: document.querySelector('[data-testid="route-effort-defaultLead"]')?.getAttribute("data-value") ?? "",
        sotaLeadModel: (document.querySelector('[data-testid="route-select-sotaLead"]') as HTMLSelectElement)?.value,
        sotaLeadEffort: document.querySelector('[data-testid="route-effort-sotaLead"]')?.getAttribute("data-value") ?? "",
      }));
      expect(secondReopen).toEqual({
        defaultLeadModel: "codex::gpt-6-astra",
        defaultLeadEffort: "high",
        sotaLeadModel: "opencode::opencode/deepseek-v4.1-flash-free",
        sotaLeadEffort: "medium",
      });

      await page.goto(server.url, { waitUntil: "networkidle0" });
      await clickReady(page, `[data-testid="hub-project-${alphaId}"]`);
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="open-routing-btn"]');
      await page.waitForSelector('[data-testid="routing-modal"]', { timeout: 5000 });
      const afterReload = await page.evaluate(() => ({
        defaultLeadModel: (document.querySelector('[data-testid="route-select-defaultLead"]') as HTMLSelectElement)?.value,
        defaultLeadEffort: document.querySelector('[data-testid="route-effort-defaultLead"]')?.getAttribute("data-value") ?? "",
        sotaLeadModel: (document.querySelector('[data-testid="route-select-sotaLead"]') as HTMLSelectElement)?.value,
        sotaLeadEffort: document.querySelector('[data-testid="route-effort-sotaLead"]')?.getAttribute("data-value") ?? "",
      }));
      expect(afterReload).toEqual(secondReopen);
      await clickReady(page, '[data-testid="routing-modal"] [data-slot="dialog-footer"] button:not([data-testid])');
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
        { timeout: 15000 },
      );
      const stageAfterAsk = await page.evaluate(() => document.querySelector('[data-testid="ws-stage-badge"]')?.textContent ?? "");
      const derivedAfterAsk = await page.evaluate(
        () => document.querySelector('[data-testid="ws-derived-status-badge"]')?.textContent ?? "",
      );
      expect(stageAfterAsk).toContain("规划中");
      expect(derivedAfterAsk).toContain("待批准");

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
      // REQ-015 审查修复：模型触发按钮的收缩规则必须高于基础 .btn，才能在窄行内省略长模型名。
      const bannerRunnerMetrics = await page.evaluate(() => {
        const trigger = document.querySelector('[data-testid="banner-runner-select-trigger"]') as HTMLElement | null;
        const style = trigger ? getComputedStyle(trigger) : null;
        return {
          flexShrink: style?.flexShrink ?? "",
          minWidth: style?.minWidth ?? "",
          height: trigger?.getBoundingClientRect().height ?? -1,
        };
      });
      expect(bannerRunnerMetrics.flexShrink).toBe("1");
      expect(bannerRunnerMetrics.minWidth).toBe("0px");
      expect(Math.abs(bannerRunnerMetrics.height - 28)).toBeLessThanOrEqual(1);
      // REQ-015: 阶段横幅内模型触发器、推理强度下拉与运行/审查按钮严格等高 28px 且单行。
      await expectControlsAligned(
        page,
        [
          '[data-testid="banner-runner-select-trigger"]',
          '[data-testid="banner-runner-select-effort"]',
          '[data-testid="run-selected-model-btn"]',
          '[data-testid="run-review-btn"]',
        ],
        28,
      );
      await selectUiOption(page, '[data-testid="banner-runner-select-effort"]', "high");
      await clickReady(page, '[data-testid="run-selected-model-btn"]');
      // Auto-review may chain immediately after `implement`, switching the drawer to the review run's stream.
      await page.waitForFunction(
        () => {
          const text = document.querySelector('[data-testid="console-log-output"]')?.textContent ?? "";
          return (
            text.includes("model run finished ok") ||
            text.includes("审查完成") ||
            Boolean(document.querySelector('[data-testid="review-report-card"]')?.textContent?.includes("跨模型审查通过"))
          );
        },
        { timeout: 15000 },
      );

      if (
        await page.evaluate(
          () => !document.querySelector('[data-testid="review-report-card"]')?.textContent?.includes("跨模型审查通过"),
        )
      ) {
        const canManualReview = await page.evaluate(() =>
          Boolean(document.querySelector('[data-testid="run-review-btn"]:not([disabled])')),
        );
        if (canManualReview) {
          await clickReady(page, '[data-testid="run-review-btn"]');
        }
      }
      await page.waitForFunction(
        () =>
          Boolean(document.querySelector('[data-testid="review-report-card"]')?.textContent?.includes("跨模型审查通过")) &&
          !document.querySelector('[data-testid="live-agent-banner"]'),
        { timeout: 15000 },
      );

      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 90_000);

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
        const buttons = Array.from(document.querySelectorAll('[data-testid="more-menu"] [role="menuitem"]'));
        const target = buttons.find((b) => (b.textContent ?? "").includes(text));
        if (!target) throw new Error(`menu item not found: ${text}`);
        (target as HTMLElement).click();
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

      // 5. 选择菜单项后菜单关闭，且动作正常打开 coss Dialog（交接简报弹窗）。
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

  test("REQ-014: 浮层锚点在重新渲染与反复退出重入期间保持稳定且页面可继续操作", async () => {
    const repo = initGitRepo();
    await initProject(repo, { name: "AnchorStabilityRepo", privacyMode: "local" });
    await createRequirement(repo, {
      goal: "浮层触发节点在无关重新渲染期间保持引用稳定",
      criteria: [{ id: "AC-1", description: "交互可完成", required: true, command: "echo ok" }],
    });

    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false });
    servers.push(server);

    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));
    page.on("console", (msg: { type: () => string; text: () => string }) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    const anchorContains = (anchorSel: string, childSel: string) =>
      page.evaluate(
        (anchor: string, child: string) => {
          const a = document.querySelector(anchor);
          const c = document.querySelector(child);
          return Boolean(a && c && a.contains(c));
        },
        anchorSel,
        childSel,
      );
    const rememberAnchor = (anchorSel: string) =>
      page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        (window as unknown as { __req014Anchor?: Element | null }).__req014Anchor = el;
        return Boolean(el);
      }, anchorSel);
    const anchorStillSame = (anchorSel: string) =>
      page.evaluate((sel: string) => {
        const remembered = (window as unknown as { __req014Anchor?: Element | null }).__req014Anchor;
        return Boolean(remembered && document.querySelector(sel) === remembered);
      }, anchorSel);
    const waitAnchorPlaced = () =>
      page.waitForFunction(
        () => document.querySelector('[data-slot="menu-positioner"][data-side], [data-slot="popover-positioner"][data-side]') !== null,
        { timeout: 5000 },
      );

    try {
      // 与上报现场一致：浅色主题、2514×1348 视口。
      await page.setViewport({ width: 2514, height: 1348 });
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="banner-runner-select-trigger"]', { timeout: 5000 });

      // 1. 「更多」菜单：锚点是按钮的稳定包装节点，外部状态更新不重建锚点。
      await clickReady(page, '[data-testid="more-menu-btn"]');
      await page.waitForSelector('[data-testid="more-menu"]', { timeout: 5000 });
      await waitAnchorPlaced();
      expect(await anchorContains('[data-testid="more-menu-anchor"]', '[data-testid="more-menu-btn"]')).toBe(true);
      expect(await rememberAnchor('[data-testid="more-menu-anchor"]')).toBe(true);
      const alternateRunnerKey = await page.evaluate(() => {
        const select = document.querySelector('[data-testid="banner-runner-select"]') as HTMLSelectElement | null;
        if (!select) return "";
        const options = Array.from(select.options).map((o) => o.value);
        return options.find((v) => v && v !== select.value) ?? options.find((v) => v !== select.value) ?? "";
      });
      await page.select('[data-testid="banner-runner-select"]', alternateRunnerKey);
      await page.waitForFunction(
        (expected: unknown) =>
          (document.querySelector('[data-testid="banner-runner-select"]') as HTMLSelectElement | null)?.value === expected,
        { timeout: 5000 },
        alternateRunnerKey,
      );
      expect(await anchorStillSame('[data-testid="more-menu-anchor"]')).toBe(true);
      expect(await page.evaluate(() => Boolean(document.querySelector('[data-testid="more-menu"]')))).toBe(true);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector('[data-testid="more-menu"]'), { timeout: 5000 });
      await page.waitForFunction(
        () => document.activeElement?.getAttribute("data-testid") === "more-menu-btn",
        { timeout: 5000 },
      );

      // 反复开合仍可操作，且恢复到同一锚点。
      for (let i = 0; i < 3; i += 1) {
        await clickReady(page, '[data-testid="more-menu-btn"]');
        await page.waitForSelector('[data-testid="more-menu"]', { timeout: 5000 });
        expect(await anchorStillSame('[data-testid="more-menu-anchor"]')).toBe(true);
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => !document.querySelector('[data-testid="more-menu"]'), { timeout: 5000 });
      }

      // 2. 工作台模型选择器：无关状态更新期间锚点与浮层保持稳定，退出后焦点回到按钮。
      await page.select('[data-testid="banner-runner-select"]', "");
      await clickReady(page, '[data-testid="banner-runner-select-trigger"]');
      await page.waitForSelector('[data-testid="banner-runner-select-search"]', { timeout: 5000 });
      await waitAnchorPlaced();
      expect(
        await anchorContains('[data-testid="banner-runner-select-anchor"]', '[data-testid="banner-runner-select-trigger"]'),
      ).toBe(true);
      expect(await rememberAnchor('[data-testid="banner-runner-select-anchor"]')).toBe(true);
      const secondRunnerKey = await page.evaluate(() => {
        const select = document.querySelector('[data-testid="banner-runner-select"]') as HTMLSelectElement | null;
        if (!select) return "";
        const options = Array.from(select.options).map((o) => o.value);
        return options.find((v) => v && v !== select.value) ?? options.find((v) => v !== select.value) ?? "";
      });
      await page.select('[data-testid="banner-runner-select"]', secondRunnerKey);
      await page.waitForFunction(
        (expected: unknown) =>
          (document.querySelector('[data-testid="banner-runner-select"]') as HTMLSelectElement | null)?.value === expected,
        { timeout: 5000 },
        secondRunnerKey,
      );
      expect(await anchorStillSame('[data-testid="banner-runner-select-anchor"]')).toBe(true);
      expect(await page.evaluate(() => Boolean(document.querySelector('[data-testid="banner-runner-select-search"]')))).toBe(
        true,
      );
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="banner-runner-select-search"]'),
        { timeout: 5000 },
      );
      await page.waitForFunction(
        () => document.activeElement?.getAttribute("data-testid") === "banner-runner-select-trigger",
        { timeout: 5000 },
      );
      await clickReady(page, '[data-testid="banner-runner-select-trigger"]');
      await page.waitForSelector('[data-testid="banner-runner-select-search"]', { timeout: 5000 });
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="banner-runner-select-search"]'),
        { timeout: 5000 },
      );

      // 3. 配置弹窗中的模型选择器：三个角色的锚点互不干扰，切换其他角色不重建当前锚点。
      await clickReady(page, '[data-testid="open-routing-btn"]');
      await page.waitForSelector('[data-testid="routing-modal"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="route-select-defaultLead-trigger"]');
      await page.waitForSelector('[data-testid="route-select-defaultLead-search"]', { timeout: 5000 });
      await waitAnchorPlaced();
      expect(await rememberAnchor('[data-testid="route-select-defaultLead-anchor"]')).toBe(true);
      const nextSotaValue = await page.evaluate(() => {
        const select = document.querySelector('[data-testid="route-select-sotaLead"]') as HTMLSelectElement | null;
        if (!select) return null;
        const current = select.value;
        const candidate = Array.from(select.options)
          .map((option) => option.value)
          .find((value) => value && value !== current);
        if (candidate) {
          select.value = candidate;
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return candidate;
      });
      expect(nextSotaValue).not.toBeNull();
      expect(await anchorStillSame('[data-testid="route-select-defaultLead-anchor"]')).toBe(true);
      expect(await page.evaluate(() => Boolean(document.querySelector('[data-testid="route-select-defaultLead-search"]')))).toBe(
        true,
      );
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="route-select-defaultLead-search"]'),
        { timeout: 5000 },
      );
      expect(await page.evaluate(() => Boolean(document.querySelector('[data-testid="routing-modal"]')))).toBe(true);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector('[data-testid="routing-modal"]'), { timeout: 5000 });

      expect(pageErrors).toEqual([]);
      expect(consoleErrors.filter((line) => line.includes("Maximum update depth exceeded"))).toEqual([]);
    } finally {
      await page.close();
    }
  }, 90_000);

  test("REQ-004: 执行终端适配亮暗主题、折叠次要上下文、切换结构/原始视图并自动加载历史 Run 日志", async () => {
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-e2e-console-hub-"));
    tempDirs.push(hubDir);
    process.env.WORKBENCH_HUB_DIR = hubDir;

    const repo = initGitRepo();
    await initProject(repo, {
      name: "ConsoleRepo",
      privacyMode: "local",
      routing: {
        defaultLead: { primary: { harness: "codex", model: "gpt-6-astra" }, fallbacks: [] },
        sotaLead: { primary: { harness: "codex", model: "gpt-6-astra" }, fallbacks: [] },
        reviewer: { primary: { harness: "codex", model: "gpt-6-astra" }, fallbacks: [] },
        autoReview: false,
        autoHeal: false,
      },
    });
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
      await page.waitForFunction(
        () =>
          Boolean(document.querySelector('[data-testid="ws-stage-badge"]')?.textContent?.includes("研发中")) &&
          Boolean(document.querySelector('[data-testid="run-selected-model-btn"]:not([disabled])')),
        { timeout: 5000 },
      );

      await clickReady(page, '[data-testid="run-selected-model-btn"]');
      await page.waitForFunction(
        () =>
          Boolean(document.querySelector('[data-testid="console-log-output"]')?.textContent?.includes("核心回复：终端渲染已完成")) &&
          !document.querySelector('[data-testid="live-agent-banner"]'),
        { timeout: 20000 },
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
      expect(lightColors.bg).toBe("rgb(250, 250, 250)");
      expect(lightColors.color).toBe("rgb(38, 38, 38)");

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
      expect(darkColors.bg).toBe("rgb(16, 16, 19)");
      expect(darkColors.color).toBe("rgb(228, 228, 231)");

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

      // 4b. REQ-015 审查修复：窄终端抽屉中状态徽标不溢入操作区，操作组可整体换行。
      await page.setViewport({ width: 390, height: 844 });
      await Bun.sleep(150);
      const narrowConsoleStatus = await page.evaluate(() => {
        const rect = (el: HTMLElement | null) => {
          if (!el) return { left: -1, right: -1, top: -1, bottom: -1, width: -1, height: -1 };
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
        };
        const bar = document.querySelector(".console-status-bar") as HTMLElement | null;
        const info = bar?.querySelector(".console-status-info") as HTMLElement | null;
        const actions = bar?.querySelector(".console-status-actions") as HTMLElement | null;
        const badge = info?.querySelector('[data-slot="badge"]') as HTMLElement | null;
        return {
          bar: rect(bar),
          info: rect(info),
          actions: rect(actions),
          badge: rect(badge),
          barOverflow: bar ? bar.scrollWidth - bar.clientWidth : -1,
          infoOverflow: info ? info.scrollWidth - info.clientWidth : -1,
        };
      });
      expect(narrowConsoleStatus.barOverflow).toBeLessThanOrEqual(1);
      expect(narrowConsoleStatus.infoOverflow).toBeLessThanOrEqual(1);
      expect(narrowConsoleStatus.badge.right).toBeLessThanOrEqual(narrowConsoleStatus.info.right + 1);
      expect(narrowConsoleStatus.badge.right).toBeLessThanOrEqual(narrowConsoleStatus.bar.right + 1);
      const actionGroupSeparated =
        narrowConsoleStatus.actions.left >= narrowConsoleStatus.info.right - 1 ||
        narrowConsoleStatus.actions.top >= narrowConsoleStatus.info.bottom - 1;
      expect(actionGroupSeparated).toBe(true);
      await page.setViewport({ width: 1360, height: 860 });
      await Bun.sleep(150);

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
          const inner = (menu.firstElementChild as HTMLElement | null) ?? menu;
          const style = getComputedStyle(inner);
          const contentWidth =
            inner.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
          const items = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((b) => (b as HTMLElement).offsetWidth);
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
