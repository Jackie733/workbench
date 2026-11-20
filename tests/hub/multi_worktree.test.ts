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
  initProject,
  propose,
  reopenRequirement,
  updateProjectConfig,
  updateTasks,
} from "../../src/core/engine.ts";
import { observeGitSnapshot } from "../../src/core/git.ts";
import type { GitHubCommandDeps } from "../../src/core/github.ts";
import { runVerification } from "../../src/core/runner.ts";
import {
  applySandboxToMain,
  cascadeSyncProjectSandboxes,
  createOrReuseWorktree,
  inspectRsiSandboxDrift,
  prepareSandboxConflictResolution,
  recommendSandboxMergeOrder,
  syncRsiSandboxBase,
} from "../../src/hub/evolution.ts";
import { HubExecutor } from "../../src/hub/executor.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";

const tempDirs: string[] = [];
const servers: WorkbenchServerHandle[] = [];
const origHubEnv = process.env.WORKBENCH_HUB_DIR;

function makeTempHub(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-mwt-hub-"));
  tempDirs.push(dir);
  process.env.WORKBENCH_HUB_DIR = dir;
  return dir;
}

function makeMultiLineRepo(name = "mwt-repo"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wb-${name}-`));
  tempDirs.push(dir);
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  const lines = Array.from({ length: 40 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join("\n") + "\n";
  fs.writeFileSync(path.join(dir, "shared.ts"), lines);
  fs.writeFileSync(path.join(dir, "leaf.ts"), "export const leaf = 0;\n");
  execFileSync("git", ["add", "shared.ts", "leaf.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function makeBareRemoteRepo(name = "mwt-remote"): { repo: string; bare: string } {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), `wb-${name}-bare-`));
  tempDirs.push(bare);
  execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: bare, stdio: "ignore" });
  const repo = makeMultiLineRepo(name);
  execFileSync("git", ["remote", "add", "origin", bare], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repo, stdio: "ignore" });
  return { repo, bare };
}

afterEach(async () => {
  while (servers.length > 0) {
    servers.pop()!.stop();
  }
  if (origHubEnv === undefined) delete process.env.WORKBENCH_HUB_DIR;
  else process.env.WORKBENCH_HUB_DIR = origHubEnv;
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Multi-Worktree collaboration, merge-tree conflict detection, and lifecycle sync", () => {
  test("git merge-tree detects auto_mergeable shared file edits (even with WIP) vs true line conflicts", async () => {
    makeTempHub();
    const repo = makeMultiLineRepo("merge-tree");
    await initProject(repo, { name: "MergeTreeTest", privacyMode: "local" });
    await createRequirement(repo, {
      goal: "Modify top of shared.ts",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design\nTop edit.", actor: "agent" });
    await approveDesign(repo, "REQ-001");

    const sb = await createOrReuseWorktree(repo, "REQ-001", { branchPrefix: "feat" });
    expect(sb.branch).toBe("feat/req-001");

    // Edit line 1 in worktree (uncommitted WIP)
    const wtOrig = fs.readFileSync(path.join(sb.worktreePath, "shared.ts"), "utf8");
    fs.writeFileSync(path.join(sb.worktreePath, "shared.ts"), wtOrig.replace("export const line1 = 1;", "export const line1 = 100;"));

    // Edit line 40 in main (same file, non-overlapping hunk!)
    const mainOrig = fs.readFileSync(path.join(repo, "shared.ts"), "utf8");
    fs.writeFileSync(path.join(repo, "shared.ts"), mainOrig.replace("export const line40 = 40;", "export const line40 = 400;"));
    execFileSync("git", ["add", "shared.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "main edits line 40"], { cwd: repo, stdio: "ignore" });

    const driftAuto = await inspectRsiSandboxDrift(repo, "REQ-001");
    expect(driftAuto?.driftStatus).toBe("auto_mergeable");
    expect(driftAuto?.overlapFiles).toEqual(["shared.ts"]);
    expect(driftAuto?.conflictFiles).toEqual([]);
    expect(driftAuto?.canAutoSync).toBe(true);

    // Auto-sync cleanly 3-way merges both line 1 WIP and line 40 main commit!
    const syncRes = await syncRsiSandboxBase(repo, "REQ-001", { fetchRemote: false });
    expect(syncRes.synced).toBe(true);
    expect(syncRes.drift.behindCount).toBe(0);
    const mergedContent = fs.readFileSync(path.join(sb.worktreePath, "shared.ts"), "utf8");
    expect(mergedContent).toContain("export const line1 = 100;");
    expect(mergedContent).toContain("export const line40 = 400;");

    // Now main edits line 1 too -> true conflict!
    fs.writeFileSync(
      path.join(repo, "shared.ts"),
      fs.readFileSync(path.join(repo, "shared.ts"), "utf8").replace("export const line1 = 1;", "export const line1 = 999;"),
    );
    execFileSync("git", ["add", "shared.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "main conflicts line 1"], { cwd: repo, stdio: "ignore" });

    const driftConflict = await inspectRsiSandboxDrift(repo, "REQ-001");
    expect(driftConflict?.driftStatus).toBe("true_conflict");
    expect(driftConflict?.conflictFiles).toEqual(["shared.ts"]);
    expect(driftConflict?.canAutoSync).toBe(false);
  });

  test("done stage clean sync stays done & allows applySandboxToMain, while reopen(preserveApproval) and sync-resolve keep approval intact", async () => {
    makeTempHub();
    const repo = makeMultiLineRepo("done-sync");
    await initProject(repo, { name: "DoneSyncTest", privacyMode: "local" });
    await createRequirement(repo, {
      goal: "Feature in leaf.ts",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design\nLeaf.", actor: "agent" });
    await approveDesign(repo, "REQ-001");
    const sb = await createOrReuseWorktree(repo, "REQ-001");

    fs.writeFileSync(path.join(sb.worktreePath, "leaf.ts"), "export const leaf = 42;\n");
    execFileSync("git", ["add", "leaf.ts"], { cwd: sb.worktreePath, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat: leaf=42"], { cwd: sb.worktreePath, stdio: "ignore" });
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const wtSnap = (await observeGitSnapshot(sb.worktreePath))!;
    await updateTasks(repo, "REQ-001", {
      tasks: [{ title: "done", status: "done" }],
      readyForAcceptance: true,
      currentCodeSnapshotHash: wtSnap.fingerprint,
    });
    await acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: wtSnap.fingerprint });

    // Advance main on an unrelated file while REQ-001 is already `done`
    fs.writeFileSync(path.join(repo, "unrelated.ts"), "export const u = 1;\n");
    execFileSync("git", ["add", "unrelated.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "main advances unrelated"], { cwd: repo, stdio: "ignore" });

    // Clean sync on `done` preserves stage === "done" and approval!
    const syncDone = await syncRsiSandboxBase(repo, "REQ-001", { fetchRemote: false });
    expect(syncDone.synced).toBe(true);
    expect(syncDone.detail.state.stage).toBe("done");
    expect(syncDone.detail.state.approval).not.toBeNull();
    expect(fs.readFileSync(path.join(sb.worktreePath, "unrelated.ts"), "utf8")).toBe("export const u = 1;\n");

    // `reopenRequirement(..., { preserveApproval: true })` goes to `implementing` & keeps approval
    const reopenedKeep = await reopenRequirement(repo, "REQ-001", {
      reason: "需要顺带调一下格式",
      preserveApproval: true,
    });
    expect(reopenedKeep.state.stage).toBe("implementing");
    expect(reopenedKeep.state.approval).not.toBeNull();

    // Re-verify and re-accept, then test conflict sync-resolve via prepareSandboxConflictResolution & awaiting_approval API
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const wtSnap2 = (await observeGitSnapshot(sb.worktreePath))!;
    await acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: wtSnap2.fingerprint });

    // Now test `done` -> `implementing` via prepareSandboxConflictResolution without touching lastFeedback
    const prep = await prepareSandboxConflictResolution(repo, "REQ-001");
    expect(prep.state.stage).toBe("implementing");
    expect(prep.state.approval).not.toBeNull();
    expect(prep.state.lastFeedback).toBeNull();

    // Re-verify, re-accept, and verify applySandboxToMain works after a clean done sync!
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const wtSnap3 = (await observeGitSnapshot(sb.worktreePath))!;
    await acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: wtSnap3.fingerprint });
    fs.writeFileSync(path.join(repo, "unrelated2.ts"), "export const u2 = 2;\n");
    execFileSync("git", ["add", "unrelated2.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "main advances unrelated2"], { cwd: repo, stdio: "ignore" });
    await syncRsiSandboxBase(repo, "REQ-001", { fetchRemote: false });

    const applied = await applySandboxToMain(repo, "REQ-001");
    expect(applied.appliedFiles).toContain("leaf.ts");
    expect(fs.readFileSync(path.join(repo, "leaf.ts"), "utf8")).toBe("export const leaf = 42;\n");
  });

  test("sync-resolve API unblocks awaiting_approval and done requirements without approval_required errors", async () => {
    makeTempHub();
    const repo = makeMultiLineRepo("sync-resolve-api");
    await initProject(repo, { name: "SyncResolveApi", privacyMode: "local" });
    await createRequirement(repo, {
      goal: "Edit shared.ts and test awaiting_approval sync-resolve",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design\nv2 ready.", actor: "agent" });
    // Leave REQ-001 in awaiting_approval (the exact REQ-009 trap!)
    const sb = await createOrReuseWorktree(repo, "REQ-001");
    fs.writeFileSync(path.join(sb.worktreePath, "leaf.ts"), "export const leaf = 9;\n");

    const dispatched: Array<{ action: string; prompt: string }> = [];
    const executor = new HubExecutor({
      initialHarnesses: [
        {
          id: "codex",
          label: "Codex",
          subscription: "Plus",
          installed: true,
          executable: "codex",
          models: [{ id: "gpt-6.2-sol", tier: "sota", source: "detected" }],
          defaultModel: "gpt-6.2-sol",
          detectedAt: Date.now(),
        },
      ],
      commandBuilder: (target, ctx) => {
        dispatched.push({ action: ctx.action, prompt: ctx.prompt });
        return { command: "bash", args: ["-c", "echo 'resolved'"], displayCommand: "mock-fix" };
      },
    });
    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, hubMode: false, executor });
    servers.push(server);

    const res = await fetch(`${server.url}/api/requirements/REQ-001/sync-resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approveFirst: true, useCli: true }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { detail: { state: { stage: string; approval: unknown; lastFeedback: string | null } } };
    expect(body.detail.state.stage).toBe("implementing");
    expect(body.detail.state.approval).not.toBeNull();
    expect(body.detail.state.lastFeedback).toBeNull();

    // Wait for mock run completion
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const runs = getRequirement(repo, "REQ-001").state.agentRuns ?? [];
      if (runs.length > 0 && runs[0]!.status !== "running") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(dispatched.length).toBe(1);
    expect(dispatched[0]!.action).toBe("fix");
    expect(dispatched[0]!.prompt).toContain("主干");
  });

  test("tracks origin/main even when main checkout is dirty and supports forceWithLease on diverged PR branch", async () => {
    makeTempHub();
    const { repo, bare } = makeBareRemoteRepo("origin-sync");
    await initProject(repo, { name: "OriginSyncTest", privacyMode: "local" });
    await updateProjectConfig(repo, { github: { repo: "owner/repo", defaultBaseBranch: "main" } });

    await createRequirement(repo, {
      goal: "Sync from origin/main and force-with-lease push",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design\nOrigin sync.", actor: "agent" });
    await approveDesign(repo, "REQ-001");
    const sb = await createOrReuseWorktree(repo, "REQ-001");

    // Commit feature in sandbox and push an old commit to remote branch
    fs.writeFileSync(path.join(sb.worktreePath, "leaf.ts"), "export const leaf = 11;\n");
    execFileSync("git", ["add", "leaf.ts"], { cwd: sb.worktreePath, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "old sandbox commit"], { cwd: sb.worktreePath, stdio: "ignore" });
    execFileSync("git", ["push", "-u", "origin", sb.branch], { cwd: sb.worktreePath, stdio: "ignore" });

    // Amend sandbox commit so remote branch is now diverged!
    fs.writeFileSync(path.join(sb.worktreePath, "leaf.ts"), "export const leaf = 12;\n");
    execFileSync("git", ["add", "leaf.ts"], { cwd: sb.worktreePath, stdio: "ignore" });
    execFileSync("git", ["commit", "--amend", "-m", "amended sandbox commit"], { cwd: sb.worktreePath, stdio: "ignore" });

    // Simulate another PR merged on origin/main from a second clone, while local main checkout is DIRTY!
    const clone2 = fs.mkdtempSync(path.join(os.tmpdir(), "wb-clone2-"));
    tempDirs.push(clone2);
    execFileSync("git", ["clone", bare, clone2], { stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Other"], { cwd: clone2, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "other@example.com"], { cwd: clone2, stdio: "ignore" });
    fs.writeFileSync(path.join(clone2, "remote_pr.ts"), "export const remotePr = true;\n");
    execFileSync("git", ["add", "remote_pr.ts"], { cwd: clone2, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "merged PR on remote"], { cwd: clone2, stdio: "ignore" });
    execFileSync("git", ["push", "origin", "main"], { cwd: clone2, stdio: "ignore" });

    // Make main checkout dirty so fast-forward of local main is impossible
    fs.writeFileSync(path.join(repo, "local_wip.txt"), "dirty main");

    // Fetch origin/main via syncRsiSandboxBase -> sandbox gets remote_pr.ts despite dirty main checkout!
    const synced = await syncRsiSandboxBase(repo, "REQ-001", { fetchRemote: true });
    expect(synced.synced).toBe(true);
    expect(fs.existsSync(path.join(sb.worktreePath, "remote_pr.ts"))).toBe(true);

    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });
    const wtSnap = (await observeGitSnapshot(sb.worktreePath))!;
    await acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: wtSnap.fingerprint });

    const mockGh: GitHubCommandDeps = {
      whichGh: () => "/usr/local/bin/gh",
      resolveDefaultBaseBranch: async () => "main",
      getRemoteUrl: async () => "https://github.com/owner/repo.git",
      runGh: async (_bin, args) => {
        const [group, sub] = args;
        if (group === "auth" && sub === "status") {
          return { code: 0, stdout: "github.com\n  ✓ Logged in", stderr: "" };
        }
        if (group === "repo" && sub === "view") {
          return { code: 0, stdout: JSON.stringify({ defaultBranchRef: { name: "main" } }), stderr: "" };
        }
        if (group === "pr" && sub === "list") return { code: 0, stdout: "[]", stderr: "" };
        if (group === "pr" && sub === "create") {
          return { code: 0, stdout: "https://github.com/owner/repo/pull/99\n", stderr: "" };
        }
        return { code: 0, stdout: "{}", stderr: "" };
      },
    };
    const preview = await getRequirementDeliveryPreview(repo, "REQ-001", mockGh);
    expect(preview.remoteBranchDiverged).toBe(true);

    // Without forceWithLease, push fails; WITH forceWithLease, push & PR creation succeed!
    const delivered = await deliverRequirement(
      repo,
      "REQ-001",
      { files: [], commitMessage: "feat: amended + synced", createPr: true, forceWithLease: true },
      mockGh,
    );
    expect(delivered.pr?.number).toBe(99);
  });

  test("sibling conflict radar, merge order recommendation, stacked worktree, and cascade sync", async () => {
    makeTempHub();
    const repo = makeMultiLineRepo("orchestration");
    await initProject(repo, { name: "OrchestrationTest", privacyMode: "local" });

    // Create 3 parallel requirements with sandboxes
    for (const [id, title] of [
      ["REQ-001", "Sibling A touches line 1"],
      ["REQ-002", "Sibling B also touches line 1"],
      ["REQ-003", "Clean leaf feature"],
    ] as const) {
      await createRequirement(repo, {
        goal: title,
        title,
        criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
      });
      await propose(repo, id, { designMarkdown: `# ${title}`, actor: "agent" });
      await approveDesign(repo, id);
    }

    const sb1 = await createOrReuseWorktree(repo, "REQ-001", { branchPrefix: "feat" });
    const sb2 = await createOrReuseWorktree(repo, "REQ-002", { branchPrefix: "feat" });
    const sb3 = await createOrReuseWorktree(repo, "REQ-003", { branchPrefix: "feat" });

    // REQ-001 & REQ-002 both edit line 1 of shared.ts -> sibling conflict!
    fs.writeFileSync(
      path.join(sb1.worktreePath, "shared.ts"),
      fs.readFileSync(path.join(sb1.worktreePath, "shared.ts"), "utf8").replace("export const line1 = 1;", "export const line1 = 111;"),
    );
    execFileSync("git", ["add", "shared.ts"], { cwd: sb1.worktreePath, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "req1 line1"], { cwd: sb1.worktreePath, stdio: "ignore" });

    fs.writeFileSync(
      path.join(sb2.worktreePath, "shared.ts"),
      fs.readFileSync(path.join(sb2.worktreePath, "shared.ts"), "utf8").replace("export const line1 = 1;", "export const line1 = 222;"),
    );
    execFileSync("git", ["add", "shared.ts"], { cwd: sb2.worktreePath, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "req2 line1"], { cwd: sb2.worktreePath, stdio: "ignore" });

    // REQ-003 edits leaf.ts cleanly and finishes acceptance (`done`)
    fs.writeFileSync(path.join(sb3.worktreePath, "leaf.ts"), "export const leaf = 333;\n");
    execFileSync("git", ["add", "leaf.ts"], { cwd: sb3.worktreePath, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "req3 leaf"], { cwd: sb3.worktreePath, stdio: "ignore" });
    await runVerification(repo, "REQ-003", { command: "echo ok", criterionIds: ["AC-1"] });
    const snap3 = (await observeGitSnapshot(sb3.worktreePath))!;
    await acceptRequirement(repo, "REQ-003", { currentCodeSnapshotHash: snap3.fingerprint });

    // Sibling radar on REQ-001 detects true conflict with REQ-002
    const drift1 = await inspectRsiSandboxDrift(repo, "REQ-001");
    expect(drift1?.siblingConflicts?.some((s) => s.requirementId === "REQ-002" && s.conflictFiles.includes("shared.ts"))).toBe(true);

    // Merge order recommends REQ-003 first (`clean_leaf`), ahead of conflicting siblings!
    const order = await recommendSandboxMergeOrder(repo);
    expect(order.ordered.map((e) => e.requirementId)).toEqual(["REQ-003", "REQ-001", "REQ-002"]);
    expect(order.ordered[0]!.reason).toBe("clean_leaf");
    expect(order.ordered[1]!.conflictsWithSiblings).toEqual(["REQ-002"]);

    // Stacked worktree REQ-004 forked from REQ-001 inherits REQ-001's commit!
    await createRequirement(repo, {
      goal: "Stacked on REQ-001",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    const sb4 = await createOrReuseWorktree(repo, "REQ-004", { branchPrefix: "feat", stackedOnReqId: "REQ-001" });
    expect(fs.readFileSync(path.join(sb4.worktreePath, "shared.ts"), "utf8")).toContain("export const line1 = 111;");

    // Apply REQ-003 to main and commit, then cascadeSyncProjectSandboxes advances REQ-001 & REQ-002 automatically!
    await applySandboxToMain(repo, "REQ-003");
    execFileSync("git", ["add", "leaf.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "merge REQ-003 leaf"], { cwd: repo, stdio: "ignore" });

    const cascade = await cascadeSyncProjectSandboxes(repo, "REQ-003");
    expect(cascade.find((c) => c.requirementId === "REQ-001")?.status).toBe("synced");
    expect(cascade.find((c) => c.requirementId === "REQ-002")?.status).toBe("synced");
    expect(fs.readFileSync(path.join(sb1.worktreePath, "leaf.ts"), "utf8")).toBe("export const leaf = 333;\n");
    expect(fs.readFileSync(path.join(sb2.worktreePath, "leaf.ts"), "utf8")).toBe("export const leaf = 333;\n");
  });
});
