import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkbenchError } from "./errors.ts";
import { atomicWriteBuffer, canonicalRoot, readJsonStrict, resolveSafePath } from "./fs.ts";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_NAME_CHARS,
  MAX_ATTACHMENTS_PER_ITEM,
  MAX_ATTACHMENT_TOTAL_BYTES,
  WORKBENCH_DIR,
  type AttachmentMeta,
} from "./types.ts";

/** 允许上传的扩展名 → 服务端 MIME 白名单。svg/html 及可执行类型一律不在此表中。 */
export const ATTACHMENT_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  log: "text/plain",
  zip: "application/zip",
};

export const ATTACHMENT_ALLOWED_EXTENSIONS = Object.keys(ATTACHMENT_MIME_BY_EXT);

export const ATTACHMENT_STAGING_TTL_MS = 24 * 60 * 60 * 1000;

const ATTACHMENT_ID_RE = /^ATT-[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
const TOKEN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function isAttachmentId(value: unknown): value is string {
  return typeof value === "string" && ATTACHMENT_ID_RE.test(value);
}

/** 取小写扩展名；无扩展名时返回空串。 */
export function attachmentExtension(name: string): string {
  const base = path.basename(name.replace(/\\/g, "/"));
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** 将用户文件名清理为仅用于展示的安全文本；落盘名始终由服务端生成。 */
export function normalizeAttachmentName(raw: string): string {
  const withoutPath = raw.replace(/\\/g, "/").split("/").pop() ?? "";
  let name = withoutPath
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(LONE_SURROGATE, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) name = "attachment";
  const ext = attachmentExtension(name);
  const suffix = ext ? `.${ext}` : "";
  let base = suffix ? name.slice(0, name.length - suffix.length) : name;
  if (!base) base = "attachment";
  const maxBaseChars = Math.max(1, MAX_ATTACHMENT_NAME_CHARS - suffix.length);
  const chars = Array.from(base);
  if (chars.length > maxBaseChars) {
    base = chars.slice(0, maxBaseChars).join("").trim() || "attachment";
  }
  return `${base}${suffix}`;
}

/** 按扩展名解析 MIME；不在白名单内直接拒绝。 */
export function attachmentMimeType(name: string): string {
  const ext = attachmentExtension(name);
  const mime = ATTACHMENT_MIME_BY_EXT[ext];
  if (!mime) {
    throw new WorkbenchError(
      "invalid_input",
      `不支持的附件类型: .${ext || "(无扩展名)"}；仅允许图片 ${ATTACHMENT_ALLOWED_EXTENSIONS.filter((e) => ATTACHMENT_MIME_BY_EXT[e]!.startsWith("image/")).join("/")} 与文件 ${ATTACHMENT_ALLOWED_EXTENSIONS.filter((e) => !ATTACHMENT_MIME_BY_EXT[e]!.startsWith("image/")).join("/")}`,
    );
  }
  return mime;
}

export function attachmentFileName(meta: AttachmentMeta): string {
  const ext = attachmentExtension(meta.name);
  const mime = ATTACHMENT_MIME_BY_EXT[ext];
  if (!mime || mime !== meta.mimeType) {
    throw new WorkbenchError("corrupt_record", `附件 ${meta.id} 的类型元数据损坏`);
  }
  return `${meta.id}.${ext}`;
}

export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** 需求附件正式目录：.workbench/items/<REQ>/attachments/ */
export function requirementAttachmentsDir(root: string, requirementId: string): string {
  return resolveSafePath(root, WORKBENCH_DIR, "items", requirementId, "attachments");
}

export function attachmentsStagingRoot(): string {
  const custom = process.env.WORKBENCH_HUB_DIR?.trim();
  const hubDir = custom ? path.resolve(custom) : path.join(os.homedir(), ".workbench-hub");
  return path.join(hubDir, "uploads");
}

function assertAttachmentSetWithinLimits(metas: AttachmentMeta[], label = "附件"): void {
  if (metas.length > MAX_ATTACHMENTS_PER_ITEM) {
    throw new WorkbenchError(
      "invalid_input",
      `${label}最多 ${MAX_ATTACHMENTS_PER_ITEM} 个，当前 ${metas.length} 个`,
    );
  }
  const total = metas.reduce((sum, m) => sum + m.size, 0);
  if (total > MAX_ATTACHMENT_TOTAL_BYTES) {
    throw new WorkbenchError(
      "payload_too_large",
      `${label}合计大小超过 ${formatAttachmentSize(MAX_ATTACHMENT_TOTAL_BYTES)} 上限`,
    );
  }
}

function isSafeDisplayName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_ATTACHMENT_NAME_CHARS * 4 &&
    !CONTROL_CHARS.test(value) &&
    !LONE_SURROGATE.test(value)
  );
}

