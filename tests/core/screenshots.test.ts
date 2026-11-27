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
import {
  attachRequirementScreenshots,
  captureRequirementScreenshots,
  collectStagedScreenshots,
  screenshotStagingDir,
} from "../../src/core/screenshots.ts";
import { readRequirementBundle, readRequirementScreenshot } from "../../src/core/store.ts";
import { runCli } from "../../src/cli/index.ts";
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

  test("AC-3: skips built-in Workbench UI screenshot matrix cleanly on external business repos", async () => {
    const root = makeTempProject();
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "deepmdt-frontend-pc", version: "1.0.0" }));
    execFileSync("git", ["add", "package.json"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "add external package.json"], { cwd: root, stdio: "ignore" });
    await initProject(root);
    const snapshot = await observeGitSnapshot(root);
    await createRequirement(root, {
      goal: "外部项目不应运行自举截图矩阵",
      criteria: [{ id: "AC-1", description: "lint ok", required: true, command: "echo ok" }],
    });
    await authorizeFastTrack(root, "REQ-001", { baseline: snapshot, currentCodeSnapshotHash: snapshot?.fingerprint });

    const res = await captureRequirementScreenshots(root, "REQ-001", {
      trigger: "manual",
      actor: "human",
      currentCodeSnapshotHash: snapshot?.fingerprint,
    });
    expect(res.status).toBe("skipped");
    expect(res.reasonCode).toBe("no_shots");
    expect(res.reason).toContain("外部业务项目");
    expect(res.batch?.source).toBe("matrix");
  });
});

