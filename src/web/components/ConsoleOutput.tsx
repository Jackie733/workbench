import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  FileEdit,
  FileText,
  GitBranch,
  Globe,
  Info,
  Layers,
  Loader2,
  Search,
  Sparkles,
  Terminal,
  Wrench,
  Zap,
} from "lucide-react";
import type { RunTraceEvent } from "../../core/types.ts";
import { t, type MessageKey, type UiLanguage } from "../i18n.ts";
import {
  parseConsoleLog,
  reconstructAgyTraceEvents,
  shortenDisplayPath,
  type ConsoleBlock,
  type ConsoleBlockKind,
} from "../lib/consoleFormat.ts";
import { formatDurationHuman, formatPercent, formatTokenCount, formatUsd } from "../state.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { Icon } from "./Icon.tsx";
import { Alert, AlertDescription } from "./ui/alert.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { RadioGroupPrimitive, RadioPrimitive } from "./ui/radio-group.tsx";
import { SegmentedControl, SegmentedControlItem } from "./ui/segmented-control.tsx";

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

interface ToolGroupItem {
  id: string;
  tools: PairedToolCall[];
  totalDurationMs: number;
  countsByTool: Array<{ toolName: string; count: number }>;
}

type StructuredRenderItem =
  | { kind: "event"; event: RunTraceEvent }
  | { kind: "tool_pair"; tool: PairedToolCall }
  | { kind: "tool_group"; group: ToolGroupItem };

function isGroupableReadTool(tool: PairedToolCall): boolean {
  return tool.ended && !tool.isError && (tool.category === "read" || tool.category === "search");
}

function groupConsecutiveReadTools(items: StructuredRenderItem[], filter: TraceFilter): StructuredRenderItem[] {
  if (filter !== "all" && filter !== "tools") return items;
  const grouped: StructuredRenderItem[] = [];
  let streak: PairedToolCall[] = [];

  const flushStreak = () => {
    if (streak.length === 0) return;
    if (streak.length < 3) {
      for (const tool of streak) grouped.push({ kind: "tool_pair", tool });
      streak = [];
      return;
    }
    const counts = new Map<string, number>();
    let totalDurationMs = 0;
    for (const tool of streak) {
      counts.set(tool.toolName, (counts.get(tool.toolName) ?? 0) + 1);
      totalDurationMs += tool.durationMs ?? 0;
    }
    grouped.push({
      kind: "tool_group",
      group: {
        id: `tool-group-${streak[0]!.id}`,
        tools: streak,
        totalDurationMs,
        countsByTool: Array.from(counts.entries()).map(([toolName, count]) => ({ toolName, count })),
      },
    });
    streak = [];
  };

  for (const item of items) {
    if (item.kind === "tool_pair" && isGroupableReadTool(item.tool)) {
      streak.push(item.tool);
      continue;
    }
    flushStreak();
    grouped.push(item);
  }
  flushStreak();
  return grouped;
}

function toolCategoryIcon(category: string) {
  switch (category) {
    case "read":
      return FileText;
    case "search":
      return Search;
    case "write":
      return FileEdit;
    case "bash":
      return Terminal;
    case "wb_cli":
      return Zap;
    case "subagent":
      return GitBranch;
    case "web":
      return Globe;
    case "mcp":
      return Layers;
    default:
      return Wrench;
  }
}

function toolCategoryLabel(language: UiLanguage, category: string): string {
  const known = new Set(["read", "write", "search", "bash", "wb_cli", "mcp", "subagent", "web", "other"]);
  const key = `console.cat.${known.has(category) ? category : "other"}` as MessageKey;
  return t(language, key);
}

function formatToolSummaryCompact(tool: PairedToolCall): string {
  const raw = tool.summary.trim();
  if (!raw) return "";
  if (tool.category === "bash" || tool.category === "wb_cli") return raw;
  return shortenDisplayPath(raw);
}

