import { execFileSync } from "node:child_process";
import * as path from "node:path";

export function isGitRevision(value: unknown): value is string {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
}

export function readSourceRevision(): string | undefined {
  const sourceRoot = path.resolve(import.meta.dir, "../..");
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  try {
    // Do not attribute a source snapshot nested in an unrelated checkout to that checkout.
    const output = execFileSync("git", ["rev-parse", "--show-prefix", "--verify", "HEAD"], {
      cwd: sourceRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000,
    });
    const [prefix, revision] = output.trimEnd().split("\n");
    if (prefix === "" && isGitRevision(revision)) return revision.toLowerCase();
  } catch {
    // Git and repository metadata are optional for runtime installations.
  }
}

export function isSourceRevisionPublished(
  revision: string,
  sourceRoot: string = path.resolve(import.meta.dir, "../.."),
): boolean | undefined {
  if (!isGitRevision(revision)) return undefined;
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  try {
    const hasOrigin = execFileSync("git", ["for-each-ref", "--count=1", "refs/remotes/origin/"], {
      cwd: sourceRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000,
    }).trim();
    if (!hasOrigin) return undefined;
    const matched = execFileSync("git", ["for-each-ref", "--count=1", "--contains", revision, "refs/remotes/origin/"], {
      cwd: sourceRoot, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000,
    }).trim();
    return matched.length > 0;
  } catch {
    return undefined;
  }
}
