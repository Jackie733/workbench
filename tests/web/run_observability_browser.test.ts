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
  setRequestInterception(enabled: boolean): Promise<void>;
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
    await page.waitForFunction(() => window.innerWidth === 1360 && window.innerHeight === 860, { timeout: 5000 });

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
    // Keep the head/base click path on the same fixed viewport and historical-run state.
    await page.setViewport({ width: 1360, height: 860 });
    await page.waitForFunction(() => window.innerWidth === 1360 && window.innerHeight === 860, { timeout: 5000 });
    const jumpPreconditions = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      selectedRunId:
        document.querySelector<HTMLSelectElement>('[data-testid="right-drawer"] .console-toolbar select')?.value ?? "",
      timelineActive: Boolean(document.querySelector('[data-testid="tab-timeline"]')?.classList.contains("active")),
    }));
    expect(jumpPreconditions).toEqual({
      width: 1360,
      height: 860,
      selectedRunId: run1Started.run.id,
      timelineActive: true,
    });
    await page.waitForFunction(
      () => {
        if (window.innerWidth !== 1360 || window.innerHeight !== 860) return false;
        const drawer = document.querySelector('[data-testid="right-drawer"]');
        const backdrop = document.querySelector(".drawer-backdrop");
        const button = document.querySelector<HTMLElement>(
          '[data-testid="jump-to-live-run-btn"]:not([disabled])',
        );
        if (!drawer || !button || !button.isConnected) return false;
        if (!drawer.classList.contains("open") || drawer.getAttribute("aria-hidden") !== "false") return false;
        if (["entering", "opening", "closing"].some((phase) => drawer.classList.contains(phase))) return false;
        const animations = [...drawer.getAnimations(), ...(backdrop?.getAnimations() ?? [])];
        if (animations.some((animation) => animation.playState === "running")) return false;

        const rect = button.getBoundingClientRect();
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          rect.left < 0 ||
          rect.top < 0 ||
          rect.right > window.innerWidth ||
          rect.bottom > window.innerHeight
        ) {
          return false;
        }
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return Boolean(hit && (hit === button || button.contains(hit)) && hit.closest("button") === button);
      },
      { timeout: 5000 },
    );
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

    await clickReady(page, '[data-testid="toggle-drawer-btn"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="right-drawer"].open'), { timeout: 5000 });

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

    // The requirement's audit tab remains usable through the accepted wide-to-phone viewport matrix.
    const responsiveWidths = [1440, 1360, 1280, 1024, 821, 820, 768, 390, 375, 320, 1440];
    const waitForDrawerStable = async (open: boolean) => {
      try {
        await page.waitForFunction(
          (expectedOpen: unknown) => {
            const shouldBeOpen = Boolean(expectedOpen);
            const drawer = document.querySelector('[data-testid="right-drawer"]');
            if (!drawer) return false;
            const backdrop = document.querySelector(".drawer-backdrop");
            const animations = [...drawer.getAnimations(), ...(backdrop?.getAnimations() ?? [])];
            const stateMatches = shouldBeOpen
              ? drawer.classList.contains("open") &&
                drawer.getAttribute("aria-hidden") === "false" &&
                !["entering", "opening", "closing"].some((phase) => drawer.classList.contains(phase))
              : drawer.classList.contains("collapsed") &&
                drawer.classList.contains("settled") &&
                drawer.getAttribute("aria-hidden") === "true";
            return stateMatches && animations.every((animation) => animation.playState !== "running");
          },
          { timeout: 5000 },
          open,
        );
      } catch (error) {
        const state = await page.evaluate(() => {
          const drawer = document.querySelector('[data-testid="right-drawer"]');
          const backdrop = document.querySelector(".drawer-backdrop");
          return {
            width: window.innerWidth,
            className: drawer?.className ?? "missing",
            ariaHidden: drawer?.getAttribute("aria-hidden") ?? "missing",
            runningAnimations: [...(drawer?.getAnimations() ?? []), ...(backdrop?.getAnimations() ?? [])]
              .filter((animation) => animation.playState === "running")
              .map((animation) => animation.effect?.getTiming().duration ?? "unknown"),
          };
        });
        throw new Error(`Drawer failed to stabilize (${open ? "open" : "closed"}): ${JSON.stringify(state)}; ${String(error)}`);
      }
    };
    const expectVisibleRun2Selection = async () => {
      await page.waitForFunction(
        () => {
          const select = document.querySelector<HTMLSelectElement>('[data-testid="right-drawer"] .console-toolbar select');
          const rect = select?.getBoundingClientRect();
          const style = select ? getComputedStyle(select) : null;
          return Boolean(select && style?.display !== "none" && style?.visibility !== "hidden" && rect && rect.width > 0 && rect.height > 0);
        },
        { timeout: 5000 },
      );
      const selection = await page.evaluate(() => {
        const select = document.querySelector<HTMLSelectElement>('[data-testid="right-drawer"] .console-toolbar select');
        const rect = select?.getBoundingClientRect();
        const style = select ? getComputedStyle(select) : null;
        return {
          runId: select?.value ?? "",
          visible: Boolean(select && style?.display !== "none" && style?.visibility !== "hidden" && rect && rect.width > 0 && rect.height > 0),
        };
      });
      expect(selection.runId).toBe(run2Started.run.id);
      expect(selection.visible).toBe(true);
    };
    for (const width of responsiveWidths) {
      await page.setViewport({ width, height: 820 });
      await page.waitForFunction(
        (expectedWidth: unknown) => window.innerWidth === Number(expectedWidth) && window.innerHeight === 820,
        { timeout: 5000 },
        width,
      );
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const auditLayout = await page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        mainWidth: document.querySelector(".main-stage")?.getBoundingClientRect().width ?? 0,
        selectedRequirement: document.querySelector(".app-req-id")?.textContent?.trim() ?? "",
        hasAuditSummary: Boolean(document.querySelector('[data-testid="req-audit-summary"]')),
        timelineActive: Boolean(document.querySelector('[data-testid="tab-timeline"]')?.classList.contains("active")),
      }));
      expect(auditLayout.viewportWidth).toBe(width);
      expect(auditLayout.viewportHeight).toBe(820);
      expect(auditLayout.overflow).toBe(false);
      expect(auditLayout.mainWidth).toBeGreaterThan(250);
      expect(auditLayout.selectedRequirement).toBe("REQ-001");
      expect(auditLayout.hasAuditSummary).toBe(true);
      expect(auditLayout.timelineActive).toBe(true);
      await clickReady(page, '[data-testid="toggle-drawer-btn"]');
      await waitForDrawerStable(true);
      await expectVisibleRun2Selection();
      await clickReady(page, width === 1440 ? '[data-testid="toggle-drawer-btn"]' : '[data-testid="drawer-close-btn"]');
      await waitForDrawerStable(false);
    }

    // 4. Option A Global Insights view: topbar entry hides drawer, sets URL view=insights, and rolls up omp into opencode-go
    await page.setViewport({ width: 1360, height: 820 });
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

    for (const width of responsiveWidths) {
      await page.setViewport({ width, height: 820 });
      await page.waitForFunction(
        (expectedWidth: unknown) => window.innerWidth === Number(expectedWidth) && window.innerHeight === 820,
        { timeout: 5000 },
        width,
      );
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const insightsLayout = await page.evaluate(() => ({
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        contentWidth: document.querySelector('[data-testid="insights-view"]')?.getBoundingClientRect().width ?? 0,
        hasKpis: Boolean(document.querySelector('[data-testid="insights-kpi-grid"]')),
        routeStillInsights: new URL(window.location.href).searchParams.get("view") === "insights",
      }));
      expect(insightsLayout.viewportWidth).toBe(width);
      expect(insightsLayout.viewportHeight).toBe(820);
      expect(insightsLayout.overflow).toBe(false);
      expect(insightsLayout.contentWidth).toBeGreaterThan(250);
      expect(insightsLayout.hasKpis).toBe(true);
      expect(insightsLayout.routeStillInsights).toBe(true);
    }

    // Jump back from Insights into REQ-001 workspace
    await page.setViewport({ width: 1360, height: 820 });
    await clickReady(page, '[data-testid="insights-jump-req-REQ-001"]');
    await page.waitForSelector('[data-testid="tab-timeline"]', { timeout: 6000 });

    await clickReady(page, '[data-testid="toggle-drawer-btn"]');
    await waitForDrawerStable(true);
    await expectVisibleRun2Selection();
    await clickReady(page, '[data-testid="drawer-close-btn"]');
    await waitForDrawerStable(false);

    await page.setViewport({ width: 820, height: 820 });
    await page.waitForFunction(() => window.innerWidth === 820 && window.innerHeight === 820, { timeout: 5000 });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await clickReady(page, '[data-testid="toggle-drawer-btn"]');
    await waitForDrawerStable(true);
    await expectVisibleRun2Selection();
    await clickReady(page, '[data-testid="toggle-sidebar-btn"]');
    await page.waitForFunction(
      () => Boolean(document.querySelector('[data-testid="hub-sidebar"].open')) && !document.querySelector('[data-testid="right-drawer"].open'),
      { timeout: 5000 },
    );
    const mobilePanelState = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      sidebarOpen: Boolean(document.querySelector('[data-testid="hub-sidebar"].open')),
      drawerOpen: Boolean(document.querySelector('[data-testid="right-drawer"].open')),
    }));
    expect(mobilePanelState).toEqual({ viewportWidth: 820, viewportHeight: 820, sidebarOpen: true, drawerOpen: false });
    await clickReady(page, '.sb-close-btn');
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="hub-sidebar"].open') && !document.querySelector('[data-testid="right-drawer"].open'),
      { timeout: 5000 },
    );
    await clickReady(page, '[data-testid="toggle-drawer-btn"]');
    await waitForDrawerStable(true);
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="hub-sidebar"].open') && Boolean(document.querySelector('[data-testid="right-drawer"].open')),
      { timeout: 5000 },
    );
    await expectVisibleRun2Selection();

    expect(pageErrors).toEqual([]);
    expect(httpErrors).toEqual([]);
    expect(invokeCount).toBe(2);
    await page.close();
  }, { timeout: 30_000 });
});
