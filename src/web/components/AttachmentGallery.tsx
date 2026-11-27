import { ChevronLeft, ChevronRight, Download, FileText, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { AttachmentMeta } from "../../core/types.ts";
import { t } from "../i18n.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { Icon } from "./Icon.tsx";
import { ModalShell } from "./Primitives.tsx";
import { Button } from "./ui/button.tsx";
import { DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "./ui/dialog.tsx";

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
  const language = useUiStore((s) => s.language);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const images = attachments.filter((meta) => meta.mimeType.startsWith("image/"));
  const files = attachments.filter((meta) => !meta.mimeType.startsWith("image/"));
  const activeIndex = previewId === null ? -1 : images.findIndex((meta) => meta.id === previewId);
  const activeImage = activeIndex >= 0 ? images[activeIndex]! : null;
  const prevImage = activeIndex >= 0 ? images[(activeIndex - 1 + images.length) % images.length]! : null;
  const nextImage = activeIndex >= 0 ? images[(activeIndex + 1) % images.length]! : null;

  useEffect(() => {
    if (!activeImage) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setPreviewId(null);
        return;
      }
      if (images.length < 2) return;
      if (event.key === "ArrowLeft" && prevImage) {
        event.preventDefault();
        setPreviewId(prevImage.id);
      } else if (event.key === "ArrowRight" && nextImage) {
        event.preventDefault();
        setPreviewId(nextImage.id);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [activeImage, prevImage, nextImage, images.length]);

  if (attachments.length === 0) {
    if (!emptyText) return null;
    return <div className="xs muted">{emptyText}</div>;
  }

  const showPrev = () => {
    if (prevImage) setPreviewId(prevImage.id);
  };
  const showNext = () => {
    if (nextImage) setPreviewId(nextImage.id);
  };

  return (
    <div className="attachment-gallery" data-testid="attachment-gallery">
      {images.length > 0 && (
        <div className="attachment-grid">
          {images.map((meta) => (
            <figure className="attachment-figure" key={meta.id} data-testid="attachment-image">
              <button
                type="button"
                className="attachment-open"
                data-testid="attachment-open"
                title={`${meta.name} · ${formatSize(meta.size)}`}
                aria-label={t(language, "attachment.openAria", { name: meta.name })}
                onClick={() => setPreviewId(meta.id)}
              >
                <img src={urlFor(meta.id)} alt={meta.name} loading="lazy" />
              </button>
              <figcaption title={meta.name}>
                <span className="attachment-name">{meta.name}</span>
                <span className="xs muted">{formatSize(meta.size)}</span>
              </figcaption>
              {onDelete && (
                <Button
                  className="attachment-delete"
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                  aria-label={t(language, "attachment.deleteAria", { name: meta.name })}
                  onClick={() => onDelete(meta.id)}
                >
                  <Icon icon={Trash2} size={14} />
                </Button>
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
              <Button
                render={<a href={urlFor(meta.id)} download={meta.name} />}
                size="icon-xs"
                variant="ghost"
                aria-label={t(language, "attachment.downloadAria", { name: meta.name })}
              >
                <Icon icon={Download} size={14} />
              </Button>
              {onDelete && (
                <Button
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                  aria-label={t(language, "attachment.deleteAria", { name: meta.name })}
                  onClick={() => onDelete(meta.id)}
                >
                  <Icon icon={Trash2} size={14} />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {activeImage && (
        <ModalShell wide hasExplicitTitle onClose={() => setPreviewId(null)} testId="attachment-lightbox">
          <DialogHeader className="min-w-0">
            <DialogTitle className="attachment-lightbox-title text-base">{activeImage.name}</DialogTitle>
            <DialogDescription data-testid="attachment-lightbox-counter">
              {t(language, "attachment.previewCounter", {
                index: activeIndex + 1,
                total: images.length,
                size: formatSize(activeImage.size),
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="attachment-lightbox-body">
              {images.length > 1 && (
                <Button
                  size="xs"
                  variant="outline"
                  type="button"
                  data-testid="attachment-lightbox-prev"
                  onClick={showPrev}
                >
                  <Icon icon={ChevronLeft} size={14} /> {t(language, "attachment.prev")}
                </Button>
              )}
              <img
                className="attachment-lightbox-image"
                data-testid="attachment-lightbox-image"
                src={urlFor(activeImage.id)}
                alt={activeImage.name}
              />
              {images.length > 1 && (
                <Button
                  size="xs"
                  variant="outline"
                  type="button"
                  data-testid="attachment-lightbox-next"
                  onClick={showNext}
                >
                  {t(language, "attachment.next")} <Icon icon={ChevronRight} size={14} />
                </Button>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" type="button" onClick={() => setPreviewId(null)}>
              <Icon icon={X} size={14} /> {t(language, "common.closeEsc")}
            </Button>
          </DialogFooter>
        </ModalShell>
      )}
    </div>
  );
}
