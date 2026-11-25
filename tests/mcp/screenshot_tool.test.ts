import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { authorizeFastTrack, createRequirement, initProject, recordVerification } from "../../src/core/engine.ts";
import { observeGitSnapshot } from "../../src/core/git.ts";
import { captureRequirementScreenshots } from "../../src/core/screenshots.ts";
import { handleMcpMessage } from "../../src/mcp/server.ts";
import { executeWorkbenchTool } from "../../src/mcp/tools.ts";
import type { VerificationRecord } from "../../src/core/types.ts";

const tempDirs: string[] = [];
const origChrome = process.env.WORKBENCH_CHROME_PATH;
const origPuppeteer = process.env.WORKBENCH_PUPPETEER_PATH;

function initGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-shot-mcp-"));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "index.ts"), "export const v = 1;\n");
  execFileSync("git", ["add", "index.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function makeVerification(id: string, specHash: string, codeSnapshotHash: string): VerificationRecord {
  const now = Date.now();
  return {
    id,
    command: "echo ok",
    cwd: ".",
    criterionIds: ["AC-1"],
    specHash,
    codeSnapshotHash,
    exitCode: 0,
    timedOut: false,
    durationMs: 10,
    startedAt: now - 10,
    endedAt: now,
    passed: true,
    outputPath: `evidence/verify-${id}.log`,
    outputPreview: "ok",
    truncated: false,
  };
}

async function prepareReadyRequirement() {
  const root = initGitRepo();
  await initProject(root);
  const snapshot = await observeGitSnapshot(root);
  if (!snapshot) throw new Error("missing snapshot");
  const detail = await createRequirement(root, {
    goal: "UI 截图自动采集测试",
    criteria: [{ id: "AC-1", description: "命令通过", required: true, command: "echo ok" }],
    track: "fast_track",
    uiRelated: true,
    currentCodeSnapshotHash: snapshot.fingerprint,
  });
  const id = detail.state.id;
  await authorizeFastTrack(root, id, { baseline: snapshot, currentCodeSnapshotHash: snapshot.fingerprint });
  await recordVerification(root, id, {
    record: makeVerification("V-1", detail.state.specHash, snapshot.fingerprint),
    rawLog: "ok",
    currentCodeSnapshotHash: snapshot.fingerprint,
  });
  return { root, id, snapshot };
}

afterEach(() => {
  process.env.WORKBENCH_CHROME_PATH = origChrome ?? "";
  if (origChrome === undefined) delete process.env.WORKBENCH_CHROME_PATH;
  if (origPuppeteer === undefined) delete process.env.WORKBENCH_PUPPETEER_PATH;
  else process.env.WORKBENCH_PUPPETEER_PATH = origPuppeteer;
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("REQ-011 MCP screenshot tool and automatic trigger", () => {
  test("AC-4: registers wb_screenshot and rejects unknown or malformed arguments", async () => {
    const root = initGitRepo();
    await initProject(root);
    await createRequirement(root, { goal: "截图工具注册测试" });

    const listResp = await handleMcpMessage(root, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (listResp?.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;
    const screenshotTool = tools.find((tool) => tool.name === "wb_screenshot");
    expect(screenshotTool).toBeTruthy();
    expect(
      (screenshotTool!.inputSchema.required as string[]).includes("id"),
    ).toBe(true);

    const unknownArg = await handleMcpMessage(root, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "wb_screenshot", arguments: { id: "REQ-001", force: true } },
    });
    expect((unknownArg?.result as { isError: boolean }).isError).toBe(true);
    expect((unknownArg?.result as { content: Array<{ text: string }> }).content[0]!.text).toContain("invalid_input");

    const missingId = await handleMcpMessage(root, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "wb_screenshot", arguments: {} },
    });
    expect((missingId?.result as { isError: boolean }).isError).toBe(true);
  });

  test("AC-4: auto capture records a skipped batch without blocking acceptance", async () => {
    const { root, id } = await prepareReadyRequirement();
    process.env.WORKBENCH_CHROME_PATH = path.join(root, "missing-chrome");
    process.env.WORKBENCH_PUPPETEER_PATH = path.join(root, "missing-puppeteer.js");

    const shot = await captureRequirementScreenshots(root, id, {
      trigger: "auto_submit",
      actor: "system",
    });
    expect(shot.status).toBe("skipped");
    expect(shot.reason).toContain("WORKBENCH_CHROME_PATH");
    expect(shot.batch?.id).toBeTruthy();

    const detail = (await executeWorkbenchTool(root, "wb_get", { id })) as {
      stage: string;
      screenshotBatches?: Array<{ status: string; skipReason: string | null }>;
    };
    expect(detail.stage).toBe("coding");
    const batches = detail.screenshotBatches ?? [];
    expect(batches).toHaveLength(1);
    expect(batches[0]!.status).toBe("skipped");
    expect(batches[0]!.skipReason).toContain("WORKBENCH_CHROME_PATH");
  });

  test("AC-4: manual wb_screenshot degrades to skipped evidence when browser is unavailable", async () => {
    const { root, id } = await prepareReadyRequirement();
    process.env.WORKBENCH_CHROME_PATH = path.join(root, "missing-chrome");
    process.env.WORKBENCH_PUPPETEER_PATH = path.join(root, "missing-puppeteer.js");

    const res = (await executeWorkbenchTool(root, "wb_screenshot", {
      id,
      label: "人工补采",
    })) as { status: string; reason: string | null; screenshotCapture: { reason: string | null } };
    expect(res.status).toBe("skipped");
    expect(res.reason).toContain("WORKBENCH_CHROME_PATH");
    expect(res.screenshotCapture.reason).toContain("WORKBENCH_CHROME_PATH");
  });
});
