import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  acceptRequirement,
  authorizeFastTrack,
  createRequirement,
  initProject,
  isUiRelatedRequirement,
  recordScreenshotBatch,
  recordVerification,
} from "../../src/core/engine.ts";
import { observeGitSnapshot } from "../../src/core/git.ts";
import { readRequirementBundle, readRequirementScreenshot } from "../../src/core/store.ts";
import {
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOTS_PER_BATCH,
  type ScreenshotBatch,
  type ScreenshotShot,
  type VerificationRecord,
} from "../../src/core/types.ts";

const tempDirs: string[] = [];
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lw7sNwAAAABJRU5ErkJggg==",
  "base64",
);

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-shot-core-"));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.mkdirSync(path.join(dir, "src", "web"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.ts"), "export const value = 1;\n");
  fs.writeFileSync(path.join(dir, "src", "web", "App.tsx"), "export const App = () => null;\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function sha(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

function makeShot(index: number, options: { sizeBytes?: number; bytesLength?: number } = {}): {
  shot: ScreenshotShot;
  bytes: Buffer;
} {
  const id = `S-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
  const bytes = PNG_BYTES;
  const sizeBytes = options.sizeBytes ?? bytes.length;
  return {
    shot: {
      id,
      label: `首页需求列表 ${index}`,
      urlPath: "/",
      viewport: index % 2 === 0 ? "1440x900" : "390x844",
      theme: index % 2 === 0 ? "light" : "dark",
      path: `screenshots/shot-${id}.png`,
      sha256: sha(id),
      sizeBytes,
    },
    bytes,
  };
}

function makeBatch(
  index: number,
  specHash: string,
  codeSnapshotHash: string,
  shots: ScreenshotShot[] = [],
  overrides: Partial<ScreenshotBatch> = {},
): ScreenshotBatch {
  return {
    id: `SB-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 6)}`,
    createdAt: Date.now() + index,
    trigger: "manual",
    actor: "agent",
    specHash,
    codeSnapshotHash,
    status: shots.length > 0 ? "captured" : "skipped",
    skipReason: shots.length > 0 ? null : "浏览器环境不可用",
    shots,
    durationMs: 12,
    ...overrides,
  };
}

function makeVerification(
  id: string,
  specHash: string,
  codeSnapshotHash: string,
  criterionIds: string[],
): VerificationRecord {
  const now = Date.now();
  return {
    id,
    command: "echo ok",
    cwd: ".",
    criterionIds,
    specHash,
    codeSnapshotHash,
    exitCode: 0,
    timedOut: false,
    durationMs: 12,
    startedAt: now - 12,
    endedAt: now,
    passed: true,
    outputPath: `evidence/verify-${id}.log`,
    outputPreview: "ok",
    truncated: false,
  };
}

async function prepareImplementingRequirement() {
  const root = makeTempProject();
  await initProject(root);
  const snapshot = await observeGitSnapshot(root);
  if (!snapshot) throw new Error("missing git snapshot");
  const detail = await createRequirement(root, {
    goal: "验证 UI 截图证据链路",
    criteria: [{ id: "AC-1", description: "命令通过", required: true, command: "echo ok" }],
    track: "fast_track",
    currentCodeSnapshotHash: snapshot.fingerprint,
  });
  const id = detail.state.id;
  await authorizeFastTrack(root, id, {
    baseline: snapshot,
    currentCodeSnapshotHash: snapshot.fingerprint,
  });
  return { root, id, snapshot };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("REQ-011 screenshot evidence persistence", () => {
  test("AC-3: writes/reads PNG evidence, keeps only the newest 5 batches and trims old files", async () => {
    const { root, id, snapshot } = await prepareImplementingRequirement();
    const firstPaths: string[] = [];

    for (let i = 0; i < 6; i++) {
      const { shot, bytes } = makeShot(i);
      firstPaths.push(shot.path);
      const bundleBefore = readRequirementBundle(root, id);
      await recordScreenshotBatch(root, id, {
        batch: makeBatch(i, bundleBefore.state.specHash, snapshot.fingerprint, [shot]),
        files: [{ shotId: shot.id, bytes }],
        currentCodeSnapshotHash: snapshot.fingerprint,
      });
    }

    const bundle = readRequirementBundle(root, id);
    const batches = bundle.state.screenshotBatches ?? [];
    expect(batches).toHaveLength(5);
    expect(batches[batches.length - 1]!.shots).toHaveLength(1);

    const itemDir = path.join(root, ".workbench", "items", id);
    expect(fs.existsSync(path.join(itemDir, firstPaths[0]!))).toBe(false);
    const latestShot = batches[batches.length - 1]!.shots[0]!;
    expect(fs.existsSync(path.join(itemDir, latestShot.path))).toBe(true);

    const read = readRequirementScreenshot(root, id, latestShot.id);
    expect(read.bytes.equals(PNG_BYTES)).toBe(true);
    expect(read.shot.sha256).toBe(latestShot.sha256);
  });

  test("AC-3: enforces per-shot 2MB, per-batch 12 shots and stage gates", async () => {
    const { root, id, snapshot } = await prepareImplementingRequirement();
    const specHash = readRequirementBundle(root, id).state.specHash;

    const oversized = makeShot(0, { sizeBytes: MAX_SCREENSHOT_BYTES + 1 });
    await expect(
      recordScreenshotBatch(root, id, {
        batch: makeBatch(0, specHash, snapshot.fingerprint, [oversized.shot]),
        files: [{ shotId: oversized.shot.id, bytes: oversized.bytes }],
        currentCodeSnapshotHash: snapshot.fingerprint,
      }),
    ).rejects.toMatchObject({ code: "corrupt_record" });

    const shots = Array.from({ length: MAX_SCREENSHOTS_PER_BATCH + 1 }, (_, index) => makeShot(index).shot);
    await expect(
      recordScreenshotBatch(root, id, {
        batch: makeBatch(1, specHash, snapshot.fingerprint, shots),
        files: [],
        currentCodeSnapshotHash: snapshot.fingerprint,
      }),
    ).rejects.toMatchObject({ code: "corrupt_record" });

    const { shot, bytes } = makeShot(99);
    await recordScreenshotBatch(root, id, {
      batch: makeBatch(99, specHash, snapshot.fingerprint, [shot]),
      files: [{ shotId: shot.id, bytes }],
      currentCodeSnapshotHash: snapshot.fingerprint,
    });
  });

  test("AC-3: detects explicit UI marker and src/web changes, ignores unrelated changes", async () => {
    const root = makeTempProject();
    await initProject(root);
    const explicit = await createRequirement(root, {
      goal: "显式标记 UI 需求",
      uiRelated: true,
    });
    expect(await isUiRelatedRequirement(explicit.state, root)).toBe(true);

    const plain = await createRequirement(root, { goal: "后端日志调整" });
    expect(await isUiRelatedRequirement(plain.state, root)).toBe(false);
    fs.writeFileSync(path.join(root, "src", "web", "App.tsx"), "export const App = () => 'changed';\n");
    expect(await isUiRelatedRequirement(plain.state, root)).toBe(true);
  });

  test("AC-3: freezes screenshot metadata into acceptance snapshot and reports missing PNG", async () => {
    const { root, id, snapshot } = await prepareImplementingRequirement();
    const { shot, bytes } = makeShot(0);
    await recordScreenshotBatch(root, id, {
      batch: makeBatch(0, readRequirementBundle(root, id).state.specHash, snapshot.fingerprint, [shot]),
      files: [{ shotId: shot.id, bytes }],
      currentCodeSnapshotHash: snapshot.fingerprint,
    });

    const bundle = readRequirementBundle(root, id);
    await recordVerification(root, id, {
      record: makeVerification("V-1", bundle.state.specHash, snapshot.fingerprint, ["AC-1"]),
      rawLog: "ok",
      currentCodeSnapshotHash: snapshot.fingerprint,
    });

    const afterVerify = readRequirementBundle(root, id);
    const done = await acceptRequirement(root, id, {
      currentCodeSnapshotHash: snapshot.fingerprint,
      expectedRevision: afterVerify.state.revision,
    });
    expect(done.state.stage).toBe("done");
    const snapshots = done.acceptanceSnapshot?.screenshots ?? [];
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.shots[0]!.id).toBe(shot.id);

    const available = readRequirementBundle(root, id);
    expect(available.acceptanceSnapshotStatus).toBe("available");

    fs.rmSync(path.join(root, ".workbench", "items", id, shot.path), { force: true });
    const missing = readRequirementBundle(root, id);
    expect(missing.acceptanceSnapshotStatus).toBe("missing");
    expect(missing.acceptanceSnapshotReason).toContain("截图文件缺失");

    await expect(
      recordScreenshotBatch(root, id, {
        batch: makeBatch(1, bundle.state.specHash, snapshot.fingerprint, []),
        currentCodeSnapshotHash: snapshot.fingerprint,
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
  });
});
