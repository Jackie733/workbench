import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  acceptRequirement,
  approveDesign,
  createRequirement,
  deliverRequirement,
  getRequirement,
  getRequirementDeliveryPreview,
  initProject,
  linkRequirementGitHubIssue,
  propose,
  reopenRequirement,
  updateProjectConfig,
} from "../../src/core/engine.ts";
import {
  commentOnGitHubIssue,
  createGitHubIssue,
  createOrUpdateGitHubPr,
  inspectGitHubEnvironment,
  parseGitHubIssueRef,
  parseGitHubRepoFromRemoteUrl,
  setGitHubIssueState,
  viewGitHubIssue,
  viewGitHubPr,
  type GitHubCommandDeps,
} from "../../src/core/github.ts";
import { runVerification } from "../../src/core/runner.ts";
import { createOrReuseWorktree } from "../../src/core/worktree.ts";

const tempDirs: string[] = [];

function createGitRepoWithBareRemote(): { repo: string; bareRemote: string } {
  const bareRemote = fs.mkdtempSync(path.join(os.tmpdir(), "wb-gh-bare-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wb-gh-repo-"));
  tempDirs.push(bareRemote, repo);

  execFileSync("git", ["init", "--bare", "--initial-branch=main"], { cwd: bareRemote, stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", bareRemote], { cwd: repo, stdio: "ignore" });

  fs.mkdirSync(path.join(repo, "src/web"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src/web/app.ts"), "export const version = 1;\n");
  fs.writeFileSync(path.join(repo, "feature.ts"), "export const flag = false;\n");
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repo, stdio: "ignore" });
  return { repo, bareRemote };
}

interface MockPrRecord {
  number: number;
  url: string;
  title: string;
  body: string;
  headBranch: string;
  baseBranch: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  mergedAt: string | null;
}

function createMockGhDeps(repoSlug = "Jackie733/workbench-demo") {
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  const prs = new Map<number, MockPrRecord>();
  const comments: Array<{ issueNumber: number; body: string }> = [];
  const issueStates = new Map<number, string>();
  let nextPrNumber = 10;
  let nextIssueNumber = 50;
  let sawLabelRetry = false;

  const deps: GitHubCommandDeps = {
    whichGh: () => "/usr/local/bin/gh",
    resolveDefaultBaseBranch: async () => "main",
    runGh: async (_bin, args, options) => {
      calls.push({ args, stdin: options.stdin });
      const [group, sub] = args;

      if (group === "auth" && sub === "status") {
        return { code: 0, stdout: "github.com\n  ✓ Logged in to github.com account Jackie733 (keyring)\n", stderr: "" };
      }

      if (group === "repo" && sub === "view") {
        return { code: 0, stdout: JSON.stringify({ defaultBranchRef: { name: "main" } }), stderr: "" };
      }

      if (group === "issue" && sub === "create") {
        if (args.includes("--label") && !sawLabelRetry) {
          sawLabelRetry = true;
          return { code: 1, stdout: "", stderr: "could not add label: 'workbench' not found" };
        }
        const num = nextIssueNumber++;
        issueStates.set(num, "open");
        return { code: 0, stdout: `https://github.com/${repoSlug}/issues/${num}\n`, stderr: "" };
      }

      if (group === "issue" && sub === "view") {
        const num = Number(args[2]);
        return {
          code: 0,
          stdout: JSON.stringify({
            number: num,
            title: `Imported Issue #${num}`,
            body: "## Goal\nImplement standardized workflow",
            url: `https://github.com/${repoSlug}/issues/${num}`,
            state: (issueStates.get(num) ?? "OPEN").toUpperCase(),
            labels: [{ name: "workbench" }, { name: "rsi" }],
          }),
          stderr: "",
        };
      }

      if (group === "issue" && sub === "comment") {
        comments.push({ issueNumber: Number(args[2]), body: options.stdin ?? "" });
        return { code: 0, stdout: "", stderr: "" };
      }

      if (group === "issue" && (sub === "close" || sub === "reopen")) {
        issueStates.set(Number(args[2]), sub === "close" ? "closed" : "open");
        return { code: 0, stdout: "", stderr: "" };
      }

      if (group === "pr" && sub === "list") {
        const headIdx = args.indexOf("--head");
        const headBranch = headIdx >= 0 ? args[headIdx + 1] : "";
        const found = [...prs.values()].filter((p) => p.headBranch === headBranch && p.state === "OPEN");
        return {
          code: 0,
          stdout: JSON.stringify(
            found.map((p) => ({
              number: p.number,
              url: p.url,
              title: p.title,
              state: p.state,
              baseRefName: p.baseBranch,
              headRefName: p.headBranch,
            })),
          ),
          stderr: "",
        };
      }

      if (group === "pr" && sub === "create") {
        const num = nextPrNumber++;
        const base = args[args.indexOf("--base") + 1]!;
        const head = args[args.indexOf("--head") + 1]!;
        const title = args[args.indexOf("--title") + 1]!;
        const url = `https://github.com/${repoSlug}/pull/${num}`;
        prs.set(num, {
          number: num,
          url,
          title,
          body: options.stdin ?? "",
          headBranch: head,
          baseBranch: base,
          state: "OPEN",
          mergedAt: null,
        });
        return { code: 0, stdout: `${url}\n`, stderr: "" };
      }

      if (group === "pr" && sub === "edit") {
        const num = Number(args[2]);
        const title = args[args.indexOf("--title") + 1]!;
        const existing = prs.get(num);
        if (existing) {
          existing.title = title;
          existing.body = options.stdin ?? existing.body;
        }
        return { code: 0, stdout: "", stderr: "" };
      }

      if (group === "pr" && sub === "view") {
        const num = Number(args[2]);
        const pr = prs.get(num);
        if (!pr) return { code: 1, stdout: "", stderr: "pr not found" };
        return {
          code: 0,
          stdout: JSON.stringify({
            number: pr.number,
            url: pr.url,
            title: pr.title,
            state: pr.state,
            mergedAt: pr.mergedAt,
            baseRefName: pr.baseBranch,
            headRefName: pr.headBranch,
          }),
          stderr: "",
        };
      }

      return { code: 1, stdout: "", stderr: `unexpected gh call: ${args.join(" ")}` };
    },
  };

  return { deps, calls, prs, comments, issueStates };
}

const prevHubDir = process.env.WORKBENCH_HUB_DIR;

beforeEach(() => {
  const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-gh-hub-"));
  tempDirs.push(hubDir);
  process.env.WORKBENCH_HUB_DIR = hubDir;
});

afterEach(() => {
  if (prevHubDir === undefined) delete process.env.WORKBENCH_HUB_DIR;
  else process.env.WORKBENCH_HUB_DIR = prevHubDir;
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("GitHub Issue & PR integration", () => {
  test("parses SSH/HTTPS remotes, issue references, and inspects environment cleanly", async () => {
    expect(parseGitHubRepoFromRemoteUrl("git@github.com:Jackie733/workbench.git")).toBe("Jackie733/workbench");
    expect(parseGitHubRepoFromRemoteUrl("https://github.com/Jackie733/workbench.git")).toBe("Jackie733/workbench");
    expect(parseGitHubRepoFromRemoteUrl("ssh://git@github.com:22/Jackie733/workbench")).toBe("Jackie733/workbench");
    expect(parseGitHubRepoFromRemoteUrl("/tmp/local-bare.git")).toBeNull();

    expect(parseGitHubIssueRef("42", "Jackie733/workbench")).toEqual({ repo: "Jackie733/workbench", number: 42 });
    expect(parseGitHubIssueRef("#77", "Jackie733/workbench")).toEqual({ repo: "Jackie733/workbench", number: 77 });
    expect(parseGitHubIssueRef("https://github.com/org/repo-1/issues/108")).toEqual({
      repo: "org/repo-1",
      number: 108,
    });
    expect(() => parseGitHubIssueRef("invalid-ref", "Jackie733/workbench")).toThrow();

    const { repo } = createGitRepoWithBareRemote();
    await initProject(repo, { name: "env-check" });

    const missingGh = await inspectGitHubEnvironment(repo, { repo: "Jackie733/demo" }, { whichGh: () => null });
    expect(missingGh.ready).toBe(false);
    expect(missingGh.ghInstalled).toBe(false);

    const unauth = await inspectGitHubEnvironment(
      repo,
      { repo: "Jackie733/demo" },
      {
        whichGh: () => "/usr/bin/gh",
        runGh: async () => ({ code: 1, stdout: "", stderr: "not logged in" }),
      },
    );
    expect(unauth.ready).toBe(false);
    expect(unauth.authenticated).toBe(false);

    const mock = createMockGhDeps("Jackie733/demo");
    const ready = await inspectGitHubEnvironment(repo, { repo: "Jackie733/demo" }, mock.deps);
    expect(ready.ready).toBe(true);
    expect(ready.authenticated).toBe(true);
    expect(ready.account).toBe("Jackie733");
    expect(ready.repo).toBe("Jackie733/demo");
    expect(ready.defaultBaseBranch).toBe("main");
  });

  test("handles Issue CRUD/comments/state (with missing-label retry) & idempotent PR create/edit/view", async () => {
    const { repo } = createGitRepoWithBareRemote();
    const mock = createMockGhDeps("Jackie733/demo");

    const createdIssue = await createGitHubIssue(
      {
        root: repo,
        repo: "Jackie733/demo",
        title: "支持输出语言配置",
        body: "## 目标\n统一中文方案输出",
        labels: ["workbench"],
      },
      mock.deps,
    );
    expect(createdIssue.number).toBe(50);
    expect(createdIssue.url).toBe("https://github.com/Jackie733/demo/issues/50");
    // Verified label fallback retry succeeded on second attempt without --label
    const issueCreateCalls = mock.calls.filter((c) => c.args[0] === "issue" && c.args[1] === "create");
    expect(issueCreateCalls).toHaveLength(2);
    expect(issueCreateCalls[1]!.args).not.toContain("--label");

    const viewed = await viewGitHubIssue({ root: repo, repo: "Jackie733/demo", issueRef: "#50" }, mock.deps);
    expect(viewed.number).toBe(50);
    expect(viewed.labels).toEqual(["workbench", "rsi"]);

    await commentOnGitHubIssue(
      { root: repo, repo: "Jackie733/demo", issueNumber: 50, body: "已完成验收并关联 PR" },
      mock.deps,
    );
    expect(mock.comments).toEqual([{ issueNumber: 50, body: "已完成验收并关联 PR" }]);

    await setGitHubIssueState({ root: repo, repo: "Jackie733/demo", issueNumber: 50, state: "closed" }, mock.deps);
    expect(mock.issueStates.get(50)).toBe("closed");

    const pr1 = await createOrUpdateGitHubPr(
      {
        root: repo,
        repo: "Jackie733/demo",
        headBranch: "rsi/REQ-001",
        baseBranch: "main",
        title: "feat(REQ-001): initial PR",
        body: "Closes #50",
      },
      mock.deps,
    );
    expect(pr1.created).toBe(true);
    expect(pr1.number).toBe(10);

    // Second call on same open head branch updates existing PR rather than creating a duplicate
    const pr2 = await createOrUpdateGitHubPr(
      {
        root: repo,
        repo: "Jackie733/demo",
        headBranch: "rsi/REQ-001",
        baseBranch: "main",
        title: "feat(REQ-001): updated PR",
        body: "Closes #50\nUpdated evidence",
      },
      mock.deps,
    );
    expect(pr2.created).toBe(false);
    expect(pr2.number).toBe(10);
    expect(mock.prs.get(10)!.title).toBe("feat(REQ-001): updated PR");

    mock.prs.get(10)!.state = "MERGED";
    mock.prs.get(10)!.mergedAt = "2026-11-17T12:00:00Z";
    const viewedPr = await viewGitHubPr({ root: repo, repo: "Jackie733/demo", prNumber: 10 }, mock.deps);
    expect(viewedPr.state).toBe("merged");
    expect(viewedPr.mergedAt).toBeGreaterThan(0);
  });

  test("deliverRequirement({ createPr: true }) pushes RSI worktree without .workbench/", async () => {
    const { repo, bareRemote } = createGitRepoWithBareRemote();
    const repoSlug = "Jackie733/workbench-demo";
    const mock = createMockGhDeps(repoSlug);

    await initProject(repo, { name: "pr-rsi-sandbox" });
    await updateProjectConfig(repo, {
      github: { repo: repoSlug, defaultBaseBranch: "main", autoSyncIssue: true },
    });

    const reqA = await createRequirement(repo, {
      goal: "RSI 沙箱标准化 PR 提交流程",
      criteria: [{ id: "AC-1", description: "验证通过", required: true, command: "echo ok" }],
    });
    const idA = reqA.state.id;
    const wtA = await createOrReuseWorktree(repo, idA);
    fs.writeFileSync(path.join(wtA.worktreePath, "src/web/app.ts"), "export const version = 2;\n");
    fs.mkdirSync(path.join(wtA.worktreePath, ".workbench"), { recursive: true });
    fs.writeFileSync(path.join(wtA.worktreePath, ".workbench/scratch.log"), "never commit\n");

    await propose(repo, idA, { designMarkdown: "# RSI PR 交付设计", actor: "agent" });
    await approveDesign(repo, idA);
    await runVerification(repo, idA, { command: "echo ok", criterionIds: ["AC-1"] });
    await acceptRequirement(repo, idA, {
      currentCodeSnapshotHash: getRequirement(repo, idA).state.verifications[0]!.codeSnapshotHash,
    });

    const previewA = await getRequirementDeliveryPreview(repo, idA, mock.deps);
    expect(previewA.codeRootKind).toBe("sandbox");
    expect(previewA.sandboxActive).toBe(true);
    expect(previewA.branch).toBe(wtA.branch);
    expect(previewA.baseBranch).toBe("main");
    expect(previewA.candidates.some((f) => f.path === "src/web/app.ts")).toBe(true);
    expect(previewA.candidates.some((f) => f.path.includes(".workbench"))).toBe(false);
    expect(previewA.githubReady).toBe(true);
    expect(previewA.canCreatePr).toBe(true);

    const deliverA = await deliverRequirement(
      repo,
      idA,
      { files: ["src/web/app.ts"], commitMessage: "feat: apply rsi fix", createPr: true },
      mock.deps,
    );
    expect(deliverA.pr).toBeDefined();
    expect(deliverA.pr!.headBranch).toBe(wtA.branch);
    expect(deliverA.pr!.baseBranch).toBe("main");
    expect(deliverA.delivery.prNumber).toBe(deliverA.pr!.number);
    expect(deliverA.detail.state.delivery?.prNumber).toBe(deliverA.pr!.number);
    expect(deliverA.detail.state.github?.pr?.number).toBe(deliverA.pr!.number);
    expect(deliverA.detail.state.timeline.some((e) => e.kind === "github_pr_created")).toBe(true);

    const remoteBranchA = execFileSync("git", ["--git-dir", bareRemote, "rev-parse", "--verify", `refs/heads/${wtA.branch}`], {
      encoding: "utf8",
    }).trim();
    expect(remoteBranchA.length).toBe(40);
    const treeFilesA = execFileSync("git", ["--git-dir", bareRemote, "ls-tree", "-r", "--name-only", `refs/heads/${wtA.branch}`], {
      encoding: "utf8",
    });
    expect(treeFilesA).toContain("src/web/app.ts");
    expect(treeFilesA).not.toContain(".workbench");
  }, 15_000);

  test("deliverRequirement({ createPr: true }) pushes ahead commits in RSI sandbox even with files: []", async () => {
    const { repo, bareRemote } = createGitRepoWithBareRemote();
    const repoSlug = "Jackie733/workbench-demo";
    const mock = createMockGhDeps(repoSlug);

    await initProject(repo, { name: "pr-ahead-commits" });
    await updateProjectConfig(repo, {
      github: { repo: repoSlug, defaultBaseBranch: "main", autoSyncIssue: true },
    });

    const reqB = await createRequirement(repo, {
      goal: "支持推送沙箱内已提交 commit 的空选择 PR 交付",
      criteria: [{ id: "AC-1", description: "验证通过", required: true, command: "echo ok" }],
    });
    const idB = reqB.state.id;
    const wtB = await createOrReuseWorktree(repo, idB);
    fs.writeFileSync(path.join(wtB.worktreePath, "src/web/app.ts"), "export const version = 3;\n");
    execFileSync("git", ["add", "src/web/app.ts"], { cwd: wtB.worktreePath, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "pre-committed inside sandbox"], { cwd: wtB.worktreePath, stdio: "ignore" });

    await propose(repo, idB, { designMarkdown: "# 已提交 Commit 推送方案", actor: "agent" });
    await approveDesign(repo, idB);
    await runVerification(repo, idB, { command: "echo ok", criterionIds: ["AC-1"] });
    await acceptRequirement(repo, idB, {
      currentCodeSnapshotHash: getRequirement(repo, idB).state.verifications[0]!.codeSnapshotHash,
    });

    const previewB = await getRequirementDeliveryPreview(repo, idB, mock.deps);
    expect(previewB.candidates).toHaveLength(0);
    expect(previewB.aheadCommitsCount).toBe(1);
    expect(previewB.canCreatePr).toBe(true);

    const deliverB = await deliverRequirement(
      repo,
      idB,
      { files: [], commitMessage: "chore: push sandbox commits", createPr: true },
      mock.deps,
    );
    expect(deliverB.pr).toBeDefined();
    expect(deliverB.delivery.files).toEqual(["src/web/app.ts"]);
    expect(deliverB.delivery.prNumber).toBe(deliverB.pr!.number);
    const remoteBranchB = execFileSync("git", ["--git-dir", bareRemote, "rev-parse", "--verify", `refs/heads/${wtB.branch}`], {
      encoding: "utf8",
    }).trim();
    expect(remoteBranchB.length).toBe(40);
  }, 15_000);

  test("deliverRequirement({ createPr: true }) auto-branches regular main edits, comments Issue, and reopen preserves state.github", async () => {
    const { repo } = createGitRepoWithBareRemote();
    const repoSlug = "Jackie733/workbench-demo";
    const mock = createMockGhDeps(repoSlug);

    await initProject(repo, { name: "pr-regular-branch" });
    await updateProjectConfig(repo, {
      github: { repo: repoSlug, defaultBaseBranch: "main", autoSyncIssue: true },
    });

    const reqC = await createRequirement(repo, {
      goal: "常规需求在 main 分支自动切分支提交 PR",
      criteria: [{ id: "AC-1", description: "验证通过", required: true, command: "echo ok" }],
    });
    const idC = reqC.state.id;
    await linkRequirementGitHubIssue(repo, idC, {
      repo: repoSlug,
      issue: {
        number: 77,
        url: `https://github.com/${repoSlug}/issues/77`,
        title: "Track regular delivery",
        state: "open",
        lastSyncedAt: Date.now(),
      },
    });

    fs.writeFileSync(path.join(repo, "feature.ts"), "export const flag = true;\n");
    await propose(repo, idC, { designMarkdown: "# 常规分支 PR 方案", actor: "agent" });
    await approveDesign(repo, idC);
    await runVerification(repo, idC, { command: "echo ok", criterionIds: ["AC-1"] });
    await acceptRequirement(repo, idC, {
      currentCodeSnapshotHash: getRequirement(repo, idC).state.verifications[0]!.codeSnapshotHash,
    });

    const deliverC = await deliverRequirement(
      repo,
      idC,
      { files: ["feature.ts"], commitMessage: "feat: regular PR", createPr: true },
      mock.deps,
    );
    expect(deliverC.pr).toBeDefined();
    expect(deliverC.pr!.headBranch).not.toBe("main");
    expect(deliverC.pr!.baseBranch).toBe("main");
    const createdPrRecord = mock.prs.get(deliverC.pr!.number)!;
    expect(createdPrRecord.body).toContain("Closes #77");
    expect(mock.comments.some((c) => c.issueNumber === 77 && c.body.includes(deliverC.pr!.url))).toBe(true);

    const reopened = await reopenRequirement(repo, idC, { reason: "补充边界校验" });
    expect(reopened.state.stage).toBe("planning");
    expect(reopened.state.github?.issue?.number).toBe(77);
    expect(reopened.state.github?.pr?.number).toBe(deliverC.pr!.number);
  }, 15_000);
});
