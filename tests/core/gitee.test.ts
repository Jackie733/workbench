import { afterEach, describe, expect, test } from "bun:test";
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
  updateProjectConfig,
} from "../../src/core/engine.ts";
import {
  createOrUpdateGiteePr,
  detectGitRemoteProvider,
  findOpenGiteePrForBranch,
  inspectGiteeEnvironment,
  listGiteeMyIssues,
  parseGiteeIssueRef,
  parseGiteeRepoFromRemoteUrl,
  viewGiteeIssue,
  viewGiteePr,
  type GiteeApiDeps,
} from "../../src/core/gitee.ts";
import { observeGitSnapshot } from "../../src/core/git.ts";
import { buildRequirementPrBody } from "../../src/core/github.ts";
import { runVerification } from "../../src/core/runner.ts";

const tempDirs: string[] = [];

function createGiteeRepoWithBareRemote(
  bareRemoteOverride?: string,
): { repo: string; bareRemote: string } {
  const bareRemote = bareRemoteOverride ?? fs.mkdtempSync(path.join(os.tmpdir(), "wb-gitee-bare-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wb-gitee-repo-"));
  tempDirs.push(bareRemote, repo);

  execFileSync("git", ["init", "--bare", "--initial-branch=master"], { cwd: bareRemote, stdio: "ignore" });
  execFileSync("git", ["init", "-b", "master"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Gitee Tester"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "tester@example.com"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", bareRemote], { cwd: repo, stdio: "ignore" });

  fs.writeFileSync(path.join(repo, "app.ts"), "export const v = 1;\n");
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["push", "-u", "origin", "master"], { cwd: repo, stdio: "ignore" });
  return { repo, bareRemote };
}