describe("REQ-018 scenario screenshot attachment", () => {
  test("attaches PNG scenario evidence, derives viewport from IHDR and persists scene metadata", async () => {
    const { root, id, snapshot } = await prepareImplementingRequirement();
    const pngPath = path.join(root, "focus-state.png");
    fs.writeFileSync(pngPath, PNG_BYTES);

    const res = await attachRequirementScreenshots(root, id, {
      shots: [
        {
          file: pngPath,
          label: "保存按钮焦点态",
          description: "键盘聚焦后的高亮环",
          phase: "after",
          theme: "dark",
          urlPath: "/#focus-state",
          criterionIds: ["AC-1", "AC-1"],
        },
      ],
      currentCodeSnapshotHash: snapshot.fingerprint,
    });
    expect(res.status).toBe("captured");
    const batch = res.batch!;
    expect(batch.source).toBe("scenario");
    expect(batch.trigger).toBe("agent_attach");
    const currentSnapshot = await observeGitSnapshot(root);
    expect(currentSnapshot).toBeTruthy();
    expect(batch.codeSnapshotHash).toBe(currentSnapshot!.fingerprint);
    expect(batch.shots).toHaveLength(1);
    expect(batch.shots[0]!.viewport).toBe("1x1");
    expect(batch.shots[0]!.theme).toBe("dark");
    expect(batch.shots[0]!.phase).toBe("after");
    expect(batch.shots[0]!.description).toBe("键盘聚焦后的高亮环");
    expect(batch.shots[0]!.criterionIds).toEqual(["AC-1"]);
    expect(batch.shots[0]!.urlPath).toBe("/#focus-state");

    const stored = readRequirementBundle(root, id).state.screenshotBatches ?? [];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.source).toBe("scenario");
    const png = readRequirementScreenshot(root, id, batch.shots[0]!.id);
    expect(png.bytes.equals(PNG_BYTES)).toBe(true);
  });

  test("supports external repositories and enforces PNG magic, symlink and stage guards", async () => {
    const { root, id } = await prepareImplementingRequirement();
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "external-ui-app", version: "1.0.0" }));
    const pngPath = path.join(root, "external-state.png");
    fs.writeFileSync(pngPath, PNG_BYTES);

    const external = await attachRequirementScreenshots(root, id, {
      shots: [{ file: pngPath, label: "外部项目场景", theme: "light" }],
    });
    expect(external.status).toBe("captured");
    expect(external.batch?.source).toBe("scenario");

    const invalidPath = path.join(root, "not-a-png.png");
    fs.writeFileSync(invalidPath, "not a png");
    await expect(
      attachRequirementScreenshots(root, id, { shots: [{ file: invalidPath, label: "非法文件" }] }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    const linkPath = path.join(root, "link-state.png");
    fs.symlinkSync(pngPath, linkPath);
    await expect(
      attachRequirementScreenshots(root, id, { shots: [{ file: linkPath, label: "符号链接" }] }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    const planningRoot = makeTempProject();
    await initProject(planningRoot);
    const planning = await createRequirement(planningRoot, { goal: "规划阶段不可提交截图" });
    await expect(
      attachRequirementScreenshots(planningRoot, planning.state.id, {
        shots: [{ file: pngPath, label: "越阶段" }],
      }),
    ).rejects.toMatchObject({ code: "approval_required" });
  });

  test("collects staged manifest screenshots once and cleans the staging directory", async () => {
    const { root, id, snapshot } = await prepareImplementingRequirement();
    const staging = screenshotStagingDir(root, id);
    fs.mkdirSync(staging, { recursive: true });
    const beforePng = path.join(staging, "before.png");
    const afterPng = path.join(staging, "after.png");
    fs.writeFileSync(beforePng, PNG_BYTES);
    fs.writeFileSync(afterPng, PNG_BYTES);
    fs.writeFileSync(
      path.join(staging, "manifest.json"),
      JSON.stringify({
        shots: [
          { file: "before.png", label: "改动前基线", phase: "before", description: "旧版布局" },
          { file: "after.png", label: "改动后结果", phase: "after", criterionIds: ["AC-1"] },
        ],
      }),
    );

    const collected = await collectStagedScreenshots(root, id, {
      currentCodeSnapshotHash: snapshot.fingerprint,
    });
    expect(collected.attached).toBe(true);
    expect(collected.count).toBe(2);
    expect(collected.batch?.source).toBe("scenario");
    expect(collected.batch?.trigger).toBe("auto_collect");
    expect(collected.batch?.shots.map((shot) => shot.phase)).toEqual(["before", "after"]);
    expect(fs.existsSync(beforePng)).toBe(false);
    expect(fs.existsSync(afterPng)).toBe(false);
    expect(fs.existsSync(path.join(staging, "manifest.json"))).toBe(false);

    const again = await collectStagedScreenshots(root, id);
    expect(again.attached).toBe(false);
  });

  test("rejects staged manifest paths that escape via symlinked directories", async () => {
    const { root, id } = await prepareImplementingRequirement();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "wb-shot-outside-"));
    tempDirs.push(outside);
    const outsidePng = path.join(outside, "secret.png");
    fs.writeFileSync(outsidePng, PNG_BYTES);
    const staging = screenshotStagingDir(root, id);
    fs.mkdirSync(staging, { recursive: true });
    fs.symlinkSync(outside, path.join(staging, "sub"), "dir");
    fs.writeFileSync(
      path.join(staging, "manifest.json"),
      JSON.stringify({ shots: [{ file: "sub/secret.png", label: "越界读取" }] }),
    );

    await expect(collectStagedScreenshots(root, id)).rejects.toMatchObject({ code: "invalid_input" });
    expect(fs.existsSync(outsidePng)).toBe(true);
    expect(readRequirementBundle(root, id).state.screenshotBatches ?? []).toHaveLength(0);
  });

  test("rejects invalid staged metadata instead of silently falling back to defaults", async () => {
    const { root, id } = await prepareImplementingRequirement();
    const staging = screenshotStagingDir(root, id);
    fs.mkdirSync(staging, { recursive: true });
    const png = path.join(staging, "shot.png");
    fs.writeFileSync(png, PNG_BYTES);

    const invalidEntries = [
      { file: "shot.png", label: "非法主题", theme: "sepia" },
      { file: "shot.png", label: "非法条件", criterionIds: ["AC-1", 7] },
      { file: "shot.png", label: "非法阶段", phase: "during" },
    ];
    for (const entry of invalidEntries) {
      fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify({ shots: [entry] }));
      await expect(collectStagedScreenshots(root, id)).rejects.toMatchObject({ code: "invalid_input" });
      expect(fs.existsSync(png)).toBe(true);
    }
    expect(readRequirementBundle(root, id).state.screenshotBatches ?? []).toHaveLength(0);
  });

  test("CLI screenshot add registers a single scenario shot", async () => {
    const { root, id } = await prepareImplementingRequirement();
    const pngPath = path.join(root, "cli-scene.png");
    fs.writeFileSync(pngPath, PNG_BYTES);

    const code = await runCli([
      "--root",
      root,
      "--json",
      "screenshot",
      "add",
      id,
      "--file",
      pngPath,
      "--label",
      "CLI 场景",
      "--phase",
      "after",
      "--theme",
      "dark",
      "--viewport",
      "12x34",
      "--url",
      "/#cli",
      "--description",
      "CLI 提交说明",
      "--criteria",
      "AC-1,AC-2",
    ]);
    expect(code).toBe(0);
    const batch = (readRequirementBundle(root, id).state.screenshotBatches ?? []).at(-1)!;
    expect(batch.source).toBe("scenario");
    expect(batch.trigger).toBe("agent_attach");
    expect(batch.shots).toHaveLength(1);
    expect(batch.shots[0]!.label).toBe("CLI 场景");
    expect(batch.shots[0]!.phase).toBe("after");
    expect(batch.shots[0]!.theme).toBe("dark");
    expect(batch.shots[0]!.viewport).toBe("12x34");
    expect(batch.shots[0]!.urlPath).toBe("/#cli");
    expect(batch.shots[0]!.description).toBe("CLI 提交说明");
    expect(batch.shots[0]!.criterionIds).toEqual(["AC-1", "AC-2"]);

    const rejected = await runCli([
      "--root",
      root,
      "--json",
      "screenshot",
      "add",
      id,
      "--file",
      pngPath,
      "--label",
      "非法主题",
      "--theme",
      "sepia",
    ]);
    expect(rejected).toBe(1);
    expect(readRequirementBundle(root, id).state.screenshotBatches ?? []).toHaveLength(1);
  });

  test("CLI screenshot add --manifest resolves relative files from the manifest directory", async () => {
    const { root, id } = await prepareImplementingRequirement();
    const shotDir = fs.mkdtempSync(path.join(root, "cli-manifest-"));
    fs.writeFileSync(path.join(shotDir, "before.png"), PNG_BYTES);
    fs.writeFileSync(path.join(shotDir, "after.png"), PNG_BYTES);
    const manifestPath = path.join(shotDir, "manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        shots: [
          { file: "before.png", label: "清单改动前", phase: "before" },
          { file: "after.png", label: "清单改动后", phase: "after", criteria: ["AC-1"] },
        ],
      }),
    );

    const code = await runCli(["--root", root, "--json", "screenshot", "add", id, "--manifest", manifestPath]);
    expect(code).toBe(0);
    const batch = (readRequirementBundle(root, id).state.screenshotBatches ?? []).at(-1)!;
    expect(batch.source).toBe("scenario");
    expect(batch.shots).toHaveLength(2);
    expect(batch.shots.map((shot) => shot.phase)).toEqual(["before", "after"]);
    expect(batch.shots[1]!.criterionIds).toEqual(["AC-1"]);
  });

  test("keeps legacy batches without source backward compatible", async () => {
    const { root, id, snapshot } = await prepareImplementingRequirement();
    const { shot, bytes } = makeShot(0);
    await recordScreenshotBatch(root, id, {
      batch: makeBatch(0, readRequirementBundle(root, id).state.specHash, snapshot.fingerprint, [shot]),
      files: [{ shotId: shot.id, bytes }],
      currentCodeSnapshotHash: snapshot.fingerprint,
    });
    const batch = (readRequirementBundle(root, id).state.screenshotBatches ?? [])[0]!;
    expect(batch.source).toBeUndefined();
    expect(batch.trigger).toBe("manual");
  });
});