function formatSmartToolInput(tool: PairedToolCall): { commandPreview?: string; rawInput?: string } {
  const raw = tool.inputText?.trim();
  if (!raw) return {};
  if (raw.startsWith("{")) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const cmd =
        typeof obj.CommandLine === "string"
          ? obj.CommandLine
          : typeof obj.command === "string"
            ? obj.command
            : typeof obj.cmd === "string"
              ? obj.cmd
              : "";
      if ((tool.category === "bash" || tool.category === "wb_cli") && cmd.trim()) {
        return { commandPreview: `$ ${cmd.trim()}` };
      }
      if (tool.category === "read" && typeof (obj.Path ?? obj.file_path ?? obj.AbsolutePath) === "string") {
        const p = shortenDisplayPath(String(obj.Path ?? obj.file_path ?? obj.AbsolutePath));
        const start = typeof obj.StartLine === "number" ? obj.StartLine : undefined;
        const end = typeof obj.EndLine === "number" ? obj.EndLine : undefined;
        const range = start !== undefined ? `#L${start}${end !== undefined ? `-L${end}` : ""}` : "";
        return { commandPreview: `${p}${range}` };
      }
    } catch {
      // Keep raw JSON fallback
    }
  }
  return { rawInput: raw };
}

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

  if (filter === "all") return groupConsecutiveReadTools(items, filter);
  const grouped = items.filter((item) => {
    if (item.kind === "tool_pair") {
      if (filter === "tools") return true;
      if (filter === "errors") return item.tool.isError;
      if (filter === "wb") return Boolean(item.tool.wbCommand || item.tool.category === "wb_cli");
      return false;
    }
    if (item.kind !== "event") return false;
    const tType = item.event.type;
    if (filter === "thinking") return tType === "thinking";
    if (filter === "replies") return tType === "assistant.message" || tType === "run.end";
    if (filter === "errors") return tType === "run.error" || (tType === "run.end" && item.event.status === "failed");
    return false;
  });
  return groupConsecutiveReadTools(grouped, filter);
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

function isMarkdownTableStart(lines: string[], idx: number): boolean {
  const line = lines[idx];
  if (!line || !line.trim().startsWith("|") || idx + 1 >= lines.length) return false;
  return /^\s*\|?\s*[-:]+(?:\s*\|\s*[-:]+)+\s*\|?\s*$/.test(lines[idx + 1]!);
}

