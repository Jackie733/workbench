import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  acceptRequirement,
  authorizeFastTrack,
  createRequirement,
  getRequirement,
  getVerificationEvidence,
  initProject,
} from "../../src/core/engine.ts";
import { commitFilesInGit, observeGitChanges, observeGitSnapshot } from "../../src/core/git.ts";
import { isHeavyVerificationCommand, runAllVerifications, runVerification } from "../../src/core/runner.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix = "wb-git-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initGitRepo(withCommit = true): string {
  const dir = makeTempDir();
  git(dir, "init");
  git(dir, "config", "user.name", "Workbench Test");
  git(dir, "config", "user.email", "test@example.com");
  fs.writeFileSync(path.join(dir, "app.ts"), "export const sum = (a: number, b: number) => a + b;\n");
  if (withCommit) {
    git(dir, "add", "app.ts");
    git(dir, "commit", "-m", "initial commit");
  }
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("WB-02 git observer and verification runner", () => {
  test("returns non-git gracefully when directory is not a git repo", async () => {
    const dir = makeTempDir("wb-nongit-");
    await initProject(dir);
    await createRequirement(dir, {
      goal: "测试非 Git 目录",
      criteria: [{ id: "AC-1", description: "运行命令", required: true }],
    });

    const snap = await observeGitSnapshot(dir);
    expect(snap).toBeNull();
    const obs = await observeGitChanges(dir);
    expect(obs.isGitRepo).toBe(false);
    expect(obs.fingerprint).toBeNull();

    await expect(
      runVerification(dir, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] }),
    ).rejects.toMatchObject({ code: "execution_failed" });
  });

  test("excludes .workbench metadata from snapshots and detects tracked/untracked edits and commits", async () => {
    const repo = initGitRepo(true);
    await initProject(repo, { privacyMode: "tracked" });
    const baseSnap = (await observeGitSnapshot(repo))!;
    expect(baseSnap.dirty).toBe(false);
    expect(baseSnap.head).toMatch(/^[a-f0-9]{40}$/);

    // Creating workbench items does NOT change workspace codeSnapshotHash or diff
    await createRequirement(repo, { goal: "测试排除工作台元数据" });
    const afterMetaSnap = (await observeGitSnapshot(repo))!;
    expect(afterMetaSnap.fingerprint).toBe(baseSnap.fingerprint);
    expect(afterMetaSnap.dirty).toBe(false);

    // Modifying a tracked file changes fingerprint deterministically
    fs.writeFileSync(path.join(repo, "app.ts"), "export const sum = (a: number, b: number) => a + b + 1;\n");
    const dirtySnap1 = (await observeGitSnapshot(repo))!;
    expect(dirtySnap1.dirty).toBe(true);
    expect(dirtySnap1.fingerprint).not.toBe(baseSnap.fingerprint);

    // Adding an untracked file changes fingerprint again and appears in unified diff
    fs.writeFileSync(path.join(repo, "helper.ts"), "export const ok = true;\n");
    const dirtySnap2 = (await observeGitSnapshot(repo))!;
    expect(dirtySnap2.fingerprint).not.toBe(dirtySnap1.fingerprint);

    const changes = await observeGitChanges(repo);
    expect(changes.files.map((f) => f.path)).toEqual(["app.ts", "helper.ts"]);
    expect(changes.diff).toContain("a + b + 1");
    expect(changes.diff).toContain("export const ok = true;");
    expect(changes.diff).not.toContain(".workbench");

    // Committing and comparing against baseSnap.head includes commit log & diff since baseline
    git(repo, "add", "app.ts", "helper.ts");
    git(repo, "commit", "-m", "feat: add helper");
    const sinceBase = await observeGitChanges(repo, { sinceHead: baseSnap.head });
    expect(sinceBase.commits).toHaveLength(1);
    expect(sinceBase.commits[0]?.subject).toBe("feat: add helper");
    expect(sinceBase.diff).toContain("export const ok = true;");
  });

  test("handles unborn git repo without commits", async () => {
    const repo = initGitRepo(false);
    await initProject(repo);
    const snap = await observeGitSnapshot(repo);
    expect(snap).not.toBeNull();
    expect(snap!.head).toBe("");
    expect(snap!.dirty).toBe(true);
    const obs = await observeGitChanges(repo);
    expect(obs.diff).toContain("export const sum");
  });

  test("executes real verification commands, records redacted evidence, handles timeouts, and marks stale after code edits", async () => {
    const repo = initGitRepo(true);
    await initProject(repo);
    await createRequirement(repo, {
      goal: "验证真实执行器闭环",
      criteria: [
        { id: "AC-1", description: "功能断言通过", required: true, command: "bun -e 'console.log(\"Bearer secret-abc\")'" },
        { id: "AC-2", description: "辅助检查通过", required: true, command: "bun -e 'console.log(\"Bearer secret-abc\")'" },
      ],
    });
    await authorizeFastTrack(repo, "REQ-001");

    // 1. Failing command
    const failRun = await runVerification(repo, "REQ-001", {
      command: "echo fail-out >&2; exit 2",
      criterionIds: ["AC-1"],
    });
    expect(failRun.record.passed).toBe(false);
    expect(failRun.record.exitCode).toBe(2);
    expect(failRun.detail.validity.coverage.requiredPassed).toBe(0);

    // 2. Timeout command
    const timeoutRun = await runVerification(repo, "REQ-001", {
      command: "sleep 5",
      criterionIds: ["AC-1"],
      timeoutMs: 500,
    });
    expect(timeoutRun.record.timedOut).toBe(true);
    expect(timeoutRun.record.passed).toBe(false);
    expect(timeoutRun.record.exitCode).toBeNull();

    // 3. runAllVerifications groups shared command once and redacts Bearer token
    const allRes = await runAllVerifications(repo, "REQ-001");
    expect(allRes.runs).toHaveLength(1);
    expect(allRes.runs[0]!.record.criterionIds).toEqual(["AC-1", "AC-2"]);
    expect(allRes.runs[0]!.record.passed).toBe(true);
    expect(allRes.runs[0]!.log).not.toContain("secret-abc");
    expect(allRes.runs[0]!.log).toContain("Bearer [REDACTED]");
    expect(allRes.detail.validity.acceptanceGate.ok).toBe(true);

    const stored = getVerificationEvidence(repo, "REQ-001", allRes.runs[0]!.record.id);
    expect(stored.log).toContain("Bearer [REDACTED]");

    // 4. Editing code after passing immediately makes evidence stale and blocks acceptance
    fs.writeFileSync(path.join(repo, "app.ts"), "export const sum = (a: number, b: number) => a - b;\n");
    const postEditSnap = (await observeGitSnapshot(repo))!;
    const staleDetail = getRequirement(repo, "REQ-001", { currentCodeSnapshotHash: postEditSnap.fingerprint });
    expect(staleDetail.validity.coverage.requiredPassed).toBe(0);
    expect(staleDetail.validity.coverage.items.every((i) => i.state === "stale")).toBe(true);
    expect(staleDetail.validity.acceptanceGate.ok).toBe(false);
    await expect(
      acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: postEditSnap.fingerprint }),
    ).rejects.toMatchObject({ code: "acceptance_gate_failed" });

    // 5. Re-running on new code snapshot enables acceptance
    await runAllVerifications(repo, "REQ-001");
    const done = await acceptRequirement(repo, "REQ-001", { currentCodeSnapshotHash: postEditSnap.fingerprint });
    expect(done.state.stage).toBe("done");
  });

  test("strips inherited WORKBENCH_ROOT and WORKBENCH_REQ_ID from verification command env", async () => {
    const repo = initGitRepo(true);
    await initProject(repo);
    await createRequirement(repo, {
      goal: "验证子进程环境变量隔离",
      criteria: [
        {
          id: "AC-1",
          description: "子进程不继承 WORKBENCH_ROOT/WORKBENCH_REQ_ID",
          required: true,
          command: "bun -e 'console.log(JSON.stringify({root: process.env.WORKBENCH_ROOT ?? null, req: process.env.WORKBENCH_REQ_ID ?? null}))'",
        },
      ],
    });
    await authorizeFastTrack(repo, "REQ-001");

    const prevRoot = process.env.WORKBENCH_ROOT;
    const prevReq = process.env.WORKBENCH_REQ_ID;
    process.env.WORKBENCH_ROOT = "/tmp/leaked-host-root";
    process.env.WORKBENCH_REQ_ID = "REQ-999";
    try {
      const res = await runAllVerifications(repo, "REQ-001");
      expect(res.runs[0]!.record.passed).toBe(true);
      expect(res.runs[0]!.log).toContain('"root":null,"req":null');
    } finally {
      if (prevRoot === undefined) delete process.env.WORKBENCH_ROOT;
      else process.env.WORKBENCH_ROOT = prevRoot;
      if (prevReq === undefined) delete process.env.WORKBENCH_REQ_ID;
      else process.env.WORKBENCH_REQ_ID = prevReq;
    }
  });

  test("subsumes file-only bun test subsets into exact bun test while keeping filtered runs separate", async () => {
    const repo = initGitRepo(true);
    await initProject(repo);
    fs.mkdirSync(path.join(repo, "tests"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "tests/sample.test.ts"),
      `import { expect, test } from "bun:test";\ntest("ok", () => { expect(1).toBe(1); });\n`,
    );
    git(repo, "add", "tests/sample.test.ts");
    git(repo, "commit", "-m", "add sample test");

    await createRequirement(repo, {
      goal: "验证 bun test 子集自动去重归并",
      criteria: [
        { id: "AC-1", description: "全量测试", required: true, command: "bun test" },
        { id: "AC-2", description: "子集文件测试", required: true, command: "bun test tests/sample.test.ts" },
        { id: "AC-3", description: "带过滤参数保持独立", required: true, command: "bun test tests/sample.test.ts -t ok" },
      ],
    });
    await authorizeFastTrack(repo, "REQ-001");

    const res = await runAllVerifications(repo, "REQ-001");
    expect(res.runs).toHaveLength(2);
    expect(res.runs[0]!.record.command).toBe("bun test tests/sample.test.ts -t ok");
    expect(res.runs[0]!.record.criterionIds).toEqual(["AC-3"]);
    expect(res.runs[1]!.record.command).toBe("bun test");
    expect(res.runs[1]!.record.criterionIds).toEqual(["AC-1", "AC-2"]);
    expect(res.detail.validity.acceptanceGate.ok).toBe(true);
  });

  test("reuses matching passed verification on unchanged snapshot unless force is true, and classifies heavy commands", async () => {
    expect(isHeavyVerificationCommand("bun test")).toBe(true);
    expect(isHeavyVerificationCommand("bun run typecheck && bun test")).toBe(true);
    expect(isHeavyVerificationCommand("bun test tests/core/git_runner.test.ts")).toBe(false);
    expect(isHeavyVerificationCommand("bun run typecheck")).toBe(false);

    const repo = initGitRepo(true);
    await initProject(repo);
    const stampFile = path.join(repo, ".run-count");
    await createRequirement(repo, {
      goal: "验证同快照幂等复用与 force 重跑",
      criteria: [
        {
          id: "AC-1",
          description: "计数验证",
          required: true,
          command: `bun -e 'const fs=require("fs");const f=${JSON.stringify(stampFile)};const n=(fs.existsSync(f)?Number(fs.readFileSync(f,"utf8")):0)+1;fs.writeFileSync(f,String(n));'`,
        },
      ],
    });
    await authorizeFastTrack(repo, "REQ-001");

    const first = await runAllVerifications(repo, "REQ-001");
    expect(first.runs).toHaveLength(1);
    expect(first.runs[0]!.reused).toBeUndefined();
    expect(fs.readFileSync(stampFile, "utf8")).toBe("1");

    // Re-running without force reuses existing passing verification for unchanged spec & code snapshot.
    const second = await runAllVerifications(repo, "REQ-001");
    expect(second.runs).toHaveLength(1);
    expect(second.runs[0]!.reused).toBe(true);
    expect(second.runs[0]!.record.id).toBe(first.runs[0]!.record.id);
    expect(fs.readFileSync(stampFile, "utf8")).toBe("1");

    // Explicit force=true executes the command again.
    const forced = await runAllVerifications(repo, "REQ-001", { force: true });
    expect(forced.runs).toHaveLength(1);
    expect(forced.runs[0]!.reused).toBeUndefined();
    expect(fs.readFileSync(stampFile, "utf8")).toBe("2");
  });

  test("shares verify cache across requirements on identical git snapshot and subsumes bun test files under bun run test", async () => {
    const repo = initGitRepo(true);
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-runner-cache-hub-"));
    tempDirs.push(hubDir);
    const prevHub = process.env.WORKBENCH_HUB_DIR;
    process.env.WORKBENCH_HUB_DIR = hubDir;
    try {
      await initProject(repo);
      const stampFile = path.join(repo, ".cache-count");
      const cmd = `bun -e 'const fs=require("fs");const f=${JSON.stringify(stampFile)};const n=(fs.existsSync(f)?Number(fs.readFileSync(f,"utf8")):0)+1;fs.writeFileSync(f,String(n));'`;
      await createRequirement(repo, {
        goal: "第一个需求生成验证缓存",
        criteria: [{ id: "AC-1", description: "计数验证", required: true, command: cmd }],
      });
      await authorizeFastTrack(repo, "REQ-001");
      const first = await runAllVerifications(repo, "REQ-001");
      expect(first.runs[0]!.reused).toBeUndefined();
      expect(fs.readFileSync(stampFile, "utf8")).toBe("1");

      // Second requirement on the exact same git snapshot hits the cross-requirement verify cache.
      await createRequirement(repo, {
        goal: "第二个需求命中同快照验证缓存",
        criteria: [{ id: "AC-1", description: "计数验证", required: true, command: cmd }],
      });
      await authorizeFastTrack(repo, "REQ-002");
      const second = await runAllVerifications(repo, "REQ-002");
      expect(second.runs).toHaveLength(1);
      expect(second.runs[0]!.reused).toBe(true);
      expect(second.runs[0]!.log).toContain("跨需求验证缓存");
      expect(second.detail.validity.acceptanceGate.ok).toBe(true);
      expect(fs.readFileSync(stampFile, "utf8")).toBe("1");
    } finally {
      if (prevHub === undefined) delete process.env.WORKBENCH_HUB_DIR;
      else process.env.WORKBENCH_HUB_DIR = prevHub;
    }
  });

  test("strips inherited WORKBENCH_RSI_DEPTH, WORKBENCH_HUB_PID, and WORKBENCH_OUTPUT_LANGUAGE from verification env", async () => {
    const repo = initGitRepo(true);
    await initProject(repo);
    await createRequirement(repo, {
      goal: "验证验证命令清理 RSI 与宿主环境标记",
      criteria: [
        {
          id: "AC-1",
          description: "验证命令中不存在 WORKBENCH_RSI_DEPTH",
          required: true,
          command:
            "bun -e 'if (process.env.WORKBENCH_RSI_DEPTH || process.env.WORKBENCH_HUB_PID || process.env.WORKBENCH_OUTPUT_LANGUAGE) process.exit(1);'",
        },
      ],
    });
    await authorizeFastTrack(repo, "REQ-001");

    const prevDepth = process.env.WORKBENCH_RSI_DEPTH;
    const prevPid = process.env.WORKBENCH_HUB_PID;
    const prevLang = process.env.WORKBENCH_OUTPUT_LANGUAGE;
    process.env.WORKBENCH_RSI_DEPTH = "1";
    process.env.WORKBENCH_HUB_PID = "99999";
    process.env.WORKBENCH_OUTPUT_LANGUAGE = "zh-CN";
    try {
      const res = await runAllVerifications(repo, "REQ-001");
      expect(res.runs[0]!.record.passed).toBe(true);
    } finally {
      if (prevDepth === undefined) delete process.env.WORKBENCH_RSI_DEPTH;
      else process.env.WORKBENCH_RSI_DEPTH = prevDepth;
      if (prevPid === undefined) delete process.env.WORKBENCH_HUB_PID;
      else process.env.WORKBENCH_HUB_PID = prevPid;
      if (prevLang === undefined) delete process.env.WORKBENCH_OUTPUT_LANGUAGE;
      else process.env.WORKBENCH_OUTPUT_LANGUAGE = prevLang;
    }
  });

  test("handles monorepo subdirectory git paths for snapshot, untracked diff, and commitFilesInGit, and skips optional criteria in runAllVerifications", async () => {
    const monorepo = initGitRepo(true);
    const subDir = path.join(monorepo, "api-proxy");
    fs.mkdirSync(path.join(subDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(subDir, "src", "index.js"), "exports.ok = 1;\n");
    execFileSync("git", ["add", "api-proxy/src/index.js"], { cwd: monorepo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "add api-proxy"], { cwd: monorepo, stdio: "ignore" });

    await initProject(subDir);
    await createRequirement(subDir, {
      goal: "Monorepo 子目录改动快照与提交测试",
      criteria: [
        { id: "AC-1", description: "必需只读校验", required: true, command: "echo required-ok" },
        { id: "AC-2", description: "可选副作用脚本不应执行", required: false, command: "echo optional-mutating > optional-marker.txt" },
      ],
    });
    await authorizeFastTrack(subDir, "REQ-001");

    // 1. runAllVerifications runs only required criteria when present; includeOptional runs both
    const reqOnly = await runAllVerifications(subDir, "REQ-001");
    expect(reqOnly.runs).toHaveLength(1);
    expect(reqOnly.runs[0]!.record.criterionIds).toEqual(["AC-1"]);
    expect(fs.existsSync(path.join(subDir, "optional-marker.txt"))).toBe(false);

    // 2. Modified and untracked files under monorepo subdir produce distinct snapshots, captured diff, and clean commit
    const beforeSnap = await observeGitSnapshot(subDir);
    fs.writeFileSync(path.join(subDir, "src", "index.js"), "exports.ok = 2;\n");
    const modSnap = await observeGitSnapshot(subDir);
    expect(modSnap?.fingerprint).not.toBe(beforeSnap?.fingerprint);

    fs.writeFileSync(path.join(subDir, "src", "extra.js"), "exports.extra = true;\n");
    const obs = await observeGitChanges(subDir);
    expect(obs.diff).toContain("api-proxy/src/extra.js");

    const committed = await commitFilesInGit(subDir, ["api-proxy/src/index.js"], "fix(api-proxy): update index");
    expect(committed.commitHash).toMatch(/^[0-9a-f]{40}$/);
    const committedFiles = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], {
      cwd: monorepo,
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    expect(committedFiles).toEqual(["api-proxy/src/index.js"]);
  });
});
