import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { authorizeFastTrack, createRequirement, initProject, recordScreenshotBatch } from "../../src/core/engine.ts";
import { observeGitSnapshot } from "../../src/core/git.ts";
import { readRequirementBundle } from "../../src/core/store.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";
import type { ScreenshotShot } from "../../src/core/types.ts";

const tempDirs: string[] = [];
const servers: WorkbenchServerHandle[] = [];
const origChrome = process.env.WORKBENCH_CHROME_PATH;
const origPuppeteer = process.env.WORKBENCH_PUPPETEER_PATH;
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lw7sNwAAAABJRU5ErkJggg==",
  "base64",
);

function initGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-shot-api-"));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "index.ts"), "export const v = 1;\n");
  execFileSync("git", ["add", "index.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function makeShot(index: number): ScreenshotShot {
  const id = `S-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
  return {
    id,
    label: "首页需求列表",
    urlPath: "/",
    viewport: "1440x900",
    theme: "light",
    path: `screenshots/shot-${id}.png`,
    sha256: createHash("sha256").update(PNG_BYTES).digest("hex"),
    sizeBytes: PNG_BYTES.length,
  };
}

afterEach(() => {
  while (servers.length > 0) servers.pop()!.stop();
  if (origChrome === undefined) delete process.env.WORKBENCH_CHROME_PATH;
  else process.env.WORKBENCH_CHROME_PATH = origChrome;
  if (origPuppeteer === undefined) delete process.env.WORKBENCH_PUPPETEER_PATH;
  else process.env.WORKBENCH_PUPPETEER_PATH = origPuppeteer;
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("REQ-011 screenshot HTTP API", () => {
  test("AC-5: serves PNG bytes, rejects traversal and missing shots, and gates capture by stage", async () => {
    const root = initGitRepo();
    await initProject(root);
    const server = await startWorkbenchServer({ root, port: 0, writeDiscovery: false });
    servers.push(server);

    const snapshot = await observeGitSnapshot(root);
    if (!snapshot) throw new Error("missing snapshot");
    const created = await createRequirement(root, {
      goal: "截图 API 测试",
      criteria: [{ id: "AC-1", description: "命令通过", required: true, command: "echo ok" }],
      track: "fast_track",
      currentCodeSnapshotHash: snapshot.fingerprint,
    });
    const id = created.state.id;

    const draftCapture = await fetch(`${server.url}/api/requirements/${id}/screenshots/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(draftCapture.status).toBe(409);

    await authorizeFastTrack(root, id, { baseline: snapshot, currentCodeSnapshotHash: snapshot.fingerprint });
    const shot = makeShot(0);
    const specHash = readRequirementBundle(root, id).state.specHash;
    await recordScreenshotBatch(root, id, {
      batch: {
        id: `SB-${Date.now()}-aaa111`,
        createdAt: Date.now(),
        trigger: "manual",
        actor: "human",
        specHash,
        codeSnapshotHash: snapshot.fingerprint,
        status: "captured",
        skipReason: null,
        shots: [shot],
        durationMs: 15,
      },
      files: [{ shotId: shot.id, bytes: PNG_BYTES }],
      currentCodeSnapshotHash: snapshot.fingerprint,
    });

    const pngResp = await fetch(`${server.url}/api/requirements/${id}/screenshots/${encodeURIComponent(shot.id)}`);
    expect(pngResp.status).toBe(200);
    expect(pngResp.headers.get("content-type")).toBe("image/png");
    expect(pngResp.headers.get("cache-control")).toContain("immutable");
    const bytes = Buffer.from(await pngResp.arrayBuffer());
    expect(bytes.equals(PNG_BYTES)).toBe(true);

    const traversal = await fetch(
      `${server.url}/api/requirements/${id}/screenshots/${encodeURIComponent("../../state.json")}`,
    );
    expect(traversal.status).toBe(400);

    const invalid = await fetch(`${server.url}/api/requirements/${id}/screenshots/not-a-shot`);
    expect(invalid.status).toBe(400);

    const missing = await fetch(`${server.url}/api/requirements/${id}/screenshots/S-1-missing`);
    expect(missing.status).toBe(404);

    process.env.WORKBENCH_CHROME_PATH = path.join(root, "missing-chrome");
    process.env.WORKBENCH_PUPPETEER_PATH = path.join(root, "missing-puppeteer.js");
    const captureResp = await fetch(`${server.url}/api/requirements/${id}/screenshots/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "验收补采" }),
    });
    expect(captureResp.status).toBe(200);
    const captureBody = (await captureResp.json()) as {
      detail: { state: { screenshotBatches: Array<{ status: string; skipReason: string | null }> } };
      screenshotCapture: { status: string; reason: string | null };
    };
    expect(captureBody.screenshotCapture.status).toBe("skipped");
    expect(captureBody.screenshotCapture.reason).toContain("WORKBENCH_CHROME_PATH");
    expect(captureBody.detail.state.screenshotBatches.length).toBe(2);
  });
});
