import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { approveDesign, createRequirement, getRequirement, initProject, propose } from "../../src/core/engine.ts";
import { runVerification } from "../../src/core/runner.ts";
import { HubExecutor } from "../../src/hub/executor.ts";
import { registerHubProject } from "../../src/hub/registry.ts";
import { recordModelRunOutcome } from "../../src/hub/telemetry.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";
import {
  type BrowserInstance,
  type BrowserPage,
  cleanupE2eResources,
  clickReady,
  closeE2eBrowser,
  controlledRunScript,
  HAS_BROWSER,
  initGitRepoIn,
  installBlockedWebSocket,
  installedCodexHarness,
  installHeldHubState,
  installHeldRunStart,
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

suite("REQ-012 Web E2E run lock & reconnect recovery flows", () => {
  test("REQ-012: 活跃运行期间暂停冲突写入，保留只读导航与终止并隔离跨项目同号需求", async () => {
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-e2e-runlock-hub-"));
    tempDirs.push(hubDir);
    process.env.WORKBENCH_HUB_DIR = hubDir;

    const repoA = initGitRepo();
    const repoB = initGitRepo();
    await initProject(repoA, { name: "RunLockAlpha", privacyMode: "local" });
    await initProject(repoB, { name: "RunLockBeta", privacyMode: "local" });

    // 实施中且验证已过期：同时可见「重新运行验证」与「继续让 Agent 实施」。
    await createRequirement(repoA, {
      goal: "运行期限制 Alpha",
      criteria: [{ id: "AC-1", description: "echo 验证", required: true, command: "echo ok" }],
    });
    await propose(repoA, "REQ-001", { designMarkdown: "# 方案\n实现并验证。", actor: "agent" });
    await approveDesign(repoA, "REQ-001", {});
    await runVerification(repoA, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    fs.appendFileSync(path.join(repoA, "calc.ts"), "// stale after verify\n");
    await createRequirement(repoB, { goal: "运行期隔离 Beta" });

    registerHubProject(repoA, { name: "RunLockAlpha", activate: true });
    registerHubProject(repoB, { name: "RunLockBeta", activate: false });

    const doneFile = path.join(hubDir, "run-done");
    const codeFile = path.join(hubDir, "run-code");
    const started: string[] = [];
    const finished: string[] = [];
    const executor = new HubExecutor({
      initialHarnesses: [installedCodexHarness()],
      commandBuilder: () => ({
        command: "bash",
        args: ["-c", controlledRunScript(doneFile, codeFile)],
        displayCommand: "controlled-agent",
      }),
    });
    executor.subscribe((ev) => {
      if (ev.type === "agent.run.started") started.push(ev.runId);
      if (ev.type === "agent.run.finished") finished.push(ev.runId);
    });

    const server = await startWorkbenchServer({ root: repoA, port: 0, writeDiscovery: false, hubMode: true, executor });
    servers.push(server);

    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));
    const writeRequests: string[] = [];
    page.on("request", (req: { url(): string; method(): string }) => {
      if (req.method() !== "POST") return;
      const pathname = new URL(req.url()).pathname;
      if (
        /\/run$|\/verify$|\/approve$|\/accept$|\/request-changes$|\/fast-track$|\/sync-base$|\/sync-resolve$|\/apply-sandbox$|\/sandbox$/.test(
          pathname,
        )
      ) {
        writeRequests.push(pathname);
      }
    });

    const disabled = (selector: string) =>
      page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLButtonElement | null;
        if (!el) return false;
        return Boolean(el.disabled || el.getAttribute("aria-disabled") === "true" || el.hasAttribute("data-disabled"));
      }, selector);
    const projectId = (name: string) =>
      page.evaluate((needle: string) => {
        const row = Array.from(document.querySelectorAll('[data-action="switch-project"]')).find((el) =>
          (el.textContent ?? "").includes(needle),
        );
        return row?.getAttribute("data-id") ?? "";
      }, name);
    const closeModal = async (testId: string) => {
      await page.evaluate((id: string) => {
        const modal = document.querySelector(`[data-testid="${id}"]`);
        const buttons = Array.from(modal?.querySelectorAll("button") ?? []);
        (buttons.find((b) => (b.textContent ?? "").includes("关闭")) as HTMLButtonElement | undefined)?.click();
      }, testId);
      await page.waitForFunction((id: unknown) => !document.querySelector(`[data-testid="${String(id)}"]`), { timeout: 5000 }, testId);
    };

    try {
      await page.setViewport({ width: 1360, height: 860 });
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 8000 });
      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="action-run_all_verifications"]', { timeout: 8000 });
      await page.waitForSelector('[data-testid="action-dispatch_implement"]', { timeout: 8000 });

      // 启动受控运行：命令持续输出直到测试写入结束标记。
      await clickReady(page, '[data-testid="run-selected-model-btn"]');
      await page.waitForSelector('[data-testid="live-agent-banner"]', { timeout: 8000 });
      await page.waitForSelector('[data-testid="run-lock-hint"]', { timeout: 5000 });
      await page.waitForFunction(
        () =>
          Boolean(
            document.querySelector('[data-testid="console-log-output"]')?.textContent?.includes("active-run-started"),
          ),
        { timeout: 8000 },
      );
      expect(started.length).toBe(1);
      const requestsAtLock = writeRequests.length;

      // 固定区冲突入口按原阶段显示但不可提交。
      expect(await disabled('[data-testid="action-run_all_verifications"]')).toBe(true);
      expect(await disabled('[data-testid="action-dispatch_implement"]')).toBe(true);
      expect(await disabled('[data-testid="run-selected-model-btn"]')).toBe(true);

      // 「更多」可打开：写入项禁用，只读项可用。
      await clickReady(page, '[data-testid="more-menu-btn"]');
      await page.waitForSelector('[data-testid="more-menu"]', { timeout: 5000 });
      expect(await page.evaluate(() => Boolean(document.querySelector('[data-testid="more-menu-lock-hint"]')))).toBe(true);
      expect(await disabled('[data-testid="menu-edit-req-btn"]')).toBe(true);
      expect(await disabled('[data-testid="menu-enable-sandbox-btn"]')).toBe(true);
      const handoffEnabled = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('[data-testid="more-menu"] [role="menuitem"]'));
        const target = buttons.find((b) => (b.textContent ?? "").includes("查看交接简报")) as HTMLElement | undefined;
        return Boolean(target && !target.hasAttribute("data-disabled") && target.getAttribute("aria-disabled") !== "true");
      });
      expect(handoffEnabled).toBe(true);
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('[data-testid="more-menu"] [role="menuitem"]'));
        (buttons.find((b) => (b.textContent ?? "").includes("查看交接简报")) as HTMLElement | undefined)?.click();
      });
      await page.waitForSelector('[data-testid="handoff-modal"]', { timeout: 5000 });
      await closeModal("handoff-modal");

      // 键盘打开「更多」并用只读项进入交接简报（禁用项被跳过）。
      await page.evaluate(() => (document.querySelector('[data-testid="more-menu-btn"]') as HTMLButtonElement | null)?.focus());
      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-testid="more-menu"]', { timeout: 5000 });
      for (let i = 0; i < 6; i++) {
        const focused = await page.evaluate(() => document.activeElement?.textContent ?? "");
        if (focused.includes("查看交接简报")) break;
        await page.keyboard.press("ArrowDown");
      }
      expect(await page.evaluate(() => document.activeElement?.textContent ?? "")).toContain("查看交接简报");
      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-testid="handoff-modal"]', { timeout: 5000 });
      await closeModal("handoff-modal");

      // 真实鼠标点击禁用按钮与程序化提交均不应产生请求。
      const box = await page.evaluate(() => {
        const rect = (document.querySelector('[data-testid="action-run_all_verifications"]') as HTMLElement).getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      await page.mouse.move(box.x, box.y);
      await page.mouse.down();
      await page.mouse.up();
      await page.evaluate(() => {
        (document.querySelector('[data-testid="action-dispatch_implement"]') as HTMLButtonElement | null)?.click();
        (document.querySelector('[data-testid="run-selected-model-btn"]') as HTMLButtonElement | null)?.click();
      });
      await Bun.sleep(250);
      expect(writeRequests.length).toBe(requestsAtLock);
      expect(started.length).toBe(1);

      // 只读标签页、已有日志与实时终端仍可用，终止按钮保持可用。
      await clickReady(page, '[data-testid="tab-changes"]');
      await page.waitForSelector('[data-testid="manual-verify-btn"]', { timeout: 5000 });
      expect(await disabled('[data-testid="manual-verify-btn"]')).toBe(true);
      await clickReady(page, '[data-testid="tab-timeline"]');
      await page.waitForSelector(".timeline-item", { timeout: 5000 });
      await clickReady(page, '[data-testid="tab-spec"]');
      await page.waitForSelector('[data-testid="save-spec-btn"], [data-action="start-edit-spec"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="open-console-tab-btn"]');
      await page.waitForSelector('[data-testid="cancel-run-btn"]', { timeout: 5000 });
      expect(await disabled('[data-testid="cancel-run-btn"]')).toBe(false);

      // 跨项目同号需求隔离：Beta 的 REQ-001 不受 Alpha 运行影响。
      const betaId = await projectId("RunLockBeta");
      expect(betaId).not.toBe("");
      await clickReady(page, `[data-testid="hub-project-${betaId}"]`);
      await page.waitForFunction(
        () => (document.querySelector(".ws-title")?.textContent ?? "").includes("运行期隔离 Beta"),
        { timeout: 8000 },
      );
      expect(await page.evaluate(() => Boolean(document.querySelector('[data-testid="live-agent-banner"]')))).toBe(false);
      expect(await page.evaluate(() => Boolean(document.querySelector('[data-testid="run-lock-hint"]')))).toBe(false);
      await clickReady(page, '[data-testid="more-menu-btn"]');
      await page.waitForSelector('[data-testid="more-menu"]', { timeout: 5000 });
      expect(await disabled('[data-testid="menu-edit-req-btn"]')).toBe(false);
      await page.keyboard.press("Escape");

      // 返回 Alpha：运行仍在，随后主动终止并按真实状态恢复。
      const alphaId = await projectId("RunLockAlpha");
      await clickReady(page, `[data-testid="hub-project-${alphaId}"]`);
      await page.waitForSelector('[data-testid="live-agent-banner"]', { timeout: 8000 });
      await clickReady(page, '[data-testid="cancel-run-btn"]');
      await page.waitForFunction(() => !document.querySelector('[data-testid="live-agent-banner"]'), { timeout: 8000 });
      await page.waitForFunction(
        () => {
          const btn = document.querySelector('[data-testid="action-run_all_verifications"]') as HTMLButtonElement | null;
          return Boolean(btn && !btn.disabled);
        },
        { timeout: 8000 },
      );
      expect(await disabled('[data-testid="action-dispatch_implement"]')).toBe(false);
      expect(await disabled('[data-testid="run-selected-model-btn"]')).toBe(false);
      expect(finished.length).toBe(1);

      await clickReady(page, '[data-testid="more-menu-btn"]');
      await page.waitForSelector('[data-testid="more-menu"]', { timeout: 5000 });
      expect(await disabled('[data-testid="menu-edit-req-btn"]')).toBe(false);
      await page.keyboard.press("Escape");

      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 45_000);

  test("REQ-012: 成功、失败、快速结束与刷新后的运行状态恢复", async () => {
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-e2e-runlock2-hub-"));
    tempDirs.push(hubDir);
    process.env.WORKBENCH_HUB_DIR = hubDir;

    const repo = initGitRepo();
    await initProject(repo, {
      name: "RunLifecycle",
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
      goal: "运行生命周期恢复",
      criteria: [{ id: "AC-1", description: "echo 验证", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# 方案\n实现并验证。", actor: "agent" });
    await approveDesign(repo, "REQ-001", {});
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    fs.appendFileSync(path.join(repo, "calc.ts"), "// stale after verify\n");
    registerHubProject(repo, { name: "RunLifecycle", activate: true });

    const doneFile = path.join(hubDir, "run-done");
    const codeFile = path.join(hubDir, "run-code");
    const started: string[] = [];
    const executor = new HubExecutor({
      initialHarnesses: [installedCodexHarness()],
      commandBuilder: () => ({
        command: "bash",
        args: ["-c", controlledRunScript(doneFile, codeFile)],
        displayCommand: "controlled-agent",
      }),
    });
    executor.subscribe((ev) => {
      if (ev.type === "agent.run.started") started.push(ev.runId);
    });

    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, hubMode: true, executor });
    servers.push(server);

    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));

    const waitUnlocked = () =>
      page.waitForFunction(
        () =>
          !document.querySelector('[data-testid="live-agent-banner"]') &&
          Boolean((document.querySelector('[data-testid="run-selected-model-btn"]') as HTMLButtonElement | null)?.disabled === false),
        { timeout: 8000 },
      );
    const finishRun = (code: number) => {
      fs.writeFileSync(codeFile, `${code}\n`);
      fs.writeFileSync(doneFile, "1\n");
    };
    const waitStarted = async (count: number) => {
      const deadline = Date.now() + 8000;
      while (started.length < count && Date.now() < deadline) await Bun.sleep(25);
      expect(started.length).toBeGreaterThanOrEqual(count);
    };
    const startRun = async (expectedRuns: number) => {
      fs.rmSync(doneFile, { force: true });
      await clickReady(page, '[data-testid="run-selected-model-btn"]');
      await page.waitForSelector('[data-testid="live-agent-banner"]', { timeout: 8000 });
      await waitStarted(expectedRuns);
    };

    try {
      await page.setViewport({ width: 1360, height: 860 });
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 8000 });
      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="run-selected-model-btn"]', { timeout: 8000 });

      // 1. 刷新后由 Hub 快照恢复运行期限制。
      await startRun(1);
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 8000 });
      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="live-agent-banner"]', { timeout: 8000 });
      expect(await page.evaluate(() => Boolean(document.querySelector('[data-testid="run-lock-hint"]')))).toBe(true);
      finishRun(0);
      await waitUnlocked();

      // 2. 失败结束同样按真实状态解除限制。
      await startRun(2);
      finishRun(1);
      await waitUnlocked();
      await clickReady(page, '[data-testid="tab-timeline"]');
      await page.waitForFunction(
        () => (document.body.innerText ?? "").includes("失败") || (document.body.innerText ?? "").includes("failed"),
        { timeout: 8000 },
      );

      // 3. 主动终止后恢复。
      await clickReady(page, '[data-testid="tab-spec"]');
      await startRun(3);
      await clickReady(page, '[data-testid="open-console-tab-btn"]');
      await clickReady(page, '[data-testid="cancel-run-btn"]');
      await waitUnlocked();

      // 4. 快速结束（HTTP 调度响应可能晚于结束事件）不会留下陈旧锁。
      finishRun(0);
      const expectedFastRun = started.length + 1;
      await clickReady(page, '[data-testid="run-selected-model-btn"]');
      await waitStarted(expectedFastRun);
      await page.waitForFunction(
        () =>
          !document.querySelector('[data-testid="live-agent-banner"]') &&
          Boolean((document.querySelector('[data-testid="run-selected-model-btn"]') as HTMLButtonElement | null)?.disabled === false),
        { timeout: 8000 },
      );
      expect(await page.evaluate(() => Boolean(document.querySelector('[data-testid="run-lock-hint"]')))).toBe(false);

      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 45_000);

  test("REQ-012: 单项目快照与不刷新页面的断线重连保持真实运行限制", async () => {
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-e2e-reconnect-hub-"));
    tempDirs.push(hubDir);
    process.env.WORKBENCH_HUB_DIR = hubDir;

    const repo = initGitRepo();
    await initProject(repo, { name: "SingleModeRun", privacyMode: "local" });
    await createRequirement(repo, {
      goal: "单项目运行快照与重连",
      criteria: [{ id: "AC-1", description: "echo 验证", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# 方案\n实现并验证。", actor: "agent" });
    await approveDesign(repo, "REQ-001", {});
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    fs.appendFileSync(path.join(repo, "calc.ts"), "// stale after verify\n");
    // 项目已登记到 Hub，但服务以单项目模式启动：快照运行会附带 projectId。
    registerHubProject(repo, { name: "SingleModeRun", activate: true });

    const doneFile = path.join(hubDir, "run-done");
    const codeFile = path.join(hubDir, "run-code");
    const started: string[] = [];
    const finished: string[] = [];
    const executor = new HubExecutor({
      initialHarnesses: [installedCodexHarness()],
      commandBuilder: () => ({
        command: "bash",
        args: ["-c", controlledRunScript(doneFile, codeFile)],
        displayCommand: "controlled-agent",
      }),
    });
    executor.subscribe((ev) => {
      if (ev.type === "agent.run.started") started.push(ev.runId);
      if (ev.type === "agent.run.finished") finished.push(ev.runId);
    });

    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, executor });
    servers.push(server);

    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));
    let hubStateResponses = 0;
    page.on("response", (resp: { url(): string }) => {
      if (resp.url().includes("/api/hub/state")) hubStateResponses += 1;
    });
    // 测试专用 WebSocket 包装：断线期间阻止重连，重连后恢复正常连接。
    await page.evaluateOnNewDocument(() => {
      const w = window as unknown as {
        WebSocket: typeof WebSocket;
        __wbSockets: WebSocket[];
        __wbBlockSockets: boolean;
      };
      const Native = w.WebSocket;
      const sockets: WebSocket[] = [];
      function Wrapped(url: string, protocols?: string | string[]) {
        if (w.__wbBlockSockets) {
          const listeners: Record<string, Array<() => void>> = {};
          const fake = {
            readyState: 3,
            addEventListener(type: string, fn: () => void) {
              (listeners[type] ??= []).push(fn);
              if (type === "close") setTimeout(() => (listeners.close ?? []).forEach((cb) => cb()), 0);
            },
            removeEventListener() {},
            close() {
              (listeners.close ?? []).forEach((cb) => cb());
            },
          };
          return fake;
        }
        const ws = new Native(url, protocols);
        sockets.push(ws);
        return ws;
      }
      Wrapped.prototype = Native.prototype;
      Object.assign(Wrapped, {
        CONNECTING: Native.CONNECTING,
        OPEN: Native.OPEN,
        CLOSING: Native.CLOSING,
        CLOSED: Native.CLOSED,
      });
      w.WebSocket = Wrapped as unknown as typeof WebSocket;
      w.__wbSockets = sockets;
      w.__wbBlockSockets = false;
    });

    const waitStarted = async (count: number) => {
      const deadline = Date.now() + 8000;
      while (started.length < count && Date.now() < deadline) await Bun.sleep(25);
      expect(started.length).toBeGreaterThanOrEqual(count);
    };
    const waitFinished = async (count: number) => {
      const deadline = Date.now() + 8000;
      while (finished.length < count && Date.now() < deadline) await Bun.sleep(25);
      expect(finished.length).toBeGreaterThanOrEqual(count);
    };
    const disconnect = () =>
      page.evaluate(() => {
        const w = window as unknown as { __wbSockets: WebSocket[]; __wbBlockSockets: boolean };
        w.__wbBlockSockets = true;
        for (const ws of w.__wbSockets) {
          try {
            ws.close();
          } catch {
            // 已关闭的连接忽略。
          }
        }
      });
    const reconnect = () =>
      page.evaluate(() => {
        (window as unknown as { __wbBlockSockets: boolean }).__wbBlockSockets = false;
      });
    const disabled = (selector: string) =>
      page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLButtonElement | null;
        if (!el) return false;
        return Boolean(el.disabled || el.getAttribute("aria-disabled") === "true" || el.hasAttribute("data-disabled"));
      }, selector);

    try {
      await page.setViewport({ width: 1360, height: 860 });
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 8000 });
      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="run-selected-model-btn"]', { timeout: 8000 });

      // 1. 单项目模式：运行中触发一次全量查询失效，快照附带 projectId 仍应维持限制。
      await clickReady(page, '[data-testid="run-selected-model-btn"]');
      await page.waitForSelector('[data-testid="live-agent-banner"]', { timeout: 8000 });
      await waitStarted(1);
      const beforeSync = hubStateResponses;
      await page.evaluate(async () => {
        await fetch("/api/project/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
      });
      const syncDeadline = Date.now() + 5000;
      while (hubStateResponses <= beforeSync && Date.now() < syncDeadline) await Bun.sleep(25);
      expect(hubStateResponses).toBeGreaterThan(beforeSync);
      await Bun.sleep(200);
      expect(await page.evaluate(() => Boolean(document.querySelector('[data-testid="live-agent-banner"]')))).toBe(true);
      expect(await disabled('[data-testid="action-run_all_verifications"]')).toBe(true);

      // 2. 断线期间运行结束：页面漏收结束事件，重连快照后解除限制。
      await disconnect();
      executor.cancelRun(started[0]!);
      await waitFinished(1);
      await Bun.sleep(400);
      expect(await page.evaluate(() => Boolean(document.querySelector('[data-testid="live-agent-banner"]')))).toBe(true);
      await reconnect();
      await page.waitForFunction(() => !document.querySelector('[data-testid="live-agent-banner"]'), { timeout: 12000 });
      await page.waitForFunction(
        () => !(document.querySelector('[data-testid="run-selected-model-btn"]') as HTMLButtonElement | null)?.disabled,
        { timeout: 8000 },
      );
      expect(await disabled('[data-testid="action-run_all_verifications"]')).toBe(false);

      // 3. 断线期间启动运行：页面漏收启动事件，重连快照后恢复限制。
      await disconnect();
      const startedWhileOffline = await executor.startRun({
        root: repo,
        requirementId: "REQ-001",
        action: "implement",
        harness: "codex",
        model: "gpt-6-astra",
      });
      await waitStarted(2);
      await Bun.sleep(400);
      expect(await page.evaluate(() => Boolean(document.querySelector('[data-testid="live-agent-banner"]')))).toBe(false);
      await reconnect();
      await page.waitForSelector('[data-testid="live-agent-banner"]', { timeout: 12000 });
      await page.waitForSelector('[data-testid="run-lock-hint"]', { timeout: 5000 });
      expect(await disabled('[data-testid="action-run_all_verifications"]')).toBe(true);
      expect(await page.evaluate(() => (document.querySelector('[data-testid="ws-stage-badge"]')?.textContent ?? "").includes("研发中"))).toBe(
        true,
      );

      executor.cancelRun(startedWhileOffline.run.id);
      await waitFinished(2);
      await page.waitForFunction(() => !document.querySelector('[data-testid="live-agent-banner"]'), { timeout: 8000 });

      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 45_000);

  test("REQ-012: 初始快照与首次连接之间的运行起止事件由连接后快照校正", async () => {
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-e2e-firstconnect-hub-"));
    tempDirs.push(hubDir);
    process.env.WORKBENCH_HUB_DIR = hubDir;

    const repo = initGitRepo();
    await initProject(repo, { name: "FirstConnectRun", privacyMode: "local" });
    await createRequirement(repo, {
      goal: "首次连接运行快照校正",
      criteria: [{ id: "AC-1", description: "echo 验证", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# 方案\n实现并验证。", actor: "agent" });
    await approveDesign(repo, "REQ-001", {});
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    fs.appendFileSync(path.join(repo, "calc.ts"), "// stale after verify\n");
    registerHubProject(repo, { name: "FirstConnectRun", activate: true });

    const doneFile = path.join(hubDir, "run-done");
    const codeFile = path.join(hubDir, "run-code");
    const started: string[] = [];
    const finished: string[] = [];
    const executor = new HubExecutor({
      initialHarnesses: [installedCodexHarness()],
      commandBuilder: () => ({
        command: "bash",
        args: ["-c", controlledRunScript(doneFile, codeFile)],
        displayCommand: "controlled-agent",
      }),
    });
    executor.subscribe((ev) => {
      if (ev.type === "agent.run.started") started.push(ev.runId);
      if (ev.type === "agent.run.finished") finished.push(ev.runId);
    });

    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, hubMode: true, executor });
    servers.push(server);

    const waitStarted = async (count: number) => {
      const deadline = Date.now() + 8000;
      while (started.length < count && Date.now() < deadline) await Bun.sleep(25);
      expect(started.length).toBeGreaterThanOrEqual(count);
    };
    const waitFinished = async (count: number) => {
      const deadline = Date.now() + 8000;
      while (finished.length < count && Date.now() < deadline) await Bun.sleep(25);
      expect(finished.length).toBeGreaterThanOrEqual(count);
    };
    const unblockSockets = (page: BrowserPage) =>
      page.evaluate(() => {
        (window as unknown as { __wbBlockSockets: boolean }).__wbBlockSockets = false;
      });

    const pageA = await browser!.newPage();
    const pageB = await browser!.newPage();
    const pageErrors: string[] = [];
    pageA.on("pageerror", (err: Error) => pageErrors.push(err.message));
    pageB.on("pageerror", (err: Error) => pageErrors.push(err.message));

    try {
      // 顺序 1：初始快照（无运行）与首次连接之间启动运行。
      await installBlockedWebSocket(pageA);
      await pageA.setViewport({ width: 1360, height: 860 });
      await pageA.goto(server.url, { waitUntil: "networkidle0" });
      await pageA.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 10000 });
      await clickReady(pageA, '[data-testid="req-row-REQ-001"]');
      await pageA.waitForSelector('[data-testid="run-selected-model-btn"]', { timeout: 8000 });

      const runDuringGap = await executor.startRun({
        root: repo,
        requirementId: "REQ-001",
        action: "implement",
        harness: "codex",
        model: "gpt-6-astra",
      });
      await waitStarted(1);
      await Bun.sleep(300);
      expect(await pageA.evaluate(() => Boolean(document.querySelector('[data-testid="live-agent-banner"]')))).toBe(false);

      await unblockSockets(pageA);
      await pageA.waitForSelector('[data-testid="live-agent-banner"]', { timeout: 12000 });
      await pageA.waitForSelector('[data-testid="run-lock-hint"]', { timeout: 5000 });
      expect(
        await pageA.evaluate(
          () => Boolean((document.querySelector('[data-testid="action-run_all_verifications"]') as HTMLButtonElement | null)?.disabled),
        ),
      ).toBe(true);

      executor.cancelRun(runDuringGap.run.id);
      await waitFinished(1);
      await pageA.waitForFunction(() => !document.querySelector('[data-testid="live-agent-banner"]'), { timeout: 8000 });

      // 顺序 2：初始快照（有运行）与首次连接之间结束运行。
      const runBeforeLoad = await executor.startRun({
        root: repo,
        requirementId: "REQ-001",
        action: "implement",
        harness: "codex",
        model: "gpt-6-astra",
      });
      await waitStarted(2);

      await installBlockedWebSocket(pageB);
      await pageB.setViewport({ width: 1360, height: 860 });
      await pageB.goto(server.url, { waitUntil: "networkidle0" });
      await pageB.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 10000 });
      await clickReady(pageB, '[data-testid="req-row-REQ-001"]');
      await pageB.waitForSelector('[data-testid="live-agent-banner"]', { timeout: 10000 });

      executor.cancelRun(runBeforeLoad.run.id);
      await waitFinished(2);
      await Bun.sleep(300);
      expect(await pageB.evaluate(() => Boolean(document.querySelector('[data-testid="live-agent-banner"]')))).toBe(true);

      await unblockSockets(pageB);
      await pageB.waitForFunction(() => !document.querySelector('[data-testid="live-agent-banner"]'), { timeout: 12000 });
      await pageB.waitForFunction(
        () => !(document.querySelector('[data-testid="run-selected-model-btn"]') as HTMLButtonElement | null)?.disabled,
        { timeout: 8000 },
      );

      expect(pageErrors).toEqual([]);
    } finally {
      await pageA.close();
      await pageB.close();
    }
  }, 45_000);

  test("REQ-012: 初始快照仍在途时首次连接后补拉权威快照", async () => {
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-e2e-heldsnapshot-hub-"));
    tempDirs.push(hubDir);
    process.env.WORKBENCH_HUB_DIR = hubDir;

    const repo = initGitRepo();
    await initProject(repo, { name: "HeldSnapshot", privacyMode: "local" });
    await createRequirement(repo, {
      goal: "在途快照补拉",
      criteria: [{ id: "AC-1", description: "echo 验证", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# 方案\n实现并验证。", actor: "agent" });
    await approveDesign(repo, "REQ-001", {});
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    fs.appendFileSync(path.join(repo, "calc.ts"), "// stale after verify\n");
    registerHubProject(repo, { name: "HeldSnapshot", activate: true });

    const doneFile = path.join(hubDir, "run-done");
    const codeFile = path.join(hubDir, "run-code");
    const started: string[] = [];
    const finished: string[] = [];
    const executor = new HubExecutor({
      initialHarnesses: [installedCodexHarness()],
      commandBuilder: () => ({
        command: "bash",
        args: ["-c", controlledRunScript(doneFile, codeFile)],
        displayCommand: "controlled-agent",
      }),
    });
    executor.subscribe((ev) => {
      if (ev.type === "agent.run.started") started.push(ev.runId);
      if (ev.type === "agent.run.finished") finished.push(ev.runId);
    });

    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, hubMode: true, executor });
    servers.push(server);

    const waitStarted = async (count: number) => {
      const deadline = Date.now() + 8000;
      while (started.length < count && Date.now() < deadline) await Bun.sleep(25);
      expect(started.length).toBeGreaterThanOrEqual(count);
    };
    const waitFinished = async (count: number) => {
      const deadline = Date.now() + 8000;
      while (finished.length < count && Date.now() < deadline) await Bun.sleep(25);
      expect(finished.length).toBeGreaterThanOrEqual(count);
    };
    const unblockSockets = (p: BrowserPage) =>
      p.evaluate(() => {
        (window as unknown as { __wbBlockSockets: boolean }).__wbBlockSockets = false;
      });
    const releaseHubState = (p: BrowserPage) =>
      p.evaluate(() => (window as unknown as { __wbReleaseHubState: () => void }).__wbReleaseHubState());
    const hubStateRequests = (p: BrowserPage) =>
      p.evaluate(() => (window as unknown as { __wbHubStateRequests: number }).__wbHubStateRequests);
    const disabled = (p: BrowserPage, selector: string) =>
      p.evaluate((sel: string) => Boolean((document.querySelector(sel) as HTMLButtonElement | null)?.disabled), selector);

    const pageA = await browser!.newPage();
    const pageB = await browser!.newPage();
    const pageErrors: string[] = [];
    pageA.on("pageerror", (err: Error) => pageErrors.push(err.message));
    pageB.on("pageerror", (err: Error) => pageErrors.push(err.message));

    try {
      // 顺序 1：初始快照（无运行）响应仍在途时启动运行。
      await installHeldHubState(pageA);
      await installBlockedWebSocket(pageA);
      await pageA.setViewport({ width: 1360, height: 860 });
      await pageA.goto(server.url, { waitUntil: "domcontentloaded" });
      await pageA.waitForFunction(() => (window as unknown as { __wbHubStateRequests: number }).__wbHubStateRequests >= 1, {
        timeout: 8000,
      });

      const runDuringGap = await executor.startRun({
        root: repo,
        requirementId: "REQ-001",
        action: "implement",
        harness: "codex",
        model: "gpt-6-astra",
      });
      await waitStarted(1);

      const requestsBeforeA = await hubStateRequests(pageA);
      await unblockSockets(pageA);
      // 初始请求仍在途时 react-query 会复用它，连接建立后必须真实补拉新快照。
      await pageA.waitForFunction(
        (...args: unknown[]) => (window as unknown as { __wbHubStateRequests: number }).__wbHubStateRequests > Number(args[0]),
        { timeout: 10_000 },
        requestsBeforeA,
      );
      await releaseHubState(pageA);

      await pageA.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 10_000 });
      await clickReady(pageA, '[data-testid="req-row-REQ-001"]');
      await pageA.waitForSelector('[data-testid="live-agent-banner"]', { timeout: 8000 });
      expect(await disabled(pageA, '[data-testid="action-run_all_verifications"]')).toBe(true);

      executor.cancelRun(runDuringGap.run.id);
      await waitFinished(1);
      await pageA.waitForFunction(() => !document.querySelector('[data-testid="live-agent-banner"]'), { timeout: 8000 });

      // 顺序 2：初始快照（含运行）响应仍在途时结束运行。
      const runBeforeLoad = await executor.startRun({
        root: repo,
        requirementId: "REQ-001",
        action: "implement",
        harness: "codex",
        model: "gpt-6-astra",
      });
      await waitStarted(2);

      await installHeldHubState(pageB);
      await installBlockedWebSocket(pageB);
      await pageB.setViewport({ width: 1360, height: 860 });
      await pageB.goto(server.url, { waitUntil: "domcontentloaded" });
      await pageB.waitForFunction(() => (window as unknown as { __wbHubStateRequests: number }).__wbHubStateRequests >= 1, {
        timeout: 8000,
      });

      executor.cancelRun(runBeforeLoad.run.id);
      await waitFinished(2);

      const requestsBeforeB = await hubStateRequests(pageB);
      await unblockSockets(pageB);
      await pageB.waitForFunction(
        (...args: unknown[]) => (window as unknown as { __wbHubStateRequests: number }).__wbHubStateRequests > Number(args[0]),
        { timeout: 10_000 },
        requestsBeforeB,
      );
      await releaseHubState(pageB);

      await pageB.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 10_000 });
      await clickReady(pageB, '[data-testid="req-row-REQ-001"]');
      await pageB.waitForSelector('[data-testid="run-selected-model-btn"]', { timeout: 8000 });
      // 释放的旧快照包含已结束的运行，不得回滚连接后补拉的新状态。
      await Bun.sleep(300);
      expect(await pageB.evaluate(() => Boolean(document.querySelector('[data-testid="live-agent-banner"]')))).toBe(false);
      expect(await disabled(pageB, '[data-testid="run-selected-model-btn"]')).toBe(false);

      expect(pageErrors).toEqual([]);
      // 断言初始请求在途期间连接后确实发出了新快照请求，而非直接复用。
      expect(await hubStateRequests(pageA)).toBeGreaterThan(requestsBeforeA);
    } finally {
      await pageA.close();
      await pageB.close();
    }
  }, 60_000);

  test("REQ-012: 断线期间结束且调度响应迟到时不重新加锁", async () => {
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-e2e-latedispatch-hub-"));
    tempDirs.push(hubDir);
    process.env.WORKBENCH_HUB_DIR = hubDir;

    const repo = initGitRepo();
    await initProject(repo, { name: "LateDispatch", privacyMode: "local" });
    await createRequirement(repo, {
      goal: "迟到调度响应",
      criteria: [{ id: "AC-1", description: "echo 验证", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# 方案\n实现并验证。", actor: "agent" });
    await approveDesign(repo, "REQ-001", {});
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    fs.appendFileSync(path.join(repo, "calc.ts"), "// stale after verify\n");
    registerHubProject(repo, { name: "LateDispatch", activate: true });

    const doneFile = path.join(hubDir, "run-done");
    const codeFile = path.join(hubDir, "run-code");
    const started: string[] = [];
    const finished: string[] = [];
    const executor = new HubExecutor({
      initialHarnesses: [installedCodexHarness()],
      commandBuilder: () => ({
        command: "bash",
        args: ["-c", controlledRunScript(doneFile, codeFile)],
        displayCommand: "controlled-agent",
      }),
    });
    executor.subscribe((ev) => {
      if (ev.type === "agent.run.started") started.push(ev.runId);
      if (ev.type === "agent.run.finished") finished.push(ev.runId);
    });

    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, hubMode: true, executor });
    servers.push(server);

    const waitStarted = async (count: number) => {
      const deadline = Date.now() + 8000;
      while (started.length < count && Date.now() < deadline) await Bun.sleep(25);
      expect(started.length).toBeGreaterThanOrEqual(count);
    };
    const waitFinished = async (count: number) => {
      const deadline = Date.now() + 8000;
      while (finished.length < count && Date.now() < deadline) await Bun.sleep(25);
      expect(finished.length).toBeGreaterThanOrEqual(count);
    };
    const bannerVisible = (p: BrowserPage) =>
      p.evaluate(() => Boolean(document.querySelector('[data-testid="live-agent-banner"]')));

    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));

    try {
      await installHeldHubState(page, false);
      await installHeldRunStart(page);
      await installBlockedWebSocket(page, false);
      await page.setViewport({ width: 1360, height: 860 });
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await page.waitForFunction(
        () => ((window as unknown as { __wbSockets: WebSocket[] }).__wbSockets).some((ws) => ws.readyState === 1),
        { timeout: 10_000 },
      );
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 10_000 });
      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="run-selected-model-btn"]', { timeout: 8000 });

      await clickReady(page, '[data-testid="run-selected-model-btn"]');
      await waitStarted(1);
      await page.waitForSelector('[data-testid="live-agent-banner"]', { timeout: 8000 });
      expect(await page.evaluate(() => Boolean((window as unknown as { __wbRunStartPending: boolean }).__wbRunStartPending))).toBe(
        true,
      );

      // 断线期间运行结束：页面漏收结束事件，调度响应仍被挂起。
      await page.evaluate(() => {
        const w = window as unknown as { __wbSockets: WebSocket[]; __wbBlockSockets: boolean };
        w.__wbBlockSockets = true;
        for (const ws of w.__wbSockets) {
          try {
            ws.close();
          } catch {
            // 已关闭的连接忽略。
          }
        }
      });
      executor.cancelRun(started[0]!);
      await waitFinished(1);
      await Bun.sleep(300);
      expect(await bannerVisible(page)).toBe(true);

      // 重连快照到达并解除限制。
      await page.evaluate(() => {
        (window as unknown as { __wbBlockSockets: boolean }).__wbBlockSockets = false;
      });
      await page.waitForFunction(() => !document.querySelector('[data-testid="live-agent-banner"]'), { timeout: 12_000 });

      // 迟到的调度响应此时才到达，不得重新锁住已恢复的操作。
      // 挂起响应到达后触发的 Hub 快照，确保任何陈旧锁状态均可被观测到。
      await page.evaluate(() => (window as unknown as { __wbHoldHubState: () => void }).__wbHoldHubState());
      await page.evaluate(() => (window as unknown as { __wbReleaseRunStart: () => void }).__wbReleaseRunStart());
      await Bun.sleep(800);
      expect(await bannerVisible(page)).toBe(false);
      expect(
        await page.evaluate(
          () => Boolean((document.querySelector('[data-testid="run-selected-model-btn"]') as HTMLButtonElement | null)?.disabled),
        ),
      ).toBe(false);

      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
});
