import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeWorkbenchTool } from "../../src/mcp/tools.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";
import { ensureServerForProject, removeServerDiscovery } from "../../src/server/runtime.ts";
import type { GitHubCommandDeps } from "../../src/core/github.ts";

const tempDirs: string[] = [];
const runningServers: WorkbenchServerHandle[] = [];

function initGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-srv-test-"));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "main.ts"), "export const ready = true;\n");
  execFileSync("git", ["add", "main.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

async function apiJson(url: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const resp = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await resp.json()) as Record<string, unknown>;
  return { status: resp.status, body };
}

afterEach(() => {
  while (runningServers.length > 0) {
    runningServers.pop()!.stop();
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("WB-04 local HTTP/WS server and omp bridge adapter", () => {
  test("serves REST API lifecycle, CAS conflict 409, verification, git diff, and WS broadcasts", async () => {
    const root = initGitRepo();
    const server = await startWorkbenchServer({ root, port: 0, writeDiscovery: false });
    runningServers.push(server);

    const uiEvents: Array<Record<string, unknown>> = [];
    const uiWs = new WebSocket(`${server.url.replace("http", "ws")}/ws?role=ui`);
    await new Promise<void>((resolve) => {
      uiWs.addEventListener("open", () => resolve());
    });
    uiWs.addEventListener("message", (ev) => {
      uiEvents.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
    });

    try {
      const preProject = await apiJson(`${server.url}/api/project`);
      expect(preProject.status).toBe(200);
      expect(preProject.body.initialized).toBe(false);

      const initRes = await apiJson(`${server.url}/api/project/init`, {
        method: "POST",
        body: JSON.stringify({ name: "srv-demo", privacyMode: "local" }),
      });
      expect(initRes.status).toBe(201);

      const createRes = await apiJson(`${server.url}/api/requirements`, {
        method: "POST",
        body: JSON.stringify({ goal: "添加服务端接口测试" }),
      });
      expect(createRes.status).toBe(201);
      const createdDetail = createRes.body.detail as { state: { id: string; stage: string; revision: number } };
      expect(createdDetail.state.id).toBe("REQ-001");
      expect(createdDetail.state.stage).toBe("planning");

      // CAS conflict returns 409
      const conflictRes = await apiJson(`${server.url}/api/requirements/REQ-001/spec`, {
        method: "PATCH",
        body: JSON.stringify({ title: "过期编辑", expectedRevision: 999 }),
      });
      expect(conflictRes.status).toBe(409);

      // External Agent tool mutation triggers fs.watch -> WS broadcast
      await executeWorkbenchTool(root, "wb_propose", {
        id: "REQ-001",
        criteria: [{ id: "AC-1", description: "脚本通过", required: true, command: "echo ok" }],
        design: "## API 方案\n增加测试覆盖。",
      });

      const approveRes = await apiJson(`${server.url}/api/requirements/REQ-001/approve`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(approveRes.status).toBe(200);

      fs.writeFileSync(path.join(root, "main.ts"), "export const ready = true;\nexport const tested = 1;\n");
      const diffRes = await apiJson(`${server.url}/api/requirements/REQ-001/diff`);
      expect(diffRes.status).toBe(200);
      expect((diffRes.body.changes as { diff: string }).diff).toContain("export const tested = 1");

      const verifyRes = await apiJson(`${server.url}/api/requirements/REQ-001/verify`, {
        method: "POST",
        body: JSON.stringify({ all: true }),
      });
      expect(verifyRes.status).toBe(200);

      const acceptRes = await apiJson(`${server.url}/api/requirements/REQ-001/accept`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(acceptRes.status).toBe(200);
      expect((acceptRes.body.detail as { state: { stage: string } }).state.stage).toBe("done");

      await new Promise((r) => setTimeout(r, 120));
      expect(uiEvents.some((e) => e.type === "workbench.updated")).toBe(true);
    } finally {
      uiWs.close();
    }
  }, 20_000);

  test("ensureServerForProject spawns a healthy background server and reuses it", async () => {
    const root = initGitRepo();
    const info1 = await ensureServerForProject(root);
    try {
      expect(info1.port).toBeGreaterThan(0);
      expect(info1.url).toContain("127.0.0.1:");
      const info2 = await ensureServerForProject(root);
      expect(info2.pid).toBe(info1.pid);
      expect(info2.url).toBe(info1.url);
      const health = await fetch(`${info1.url}/api/health`);
      expect(health.status).toBe(200);
    } finally {
      try { process.kill(info1.pid, "SIGTERM"); } catch { /* ignore */ }
      removeServerDiscovery(root, info1.pid);
    }
  });

  test("exposes Hub/project language preferences and GitHub Issue/PR routes via githubDeps", async () => {
    const origHubDir = process.env.WORKBENCH_HUB_DIR;
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-srv-gh-hub-"));
    const bareRemote = fs.mkdtempSync(path.join(os.tmpdir(), "wb-srv-gh-bare-"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-srv-gh-repo-"));
    tempDirs.push(hubDir, bareRemote, root);
    process.env.WORKBENCH_HUB_DIR = hubDir;

    try {
      execFileSync("git", ["init", "--bare", "--initial-branch=main"], { cwd: bareRemote, stdio: "ignore" });
      execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Server Test"], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "srv@example.com"], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["remote", "add", "origin", bareRemote], { cwd: root, stdio: "ignore" });
      fs.writeFileSync(path.join(root, "index.ts"), "export const v = 1;\n");
      execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["push", "-u", "origin", "main"], { cwd: root, stdio: "ignore" });

      const comments: Array<{ issueNumber: number; body: string }> = [];
      let nextIssue = 101;
      let nextPr = 20;
      const deps: GitHubCommandDeps = {
        whichGh: () => "/usr/local/bin/gh",
        resolveDefaultBaseBranch: async () => "main",
        runGh: async (_bin, args, opts) => {
          const [group, sub] = args;
          if (group === "auth" && sub === "status") {
            return { code: 0, stdout: "✓ Logged in to github.com account Jackie733\n", stderr: "" };
          }
          if (group === "repo" && sub === "view") {
            return { code: 0, stdout: JSON.stringify({ defaultBranchRef: { name: "main" } }), stderr: "" };
          }
          if (group === "issue" && sub === "view") {
            const num = Number(args[2]);
            return {
              code: 0,
              stdout: JSON.stringify({
                number: num,
                title: `Issue #${num}: 支持中文计划与 GitHub 集成`,
                body: "Detailed issue description from GitHub",
                url: `https://github.com/Jackie733/workbench-demo/issues/${num}`,
                state: "OPEN",
                labels: [{ name: "enhancement" }],
              }),
              stderr: "",
            };
          }
          if (group === "issue" && sub === "create") {
            const num = nextIssue++;
            return { code: 0, stdout: `https://github.com/Jackie733/workbench-demo/issues/${num}\n`, stderr: "" };
          }
          if (group === "issue" && sub === "comment") {
            comments.push({ issueNumber: Number(args[2]), body: opts.stdin ?? "" });
            return { code: 0, stdout: "", stderr: "" };
          }
          if (group === "pr" && sub === "list") {
            return { code: 0, stdout: "[]", stderr: "" };
          }
          if (group === "pr" && sub === "create") {
            const num = nextPr++;
            return { code: 0, stdout: `https://github.com/Jackie733/workbench-demo/pull/${num}\n`, stderr: "" };
          }
          return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
        },
      };

      const server = await startWorkbenchServer({ root, port: 0, writeDiscovery: false, githubDeps: deps });
      runningServers.push(server);

      await apiJson(`${server.url}/api/project/init`, { method: "POST", body: JSON.stringify({ name: "srv-gh" }) });

      const prefRes = await apiJson(`${server.url}/api/hub/preferences`, {
        method: "PUT",
        body: JSON.stringify({ outputLanguage: "en" }),
      });
      expect(prefRes.status).toBe(200);
      expect(prefRes.body.outputLanguage).toBe("en");

      const settingsRes = await apiJson(`${server.url}/api/project/settings`, {
        method: "PATCH",
        body: JSON.stringify({
          outputLanguage: "zh-CN",
          github: { repo: "Jackie733/workbench-demo", defaultBaseBranch: "main", autoSyncIssue: true },
        }),
      });
      expect(settingsRes.status).toBe(200);
      expect((settingsRes.body.project as { outputLanguage?: string }).outputLanguage).toBe("zh-CN");

      const statusRes = await apiJson(`${server.url}/api/github/status`);
      expect(statusRes.status).toBe(200);
      expect(statusRes.body.ready).toBe(true);
      expect(statusRes.body.account).toBe("Jackie733");
      expect(statusRes.body.repo).toBe("Jackie733/workbench-demo");

      const import1 = await apiJson(`${server.url}/api/requirements/import-issue`, {
        method: "POST",
        body: JSON.stringify({ issueRef: "#42" }),
      });
      expect(import1.status).toBe(201);
      expect(import1.body.alreadyExisted).toBe(false);
      const importedId = (import1.body.detail as { state: { id: string } }).state.id;

      const import2 = await apiJson(`${server.url}/api/requirements/import-issue`, {
        method: "POST",
        body: JSON.stringify({ issueRef: "42" }),
      });
      expect(import2.status).toBe(200);
      expect(import2.body.alreadyExisted).toBe(true);
      expect((import2.body.detail as { state: { id: string } }).state.id).toBe(importedId);

      // Create REQ-002 -> link new GitHub Issue -> sync Issue comment -> propose/approve/verify/accept -> deliver PR
      const createRes = await apiJson(`${server.url}/api/requirements`, {
        method: "POST",
        body: JSON.stringify({
          goal: "服务端 PR 交付联调",
          criteria: [{ id: "AC-1", description: "检查通过", required: true, command: "echo ok" }],
        }),
      });
      const req2Id = (createRes.body.detail as { state: { id: string } }).state.id;

      const linkRes = await apiJson(`${server.url}/api/requirements/${req2Id}/github/issue`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(linkRes.status).toBe(201);
      expect((linkRes.body.detail as { state: { github?: { issue?: { number: number } } } }).state.github?.issue?.number).toBe(101);

      const syncIssueRes = await apiJson(`${server.url}/api/requirements/${req2Id}/github/sync-issue`, {
        method: "POST",
        body: JSON.stringify({ comment: "需求已关联并进入方案阶段" }),
      });
      expect(syncIssueRes.status).toBe(200);
      expect(comments.some((c) => c.issueNumber === 101 && c.body.includes("需求已关联并进入方案阶段"))).toBe(true);

      await executeWorkbenchTool(root, "wb_propose", { id: req2Id, design: "# PR 方案" });
      await apiJson(`${server.url}/api/requirements/${req2Id}/approve`, { method: "POST", body: JSON.stringify({}) });
      fs.writeFileSync(path.join(root, "index.ts"), "export const v = 2;\n");
      const verifyRes = await apiJson(`${server.url}/api/requirements/${req2Id}/verify`, {
        method: "POST",
        body: JSON.stringify({ command: "echo ok", criterionIds: ["AC-1"] }),
      });
      expect(verifyRes.status).toBe(200);
      await apiJson(`${server.url}/api/requirements/${req2Id}/accept`, { method: "POST", body: JSON.stringify({}) });

      const deliverRes = await apiJson(`${server.url}/api/requirements/${req2Id}/deliver`, {
        method: "POST",
        body: JSON.stringify({
          files: ["index.ts"],
          commitMessage: "feat: deliver server PR",
          createPr: true,
        }),
      });
      expect(deliverRes.status).toBe(200);
      expect((deliverRes.body.pr as { number: number }).number).toBe(20);
      expect((deliverRes.body.detail as { state: { github?: { pr?: { number: number } } } }).state.github?.pr?.number).toBe(20);
    } finally {
      if (origHubDir === undefined) delete process.env.WORKBENCH_HUB_DIR;
      else process.env.WORKBENCH_HUB_DIR = origHubDir;
    }
  }, 15_000);

  test("GET /api/requirements isolates a single corrupt record instead of failing the whole list", async () => {
    const root = initGitRepo();
    const server = await startWorkbenchServer({ root, port: 0, writeDiscovery: false });
    runningServers.push(server);

    await apiJson(`${server.url}/api/project/init`, { method: "POST", body: JSON.stringify({}) });
    await apiJson(`${server.url}/api/requirements`, {
      method: "POST",
      body: JSON.stringify({ goal: "健康需求" }),
    });
    await apiJson(`${server.url}/api/requirements`, {
      method: "POST",
      body: JSON.stringify({ goal: "待损坏需求" }),
    });

    const corruptPath = path.join(root, ".workbench", "items", "REQ-002", "state.json");
    fs.writeFileSync(corruptPath, "{broken-json", "utf8");

    const listRes = await apiJson(`${server.url}/api/requirements?scope=all`);
    expect(listRes.status).toBe(200);
    const items = listRes.body.items as Array<{ id: string }>;
    const corruptItems = listRes.body.corruptItems as Array<{ id: string; code: string }>;
    expect(items.map((i) => i.id)).toEqual(["REQ-001"]);
    expect(corruptItems).toHaveLength(1);
    expect(corruptItems[0]!.id).toBe("REQ-002");
  });

  test("M3/M4 exposes project context, verification settings, parentId, and POST /api/requirements/:id/spawn", async () => {
    const root = initGitRepo();
    fs.writeFileSync(path.join(root, "AGENTS.md"), "# Arch\n\n## Layering\nStrict core/server split.");
    const server = await startWorkbenchServer({ root, port: 0, writeDiscovery: false });
    runningServers.push(server);

    await apiJson(`${server.url}/api/project/init`, { method: "POST", body: JSON.stringify({ name: "M4Test" }) });

    const projRes = await apiJson(`${server.url}/api/project`);
    expect(projRes.status).toBe(200);
    const context = projRes.body.context as { archDocs: Array<{ path: string }> };
    expect(context.archDocs.some((d) => d.path === "AGENTS.md")).toBe(true);

    const patchRes = await apiJson(`${server.url}/api/project/settings`, {
      method: "PATCH",
      body: JSON.stringify({
        verification: { fastCommand: "bun run typecheck", fullCommand: "bun test", autoScreenshots: false },
      }),
    });
    expect(patchRes.status).toBe(200);

    const updatedProj = await apiJson(`${server.url}/api/project`);
    expect((updatedProj.body.project as { verification?: Record<string, unknown> }).verification).toEqual({
      fastCommand: "bun run typecheck",
      fullCommand: "bun test",
      autoScreenshots: false,
    });

    await apiJson(`${server.url}/api/requirements`, {
      method: "POST",
      body: JSON.stringify({ goal: "拆分系统重构子需求" }),
    });
    await executeWorkbenchTool(root, "wb_propose", {
      id: "REQ-001",
      design: "# 整体设计\n\n## 拆分核心引擎模块\n核心层实现。\n\n## 增加前端抽屉适配\n抽屉交互优化。",
      criteria: [{ id: "AC-1", description: "typecheck passes", command: "bun run typecheck", required: true }],
    });

    const spawnRes = await apiJson(`${server.url}/api/requirements/REQ-001/spawn`, {
      method: "POST",
      body: JSON.stringify({ track: "fast_track" }),
    });
    expect(spawnRes.status).toBe(201);
    const created = spawnRes.body.created as Array<{ state: { id: string; parentId?: string; track: string } }>;
    expect(created).toHaveLength(2);
    expect(created[0]!.state.parentId).toBe("REQ-001");
    expect(created[0]!.state.track).toBe("fast_track");

    const parentGet = await apiJson(`${server.url}/api/requirements/REQ-001`);
    expect(parentGet.status).toBe(200);
    const subReqs = (parentGet.body.detail as { subRequirements?: Array<{ id: string }> }).subRequirements ?? [];
    expect(subReqs.map((s) => s.id).sort()).toEqual(["REQ-002", "REQ-003"]);

    // Fast-track authorization transitions REQ-002 to coding
    await executeWorkbenchTool(root, "wb_propose", {
      id: "REQ-002",
      criteria: [{ id: "AC-1", description: "ok", command: "echo ok", required: true }],
    });
    const ftRes = await apiJson(`${server.url}/api/requirements/REQ-002/fast-track`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(ftRes.status).toBe(200);
    expect((ftRes.body.detail as { state: { stage: string } }).state.stage).toBe("coding");
  });
});
