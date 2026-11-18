import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";

const ROOT = path.resolve(import.meta.dir, "../..");
const SOURCE_BRAND_DIR = path.join(ROOT, "src/web/brand");

// 在仓库内复制一份 src，让 Bun.build 既能解析相对导入与 node_modules，
// 又能在独立副本上模拟素材缺失，不触碰真实文件。
const tempRoot = fs.mkdtempSync(path.join(import.meta.dir, ".brand-assets-"));
const tempSrc = path.join(tempRoot, "src");
const webDir = path.join(tempSrc, "web");
const brandDir = path.join(webDir, "brand");
let server: WorkbenchServerHandle;

const ASSETS = [
  { path: "/favicon.svg", file: "favicon.svg", contentType: "image/svg+xml" },
  { path: "/favicon.ico", file: "favicon.ico", contentType: "image/x-icon" },
  { path: "/apple-touch-icon.png", file: "apple-touch-icon.png", contentType: "image/png" },
  { path: "/brand/symbol-compact.svg", file: "symbol-compact.svg", contentType: "image/svg+xml" },
] as const;

/** 非回环 Host 让回环连接也走未登录分支，模拟局域网访客。 */
const remoteHeaders = { host: "workbench-remote.example" };

beforeAll(async () => {
  fs.cpSync(path.join(ROOT, "src"), tempSrc, { recursive: true });
  const projectRoot = path.join(tempRoot, "project");
  fs.mkdirSync(projectRoot);
  server = await startWorkbenchServer({ root: projectRoot, port: 0, writeDiscovery: false, webDir });
}, 30_000);

afterAll(() => {
  server?.stop();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("REQ-007 public brand assets", () => {
  test("serves the four exact paths with the right media type and original bytes without login", async () => {
    for (const asset of ASSETS) {
      const res = await fetch(`${server.url}${asset.path}`, { headers: remoteHeaders });
      expect(res.status, `${asset.path} must stay public`).toBe(200);
      expect(res.headers.get("content-type"), `${asset.path} media type`).toBe(asset.contentType);
      expect(res.headers.get("cache-control"), `${asset.path} cache policy`).toBe("no-store");
      const served = Buffer.from(await res.arrayBuffer());
      expect(served.equals(fs.readFileSync(path.join(SOURCE_BRAND_DIR, asset.file))), `${asset.path} bytes`).toBe(true);
    }
  });

  test("HEAD probes answer with metadata and no response body", async () => {
    for (const asset of ASSETS) {
      const res = await fetch(`${server.url}${asset.path}`, { method: "HEAD", headers: remoteHeaders });
      expect(res.status, `${asset.path} HEAD status`).toBe(200);
      expect(res.headers.get("content-type")).toBe(asset.contentType);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const size = fs.statSync(path.join(SOURCE_BRAND_DIR, asset.file)).size;
      expect(Number(res.headers.get("content-length")), `${asset.path} HEAD length`).toBe(size);
      expect((await res.arrayBuffer()).byteLength, `${asset.path} HEAD body`).toBe(0);
    }
  });

  test("known paths with missing files return 404 instead of the application page", async () => {
    const missing = path.join(brandDir, "favicon.ico");
    const parked = `${missing}.parked`;
    fs.renameSync(missing, parked);
    try {
      const res = await fetch(`${server.url}/favicon.ico`, { headers: remoteHeaders });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
      expect(await res.text()).not.toContain("<!doctype html>");
    } finally {
      fs.renameSync(parked, missing);
    }
    const restored = await fetch(`${server.url}/favicon.ico`, { headers: remoteHeaders });
    expect(restored.status).toBe(200);
  });

  test("rejects non-GET/HEAD methods without exposing other files", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await fetch(`${server.url}/brand/symbol-compact.svg`, { method, headers: remoteHeaders });
      expect(res.status, `${method} must be rejected`).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
    }
    const applicationPage = await fetch(`${server.url}/brand/unknown.svg`, { headers: remoteHeaders });
    expect(applicationPage.status).toBe(200);
    expect(applicationPage.headers.get("content-type")).toContain("text/html");
    expect(await applicationPage.text()).toContain("<!doctype html>");
  });

  test("public assets do not weaken protected API authentication", async () => {
    const anonymous = await fetch(`${server.url}/api/hub/state`, { headers: remoteHeaders });
    expect(anonymous.status).toBe(401);
    expect(((await anonymous.json()) as { error: { code: string } }).error.code).toBe("unauthorized");

    const status = await fetch(`${server.url}/api/auth/status`, { headers: remoteHeaders });
    expect(await status.json()).toEqual({ required: true, authenticated: false });

    for (const asset of ASSETS) {
      const res = await fetch(`${server.url}${asset.path}`, { headers: remoteHeaders });
      expect(res.status, `${asset.path} stays reachable for the login view`).toBe(200);
    }
  });
});
