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
  Info,
  Layers,
  Loader2,
  Sparkles,
  Terminal,
  Wrench,
  Zap,
} from "lucide-react";
import type { RunTraceEvent } from "../../core/types.ts";
import { t, type UiLanguage } from "../i18n.ts";
import { parseConsoleLog, type ConsoleBlock, type ConsoleBlockKind } from "../lib/consoleFormat.ts";
import { formatDurationHuman, formatPercent, formatTokenCount, formatUsd } from "../state.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { Icon } from "./Icon.tsx";

export interface ConsoleOutputProps {
  runId: string;
  rawLog: string;
  traceEvents?: RunTraceEvent[];
  hasTrace?: boolean;
  traceHydrated?: boolean;
  isRunning?: boolean;
  emptyText?: string;
  language?: UiLanguage;
  defaultViewMode?: "structured" | "raw";
}

type TraceFilter = "all" | "tools" | "thinking" | "replies" | "errors" | "wb";

interface PairedToolCall {
  id: string;
  seq: number;
  ts: number;
  turnIndex: number;
  callId: string;
  toolName: string;
  category: string;
  summary: string;
  inputText?: string;
  inputTruncated?: boolean;
  wbCommand?: string;
  ended: boolean;
  isError: boolean;
  durationMs?: number;
  outputText?: string;
  outputTruncated?: boolean;
  filesTouched?: string[];
}

type StructuredRenderItem =
  | { kind: "event"; event: RunTraceEvent }
  | { kind: "tool_pair"; tool: PairedToolCall };

function pairTraceEvents(events: RunTraceEvent[], filter: TraceFilter): StructuredRenderItem[] {
  const items: StructuredRenderItem[] = [];
  const toolIndexByCallId = new Map<string, number>();

  for (const ev of events) {
    if (ev.type === "tool.start") {
      const pair: PairedToolCall = {
        id: `tool-${ev.callId}-${ev.seq}`,
        seq: ev.seq,
        ts: ev.ts,
        turnIndex: ev.turnIndex,
        callId: ev.callId,
        toolName: ev.toolName,
        category: ev.category,
        summary: ev.summary,
        inputText: ev.inputText,
        inputTruncated: ev.inputTruncated,
        wbCommand: ev.wbCommand,
        ended: false,
        isError: false,
      };
      toolIndexByCallId.set(ev.callId, items.length);
      items.push({ kind: "tool_pair", tool: pair });
      continue;
    }

    if (ev.type === "tool.end") {
      const existingIdx = toolIndexByCallId.get(ev.callId);
      if (existingIdx !== undefined && items[existingIdx]?.kind === "tool_pair") {
        const prev = items[existingIdx]!.tool;
        items[existingIdx] = {
          kind: "tool_pair",
          tool: {
            ...prev,
            ended: true,
            isError: Boolean(ev.isError),
            durationMs: ev.durationMs ?? Math.max(0, ev.ts - prev.ts),
            outputText: ev.output,
            outputTruncated: ev.outputTruncated,
            filesTouched: ev.filesTouched,
            wbCommand: prev.wbCommand ?? ev.wbCommand,
          },
        };
      } else {
        items.push({
          kind: "tool_pair",
          tool: {
            id: `tool-${ev.callId}-${ev.seq}`,
            seq: ev.seq,
            ts: ev.ts,
            turnIndex: ev.turnIndex,
            callId: ev.callId,
            toolName: ev.toolName,
            category: ev.category,
            summary: ev.summary,
            wbCommand: ev.wbCommand,
            ended: true,
            isError: Boolean(ev.isError),
            durationMs: ev.durationMs,
            outputText: ev.output,
            outputTruncated: ev.outputTruncated,
            filesTouched: ev.filesTouched,
          },
        });
      }
      continue;
    }

    items.push({ kind: "event", event: ev });
  }

  if (filter === "all") return items;
  return items.filter((item) => {
    if (item.kind === "tool_pair") {
      if (filter === "tools") return true;
      if (filter === "errors") return item.tool.isError;
      if (filter === "wb") return Boolean(item.tool.wbCommand || item.tool.category === "wb_cli");
      return false;
    }
    const tType = item.event.type;
    if (filter === "thinking") return tType === "thinking";
    if (filter === "replies") return tType === "assistant.message" || tType === "run.end";
    if (filter === "errors") return tType === "run.error" || (tType === "run.end" && item.event.status === "failed");
    return false;
  });
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

function renderFormattedMessage(text: string) {
  const lines = text.split("\n");
  const out: Array<
    | { kind: "heading"; key: string; text: string }
    | { kind: "code"; key: string; lang: string; content: string }
    | { kind: "list"; key: string; items: string[] }
    | { kind: "text"; key: string; text: string }
  > = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) {
        codeLines.push(lines[i]!);
        i += 1;
      }
      out.push({ kind: "code", key: `code-${i}`, lang, content: codeLines.join("\n") });
      i += 1;
      continue;
    }

    if (/^#{1,4}\s+/.test(line.trim())) {
      out.push({ kind: "heading", key: `h-${i}`, text: line.trim().replace(/^#{1,4}\s+/, "") });
      i += 1;
      continue;
    }

    if (/^\s*(?:[-*]|\d+\.)\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*(?:[-*]|\d+\.)\s+/.test(lines[i]!)) {
        items.push(lines[i]!.trim().replace(/^(?:[-*]|\d+\.)\s+/, ""));
        i += 1;
      }
      out.push({ kind: "list", key: `list-${i}`, items });
      continue;
    }

    const textLines: string[] = [];
    while (
      i < lines.length &&
      !lines[i]!.trim().startsWith("```") &&
      !/^#{1,4}\s+/.test(lines[i]!.trim()) &&
      !/^\s*(?:[-*]|\d+\.)\s+/.test(lines[i]!)
    ) {
      textLines.push(lines[i]!);
      i += 1;
    }
    const joined = textLines.join("\n").trim();
    if (joined) out.push({ kind: "text", key: `txt-${i}`, text: joined });
  }

  return (
    <div className="console-msg-rich">
      {out.map((seg) => {
        if (seg.kind === "heading") {
          return (
            <div key={seg.key} className="console-msg-heading">
              {seg.text}
            </div>
          );
        }
        if (seg.kind === "code") {
          return (
            <pre key={seg.key} className="console-msg-code">
              {seg.lang && <span className="console-msg-code-lang">{seg.lang}</span>}
              <code>{seg.content}</code>
            </pre>
          );
        }
        if (seg.kind === "list") {
          return (
            <ul key={seg.key} className="console-msg-list">
              {seg.items.map((item, idx) => (
                <li key={idx}>{renderInlineCode(item)}</li>
              ))}
            </ul>
          );
        }
        return (
          <div key={seg.key} className="console-msg-para">
            {renderInlineCode(seg.text)}
          </div>
        );
      })}
    </div>
  );
}

