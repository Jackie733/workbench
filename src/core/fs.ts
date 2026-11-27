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

/** Reads a regular non-symlink binary file within maxBytes. */
export function readBoundedBuffer(filePath: string, maxBytes: number): Buffer {
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
    return buf.subarray(0, offset);
  } catch (error) {
    if (error instanceof WorkbenchError) throw error;
    throw new WorkbenchError("corrupt_record", `读取二进制文件失败: ${path.basename(filePath)}`);
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

/** Atomically writes raw bytes via temp file + fsync + rename. */
export function atomicWriteBuffer(filePath: string, content: Buffer, mode?: number): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.tmp-${randomUUID()}`;
  const fd = fs.openSync(
    tempPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    mode ?? 0o644,
  );
  try {
    try {
      let offset = 0;
      while (offset < content.length) {
        const written = fs.writeSync(fd, content, offset, content.length - offset);
        if (written === 0) break;
        offset += written;
      }
      if (mode !== undefined) {
        fs.fchmodSync(fd, mode);
      }
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

/** Atomically writes UTF-8 text via temp file + fsync + rename. */
export function atomicWriteFile(filePath: string, content: string, mode?: number): void {
  atomicWriteBuffer(filePath, Buffer.from(content, "utf8"), mode);
}

export function atomicWriteJson(filePath: string, value: unknown, mode?: number): void {
  atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function tryBreakStaleLock(lockPath: string, staleMs = LOCK_STALE_MS): boolean {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: number; createdAt?: number };
    const dead = typeof parsed.pid === "number" && !isProcessAlive(parsed.pid);
    const expired = typeof parsed.createdAt === "number" && Date.now() - parsed.createdAt > staleMs;
    if (dead || expired) {
      fs.rmSync(lockPath, { force: true });
      return true;
    }
  } catch {
    const stat = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    if (stat && Date.now() - stat.mtimeMs > staleMs) {
      fs.rmSync(lockPath, { force: true });
      return true;
    }
  }
  return false;
}

function tryCreateLockFile(lockPath: string, holderMeta?: Record<string, string>): string | null {
  const token = randomUUID();
  try {
    const fd = fs.openSync(
      lockPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const payload = {
        token,
        pid: process.pid,
        createdAt: Date.now(),
        ...(holderMeta && Object.keys(holderMeta).length > 0 ? { holder: holderMeta } : {}),
      };
      fs.writeFileSync(fd, JSON.stringify(payload), "utf8");
    } finally {
      fs.closeSync(fd);
    }
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    return null;
  }
}

function readLockHolder(lockPath: string): Record<string, string> | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { holder?: unknown };
    if (!parsed.holder || typeof parsed.holder !== "object" || Array.isArray(parsed.holder)) {
      return null;
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.holder as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

export interface NamedAdvisoryLockOptions {
  waitTimeoutMs?: number;
  staleMs?: number;
  pollMs?: number;
  busyMessage?: string;
  holderMeta?: Record<string, string>;
  onWait?: (info: { waitedMs: number; holder: Record<string, string> | null }) => void;
  waitNotifyIntervalMs?: number;
}

const inProcessHolders = new Map<string, Record<string, string> | null>();

async function acquireAdvisoryLock(
  lockPath: string,
  options: NamedAdvisoryLockOptions = {},
): Promise<string> {
  const waitTimeoutMs = options.waitTimeoutMs ?? LOCK_WAIT_MS;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const pollMs = options.pollMs ?? 25;
  const notifyIntervalMs = options.waitNotifyIntervalMs ?? 15_000;
  const startedWaitAt = Date.now();
  const deadline = startedWaitAt + waitTimeoutMs;
  let notifiedOnce = false;
  let lastNotifiedAt = 0;

  while (true) {
    const token = tryCreateLockFile(lockPath, options.holderMeta);
    if (token) return token;
    if (tryBreakStaleLock(lockPath, staleMs)) continue;
    const now = Date.now();
    if (now >= deadline) {
      throw new WorkbenchError("lock_timeout", options.busyMessage ?? "项目正在被另一个工作台进程写入，请稍后重试");
    }
    const waitedMs = now - startedWaitAt;
    if (
      options.onWait &&
      ((!notifiedOnce && waitedMs >= 200) || (notifiedOnce && now - lastNotifiedAt >= notifyIntervalMs))
    ) {
      notifiedOnce = true;
      lastNotifiedAt = now;
      try {
        options.onWait({ waitedMs, holder: readLockHolder(lockPath) });
      } catch {
        // Progress notifications are strictly best-effort.
      }
    }
    await delay(pollMs);
  }
}

function acquireAdvisoryLockSync(lockPath: string): string {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    const token = tryCreateLockFile(lockPath);
    if (token) return token;
    if (tryBreakStaleLock(lockPath)) continue;
    if (Date.now() >= deadline) {
      throw new WorkbenchError("lock_timeout", "文件正在被另一个工作台进程写入，请稍后重试");
    }
    if (typeof Bun !== "undefined" && typeof Bun.sleepSync === "function") {
      Bun.sleepSync(15);
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

/** Serializes read-modify-write operations on a shared lock file synchronously across processes. */
export function withFileLockSync<T>(lockPath: string, fn: () => T): T {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = acquireAdvisoryLockSync(lockPath);
  try {
    return fn();
  } finally {
    releaseAdvisoryLock(lockPath, token);
  }
}

/** Serializes async operations both in-process and across CLI/MCP/Server processes using a named lock file. */
export async function withNamedAdvisoryLock<T>(
  lockPath: string,
  fn: () => Promise<T> | T,
  options: NamedAdvisoryLockOptions = {},
): Promise<T> {
  const queueKey = path.resolve(lockPath);
  const hasPrevious = inProcessQueue.has(queueKey);
  const previous = inProcessQueue.get(queueKey) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const tail = previous.then(() => current, () => current);
  inProcessQueue.set(queueKey, tail);

  if (hasPrevious && options.onWait) {
    const waitStartedAt = Date.now();
    const notifyIntervalMs = options.waitNotifyIntervalMs ?? 15_000;
    const emitInProcessWait = () => {
      try {
        options.onWait?.({
          waitedMs: Date.now() - waitStartedAt,
          holder: inProcessHolders.get(queueKey) ?? readLockHolder(queueKey),
        });
      } catch {
        // Best-effort wait progress notification.
      }
    };
    const initialTimer = setTimeout(emitInProcessWait, 200);
    const repeatTimer = setInterval(emitInProcessWait, notifyIntervalMs);
    initialTimer.unref?.();
    repeatTimer.unref?.();
    try {
      await previous.catch(() => {});
    } finally {
      clearTimeout(initialTimer);
      clearInterval(repeatTimer);
    }
  } else {
    await previous.catch(() => {});
  }

  let token: string | null = null;
  try {
    fs.mkdirSync(path.dirname(queueKey), { recursive: true, mode: 0o700 });
    token = await acquireAdvisoryLock(queueKey, options);
    inProcessHolders.set(queueKey, options.holderMeta ?? null);
    return await fn();
  } finally {
    inProcessHolders.delete(queueKey);
    if (token !== null) {
      releaseAdvisoryLock(queueKey, token);
    }
    releaseQueue();
    if (inProcessQueue.get(queueKey) === tail) {
      inProcessQueue.delete(queueKey);
    }
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
