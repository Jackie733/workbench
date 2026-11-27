import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  acceptRequirement,
  approveDesign,
  createRequirement,
  initProject,
  linkRequirementGitHubIssue,
  propose,
  recordRequirementGitHubSync,
} from "../../src/core/engine.ts";
import { createOrReuseWorktree } from "../../src/core/worktree.ts";
import { observeGitSnapshot } from "../../src/core/git.ts";
import type { GitHubCommandDeps } from "../../src/core/github.ts";
import { runVerification } from "../../src/core/runner.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";
import { resolveTestBrowser } from "./browser_env.ts";

const browserEnv = resolveTestBrowser();
const HAS_BROWSER = browserEnv !== null;

interface BrowserPage {
  setViewport(vp: { width: number; height: number }): Promise<void>;
  goto(url: string, opts?: { waitUntil?: string }): Promise<unknown>;
  waitForSelector(sel: string, opts?: { timeout?: number }): Promise<unknown>;
  waitForFunction(fn: string | ((...args: unknown[]) => boolean), opts?: { timeout?: number }, ...args: unknown[]): Promise<unknown>;
  waitForNavigation(opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  click(sel: string): Promise<void>;
  select(sel: string, ...values: string[]): Promise<string[]>;
  type(sel: string, text: string): Promise<void>;
  evaluate<T>(fn: (...args: unknown[]) => T, ...args: unknown[]): Promise<T>;
  evaluateOnNewDocument(fn: () => void): Promise<unknown>;
  keyboard: { press(key: string): Promise<void> };
  on(ev: string, fn: (arg: Error) => void): void;
  close(): Promise<void>;
}

interface BrowserInstance {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

const tempDirs: string[] = [];
const servers: WorkbenchServerHandle[] = [];
const origHubEnv = process.env.WORKBENCH_HUB_DIR;
let browser: BrowserInstance | null = null;

// Evolution modal and quick-report UI were removed in Workbench v6.
const suite = describe.skip;

function writePromotedPainPoints(_entries: { id: string; title: string; reqId: string }[]): void {
  // No-op in v6 (evolution inbox removed).
}

function makeTempHub(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-reload-ui-hub-"));
  tempDirs.push(dir);
  process.env.WORKBENCH_HUB_DIR = dir;
}

function makeGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-reload-ui-"));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "workbench", version: "1.0.0" }, null, 2),
  );
  fs.mkdirSync(path.join(dir, "src", "web"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "web", "queries.ts"), "export const version = 1;\n");
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["branch", "-M", "main"], { cwd: dir, stdio: "ignore" });
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "wb-reload-ui-remote-"));
  tempDirs.push(bare);
  execFileSync("git", ["init", "--bare"], { cwd: bare, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", bare], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: dir, stdio: "ignore" });
  return dir;
}

/** 构造一个已完成验收、带有隔离沙箱与开启状态 PR 的需求。 */
async function prepareDoneRequirement(repo: string, webVersion: number, prNumber: number): Promise<string> {
  const detail = await createRequirement(repo, {
    goal: `同步 PR 热刷新验证 ${prNumber}`,
    criteria: [{ id: "AC-1", description: "passes", required: true, command: "echo ok" }],
  });
  const reqId = detail.state.id;
  await propose(repo, reqId, { designMarkdown: "# Design", actor: "agent" });
  const base = await observeGitSnapshot(repo);
  await approveDesign(repo, reqId, { baseline: base });
  // 验收快照触及 src/web：同步合并并清理沙箱后应触发服务端热重建与 reload_ui 广播。
  fs.writeFileSync(path.join(repo, "src", "web", "queries.ts"), `export const version = ${webVersion};\n`);
  await runVerification(repo, reqId, { command: "echo ok", criterionIds: ["AC-1"] });
  const acceptedSnap = await observeGitSnapshot(repo);
  await acceptRequirement(repo, reqId, { currentCodeSnapshotHash: acceptedSnap!.fingerprint });
  await createOrReuseWorktree(repo, reqId);
  await linkRequirementGitHubIssue(repo, reqId, {
    repo: "acme/workbench",
    issue: {
      number: 70,
      url: "https://github.com/acme/workbench/issues/70",
      title: "Linked",
      state: "open",
      lastSyncedAt: Date.now(),
    },
  });
  await recordRequirementGitHubSync(repo, reqId, {
    prPatch: {
      number: prNumber,
      url: `https://github.com/acme/workbench/pull/${prNumber}`,
      title: `${reqId} PR`,
      headBranch: `rsi/${reqId}`,
      baseBranch: "main",
      state: "open",
      mergedAt: null,
      lastSyncedAt: Date.now(),
    },
    eventKind: "github_pr_synced",
    summary: `Created PR #${prNumber}`,
  });
  return reqId;
}

function makeGitHubDeps(prStates: Record<number, { baseBranch: string; headBranch: string }>): GitHubCommandDeps {
  return {
    getRemoteUrl: async () => "https://github.com/acme/workbench.git",
    resolveDefaultBaseBranch: async () => "main",
    whichGh: () => "/usr/bin/gh",
    runGh: async (_bin, args) => {
      if (args[0] === "auth" && args[1] === "status") {
        return { code: 0, stdout: "Logged in to github.com account alice", stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "view") {
        const num = Number(args[2]);
        const target = prStates[num];
        if (!target) return { code: 1, stdout: "", stderr: `Could not resolve to a PullRequest #${num}` };
        return {
          code: 0,
          stdout: JSON.stringify({
            number: num,
            url: `https://github.com/acme/workbench/pull/${num}`,
            title: `PR #${num}`,
            state: "MERGED",
            mergedAt: new Date().toISOString(),
            baseRefName: target.baseBranch,
            headRefName: target.headBranch,
          }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

async function isToastPending(page: BrowserPage): Promise<boolean> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-slot="toast-root"]')).some((el) => {
      const text = el.textContent ?? "";
      return text.includes("工作台前端已热编译更新") && text.includes("立即刷新");
    }),
  );
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
  if (origHubEnv === undefined) delete process.env.WORKBENCH_HUB_DIR;
  else process.env.WORKBENCH_HUB_DIR = origHubEnv;
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

afterAll(async () => {
  await browser?.close();
});

suite("REQ-008 同步 PR 不打断已打开弹窗", () => {
  test("自动热刷新在弹窗打开时暂缓、数据原地更新、关闭弹窗后补刷且手动热重建仍即时刷新", async () => {
    makeTempHub();
    const repo = makeGitRepo();
    await initProject(repo, { name: "workbench", privacyMode: "local" });
    const req1 = await prepareDoneRequirement(repo, 2, 77);
    const req2 = await prepareDoneRequirement(repo, 3, 78);
    writePromotedPainPoints([
      { id: "EVO-1", title: "同步 PR 关闭了自进化中心弹窗", reqId: req1 },
      { id: "EVO-2", title: "同步第二个 PR 再次触发热刷新", reqId: req2 },
    ]);

    const server = await startWorkbenchServer({
      root: repo,
      port: 0,
      writeDiscovery: false,
      hubMode: true,
      githubDeps: makeGitHubDeps({
        77: { baseBranch: "main", headBranch: `rsi/${req1}` },
        78: { baseBranch: "main", headBranch: `rsi/${req2}` },
      }),
    });
    servers.push(server);

    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));
    try {
      await page.setViewport({ width: 1360, height: 860 });
      await page.evaluateOnNewDocument(() => {
        const loads = Number(localStorage.getItem("__req008Loads") ?? "0");
        localStorage.setItem("__req008Loads", String(loads + 1));
      });
      await page.goto(server.url, { waitUntil: "networkidle2" });

      await page.waitForSelector('[data-testid="open-evolution-btn"]', { timeout: 15_000 });
      await page.click('[data-testid="open-evolution-btn"]');
      await page.waitForSelector('[data-testid="evolution-modal"]', { timeout: 10_000 });
      await page.waitForSelector('[data-testid="sync-pain-pr-EVO-1"]', { timeout: 15_000 });

      const modalTextBefore = await page.evaluate(
        () => document.querySelector('[data-testid="evolution-modal"]')?.textContent ?? "",
      );
      expect(modalTextBefore).toContain("PR #77");

      // 探针：整页重载会清空 window 变量；localStorage 计数可发现多次重载。
      await page.evaluate(() => {
        (window as unknown as { __req008Marker?: string }).__req008Marker = "alive";
      });
      expect(await page.evaluate(() => Number(localStorage.getItem("__req008Loads")))).toBe(1);

      await page.click('[data-testid="sync-pain-pr-EVO-1"]');
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll('[data-slot="toast-root"]')).some((el) => {
            const text = el.textContent ?? "";
            return text.includes("工作台前端已热编译更新") && text.includes("立即刷新");
          }),
        { timeout: 20_000 },
      );

      // 弹窗仍打开、探针仍在，且弹窗数据已原地刷新（清理后的沙箱不再显示旧 PR 徽标）。
      expect(
        await page.evaluate(() => (window as unknown as { __req008Marker?: string }).__req008Marker === "alive"),
      ).toBe(true);
      expect(await page.evaluate(() => Boolean(document.querySelector('[data-testid="evolution-modal"]')))).toBe(true);
      await page.waitForFunction(
        () => !(document.querySelector('[data-testid="pain-item-EVO-1"]')?.textContent ?? "").includes("PR #77"),
        { timeout: 10_000 },
      );

      // 重复的自动热刷新事件只保留一条持久提示，且不会排队多次整页重载。
      await page.click('[data-testid="sync-pain-pr-EVO-2"]');
      await page.waitForFunction(
        () => !(document.querySelector('[data-testid="pain-item-EVO-2"]')?.textContent ?? "").includes("PR #78"),
        { timeout: 20_000 },
      );
      expect(await isToastPending(page)).toBe(true);
      const pendingToastCount = await page.evaluate(
        () =>
          Array.from(document.querySelectorAll('[data-slot="toast-root"]')).filter((el) => {
            const text = el.textContent ?? "";
            return text.includes("工作台前端已热编译更新");
          }).length,
      );
      expect(pendingToastCount).toBe(1);
      expect(await page.evaluate(() => (window as unknown as { __req008Marker?: string }).__req008Marker === "alive")).toBe(true);
      expect(await page.evaluate(() => Number(localStorage.getItem("__req008Loads")))).toBe(1);

      // 关闭弹窗后空闲补刷：整页只重载一次。
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20_000 }),
        page.keyboard.press("Escape"),
      ]);
      await page.waitForSelector('[data-testid="open-evolution-btn"]', { timeout: 15_000 });
      expect(await page.evaluate(() => (window as unknown as { __req008Marker?: string }).__req008Marker ?? null)).toBeNull();
      expect(await page.evaluate(() => Number(localStorage.getItem("__req008Loads")))).toBe(2);

      // 重载后应用正常渲染，PR 合并状态已由渐进数据链落地。
      await page.click('[data-action="set-scope"][data-value="done"]');
      await page.waitForSelector(`[data-testid="req-row-${req1}"]`, { timeout: 10_000 });
      await page.click(`[data-testid="req-row-${req1}"]`);
      await page.waitForSelector('[data-testid="more-menu-btn"]', { timeout: 10_000 });
      await page.click('[data-testid="more-menu-btn"]');
      await page.waitForSelector('[data-testid="ws-github-pr-link"]', { timeout: 10_000 });
      const prLink = await page.evaluate(
        () => document.querySelector('[data-testid="ws-github-pr-link"]')?.textContent ?? "",
      );
      expect(prLink).toContain("PR #77");
      expect(prLink).toContain("已合并");
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 120_000);

  test("手动热重建前端在弹窗打开时仍即时刷新", async () => {
    makeTempHub();
    const repo = makeGitRepo();
    await initProject(repo, { name: "workbench", privacyMode: "local" });
    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, hubMode: true });
    servers.push(server);

    const page = await browser!.newPage();
    try {
      await page.setViewport({ width: 1360, height: 860 });
      await page.goto(server.url, { waitUntil: "networkidle2" });
      await page.waitForSelector('[data-testid="open-evolution-btn"]', { timeout: 15_000 });
      await page.click('[data-testid="open-evolution-btn"]');
      await page.waitForSelector('[data-testid="evolution-modal"]', { timeout: 10_000 });
      await page.click('[data-testid="evo-tab-telemetry"]');
      await page.waitForSelector('[data-testid="reload-web-btn"]', { timeout: 10_000 });
      await page.evaluate(() => {
        (window as unknown as { __req008Marker?: string }).__req008Marker = "alive";
      });

      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30_000 }),
        page.click('[data-testid="reload-web-btn"]'),
      ]);
      await page.waitForSelector('[data-testid="open-evolution-btn"]', { timeout: 15_000 });
      expect(await page.evaluate(() => (window as unknown as { __req008Marker?: string }).__req008Marker ?? null)).toBeNull();
      expect(await page.evaluate(() => Boolean(document.querySelector('[data-testid="evolution-modal"]')))).toBe(false);
    } finally {
      await page.close();
    }
  }, 90_000);
});
