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
  getRequirementDiff,
  initProject,
  propose,
  reopenRequirement,
} from "../../src/core/engine.ts";
import { observeGitSnapshot } from "../../src/core/git.ts";
import { runVerification } from "../../src/core/runner.ts";
import { acceptanceSnapshotPath } from "../../src/core/store.ts";

const tempDirs: string[] = [];
const origHubEnv = process.env.WORKBENCH_HUB_DIR;

function makeGitRepo(prefix = "wb-delivery-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "app.ts"), "export const v = 1;\n");
  execFileSync("git", ["add", "app.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function makeTempHub(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-delivery-hub-"));
  tempDirs.push(dir);
  process.env.WORKBENCH_HUB_DIR = dir;
  return dir;
}

afterEach(() => {
  if (origHubEnv === undefined) delete process.env.WORKBENCH_HUB_DIR;
  else process.env.WORKBENCH_HUB_DIR = origHubEnv;
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("post-acceptance Git delivery wrap-up", () => {
  test("previews candidate files, commits only selected files without sweeping unrelated staged edits, and preserves acceptance snapshot", async () => {
    makeTempHub();
    const repo = makeGitRepo();
    await initProject(repo, { name: "DeliveryRepo", privacyMode: "local" });

    await createRequirement(repo, {
      goal: "Add delivery feature",
      criteria: [{ id: "AC-1", description: "passes", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Delivery design", actor: "agent" });
    const baseSnap = await observeGitSnapshot(repo);
    await approveDesign(repo, "REQ-001", { baseline: baseSnap });

    // Active requirement cannot be delivered yet
    const activePreview = await getRequirementDeliveryPreview(repo, "REQ-001");
    expect(activePreview.canCommit).toBe(false);

    // Edit feature files and verify + accept
    fs.writeFileSync(path.join(repo, "app.ts"), "export const v = 2;\n");
    fs.writeFileSync(path.join(repo, "feature.ts"), "export const feature = true;\n");
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const accSnap = await observeGitSnapshot(repo);
    const done = await acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: accSnap!.fingerprint });
    const snapshotFile = path.join(repo, acceptanceSnapshotPath("REQ-001", done.state.acceptance!.snapshot!.id));
    const snapshotBytesBefore = fs.readFileSync(snapshotFile, "utf8");

    // Introduce an unrelated staged file AFTER acceptance
    fs.writeFileSync(path.join(repo, "unrelated.ts"), "export const unrelated = 1;\n");
    execFileSync("git", ["add", "unrelated.ts"], { cwd: repo, stdio: "ignore" });

    const preview = await getRequirementDeliveryPreview(repo, "REQ-001");
    expect(preview.canCommit).toBe(true);
    expect(preview.candidates.find((c) => c.path === "app.ts")?.inAcceptedSnapshot).toBe(true);
    expect(preview.candidates.find((c) => c.path === "feature.ts")?.inAcceptedSnapshot).toBe(true);
    expect(preview.candidates.find((c) => c.path === "unrelated.ts")?.inAcceptedSnapshot).toBe(false);

    // Reject path traversal / .workbench paths / revision mismatch
    await expect(
      deliverRequirement(repo, "REQ-001", {
        files: [".workbench/items/REQ-001/state.json"],
        commitMessage: "bad path",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    await expect(
      deliverRequirement(repo, "REQ-001", {
        files: ["app.ts"],
        commitMessage: "wrong rev",
        expectedRevision: done.state.revision - 1,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });

    // Commit ONLY the accepted feature files
    const delivered = await deliverRequirement(repo, "REQ-001", {
      files: ["app.ts", "feature.ts"],
      commitMessage: "feat(req-001): add delivery feature",
      expectedRevision: done.state.revision,
      note: "Merged cleanly",
    });

    expect(delivered.delivery.files).toEqual(["app.ts", "feature.ts"]);
    expect(delivered.delivery.commitMessage).toBe("feat(req-001): add delivery feature");
    expect(delivered.detail.state.delivery?.commitHash).toBe(delivered.delivery.commitHash);
    expect(delivered.detail.validity.banner.headline).toContain(delivered.delivery.shortHash);

    // Verify git HEAD contains ONLY app.ts and feature.ts, while unrelated.ts remains staged
    const committedFiles = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .sort();
    expect(committedFiles).toEqual(["app.ts", "feature.ts"]);

    const remainingStatus = execFileSync("git", ["status", "--short"], { cwd: repo, encoding: "utf8" }).trim();
    expect(remainingStatus).toBe("A  unrelated.ts");

    // Acceptance snapshot remains untouched & byte-stable
    expect(fs.readFileSync(snapshotFile, "utf8")).toBe(snapshotBytesBefore);
    const frozenDiff = await getRequirementDiff(repo, "REQ-001");
    expect(frozenDiff.context).toBe("accepted");
    expect(frozenDiff.observation?.files.map((f) => f.path)).toEqual(["app.ts", "feature.ts"]);

    // Reopening clears delivery state while preserving timeline history
    const reopened = await reopenRequirement(repo, "REQ-001", {
      reason: "Follow-up",
      expectedRevision: delivered.detail.state.revision,
    });
    expect(reopened.state.delivery).toBeNull();
    expect(getRequirement(repo, "REQ-001").state.timeline.some((e) => e.kind === "delivered")).toBe(true);
  }, 20_000);
});
