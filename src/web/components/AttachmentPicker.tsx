import { useEffect, useRef, useState } from "react";
import { ImagePlus, Loader2, Paperclip, X } from "lucide-react";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_ITEM,
  MAX_ATTACHMENT_TOTAL_BYTES,
  type AttachmentMeta,
} from "../../core/types.ts";
import { api } from "../api.ts";
import { Icon } from "./Icon.tsx";

const CLIENT_ALLOWED_EXTS = new Set([
  "png",
  "jpeg",
  "jpg",
  "gif",
  "webp",
  "pdf",
  "txt",
  "md",
  "json",
  "csv",
  "log",
  "zip",
]);

function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export interface AttachmentPickerProps {
  value: AttachmentMeta[];
  onChange: (metas: AttachmentMeta[]) => void;
  disabled?: boolean;
  scope?: "project" | "hub";
}

/** 文件选择 / 拖拽 / 剪贴板截图三合一附件选择器。 */
export function AttachmentPicker({ value, onChange, disabled, scope = "project" }: AttachmentPickerProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const previewsRef = useRef<Record<string, string>>({});

  const totalSize = value.reduce((sum, meta) => sum + meta.size, 0);

  useEffect(
    () => () => {
      for (const url of Object.values(previewsRef.current)) URL.revokeObjectURL(url);
      previewsRef.current = {};
    },
    [],
  );

  const removeLocal = (attId: string) => {
    const url = previewsRef.current[attId];
    if (url) {
      URL.revokeObjectURL(url);
      delete previewsRef.current[attId];
      setPreviews({ ...previewsRef.current });
    }
    onChange(value.filter((m) => m.id !== attId));
  };

  const addFiles = async (incoming: File[]) => {
    if (disabled || incoming.length === 0) return;
    setError(null);
    const remaining = MAX_ATTACHMENTS_PER_ITEM - value.length;
    if (remaining <= 0) {
      setError(`单条记录最多 ${MAX_ATTACHMENTS_PER_ITEM} 个附件`);
      return;
    }
    const accepted: File[] = [];
    for (const file of incoming) {
      const ext = extensionOf(file.name);
      if (!CLIENT_ALLOWED_EXTS.has(ext)) {
        setError(`不支持的附件类型: ${file.name}（禁止 svg/html 及可执行文件）`);
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setError(`文件 ${file.name} 超过单文件 10 MB 上限`);
        continue;
      }
      accepted.push(file);
    }
    if (accepted.length === 0) return;
    const picked = accepted.slice(0, remaining);
    if (accepted.length > remaining) {
      setError(`单条记录最多 ${MAX_ATTACHMENTS_PER_ITEM} 个附件，已自动截取前 ${remaining} 个`);
    }
    setUploading(true);
    try {
      const res = await api.uploadAttachments(picked, scope);
      const next = [...value, ...res.attachments];
      const nextTotal = next.reduce((sum, meta) => sum + meta.size, 0);
      if (nextTotal > MAX_ATTACHMENT_TOTAL_BYTES) {
        setError("附件合计大小超过 20 MB 上限");
        return;
      }
      for (let i = 0; i < res.attachments.length; i += 1) {
        const meta = res.attachments[i]!;
        const file = picked[i];
        if (file && meta.mimeType.startsWith("image/")) {
          previewsRef.current[meta.id] = URL.createObjectURL(file);
        }
      }
      setPreviews({ ...previewsRef.current });
      onChange(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "附件上传失败");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const files: File[] = [];
    const items = event.clipboardData?.items ?? [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item?.kind !== "file" || !item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (!file) continue;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const ext = item.type === "image/jpeg" ? "jpg" : item.type.split("/")[1] || "png";
      files.push(new File([file], `截图-${stamp}.${ext}`, { type: item.type }));
    }
    if (files.length > 0) {
      event.preventDefault();
      void addFiles(files);
    }
  };

  return (
    <div className="attachment-picker" data-testid="attachment-picker">
      <div
        className={`attachment-dropzone${dragOver ? " drag-over" : ""}${disabled ? " disabled" : ""}`}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label="添加图片或文件附件"
        onPaste={handlePaste}
        onClick={() => {
          if (!disabled && !uploading) inputRef.current?.click();
        }}
        onKeyDown={(event) => {
          if ((event.key === "Enter" || event.key === " ") && !disabled && !uploading) {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(event) => {
          if (disabled) return;
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          if (disabled) return;
          event.preventDefault();
          setDragOver(false);
          void addFiles(Array.from(event.dataTransfer.files ?? []));
        }}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          data-testid="attachment-input"
          accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.json,.csv,.log,.zip"
          onChange={(event) => void addFiles(Array.from(event.target.files ?? []))}
        />
        {uploading ? (
          <span className="xs muted" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Icon icon={Loader2} size={14} className="spin" /> 正在上传附件…
          </span>
        ) : (
          <span className="attachment-dropzone-hint">
            <Icon icon={Paperclip} size={14} />
            <span>点击选择、拖拽文件，或粘贴剪贴板截图</span>
            <span className="xs muted">
              （图片 png/jpeg/gif/webp；文件 pdf/txt/md/json/csv/log/zip；单文件 ≤10MB，最多 8 个）
            </span>
          </span>
        )}
      </div>

      {error && (
        <div className="callout danger xs" role="alert" data-testid="attachment-error" style={{ marginTop: 6 }}>
          {error}
        </div>
      )}

      {value.length > 0 && (
        <div className="attachment-pending" data-testid="attachment-pending-list">
          {value.map((meta) => (
            <div className="attachment-pending-item" key={meta.id}>
              {meta.mimeType.startsWith("image/") ? (
                <img
                  className="attachment-thumb"
                  src={previews[meta.id] ?? apiAttachmentPreview(meta)}
                  alt={meta.name}
                  data-testid="attachment-thumb"
                />
              ) : (
                <span className="attachment-file-icon">
                  <Icon icon={ImagePlus} size={16} />
                </span>
              )}
              <span className="attachment-name" title={meta.name}>
                {meta.name}
              </span>
              <span className="xs muted">{formatSize(meta.size)}</span>
              <button
                className="btn ghost xs"
                type="button"
                aria-label={`移除附件 ${meta.name}`}
                data-testid="attachment-remove"
                onClick={() => removeLocal(meta.id)}
              >
                <Icon icon={X} size={14} />
              </button>
            </div>
          ))}
          <div className="xs muted">
            已选 {value.length} 个附件，合计 {formatSize(totalSize)}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 暂存附件在认领前无法通过归属路由读取；图片预览使用本地 blob URL。
 * 这里对暂存元数据不持有文件对象，因此退化为统一占位图标。
 */
function apiAttachmentPreview(meta: AttachmentMeta): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#e5e7eb"/><text x="24" y="28" font-size="10" text-anchor="middle" fill="#6b7280">${meta.mimeType.startsWith("image/") ? "IMG" : "FILE"}</text></svg>`,
  )}`;
}
