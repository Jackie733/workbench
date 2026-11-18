import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function findPlaywrightChromium(): string | undefined {
  const cacheDir = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), ".cache", "ms-playwright");
  let entries: string[];
  try {
    entries = fs.readdirSync(cacheDir);
  } catch {
    return undefined;
  }
  const candidates = entries
    .flatMap((entry) => {
      const match = /^(chromium|chromium_headless_shell)-(\d+)$/.exec(entry);
      if (!match) return [];
      const executable = match[1] === "chromium"
        ? "chrome-linux64/chrome"
        : "chrome-headless-shell-linux64/chrome-headless-shell";
      return [{ version: Number(match[2]), executable: path.join(cacheDir, entry, executable) }];
    })
    .sort((a, b) => b.version - a.version);
  return candidates.find(({ executable }) => fs.existsSync(executable))?.executable;
}

const puppeteerEntry = "puppeteer-core/lib/puppeteer/puppeteer-core.js";

export const CHROME_PATH = process.env.WORKBENCH_CHROME_PATH?.trim()
  || findPlaywrightChromium()
  || Bun.which("chromium")
  || Bun.which("google-chrome")
  || "";
export const PUPPETEER_PATH = process.env.WORKBENCH_PUPPETEER_PATH?.trim()
  || [
    path.resolve(import.meta.dir, "../../node_modules", puppeteerEntry),
    path.join(os.homedir(), ".bun/install/global/node_modules", puppeteerEntry),
  ].find((candidate) => fs.existsSync(candidate))
  || "";
export const HAS_BROWSER = fs.existsSync(CHROME_PATH) && fs.existsSync(PUPPETEER_PATH);
