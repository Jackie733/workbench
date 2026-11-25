import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acceptRequirement, approveDesign, initProject, propose } from "../../src/core/engine.ts";
import { observeGitSnapshot } from "../../src/core/git.ts";
import type { GiteeApiDeps } from "../../src/core/gitee.ts";
import { runVerification } from "../../src/core/runner.ts";
import { startWorkbenchNodeClient, type NodeClientHandle } from "../../src/hub/node_bridge.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";

const tempDirs: string[] = [];
const servers: WorkbenchServerHandle[] = [];
const nodes: NodeClientHandle[] = [];
const origHubEnv = process.env.WORKBENCH_HUB_DIR;

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeGiteeGitRepo(): { repo: string; bareRemote: string } {
  const bareRemote = makeTempDir("wb-gitee-srv-bare-");
  const repo = makeTempDir("wb-gitee-srv-repo-");
  execFileSync("git", ["init", "--bare", "--initial-branch=master"], { cwd: bareRemote, stdio: "ignore" });
  execFileSync("git", ["init", "-b", "master"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Gitee User"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "user@example.com"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", bareRemote], { cwd: repo, stdio: "ignore" });
  fs.writeFileSync(path.join(repo, "index.ts"), "export const x = 1;\n");
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["push", "-u", "origin", "master"], { cwd: repo, stdio: "ignore" });
  return { repo, bareRemote };
}

function createServerMockGiteeDeps(): {
  deps: GiteeApiDeps;
  calls: Array<{ method: string; url: string; body?: Record<string, unknown> }>;
  prs: Map<number, { number: number; state: "open" | "merged" | "closed"; title: string; body: string }>;
} {
  const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
  const prs = new Map<number, { number: number; state: "open" | "merged" | "closed"; title: string; body: string }>();
  let nextPr = 21;

  const fetchMock: NonNullable<GiteeApiDeps["fetch"]> = async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body =
      typeof init?.body === "string" && init.body.trim()
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    calls.push({ method, url, body });

    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
    if (!auth.includes("token-secret-1234")) {
      return new Response(JSON.stringify({ message: "401 Unauthorized" }), { status: 401 });
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
              number: "I9NODE",
              html_url: "https://e.gitee.com/openstring/issues/list?issue=I9NODE",
              title: "远程 WSL2 无仓库工作项",
              body: "从企业工作项直接导入并提 PR",
              state: "open",
              issue_state_detail: { title: "开启" },
              issue_type_detail: { title: "需求" },
              labels: [{ name: "web" }],
              repository: null,
              program: { name: "PC 客户端" },
              updated_at: "2026-11-18T12:00:00+08:00",
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
        state: "open" as const,
        head: { ref: String(body?.head ?? "") },
        base: { ref: String(body?.base ?? "master") },
        merged_at: null,
      };
      prs.set(num, pr);
      return new Response(JSON.stringify(pr), { status: 201 });
    }
    const prViewMatch = /^\/api\/v5\/repos\/openstring\/deepmdt-frontend-pc\/pulls\/(\d+)$/.exec(p);
    if (method === "GET" && prViewMatch) {
      const pr = prs.get(Number(prViewMatch[1]));
      if (!pr) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      return new Response(
        JSON.stringify({
          ...pr,
          html_url: `https://gitee.com/openstring/deepmdt-frontend-pc/pulls/${pr.number}`,
          head: { ref: "feat/req-001" },
          base: { ref: "master" },
          merged_at: pr.state === "merged" ? "2026-11-18T13:00:00+08:00" : null,
        }),
        { status: 200 },
      );
    }

    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  };

  return {
    calls,
    prs,
    deps: {
      fetch: fetchMock,
      getRemoteUrl: async () => "git@gitee.com:openstring/deepmdt-frontend-pc.git",
      resolveDefaultBaseBranch: async () => "master",
    },
  };
}

