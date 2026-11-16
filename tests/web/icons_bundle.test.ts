import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { gzipSync } from "node:zlib";

const ROOT = path.resolve(import.meta.dir, "../..");
const WEB_DIR = path.join(ROOT, "src/web");
const FIXTURE_DIR = fs.mkdtempSync(path.join(import.meta.dir, ".icons-bundle-"));

// Same browser build configuration as src/server/index.ts (Bun 1.3.14, esm/browser/minify:false).
const BUILD_CONFIG = { target: "browser", format: "esm", minify: false } as const;
const BASELINE = { bun: "1.3.14", raw: 1_285_575, gzip: 230_480 };

async function build(entrypoint: string): Promise<{ raw: number; gzip: number; js: string }> {
  const result = await Bun.build({ entrypoints: [entrypoint], ...BUILD_CONFIG });
  if (!result.success || result.outputs.length === 0) {
    throw new Error(result.logs.map((log) => log.message).join("; "));
  }
  const js = await result.outputs[0]!.text();
  const bytes = Buffer.from(js);
  return { raw: bytes.byteLength, gzip: gzipSync(bytes).byteLength, js };
}

function fixture(name: string, source: string): string {
  const file = path.join(FIXTURE_DIR, `${name}.tsx`);
  fs.writeFileSync(file, source);
  return file;
}

const oneIcon = fixture(
  "one-icon",
  `import { Check } from "lucide-react";\nexport const glyph = Check;\n`,
);
const multiIcon = fixture(
  "multi-icon",
  `import { ArrowLeft, Check, Circle, CircleAlert, Menu, MessageSquare, RefreshCw, Terminal, X } from "lucide-react";\nexport const glyphs = [ArrowLeft, Check, Circle, CircleAlert, Menu, MessageSquare, RefreshCw, Terminal, X];\n`,
);
const catalog = fixture(
  "catalog",
  `import * as icons from "lucide-react";\nexport const count = Object.keys(icons).length;\n`,
);

afterAll(() => {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe("icon dependency and bundle contract", () => {
  test("locks the React-19-compatible lucide-react release without unrelated upgrades", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.dependencies["lucide-react"]).toBe("1.73.0");
    expect(pkg.dependencies.react).toBe("^19.0.0");
    expect(pkg.dependencies["react-dom"]).toBe("^19.0.0");
    expect(pkg.devDependencies.typescript).toBe("^5.8.0");

    const lock = fs.readFileSync(path.join(ROOT, "bun.lock"), "utf8");
    expect(lock).toContain('"lucide-react": ["lucide-react@1.73.0"');

    const installed = JSON.parse(
      fs.readFileSync(path.join(ROOT, "node_modules/lucide-react/package.json"), "utf8"),
    ) as { version: string; license: string };
    expect(installed.version).toBe("1.73.0");
    expect(installed.license).toBe("ISC");
  });

  test("the real app builds with Bun browser settings and ships a static icon glyph", async () => {
    const app = await build(path.join(WEB_DIR, "app.tsx"));
    expect(app.raw).toBeGreaterThan(0);
    expect(app.gzip).toBeLessThan(app.raw);
    // Check's path data proves the shared icon is compiled into the local bundle.
    expect(app.js).toContain("M20 6 9 17l-5-5");

    console.log(
      `[REQ-001] bundle before raw=${BASELINE.raw} gzip=${BASELINE.gzip}; ` +
        `after raw=${app.raw} gzip=${app.gzip} (Bun ${Bun.version}, esm/browser/minify:false)`,
    );

    // Measured on this machine with identical settings: +25,782 raw / +7,053 gzip.
    // Leave generous headroom while still failing on catalog-sized regressions.
    expect(app.raw).toBeLessThan(BASELINE.raw + 60_000);
    expect(app.gzip).toBeLessThan(BASELINE.gzip + 20_000);
  });

  test("static named imports tree-shake instead of pulling the whole catalog", async () => {
    const [one, multi, whole] = await Promise.all([build(oneIcon), build(multiIcon), build(catalog)]);

    console.log(
      `[REQ-001] fixture raw: one=${one.raw} multi=${multi.raw} catalog=${whole.raw} ` +
        `(gzip: one=${one.gzip} multi=${multi.gzip} catalog=${whole.gzip})`,
    );

    expect(whole.raw).toBeGreaterThan(one.raw * 5);
    expect(multi.raw - one.raw).toBeLessThan(25_000);
    const app = await build(path.join(WEB_DIR, "app.tsx"));
    expect(app.raw).toBeLessThan(whole.raw * 0.95);
  });

  test("does not introduce runtime icon requests, icon fonts, or the dynamic loader", async () => {
    const app = await build(path.join(WEB_DIR, "app.tsx"));
    for (const forbidden of [
      "unpkg.com",
      "cdn.jsdelivr.net",
      "fonts.googleapis.com",
      "fonts.gstatic.com",
      "lucide.dev",
      "lucide-react/dynamic",
      "@font-face",
    ]) {
      expect(app.js, `bundle must not reference ${forbidden}`).not.toContain(forbidden);
    }
    expect(app.js).not.toMatch(/https?:\/\/[^"']*\.(?:woff2?|ttf|otf)/i);

    const css = fs.readFileSync(path.join(WEB_DIR, "styles.css"), "utf8");
    expect(css).not.toMatch(/url\(\s*["']?https?:/i);
    expect(css).not.toContain("@font-face");
  });

  test("all lucide imports stay static named imports", () => {
    const files = fs
      .readdirSync(path.join(WEB_DIR, "components"))
      .filter((file) => file.endsWith(".tsx"))
      .map((file) => path.join(WEB_DIR, "components", file))
      .concat([path.join(WEB_DIR, "app.tsx"), path.join(WEB_DIR, "state.ts"), path.join(WEB_DIR, "render.ts")]);

    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(/import\s+(?!type\b)([\s\S]*?)\s+from\s+"lucide-react"/g)) {
        const clause = match[1]!.trim();
        expect(clause, `${path.relative(ROOT, file)} must use named imports`).toContain("{");
        expect(clause, `${path.relative(ROOT, file)} must not namespace-import`).not.toContain("*");
      }
      expect(source).not.toMatch(/import\s*\(\s*["']lucide-react/);
    }
  });
});
