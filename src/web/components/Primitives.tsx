import React from "react";
import { Languages, Lock, MessageSquare } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentAction, RequirementTier } from "../../core/types.ts";
import { t, type UiLanguage } from "../i18n.ts";
import { cn } from "../lib/utils.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { Icon } from "./Icon.tsx";
import { Alert, AlertDescription } from "./ui/alert.tsx";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogPopup, DialogTitle } from "./ui/dialog.tsx";
import { ModelRunnerBar } from "./ui/ModelRunnerBar.tsx";
import { Select, SelectItem, SelectPopup, SelectTrigger, SimpleSelect } from "./ui/select.tsx";

export function UiLanguageSelect({ className = "", iconOnly = false }: { className?: string; iconOnly?: boolean }) {
  const language = useUiStore((s) => s.language);
  const setLanguage = useUiStore((s) => s.setLanguage);
  const options = [
    { value: "zh-CN", label: "简体中文" },
    { value: "en", label: "English" },
  ];
  if (iconOnly) {
    return (
      <Select
        items={options}
        value={language}
        onValueChange={(next) => {
          if (next === null || next === undefined) return;
          setLanguage(String(next) as UiLanguage);
        }}
      >
        <SelectTrigger
          aria-label={t(language, "app.languageSwitch")}
          className={cn(
            "h-7 min-h-7 w-7 min-w-7 justify-center gap-0 rounded-md border-transparent bg-transparent px-0 shadow-none before:hidden hover:bg-accent data-pressed:bg-accent data-popup-open:bg-accent dark:bg-transparent sm:h-6 sm:min-h-6 sm:w-6 sm:min-w-6 [&_[data-slot=select-icon]]:hidden",
            className,
          )}
          data-testid="ui-language-select"
          data-value={language}
          size="sm"
          title={t(language, "app.languageSwitch")}
        >
          <Icon icon={Languages} size={14} />
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    );
  }
  return (
    <SimpleSelect
      aria-label={t(language, "app.languageSwitch")}
      className={cn("ui-language-select w-auto min-w-[96px]", className)}
      data-testid="ui-language-select"
      options={options}
      size="sm"
      title={t(language, "app.languageSwitch")}
      value={language}
      onValueChange={(next) => setLanguage(next as UiLanguage)}
    />
  );
}

export function RunLockNotice({ testId = "run-lock-notice" }: { testId?: string }) {
  const language = useUiStore((s) => s.language);
  return (
    <Alert variant="warning" className="mb-2.5 text-xs" data-testid={testId}>
      <Icon icon={Lock} size={14} />
      <AlertDescription className="text-foreground">{t(language, "runLock.notice")}</AlertDescription>
    </Alert>
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
  annotationCounts,
  className = "md-body",
}: {
  markdown: string;
  annotatable?: boolean;
  docLabel?: string;
  onAnnotate?: (anchor: string) => void;
  annotationCounts?: Record<string, number>;
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
      const count = annotationCounts?.[anchor] ?? 0;
      return (
        <div className="md-annot-row" data-anchor-target={anchor}>
          <Tag>{children}</Tag>
          <Button
            className={`md-annot-btn ${count > 0 ? "has-count" : ""}`}
            size="xs"
            type="button"
            variant="ghost"
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
            {count > 0 && (
              <span className="md-annot-count" data-testid="anchor-annot-count">
                {count}
              </span>
            )}
          </Button>
        </div>
      );
    };
  };

  return (
    <div
      className={className}
      data-annotatable-doc={annotatable ? docLabel : undefined}
      data-anchor-target={annotatable ? docLabel : undefined}
    >
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
  tier = "standard",
}: {
  stageAction: AgentAction;
  testId: string;
  tier?: RequirementTier;
}) {
  return <ModelRunnerBar stageAction={stageAction} testId={testId} tier={tier} />;
}

export function ModalShell({
  onClose,
  wide = false,
  testId,
  className,
  showCloseButton = true,
  hasExplicitTitle = false,
  children,
}: {
  onClose: () => void;
  wide?: boolean;
  testId?: string;
  className?: string;
  showCloseButton?: boolean;
  hasExplicitTitle?: boolean;
  children: React.ReactNode;
}) {
  const language = useUiStore((s) => s.language);
  return (
    <Dialog
      modal={false}
      disablePointerDismissal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup
        bottomStickOnMobile={false}
        className={cn(wide ? "sm:max-w-3xl" : "sm:max-w-xl", className)}
        data-testid={testId}
        onBackdropClick={onClose}
        showCloseButton={showCloseButton}
      >
        {!hasExplicitTitle && <DialogTitle className="sr-only">{t(language, "app.dialogTitle")}</DialogTitle>}
        {children}
      </DialogPopup>
    </Dialog>
  );
}