function createMockGiteeFetch() {
  const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
  const prs = new Map<
    number,
    {
      number: number;
      html_url: string;
      title: string;
      body: string;
      state: "open" | "merged" | "closed";
      head: { ref: string };
      base: { ref: string };
      merged_at: string | null;
    }
  >();
  let nextPrNumber = 12;

  const fetchMock: NonNullable<GiteeApiDeps["fetch"]> = async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const parsedBody =
      typeof init?.body === "string" && init.body.trim()
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    calls.push({ method, url, body: parsedBody });

    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
    if (!auth.includes("valid-gitee-token")) {
      return new Response(JSON.stringify({ message: "401 Unauthorized" }), { status: 401 });
    }

    const u = new URL(url);
    const p = u.pathname;

    if (method === "GET" && p === "/api/v5/user") {
      return new Response(JSON.stringify({ login: "jackie", name: "Jackie" }), { status: 200 });
    }

    if (method === "GET" && p === "/api/v5/user/issues") {
      const state = u.searchParams.get("state");
      if (state === "progressing") {
        return new Response(
          JSON.stringify([
            {
              number: "I8UNL1",
              html_url: "https://e.gitee.com/openstring/issues/list?issue=I8UNL1",
              title: "PC端登录页适配",
              body: "无仓库绑定的企业任务正文",
              state: "progressing",
              issue_state_detail: { title: "进行中" },
              issue_type_detail: { title: "需求" },
              labels: [{ name: "frontend" }],
              repository: null,
              program: { name: "DeepMDT 3.0" },
              updated_at: "2026-11-18T08:00:00+08:00",
            },
          ]),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }

    if (method === "GET" && p === "/api/v5/enterprises/openstring/issues") {
      const state = u.searchParams.get("state");
      if (state === "open") {
        return new Response(
          JSON.stringify([
            {
              number: "I8ENT2",
              html_url: "https://e.gitee.com/openstring/issues/list?issue=I8ENT2",
              title: "表格导出 CSV 支持中文表头",
              body: "企业工作项详细说明",
              state: "open",
              issue_state_detail: { title: "待办" },
              issue_type_detail: { title: "任务" },
              labels: [],
              repository: null,
              program: { name: "DeepMDT 3.0" },
              updated_at: "2026-11-18T09:00:00+08:00",
            },
          ]),
          { status: 200 },
        );
      }
      if (state === "progressing") {
        // Duplicate of I8UNL1 to verify deduplication.
        return new Response(
          JSON.stringify([
            {
              number: "I8UNL1",
              html_url: "https://e.gitee.com/openstring/issues/list?issue=I8UNL1",
              title: "PC端登录页适配",
              body: "无仓库绑定的企业任务正文",
              state: "progressing",
              repository: null,
              updated_at: "2026-11-18T08:00:00+08:00",
            },
          ]),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }

    if (method === "GET" && p === "/api/v5/enterprises/openstring/issues/I8ENT2") {
      return new Response(
        JSON.stringify({
          number: "I8ENT2",
          html_url: "https://e.gitee.com/openstring/issues/list?issue=I8ENT2",
          title: "表格导出 CSV 支持中文表头",
          body: "企业工作项详细说明",
          state: "open",
          issue_state_detail: { title: "待办" },
          issue_type_detail: { title: "任务" },
          repository: null,
          program: { name: "DeepMDT 3.0" },
          updated_at: "2026-11-18T09:00:00+08:00",
        }),
        { status: 200 },
      );
    }

    if (method === "GET" && p === "/api/v5/repos/openstring/deepmdt-frontend-pc/pulls") {
      const head = u.searchParams.get("head");
      const found = [...prs.values()].filter((pr) => pr.state === "open" && (!head || pr.head.ref === head));
      return new Response(JSON.stringify(found), { status: 200 });
    }

    if (method === "POST" && p === "/api/v5/repos/openstring/deepmdt-frontend-pc/pulls") {
      const num = nextPrNumber++;
      const created = {
        number: num,
        html_url: `https://gitee.com/openstring/deepmdt-frontend-pc/pulls/${num}`,
        title: String(parsedBody?.title ?? ""),
        body: String(parsedBody?.body ?? ""),
        state: "open" as const,
        head: { ref: String(parsedBody?.head ?? "") },
        base: { ref: String(parsedBody?.base ?? "master") },
        merged_at: null,
      };
      prs.set(num, created);
      return new Response(JSON.stringify(created), { status: 201 });
    }

    const prPatchMatch = /^\/api\/v5\/repos\/openstring\/deepmdt-frontend-pc\/pulls\/(\d+)$/.exec(p);
    if (prPatchMatch) {
      const num = Number(prPatchMatch[1]);
      const existing = prs.get(num);
      if (!existing) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      if (method === "PATCH") {
        existing.title = String(parsedBody?.title ?? existing.title);
        existing.body = String(parsedBody?.body ?? existing.body);
      }
      return new Response(JSON.stringify(existing), { status: 200 });
    }

    return new Response(JSON.stringify({ message: `Unhandled mock route: ${method} ${p}` }), { status: 404 });
  };

  return { fetchMock, calls, prs };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Gitee V5 integration", () => {
  test("parses Gitee SSH/HTTPS remotes, detects provider, and parses various work item references", () => {
    expect(parseGiteeRepoFromRemoteUrl("git@gitee.com:openstring/deepmdt-frontend-pc.git")).toBe(
      "openstring/deepmdt-frontend-pc",
    );
    expect(parseGiteeRepoFromRemoteUrl("ssh://git@gitee.com/openstring/deepmdt-frontend-pc.git")).toBe(
      "openstring/deepmdt-frontend-pc",
    );
    expect(parseGiteeRepoFromRemoteUrl("https://gitee.com/openstring/deepmdt-frontend-pc")).toBe(
      "openstring/deepmdt-frontend-pc",
    );
    expect(parseGiteeRepoFromRemoteUrl("git@github.com:Jackie733/workbench.git")).toBeNull();

    expect(detectGitRemoteProvider("git@gitee.com:openstring/deepmdt-frontend-pc.git")).toBe("gitee");
    expect(detectGitRemoteProvider("git@github.com:Jackie733/workbench.git")).toBe("github");
    expect(detectGitRemoteProvider("https://example.com/foo/bar.git")).toBeNull();

    expect(parseGiteeIssueRef("#I8ABCD", { enterprise: "openstring" })).toEqual({
      ident: "I8ABCD",
      enterprise: "openstring",
      repo: null,
    });
    expect(parseGiteeIssueRef("#i8abcd", { enterprise: "openstring" })).toEqual({
      ident: "I8ABCD",
      enterprise: "openstring",
      repo: null,
    });
    expect(parseGiteeIssueRef("https://e.gitee.com/openstring/issues/list?issue=I8XYZ9")).toEqual({
      ident: "I8XYZ9",
      enterprise: "openstring",
      repo: null,
    });
    expect(parseGiteeIssueRef("https://e.gitee.com/openstring/issues/list#?issue=i8hash")).toEqual({
      ident: "I8HASH",
      enterprise: "openstring",
      repo: null,
    });
    expect(parseGiteeIssueRef("https://gitee.com/enterprises/openstring/issues/list?issue=i8list")).toEqual({
      ident: "I8LIST",
      enterprise: "openstring",
      repo: null,
    });
    expect(parseGiteeIssueRef("https://gitee.com/openstring/deepmdt-frontend-pc/issues/I8REPO1")).toEqual({
      ident: "I8REPO1",
      enterprise: "openstring",
      repo: "openstring/deepmdt-frontend-pc",
    });
  });

  test("lists repository-unlinked my issues, deduplicates across user/enterprise endpoints, and creates/updates PRs", async () => {
    const { repo } = createGiteeRepoWithBareRemote();
    const { fetchMock, calls, prs } = createMockGiteeFetch();
    const deps: GiteeApiDeps = {
      fetch: fetchMock,
      getRemoteUrl: async () => "git@gitee.com:openstring/deepmdt-frontend-pc.git",
      resolveDefaultBaseBranch: async () => "master",
    };

    const noTokenStatus = await inspectGiteeEnvironment(repo, undefined, null, deps);
    expect(noTokenStatus.ready).toBe(false);
    expect(noTokenStatus.tokenConfigured).toBe(false);
    expect(noTokenStatus.repo).toBe("openstring/deepmdt-frontend-pc");
    expect(noTokenStatus.enterprise).toBe("openstring");

    const okStatus = await inspectGiteeEnvironment(repo, undefined, "valid-gitee-token", deps);
    expect(okStatus.ready).toBe(true);
    expect(okStatus.authenticated).toBe(true);
    expect(okStatus.account).toBe("jackie");
    expect(okStatus.defaultBaseBranch).toBe("master");

    const listed = await listGiteeMyIssues(
      { token: "valid-gitee-token", enterprise: "openstring", filter: "assigned", state: "active" },
      deps,
    );
    expect(listed.account).toBe("jackie");
    expect(listed.items.map((i) => i.ident)).toEqual(["I8ENT2", "I8UNL1"]);
    expect(listed.items[0]?.repository).toBeNull();
    expect(listed.items[0]?.programName).toBe("DeepMDT 3.0");

    const filtered = await listGiteeMyIssues(
      { token: "valid-gitee-token", enterprise: "openstring", search: "CSV" },
      deps,
    );
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]?.ident).toBe("I8ENT2");

    const single = await viewGiteeIssue(
      { token: "valid-gitee-token", issueRef: "#I8ENT2", enterprise: "openstring" },
      deps,
    );
    expect(single.title).toBe("表格导出 CSV 支持中文表头");

    const pr1 = await createOrUpdateGiteePr(
      {
        repo: "openstring/deepmdt-frontend-pc",
        headBranch: "feat/req-001",
        baseBranch: "master",
        title: "REQ-001: 表格导出 CSV",
        body: "Closes #I8ENT2",
        token: "valid-gitee-token",
      },
      deps,
    );
    expect(pr1.created).toBe(true);
    expect(pr1.number).toBe(12);

    const pr2 = await createOrUpdateGiteePr(
      {
        repo: "openstring/deepmdt-frontend-pc",
        headBranch: "feat/req-001",
        baseBranch: "master",
        title: "REQ-001: 表格导出 CSV (v2)",
        body: "Closes #I8ENT2\nUpdated body",
        token: "valid-gitee-token",
      },
      deps,
    );
    expect(pr2.created).toBe(false);
    expect(pr2.number).toBe(12);
    expect(prs.get(12)?.title).toBe("REQ-001: 表格导出 CSV (v2)");

    // Ensure access_token is only sent via Authorization header, never in POST/PATCH JSON bodies.
    const prWriteCalls = calls.filter(
      (c) => (c.method === "POST" || c.method === "PATCH") && c.url.includes("/pulls"),
    );
    expect(prWriteCalls.length).toBe(2);
    for (const call of prWriteCalls) {
      expect(call.body?.access_token).toBeUndefined();
    }

    prs.get(12)!.state = "merged";
    prs.get(12)!.merged_at = "2026-11-18T10:00:00+08:00";
    const viewed = await viewGiteePr(
      { repo: "openstring/deepmdt-frontend-pc", prNumber: 12, token: "valid-gitee-token" },
      deps,
    );
    expect(viewed.state).toBe("merged");
    expect(viewed.mergedAt).toBeGreaterThan(0);
  });

  test("deliverRequirement({ createPr: true }) pushes feature branch to Gitee, links #I8ENT2 in PR body, and never comments/updates issue", async () => {
    const { repo, bareRemote } = createGiteeRepoWithBareRemote();
    const { fetchMock, calls, prs } = createMockGiteeFetch();
    const giteeDeps: GiteeApiDeps = {
      fetch: fetchMock,
      getRemoteUrl: async () => "git@gitee.com:openstring/deepmdt-frontend-pc.git",
      resolveDefaultBaseBranch: async () => "master",
    };

    await initProject(repo, { name: "deepmdt-frontend-pc", privacyMode: "local" });
    await updateProjectConfig(repo, {
      gitee: { repo: "openstring/deepmdt-frontend-pc", enterprise: "openstring", defaultBaseBranch: "master" },
    });

    await createRequirement(repo, {
      goal: "表格导出 CSV 支持中文表头",
      criteria: [{ id: "AC-1", description: "passes", required: true, command: "echo ok" }],
    });
    await linkRequirementGitHubIssue(repo, "REQ-001", {
      provider: "gitee",
      repo: "openstring/deepmdt-frontend-pc",
      enterprise: "openstring",
      issue: {
        number: "I8ENT2",
        url: "https://e.gitee.com/openstring/issues/list?issue=I8ENT2",
        title: "表格导出 CSV 支持中文表头",
        state: "open",
        issueType: "任务",
        programName: "DeepMDT 3.0",
        lastSyncedAt: Date.now(),
      },
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design\nExport UTF-8 BOM CSV.", actor: "agent" });
    const baseSnap = await observeGitSnapshot(repo);
    await approveDesign(repo, "REQ-001", { baseline: baseSnap });

    fs.writeFileSync(path.join(repo, "app.ts"), "export const v = 2;\n");
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const accSnap = await observeGitSnapshot(repo);
    await acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: accSnap!.fingerprint });

    const preview = await getRequirementDeliveryPreview(repo, "REQ-001", {
      giteeDeps,
      giteeToken: "valid-gitee-token",
    });
    expect(preview.remoteProvider).toBe("gitee");
    expect(preview.githubRepo).toBe("openstring/deepmdt-frontend-pc");
    expect(preview.baseBranch).toBe("master");
    expect(preview.canCreatePr).toBe(true);

    const detail = getRequirement(repo, "REQ-001");
    expect(buildRequirementPrBody(detail)).toContain("Closes #I8ENT2");
    expect(buildRequirementPrBody(detail)).toContain("关联 Gitee 工作项");

    const delivered = await deliverRequirement(
      repo,
      "REQ-001",
      {
        files: ["app.ts"],
        commitMessage: "feat(req-001): support UTF-8 CSV export",
        createPr: true,
        baseBranch: "master",
      },
      { giteeDeps, giteeToken: "valid-gitee-token" },
    );

    expect(delivered.pr?.number).toBe(12);
    expect(delivered.pr?.url).toBe("https://gitee.com/openstring/deepmdt-frontend-pc/pulls/12");
    expect(delivered.detail.state.github?.provider).toBe("gitee");
    expect(delivered.detail.state.github?.issue?.number).toBe("I8ENT2");
    expect(delivered.detail.state.github?.pr?.number).toBe(12);
    expect(prs.get(12)?.body).toContain("Closes #I8ENT2");

    // Verify branch was pushed to remote origin.
    const remoteBranch = execFileSync("git", ["branch", "--list", "feat/req-001"], {
      cwd: bareRemote,
      encoding: "utf8",
    }).trim();
    expect(remoteBranch).toContain("feat/req-001");

    // Verify zero comment or issue-mutation calls were made to Gitee.
    const issueWriteCalls = calls.filter(
      (c) => (c.method === "POST" || c.method === "PATCH") && c.url.includes("/issues"),
    );
    expect(issueWriteCalls).toHaveLength(0);
  });

  test("listGiteeMyIssues throws when all sub-requests fail and preserves partial results without polluting enterprise", async () => {
    const failAllFetch: NonNullable<GiteeApiDeps["fetch"]> = async (url) => {
      const p = new URL(url).pathname;
      if (p === "/api/v5/user") {
        return new Response(JSON.stringify({ login: "jackie" }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: "403 Forbidden: missing issues scope" }), { status: 403 });
    };
    await expect(
      listGiteeMyIssues({ token: "tok", enterprise: "openstring" }, { fetch: failAllFetch }),
    ).rejects.toThrow("403");

    const partialFetch: NonNullable<GiteeApiDeps["fetch"]> = async (url) => {
      const u = new URL(url);
      if (u.pathname === "/api/v5/user") {
        return new Response(JSON.stringify({ login: "jackie" }), { status: 200 });
      }
      if (u.pathname === "/api/v5/user/issues") {
        if (u.searchParams.get("state") === "open") {
          return new Response(
            JSON.stringify([
              {
                number: "I9PERS",
                title: "个人仓库 Issue",
                state: "open",
                repository: { full_name: "other-org/other-repo" },
                updated_at: "2026-11-18T11:00:00+08:00",
              },
            ]),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(JSON.stringify({ message: "Enterprise not found" }), { status: 404 });
    };
    const partial = await listGiteeMyIssues({ token: "tok", enterprise: "openstring" }, { fetch: partialFetch });
    expect(partial.items).toHaveLength(1);
    expect(partial.items[0]?.ident).toBe("I9PERS");
    expect(partial.items[0]?.enterprise).toBeNull();
    expect(partial.items[0]?.url).toBe("https://gitee.com/other-org/other-repo/issues/I9PERS");
  });

  test("findOpenGiteePrForBranch verifies headBranch and baseBranch client-side", async () => {
    const mockFetch: NonNullable<GiteeApiDeps["fetch"]> = async () =>
      new Response(
        JSON.stringify([
          {
            number: 99,
            state: "open",
            title: "Unrelated PR",
            head: { ref: "feat/other" },
            base: { ref: "master" },
          },
          {
            number: 100,
            state: "open",
            title: "Target PR",
            head: { ref: "feat/target" },
            base: { ref: "release" },
          },
        ]),
        { status: 200 },
      );

    const wrongBase = await findOpenGiteePrForBranch(
      { repo: "openstring/deepmdt-frontend-pc", headBranch: "feat/target", baseBranch: "master", token: "tok" },
      { fetch: mockFetch },
    );
    expect(wrongBase).toBeNull();

    const matched = await findOpenGiteePrForBranch(
      { repo: "openstring/deepmdt-frontend-pc", headBranch: "feat/target", baseBranch: "release", token: "tok" },
      { fetch: mockFetch },
    );
    expect(matched?.number).toBe(100);
  });
});
