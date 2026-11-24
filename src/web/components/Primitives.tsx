import React from "react";
import { Lock, MessageSquare } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentAction } from "../../core/types.ts";
import { t, type UiLanguage } from "../i18n.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { Icon } from "./Icon.tsx";
import { Dialog, DialogPopup, DialogTitle } from "./ui/dialog.tsx";
import { ModelRunnerBar } from "./ui/ModelRunnerBar.tsx";

export function UiLanguageSelect({ className = "" }: { className?: string }) {
  const language = useUiStore((s) => s.language);
  const setLanguage = useUiStore((s) => s.setLanguage);
  return (
    <select
      className={`select xs ui-language-select ${className}`.trim()}
      data-testid="ui-language-select"
      aria-label={t(language, "app.languageSwitch")}
      title={t(language, "app.languageSwitch")}
      value={language}
      onChange={(e) => setLanguage(e.target.value as UiLanguage)}
    >
      <option value="zh-CN">简体中文</option>
      <option value="en">English</option>
    </select>
  );
}

export function RunLockNotice({ testId = "run-lock-notice" }: { testId?: string }) {
  const language = useUiStore((s) => s.language);
  return (
    <div className="callout warning xs" data-testid={testId} style={{ marginBottom: 10 }}>
      <Icon icon={Lock} size={14} />
      <span>{t(language, "runLock.notice")}</span>
    </div>
  );
}

export function LiveTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, [startedAt]);

  const elapsedSec = Math.max(0, (now - startedAt) / 1000).toFixed(1);
  return (
    <span className="live-timer xs" data-live-elapsed={startedAt}>
      {elapsedSec}s
    </span>
  );
}

function extractNodeText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractNodeText).join("");
  if (React.isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode };
    return extractNodeText(props.children);
  }
  return "";
}

export function MarkdownView({
  markdown,
  annotatable = false,
  docLabel = "doc",
  onAnnotate,
  className = "md-body",
}: {
  markdown: string;
  annotatable?: boolean;
  docLabel?: string;
  onAnnotate?: (anchor: string) => void;
  className?: string;
}) {
  const language = useUiStore((s) => s.language);
  const normalized = markdown.trim();
  if (!normalized) {
    return (
      <div className={className}>
        <p className="muted">{t(language, "md.empty")}</p>
      </div>
    );
  }

  const renderHeading = (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") => {
    return ({ children }: { children?: React.ReactNode }) => {
      if (!annotatable) return <Tag>{children}</Tag>;
      const rawText = extractNodeText(children).trim().slice(0, 60);
      const anchor = `${docLabel}#${rawText}`;
      return (
        <div className="md-annot-row">
          <Tag>{children}</Tag>
          <button
            className="btn ghost xs md-annot-btn"
            type="button"
            data-action="annotate-anchor"
            data-anchor={anchor}
            title={t(language, "md.annotateTitle")}
            aria-label={t(language, "md.annotateTitle")}
            onClick={() => onAnnotate?.(anchor)}
          >
            <span className="md-annot-icon" data-icon-slot="annotate" aria-hidden="true">
              <Icon icon={MessageSquare} size={14} />
            </span>
            {t(language, "md.annotate")}
          </button>
        </div>
      );
    };
  };

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => (/^(https?:\/\/|\/|#)/i.test(url.trim()) ? url : "")}
        components={{
          h1: renderHeading("h1"),
          h2: renderHeading("h2"),
          h3: renderHeading("h3"),
          h4: renderHeading("h4"),
          h5: renderHeading("h5"),
          h6: renderHeading("h6"),
          a: ({ href, children }) =>
            href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
        }}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
}

export function RunnerSelect({
  stageAction,
  testId,
  includeManualCopy = false,
}: {
  stageAction: AgentAction;
  testId: string;
  includeManualCopy?: boolean;
}) {
  return <ModelRunnerBar stageAction={stageAction} testId={testId} includeManualCopy={includeManualCopy} />;
}

export function ModalShell({
  onClose,
  wide = false,
  testId,
  children,
}: {
  onClose: () => void;
  wide?: boolean;
  testId?: string;
  children: React.ReactNode;
}) {
  const language = useUiStore((s) => s.language);
  return (
    <Dialog
      open
      onOpenChange={(open, eventDetails) => {
        if (open) return;
        if (eventDetails?.reason === "outside-press") {
          const target = eventDetails.event?.target as HTMLElement | null;
          if (target?.closest('[data-slot="toast-viewport"], [data-slot="toast-root"]')) {
            eventDetails.cancel();
            return;
          }
        }
        onClose();
      }}
    >
      <DialogPopup
        bottomStickOnMobile={false}
        className={`modal ${wide ? "modal-wide" : ""}`}
        data-testid={testId}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{t(language, "app.dialogTitle")}</DialogTitle>
        {children}
      </DialogPopup>
    </Dialog>
  );
}
