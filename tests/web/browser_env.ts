import * as path from "node:path";
import { resolveBrowserEnvironment } from "../../src/core/screenshots.ts";

export interface TestBrowserEnvironment {
  chromePath: string;
  puppeteerPath: string;
  headless: true | "shell";
}

/** 复用截图模块的浏览器解析（env 覆盖 → Playwright 缓存 → PATH），供浏览器测试真实执行。 */
export function resolveTestBrowser(): TestBrowserEnvironment | null {
  const env = resolveBrowserEnvironment();
  if (!env.ok || !env.chromePath || !env.puppeteerPath) return null;
  const headless = path.basename(env.chromePath).includes("headless-shell") ? ("shell" as const) : true;
  return { chromePath: env.chromePath, puppeteerPath: env.puppeteerPath, headless };
}