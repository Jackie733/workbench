import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  claimAttachments,
  formatAttachmentSize,
  normalizeAttachmentName,
  normalizeAttachments,
  readAttachmentForServe,
  removeAttachment,
  stageUpload,
  sweepStagedUploads,
  verifyAttachmentIntegrity,
} from "../../src/core/attachments.ts";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_ITEM,
  MAX_ATTACHMENT_TOTAL_BYTES,
} from "../../src/core/types.ts";

const tempDirs: string[] = [];
const origHubDir = process.env.WORKBENCH_HUB_DIR;

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  expect((caught as { code?: string }).code).toBe(code);
}

beforeEach(() => {
  process.env.WORKBENCH_HUB_DIR = makeTempDir("wb-att-hub-");
});

afterEach(() => {
  if (origHubDir === undefined) delete process.env.WORKBENCH_HUB_DIR;
  else process.env.WORKBENCH_HUB_DIR = origHubDir;
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("附件核心模块", () => {
  test("类型白名单拒绝 svg/html/可执行文件，允许图片与文档", () => {
    expect(() => stageUpload([{ name: "evil.svg", bytes: Buffer.from("<svg/>") }])).toThrow("不支持的附件类型");
    expect(() => stageUpload([{ name: "evil.html", bytes: Buffer.from("<html/>") }])).toThrow("不支持的附件类型");
    expect(() => stageUpload([{ name: "run.exe", bytes: Buffer.from("MZ") }])).toThrow("不支持的附件类型");
    expect(() => stageUpload([{ name: "noext", bytes: Buffer.from("x") }])).toThrow("不支持的附件类型");

    const metas = stageUpload([
      { name: "截图.png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      { name: "说明.md", bytes: Buffer.from("# hello") },
      { name: "数据.JSON", bytes: Buffer.from("{}") },
      { name: "photo.jpg", bytes: Buffer.from([0xff, 0xd8, 0xff]) },
    ]);
    expect(metas).toHaveLength(4);
    expect(metas[0]!.mimeType).toBe("image/png");
    expect(metas[2]!.mimeType).toBe("application/json");
    expect(metas[3]!.mimeType).toBe("image/jpeg");
  });

  test("单文件 10MB、单条 8 个、合计 20MB 限额", () => {
    expectCode(() => stageUpload([{ name: "big.png", bytes: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1) }]), "payload_too_large");

    expectCode(
      () =>
        stageUpload(
          Array.from({ length: MAX_ATTACHMENTS_PER_ITEM + 1 }, (_, i) => ({
            name: `f-${i}.txt`,
            bytes: Buffer.from(`ok-${i}`),
          })),
        ),
      "invalid_input",
    );

    expectCode(
      () =>
        stageUpload([
          { name: "a.zip", bytes: Buffer.alloc(8 * 1024 * 1024) },
          { name: "b.zip", bytes: Buffer.alloc(8 * 1024 * 1024) },
          { name: "c.zip", bytes: Buffer.alloc(8 * 1024 * 1024) },
        ]),
      "payload_too_large",
    );
    expect(formatAttachmentSize(MAX_ATTACHMENT_TOTAL_BYTES)).toBe("20.00 MB");
  });

  test("文件名 sanitize：去路径与控制字符、保留扩展名并截断到 120 字符", () => {
    expect(normalizeAttachmentName("../../etc/passwd.txt")).toBe("passwd.txt");
    expect(normalizeAttachmentName("evil\\win\\report.pdf")).toBe("report.pdf");
    expect(normalizeAttachmentName("bad\u0000name\u001f.png")).toBe("badname.png");
    expect(normalizeAttachmentName("   ")).toBe("attachment");
    const long = `${"长".repeat(300)}.png`;
    const normalized = normalizeAttachmentName(long);
    expect(Array.from(normalized).length).toBeLessThanOrEqual(120);
    expect(normalized.endsWith(".png")).toBe(true);
  });

  test("暂存 → 认领 → 读取 → 删除完整往返，sha256 与响应头正确", () => {
    const target = makeTempDir("wb-att-target-");
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const pdfBytes = Buffer.from("%PDF-1.4\n附件");
    const metas = stageUpload([
      { name: "截图.png", bytes: pngBytes },
      { name: "日志.pdf", bytes: pdfBytes },
    ]);

    expect(metas[0]!.sha256).toHaveLength(64);
    expect(fs.existsSync(path.join(process.env.WORKBENCH_HUB_DIR!, "uploads", metas[0]!.id))).toBe(true);

    const claimed = claimAttachments(
      metas.map((m) => m.id),
      target,
    );
    expect(claimed).toHaveLength(2);
    expect(fs.existsSync(path.join(target, `${claimed[0]!.id}.png`))).toBe(true);
    expect(verifyAttachmentIntegrity(target, claimed[0]!)).toBe(true);
    expect(verifyAttachmentIntegrity(target, { ...claimed[0]!, sha256: "0".repeat(64) })).toBe(false);

    const image = readAttachmentForServe(target, claimed[0]!.id, claimed);
    expect(image.bytes.equals(pngBytes)).toBe(true);
    expect(image.headers["Content-Type"]).toBe("image/png");
    expect(image.headers["Content-Disposition"]).toContain("inline");
    expect(image.headers["X-Content-Type-Options"]).toBe("nosniff");

    const pdf = readAttachmentForServe(target, claimed[1]!.id, claimed);
    expect(pdf.headers["Content-Type"]).toBe("application/pdf");
    expect(pdf.headers["Content-Disposition"]).toContain("attachment");
    expect(pdf.headers["Content-Disposition"]).toContain("filename*=UTF-8''");

    const remaining = removeAttachment(target, claimed[0]!.id, claimed);
    expect(remaining).toHaveLength(1);
    expect(fs.existsSync(path.join(target, `${claimed[0]!.id}.png`))).toBe(false);
  });

  test("路径穿越 attId 一律拒绝，未知附件返回 not_found", () => {
    const target = makeTempDir("wb-att-safe-");
    const metas = stageUpload([{ name: "ok.txt", bytes: Buffer.from("ok") }]);
    const claimed = claimAttachments([metas[0]!.id], target);

    expectCode(() => readAttachmentForServe(target, "../../etc/passwd", claimed), "not_found");
    expectCode(() => readAttachmentForServe(target, "ATT-not-exist", claimed), "not_found");
    expectCode(() => claimAttachments(["../../etc/passwd"], target), "not_found");
    expectCode(() => removeAttachment(target, "../x", claimed), "not_found");
  });

  test("暂存 TTL 惰性清扫与合并上限复检", () => {
    const expired = path.join(process.env.WORKBENCH_HUB_DIR!, "uploads", "ATT-expired");
    fs.mkdirSync(expired, { recursive: true });
    const old = Date.now() - 25 * 60 * 60 * 1000;
    fs.utimesSync(expired, old / 1000, old / 1000);
    expect(sweepStagedUploads()).toBe(1);
    expect(fs.existsSync(expired)).toBe(false);

    const target = makeTempDir("wb-att-merge-");
    const first = stageUpload(
      Array.from({ length: MAX_ATTACHMENTS_PER_ITEM }, (_, i) => ({
        name: `a-${i}.txt`,
        bytes: Buffer.from(`a-${i}`),
      })),
    );
    const existing = claimAttachments(first.map((m) => m.id), target);
    expect(existing).toHaveLength(MAX_ATTACHMENTS_PER_ITEM);
    const extra = stageUpload([{ name: "extra.txt", bytes: Buffer.from("extra") }]);
    expectCode(() => claimAttachments([extra[0]!.id], target, existing), "invalid_input");
  });

  test("normalizeAttachments 拒绝旧数据中的非法 MIME、未知字段与重复 ID", () => {
    const valid = {
      id: "ATT-abc123",
      name: "ok.png",
      mimeType: "image/png",
      size: 10,
      sha256: "a".repeat(64),
      addedAt: Date.now(),
    };
    expect(normalizeAttachments([valid])).toHaveLength(1);
    expect(normalizeAttachments(undefined)).toBeUndefined();
    expectCode(() => normalizeAttachments([{ ...valid, mimeType: "image/svg+xml" }]), "corrupt_record");
    expectCode(() => normalizeAttachments([{ ...valid, extra: true }]), "corrupt_record");
    expectCode(() => normalizeAttachments([valid, { ...valid }]), "corrupt_record");
  });
});
