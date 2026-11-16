import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalRoot } from "../core/fs.ts";

export interface ServerRuntimeInfo {
  pid: number;
  port: number;
  url: string;
  root: string;
  startedAt: number;
}

function runtimeBaseDir(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return path.join(os.tmpdir(), `workbench-${uid}`);
}

export function serverDiscoveryPath(root: string): string {
  const base = canonicalRoot(root);
  const hash = createHash("sha256").update(base, "utf8").digest("hex").slice(0, 16);
  return path.join(runtimeBaseDir(), "servers", `${hash}.json`);
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Ignore on filesystems that don't preserve POSIX modes.
  }
}

export function writeServerDiscovery(info: ServerRuntimeInfo): string {
  const filePath = serverDiscoveryPath(info.root);
  ensurePrivateDir(runtimeBaseDir());
  ensurePrivateDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  return filePath;
}

export function readServerDiscovery(root: string): ServerRuntimeInfo | null {
  try {
    const filePath = serverDiscoveryPath(root);
    if (!fs.existsSync(filePath)) return null;
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<ServerRuntimeInfo>;
    if (
      typeof raw.pid !== "number" ||
      typeof raw.port !== "number" ||
      typeof raw.url !== "string" ||
      typeof raw.root !== "string"
    ) {
      return null;
    }
    return raw as ServerRuntimeInfo;
  } catch {
    return null;
  }
}

export function removeServerDiscovery(root: string, expectedPid = process.pid): void {
  try {
    const current = readServerDiscovery(root);
    if (current && current.pid === expectedPid) {
      fs.rmSync(serverDiscoveryPath(root), { force: true });
    }
  } catch {
    // Ignore cleanup errors.
  }
}

async function isHealthyServer(info: ServerRuntimeInfo): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    try {
      const resp = await fetch(`${info.url}/api/health`, { signal: controller.signal });
      if (!resp.ok) return false;
      const body = (await resp.json()) as { ok?: boolean; root?: string };
      return body.ok === true && body.root === info.root;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/** Reuses a live local Workbench server for this project or starts one in the background. */
export async function ensureServerForProject(
  root: string,
  cliEntryPath = path.resolve(import.meta.dir, "../cli/index.ts"),
): Promise<ServerRuntimeInfo> {
  const base = canonicalRoot(root);
  const existing = readServerDiscovery(base);
  if (existing && (await isHealthyServer(existing))) {
    return existing;
  }

  const child = spawn("bun", ["run", cliEntryPath, "serve", "--root", base, "--port", "0"], {
    cwd: base,
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const info = readServerDiscovery(base);
    if (info && (await isHealthyServer(info))) {
      return info;
    }
    await delay(80);
  }
  throw new Error("启动本地 Workbench Web 服务超时");
}
