import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Resolves a real Chromium + puppeteer-core pair for browser tests.
 * Precedence: explicit WORKBENCH_* env vars, the legacy developer absolute paths,
 * then locally installed Playwright/Chromium caches. Returning the legacy path when
 * nothing matches keeps the diagnostic message stable while HAS_BROWSER stays false.
 */
const LEGACY_CHROME_PATH = "/home/jackie/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome";
const LEGACY_PUPPETEER_PATH = "/home/jackie/.bun/install/global/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js";

function firstExisting(candidates: Array<string | undefined>): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore inaccessible candidates
    }
  }
  return null;
}

function playwrightChromeCandidates(): string[] {
  const cacheRoots = [
    path.join(os.homedir(), ".cache", "ms-playwright"),
    "/home/tsien/.cache/ms-playwright",
  ];
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const root of cacheRoots) {
    if (seen.has(root) || !fs.existsSync(root)) continue;
    seen.add(root);
    let entries: string[];
    try {
      entries = fs.readdirSync(root).sort().reverse();
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith("chromium-")) {
        candidates.push(
          path.join(root, entry, "chrome-linux64", "chrome"),
          path.join(root, entry, "chrome-linux", "chrome"),
        );
      } else if (entry.startsWith("chromium_headless_shell-")) {
        candidates.push(path.join(root, entry, "chrome-headless-shell-linux64", "chrome-headless-shell"));
      }
    }
  }
  return candidates;
}

function puppeteerCandidates(): string[] {
  const rel = path.join("node_modules", "puppeteer-core", "lib", "puppeteer", "puppeteer-core.js");
  return [
    path.join(os.homedir(), rel),
    path.join(os.homedir(), ".bun", "install", "global", rel),
    path.resolve(import.meta.dir, "..", "..", rel),
  ];
}

export const CHROME_PATH =
  firstExisting([process.env.WORKBENCH_CHROME_PATH, LEGACY_CHROME_PATH, ...playwrightChromeCandidates()]) ??
  LEGACY_CHROME_PATH;

export const PUPPETEER_PATH =
  firstExisting([process.env.WORKBENCH_PUPPETEER_PATH, LEGACY_PUPPETEER_PATH, ...puppeteerCandidates()]) ??
  LEGACY_PUPPETEER_PATH;

export const HAS_BROWSER = fs.existsSync(CHROME_PATH) && fs.existsSync(PUPPETEER_PATH);