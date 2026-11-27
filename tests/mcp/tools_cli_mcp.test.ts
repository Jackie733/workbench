import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { approveDesign, createRequirement, initProject } from "../../src/core/engine.ts";
import { handleMcpMessage } from "../../src/mcp/server.ts";

const tempDirs: string[] = [];
const CLI_ENTRY = path.resolve(import.meta.dir, "../../src/cli/index.ts");

function initGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-mcp-test-"));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "index.ts"), "export const v = 1;\n");
  execFileSync("git", ["add", "index.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function runCliSubprocess(root: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync("bun", ["run", CLI_ENTRY, "--root", root, "--json", ...args], {
    encoding: "utf8",
  });
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("WB-03 MCP Server and wb CLI", () => {
  test("exposes strictly 5 orthogonal tools and rejects unauthorized approve/accept or passed spoofing", async () => {
    const root = initGitRepo();
    await initProject(root);
    await createRequirement(root, { goal: "新增健康检查接口" });

    const initResp = await handleMcpMessage(root, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", clientInfo: { name: "test", version: "1.0" } },
    });
    expect((initResp?.result as Record<string, unknown>)?.protocolVersion).toBe("2024-11-05");

    const listToolsResp = await handleMcpMessage(root, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (listToolsResp?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(tools).toEqual(["wb_list", "wb_get", "wb_propose", "wb_screenshot", "wb_screenshot_add", "wb_verify"]);

    // Reject unknown/privileged tools
    for (const forbidden of ["wb_approve", "wb_accept", "approve", "accept"]) {
      const resp = await handleMcpMessage(root, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: forbidden, arguments: { id: "REQ-001" } },
      });
      expect((resp?.result as { isError: boolean }).isError).toBe(true);
    }

    // Reject spoofing passed=true on wb_verify
    const spoofResp = await handleMcpMessage(root, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "wb_verify",
        arguments: { id: "REQ-001", command: "echo hi", criterionIds: [], passed: true },
      },
    });
    expect((spoofResp?.result as { isError: boolean }).isError).toBe(true);
    expect((spoofResp?.result as { content: Array<{ text: string }> }).content[0]!.text).toContain("invalid_input");
  });

  test("completes full Agent tool workflow over real stdio MCP subprocess", async () => {
    const root = initGitRepo();
    await initProject(root);
    await createRequirement(root, { goal: "实现 /health 返回 ok" });

    const child = spawn("bun", ["run", CLI_ENTRY, "--root", root, "mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const responses = new Map<number, Record<string, unknown>>();
    const waiters = new Map<number, (val: Record<string, unknown>) => void>();
    let buf = "";

    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          const msg = JSON.parse(line) as Record<string, unknown>;
          const id = msg.id as number;
          const waiter = waiters.get(id);
          if (waiter) {
            waiters.delete(id);
            waiter(msg);
          } else {
            responses.set(id, msg);
          }
        }
        nl = buf.indexOf("\n");
      }
    });

    let nextId = 1;
    const rpc = (method: string, params?: unknown) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const id = nextId++;
        const existing = responses.get(id);
        if (existing) {
          responses.delete(id);
          resolve(existing);
          return;
        }
        waiters.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });

    try {
      await rpc("initialize", { protocolVersion: "2024-11-05" });

      // 1. Agent lists & proposes spec + design
      const listRes = await rpc("tools/call", { name: "wb_list", arguments: {} });
      const listData = JSON.parse(((listRes.result as { content: Array<{ text: string }> }).content[0]!.text)) as {
        items: Array<{ id: string }>;
      };
      expect(listData.items[0]!.id).toBe("REQ-001");

      const propRes = await rpc("tools/call", {
        name: "wb_propose",
        arguments: {
          id: "REQ-001",
          title: "新增 /health 健康检查",
          spec: "提供 /health 端点并返回 JSON `{ ok: true }`",
          criteria: [{ id: "AC-1", description: "健康检查脚本返回 0", required: true, command: "bun -e 'console.log(1)'" }],
          design: "## 方案\n在路由表增加 `/health` 处理函数。",
        },
      });
      const propJson = JSON.parse((propRes.result as { content: Array<{ text: string }> }).content[0]!.text) as {
        stage: string;
      };
      expect(propJson.stage).toBe("planning");

      // 2. Agent cannot run verification before human approval
      const prematureVerify = await rpc("tools/call", {
        name: "wb_verify",
        arguments: { id: "REQ-001", command: "bun -e 'console.log(1)'", criterionIds: ["AC-1"] },
      });
      expect((prematureVerify.result as { isError: boolean }).isError).toBe(true);

      // 3. Human approves in core (simulating Web UI approval)
      await approveDesign(root, "REQ-001");

      // 4. Agent writes code and runs real verification via wb_verify
      fs.writeFileSync(path.join(root, "index.ts"), "export const v = 2;\nexport const health = () => ({ ok: true });\n");
      const verifyRes = await rpc("tools/call", {
        name: "wb_verify",
        arguments: { id: "REQ-001", command: "bun -e 'console.log(\"health ok\")'", criterionIds: ["AC-1"] },
      });
      const verifyJson = JSON.parse((verifyRes.result as { content: Array<{ text: string }> }).content[0]!.text) as {
        verification: { passed: boolean };
        acceptanceGate: { ok: boolean };
      };
      expect(verifyJson.verification.passed).toBe(true);
      expect(verifyJson.acceptanceGate.ok).toBe(true);

      const getDiffRes = await rpc("tools/call", {
        name: "wb_get",
        arguments: { id: "REQ-001", includeDiff: true },
      });
      const getDiffJson = JSON.parse((getDiffRes.result as { content: Array<{ text: string }> }).content[0]!.text) as {
        gitChanges: { diff: string };
      };
      expect(getDiffJson.gitChanges.diff).toContain("export const health");
    } finally {
      child.stdin.end();
      child.kill();
    }
  });

  test("wb CLI handles init, create, propose, verify, tasks, get --diff and rejects unauthorized commands", async () => {
    const root = initGitRepo();
    expect(runCliSubprocess(root, ["init", "--local"]).status).toBe(0);

    const created = runCliSubprocess(root, ["create", "通过 CLI 验证工作流"]);
    expect(created.status).toBe(0);
    expect(JSON.parse(created.stdout).id).toBe("REQ-001");

    const criteriaFile = path.join(root, "criteria.tmp.json");
    fs.writeFileSync(
      criteriaFile,
      JSON.stringify([{ id: "AC-1", description: "CLI 测试通过", required: true, command: "echo ok" }]),
    );
    const proposed = runCliSubprocess(root, [
      "propose",
      "REQ-001",
      "--design",
      "## CLI Design",
      "--criteria",
      `@${criteriaFile}`,
    ]);
    fs.rmSync(criteriaFile);
    expect(proposed.status).toBe(0);
    expect(JSON.parse(proposed.stdout).stage).toBe("planning");

    // CLI does not expose approve or accept
    expect(runCliSubprocess(root, ["approve", "REQ-001"]).status).toBe(1);
    expect(runCliSubprocess(root, ["accept", "REQ-001"]).status).toBe(1);

    await approveDesign(root, "REQ-001");

    const verified = runCliSubprocess(root, ["verify", "REQ-001", "--all"]);
    expect(verified.status).toBe(0);
    expect(JSON.parse(verified.stdout).coverage.requiredPassed).toBe(1);
  });

  test("wb config verification flags and wb spawn CLI", async () => {
    const root = initGitRepo();
    expect(runCliSubprocess(root, ["init", "--name", "CLISpawn"]).status).toBe(0);
    const cfg = runCliSubprocess(root, [
      "config",
      "--fast-command",
      "bun run typecheck",
      "--full-command",
      "bun test",
    ]);
    expect(cfg.status).toBe(0);
    const cfgJson = JSON.parse(cfg.stdout);
    expect(cfgJson.project.verification.fastCommand).toBe("bun run typecheck");
    expect(cfgJson.project.verification.fullCommand).toBe("bun test");

    const cfgRead = runCliSubprocess(root, ["config"]);
    expect(cfgRead.status).toBe(0);
    expect(JSON.parse(cfgRead.stdout).verification).toEqual({
      fastCommand: "bun run typecheck",
      fullCommand: "bun test",
    });

    expect(runCliSubprocess(root, ["create", "主架构拆分"]).status).toBe(0);
    const designText = "## 模块 A 拆分\n职责 A\n\n## 模块 B 拆分\n职责 B\n";
    expect(runCliSubprocess(root, ["propose", "REQ-001", "--design", designText]).status).toBe(0);

    const spawned = runCliSubprocess(root, ["spawn", "REQ-001", "--fast-track"]);
    expect(spawned.status).toBe(0);
    const spawnedJson = JSON.parse(spawned.stdout) as { parentId: string; created: Array<{ id: string; track: string }> };
    expect(spawnedJson.parentId).toBe("REQ-001");
    expect(spawnedJson.created.map((c) => c.id)).toEqual(["REQ-002", "REQ-003"]);
    expect(spawnedJson.created.every((c) => c.track === "fast_track")).toBe(true);
  });
});
