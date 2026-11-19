import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Layers,
  Sparkles,
  Terminal,
  Wrench,
  Zap,
} from "lucide-react";
import { t, type UiLanguage } from "../i18n.ts";
import { parseConsoleLog, type ConsoleBlock, type ConsoleBlockKind } from "../lib/consoleFormat.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { Icon } from "./Icon.tsx";

export interface ConsoleOutputProps {
  runId: string;
  rawLog: string;
  isRunning?: boolean;
  emptyText?: string;
  language?: UiLanguage;
}

function blockIcon(kind: ConsoleBlockKind, tone: ConsoleBlock["tone"]) {
  switch (kind) {
    case "command_env":
      return Terminal;
    case "prompt_context":
      return FileText;
    case "lifecycle_noise":
      return Layers;
    case "thinking":
      return Sparkles;
    case "tool_call":
      return tone === "danger" ? AlertTriangle : Wrench;
    case "status":
      return tone === "success" ? CheckCircle2 : tone === "warning" ? AlertTriangle : Zap;
    case "error":
      return AlertTriangle;
    case "message":
      return Terminal;
  }
}

function renderInlineCode(text: string) {
  const parts = text.split(/(`[^`\n]+`)/g);
  return parts.map((part, idx) => {
    if (part.length >= 2 && part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={idx} className="console-inline-code">
          {part.slice(1, -1)}
        </code>
      );
    }
    return <Fragment key={idx}>{part}</Fragment>;
  });
}

function renderFormattedMessage(content: string) {
  const segments: Array<{ kind: "text" | "code"; value: string }> = [];
  const fenceRe = /```[A-Za-z0-9_-]*\n([\s\S]*?)```/g;
  let lastIndex = 0;
  for (const match of content.matchAll(fenceRe)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      const before = content.slice(lastIndex, start).replace(/^\n+|\n+$/g, "");
      if (before) segments.push({ kind: "text", value: before });
    }
    segments.push({ kind: "code", value: match[1]!.replace(/\n$/, "") });
    lastIndex = start + match[0].length;
  }
  if (lastIndex < content.length) {
    const tail = content.slice(lastIndex).replace(/^\n+|\n+$/g, "");
    if (tail) segments.push({ kind: "text", value: tail });
  }
  if (segments.length === 0) {
    segments.push({ kind: "text", value: content });
  }

  return (
    <div className="console-formatted-text">
      {segments.map((seg, idx) =>
        seg.kind === "code" ? (
          <pre key={idx} className="console-inline-codeblock">
            <code>{seg.value}</code>
          </pre>
        ) : (
          <div key={idx} className="console-text-segment">
            {renderInlineCode(seg.value)}
          </div>
        ),
      )}
    </div>
  );
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback below
    }
  }
  if (typeof document !== "undefined") {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      document.body.removeChild(ta);
    }
  }
  return false;
}

export function ConsoleOutput({
  runId,
  rawLog,
  isRunning = false,
  emptyText,
  language: languageProp,
}: ConsoleOutputProps) {
  const storeLanguage = useUiStore((s) => s.language);
  const language = languageProp ?? storeLanguage;
  const [viewMode, setViewMode] = useState<"structured" | "raw">("structured");
  const [collapseOverrides, setCollapseOverrides] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);
  const [showJumpBottom, setShowJumpBottom] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const isAtBottomRef = useRef(true);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const blocks = useMemo(() => parseConsoleLog(rawLog, language), [rawLog, language]);

  useEffect(() => {
    setCollapseOverrides({});
    isAtBottomRef.current = true;
    setShowJumpBottom(false);
  }, [runId]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      setShowJumpBottom(false);
    } else {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowJumpBottom(dist > 24 && el.scrollHeight > el.clientHeight + 24);
    }
  }, [rawLog, viewMode, runId]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = dist <= 24;
    isAtBottomRef.current = atBottom;
    setShowJumpBottom(!atBottom && el.scrollHeight > el.clientHeight + 24);
  };

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    isAtBottomRef.current = true;
    setShowJumpBottom(false);
  };

  const isExpanded = (block: ConsoleBlock): boolean =>
    collapseOverrides[block.id] ?? !block.defaultCollapsed;

  const secondaryBlocks = blocks.filter((b) => b.collapsible && b.defaultCollapsed);
  const hasCollapsedSecondary = secondaryBlocks.some((b) => !isExpanded(b));

  const toggleAllSecondary = () => {
    if (hasCollapsedSecondary) {
      const next: Record<string, boolean> = { ...collapseOverrides };
      for (const b of blocks) {
        if (b.collapsible) next[b.id] = true;
      }
      setCollapseOverrides(next);
    } else {
      const next: Record<string, boolean> = { ...collapseOverrides };
      for (const b of secondaryBlocks) {
        next[b.id] = false;
      }
      setCollapseOverrides(next);
    }
  };

  const toggleBlock = (block: ConsoleBlock) => {
    const current = isExpanded(block);
    setCollapseOverrides((prev) => ({
      ...prev,
      [block.id]: !current,
    }));
  };

  const handleCopy = async () => {
    const ok = await copyTextToClipboard(rawLog);
    if (!ok) return;
    setCopied(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied(false), 1800);
  };

  return (
    <>
      <div className="console-controls-bar" data-testid="console-controls-bar">
        <div className="segmented" role="group" aria-label={t(language, "console.modeAria")}>
          <button
            type="button"
            className={viewMode === "structured" ? "active" : ""}
            data-testid="console-mode-structured"
            onClick={() => setViewMode("structured")}
          >
            {t(language, "console.modeStructured")}
          </button>
          <button
            type="button"
            className={viewMode === "raw" ? "active" : ""}
            data-testid="console-mode-raw"
            onClick={() => setViewMode("raw")}
          >
            {t(language, "console.modeRaw")}
          </button>
        </div>

        <div className="console-controls-actions">
          {viewMode === "structured" && secondaryBlocks.length > 0 && (
            <button
              type="button"
              className="btn ghost xs"
              data-testid="console-toggle-secondary-btn"
              onClick={toggleAllSecondary}
            >
              {t(language, hasCollapsedSecondary ? "console.expandAll" : "console.collapseSecondary")}
            </button>
          )}
          <button
            type="button"
            className="btn ghost xs"
            data-testid="console-copy-btn"
            disabled={!rawLog}
            onClick={() => void handleCopy()}
          >
            <Icon icon={copied ? Check : Copy} size={14} />
            {t(language, copied ? "console.copied" : "console.copy")}
          </button>
        </div>
      </div>

      <div className="console-shell">
        <div
          className="console-log"
          data-testid="console-log-output"
          ref={scrollRef}
          onScroll={handleScroll}
        >
          {!rawLog ? (
            <div className="console-empty">
              {isRunning ? (emptyText ?? t(language, "console.waiting")) : t(language, "console.empty")}
            </div>
          ) : viewMode === "raw" ? (
            <pre className="console-raw-pre" data-testid="console-raw-pre">
              {rawLog}
            </pre>
          ) : blocks.length === 0 ? (
            <pre className="console-raw-pre">{rawLog}</pre>
          ) : (
            <div className="console-blocks" data-testid="console-blocks">
              {blocks.map((block) => {
                const Glyph = blockIcon(block.kind, block.tone);

                if (block.kind === "status") {
                  return (
                    <div
                      key={block.id}
                      className={`console-block console-block-status tone-${block.tone}`}
                      data-testid="console-block"
                      data-block-kind={block.kind}
                    >
                      <span className="console-status-icon">
                        <Icon icon={Glyph} size={14} />
                      </span>
                      <span className="console-status-text">{block.content}</span>
                    </div>
                  );
                }

                if (block.kind === "tool_call" && !block.collapsible) {
                  return (
                    <div
                      key={block.id}
                      className={`console-block console-block-tool_call tone-${block.tone}`}
                      data-testid="console-block"
                      data-block-kind={block.kind}
                    >
                      <div className="console-block-head-static">
                        <Icon icon={Glyph} size={14} />
                        <span>{block.title}</span>
                        <span className="console-fold-summary">{block.summary}</span>
                      </div>
                    </div>
                  );
                }

                if (!block.collapsible) {
                  return (
                    <div
                      key={block.id}
                      className={`console-block console-block-${block.kind} tone-${block.tone}`}
                      data-testid="console-block"
                      data-block-kind={block.kind}
                    >
                      {block.kind === "error" && (
                        <div className="console-block-head-static">
                          <Icon icon={Glyph} size={14} />
                          <span>{block.title}</span>
                        </div>
                      )}
                      <div className="console-block-body">
                        {block.kind === "message"
                          ? renderFormattedMessage(block.content)
                          : block.content}
                      </div>
                    </div>
                  );
                }

                const expanded = isExpanded(block);
                return (
                  <div
                    key={block.id}
                    className={`console-block console-block-${block.kind} tone-${block.tone}`}
                    data-testid="console-block"
                    data-block-kind={block.kind}
                  >
                    <button
                      type="button"
                      className="console-fold-btn"
                      aria-expanded={expanded}
                      data-testid={`console-fold-${block.kind}`}
                      onClick={() => toggleBlock(block)}
                    >
                      <span className="console-fold-left">
                        <Icon icon={expanded ? ChevronDown : ChevronRight} size={14} />
                        <Icon icon={Glyph} size={14} />
                        <span className="console-fold-title">{block.title}</span>
                        <span className="console-fold-summary">{block.summary}</span>
                      </span>
                      <span className="console-fold-meta">{t(language, "console.lines", { count: block.linesCount })}</span>
                    </button>
                    {expanded && (
                      <div className="console-block-body" data-testid="console-block-body">
                        {block.content}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {showJumpBottom && (
          <button
            type="button"
            className="btn xs console-jump-bottom"
            data-testid="console-scroll-bottom-btn"
            onClick={jumpToBottom}
          >
            <Icon icon={ArrowDown} size={14} />
            {t(language, "console.jumpBottom")}
          </button>
        )}
      </div>
    </>
  );
}