/** 读取旧 state / inbox 中的附件字段时做防御性校验；undefined 表示旧数据无附件。 */
export function normalizeAttachments(raw: unknown): AttachmentMeta[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new WorkbenchError("corrupt_record", "attachments 字段必须是数组");
  }
  const ids = new Set<string>();
  const out: AttachmentMeta[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new WorkbenchError("corrupt_record", "attachments 中的记录必须是对象");
    }
    const obj = entry as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.some((k) => !["id", "name", "mimeType", "size", "sha256", "addedAt"].includes(k))) {
      throw new WorkbenchError("corrupt_record", "attachments 记录包含未知字段");
    }
    if (
      !isAttachmentId(obj.id) ||
      !isSafeDisplayName(obj.name) ||
      typeof obj.mimeType !== "string" ||
      !Number.isSafeInteger(obj.size) ||
      (obj.size as number) < 0 ||
      (obj.size as number) > MAX_ATTACHMENT_BYTES ||
      typeof obj.sha256 !== "string" ||
      !SHA256_RE.test(obj.sha256) ||
      !Number.isSafeInteger(obj.addedAt) ||
      (obj.addedAt as number) < 0
    ) {
      throw new WorkbenchError("corrupt_record", "attachments 记录字段损坏");
    }
    const ext = attachmentExtension(obj.name);
    const expectedMime = ATTACHMENT_MIME_BY_EXT[ext];
    if (!expectedMime || expectedMime !== obj.mimeType) {
      throw new WorkbenchError("corrupt_record", `附件 ${String(obj.id)} 的文件名或 MIME 不在白名单内`);
    }
    if (ids.has(obj.id as string)) {
      throw new WorkbenchError("corrupt_record", `附件 ID 重复: ${String(obj.id)}`);
    }
    ids.add(obj.id as string);
    out.push({
      id: obj.id as string,
      name: obj.name as string,
      mimeType: obj.mimeType as string,
      size: obj.size as number,
      sha256: obj.sha256 as string,
      addedAt: obj.addedAt as number,
    });
  }
  assertAttachmentSetWithinLimits(out);
  return out;
}

/** 惰性清扫超过 TTL 的暂存目录；返回清理数量。 */
export function sweepStagedUploads(now = Date.now()): number {
  const root = attachmentsStagingRoot();
  if (!fs.existsSync(root)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      const stat = fs.lstatSync(dir);
      if (stat.isSymbolicLink()) {
        fs.rmSync(dir, { force: true });
        removed += 1;
        continue;
      }
      if (now - stat.mtimeMs > ATTACHMENT_STAGING_TTL_MS) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // 并发删除或权限异常时跳过，下一次惰性清扫会再处理。
    }
  }
  return removed;
}

export interface StageUploadInput {
  name: string;
  bytes: Buffer | Uint8Array;
}

/** 校验并写入 hub 暂存区，返回附件元数据。 */
export function stageUpload(files: StageUploadInput[]): AttachmentMeta[] {
  if (files.length === 0) {
    throw new WorkbenchError("invalid_input", "请选择至少一个附件文件");
  }
  if (files.length > MAX_ATTACHMENTS_PER_ITEM) {
    throw new WorkbenchError(
      "invalid_input",
      `单次最多上传 ${MAX_ATTACHMENTS_PER_ITEM} 个附件，当前 ${files.length} 个`,
    );
  }

  const now = Date.now();
  const prepared = files.map((file) => {
    const name = normalizeAttachmentName(file.name);
    const mimeType = attachmentMimeType(name);
    const bytes = Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(file.bytes);
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new WorkbenchError(
        "payload_too_large",
        `文件 ${name} 超过单文件 ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)} 上限`,
      );
    }
    return { name, mimeType, bytes };
  });
  const total = prepared.reduce((sum, p) => sum + p.bytes.length, 0);
  if (total > MAX_ATTACHMENT_TOTAL_BYTES) {
    throw new WorkbenchError(
      "payload_too_large",
      `附件合计大小超过 ${formatAttachmentSize(MAX_ATTACHMENT_TOTAL_BYTES)} 上限`,
    );
  }

  sweepStagedUploads(now);
  const root = attachmentsStagingRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stagingRoot = canonicalRoot(root);
  const created: string[] = [];
  const metas: AttachmentMeta[] = [];
  try {
    for (const item of prepared) {
      let id = "";
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = `ATT-${now.toString(36)}-${randomUUID().replace(/-/g, "").slice(0, 6)}`;
        if (!fs.existsSync(path.join(stagingRoot, candidate))) {
          id = candidate;
          break;
        }
      }
      if (!id) throw new WorkbenchError("execution_failed", "无法生成唯一附件 ID，请重试");
      const dir = resolveSafePath(stagingRoot, id);
      fs.mkdirSync(dir, { recursive: false, mode: 0o700 });
      created.push(dir);
      const ext = attachmentExtension(item.name);
      const fileName = `${id}.${ext}`;
      const meta: AttachmentMeta = {
        id,
        name: item.name,
        mimeType: item.mimeType,
        size: item.bytes.length,
        sha256: createHash("sha256").update(item.bytes).digest("hex"),
        addedAt: now,
      };
      atomicWriteBuffer(resolveSafePath(dir, fileName), item.bytes, 0o600);
      atomicWriteBuffer(
        resolveSafePath(dir, "meta.json"),
        Buffer.from(`${JSON.stringify(meta, null, 2)}\n`, "utf8"),
        0o600,
      );
      metas.push(meta);
    }
  } catch (error) {
    for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return metas;
}

