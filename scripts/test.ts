import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const TESTS_DIR = path.join(ROOT, "tests");

function collectTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTestFiles(full));
    } else if (/\.test\.(?:ts|tsx|js|jsx|mts|cts)$/.test(entry.name)) {
      out.push(path.relative(ROOT, full));
    }
  }
  return out;
}

function estimateWeight(relPath: string): number {
  if (
    relPath.endsWith("e2e_browser.test.ts") ||
    relPath.endsWith("e2e_i18n_layout_browser.test.ts") ||
    relPath.endsWith("e2e_run_lock_browser.test.ts")
  ) {
    return 600;
  }
  if (relPath.endsWith("_browser.test.ts")) return 300;
  if (relPath.includes("delivery.test.ts") || relPath.includes("hub.test.ts")) return 150;
  try {
    return Math.min(120, Math.ceil(fs.statSync(path.join(ROOT, relPath)).size / 512));
  } catch {
    return 10;
  }
}

function runPassthrough(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["test", ...args], {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
    });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

interface FileRunResult {
  file: string;
  code: number;
  durationMs: number;
  output: string;
  passCount: number;
  failCount: number;
}

function parseCounts(output: string): { passCount: number; failCount: number } {
  const passMatch = output.match(/^\s*(\d+)\s+pass$/m);
  const failMatch = output.match(/^\s*(\d+)\s+fail$/m);
  return {
    passCount: passMatch ? Number(passMatch[1]) : 0,
    failCount: failMatch ? Number(failMatch[1]) : 0,
  };
}

function runTestFile(file: string, workerTmpDir: string): Promise<FileRunResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const workerHubDir = path.join(workerTmpDir, "hub");
    fs.mkdirSync(workerHubDir, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TMPDIR: workerTmpDir,
      TEMP: workerTmpDir,
      TMP: workerTmpDir,
      WORKBENCH_HUB_DIR: workerHubDir,
      WORKBENCH_DISABLE_VERIFY_LOCK: "1",
    };
    delete env.WORKBENCH_RSI_DEPTH;
    const child = spawn(process.execPath, ["test", file], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (buf: Buffer) => chunks.push(buf));
    child.stderr?.on("data", (buf: Buffer) => chunks.push(buf));
    child.on("close", (code) => {
      const output = Buffer.concat(chunks).toString("utf8");
      const { passCount, failCount } = parseCounts(output);
      resolve({
        file,
        code: code ?? 1,
        durationMs: Date.now() - startedAt,
        output,
        passCount,
        failCount,
      });
    });
    child.on("error", (err) => {
      resolve({
        file,
        code: 1,
        durationMs: Date.now() - startedAt,
        output: `Failed to spawn bun test for ${file}: ${err.message}\n`,
        passCount: 0,
        failCount: 1,
      });
    });
  });
}

function isHeavyBrowserTest(relPath: string): boolean {
  return relPath.endsWith("_browser.test.ts") || relPath.endsWith("web/acceptance_history.test.ts");
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    return runPassthrough(args);
  }

  // Schedule heaviest files (including browser suites) first so isolated workers stay balanced instead of idling on a serial tail.
  const files = collectTestFiles(TESTS_DIR).sort(
    (a, b) => estimateWeight(b) - estimateWeight(a) || a.localeCompare(b),
  );
  const rawWorkers = Number(process.env.WORKBENCH_TEST_WORKERS ?? "");
  const defaultWorkers = Math.min(3, Math.max(2, Math.floor(os.cpus().length / 2)));
  const concurrency = Math.max(1, Math.min(files.length, Number.isFinite(rawWorkers) && rawWorkers > 0 ? Math.floor(rawWorkers) : defaultWorkers));
  const rawBrowserWorkers = Number(process.env.WORKBENCH_BROWSER_WORKERS ?? "");
  const maxBrowserWorkers = Math.max(
    1,
    Math.min(concurrency, Number.isFinite(rawBrowserWorkers) && rawBrowserWorkers > 0 ? Math.floor(rawBrowserWorkers) : 1),
  );

  const suiteStart = Date.now();
  const queue = [...files];
  const results: FileRunResult[] = [];
  let completed = 0;
  let activeBrowserWorkers = 0;
  const browserWaiters: Array<() => void> = [];

  const acquireNextFile = async (): Promise<{ file: string; isBrowser: boolean } | null> => {
    while (queue.length > 0) {
      if (activeBrowserWorkers < maxBrowserWorkers) {
        const next = queue.shift()!;
        const isBrowser = isHeavyBrowserTest(next);
        if (isBrowser) activeBrowserWorkers += 1;
        return { file: next, isBrowser };
      }
      const nonBrowserIdx = queue.findIndex((f) => !isHeavyBrowserTest(f));
      if (nonBrowserIdx !== -1) {
        const [nonBrowser] = queue.splice(nonBrowserIdx, 1);
        return { file: nonBrowser!, isBrowser: false };
      }
      // Only browser tests remain while browser slots are full.
      await new Promise<void>((resolve) => {
        browserWaiters.push(resolve);
      });
    }
    return null;
  };

  const releaseBrowserSlot = () => {
    activeBrowserWorkers = Math.max(0, activeBrowserWorkers - 1);
    while (browserWaiters.length > 0) {
      browserWaiters.shift()!();
    }
  };

  process.stdout.write(`Running ${files.length} test files across ${concurrency} isolated workers...\n`);

  const workers = Array.from({ length: concurrency }, async () => {
    const workerTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-test-worker-"));
    try {
      for (;;) {
        const next = await acquireNextFile();
        if (!next) break;
        let res: FileRunResult;
        try {
          res = await runTestFile(next.file, workerTmpDir);
        } finally {
          if (next.isBrowser) releaseBrowserSlot();
        }
        results.push(res);
        completed += 1;
        const status = res.code === 0 ? "PASS" : "FAIL";
        const sec = (res.durationMs / 1000).toFixed(1);
        process.stdout.write(
          `[${completed}/${files.length}] ${status} ${next.file} (${sec}s, ${res.passCount} pass, ${res.failCount} fail)\n`,
        );
      }
    } finally {
      fs.rmSync(workerTmpDir, { recursive: true, force: true });
    }
  });

  await Promise.all(workers);

  const failed = results.filter((r) => r.code !== 0);
  if (failed.length > 0) {
    process.stderr.write("\n=== Failed Test File Outputs ===\n");
    for (const item of failed) {
      process.stderr.write(`\n--- ${item.file} (exit ${item.code}) ---\n${item.output}\n`);
    }
  }

  const totalPass = results.reduce((sum, r) => sum + r.passCount, 0);
  const totalFail = results.reduce((sum, r) => sum + r.failCount, 0);
  const wallSec = ((Date.now() - suiteStart) / 1000).toFixed(2);
  process.stdout.write(`\n ${totalPass} pass\n ${totalFail} fail\nRan ${files.length} files across ${concurrency} workers. [${wallSec}s]\n`);

  return failed.length > 0 ? 1 : 0;
}

const code = await main();
process.exit(code);
