import { Download, FileText, Trash2 } from "lucide-react";
import type { AttachmentMeta } from "../../core/types.ts";
import { Icon } from "./Icon.tsx";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export interface AttachmentGalleryProps {
  attachments: AttachmentMeta[];
  urlFor: (attachmentId: string) => string;
  onDelete?: (attachmentId: string) => void;
  emptyText?: string;
}

/** 需求详情与收集箱详情共用的附件展示：图片缩略图 + 文件下载列表。 */
export function AttachmentGallery({ attachments, urlFor, onDelete, emptyText }: AttachmentGalleryProps) {
  if (attachments.length === 0) {
    if (!emptyText) return null;
    return <div className="xs muted">{emptyText}</div>;
  }
  const images = attachments.filter((meta) => meta.mimeType.startsWith("image/"));
  const files = attachments.filter((meta) => !meta.mimeType.startsWith("image/"));

  return (
    <div className="attachment-gallery" data-testid="attachment-gallery">
      {images.length > 0 && (
        <div className="attachment-grid">
          {images.map((meta) => (
            <figure className="attachment-figure" key={meta.id} data-testid="attachment-image">
              <a href={urlFor(meta.id)} target="_blank" rel="noreferrer" title={`${meta.name} · ${formatSize(meta.size)}`}>
                <img src={urlFor(meta.id)} alt={meta.name} loading="lazy" />
              </a>
              <figcaption title={meta.name}>
                <span className="attachment-name">{meta.name}</span>
                <span className="xs muted">{formatSize(meta.size)}</span>
              </figcaption>
              {onDelete && (
                <button
                  className="btn ghost xs attachment-delete"
                  type="button"
                  aria-label={`删除附件 ${meta.name}`}
                  onClick={() => onDelete(meta.id)}
                >
                  <Icon icon={Trash2} size={14} />
                </button>
              )}
            </figure>
          ))}
        </div>
      )}

      {files.length > 0 && (
        <div className="attachment-file-list">
          {files.map((meta) => (
            <div className="attachment-file-row" key={meta.id} data-testid="attachment-file">
              <span className="attachment-file-icon">
                <Icon icon={FileText} size={16} />
              </span>
              <span className="attachment-name" title={meta.name}>
                {meta.name}
              </span>
              <span className="xs muted">{formatSize(meta.size)}</span>
              <a className="btn ghost xs" href={urlFor(meta.id)} download={meta.name} aria-label={`下载附件 ${meta.name}`}>
                <Icon icon={Download} size={14} />
              </a>
              {onDelete && (
                <button
                  className="btn ghost xs"
                  type="button"
                  aria-label={`删除附件 ${meta.name}`}
                  onClick={() => onDelete(meta.id)}
                >
                  <Icon icon={Trash2} size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
