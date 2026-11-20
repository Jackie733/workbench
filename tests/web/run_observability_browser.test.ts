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
  reload(opts?: { waitUntil?: string }): Promise<unknown>;
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-obs-e2e-hub-"));
  tempDirs.push(dir);
  process.env.WORKBENCH_HUB_DIR = dir;
  return dir;
}

function initGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-obs-e2e-"));
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

suite("Agent Observability E2E (Chromium)", () => {
  test("fixes historical vs active terminal collision, survives mid-run refresh, audits handoff diffs, and renders global Insights", async () => {
    makeTempHub();
    const repo = initGitRepo();
    await initProject(repo, { name: "ObsProj", privacyMode: "local" });
    await createRequirement(repo, { goal: "Verify observability end-to-end" });
    registerHubProject(repo, { name: "ObsProj" });

    const controlDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-obs-ctrl-"));
    tempDirs.push(controlDir);
    const releaseRun2Flag = path.join(controlDir, "release_run2.flag");
    let invokeCount = 0;

    const executor = new HubExecutor({
      initialHarnesses: [
        {
          id: "qodercn",
          label: "Qoder",
          subscription: "Pro",
          installed: true,
          executable: "qodercn",
          models: [{ id: "Qwen4-Max-Preview", label: "Qwen4", tier: "balanced", source: "detected" }],
          defaultModel: "Qwen4-Max-Preview",
          detectedAt: Date.now(),
        },
        {
          id: "omp",
          label: "OMP",
          subscription: "CLI",
          installed: true,
          executable: "omp",
          models: [{ id: "opencode-go/glm-5", label: "GLM-5", tier: "balanced", source: "detected" }],
          defaultModel: "opencode-go/glm-5",
          detectedAt: Date.now(),
        },
      ],
      commandBuilder: (target) => {
        invokeCount += 1;
        if (target.harness === "qodercn") {
          const lines = [
            JSON.stringify({ type: "system", subtype: "init", session_id: "q-e2e-1", model: "Qwen4-Max-Preview" }),
            JSON.stringify({
              type: "assistant",
              session_id: "q-e2e-1",
              message: {
                content: [
                  { type: "thinking", thinking: "Run 1 analyzing codebase" },
                  { type: "tool_use", id: "r1-t1", name: "bash", input: { command: "echo RUN1_TOOL" } },
                ],
              },
            }),
            JSON.stringify({
              type: "user",
              session_id: "q-e2e-1",
              message: { content: [{ type: "tool_result", tool_use_id: "r1-t1", content: "RUN1_TOOL_RESULT" }] },
            }),
            JSON.stringify({
              type: "assistant",
              session_id: "q-e2e-1",
              message: { content: [{ type: "text", text: "RUN1_UNIQUE_OUTPUT" }] },
            }),
            JSON.stringify({
              type: "result",
              session_id: "q-e2e-1",
              result: "RUN1_UNIQUE_OUTPUT",
              duration_ms: 210,
              usage: { input_tokens: 400, cache_read_input_tokens: 1600, output_tokens: 120 },
            }),
          ];
          const script = lines.map((l) => `printf '%s\\n' ${JSON.stringify(l)}`).join("; ");
          return { command: "bash", args: ["-c", script], displayCommand: "mock-run1" };
        }

        const run2Lines = [
          JSON.stringify({ type: "turn_start" }),
          JSON.stringify({
            type: "tool_execution_start",
            toolCallId: "r2-t1",
            toolName: "bash",
            args: { command: "echo RUN2_STEP1" },
          }),
          JSON.stringify({
            type: "tool_execution_end",
            toolCallId: "r2-t1",
            toolName: "bash",
            result: "RUN2_TOOL_DONE",
            isError: false,
          }),
          JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "RUN2_LIVE_STREAM" }],
              usage: {
                input: 500,
                output: 90,
                cacheRead: 2000,
                cacheWrite: 0,
                cost: { total: 0.012 },
              },
            },
          }),
        ];
        const emitPrefix = run2Lines.map((l) => `printf '%s\\n' ${JSON.stringify(l)}`).join("; ");
        const script = `${emitPrefix}; while [ ! -f ${JSON.stringify(releaseRun2Flag)} ]; do sleep 0.05; done; echo "RUN2_AFTER_RELEASE"`;
        return { command: "bash", args: ["-c", script], displayCommand: "mock-run2-omp" };
      },
    });

    const server = await startWorkbenchServer({ root: repo, port: 0, hubMode: true, writeDiscovery: false, executor });
    servers.push(server);

    const run1Done = new Promise<void>((resolve) => {
      const unsub = executor.subscribe((ev) => {
        if (ev.type === "agent.run.finished" && ev.harness === "qodercn") {
          unsub();
          resolve();
        }
      });
    });
    const run1Started = await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "design",
      harness: "qodercn",
      model: "Qwen4-Max-Preview",
    });
    await run1Done;

    // Start Run 2 (stays live while we inspect historical Run 1)
    const run2StartedPromise = executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "ask",
      harness: "omp",
      model: "opencode-go/glm-5",
      message: "inspect design",
    });
    const run2Done = new Promise<void>((resolve) => {
      const unsub = executor.subscribe((ev) => {
        if (ev.type === "agent.run.finished" && ev.harness === "omp") {
          unsub();
          resolve();
        }
      });
    });
    const run2Started = await run2StartedPromise;

    // Wait briefly for Run 2's initial JSONL events to flush before interacting
    await new Promise((r) => setTimeout(r, 250));

    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    const httpErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    page.on("response", (res: { url(): string; status(): number }) => {
      if (res.status() >= 400) httpErrors.push(`HTTP ${res.status()} ${res.url()}`);
    });

    await page.setViewport({ width: 1360, height: 860 });
    await page.goto(`${server.url}?req=REQ-001`, { waitUntil: "networkidle0" });

    // 1. Bug #1 fix: viewing Run 1 while Run 2 is active must show Run 1 output, NOT Run 2's active stream
    await clickReady(page, '[data-testid="tab-timeline"]');
    await clickReady(page, `[data-testid="view-run-output-btn-${run1Started.run.id}"]`);
    await page.waitForSelector('[data-testid="historical-run-banner"]', { timeout: 5000 });
    await page.waitForFunction(
      () =>
        (document.querySelector('[data-testid="console-pane"] [data-testid="console-log-output"]')?.textContent ?? "").includes(
          "RUN1_UNIQUE_OUTPUT",
        ),
      { timeout: 5000 },
    );
    const consoleTxtOnRun1 = await page.evaluate(
      () => document.querySelector('[data-testid="console-pane"] [data-testid="console-log-output"]')?.textContent ?? "",
    );
    expect(consoleTxtOnRun1).toContain("RUN1_UNIQUE_OUTPUT");
    expect(consoleTxtOnRun1).not.toContain("RUN2_LIVE_STREAM");

    // Switching back to live run shows Run 2 stream & hides historical banner
    await clickReady(page, '[data-testid="jump-to-live-run-btn"]');
    await page.waitForFunction(
      () =>
        (document.querySelector('[data-testid="console-pane"] [data-testid="console-log-output"]')?.textContent ?? "").includes(
          "RUN2_LIVE_STREAM",
        ),
      { timeout: 5000 },
    );

    // 2. Bug #2 fix: reload page mid-run and verify prior structured trace + output hydrate from server
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="toggle-drawer-btn"]', { timeout: 6000 });
    const isDrawerOpen = await page.evaluate(() => Boolean(document.querySelector('[data-testid="right-drawer"].open')));
    if (!isDrawerOpen) {
      await clickReady(page, '[data-testid="toggle-drawer-btn"]');
      await page.waitForSelector('[data-testid="right-drawer"].open', { timeout: 5000 });
    }
    await clickReady(page, '[data-testid="drawer-tab-console"]');
    await page.waitForSelector('[data-testid="console-pane"] [data-testid="trace-tool-card"]', { timeout: 6000 });
    await page.waitForFunction(
      () =>
        (document.querySelector('[data-testid="console-pane"] [data-testid="console-log-output"]')?.textContent ?? "").includes(
          "RUN2_LIVE_STREAM",
        ),
      { timeout: 6000 },
    );

    // Release Run 2 so ledger records both Run 1 and Run 2
    fs.writeFileSync(releaseRun2Flag, "go");
    await run2Done;

    // 3. Execution Audit tab: summary strip + 4 inspector tabs including Context diff vs parent
    await clickReady(page, '[data-testid="tab-timeline"]');
    await page.waitForSelector('[data-testid="req-audit-summary"]', { timeout: 5000 });
    await page.waitForSelector('[data-testid="run-inspector-panel"]', { timeout: 5000 });
    await clickReady(page, `[data-testid="inspect-run-btn-${run2Started.run.id}"]`);
    await clickReady(page, '[data-testid="inspector-tab-context"]');
    await page.waitForSelector('[data-testid="context-handoff-md"]', { timeout: 5000 });
    await clickReady(page, '[data-testid="handoff-diff-btn"]');
    await page.waitForSelector('[data-testid="context-handoff-diff"]', { timeout: 5000 });
    await clickReady(page, '[data-testid="inspector-tab-usage"]');
    await page.waitForSelector('[data-testid="inspector-pane-usage"]', { timeout: 5000 });
    await clickReady(page, '[data-testid="inspector-tab-raw"]');
    await page.waitForSelector('[data-testid="inspector-pane-raw"]', { timeout: 5000 });

    // 4. Option A Global Insights view: topbar entry hides drawer, sets URL view=insights, and rolls up omp into opencode-go
    await clickReady(page, '[data-testid="topbar-insights-btn"]');
    await page.waitForSelector('[data-testid="insights-view"]', { timeout: 6000 });
    await page.waitForSelector('[data-testid="insights-kpi-grid"]', { timeout: 6000 });
    expect(page.url()).toContain("view=insights");
    const hasDrawerInInsights = await page.evaluate(
      () => Boolean(document.querySelector('[data-testid="drawer-tab-console"]')),
    );
    expect(hasDrawerInInsights).toBe(false);

    await page.waitForSelector('[data-testid="pool-row-opencode-go"]', { timeout: 5000 });
    const hasOmpPool = await page.evaluate(() => Boolean(document.querySelector('[data-testid="pool-row-omp"]')));
    expect(hasOmpPool).toBe(false);

    // Jump back from Insights into REQ-001 workspace
    await clickReady(page, '[data-testid="insights-jump-req-REQ-001"]');
    await page.waitForSelector('[data-testid="tab-timeline"]', { timeout: 6000 });

    expect(pageErrors).toEqual([]);
    expect(httpErrors).toEqual([]);
    expect(invokeCount).toBe(2);
    await page.close();
  }, { timeout: 30_000 });
});
