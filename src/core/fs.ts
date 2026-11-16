import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { WorkbenchError } from "./errors.ts";
import { WORKBENCH_DIR } from "./types.ts";

const LOCK_STALE_MS = 15_000;
const LOCK_WAIT_MS = 5_000;
const inProcessQueue = new Map<string, Promise<void>>();

/** Resolves and validates the canonical project root directory. */
export function canonicalRoot(root: string): string {
  if (!root || /[\x00-\x1f\x7f]/.test(root)) {
    throw new WorkbenchError("invalid_path", "项目路径无效");
  }
  let resolved: string;
  try {
    resolved = fs.realpathSync(root);
  } catch {
    throw new WorkbenchError("invalid_path", `项目目录不存在或无法访问: ${root}`);
  }
  const info = fs.statSync(resolved);
  if (!info.isDirectory()) {
    throw new WorkbenchError("invalid_path", `项目路径不是目录: ${root}`);
  }
  return resolved;
}

/** Validates a relative path and ensures no traversal or symlink escape exists inside canonicalRoot. */
export function resolveSafePath(root: string, ...relativeParts: string[]): string {
  const base = canonicalRoot(root);
  const parts: string[] = [];
  for (const raw of relativeParts) {
    if (typeof raw !== "string" || !raw || /[\x00-\x1f\x7f\\]/.test(raw) || path.isAbsolute(raw)) {
      throw new WorkbenchError("invalid_path", `非法相对路径: ${String(raw)}`);
    }
    for (const seg of raw.split("/")) {
      if (!seg || seg === "." || seg === "..") {
        throw new WorkbenchError("invalid_path", `路径不允许包含空段或越界段: ${raw}`);
      }
      parts.push(seg);
    }
  }
  let cursor = base;
  for (const seg of parts) {
    cursor = path.join(cursor, seg);
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) {
        throw new WorkbenchError("symlink_not_allowed", `不允许访问符号链接路径: ${path.relative(base, cursor)}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      if (error instanceof WorkbenchError) throw error;
      throw new WorkbenchError("invalid_path", `无法校验路径安全性: ${path.relative(base, cursor)}`);
    }
  }
  if (!cursor.startsWith(`${base}${path.sep}`)) {
    throw new WorkbenchError("invalid_path", "路径越出项目根目录");
  }
  return cursor;
}

/** Reads a regular non-symlink UTF-8 file within maxBytes. */
export function readBoundedText(filePath: string, maxBytes: number): string {
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WorkbenchError("not_found", `文件不存在: ${path.basename(filePath)}`);
    }
    throw error;
  }
  if (lstat.isSymbolicLink()) {
    throw new WorkbenchError("symlink_not_allowed", `不允许读取符号链接: ${filePath}`);
  }
  if (!lstat.isFile()) {
    throw new WorkbenchError("invalid_path", `目标不是普通文件: ${filePath}`);
  }
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new WorkbenchError("invalid_path", `目标不是普通文件: ${filePath}`);
    }
    if (stat.size > maxBytes) {
      throw new WorkbenchError("corrupt_record", `文件超出最大长度限制 (${maxBytes} 字节): ${path.basename(filePath)}`);
    }
    const buf = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const bytesRead = fs.readSync(fd, buf, offset, stat.size - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, offset));
  } catch (error) {
    if (error instanceof WorkbenchError) throw error;
    throw new WorkbenchError("corrupt_record", `读取或解码 UTF-8 文件失败: ${path.basename(filePath)}`);
  } finally {
    fs.closeSync(fd);
  }
}

export function readJsonStrict<T>(filePath: string, maxBytes: number): T {
  const raw = readBoundedText(filePath, maxBytes);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new WorkbenchError("corrupt_record", `JSON 解析失败: ${path.basename(filePath)}`);
  }
}

function syncDirBestEffort(dir: string): void {
  try {
    const fd = fs.openSync(dir, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Some filesystems do not support fsync on directory descriptors.
  }
}

/** Atomically writes UTF-8 text via temp file + fsync + rename. */
export function atomicWriteFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.tmp-${randomUUID()}`;
  const fd = fs.openSync(
    tempPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o644,
  );
  try {
    try {
      fs.writeFileSync(fd, content, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempPath, filePath);
    syncDirBestEffort(dir);
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}

export function atomicWriteJson(filePath: string, value: unknown): void {
  atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquireAdvisoryLock(lockPath: string): Promise<string> {
  const token = randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      const fd = fs.openSync(
        lockPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }), "utf8");
      } finally {
        fs.closeSync(fd);
      }
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      try {
        const raw = fs.readFileSync(lockPath, "utf8");
        const parsed = JSON.parse(raw) as { pid?: number; createdAt?: number };
        const dead = typeof parsed.pid === "number" && !isProcessAlive(parsed.pid);
        const expired = typeof parsed.createdAt === "number" && Date.now() - parsed.createdAt > LOCK_STALE_MS;
        if (dead || expired) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        const stat = fs.lstatSync(lockPath, { throwIfNoEntry: false });
        if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      }
      if (Date.now() >= deadline) {
        throw new WorkbenchError("lock_timeout", "项目正在被另一个工作台进程写入，请稍后重试");
      }
      await delay(25);
    }
  }
}

function releaseAdvisoryLock(lockPath: string, token: string): void {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { token?: string };
    if (parsed.token === token) {
      fs.rmSync(lockPath, { force: true });
    }
  } catch {
    // Lock already removed or replaced.
  }
}

/** Serializes project writes both in-process and across CLI/MCP/Server processes. */
export async function withProjectWriteLock<T>(root: string, fn: () => Promise<T> | T): Promise<T> {
  const base = canonicalRoot(root);
  const previous = inProcessQueue.get(base) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const tail = previous.then(() => current, () => current);
  inProcessQueue.set(base, tail);

  await previous.catch(() => {});
  const wbDir = path.join(base, WORKBENCH_DIR);
  const lockPath = path.join(wbDir, ".lock");
  let token: string | null = null;
  try {
    if (fs.existsSync(wbDir)) {
      token = await acquireAdvisoryLock(lockPath);
    }
    return await fn();
  } finally {
    if (token !== null) {
      releaseAdvisoryLock(lockPath, token);
    }
    releaseQueue();
    if (inProcessQueue.get(base) === tail) {
      inProcessQueue.delete(base);
    }
  }
}

/** Safely lists non-symlink directory entries inside a resolved directory. */
export function listDirSafe(dirPath: string): fs.Dirent[] {
  if (!fs.existsSync(dirPath)) return [];
  const lstat = fs.lstatSync(dirPath);
  if (lstat.isSymbolicLink()) {
    throw new WorkbenchError("symlink_not_allowed", `不允许读取符号链接目录: ${dirPath}`);
  }
  if (!lstat.isDirectory()) {
    throw new WorkbenchError("invalid_path", `路径不是目录: ${dirPath}`);
  }
  return fs.readdirSync(dirPath, { withFileTypes: true }).filter((entry) => !entry.isSymbolicLink());
}
