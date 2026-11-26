import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequirement, initProject } from "../../src/core/engine.ts";
import { HubExecutor } from "../../src/hub/executor.ts";
import { registerHubProject } from "../../src/hub/registry.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";
import { resolveTestBrowser } from "./browser_env.ts";

const browserEnv = resolveTestBrowser();
const HAS_BROWSER = browserEnv !== null;

interface BrowserPage {
  setViewport(vp: { width: number; height: number }): Promise<void>;
  goto(url: string, opts?: { waitUntil?: string }): Promise<unknown>;
  url(): string;
  waitForSelector(sel: string, opts?: { timeout?: number }): Promise<unknown>;
  waitForFunction(
    fn: string | ((...args: unknown[]) => boolean),
    opts?: { timeout?: number },
    ...args: unknown[]
  ): Promise<unknown>;
  click(sel: string): Promise<void>;
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

function makeTempHub(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-md-e2e-hub-"));
  tempDirs.push(dir);
  process.env.WORKBENCH_HUB_DIR = dir;
  return dir;
}

function initGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-md-e2e-"));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "index.ts"), "export const ok = true;\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

async function clickReady(page: BrowserPage, selector: string, timeout = 8000): Promise<void> {
  const readySel = `${selector}:not([disabled])`;
  await page.waitForSelector(readySel, { timeout });
  await page.waitForFunction(
    (sel: unknown) => {
      const el = document.querySelector(String(sel));
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    },
    { timeout },
    readySel,
  );
  await page.click(readySel);
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

suite("Structured console Markdown rendering (Chromium)", () => {
  test("renders GFM markdown, unwraps markdown fences, and copies code blocks without page errors", async () => {
    makeTempHub();
    const repo = initGitRepo();
    await initProject(repo, { name: "MdObsProj", privacyMode: "local" });
    await createRequirement(repo, { goal: "Verify structured console markdown rendering" });
    registerHubProject(repo, { name: "MdObsProj" });

    const markdownBody = [
      "## 结构视图摘要",
      "",
      "1. 准备环境",
      "   - 安装依赖",
      "2. 运行验证",
      "",
      "- [x] 类型检查",
      "- [ ] 浏览器回归",
      "",
      "| 指标 | 结果 |",
      "| :-- | :-: |",
      "| 类型检查 | 通过 |",
      "| 浏览器回归 | 待定 |",
      "",
      `~~旧方案~~ 采用 **新方案**，详见 [index.ts](file://${repo}/index.ts) 与 https://example.com 。`,
      "",
      "---",
      "",
      "```ts",
      "const ok = true;",
      "```",
    ].join("\n");
    const wrappedMessage = ["````markdown", markdownBody, "````"].join("\n");

    const agyLines = [
      JSON.stringify({ event: "init", conversation_id: "md-e2e-1", init: { model: "gemini-4-neon-medium", cwd: repo } }),
      JSON.stringify({
        event: "step_update",
        step_update: { conversation_id: "md-e2e-1", step_index: 0, state: "DONE", step_type: "user_input" },
      }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "md-e2e-1",
          step_index: 1,
          state: "ACTIVE",
          step_type: "agent_response",
          text_delta: wrappedMessage,
        },
      }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "md-e2e-1",
          step_index: 1,
          state: "DONE",
          step_type: "agent_response",
          duration_seconds: 1.1,
          usage: { input_tokens: 800, output_tokens: 120, thinking_tokens: 0, cache_read_tokens: 200, total_tokens: 920 },
        },
      }),
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "md-e2e-1",
          status: "SUCCESS",
          response: wrappedMessage,
          duration_seconds: 1.2,
          num_turns: 1,
          usage: { input_tokens: 800, output_tokens: 120, thinking_tokens: 0, cache_read_tokens: 200, total_tokens: 920 },
        },
      }),
    ];
    const agyScriptPath = path.join(repo, "agy-markdown.ndjson");
    fs.writeFileSync(agyScriptPath, `${agyLines.join("\n")}\n`);

    const executor = new HubExecutor({
      initialHarnesses: [
        {
          id: "agy",
          label: "Antigravity (agy)",
          subscription: "Antigravity",
          installed: true,
          executable: "agy",
          models: [{ id: "gemini-4-neon", label: "Gemini 4 Neon", tier: "balanced", source: "detected" }],
          defaultModel: "gemini-4-neon",
          detectedAt: Date.now(),
        },
      ],
      commandBuilder: () => ({
        command: "bash",
        args: ["-c", `cat ${JSON.stringify(agyScriptPath)}`],
        displayCommand: "mock-agy-md",
      }),
    });

    const server = await startWorkbenchServer({ root: repo, port: 0, hubMode: true, writeDiscovery: false, executor });
    servers.push(server);

    const runDone = new Promise<void>((resolve) => {
      const unsub = executor.subscribe((ev) => {
        if (ev.type === "agent.run.finished" && ev.harness === "agy") {
          unsub();
          resolve();
        }
      });
    });
    await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "ask",
      harness: "agy",
      model: "gemini-4-neon",
      message: "render markdown",
    });
    await runDone;

    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    const httpErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    page.on("response", (res: { url(): string; status(): number }) => {
      if (res.status() >= 400) httpErrors.push(`HTTP ${res.status()} ${res.url()}`);
    });
    await page.setViewport({ width: 1360, height: 900 });
    await page.goto(`${server.url}?req=REQ-001`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="toggle-drawer-btn"]', { timeout: 15000 });
    const isDrawerOpen = await page.evaluate(() => Boolean(document.querySelector('[data-testid="right-drawer"].open')));
    if (!isDrawerOpen) {
      await clickReady(page, '[data-testid="toggle-drawer-btn"]');
      await page.waitForSelector('[data-testid="right-drawer"].open', { timeout: 15000 });
    }
    await clickReady(page, '[data-testid="drawer-tab-console"]');
    await page.waitForSelector('[data-testid="console-pane"] [data-testid="trace-event-list"]', { timeout: 15000 });
    await page.waitForSelector(
      '[data-testid="console-pane"] [data-testid="console-msg-codeblock"] pre.console-msg-code',
      { timeout: 15000 },
    );

    const snap = await page.evaluate(() => {
      const out = document.querySelector('[data-testid="console-pane"] [data-testid="console-log-output"]');
      const message = out?.querySelector(".console-block-message");
      const codeBlock = out?.querySelector('[data-testid="console-msg-codeblock"]');
      const copyButton = codeBlock?.querySelector("button");
      const headerCell = out?.querySelector(".console-msg-table th") as HTMLElement | null;
      const centerCell = out?.querySelector(".console-msg-table tbody tr td:nth-child(2)") as HTMLElement | null;
      const unorderedList = out?.querySelector("ul.console-msg-list") as HTMLElement | null;
      const orderedList = out?.querySelector("ol.console-msg-list") as HTMLElement | null;
      const taskItem = out?.querySelector(".task-list-item") as HTMLElement | null;
      return {
        hasOrderedList: Boolean(out?.querySelector("ol.console-msg-list > li")),
        hasNestedList: Boolean(out?.querySelector("ol.console-msg-list > li ul.console-msg-list")),
        hasStrikethrough: Boolean(out?.querySelector("del")),
        hasDivider: Boolean(out?.querySelector("hr")),
        hasCheckedTask: Boolean(out?.querySelector('input[type="checkbox"][checked]')),
        hasCodeBlock: Boolean(out?.querySelector('[data-testid="console-msg-codeblock"] pre.console-msg-code')),
        hasFileRef: Boolean(out?.querySelector(".console-file-ref")),
        headerAlign: headerCell?.style.textAlign ?? "",
        centerCellAlign: centerCell?.style.textAlign ?? "",
        unorderedListStyle: unorderedList ? getComputedStyle(unorderedList).listStyleType : "",
        orderedListStyle: orderedList ? getComputedStyle(orderedList).listStyleType : "",
        taskItemStyle: taskItem ? getComputedStyle(taskItem).listStyleType : "",
        copyLabel: copyButton?.getAttribute("aria-label") ?? "",
        messageText: message?.textContent ?? "",
      };
    });

    expect(snap.hasOrderedList).toBe(true);
    expect(snap.hasNestedList).toBe(true);
    expect(snap.hasStrikethrough).toBe(true);
    expect(snap.hasDivider).toBe(true);
    expect(snap.hasCheckedTask).toBe(true);
    expect(snap.hasCodeBlock).toBe(true);
    expect(snap.hasFileRef).toBe(true);
    expect(snap.headerAlign).toBe("left");
    expect(snap.centerCellAlign).toBe("center");
    expect(snap.unorderedListStyle).toBe("disc");
    expect(snap.orderedListStyle).toBe("decimal");
    expect(snap.taskItemStyle).toBe("none");
    expect(snap.messageText).toContain("结构视图摘要");
    expect(snap.messageText).not.toContain("##");
    expect(snap.messageText).not.toContain("**");
    expect(snap.messageText).not.toContain("~~");
    expect(snap.messageText).not.toContain("```");
    expect(snap.copyLabel).toBe("复制");

    const copyStubbed = await page.evaluate(() => {
      try {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: () => Promise.resolve() },
        });
        return true;
      } catch {
        return false;
      }
    });
    await clickReady(page, '[data-testid="console-msg-codeblock"] .console-msg-code-copy');
    if (copyStubbed) {
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="console-msg-codeblock"] .console-msg-code-copy')
            ?.getAttribute("aria-label") === "已复制",
        { timeout: 4000 },
      );
    }

    expect(pageErrors).toEqual([]);
    expect(httpErrors).toEqual([]);
    await page.close();
  }, { timeout: 60_000 });
});