function readStagedMeta(id: string): { meta: AttachmentMeta; dir: string; filePath: string } {
  if (!isAttachmentId(id)) {
    throw new WorkbenchError("invalid_input", `无效的附件 ID: ${id}`);
  }
  const root = attachmentsStagingRoot();
  if (!fs.existsSync(root)) {
    throw new WorkbenchError("not_found", "附件暂存区不存在或附件已过期");
  }
  const stagingRoot = canonicalRoot(root);
  const dir = path.join(stagingRoot, id);
  if (!fs.existsSync(dir) || fs.lstatSync(dir).isSymbolicLink()) {
    throw new WorkbenchError("not_found", "附件不存在或已过期，请重新上传");
  }
  const metaPath = resolveSafePath(stagingRoot, id, "meta.json");
  if (!fs.existsSync(metaPath)) {
    throw new WorkbenchError("not_found", "附件元数据已过期，请重新上传");
  }
  const parsed = readJsonStrict<unknown>(metaPath, 16 * 1024);
  const metas = normalizeAttachments([parsed]);
  const meta = metas?.[0];
  if (!meta || meta.id !== id) {
    throw new WorkbenchError("corrupt_record", "附件暂存元数据损坏");
  }
  const filePath = resolveSafePath(stagingRoot, id, attachmentFileName(meta));
  if (!fs.existsSync(filePath)) {
    throw new WorkbenchError("not_found", "附件文件不存在或已过期，请重新上传");
  }
  return { meta, dir, filePath };
}

/** 丢弃尚未认领的暂存附件（例如痛点被 RSI 深度抑制时）。 */
export function discardStagedAttachments(ids: string[]): void {
  for (const id of ids) {
    if (!isAttachmentId(id)) continue;
    const root = attachmentsStagingRoot();
    if (!fs.existsSync(root)) continue;
    const dir = path.join(root, id);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // TTL 兜底。
    }
  }
}

function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return canonicalRoot(dir);
}

function moveFile(source: string, target: string): void {
  try {
    fs.renameSync(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    fs.copyFileSync(source, target);
    fs.unlinkSync(source);
  }
}

/** 凭 attachmentIds 从暂存区认领到目标目录，合并前复检数量与总量上限。 */
export function claimAttachments(
  attachmentIds: string[],
  targetDir: string,
  existing: AttachmentMeta[] = [],
): AttachmentMeta[] {
  const uniqueIds: string[] = [];
  for (const raw of attachmentIds) {
    if (!isAttachmentId(raw)) {
      throw new WorkbenchError("not_found", `附件不存在或已过期: ${String(raw)}`);
    }
    if (!uniqueIds.includes(raw)) uniqueIds.push(raw);
  }
  if (uniqueIds.length === 0) return [];
  if (existing.length + uniqueIds.length > MAX_ATTACHMENTS_PER_ITEM) {
    throw new WorkbenchError(
      "invalid_input",
      `单条记录最多 ${MAX_ATTACHMENTS_PER_ITEM} 个附件，已有 ${existing.length} 个，无法再添加 ${uniqueIds.length} 个`,
    );
  }

  const staged = uniqueIds.map((id) => readStagedMeta(id));
  const mergedBytes =
    existing.reduce((sum, m) => sum + m.size, 0) + staged.reduce((sum, s) => sum + s.meta.size, 0);
  if (mergedBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
    throw new WorkbenchError(
      "payload_too_large",
      `附件合计大小超过 ${formatAttachmentSize(MAX_ATTACHMENT_TOTAL_BYTES)} 上限`,
    );
  }
  if (existing.some((m) => uniqueIds.includes(m.id))) {
    throw new WorkbenchError("invalid_input", "附件 ID 已存在于目标记录");
  }

  const target = ensureDir(targetDir);
  const moved: string[] = [];
  const result: AttachmentMeta[] = [];
  try {
    for (const item of staged) {
      const dest = resolveSafePath(target, attachmentFileName(item.meta));
      if (fs.existsSync(dest)) {
        throw new WorkbenchError("invalid_input", `目标位置已存在同名附件: ${item.meta.id}`);
      }
      moveFile(item.filePath, dest);
      moved.push(dest);
      result.push(item.meta);
    }
  } catch (error) {
    for (const dest of moved) {
      try {
        fs.rmSync(dest, { force: true });
      } catch {
        // 回滚尽力而为。
      }
    }
    throw error;
  }
  for (const item of staged) {
    fs.rmSync(item.dir, { recursive: true, force: true });
  }
  return result;
}

/** 把源目录中的附件复制到目标目录（痛点转正、沙箱镜像等场景）。 */
export function copyAttachments(
  sourceDir: string,
  metas: AttachmentMeta[],
  targetDir: string,
): AttachmentMeta[] {
  if (metas.length === 0) return [];
  assertAttachmentSetWithinLimits(metas);
  if (!fs.existsSync(sourceDir)) {
    throw new WorkbenchError("not_found", "源附件目录不存在");
  }
  const source = canonicalRoot(sourceDir);
  const target = ensureDir(targetDir);
  const copied: string[] = [];
  try {
    for (const meta of metas) {
      const src = resolveSafePath(source, attachmentFileName(meta));
      const stat = fs.lstatSync(src);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new WorkbenchError("symlink_not_allowed", `附件不是普通文件: ${meta.name}`);
      }
      const bytes = fs.readFileSync(src);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== meta.sha256) {
        throw new WorkbenchError("corrupt_record", `附件 ${meta.name} 内容摘要校验失败`);
      }
      const dest = resolveSafePath(target, attachmentFileName(meta));
      atomicWriteBuffer(dest, bytes, 0o600);
      copied.push(dest);
    }
  } catch (error) {
    for (const dest of copied) {
      try {
        fs.rmSync(dest, { force: true });
      } catch {
        // 回滚尽力而为。
      }
    }
    throw error;
  }
  return metas.map((m) => ({ ...m }));
}

