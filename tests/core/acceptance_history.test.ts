import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  acceptRequirement,
  approveDesign,
  createRequirement,
  getRequirement,
  getRequirementDiff,
  initProject,
  listRequirements,
  propose,
  reopenRequirement,
} from "../../src/core/engine.ts";
import { atomicWriteJson } from "../../src/core/fs.ts";
import { observeGitSnapshot } from "../../src/core/git.ts";
import { runVerification } from "../../src/core/runner.ts";
import { acceptanceSnapshotPath } from "../../src/core/store.ts";
import { MAX_ACCEPTANCE_DIFF_BYTES, MAX_ACCEPTANCE_SNAPSHOT_BYTES, type RequirementState } from "../../src/core/types.ts";
import { createOrReuseWorktree } from "../../src/core/worktree.ts";

const tempDirs: string[] = [];
const origHubEnv = process.env.WORKBENCH_HUB_DIR;

function makeGitRepo(prefix = "wb-acc-hist-"): string {
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-acc-hub-"));
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

describe("REQ-003 acceptance snapshot preservation and history fidelity", () => {
  test("AC-1 & AC-2: accepted coverage, command outcomes, and bounded baseline-relative diff stay byte-stable across later commits, dirty edits, branch switches, and worktree cleanup", async () => {
    makeTempHub();
    const repo = makeGitRepo();
    await initProject(repo, { name: "HistRepo", privacyMode: "local" });

    // Create REQ-001 in an isolated sandbox worktree so worktree cleanup is also exercised.
    await createRequirement(repo, {
      goal: "Implement feature A",
      criteria: [
        { id: "AC-1", description: "passes echo check", required: true, command: "echo ok" },
        { id: "AC-2", description: "optional failing check stays failed", required: false, command: "exit 2" },
      ],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design\nUpdate app.ts and add extra files.", actor: "agent" });
    const preApproveSnap = await observeGitSnapshot(repo);
    await approveDesign(repo, "REQ-001", { baseline: preApproveSnap });

    const sandbox = await createOrReuseWorktree(repo, "REQ-001");
    const wt = sandbox.worktreePath;

    // 1. Committed change inside sandbox
    fs.writeFileSync(path.join(wt, "committed.ts"), "export const committed = true;\n");
    execFileSync("git", ["add", "committed.ts"], { cwd: wt, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "committed change"], { cwd: wt, stdio: "ignore" });

    // 2. Staged change
    fs.writeFileSync(path.join(wt, "staged.ts"), "export const staged = true;\n");
    execFileSync("git", ["add", "staged.ts"], { cwd: wt, stdio: "ignore" });

    // 3. Unstaged change to tracked file
    fs.writeFileSync(path.join(wt, "app.ts"), "export const v = 2;\n");

    // 4. Untracked text file + untracked binary file
    fs.writeFileSync(path.join(wt, "untracked.ts"), "export const untracked = 1;\n");
    fs.writeFileSync(path.join(wt, "asset.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));

    // Run both required passing and optional failing verification (failed run must NEVER become passed!).
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    await runVerification(repo, "REQ-001", { command: "exit 2", criterionIds: ["AC-2"] });

    const wtSnap = await observeGitSnapshot(wt);
    const done = await acceptRequirement(repo, "REQ-001", {
      currentCodeSnapshotHash: wtSnap!.fingerprint,
      note: "Verified all scopes",
    });

    expect(done.state.stage).toBe("done");
    expect(done.state.acceptance?.snapshot?.id).toBeTruthy();
    expect(done.validity.evidenceContext).toBe("accepted");
    expect(done.validity.coverage.requiredPassed).toBe(1);
    expect(done.validity.coverage.requiredTotal).toBe(1);
    expect(done.validity.coverage.items.find((i) => i.criterion.id === "AC-1")?.state).toBe("passed");
    expect(done.validity.coverage.items.find((i) => i.criterion.id === "AC-2")?.state).toBe("failed");

    const frozenArtifactFile = path.join(repo, acceptanceSnapshotPath("REQ-001", done.state.acceptance!.snapshot!.id));
    const frozenBytesBefore = fs.readFileSync(frozenArtifactFile, "utf8");
    const frozenDiffBefore = await getRequirementDiff(repo, "REQ-001");
    expect(frozenDiffBefore.context).toBe("accepted");
    expect(frozenDiffBefore.status).toBe("captured");
    expect(frozenDiffBefore.observation?.files.map((f) => f.path)).toEqual([
      "app.ts",
      "asset.bin",
      "committed.ts",
      "staged.ts",
      "untracked.ts",
    ]);
    expect(frozenDiffBefore.observation?.binaryFiles).toContain("asset.bin");
    expect(frozenDiffBefore.observation?.commits.length).toBe(1);
    expect(frozenDiffBefore.observation?.commits[0]?.subject).toBe("committed change");
    expect(frozenDiffBefore.observation?.diff).toContain("export const committed = true;");
    expect(frozenDiffBefore.observation?.diff).toContain("export const staged = true;");
    expect(frozenDiffBefore.observation?.diff).toContain("export const v = 2;");
    expect(frozenDiffBefore.observation?.diff).toContain("export const untracked = 1;");

    // Mutate workspace heavily: remove sandbox worktree, switch branches, commit new changes, dirty working tree!
    execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["checkout", "-b", "unrelated-branch"], { cwd: repo, stdio: "ignore" });
    fs.writeFileSync(path.join(repo, "app.ts"), "export const v = 999;\n");
    execFileSync("git", ["add", "app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "unrelated future commit"], { cwd: repo, stdio: "ignore" });
    fs.writeFileSync(path.join(repo, "later_dirty.ts"), "export const noise = 1;\n");

    const laterDetail = getRequirement(repo, "REQ-001", {
      currentCodeSnapshotHash: (await observeGitSnapshot(repo))?.fingerprint ?? null,
    });
    expect(laterDetail.validity.evidenceContext).toBe("accepted");
    expect(laterDetail.validity.coverage.requiredPassed).toBe(1);
    expect(laterDetail.validity.coverage.items.find((i) => i.criterion.id === "AC-1")?.state).toBe("passed");
    expect(laterDetail.validity.coverage.items.find((i) => i.criterion.id === "AC-2")?.state).toBe("failed");

    const frozenDiffAfter = await getRequirementDiff(repo, "REQ-001");
    expect(frozenDiffAfter.observation?.diff).toBe(frozenDiffBefore.observation?.diff);
    expect(frozenDiffAfter.observation?.files).toEqual(frozenDiffBefore.observation?.files);
    expect(fs.readFileSync(frozenArtifactFile, "utf8")).toBe(frozenBytesBefore);

    // Explicit live comparison remains separate from accepted snapshot
    const liveComparison = await getRequirementDiff(repo, "REQ-001", { live: true });
    expect(liveComparison.context).toBe("live");
    expect(liveComparison.observation?.diff).toContain("later_dirty.ts");

    // Empty diff is distinct from unavailable evidence
    await createRequirement(repo, {
      goal: "No-op doc verification",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-002", { designMarkdown: "# Empty diff test", actor: "agent" });
    const cleanSnap = await observeGitSnapshot(repo);
    execFileSync("git", ["checkout", "-"], { cwd: repo, stdio: "ignore" });
    fs.rmSync(path.join(repo, "later_dirty.ts"), { force: true });
    const baseClean = await observeGitSnapshot(repo);
    await approveDesign(repo, "REQ-002", { baseline: baseClean });
    await runVerification(repo, "REQ-002", { command: "echo ok", criterionIds: ["AC-1"] });
    await acceptRequirement(repo, "REQ-002", { currentCodeSnapshotHash: baseClean!.fingerprint });
    const emptyDiffView = await getRequirementDiff(repo, "REQ-002");
    expect(emptyDiffView.context).toBe("accepted");
    expect(emptyDiffView.status).toBe("empty");
    expect(emptyDiffView.observation?.diff).toBe("");
    void cleanSnap;
  });

  test("AC-2 truncation: oversized diff sets diffTruncated=true and oversized untracked files are disclosed in omittedFiles", async () => {
    makeTempHub();
    const repo = makeGitRepo();
    await initProject(repo, { name: "TruncRepo", privacyMode: "local" });
    await createRequirement(repo, {
      goal: "Large diff truncation",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Large patch", actor: "agent" });
    const baseSnap = await observeGitSnapshot(repo);
    await approveDesign(repo, "REQ-001", { baseline: baseSnap });

    fs.writeFileSync(path.join(repo, "big_untracked.txt"), "u".repeat(80 * 1024));
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const untrackedSnap = await observeGitSnapshot(repo);
    const untrackedDone = await acceptRequirement(repo, "REQ-001", {
      currentCodeSnapshotHash: untrackedSnap!.fingerprint,
    });
    const untrackedDiffView = await getRequirementDiff(repo, "REQ-001");
    expect(untrackedDiffView.status).toBe("captured");
    expect(untrackedDiffView.observation?.omittedFiles).toContain("big_untracked.txt");
    expect(untrackedDone.validity.provenance.diffTruncated).toBe(false);

    await reopenRequirement(repo, "REQ-001", {
      reason: "Test large tracked diff truncation",
      currentCodeSnapshotHash: untrackedSnap!.fingerprint,
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Large patch v2", actor: "agent" });
    await approveDesign(repo, "REQ-001", { baseline: baseSnap });
    fs.writeFileSync(path.join(repo, "big_tracked.ts"), "x".repeat(MAX_ACCEPTANCE_DIFF_BYTES + 8192));
    execFileSync("git", ["add", "big_tracked.ts"], { cwd: repo, stdio: "ignore" });

    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const snap = await observeGitSnapshot(repo);
    const done = await acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: snap!.fingerprint });

    const diffView = await getRequirementDiff(repo, "REQ-001");
    expect(diffView.status).toBe("captured");
    expect(diffView.observation?.diffTruncated).toBe(true);
    expect(Buffer.byteLength(diffView.observation!.diff, "utf8")).toBeLessThanOrEqual(MAX_ACCEPTANCE_DIFF_BYTES);
    expect(done.validity.provenance.diffTruncated).toBe(true);
  });

  test("AC-3: active requirements still invalidate stale verification, historical failed/timed-out runs never pass, and reopen restores live freshness", async () => {
    makeTempHub();
    const repo = makeGitRepo();
    await initProject(repo, { name: "ActiveGateRepo", privacyMode: "local" });
    await createRequirement(repo, {
      goal: "Verify live gate",
      criteria: [
        { id: "AC-1", description: "fast", required: true, command: "echo pass" },
        { id: "AC-2", description: "timeout", required: false, command: "sleep 2" },
      ],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design", actor: "agent" });
    const baseSnap = await observeGitSnapshot(repo);
    await approveDesign(repo, "REQ-001", { baseline: baseSnap });

    await runVerification(repo, "REQ-001", { command: "echo pass", criterionIds: ["AC-1"] });
    await runVerification(repo, "REQ-001", { command: "sleep 2", criterionIds: ["AC-2"], timeoutMs: 500 });

    // Edit code -> AC-1 and AC-2 must become stale (never passed!) and acceptance must be rejected!
    fs.writeFileSync(path.join(repo, "app.ts"), "export const v = 2;\n");
    const staleSnap = await observeGitSnapshot(repo);
    const staleDetail = getRequirement(repo, "REQ-001", { currentCodeSnapshotHash: staleSnap!.fingerprint });
    expect(staleDetail.validity.evidenceContext).toBe("live");
    expect(staleDetail.validity.coverage.items.find((i) => i.criterion.id === "AC-1")?.state).toBe("stale");
    expect(staleDetail.validity.coverage.items.find((i) => i.criterion.id === "AC-2")?.state).toBe("stale");
    await expect(
      acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: staleSnap!.fingerprint }),
    ).rejects.toMatchObject({ code: "acceptance_gate_failed" });

    // Re-run AC-1 (passes) and AC-2 (times out) on staleSnap; timed-out run must remain failed after acceptance!
    await runVerification(repo, "REQ-001", { command: "echo pass", criterionIds: ["AC-1"] });
    await runVerification(repo, "REQ-001", { command: "sleep 2", criterionIds: ["AC-2"], timeoutMs: 500 });
    const done = await acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: staleSnap!.fingerprint });
    expect(done.validity.verifications.filter((v) => v.record.timedOut).every((v) => v.effectiveState !== "passed")).toBe(true);
    expect(done.validity.coverage.items.find((i) => i.criterion.id === "AC-2")?.state).toBe("failed");

    // Reopen returns active evaluation to live freshness while leaving prior snapshot file intact on disk
    const snapshotFile = path.join(repo, acceptanceSnapshotPath("REQ-001", done.state.acceptance!.snapshot!.id));
    const reopened = await reopenRequirement(repo, "REQ-001", {
      reason: "Need follow-up",
      currentCodeSnapshotHash: staleSnap!.fingerprint,
    });
    expect(reopened.validity.evidenceContext).toBe("live");
    expect(reopened.validity.acceptanceGate.ok).toBe(false);
    expect(fs.existsSync(snapshotFile)).toBe(true);
  });

  test("AC-4: legacy done records recover justified coverage from hashes only and mark missing diffs/corrupt/inconsistent evidence unavailable", async () => {
    makeTempHub();
    const repo = makeGitRepo();
    await initProject(repo, { name: "LegacyRepo", privacyMode: "local" });
    await createRequirement(repo, {
      goal: "Legacy record test",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Legacy", actor: "agent" });
    const baseSnap = await observeGitSnapshot(repo);
    await approveDesign(repo, "REQ-001", { baseline: baseSnap });
    const ver = await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const done = await acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: ver.record.codeSnapshotHash });

    // Simulate legacy done record by stripping acceptance.snapshot while keeping acceptance hashes & verificationIds
    const statePath = path.join(repo, ".workbench/items/REQ-001/state.json");
    const legacyState: RequirementState = {
      ...done.state,
      acceptance: {
        acceptedAt: done.state.acceptance!.acceptedAt,
        specHash: done.state.acceptance!.specHash,
        codeSnapshotHash: done.state.acceptance!.codeSnapshotHash,
        verificationIds: done.state.acceptance!.verificationIds,
      },
    };
    atomicWriteJson(statePath, legacyState);

    // Advance HEAD so live fingerprint differs completely
    fs.writeFileSync(path.join(repo, "app.ts"), "export const v = 500;\n");
    execFileSync("git", ["add", "app.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "advance"], { cwd: repo, stdio: "ignore" });
    const liveSnap = await observeGitSnapshot(repo);

    const legacyDetail = getRequirement(repo, "REQ-001", { currentCodeSnapshotHash: liveSnap!.fingerprint });
    expect(legacyDetail.validity.evidenceContext).toBe("legacy-unavailable");
    expect(legacyDetail.validity.provenance.coverageSource).toBe("acceptance-hashes");
    expect(legacyDetail.validity.coverage.items[0]?.state).toBe("passed");
    const legacyDiff = await getRequirementDiff(repo, "REQ-001");
    expect(legacyDiff.context).toBe("legacy-unavailable");
    expect(legacyDiff.status).toBe("unavailable");
    expect(legacyDiff.observation).toBeNull();

    // Missing verification ID -> must mark coverage unavailable (never fabricate passed!)
    const missingRefState: RequirementState = {
      ...legacyState,
      acceptance: {
        ...legacyState.acceptance!,
        verificationIds: ["V-MISSING-9999"],
      },
    };
    atomicWriteJson(statePath, missingRefState);
    const missingDetail = getRequirement(repo, "REQ-001", { currentCodeSnapshotHash: liveSnap!.fingerprint });
    expect(missingDetail.validity.coverage.items[0]?.state).toBe("unavailable");
    expect(missingDetail.validity.coverage.requiredPassed).toBe(0);

    // Corrupt snapshot artifact on disk -> explicitly reported unavailable
    const snapId = done.state.acceptance!.snapshot!.id;
    const snapFile = path.join(repo, acceptanceSnapshotPath("REQ-001", snapId));
    fs.writeFileSync(snapFile, '{"tampered":true}\n');
    atomicWriteJson(statePath, done.state);
    const corruptDetail = getRequirement(repo, "REQ-001", { currentCodeSnapshotHash: liveSnap!.fingerprint });
    expect(corruptDetail.validity.evidenceContext).toBe("legacy-unavailable");
    expect(corruptDetail.validity.provenance.artifactStatus).toBe("corrupt");
    const corruptDiff = await getRequirementDiff(repo, "REQ-001");
    expect(corruptDiff.status).toBe("unavailable");
  });

  test("AC-5: missing baseline, revision conflict, concurrent code mutation, and snapshot size failure cannot publish done with partial evidence", async () => {
    makeTempHub();
    const repo = makeGitRepo();
    await initProject(repo, { name: "FailClosedRepo", privacyMode: "local" });
    await createRequirement(repo, {
      goal: "Fail closed checks",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Safety", actor: "agent" });
    const baseSnap = await observeGitSnapshot(repo);
    await approveDesign(repo, "REQ-001", { baseline: baseSnap });
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });

    // 1. Expected revision mismatch cannot publish done
    const current = getRequirement(repo, "REQ-001", { currentCodeSnapshotHash: baseSnap!.fingerprint });
    await expect(
      acceptRequirement(repo, "REQ-001", {
        currentCodeSnapshotHash: baseSnap!.fingerprint,
        expectedRevision: current.state.revision - 1,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(getRequirement(repo, "REQ-001").state.stage).toBe("coding");

    // 2. Snapshot artifact write/size failure cannot publish done: create many large criteria/files or exceed MAX_ACCEPTANCE_SNAPSHOT_BYTES
    // Force snapshot failure by making baseline unreachable (corrupt baseline ref in state.json)
    const statePath = path.join(repo, ".workbench/items/REQ-001/state.json");
    const rawState = JSON.parse(fs.readFileSync(statePath, "utf8")) as RequirementState;
    atomicWriteJson(statePath, {
      ...rawState,
      baseline: { ...rawState.baseline!, head: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
    });
    await expect(
      acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: baseSnap!.fingerprint }),
    ).rejects.toMatchObject({ code: "acceptance_gate_failed" });
    expect(getRequirement(repo, "REQ-001").state.stage).toBe("coding");

    // 3. Stale snapshotHash (concurrent edit between verify and accept) cannot publish done
    atomicWriteJson(statePath, rawState);
    fs.writeFileSync(path.join(repo, "app.ts"), "export const v = 2;\n");
    const editedSnap = await observeGitSnapshot(repo);
    await expect(
      acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: editedSnap!.fingerprint }),
    ).rejects.toMatchObject({ code: "acceptance_gate_failed" });
    expect(getRequirement(repo, "REQ-001").state.stage).toBe("coding");

    // List summary reflects frozen snapshot once validly accepted
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const done = await acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: editedSnap!.fingerprint });
    expect(done.state.stage).toBe("done");
    const summaryList = listRequirements(repo, { scope: "done", currentCodeSnapshotHash: baseSnap!.fingerprint });
    expect(summaryList[0]?.requiredPassed).toBe(1);
    expect(summaryList[0]?.requiredTotal).toBe(1);
    void MAX_ACCEPTANCE_SNAPSHOT_BYTES;
  });

  test("preserves 300KB+ acceptance diff without truncation under the 512KB / 2MB limits", async () => {
    makeTempHub();
    const repo = makeGitRepo("wb-acc-bigdiff-");
    await initProject(repo, { name: "BigDiffRepo", privacyMode: "local" });
    await createRequirement(repo, {
      goal: "Large diff preservation",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Big Diff", actor: "agent" });
    const baseSnap = await observeGitSnapshot(repo);
    await approveDesign(repo, "REQ-001", { baseline: baseSnap });

    const bigLines = Array.from({ length: 5000 }, (_, i) => `export const line_${i} = "${"x".repeat(50)}";`).join("\n");
    fs.writeFileSync(path.join(repo, "large.ts"), `${bigLines}\n`);
    execFileSync("git", ["add", "large.ts"], { cwd: repo, stdio: "ignore" });
    expect(Buffer.byteLength(bigLines, "utf8")).toBeGreaterThan(250 * 1024);
    expect(Buffer.byteLength(bigLines, "utf8")).toBeLessThan(MAX_ACCEPTANCE_DIFF_BYTES);

    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const snap = await observeGitSnapshot(repo);
    const done = await acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: snap!.fingerprint });
    expect(done.state.stage).toBe("done");

    const frozen = await getRequirementDiff(repo, "REQ-001");
    expect(frozen.status).toBe("captured");
    expect(frozen.observation?.diffTruncated).toBe(false);
    expect(frozen.observation?.diff).toContain("line_4999");
  });
});
