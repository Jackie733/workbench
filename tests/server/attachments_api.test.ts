import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeWorkbenchTool } from "../../src/mcp/tools.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";

const tempDirs: string[] = [];
const runningServers: WorkbenchServerHandle[] = [];
const origHubDir = process.env.WORKBENCH_HUB_DIR;

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function initGitRepo(): string {
  const dir = makeTempDir("wb-att-srv-");
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

async function upload(
  serverUrl: string,
  files: Array<{ name: string; bytes: Buffer; type?: string }>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData();
  for (const file of files) {
    form.append(
      "files",
      new File([Uint8Array.from(file.bytes)], file.name, { type: file.type ?? "application/octet-stream" }),
    );
  }
  const resp = await fetch(`${serverUrl}/api/uploads`, { method: "POST", body: form });
  return { status: resp.status, body: (await resp.json()) as Record<string, unknown> };
}

beforeEach(() => {
  const hub = makeTempDir("wb-att-srv-hub-");
  process.env.WORKBENCH_HUB_DIR = hub;
  delete process.env.WORKBENCH_RSI_DEPTH;
});

afterEach(() => {
  while (runningServers.length > 0) runningServers.pop()!.stop();
  if (origHubDir === undefined) delete process.env.WORKBENCH_HUB_DIR;
  else process.env.WORKBENCH_HUB_DIR = origHubDir;
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("附件服务端 API", () => {
  test("multipart 上传、创建需求携带附件、读取响应头、补传与删除", async () => {
    const root = initGitRepo();
    const server = await startWorkbenchServer({ root, port: 0, writeDiscovery: false });
    runningServers.push(server);

    await apiJson(`${server.url}/api/project/init`, {
      method: "POST",
      body: JSON.stringify({ name: "附件项目", privacyMode: "local" }),
    });

    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const uploaded = await upload(server.url, [{ name: "首页截图.png", bytes: pngBytes, type: "image/png" }]);
    expect(uploaded.status).toBe(201);
    const uploadedMetas = uploaded.body.attachments as Array<{ id: string; name: string; mimeType: string }>;
    expect(uploadedMetas).toHaveLength(1);
    expect(uploadedMetas[0]!.mimeType).toBe("image/png");

    const created = await apiJson(`${server.url}/api/requirements`, {
      method: "POST",
      body: JSON.stringify({ goal: "支持附件上传的集成测试", attachmentIds: [uploadedMetas[0]!.id] }),
    });
    expect(created.status).toBe(201);
    const detail = created.body.detail as {
      state: { id: string; attachments?: Array<{ id: string; name: string }> };
    };
    expect(detail.state.id).toBe("REQ-001");
    expect(detail.state.attachments).toHaveLength(1);
    expect(detail.state.attachments![0]!.name).toBe("首页截图.png");
    const storedPath = path.join(
      root,
      ".workbench",
      "items",
      "REQ-001",
      "attachments",
      `${uploadedMetas[0]!.id}.png`,
    );
    expect(fs.existsSync(storedPath)).toBe(true);

    const imageRes = await fetch(
      `${server.url}/api/requirements/REQ-001/attachments/${encodeURIComponent(uploadedMetas[0]!.id)}`,
    );
    expect(imageRes.status).toBe(200);
    expect(imageRes.headers.get("content-type")).toBe("image/png");
    expect(imageRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(imageRes.headers.get("content-disposition")).toContain("inline");
    expect(Buffer.from(await imageRes.arrayBuffer()).equals(pngBytes)).toBe(true);

    const pdfBytes = Buffer.from("%PDF-1.4\n附件日志");
    const pdfUpload = await upload(server.url, [{ name: "现场日志.pdf", bytes: pdfBytes, type: "application/pdf" }]);
    const pdfMeta = (pdfUpload.body.attachments as Array<{ id: string }>)[0]!;
    const added = await apiJson(`${server.url}/api/requirements/REQ-001/attachments`, {
      method: "POST",
      body: JSON.stringify({ attachmentIds: [pdfMeta.id] }),
    });
    expect(added.status).toBe(201);
    expect((added.body.detail as { state: { attachments: unknown[] } }).state.attachments).toHaveLength(2);

    const pdfRes = await fetch(`${server.url}/api/requirements/REQ-001/attachments/${encodeURIComponent(pdfMeta.id)}`);
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers.get("content-type")).toBe("application/pdf");
    expect(pdfRes.headers.get("content-disposition")).toContain("attachment");
    expect(pdfRes.headers.get("x-content-type-options")).toBe("nosniff");

    const missing = await fetch(`${server.url}/api/requirements/REQ-001/attachments/ATT-not-exist`);
    expect(missing.status).toBe(404);
    const traversal = await fetch(
      `${server.url}/api/requirements/REQ-001/attachments/${encodeURIComponent("../main.ts")}`,
    );
    expect(traversal.status).toBe(404);

    const deleted = await apiJson(`${server.url}/api/requirements/REQ-001/attachments/${encodeURIComponent(pdfMeta.id)}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    expect((deleted.body.detail as { state: { attachments: unknown[] } }).state.attachments).toHaveLength(1);
    expect(fs.existsSync(path.join(root, ".workbench", "items", "REQ-001", "attachments", `${pdfMeta.id}.pdf`))).toBe(false);
  });

  test("超限返回 413，accepted 阶段删除返回 409", async () => {
    const root = initGitRepo();
    const server = await startWorkbenchServer({ root, port: 0, writeDiscovery: false });
    runningServers.push(server);

    await apiJson(`${server.url}/api/project/init`, {
      method: "POST",
      body: JSON.stringify({ name: "附件限额", privacyMode: "local" }),
    });

    const tooBig = await upload(server.url, [
      { name: "big.zip", bytes: Buffer.alloc(10 * 1024 * 1024 + 1), type: "application/zip" },
    ]);
    expect(tooBig.status).toBe(413);

    const first = await upload(server.url, [{ name: "截图.png", bytes: Buffer.from([1, 2, 3]), type: "image/png" }]);
    const meta = (first.body.attachments as Array<{ id: string }>)[0]!;
    const created = await apiJson(`${server.url}/api/requirements`, {
      method: "POST",
      body: JSON.stringify({ goal: "验收后附件冻结", attachmentIds: [meta.id] }),
    });
    expect(created.status).toBe(201);

    await executeWorkbenchTool(root, "wb_propose", {
      id: "REQ-001",
      design: "## 方案\n验收后禁止修改附件。",
      criteria: [{ id: "AC-1", description: "命令通过", required: true, command: "true" }],
    });
    const approved = await apiJson(`${server.url}/api/requirements/REQ-001/approve`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(approved.status).toBe(200);
    const verified = await apiJson(`${server.url}/api/requirements/REQ-001/verify`, {
      method: "POST",
      body: JSON.stringify({ all: true }),
    });
    expect(verified.status).toBe(200);
    const accepted = await apiJson(`${server.url}/api/requirements/REQ-001/accept`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(accepted.status).toBe(200);

    const denied = await apiJson(`${server.url}/api/requirements/REQ-001/attachments/${encodeURIComponent(meta.id)}`, {
      method: "DELETE",
    });
    expect(denied.status).toBe(409);
  });

  test("报修携带附件只写元数据引用，并可通过 hub 路由读取", async () => {
    const root = initGitRepo();
    const server = await startWorkbenchServer({ root, port: 0, writeDiscovery: false });
    runningServers.push(server);
    await apiJson(`${server.url}/api/project/init`, {
      method: "POST",
      body: JSON.stringify({ name: "报修附件", privacyMode: "local" }),
    });

    const bytes = Buffer.from("console error line\n".repeat(100));
    const uploaded = await upload(server.url, [{ name: "浏览器控制台.log", bytes, type: "text/plain" }]);
    const meta = (uploaded.body.attachments as Array<{ id: string }>)[0]!;

    const reported = await apiJson(`${server.url}/api/hub/evolution/report`, {
      method: "POST",
      body: JSON.stringify({
        source: "ui_quick_report",
        category: "ui_anomaly",
        title: "附件报修链路",
        detail: "附带日志文件",
        attachmentIds: [meta.id],
      }),
    });
    expect(reported.status).toBe(201);
    const painPoint = reported.body.painPoint as { id: string; attachments?: Array<{ id: string; name: string }> };
    expect(painPoint.attachments).toHaveLength(1);
    expect(painPoint.attachments![0]!.name).toBe("浏览器控制台.log");

    const inboxPath = path.join(process.env.WORKBENCH_HUB_DIR!, "evolution", "inbox.jsonl");
    const inbox = fs.readFileSync(inboxPath, "utf8");
    expect(inbox).toContain(meta.id);
    expect(inbox).not.toContain(bytes.toString("base64").slice(0, 16));
    expect(Buffer.byteLength(inbox)).toBeLessThan(4096);

    const served = await fetch(
      `${server.url}/api/hub/evolution/${encodeURIComponent(painPoint.id)}/attachments/${encodeURIComponent(meta.id)}`,
    );
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("text/plain");
    expect(served.headers.get("content-disposition")).toContain("attachment");
    expect(Buffer.from(await served.arrayBuffer()).equals(bytes)).toBe(true);
  });
});