function renderFormattedMessage(text: string) {
  const lines = text.split("\n");
  const out: Array<
    | { kind: "heading"; key: string; text: string }
    | { kind: "code"; key: string; lang: string; content: string }
    | { kind: "quote"; key: string; lines: string[] }
    | { kind: "table"; key: string; headers: string[]; rows: string[][] }
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

    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        quoteLines.push(lines[i]!.replace(/^\s*>\s?/, ""));
        i += 1;
      }
      out.push({ kind: "quote", key: `quote-${i}`, lines: quoteLines });
      continue;
    }

    if (isMarkdownTableStart(lines, i)) {
      const splitRow = (rowLine: string) =>
        rowLine
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((c) => c.trim());
      const headers = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) {
        rows.push(splitRow(lines[i]!));
        i += 1;
      }
      out.push({ kind: "table", key: `tbl-${i}`, headers, rows });
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
      !/^\s*>\s?/.test(lines[i]!) &&
      !isMarkdownTableStart(lines, i) &&
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
              {renderInlineCode(seg.text)}
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
        if (seg.kind === "quote") {
          return (
            <blockquote key={seg.key} className="console-msg-quote">
              {seg.lines.map((ql, idx) => (
                <div key={idx}>{renderInlineCode(ql)}</div>
              ))}
            </blockquote>
          );
        }
        if (seg.kind === "table") {
          return (
            <div key={seg.key} className="console-msg-table-wrap">
              <table className="console-msg-table">
                <thead>
                  <tr>
                    {seg.headers.map((h, idx) => (
                      <th key={idx}>{renderInlineCode(h)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {seg.rows.map((r, rIdx) => (
                    <tr key={rIdx}>
                      {r.map((cell, cIdx) => (
                        <td key={cIdx}>{renderInlineCode(cell)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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

function renderInlineCode(text: string, allowBold = true) {
  const pattern = allowBold
    ? /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\((?:file:\/\/\/[^)\s]+|https?:\/\/[^)\s]+)\))/g
    : /(`[^`\n]+`|\[[^\]\n]+\]\((?:file:\/\/\/[^)\s]+|https?:\/\/[^)\s]+)\))/g;
  const parts = text.split(pattern);
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
        if (allowBold && part.startsWith("**") && part.endsWith("**") && part.length >= 4) {
          return <strong key={idx}>{renderInlineCode(part.slice(2, -2), false)}</strong>;
        }
        const linkMatch = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/.exec(part);
        if (linkMatch) {
          const label = linkMatch[1]!;
          const href = linkMatch[2]!;
          if (href.startsWith("file://")) {
            const fsPath = href.replace(/^file:\/\//, "");
            return (
              <span key={idx} className="console-file-ref" title={fsPath}>
                <Icon icon={FileText} size={14} />
                <span>{label}</span>
              </span>
            );
          }
          return (
            <a key={idx} href={href} target="_blank" rel="noopener noreferrer" className="console-link">
              {label}
            </a>
          );
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

  const hasRichRawTrace = Boolean(
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
  const reconstructedAgyTrace = useMemo(
    () => (hasRichRawTrace ? null : reconstructAgyTraceEvents(rawLog, traceEvents)),
    [hasRichRawTrace, rawLog, traceEvents],
  );
  const effectiveTraceEvents = hasRichRawTrace ? traceEvents : reconstructedAgyTrace ?? traceEvents;
  const hasRichTrace = hasRichRawTrace || Boolean(reconstructedAgyTrace && reconstructedAgyTrace.length > 0);
  const hasStructuredTrace = Boolean(
    effectiveTraceEvents &&
      effectiveTraceEvents.length > 0 &&
      (Boolean(reconstructedAgyTrace) || (hasTrace !== false && (hasRichTrace || !rawLog))),
  );
  const traceItems = useMemo(
    () => (hasStructuredTrace && effectiveTraceEvents ? pairTraceEvents(effectiveTraceEvents, traceFilter) : []),
    [hasStructuredTrace, effectiveTraceEvents, traceFilter],
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
    const groups = traceItems.filter((i): i is { kind: "tool_group"; group: ToolGroupItem } => i.kind === "tool_group");
    const anyCollapsed =
      pairs.some((p) => !(collapseOverrides[p.tool.id] ?? p.tool.isError)) ||
      groups.some(
        (g) =>
          !(collapseOverrides[g.group.id] ?? false) ||
          g.group.tools.some((tool) => !(collapseOverrides[tool.id] ?? tool.isError)),
      );
    const next: Record<string, boolean> = { ...collapseOverrides };
    for (const p of pairs) {
      next[p.tool.id] = anyCollapsed;
    }
    for (const g of groups) {
      next[g.group.id] = anyCollapsed;
      for (const tool of g.group.tools) {
        next[tool.id] = anyCollapsed;
      }
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
  const toolPairsInView = traceItems.filter((i) => i.kind === "tool_pair" || i.kind === "tool_group");

  return (
    <>
      <div className="console-controls-bar" data-testid="console-controls-bar">
        <SegmentedControl
          size="sm"
          render={
            <RadioGroupPrimitive
              aria-label={t(language, "console.modeAria")}
              className="flex items-center"
              value={viewMode}
              onValueChange={(next) => next && setViewMode(next as "structured" | "raw")}
            />
          }
        >
          <SegmentedControlItem
            render={<RadioPrimitive.Root value="structured" data-testid="console-mode-structured" />}
          >
            <Icon icon={Layers} size={14} /> {t(language, "console.modeStructured")}
          </SegmentedControlItem>
          <SegmentedControlItem
            render={<RadioPrimitive.Root value="raw" data-testid="console-mode-raw" />}
          >
            <Icon icon={Terminal} size={14} /> {t(language, "console.modeRaw")}
          </SegmentedControlItem>
        </SegmentedControl>

        <div className="console-controls-actions">
          {viewMode === "structured" && hasStructuredTrace && toolPairsInView.length > 0 && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              data-testid="trace-toggle-tools-btn"
              onClick={toggleAllTraceCards}
            >
              <Icon icon={Wrench} size={14} /> {t(language, "console.toggleTools")}
            </Button>
          )}
          {viewMode === "structured" && !hasStructuredTrace && secondaryBlocks.length > 0 && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              data-testid="console-toggle-secondary-btn"
              onClick={toggleAllSecondary}
            >
              <Icon icon={hasCollapsedSecondary ? ChevronRight : ChevronDown} size={14} />{" "}
              {t(language, hasCollapsedSecondary ? "console.expandAll" : "console.collapseSecondary")}
            </Button>
          )}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            data-testid="console-copy-btn"
            disabled={!rawLog && !hasStructuredTrace}
            onClick={() => void handleCopy()}
          >
            <Icon icon={copied ? Check : Copy} size={14} />
            {t(language, copied ? "console.copied" : "console.copy")}
          </Button>
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
        <Alert variant="info" className="console-legacy-notice py-2 text-xs" data-testid="legacy-no-trace-notice">
          <Icon icon={Info} size={14} />
          <AlertDescription className="text-foreground">{t(language, "console.legacyNoTrace")}</AlertDescription>
        </Alert>
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
                  const renderToolCard = (tool: PairedToolCall) => {
                    const expanded = collapseOverrides[tool.id] ?? tool.isError;
                    const toneCls = tool.isError ? "tone-danger" : tool.ended ? "tone-success" : "tone-info";
                    const CatIcon = toolCategoryIcon(tool.category);
                    const compactSummary = formatToolSummaryCompact(tool);
                    const smartInput = formatSmartToolInput(tool);
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
                              <Icon icon={CatIcon} size={14} />
                            )}
                            <span className="console-fold-title">{tool.toolName}</span>
                            <span className="trace-cat-badge">{toolCategoryLabel(language, tool.category)}</span>
                            {tool.wbCommand && <Badge size="sm" variant="info">wb</Badge>}
                            <span className="console-fold-summary" title={tool.summary}>
                              {compactSummary}
                            </span>
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
                                  <span key={fp} className="trace-file-chip" title={fp}>
                                    {shortenDisplayPath(fp)}
                                  </span>
                                ))}
                              </div>
                            )}
                            {smartInput.commandPreview && (
                              <div className="trace-io-section">
                                <div className="trace-io-label">
                                  {t(language, "console.toolInput")}
                                  {tool.inputTruncated && <Badge size="sm" variant="warning">truncated</Badge>}
                                </div>
                                <pre className="trace-tool-pre trace-tool-cmd">{smartInput.commandPreview}</pre>
                              </div>
                            )}
                            {smartInput.rawInput && (
                              <div className="trace-io-section">
                                <div className="trace-io-label">
                                  {t(language, "console.toolInput")}
                                  {tool.inputTruncated && <Badge size="sm" variant="warning">truncated</Badge>}
                                </div>
                                <pre className="trace-tool-pre">{smartInput.rawInput}</pre>
                              </div>
                            )}
                            {tool.outputText && (
                              <div className="trace-io-section">
                                <div className="trace-io-label">
                                  {t(language, "console.toolOutput")}
                                  {tool.outputTruncated && <Badge size="sm" variant="warning">clipped 32KB</Badge>}
                                </div>
                                <pre className={`trace-tool-pre ${tool.isError ? "is-error" : ""}`}>
                                  {tool.outputText}
                                </pre>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  };

                  if (item.kind === "tool_pair") {
                    return renderToolCard(item.tool);
                  }

                  if (item.kind === "tool_group") {
                    const grp = item.group;
                    const expanded = collapseOverrides[grp.id] ?? false;
                    return (
                      <div key={grp.id} className="console-block trace-tool-group" data-testid="trace-tool-group">
                        <button
                          type="button"
                          className="console-fold-btn"
                          aria-expanded={expanded}
                          onClick={() => toggleBlock(grp.id, expanded)}
                        >
                          <span className="console-fold-left">
                            <Icon icon={expanded ? ChevronDown : ChevronRight} size={14} />
                            <Icon icon={Search} size={14} />
                            <span className="console-fold-title">
                              {t(language, "console.toolGroupSummary", { count: grp.tools.length })}
                            </span>
                            <span className="trace-group-badges">
                              {grp.countsByTool.map((c) => (
                                <span key={c.toolName} className="trace-cat-badge">
                                  {c.toolName} ({c.count})
                                </span>
                              ))}
                            </span>
                          </span>
                          <span className="console-fold-meta">
                            {formatDurationHuman(grp.totalDurationMs)}
                          </span>
                        </button>
                        {expanded && (
                          <div className="trace-tool-group-body">
                            {grp.tools.map((tool) => renderToolCard(tool))}
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
                      <Alert key={`cmp-${ev.seq}`} variant="warning" className="trace-compaction-pill py-2 text-xs">
                        <Icon icon={Layers} size={14} />
                        <AlertDescription className="text-foreground">
                          {ev.summary ??
                            t(language, "console.compactionNotice", {
                              turn: ev.turnIndex,
                              mode: ev.mode,
                              reclaimed: ev.reclaimedTokens ?? 0,
                            })}
                        </AlertDescription>
                      </Alert>
                    );
                  }

                  if (ev.type === "trace.truncated") {
                    return (
                      <Alert key={`trunc-${ev.seq}`} variant="info" className="py-2 text-xs">
                        <Icon icon={Info} size={14} />
                        <AlertDescription className="text-foreground">{t(language, "console.traceTruncated")}</AlertDescription>
                      </Alert>
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
                    const agyErrMatch = /^AGY_ERROR:\s*(\{.*\})\s*$/m.exec(ev.text);
                    if (agyErrMatch?.[1]) {
                      try {
                        const errObj = JSON.parse(agyErrMatch[1]) as Record<string, unknown>;
                        const shortErr =
                          typeof errObj.short_error === "string" && errObj.short_error.trim()
                            ? errObj.short_error.trim()
                            : ev.text;
                        return (
                          <div key={`raw-${ev.seq}`} className="console-block console-block-error tone-danger">
                            <div className="console-block-body">{shortErr}</div>
                          </div>
                        );
                      } catch {
                        // fall through
                      }
                    }
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
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="console-jump-bottom"
            data-testid="console-scroll-bottom-btn"
            onClick={jumpToBottom}
          >
            <Icon icon={ArrowDown} size={14} />
            {t(language, "console.jumpBottom")}
          </Button>
        )}
      </div>
    </>
  );
}