function renderInlineCode(text: string) {
  const parts = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g);
  return (
    <>
      {parts.map((part, idx) => {
        if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
          return (
            <code key={idx} className="console-inline-code">
              {part.slice(1, -1)}
            </code>
          );
        }
        if (part.startsWith("**") && part.endsWith("**") && part.length >= 4) {
          return <strong key={idx}>{part.slice(2, -2)}</strong>;
        }
        return <Fragment key={idx}>{part}</Fragment>;
      })}
    </>
  );
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text || typeof navigator === "undefined" || !navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function ConsoleOutput({
  runId,
  rawLog,
  traceEvents,
  hasTrace,
  traceHydrated = false,
  isRunning = false,
  emptyText,
  language: languageProp,
  defaultViewMode = "structured",
}: ConsoleOutputProps) {
  const storeLanguage = useUiStore((s) => s.language);
  const language = languageProp ?? storeLanguage;
  const [viewMode, setViewMode] = useState<"structured" | "raw">(defaultViewMode);
  const [traceFilter, setTraceFilter] = useState<TraceFilter>("all");
  const [collapseOverrides, setCollapseOverrides] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);
  const [showJumpBottom, setShowJumpBottom] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const isAtBottomRef = useRef(true);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasRichTrace = Boolean(
    traceEvents?.some(
      (ev) =>
        ev.type === "thinking" ||
        ev.type === "tool.start" ||
        ev.type === "tool.end" ||
        ev.type === "assistant.message" ||
        ev.type === "turn.end" ||
        ev.type === "context.compaction",
    ),
  );
  const hasStructuredTrace = Boolean(
    traceEvents && traceEvents.length > 0 && hasTrace !== false && (hasRichTrace || !rawLog),
  );
  const traceItems = useMemo(
    () => (hasStructuredTrace && traceEvents ? pairTraceEvents(traceEvents, traceFilter) : []),
    [hasStructuredTrace, traceEvents, traceFilter],
  );
  const blocks = useMemo(() => parseConsoleLog(rawLog, language), [rawLog, language]);

  useEffect(() => {
    setCollapseOverrides({});
    setTraceFilter("all");
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
  }, [rawLog, traceEvents?.length, viewMode, traceFilter, runId]);

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

  const toggleAllTraceCards = () => {
    const pairs = traceItems.filter((i): i is { kind: "tool_pair"; tool: PairedToolCall } => i.kind === "tool_pair");
    const anyCollapsed = pairs.some((p) => !(collapseOverrides[p.tool.id] ?? p.tool.isError));
    const next: Record<string, boolean> = { ...collapseOverrides };
    for (const p of pairs) {
      next[p.tool.id] = anyCollapsed;
    }
    setCollapseOverrides(next);
  };

  const toggleBlock = (id: string, current: boolean) => {
    setCollapseOverrides((prev) => ({ ...prev, [id]: !current }));
  };

  const handleCopy = async () => {
    const textToCopy = rawLog || (traceEvents ? JSON.stringify(traceEvents, null, 2) : "");
    const ok = await copyTextToClipboard(textToCopy);
    if (!ok) return;
    setCopied(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied(false), 1800);
  };

  const isLegacyWithoutTrace = traceHydrated && hasTrace === false && !hasStructuredTrace;
  const toolPairsInView = traceItems.filter((i) => i.kind === "tool_pair");

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
            <Icon icon={Layers} size={14} /> {t(language, "console.modeStructured")}
          </button>
          <button
            type="button"
            className={viewMode === "raw" ? "active" : ""}
            data-testid="console-mode-raw"
            onClick={() => setViewMode("raw")}
          >
            <Icon icon={Terminal} size={14} /> {t(language, "console.modeRaw")}
          </button>
        </div>

        <div className="console-controls-actions">
          {viewMode === "structured" && hasStructuredTrace && toolPairsInView.length > 0 && (
            <button
              type="button"
              className="btn ghost xs"
              data-testid="trace-toggle-tools-btn"
              onClick={toggleAllTraceCards}
            >
              <Icon icon={Wrench} size={14} /> {t(language, "console.toggleTools")}
            </button>
          )}
          {viewMode === "structured" && !hasStructuredTrace && secondaryBlocks.length > 0 && (
            <button
              type="button"
              className="btn ghost xs"
              data-testid="console-toggle-secondary-btn"
              onClick={toggleAllSecondary}
            >
              <Icon icon={hasCollapsedSecondary ? ChevronRight : ChevronDown} size={14} />{" "}
              {t(language, hasCollapsedSecondary ? "console.expandAll" : "console.collapseSecondary")}
            </button>
          )}
          <button
            type="button"
            className="btn ghost xs"
            data-testid="console-copy-btn"
            disabled={!rawLog && !hasStructuredTrace}
            onClick={() => void handleCopy()}
          >
            <Icon icon={copied ? Check : Copy} size={14} />
            {t(language, copied ? "console.copied" : "console.copy")}
          </button>
        </div>
      </div>

      {viewMode === "structured" && hasStructuredTrace && (
        <div className="trace-filter-bar" data-testid="trace-filter-bar">
          {(["all", "tools", "thinking", "replies", "errors", "wb"] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={`trace-filter-pill ${traceFilter === f ? "active" : ""}`}
              data-testid={`trace-filter-${f}`}
              onClick={() => setTraceFilter(f)}
            >
              {t(language, `console.filter.${f}`)}
            </button>
          ))}
        </div>
      )}

      {isLegacyWithoutTrace && rawLog && (
        <div className="callout info xs console-legacy-notice" data-testid="legacy-no-trace-notice">
          <Icon icon={Info} size={14} /> {t(language, "console.legacyNoTrace")}
        </div>
      )}

      <div className="console-shell">
        <div
          className="console-log"
          data-testid="console-log-output"
          ref={scrollRef}
          onScroll={handleScroll}
        >
          {viewMode === "raw" ? (
            !rawLog ? (
              <div className="console-empty">
                {isRunning ? (emptyText ?? t(language, "console.waiting")) : t(language, "console.empty")}
              </div>
            ) : (
              <pre className="console-raw-pre" data-testid="console-raw-pre">
                {rawLog}
              </pre>
            )
          ) : hasStructuredTrace ? (
            <div className="console-blocks trace-event-list" data-testid="trace-event-list">
              {traceItems.length === 0 ? (
                <div className="console-empty">{t(language, "console.filterEmpty")}</div>
              ) : (
                traceItems.map((item) => {
                  if (item.kind === "tool_pair") {
                    const tool = item.tool;
                    const expanded = collapseOverrides[tool.id] ?? tool.isError;
                    const toneCls = tool.isError ? "tone-danger" : tool.ended ? "tone-success" : "tone-info";
                    return (
                      <div
                        key={tool.id}
                        className={`console-block trace-tool-card ${toneCls}`}
                        data-testid="trace-tool-card"
                        data-tool-name={tool.toolName}
                      >
                        <button
                          type="button"
                          className="console-fold-btn"
                          aria-expanded={expanded}
                          onClick={() => toggleBlock(tool.id, expanded)}
                        >
                          <span className="console-fold-left">
                            <Icon icon={expanded ? ChevronDown : ChevronRight} size={14} />
                            {!tool.ended && isRunning ? (
                              <Icon icon={Loader2} size={14} className="spin" />
                            ) : (
                              <Icon icon={Wrench} size={14} />
                            )}
                            <span className="console-fold-title">{tool.toolName}</span>
                            <span className="trace-cat-badge">{tool.category}</span>
                            {tool.wbCommand && <span className="badge info xs">wb</span>}
                            <span className="console-fold-summary">{tool.summary}</span>
                          </span>
                          <span className="console-fold-meta">
                            {tool.isError
                              ? t(language, "console.toolError")
                              : tool.ended
                                ? formatDurationHuman(tool.durationMs ?? 0)
                                : t(language, "console.toolRunning")}
                          </span>
                        </button>
                        {expanded && (
                          <div className="trace-tool-body" data-testid="trace-tool-body">
                            {tool.filesTouched && tool.filesTouched.length > 0 && (
                              <div className="trace-files-row">
                                {tool.filesTouched.map((fp) => (
                                  <span key={fp} className="trace-file-chip">
                                    {fp}
                                  </span>
                                ))}
                              </div>
                            )}
                            {tool.inputText && (
                              <div className="trace-io-section">
                                <div className="trace-io-label">
                                  {t(language, "console.toolInput")}
                                  {tool.inputTruncated && <span className="badge warning xs">truncated</span>}
                                </div>
                                <pre className="trace-tool-pre">{tool.inputText}</pre>
                              </div>
                            )}
                            {tool.outputText && (
                              <div className="trace-io-section">
                                <div className="trace-io-label">
                                  {t(language, "console.toolOutput")}
                                  {tool.outputTruncated && <span className="badge warning xs">clipped 32KB</span>}
                                </div>
                                <pre className="trace-tool-pre">{tool.outputText}</pre>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  }

                  const ev = item.event;
                  if (ev.type === "run.init") {
                    return (
                      <div key={`ev-${ev.seq}`} className="trace-meta-pill" data-testid="trace-run-init">
                        <Icon icon={Zap} size={14} />
                        <span>
                          <strong>{ev.harness}</strong>/{ev.model}
                          {ev.reasoningEffort ? ` (${ev.reasoningEffort})` : ""} · {ev.quotaPool} ({ev.billingMode}) ·{" "}
                          {ev.handoffMode} · {ev.dispatchReason}
                        </span>
                      </div>
                    );
                  }

                  if (ev.type === "handoff.snapshot") {
                    const collapsed = collapseOverrides[`handoff-${ev.seq}`] ?? true;
                    return (
                      <div key={`ev-${ev.seq}`} className="console-block console-block-prompt_context">
                        <button
                          type="button"
                          className="console-fold-btn"
                          onClick={() => toggleBlock(`handoff-${ev.seq}`, !collapsed)}
                        >
                          <span className="console-fold-left">
                            <Icon icon={collapsed ? ChevronRight : ChevronDown} size={14} />
                            <Icon icon={FileText} size={14} />
                            <span className="console-fold-title">{t(language, "console.handoffSnapshot")}</span>
                            <span className="console-fold-summary">
                              handoff ~{formatTokenCount(ev.handoffEstTokens)} tok · prompt ~
                              {formatTokenCount(ev.promptEstTokens)} tok
                              {ev.truncatedSections.length > 0 ? ` · trimmed: ${ev.truncatedSections.join(", ")}` : ""}
                            </span>
                          </span>
                        </button>
                        {!collapsed && (
                          <div className="trace-tool-body">
                            {ev.sections.map((sec) => (
                              <div key={sec.key} className="trace-section-row">
                                <span>{sec.label}</span>
                                <span className="muted">
                                  ~{formatTokenCount(sec.estTokens)} tok ({sec.finalBytes}B)
                                  {sec.truncated ? " [trimmed]" : ""}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  }

                  if (ev.type === "thinking") {
                    const key = `think-${ev.seq}`;
                    const expanded = collapseOverrides[key] ?? false;
                    return (
                      <div key={key} className="console-block console-block-thinking">
                        <button
                          type="button"
                          className="console-fold-btn"
                          onClick={() => toggleBlock(key, expanded)}
                        >
                          <span className="console-fold-left">
                            <Icon icon={expanded ? ChevronDown : ChevronRight} size={14} />
                            <Icon icon={Sparkles} size={14} />
                            <span className="console-fold-title">{t(language, "console.thinking")}</span>
                            <span className="console-fold-summary">{ev.text.slice(0, 100)}</span>
                          </span>
                        </button>
                        {expanded && (
                          <div className="console-block-body trace-thinking-body">{ev.text}</div>
                        )}
                      </div>
                    );
                  }

                  if (ev.type === "assistant.message") {
                    return (
                      <div key={`msg-${ev.seq}`} className="console-block console-block-message">
                        <div className="console-block-body">{renderFormattedMessage(ev.text)}</div>
                      </div>
                    );
                  }

                  if (ev.type === "turn.end") {
                    const cachePct =
                      ev.usage && ev.usage.inputTokens > 0
                        ? formatPercent(ev.usage.cacheReadTokens / ev.usage.inputTokens)
                        : "0%";
                    return (
                      <div key={`turn-${ev.seq}`} className="trace-turn-divider" data-testid="trace-turn-end">
                        <span>Turn #{ev.turnIndex}</span>
                        {ev.usage && (
                          <span>
                            {formatTokenCount(ev.usage.totalTokens)} tok (in {formatTokenCount(ev.usage.inputTokens)} · out{" "}
                            {formatTokenCount(ev.usage.outputTokens)} · cache {cachePct})
                          </span>
                        )}
                        {ev.contextTokens ? <span>ctx {formatTokenCount(ev.contextTokens)}</span> : null}
                        {typeof ev.costUsd === "number" && ev.costUsd > 0 ? <span>{formatUsd(ev.costUsd)}</span> : null}
                      </div>
                    );
                  }

                  if (ev.type === "context.compaction") {
                    return (
                      <div key={`cmp-${ev.seq}`} className="callout warning xs trace-compaction-pill">
                        <Icon icon={Layers} size={14} />{" "}
                        {ev.summary ??
                          t(language, "console.compactionNotice", {
                            turn: ev.turnIndex,
                            mode: ev.mode,
                            reclaimed: ev.reclaimedTokens ?? 0,
                          })}
                      </div>
                    );
                  }

                  if (ev.type === "trace.truncated") {
                    return (
                      <div key={`trunc-${ev.seq}`} className="callout info xs">
                        <Icon icon={Info} size={14} /> {t(language, "console.traceTruncated")}
                      </div>
                    );
                  }

                  if (ev.type === "run.error") {
                    return (
                      <div key={`err-${ev.seq}`} className="console-block console-block-error tone-danger">
                        <div className="console-block-body">{ev.message}</div>
                      </div>
                    );
                  }

                  if (ev.type === "run.end") {
                    return (
                      <div
                        key={`end-${ev.seq}`}
                        className={`console-block console-block-status tone-${ev.status === "succeeded" ? "success" : ev.status === "cancelled" ? "neutral" : "danger"}`}
                        data-testid="trace-run-end"
                      >
                        <span className="console-status-icon">
                          <Icon icon={ev.status === "succeeded" ? CheckCircle2 : AlertTriangle} size={14} />
                        </span>
                        <span className="console-status-text">
                          {ev.status} · {formatDurationHuman(ev.durationMs)} · {ev.turnsCount} turns · {ev.toolCallsCount}{" "}
                          tools · {formatUsd(ev.cost?.equivalentCostUsd ?? 0)}
                        </span>
                      </div>
                    );
                  }

                  if (ev.type === "raw.line") {
                    return (
                      <div
                        key={`raw-${ev.seq}`}
                        className={`trace-raw-line ${ev.stream === "stderr" ? "is-stderr" : ""}`}
                      >
                        {ev.text}
                      </div>
                    );
                  }

                  return null;
                })
              )}
            </div>
          ) : !rawLog ? (
            <div className="console-empty">
              {isRunning ? (emptyText ?? t(language, "console.waiting")) : t(language, "console.empty")}
            </div>
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
                      onClick={() => toggleBlock(block.id, expanded)}
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
