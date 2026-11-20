import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { NodeServiceInstallation } from "../../src/cli/node_service.ts";
import { applyNodeUpdate, nodeUpdateBlocksWork, readNodeUpdate } from "../../src/cli/node_update.ts";

const temp: string[] = [];
afterEach(() => { for (const dir of temp.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wb-node-update-")));
  temp.push(dir);
  const origin = path.join(dir, "source origin");
  const root = path.join(dir, "node checkout");
  const hubDir = path.join(dir, "node namespace");
  const log = path.join(dir, "operations");
  const fail = path.join(dir, "fail dependencies");
  fs.mkdirSync(path.join(origin, "src/cli"), { recursive: true });
  fs.mkdirSync(hubDir);
  fs.writeFileSync(path.join(hubDir, "node-update.json"), '{"branch":"main"}');
  fs.writeFileSync(path.join(origin, "src/cli/index.ts"), "// installed CLI\n");
  fs.writeFileSync(path.join(origin, ".gitignore"), "local-cache\n");
  git(origin, "init", "-q", "-b", "main");
  git(origin, "add", ".");
  git(origin, "commit", "-qm", "initial");
  const previous = git(origin, "rev-parse", "HEAD");
  git(dir, "clone", "-q", origin, root);
  fs.writeFileSync(path.join(origin, "release.txt"), "new code\n");
  git(origin, "add", ".");
  git(origin, "commit", "-qm", "release");
  const revision = git(origin, "rev-parse", "HEAD");
  const bun = path.join(dir, "installed Bun");
  fs.writeFileSync(bun, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ntest ! -f '${fail}'\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, "systemctl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`, { mode: 0o700 });
  const installation: NodeServiceInstallation = { schemaVersion: 1, manager: "systemd", id: "workbench-node-test.service",
    definitionPath: path.join(dir, "unused"), bunPath: bun, cliPath: path.join(root, "src/cli/index.ts"),
    workingDirectory: dir, hubDir, path: `${dir}:${process.env.PATH}` };
  return { dir, origin, root, hubDir, log, fail, previous, revision, installation };
}

test("fast-forwards to a published revision, installs before restarting, and allows work on the new process", async () => {
  const f = fixture();
  const id = crypto.randomUUID();
  await applyNodeUpdate(f.installation, id, f.revision, f.previous);
  expect(git(f.root, "rev-parse", "HEAD")).toBe(f.revision);
  expect(fs.readFileSync(f.log, "utf8")).toBe("install --production --frozen-lockfile\n--user restart workbench-node-test.service\n");
  const report = readNodeUpdate(f.hubDir);
  expect(report).toMatchObject({ id, revision: f.revision, phase: "restarting", root: f.root });
  expect(nodeUpdateBlocksWork(report, f.previous)).toBe(true);
  expect(nodeUpdateBlocksWork(report, f.revision)).toBe(false);
});

test("rejects a locally available commit not on the trusted branch and preserves a dirty checkout", async () => {
  const f = fixture();
  git(f.origin, "switch", "-qc", "unpublished", f.previous);
  fs.writeFileSync(path.join(f.origin, "side.txt"), "side branch\n");
  git(f.origin, "add", ".");
  git(f.origin, "commit", "-qm", "unpublished");
  git(f.root, "fetch", "origin", "unpublished");
  const side = git(f.root, "rev-parse", "FETCH_HEAD");
  await expect(applyNodeUpdate(f.installation, crypto.randomUUID(), side, f.previous)).rejects.toThrow();
  expect(readNodeUpdate(f.hubDir)?.message).toContain("published fast-forward");
  const edits = path.join(f.root, "untracked.txt");
  fs.writeFileSync(edits, "keep me");
  await expect(applyNodeUpdate(f.installation, crypto.randomUUID(), f.revision, f.previous)).rejects.toThrow("dirty");
  expect(fs.readFileSync(edits, "utf8")).toBe("keep me");
  expect(git(f.root, "rev-parse", "HEAD")).toBe(f.previous);
  expect(fs.existsSync(f.log)).toBe(false);
  expect(nodeUpdateBlocksWork(readNodeUpdate(f.hubDir), f.previous)).toBe(false);
});

test("dependency failure keeps new work paused and a retry reinstalls before restarting", async () => {
  const f = fixture();
  fs.writeFileSync(f.fail, "");
  await expect(applyNodeUpdate(f.installation, crypto.randomUUID(), f.revision, f.previous)).rejects.toThrow();
  expect(fs.readFileSync(f.log, "utf8")).not.toContain("restart");
  expect(git(f.root, "rev-parse", "HEAD")).toBe(f.revision);
  expect(nodeUpdateBlocksWork(readNodeUpdate(f.hubDir), f.previous)).toBe(true);
  fs.unlinkSync(f.fail);
  await applyNodeUpdate(f.installation, crypto.randomUUID(), f.revision, f.previous);
  expect(fs.readFileSync(f.log, "utf8")).toBe("install --production --frozen-lockfile\ninstall --production --frozen-lockfile\n--user restart workbench-node-test.service\n");
});
