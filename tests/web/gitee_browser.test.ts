import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  acceptRequirement,
  approveDesign,
  initProject,
  propose,
  updateProjectConfig,
} from "../../src/core/engine.ts";
import { observeGitSnapshot } from "../../src/core/git.ts";
import type { GiteeApiDeps } from "../../src/core/gitee.ts";
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
  click(sel: string): Promise<void>;
  select(sel: string, ...values: string[]): Promise<string[]>;
  type(sel: string, text: string): Promise<void>;
  evaluate<T>(fn: (...args: any[]) => T, ...args: any[]): Promise<T>;
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

function makeGiteeGitRepo(): { repo: string; bareRemote: string } {
  const bareRemote = fs.mkdtempSync(path.join(os.tmpdir(), "wb-gitee-web-bare-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wb-gitee-web-repo-"));
  tempDirs.push(bareRemote, repo);

  execFileSync("git", ["init", "--bare", "--initial-branch=master"], { cwd: bareRemote, stdio: "ignore" });
  execFileSync("git", ["init", "-b", "master"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", bareRemote], { cwd: repo, stdio: "ignore" });
  fs.writeFileSync(path.join(repo, "app.ts"), "export const v = 1;\n");
  execFileSync("git", ["add", "app.ts"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["push", "-u", "origin", "master"], { cwd: repo, stdio: "ignore" });
  return { repo, bareRemote };
}

function makeTempHub(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-gitee-web-hub-"));
  tempDirs.push(dir);
  process.env.WORKBENCH_HUB_DIR = dir;
  return dir;
}

function createMockGiteeDeps() {
  const prs = new Map<number, { number: number; title: string; body: string }>();
  let nextPr = 31;

  const giteeDeps: GiteeApiDeps = {
    getRemoteUrl: async () => "git@gitee.com:openstring/deepmdt-frontend-pc.git",
    resolveDefaultBaseBranch: async () => "master",
    fetch: async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const body =
        typeof init?.body === "string" && init.body.trim()
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
      if (!auth.includes("web-gitee-token")) {
        return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
      }
      const u = new URL(url);
      const p = u.pathname;
      if (method === "GET" && p === "/api/v5/user") {
        return new Response(JSON.stringify({ login: "jackie", name: "Jackie" }), { status: 200 });
      }
      if (method === "GET" && p === "/api/v5/user/issues") {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (method === "GET" && p === "/api/v5/enterprises/openstring/issues") {
        if (u.searchParams.get("state") === "open") {
          return new Response(
            JSON.stringify([
              {
                number: "I8WEB1",
                html_url: "https://e.gitee.com/openstring/issues/list?issue=I8WEB1",
                title: "PC工作台筛选栏优化",
                body: "无仓库工作项详情正文",
                state: "open",
                issue_state_detail: { title: "开启" },
                issue_type_detail: { title: "需求" },
                labels: [{ name: "ui" }],
                repository: null,
                program: { name: "DeepMDT 3.0" },
                updated_at: "2026-11-18T15:00:00+08:00",
              },
            ]),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (method === "GET" && p === "/api/v5/repos/openstring/deepmdt-frontend-pc/pulls") {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (method === "POST" && p === "/api/v5/repos/openstring/deepmdt-frontend-pc/pulls") {
        const num = nextPr++;
        const pr = {
          number: num,
          html_url: `https://gitee.com/openstring/deepmdt-frontend-pc/pulls/${num}`,
          title: String(body?.title ?? ""),
          body: String(body?.body ?? ""),
          state: "open",
          head: { ref: String(body?.head ?? "") },
          base: { ref: String(body?.base ?? "master") },
          merged_at: null,
        };
        prs.set(num, { number: num, title: pr.title, body: pr.body });
        return new Response(JSON.stringify(pr), { status: 201 });
      }
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    },
  };

  return { giteeDeps, prs };
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

describe("Gitee Web UI workflow", () => {
  test("configures Gitee token in settings, imports unlinked Gitee work item, and creates linked Gitee PR", async () => {
    makeTempHub();
    const { repo } = makeGiteeGitRepo();
    await initProject(repo, { name: "deepmdt-frontend-pc", privacyMode: "local" });
    await updateProjectConfig(repo, {
      gitee: { repo: "openstring/deepmdt-frontend-pc", enterprise: "openstring", defaultBaseBranch: "master" },
    });

    const { giteeDeps, prs } = createMockGiteeDeps();
    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, giteeDeps });
    servers.push(server);

    expect(HAS_BROWSER).toBe(true);
    const page = await browser!.newPage();
    try {
      await page.setViewport({ width: 1360, height: 860 });
      await page.goto(server.url, { waitUntil: "networkidle2" });

      // 1. Open Settings -> configure Gitee Token.
      await page.waitForSelector('[data-testid="open-routing-btn"]', { timeout: 5000 });
      await page.click('[data-testid="open-routing-btn"]');
      await page.waitForSelector('[data-testid="hub-gitee-token-input"]', { timeout: 5000 });
      await page.type('[data-testid="hub-gitee-token-input"]', "web-gitee-token");
      await page.click('[data-testid="save-routing-btn"]');
      await page.waitForFunction(() => !document.querySelector('[data-testid="routing-modal"]'), { timeout: 5000 });

      // 2. Open New Requirement -> switch to Gitee import tab -> list and select #I8WEB1 -> import draft.
      await page.click('[data-testid="new-req-btn"]');
      await page.waitForSelector('[data-testid="new-req-mode-import"]', { timeout: 5000 });
      const tabLabel = await page.evaluate(
        () => document.querySelector('[data-testid="new-req-mode-import"]')?.textContent ?? "",
      );
      expect(tabLabel).toContain("Gitee");
      await page.click('[data-testid="new-req-mode-import"]');

      await page.waitForSelector('[data-testid="gitee-issue-item-I8WEB1"]', { timeout: 5000 });
      const itemText = await page.evaluate(
        () => document.querySelector('[data-testid="gitee-issue-item-I8WEB1"]')?.textContent ?? "",
      );
      expect(itemText).toContain("PC工作台筛选栏优化");
      expect(itemText).toContain("未绑定仓库");

      await page.click('[data-testid="gitee-issue-item-I8WEB1"]');
      await page.click('[data-testid="import-issue-draft-btn"]');

      await page.waitForSelector('[data-testid="ws-github-issue-link"]', { timeout: 5000 });
      const badgeText = await page.evaluate(
        () => document.querySelector('[data-testid="ws-github-issue-link"]')?.textContent ?? "",
      );
      expect(badgeText).toContain("#I8WEB1");

      // 3. Complete design, verify, accept in backend, then deliver Gitee PR in browser UI.
      await propose(repo, "REQ-001", {
        designMarkdown: "# Design\nImprove filters.",
        criteria: [{ id: "AC-1", description: "passes", required: true, command: "echo ok" }],
        actor: "agent",
      });
      const baseSnap = await observeGitSnapshot(repo);
      await approveDesign(repo, "REQ-001", { baseline: baseSnap });
      fs.writeFileSync(path.join(repo, "app.ts"), "export const v = 2;\n");
      await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
      const accSnap = await observeGitSnapshot(repo);
      await acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: accSnap!.fingerprint });

      await page.goto(server.url, { waitUntil: "networkidle2" });
      await page.waitForSelector('[data-action="set-scope"][data-value="done"]', { timeout: 5000 });
      await page.click('[data-action="set-scope"][data-value="done"]');
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 5000 });
      await page.click('[data-testid="req-row-REQ-001"]');

      await page.waitForSelector('[data-testid="open-deliver-btn"]', { timeout: 10000 });
      await page.click('[data-testid="open-deliver-btn"]');
      await page.waitForSelector('[data-testid="deliver-mode-pr"]', { timeout: 5000 });
      await page.click('[data-testid="deliver-mode-pr"]');

      await page.waitForFunction(
        () => (document.querySelector('[data-testid="submit-deliver-btn"]')?.textContent ?? "").includes("Gitee PR"),
        { timeout: 5000 },
      );
      await page.click('[data-testid="submit-deliver-btn"]');
      await page.waitForSelector('[data-testid="ws-github-pr-link"]', { timeout: 10000 });

      const prBadge = await page.evaluate(
        () => document.querySelector('[data-testid="ws-github-pr-link"]')?.textContent ?? "",
      );
      expect(prBadge).toContain("PR #31");
      expect(prs.get(31)?.body).toContain("Closes #I8WEB1");
    } finally {
      await page.close();
    }
  }, { timeout: 30_000 });

  test("allows manually switching an SSH-aliased project to Gitee in Project Settings", async () => {
    makeTempHub();
    const { repo } = makeGiteeGitRepo();
    await initProject(repo, { name: "ssh-alias-project", privacyMode: "local" });

    const { giteeDeps } = createMockGiteeDeps();
    const aliasDeps: GiteeApiDeps = {
      ...giteeDeps,
      getRemoteUrl: async () => "git@gitee-work:openstring/deepmdt-frontend-pc.git",
    };
    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, giteeDeps: aliasDeps });
    servers.push(server);

    expect(HAS_BROWSER).toBe(true);
    const page = await browser!.newPage();
    try {
      await page.setViewport({ width: 1360, height: 860 });
      await page.goto(server.url, { waitUntil: "networkidle2" });

      await page.waitForSelector('[data-testid="open-routing-btn"]', { timeout: 5000 });
      await page.click('[data-testid="open-routing-btn"]');
      await page.waitForSelector('[data-testid="settings-tab-project"]', { timeout: 5000 });
      await page.click('[data-testid="settings-tab-project"]');

      await page.waitForSelector('[data-testid="project-provider-gitee"]', { timeout: 5000 });
      await page.click('[data-testid="project-provider-gitee"]');
      await page.waitForSelector('[data-testid="project-gitee-repo-input"]', { timeout: 5000 });
      await page.type('[data-testid="project-gitee-repo-input"]', "openstring/deepmdt-frontend-pc");
      await page.type('[data-testid="project-gitee-enterprise-input"]', "openstring");
      await page.click('[data-testid="save-project-btn"]');
      await page.waitForFunction(() => !document.querySelector('[data-testid="routing-modal"]'), { timeout: 5000 });

      await page.click('[data-testid="new-req-btn"]');
      await page.waitForSelector('[data-testid="new-req-mode-import"]', { timeout: 5000 });
      const tabLabel = await page.evaluate(
        () => document.querySelector('[data-testid="new-req-mode-import"]')?.textContent ?? "",
      );
      expect(tabLabel).toContain("Gitee");
    } finally {
      await page.close();
    }
  }, { timeout: 30_000 });

  test("renders localized Gitee auth failure without Chinese prefix in English UI across Settings and Import", async () => {
    makeTempHub();
    const { repo } = makeGiteeGitRepo();
    await initProject(repo, { name: "deepmdt-frontend-pc", privacyMode: "local" });
    await updateProjectConfig(repo, {
      gitee: { repo: "openstring/deepmdt-frontend-pc", enterprise: "openstring", defaultBaseBranch: "master" },
    });

    const { giteeDeps } = createMockGiteeDeps();
    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, giteeDeps });
    servers.push(server);

    expect(HAS_BROWSER).toBe(true);
    const page = await browser!.newPage();
    try {
      await page.setViewport({ width: 1360, height: 860 });
      await page.goto(server.url, { waitUntil: "networkidle2" });

      // 1. Save an invalid token that triggers mock HTTP 401 Unauthorized, then switch UI to English.
      await page.waitForSelector('[data-testid="open-routing-btn"]', { timeout: 5000 });
      await page.click('[data-testid="open-routing-btn"]');
      await page.waitForSelector('[data-testid="hub-gitee-token-input"]', { timeout: 5000 });
      await page.type('[data-testid="hub-gitee-token-input"]', "bad-gitee-token");
      await page.click('[data-testid="save-routing-btn"]');
      await page.waitForFunction(() => !document.querySelector('[data-testid="routing-modal"]'), { timeout: 5000 });

      await page.select('[data-testid="ui-language-select"]', "en");
      await page.waitForFunction(() => document.documentElement.lang === "en", { timeout: 5000 });

      // 2. Settings -> Project tab displays English Gitee auth failure with HTTP status & upstream detail.
      await page.click('[data-testid="open-routing-btn"]');
      await page.waitForSelector('[data-testid="settings-tab-project"]', { timeout: 5000 });
      await page.click('[data-testid="settings-tab-project"]');
      await page.waitForSelector('[data-testid="project-provider-status"]', { timeout: 5000 });
      const badgeText = await page.evaluate(
        () => document.querySelector('[data-testid="project-provider-status"]')?.textContent ?? "",
      );
      expect(badgeText).toBe("Gitee Access Token verification failed (HTTP 401): Unauthorized");
      expect(/[\u4e00-\u9fff]/.test(badgeText)).toBe(false);
      await page.evaluate(() => {
        const modal = document.querySelector('[data-testid="routing-modal"]');
        const closeBtn = Array.from(modal?.querySelectorAll("button") ?? []).find(
          (b) => b.textContent?.trim() === "Cancel",
        );
        closeBtn?.click();
      });
      await page.waitForFunction(() => !document.querySelector('[data-testid="routing-modal"]'), { timeout: 5000 });

      // 3. New requirement -> Gitee import pane displays English auth failure without Chinese prefix.
      await page.click('[data-testid="new-req-btn"]');
      await page.waitForSelector('[data-testid="new-req-mode-import"]', { timeout: 5000 });
      await page.click('[data-testid="new-req-mode-import"]');
      await page.waitForSelector('[data-testid="gitee-import-pane"]', { timeout: 5000 });
      const importText = await page.evaluate(
        () => document.querySelector('[data-testid="gitee-import-pane"]')?.textContent ?? "",
      );
      expect(importText).toContain("Gitee Access Token verification failed (HTTP 401): Unauthorized");
      expect(/[\u4e00-\u9fff]/.test(importText)).toBe(false);
    } finally {
      await page.close();
    }
  }, { timeout: 30_000 });
});
