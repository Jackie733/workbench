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
} from "../../src/core/engine.ts";
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

function makeGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-del-web-"));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "app.ts"), "export const v = 1;\n");
  execFileSync("git", ["add", "app.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function makeTempHub(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-del-web-hub-"));
  tempDirs.push(dir);
  process.env.WORKBENCH_HUB_DIR = dir;
  return dir;
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

describe("post-acceptance delivery wrap-up UI", () => {
  test("done requirement prompts for uncommitted changes, preselects accepted files in deliver modal, and commits via Web UI", async () => {
    makeTempHub();
    const repo = makeGitRepo();
    await initProject(repo, { name: "DeliverWebRepo", privacyMode: "local" });

    await createRequirement(repo, {
      goal: "Ship delivery flow",
      criteria: [{ id: "AC-1", description: "passes", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design", actor: "agent" });
    const base = await observeGitSnapshot(repo);
    await approveDesign(repo, "REQ-001", { baseline: base });

    fs.writeFileSync(path.join(repo, "app.ts"), "export const v = 2;\n");
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const accSnap = await observeGitSnapshot(repo);
    await acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: accSnap!.fingerprint });

    // Extra unrelated file added after acceptance
    fs.writeFileSync(path.join(repo, "scratch.ts"), "export const scratch = true;\n");

    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false });
    servers.push(server);

    expect(HAS_BROWSER).toBe(true);
    const page = await browser!.newPage();
    try {
      await page.setViewport({ width: 1360, height: 860 });
      await page.goto(server.url, { waitUntil: "networkidle2" });
      await page.waitForSelector('[data-action="set-scope"][data-value="done"]', { timeout: 5000 });
      await page.click('[data-action="set-scope"][data-value="done"]');
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 5000 });
      await page.click('[data-testid="req-row-REQ-001"]');

      await page.waitForSelector('[data-testid="open-deliver-btn"]', { timeout: 15000 });
      await page.waitForSelector('[data-testid="delivery-pending-hint"]', { timeout: 5000 });

      await page.click('[data-testid="open-deliver-btn"]');
      await page.waitForSelector('[data-testid="deliver-modal"]', { timeout: 5000 });

      const selectionState = await page.evaluate(() => ({
        appChecked: (document.querySelector('[data-testid="deliver-file-app.ts"]') as HTMLInputElement | null)?.checked,
        scratchChecked: (document.querySelector('[data-testid="deliver-file-scratch.ts"]') as HTMLInputElement | null)?.checked,
        modalText: document.querySelector('[data-testid="deliver-modal"]')?.textContent ?? "",
      }));
      expect(selectionState.appChecked).toBe(true);
      expect(selectionState.scratchChecked).toBe(false);
      expect(selectionState.modalText).toContain("本次验收");
      expect(selectionState.modalText).toContain("工作区其他");

      await page.click('[data-testid="submit-deliver-btn"]');
      await page.waitForSelector('[data-testid="delivery-summary-line"]', { timeout: 5000 });

      const summaryText = await page.evaluate(
        () => document.querySelector('[data-testid="delivery-summary-line"]')?.textContent ?? "",
      );
      expect(summaryText).toContain("已交付提交");
      expect(summaryText).toContain("1 个文件");

      // Confirm only app.ts was committed and scratch.ts remains untracked
      const committed = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], {
        cwd: repo,
        encoding: "utf8",
      }).trim();
      expect(committed).toBe("app.ts");
      const status = execFileSync("git", ["status", "--short"], { cwd: repo, encoding: "utf8" }).trim();
      expect(status).toBe("?? scratch.ts");
    } finally {
      await page.close();
    }
  }, { timeout: 30_000 });

  test("localizes GitHub Issue creation, PR delivery, and PR status sync errors in English UI", async () => {
    makeTempHub();
    const repo = makeGitRepo();
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "wb-del-remote-"));
    tempDirs.push(bare);
    execFileSync("git", ["init", "--bare"], { cwd: bare, stdio: "ignore" });
    execFileSync("git", ["branch", "-M", "main"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", bare], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repo, stdio: "ignore" });

    await initProject(repo, { name: "DeliverGitHubErrRepo", privacyMode: "local" });
    await createRequirement(repo, {
      goal: "Ship GitHub error i18n",
      criteria: [{ id: "AC-1", description: "passes", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design", actor: "agent" });
    const base = await observeGitSnapshot(repo);
    await approveDesign(repo, "REQ-001", { baseline: base });

    fs.writeFileSync(path.join(repo, "app.ts"), "export const v = 2;\n");
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const accSnap = await observeGitSnapshot(repo);
    await acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: accSnap!.fingerprint });

    let prCreateAttempts = 0;
    const githubDeps: GitHubCommandDeps = {
      getRemoteUrl: async () => "https://github.com/acme/demo.git",
      resolveDefaultBaseBranch: async () => "main",
      whichGh: () => "/usr/bin/gh",
      runGh: async (_bin, args) => {
        if (args[0] === "auth" && args[1] === "status") {
          return { code: 0, stdout: "Logged in to github.com account alice", stderr: "" };
        }
        if (args[0] === "issue" && args[1] === "create") {
          return { code: 1, stdout: "", stderr: "API rate limit exceeded" };
        }
        if (args[0] === "pr" && args[1] === "list") {
          return { code: 0, stdout: "[]", stderr: "" };
        }
        if (args[0] === "pr" && args[1] === "create") {
          prCreateAttempts += 1;
          if (prCreateAttempts === 1) {
            return { code: 1, stdout: "", stderr: "Permission denied to repo" };
          }
          return { code: 0, stdout: "https://github.com/acme/demo/pull/42\n", stderr: "" };
        }
        if (args[0] === "pr" && args[1] === "view") {
          return { code: 1, stdout: "", stderr: "Could not resolve to a PullRequest" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };

    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, githubDeps });
    servers.push(server);

    expect(HAS_BROWSER).toBe(true);
    const page = await browser!.newPage();
    try {
      await page.setViewport({ width: 1360, height: 860 });
      await page.goto(server.url, { waitUntil: "networkidle2" });

      await page.select('[data-testid="ui-language-select"]', "en");
      await page.waitForFunction(() => document.documentElement.lang === "en", { timeout: 10_000 });

      await page.waitForSelector('[data-action="set-scope"][data-value="done"]', { timeout: 10_000 });
      await page.click('[data-action="set-scope"][data-value="done"]');
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 10_000 });
      await page.click('[data-testid="req-row-REQ-001"]');

      // 1. Create & link GitHub Issue failure renders localized English message with upstream detail.
      await page.waitForSelector('[data-testid="more-menu-btn"]', { timeout: 10_000 });
      await page.click('[data-testid="more-menu-btn"]');
      await page.waitForSelector('[data-testid="menu-link-issue-btn"]', { timeout: 10_000 });
      await page.click('[data-testid="menu-link-issue-btn"]');
      await page.waitForSelector('[data-testid="submit-link-issue-btn"]', { timeout: 10_000 });
      await page.waitForFunction(
        () => !(document.querySelector('[data-testid="submit-link-issue-btn"]') as HTMLButtonElement | null)?.disabled,
        { timeout: 10_000 },
      );
      await page.click('[data-testid="submit-link-issue-btn"]');
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll("[data-sonner-toast]")).some((el) =>
            (el.textContent ?? "").includes("Failed to create GitHub Issue: API rate limit exceeded"),
          ),
        { timeout: 10_000 },
      );
      const issueErrToast = await page.evaluate(
        () =>
          Array.from(document.querySelectorAll("[data-sonner-toast]"))
            .map((el) => el.textContent ?? "")
            .find((txt) => txt.includes("Failed to create GitHub Issue")) ?? "",
      );
      expect(/[\u4e00-\u9fff]/.test(issueErrToast)).toBe(false);
      await page.evaluate(() => {
        const modal = document.querySelector('[data-testid="link-issue-modal"]');
        const closeBtn = Array.from(modal?.querySelectorAll("button") ?? []).find(
          (b) => b.textContent?.trim() === "Cancel",
        );
        closeBtn?.click();
      });
      await page.waitForFunction(() => !document.querySelector('[data-testid="link-issue-modal"]'), { timeout: 10_000 });

      // 2. Deliver PR creation failure renders localized English message with upstream detail.
      await page.waitForSelector('[data-testid="open-deliver-btn"]', { timeout: 10_000 });
      await page.click('[data-testid="open-deliver-btn"]');
      await page.waitForSelector('[data-testid="deliver-mode-pr"]', { timeout: 10_000 });
      await page.waitForFunction(
        () => !(document.querySelector('[data-testid="deliver-mode-pr"]') as HTMLButtonElement | null)?.disabled,
        { timeout: 10_000 },
      );
      await page.click('[data-testid="deliver-mode-pr"]');
      await page.click('[data-testid="submit-deliver-btn"]');
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll("[data-sonner-toast]")).some((el) =>
            (el.textContent ?? "").includes("Failed to create GitHub PR: Permission denied to repo"),
          ),
        { timeout: 10_000 },
      );
      const prErrToast = await page.evaluate(
        () =>
          Array.from(document.querySelectorAll("[data-sonner-toast]"))
            .map((el) => el.textContent ?? "")
            .find((txt) => txt.includes("Failed to create GitHub PR")) ?? "",
      );
      expect(/[\u4e00-\u9fff]/.test(prErrToast)).toBe(false);

      // 3. Wait for preview refresh after commit+push, retry PR creation (succeeds as #42), then test PR status sync failure.
      await page.waitForFunction(
        () =>
          !document.querySelector('[data-testid="deliver-file-app.ts"]') &&
          !(document.querySelector('[data-testid="submit-deliver-btn"]') as HTMLButtonElement | null)?.disabled,
        { timeout: 10_000 },
      );
      await page.click('[data-testid="submit-deliver-btn"]');
      await page.waitForFunction(() => !document.querySelector('[data-testid="deliver-modal"]'), { timeout: 10_000 });
      await page.waitForSelector('[data-testid="sync-pr-btn"]', { timeout: 10_000 });
      await page.click('[data-testid="sync-pr-btn"]');
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll("[data-sonner-toast]")).some((el) =>
            (el.textContent ?? "").includes("Failed to query PR #42 status: Could not resolve to a PullRequest"),
          ),
        { timeout: 10_000 },
      );
      const syncErrToast = await page.evaluate(
        () =>
          Array.from(document.querySelectorAll("[data-sonner-toast]"))
            .map((el) => el.textContent ?? "")
            .find((txt) => txt.includes("Failed to query PR #42 status")) ?? "",
      );
      expect(/[\u4e00-\u9fff]/.test(syncErrToast)).toBe(false);
    } finally {
      await page.close();
    }
  }, { timeout: 30_000 });

  test("localizes GitHub Issue warnings on create, manual issue sync, and PR delivery in English UI", async () => {
    makeTempHub();
    const repo = makeGitRepo();
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "wb-del-warn-remote-"));
    tempDirs.push(bare);
    execFileSync("git", ["init", "--bare"], { cwd: bare, stdio: "ignore" });
    execFileSync("git", ["branch", "-M", "main"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", bare], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repo, stdio: "ignore" });

    await initProject(repo, { name: "GitHubWarnRepo", privacyMode: "local" });
    await createRequirement(repo, {
      goal: "Ship PR with linked issue sync warning",
      criteria: [{ id: "AC-1", description: "passes", required: true, command: "echo ok" }],
    });
    await linkRequirementGitHubIssue(repo, "REQ-001", {
      repo: "acme/demo",
      issue: { number: 12, url: "https://github.com/acme/demo/issues/12", title: "Linked", state: "open", lastSyncedAt: Date.now() },
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design", actor: "agent" });
    const base = await observeGitSnapshot(repo);
    await approveDesign(repo, "REQ-001", { baseline: base });
    fs.writeFileSync(path.join(repo, "app.ts"), "export const v = 2;\n");
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const accSnap = await observeGitSnapshot(repo);
    await acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: accSnap!.fingerprint });

    const githubDeps: GitHubCommandDeps = {
      getRemoteUrl: async () => "https://github.com/acme/demo.git",
      resolveDefaultBaseBranch: async () => "main",
      whichGh: () => "/usr/bin/gh",
      runGh: async (_bin, args) => {
        if (args[0] === "auth" && args[1] === "status") {
          return { code: 0, stdout: "Logged in to github.com account alice", stderr: "" };
        }
        if (args[0] === "issue" && args[1] === "create") {
          return { code: 1, stdout: "", stderr: "API quota exceeded" };
        }
        if (args[0] === "issue" && args[1] === "comment") {
          return { code: 1, stdout: "", stderr: "Upstream sync blocked" };
        }
        if (args[0] === "pr" && args[1] === "list") {
          return { code: 0, stdout: "[]", stderr: "" };
        }
        if (args[0] === "pr" && args[1] === "create") {
          return { code: 0, stdout: "https://github.com/acme/demo/pull/42\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };

    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, githubDeps });
    servers.push(server);

    expect(HAS_BROWSER).toBe(true);
    const page = await browser!.newPage();
    try {
      await page.setViewport({ width: 1360, height: 860 });
      await page.goto(server.url, { waitUntil: "networkidle2" });
      await page.select('[data-testid="ui-language-select"]', "en");
      await page.waitForFunction(() => document.documentElement.lang === "en", { timeout: 10_000 });

      // 1. New requirement with "Also create a GitHub issue" when gh issue create fails -> localized warning toast.
      await page.waitForSelector('[data-testid="new-req-btn"]', { timeout: 10_000 });
      await page.click('[data-testid="new-req-btn"]');
      await page.waitForSelector('[data-testid="new-req-goal"]', { timeout: 10_000 });
      await page.type('[data-testid="new-req-goal"]', "Create issue warning test");
      await page.waitForFunction(
        () => !(document.querySelector('[data-testid="new-req-create-issue"]') as HTMLInputElement | null)?.disabled,
        { timeout: 10_000 },
      );
      await page.click('[data-testid="new-req-create-issue"]');
      await page.click('[data-testid="save-draft-btn"]');
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll("[data-sonner-toast]")).some((el) =>
            (el.textContent ?? "").includes(
              "GitHub issue sync warning: Failed to create GitHub Issue: API quota exceeded",
            ),
          ),
        { timeout: 10_000 },
      );
      const createWarnToast = await page.evaluate(
        () =>
          Array.from(document.querySelectorAll("[data-sonner-toast]"))
            .map((el) => el.textContent ?? "")
            .find((txt) => txt.includes("GitHub issue sync warning")) ?? "",
      );
      expect(/[\u4e00-\u9fff]/.test(createWarnToast)).toBe(false);

      // 2. Manual "Sync current status to issue #12" failure on REQ-001 -> localized comment error toast.
      await page.waitForSelector('[data-testid="back-home-btn"]', { timeout: 10_000 });
      await page.click('[data-testid="back-home-btn"]');
      await page.waitForSelector('[data-action="set-scope"][data-value="done"]', { timeout: 10_000 });
      await page.click('[data-action="set-scope"][data-value="done"]');
      await page.waitForSelector('[data-testid="req-row-REQ-001"]', { timeout: 10_000 });
      await page.click('[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="more-menu-btn"]', { timeout: 10_000 });
      await page.click('[data-testid="more-menu-btn"]');
      await page.waitForSelector('[data-testid="menu-sync-issue-btn"]', { timeout: 10_000 });
      await page.click('[data-testid="menu-sync-issue-btn"]');
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll("[data-sonner-toast]")).some((el) =>
            (el.textContent ?? "").includes("Failed to comment on Issue #12: Upstream sync blocked"),
          ),
        { timeout: 10_000 },
      );
      const manualSyncToast = await page.evaluate(
        () =>
          Array.from(document.querySelectorAll("[data-sonner-toast]"))
            .map((el) => el.textContent ?? "")
            .find((txt) => txt.includes("Failed to comment on Issue #12")) ?? "",
      );
      expect(/[\u4e00-\u9fff]/.test(manualSyncToast)).toBe(false);

      // 3. Deliver PR #42 when linked issue comment sync fails -> localized PR sync warning toast.
      await page.waitForSelector('[data-testid="open-deliver-btn"]', { timeout: 10_000 });
      await page.click('[data-testid="open-deliver-btn"]');
      await page.waitForSelector('[data-testid="deliver-mode-pr"]', { timeout: 10_000 });
      await page.waitForFunction(
        () => !(document.querySelector('[data-testid="deliver-mode-pr"]') as HTMLButtonElement | null)?.disabled,
        { timeout: 10_000 },
      );
      await page.click('[data-testid="deliver-mode-pr"]');
      await page.click('[data-testid="submit-deliver-btn"]');
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll("[data-sonner-toast]")).some((el) =>
            (el.textContent ?? "").includes(
              "Created PR #42 (issue sync warning: Failed to comment on Issue #12: Upstream sync blocked)",
            ),
          ),
        { timeout: 10_000 },
      );
      const deliverWarnToast = await page.evaluate(
        () =>
          Array.from(document.querySelectorAll("[data-sonner-toast]"))
            .map((el) => el.textContent ?? "")
            .find((txt) => txt.includes("Created PR #42")) ?? "",
      );
      expect(/[\u4e00-\u9fff]/.test(deliverWarnToast)).toBe(false);
    } finally {
      await page.close();
    }
  }, { timeout: 30_000 });
});