export function verifyAttachmentIntegrity(baseDir: string, meta: AttachmentMeta): boolean {
  try {
    if (!fs.existsSync(baseDir)) return false;
    const base = canonicalRoot(baseDir);
    const filePath = resolveSafePath(base, attachmentFileName(meta));
    if (fs.lstatSync(filePath).isSymbolicLink()) return false;
    const bytes = fs.readFileSync(filePath);
    return bytes.length === meta.size && createHash("sha256").update(bytes).digest("hex") === meta.sha256;
  } catch {
    return false;
  }
}

export interface ServedAttachment {
  bytes: Buffer;
  headers: Record<string, string>;
  mimeType: string;
  name: string;
}

function contentDispositionFilename(name: string): string {
  const asciiFallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\\r\n]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*!]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

/** 按元数据白名单读取附件并生成安全响应头；attId 非法或不存在一律 404。 */
export function readAttachmentForServe(
  baseDir: string,
  attId: string,
  metas: AttachmentMeta[],
): ServedAttachment {
  const meta = metas.find((m) => m.id === attId);
  if (!meta || !isAttachmentId(attId)) {
    throw new WorkbenchError("not_found", "附件不存在");
  }
  if (!fs.existsSync(baseDir)) {
    throw new WorkbenchError("not_found", "附件不存在");
  }
  const base = canonicalRoot(baseDir);
  const filePath = resolveSafePath(base, attachmentFileName(meta));
  if (!fs.existsSync(filePath)) {
    throw new WorkbenchError("not_found", "附件文件不存在");
  }
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new WorkbenchError("not_found", "附件文件不存在");
  }
  const bytes = fs.readFileSync(filePath);
  const isImage = meta.mimeType.startsWith("image/");
  return {
    bytes,
    mimeType: meta.mimeType,
    name: meta.name,
    headers: {
      "Content-Type": meta.mimeType,
      "Content-Length": String(bytes.length),
      "Content-Disposition": `${isImage ? "inline" : "attachment"}; ${contentDispositionFilename(meta.name)}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
      "Cache-Control": "private, max-age=3600",
    },
  };
}

/** 删除附件文件并返回剩余元数据。 */
export function removeAttachment(
  baseDir: string,
  attId: string,
  metas: AttachmentMeta[],
): AttachmentMeta[] {
  const meta = metas.find((m) => m.id === attId);
  if (!meta || !isAttachmentId(attId)) {
    throw new WorkbenchError("not_found", "附件不存在");
  }
  const base = canonicalRoot(baseDir);
  const filePath = resolveSafePath(base, attachmentFileName(meta));
  if (!fs.existsSync(filePath)) {
    throw new WorkbenchError("not_found", "附件文件不存在");
  }
  if (fs.lstatSync(filePath).isSymbolicLink()) {
    throw new WorkbenchError("symlink_not_allowed", "拒绝删除符号链接附件");
  }
  fs.rmSync(filePath, { force: true });
  return metas.filter((m) => m.id !== attId);
}