afterEach(() => {
  while (nodes.length > 0) nodes.pop()!.stop();
  while (servers.length > 0) servers.pop()!.stop();
  if (origHubEnv === undefined) delete process.env.WORKBENCH_HUB_DIR;
  else process.env.WORKBENCH_HUB_DIR = origHubEnv;
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Gitee Server & Remote Node Bridge API", () => {
  test("masks hub Gitee token, forwards token to remote node, imports unlinked work item, and delivers PR without issue comments", async () => {
    process.env.WORKBENCH_HUB_DIR = makeTempDir("wb-gitee-hub-");
    const hubRepo = makeTempDir("wb-gitee-local-");
    const { repo: remoteRepo } = makeGiteeGitRepo();
    await initProject(remoteRepo, { name: "deepmdt-frontend-pc", privacyMode: "local" });

    const { deps: giteeDeps, calls, prs } = createServerMockGiteeDeps();
    const server = await startWorkbenchServer({
      root: hubRepo,
      port: 0,
      hubMode: true,
      writeDiscovery: false,
      giteeDeps,
    });
    servers.push(server);

    const node = startWorkbenchNodeClient({
      hubUrl: server.url,
      nodeId: "wsl-test",
      nodeName: "Windows WSL2 Test",
      initialHarnesses: [],
      giteeDeps,
    });
    nodes.push(node);
    await node.waitUntilConnected(5_000);

    // Register remote Gitee project on the Hub.
    const addResp = await fetch(`${server.url}/api/hub/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: remoteRepo, nodeId: "wsl-test", name: "deepmdt-frontend-pc" }),
    });
    expect(addResp.status).toBe(201);
    const added = (await addResp.json()) as { project: { id: string } };
    const pid = added.project.id;

    // Save Gitee Access Token in Hub preferences and verify masking.
    const prefResp = await fetch(`${server.url}/api/hub/preferences`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ giteeAccessToken: "token-secret-1234" }),
    });
    expect(prefResp.status).toBe(200);
    const prefJson = (await prefResp.json()) as { giteeTokenConfigured: boolean; giteeTokenMasked: string };
    expect(prefJson.giteeTokenConfigured).toBe(true);
    expect(prefJson.giteeTokenMasked).toBe("••••1234");

    const hubStateResp = await fetch(`${server.url}/api/hub/state`);
    const hubState = (await hubStateResp.json()) as Record<string, unknown>;
    expect(hubState.giteeTokenConfigured).toBe(true);
    expect(hubState.giteeTokenMasked).toBe("••••1234");
    expect(JSON.stringify(hubState)).not.toContain("token-secret-1234");

    // Check Gitee status on remote node project.
    const statusResp = await fetch(`${server.url}/api/gitee/status?project=${encodeURIComponent(pid)}`);
    expect(statusResp.status).toBe(200);
    const statusJson = (await statusResp.json()) as { ready: boolean; account: string; enterprise: string };
    expect(statusJson.ready).toBe(true);
    expect(statusJson.account).toBe("jackie");
    expect(statusJson.enterprise).toBe("openstring");

    // List my Gitee issues (contains unlinked repository: null issue).
    const listResp = await fetch(`${server.url}/api/gitee/issues?project=${encodeURIComponent(pid)}&filter=assigned&state=active`);
    expect(listResp.status).toBe(200);
    const listJson = (await listResp.json()) as { items: Array<{ ident: string; importedRequirementId: string | null }> };
    expect(listJson.items).toHaveLength(1);
    expect(listJson.items[0]?.ident).toBe("I9NODE");
    expect(listJson.items[0]?.importedRequirementId).toBeNull();

    // Import the unlinked Gitee work item into the remote repo project.
    const importResp = await fetch(`${server.url}/api/requirements/import-issue?project=${encodeURIComponent(pid)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "gitee",
        giteeIssue: listJson.items[0],
        dispatchAgent: false,
      }),
    });
    expect(importResp.status).toBe(201);
    const imported = (await importResp.json()) as {
      alreadyExisted: boolean;
      detail: { state: { id: string; github?: { provider?: string; issue?: { number: string } } } };
    };
    expect(imported.alreadyExisted).toBe(false);
    expect(imported.detail.state.id).toBe("REQ-001");
    expect(imported.detail.state.github?.provider).toBe("gitee");
    expect(imported.detail.state.github?.issue?.number).toBe("I9NODE");

    // Re-listing marks I9NODE as already imported, and re-importing returns alreadyExisted=true.
    const listAgain = await (await fetch(`${server.url}/api/gitee/issues?project=${encodeURIComponent(pid)}`)).json() as {
      items: Array<{ ident: string; importedRequirementId: string | null }>;
    };
    expect(listAgain.items[0]?.importedRequirementId).toBe("REQ-001");

    const dupImportResp = await fetch(`${server.url}/api/requirements/import-issue?project=${encodeURIComponent(pid)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "gitee", giteeIssue: listJson.items[0] }),
    });
    expect(dupImportResp.status).toBe(200);
    expect(((await dupImportResp.json()) as { alreadyExisted: boolean }).alreadyExisted).toBe(true);

    // Complete design -> verify -> accept -> deliver PR.
    await propose(remoteRepo, "REQ-001", {
      designMarkdown: "# Plan",
      criteria: [{ id: "AC-1", description: "passes", required: true, command: "echo ok" }],
      actor: "agent",
    });
    const baseSnap = await observeGitSnapshot(remoteRepo);
    await approveDesign(remoteRepo, "REQ-001", { baseline: baseSnap });
    fs.writeFileSync(path.join(remoteRepo, "index.ts"), "export const x = 2;\n");
    await runVerification(remoteRepo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const accSnap = await observeGitSnapshot(remoteRepo);

    const accResp = await fetch(`${server.url}/api/requirements/REQ-001/accept?project=${encodeURIComponent(pid)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentCodeSnapshotHash: accSnap!.fingerprint }),
    });
    expect(accResp.status).toBe(200);

    const deliverResp = await fetch(`${server.url}/api/requirements/REQ-001/deliver?project=${encodeURIComponent(pid)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: ["index.ts"],
        commitMessage: "feat(req-001): implement I9NODE",
        createPr: true,
        baseBranch: "master",
      }),
    });
    expect(deliverResp.status).toBe(200);
    const deliverJson = (await deliverResp.json()) as { pr?: { number: number; url: string } };
    expect(deliverJson.pr?.number).toBe(21);
    expect(prs.get(21)?.body).toContain("Closes #I9NODE");

    // Sync PR merged state and ensure issue state/comments were never touched.
    prs.get(21)!.state = "merged";
    const syncResp = await fetch(`${server.url}/api/requirements/REQ-001/github/pr-sync?project=${encodeURIComponent(pid)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(syncResp.status).toBe(200);
    const syncJson = (await syncResp.json()) as {
      pr: { state: string };
      detail: { state: { github?: { issue?: { state: string } } } };
    };
    expect(syncJson.pr.state).toBe("merged");
    expect(syncJson.detail.state.github?.issue?.state).toBe("open");

    const issueMutations = calls.filter(
      (c) => (c.method === "POST" || c.method === "PATCH") && c.url.includes("/issues"),
    );
    expect(issueMutations).toHaveLength(0);
  }, 20_000);
});
