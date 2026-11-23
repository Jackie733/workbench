import { QueryClientContext } from "@tanstack/react-query";
import { diffLines } from "diff";
import {
  Activity,
  ArrowRight,
  Check,
  CircleOff,
  Clock,
  Cpu,
  Eye,
  FileEdit,
  FileText,
  GitBranch,
  Layers,
  Lightbulb,
  Loader2,
  Search,
  ShieldCheck,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { useContext, useEffect, useMemo, useState } from "react";
import type {
  AgentRunRecord,
  HandoffSectionMetric,
  RequirementDetail,
  RunContextSnapshot,
  RunTraceEvent,
  TimelineEvent,
} from "../../core/types.ts";
import { formatAgentActionLabel, formatAgentStatusLabel, t, type MessageKey, type UiLanguage } from "../i18n.ts";
import { parseConsoleLog, stripAnsi } from "../lib/consoleFormat.ts";
import {
  hydrateRunLog,
  hydrateRunTrace,
  openHandoff,
  openRunConsole,
  useRequirementRunsQuery,
  useRunContextQuery,
} from "../queries.ts";
import {
  AGENT_RUN_TONE,
  enrichRunForDisplay,
  formatBytes,
  formatDateTime,
  formatDurationHuman,
  formatPercent,
  formatTokenCount,
  formatUsd,
} from "../state.ts";
import { useStreamStore } from "../stores/streamStore.ts";
import { useUiStore } from "../stores/uiStore.ts";
import {
  CompositionBar,
  ContextGrowthChart,
  DonutRingChart,
  StackedBarChart,
  StepPayloadChart,
  type ContextTurnPoint,
  type DonutSegment,
  type StepPayloadPoint,
} from "./Charts.tsx";
import { Icon } from "./Icon.tsx";
import { MarkdownView } from "./Primitives.tsx";

type InspectorTab = "usage" | "activity" | "context";
type TimelineFilter = "all" | "agent" | "review" | "verify" | "system";
type ContextSubView = "diff" | "handoff" | "prompt";
type FileFilter = "all" | "read" | "write" | "search";
type CommandFilter = "all" | "edits" | "wb" | "errors";

type ContextCategoryKey = "system" | "handoff" | "files" | "commands" | "thinking" | "reply";

interface ContextCategorySlice {
  key: ContextCategoryKey;
  label: string;
  color: string;
  bytes: number;
  tokens: number;
  count: number;
}

interface FileActivityItem {
  path: string;
  reads: number;
  writes: number;
  searches: number;
  total: number;
}

interface ToolDistItem {
  name: string;
  count: number;
  errors: number;
}

interface CommandExecItem {
  id: string;
  step: number;
  toolName: string;
  summary: string;
  category: "edit" | "file" | "search" | "command";
  isWb: boolean;
  isError: boolean;
  durationMs?: number;
  linesCount: number;
  content: string;
}

function approxTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk++;
    }
  }
  return Math.max(1, Math.ceil(cjk * 0.72 + (text.length - cjk) * 0.26));
}

const textEncoder = new TextEncoder();
function byteLen(text: string): number {
  return text ? textEncoder.encode(text).length : 0;
}

function classifyShellProgram(cmd: string): string {
  const cleaned = cmd.trim().replace(/^[A-Z0-9_]+=\S+\s+/g, "");
  const first = cleaned.split(/[\s|;&]+/)[0] ?? "bash";
  return first.replace(/^.*\//, "").slice(0, 24) || "bash";
}

function extractPathsFromShellCmd(cmd: string): Array<{ path: string; op: "read" | "search" }> {
  const out: Array<{ path: string; op: "read" | "search" }> = [];
  const trimmed = cmd.trim();
  const op: "read" | "search" = /\b(grep|rg|find)\b/.test(trimmed) ? "search" : "read";
  const matches = trimmed.matchAll(/(?:^|\s)((?:\.{0,2}\/|src\/|tests\/|\.workbench\/)[A-Za-z0-9_./-]+\.[A-Za-z0-9_-]+)/g);
  for (const m of matches) {
    const p = m[1]!;
    if (!out.some((x) => x.path === p)) out.push({ path: p, op });
  }
  return out.slice(0, 6);
}

function categoryIcon(key: ContextCategoryKey) {
  switch (key) {
    case "system":
      return ShieldCheck;
    case "handoff":
      return FileText;
    case "files":
      return Search;
    case "commands":
      return Terminal;
    case "thinking":
      return Lightbulb;
    case "reply":
      return FileEdit;
  }
}

const CONTEXT_CATEGORY_COLORS: Record<ContextCategoryKey, string> = {
  system: "#6366f1",
  handoff: "#06b6d4",
  files: "#10b981",
  commands: "#f59e0b",
  thinking: "#8b5cf6",
  reply: "#ec4899",
};

function handoffModeLabel(language: UiLanguage, mode?: AgentRunRecord["handoffMode"]): string {
  if (mode === "native_resume") return t(language, "audit.handoff.nativeResume");
  if (mode === "fresh_handoff") return t(language, "audit.handoff.freshHandoff");
  return t(language, "audit.handoff.firstRun");
}

function timelineCategory(ev: TimelineEvent): TimelineFilter {
  if (ev.kind.startsWith("review_")) return "review";
  if (ev.kind.startsWith("verification_")) return "verify";
  if (ev.kind === "agent_run_started" || ev.kind === "agent_run_finished" || ev.kind === "agent_handoff" || ev.actor === "agent") {
    return "agent";
  }
  return "system";
}

function RunInspectorSection({
  d,
  reqId,
  runs,
  inspectedRun,
}: {
  d: RequirementDetail;
  reqId: string;
  runs: AgentRunRecord[];
  inspectedRun: AgentRunRecord;
}) {
  const language = useUiStore((s) => s.language);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const [subTab, setSubTab] = useState<InspectorTab>("usage");
  const [chartMode, setChartMode] = useState<"area" | "bars">("area");
  const [contextView, setContextView] = useState<ContextSubView>("handoff");
  const [fileFilter, setFileFilter] = useState<FileFilter>("all");
  const [cmdFilter, setCmdFilter] = useState<CommandFilter>("all");
  const [expandedCmdIds, setExpandedCmdIds] = useState<Record<string, boolean>>({});

  const rawLog = useStreamStore((s) => s.liveRunLogs[inspectedRun.id] ?? "");
  const isLogHydrated = useStreamStore((s) => Boolean(s.logHydrated[inspectedRun.id]));
  const traceState = useStreamStore((s) => s.runTraces[inspectedRun.id]);

  const { data: ctxData, isLoading: ctxLoading } = useRunContextQuery(
    activeProjectId,
    reqId,
    inspectedRun.id,
    true,
  );
  const parentRun = inspectedRun.parentRunId ? runs.find((r) => r.id === inspectedRun.parentRunId) ?? null : null;
  const { data: parentCtxData } = useRunContextQuery(
    activeProjectId,
    reqId,
    parentRun?.id ?? null,
    subTab === "context" && Boolean(parentRun?.id) && contextView === "diff",
  );

  useEffect(() => {
    if (!isLogHydrated) {
      void hydrateRunLog(reqId, inspectedRun.id, false);
    }
    if (!traceState?.hydrated) {
      void hydrateRunTrace(reqId, inspectedRun.id, false);
    }
  }, [reqId, inspectedRun.id, isLogHydrated, traceState?.hydrated]);

  const analytics = useMemo(() => {
    const events = traceState?.events ?? [];
    const compactions: Array<{ turnIndex: number; mode: string; reclaimedTokens?: number }> = [];
    const realTurns: ContextTurnPoint[] = [];
    const toolsByTurn = new Map<number, string[]>();
    const logSteps: StepPayloadPoint[] = [];
    const fileMap = new Map<string, FileActivityItem>();
    const toolMap = new Map<string, ToolDistItem>();
    const cmdList: CommandExecItem[] = [];

    const bumpFile = (filePath: string, kind: "read" | "write" | "search") => {
      const cleanPath = filePath.trim().replace(/[`,;)]+$/, "");
      if (!cleanPath || cleanPath.length > 220) return;
      const cur = fileMap.get(cleanPath) ?? { path: cleanPath, reads: 0, writes: 0, searches: 0, total: 0 };
      if (kind === "write") cur.writes++;
      else if (kind === "search") cur.searches++;
      else cur.reads++;
      cur.total++;
      fileMap.set(cleanPath, cur);
    };
    const bumpTool = (name: string, isErr = false) => {
      const key = name || "tool";
      const cur = toolMap.get(key) ?? { name: key, count: 0, errors: 0 };
      cur.count++;
      if (isErr) cur.errors++;
      toolMap.set(key, cur);
    };

    const handoffSeed = ctxData?.context?.handoffMarkdown || d.handoffMarkdown || d.designMarkdown || d.specMarkdown || "";
    const weights: Record<ContextCategoryKey, { bytes: number; tokens: number; count: number }> = {
      system: { bytes: 0, tokens: 0, count: 0 },
      handoff: {
        bytes: ctxData?.context?.handoffTotalBytes ?? byteLen(handoffSeed),
        tokens: ctxData?.context?.handoffEstTokens ?? approxTokens(handoffSeed),
        count: ctxData?.context?.sections?.length ?? (handoffSeed ? 1 : 0),
      },
      files: { bytes: 0, tokens: 0, count: 0 },
      commands: { bytes: 0, tokens: 0, count: 0 },
      thinking: { bytes: 0, tokens: 0, count: 0 },
      reply: { bytes: 0, tokens: 0, count: 0 },
    };

    const hasTraceEvents = events.some(
      (ev) => ev.type === "tool.start" || ev.type === "turn.end" || ev.type === "assistant.message",
    );
    if (hasTraceEvents) {
      const starts = new Map<string, Extract<RunTraceEvent, { type: "tool.start" }>>();
      let stepSeq = 0;
      for (const ev of events) {
        if (ev.type === "turn.end") {
          const turnUsage = ev.usage;
          const ctx = ev.contextTokens ?? 0;
          const turnTools = toolsByTurn.get(ev.turnIndex);
          if (ctx > 0) {
            realTurns.push({
              turnIndex: ev.turnIndex,
              contextTokens: ctx,
              cacheReadTokens: turnUsage?.cacheReadTokens,
              uncachedInputTokens: turnUsage
                ? turnUsage.uncachedInputTokens + (turnUsage.cacheWriteTokens ?? 0)
                : undefined,
              outputTokens: turnUsage?.outputTokens,
              reasoningTokens: turnUsage?.reasoningTokens,
              durationMs: ev.durationMs,
              toolsSummary: turnTools ? turnTools.slice(0, 4).join(", ") + (turnTools.length > 4 ? ` +${turnTools.length - 4}` : "") : undefined,
            });
          }
        } else if (ev.type === "context.compaction") {
          compactions.push({ turnIndex: ev.turnIndex, mode: ev.mode, reclaimedTokens: ev.reclaimedTokens });
        } else if (ev.type === "thinking") {
          weights.thinking.bytes += byteLen(ev.text);
          weights.thinking.tokens += approxTokens(ev.text);
          weights.thinking.count++;
        } else if (ev.type === "assistant.message") {
          weights.reply.bytes += byteLen(ev.text);
          weights.reply.tokens += approxTokens(ev.text);
          weights.reply.count++;
        } else if (ev.type === "tool.start") {
          starts.set(ev.callId, ev);
          const list = toolsByTurn.get(ev.turnIndex) ?? [];
          list.push(ev.toolName);
          toolsByTurn.set(ev.turnIndex, list);
          if (ev.filesTouched) {
            const k = /edit|write|patch/i.test(ev.toolName) ? "write" : /grep|glob|search/i.test(ev.toolName) ? "search" : "read";
            for (const f of ev.filesTouched) bumpFile(f, k);
          }
        } else if (ev.type === "tool.end") {
          stepSeq++;
          const st = starts.get(ev.callId);
          const name = ev.toolName || st?.toolName || "tool";
          const summary = ev.summary || st?.summary || "";
          const outText = ev.output ?? "";
          const inText = st?.inputText ?? "";
          const payloadText = inText + outText || summary;
          const isErr = Boolean(ev.isError);
          bumpTool(name, isErr);
          if (ev.filesTouched) {
            const k = /edit|write|patch/i.test(name) ? "write" : /grep|glob|search/i.test(name) ? "search" : "read";
            for (const f of ev.filesTouched) bumpFile(f, k);
          }
          const isEdit = /edit|write|patch/i.test(name);
          const isFileRead = /read|grep|glob|search|list/i.test(name);
          const targetCat: ContextCategoryKey = isEdit ? "reply" : isFileRead ? "files" : "commands";
          const bLen = byteLen(payloadText);
          const tokEst = approxTokens(payloadText);
          weights[targetCat].bytes += bLen;
          weights[targetCat].tokens += tokEst;
          weights[targetCat].count++;

          logSteps.push({
            stepIndex: stepSeq,
            label: `#${stepSeq}`,
            tokens: tokEst,
            bytes: bLen,
            linesCount: outText ? outText.split("\n").length : 1,
            category: targetCat,
            categoryLabel: t(language, `audit.cat.${targetCat}` as MessageKey),
            color: CONTEXT_CATEGORY_COLORS[targetCat],
            summary: `${name}: ${summary}`,
          });

          cmdList.push({
            id: ev.callId,
            step: stepSeq,
            toolName: name,
            summary: summary.slice(0, 120),
            category: isEdit ? "edit" : /grep|glob|search/i.test(name) ? "search" : isFileRead ? "file" : "command",
            isWb: Boolean(st?.wbCommand) || /\bwb\b/.test(summary),
            isError: isErr,
            durationMs: ev.durationMs ?? (st ? Math.max(0, ev.ts - st.ts) : undefined),
            linesCount: outText ? outText.split("\n").length : 0,
            content: [inText, outText].filter(Boolean).join("\n---\n"),
          });
        }
      }
    } else if (rawLog.trim()) {
      const blocks = parseConsoleLog(rawLog, language);
      let stepSeq = 0;
      let rawStepSeq = 0;
      for (const blk of blocks) {
        const tok = approxTokens(blk.content);
        const bLen = byteLen(blk.content);
        let stepCat: ContextCategoryKey | null = null;
        if (blk.kind === "command_env" || blk.kind === "lifecycle_noise") {
          weights.system.bytes += bLen;
          weights.system.tokens += tok;
          weights.system.count++;
          stepCat = "system";
        } else if (blk.kind === "prompt_context") {
          weights.handoff.bytes = Math.max(weights.handoff.bytes, bLen);
          weights.handoff.tokens = Math.max(weights.handoff.tokens, tok);
          weights.handoff.count = Math.max(weights.handoff.count, 1);
          stepCat = "handoff";
        } else if (blk.kind === "thinking") {
          weights.thinking.bytes += bLen;
          weights.thinking.tokens += tok;
          weights.thinking.count++;
          stepCat = "thinking";
        } else if (blk.kind === "message") {
          weights.reply.bytes += bLen;
          weights.reply.tokens += tok;
          weights.reply.count++;
          stepCat = "reply";
        } else if (blk.kind === "tool_call") {
          stepSeq++;
          const toolName = blk.meta?.toolName ?? (blk.meta?.command ? "Bash" : "Tool");
          const summary = blk.meta?.command || blk.summary || blk.title;
          const isEdit = /^(Edit|Write|MultiEdit|Patch|NotebookEdit)$/i.test(toolName);
          const isRead = /^(Read|View|Open)$/i.test(toolName);
          const isSearch = /^(Grep|Glob|Search|Find|WebSearch)$/i.test(toolName);
          const prog = toolName === "Bash" ? classifyShellProgram(summary) : toolName;
          const isErr = blk.tone === "danger";
          bumpTool(prog, isErr);

          if (isEdit) {
            const p = summary.split(/\s+/)[0] ?? "";
            if (p && !p.startsWith("-")) bumpFile(p, "write");
            stepCat = "reply";
          } else if (isRead) {
            const p = summary.split(/\s+/)[0] ?? "";
            if (p && !p.startsWith("-")) bumpFile(p, "read");
            stepCat = "files";
          } else if (isSearch) {
            const inMatch = /\bin\s+([^\s]+)/.exec(summary);
            if (inMatch?.[1]) bumpFile(inMatch[1], "search");
            stepCat = "files";
          } else {
            for (const fp of extractPathsFromShellCmd(summary)) {
              bumpFile(fp.path, fp.op);
            }
            stepCat = /\b(grep|rg|find|cat|sed|head|tail)\b/.test(prog) ? "files" : "commands";
          }
          weights[stepCat].bytes += bLen;
          weights[stepCat].tokens += tok;
          weights[stepCat].count++;

          cmdList.push({
            id: blk.id,
            step: stepSeq,
            toolName: prog,
            summary: summary.slice(0, 120),
            category: isEdit ? "edit" : isSearch ? "search" : isRead ? "file" : "command",
            isWb: /\bwb\b/.test(summary),
            isError: isErr,
            linesCount: blk.linesCount,
            content: blk.content,
          });
        } else if (blk.kind === "error") {
          weights.commands.bytes += bLen;
          weights.commands.tokens += tok;
          weights.commands.count++;
          stepCat = "commands";
        }

        if (stepCat && bLen > 0) {
          rawStepSeq++;
          logSteps.push({
            stepIndex: rawStepSeq,
            label: `#${rawStepSeq}`,
            tokens: tok,
            bytes: bLen,
            linesCount: blk.linesCount,
            category: stepCat,
            categoryLabel: t(language, `audit.cat.${stepCat}` as MessageKey),
            color: CONTEXT_CATEGORY_COLORS[stepCat],
            summary: `${blk.title}${blk.summary ? `: ${blk.summary}` : ""}`,
          });
        }
      }
    }

    // Honest captured activity volumes — never rescaled to fake cumulative totals
    const categories: ContextCategorySlice[] = (
      ["system", "handoff", "files", "commands", "thinking", "reply"] as const
    ).map((key) => ({
      key,
      label: t(language, `audit.cat.${key}` as MessageKey),
      color: CONTEXT_CATEGORY_COLORS[key],
      bytes: weights[key].bytes,
      tokens: weights[key].tokens,
      count: weights[key].count,
    }));
    const totalCapturedBytes = categories.reduce((acc, c) => acc + c.bytes, 0);
    const totalCapturedTokens = categories.reduce((acc, c) => acc + c.tokens, 0);

    // Exact usage segments when API / Codex reported usage is available
    const runUsage = inspectedRun.usage;
    const exactTokenSegments: DonutSegment[] = runUsage && runUsage.totalTokens > 0
      ? [
          {
            key: "cacheRead",
            label: t(language, "audit.tok.cacheRead"),
            value: runUsage.cacheReadTokens,
            color: "#10b981",
            hint: formatTokenCount(runUsage.cacheReadTokens),
          },
          {
            key: "uncachedInput",
            label: t(language, "audit.tok.uncachedIn"),
            value: runUsage.uncachedInputTokens,
            color: "var(--accent)",
            hint: formatTokenCount(runUsage.uncachedInputTokens),
          },
          {
            key: "cacheWrite",
            label: t(language, "audit.tok.cacheWrite"),
            value: runUsage.cacheWriteTokens,
            color: "#06b6d4",
            hint: formatTokenCount(runUsage.cacheWriteTokens),
          },
          {
            key: "output",
            label: t(language, "audit.tok.output"),
            value: runUsage.outputTokens,
            color: "#ec4899",
            hint: formatTokenCount(runUsage.outputTokens),
          },
          {
            key: "reasoning",
            label: t(language, "audit.tok.reasoning"),
            value: runUsage.reasoningTokens,
            color: "#8b5cf6",
            hint: formatTokenCount(runUsage.reasoningTokens),
          },
        ].filter((s) => s.value > 0)
      : [];

    const files = Array.from(fileMap.values()).sort((a, b) => b.total - a.total || a.path.localeCompare(b.path));
    const toolDist = Array.from(toolMap.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    return {
      categories,
      totalCapturedBytes,
      totalCapturedTokens,
      exactTokenSegments,
      realTurns,
      compactions,
      logSteps,
      files,
      toolDist,
      commands: cmdList,
    };
  }, [traceState?.events, rawLog, ctxData?.context, d, inspectedRun, language]);

  const synthesizedContext = useMemo<RunContextSnapshot | null>(() => {
    if (ctxData?.hasContext && ctxData.context) return ctxData.context;
    const specTxt = d.specMarkdown ?? "";
    const designTxt = d.designMarkdown ?? "";
    const handoffTxt = d.handoffMarkdown ?? "";
    if (!specTxt && !designTxt && !handoffTxt) return null;
    const sections: HandoffSectionMetric[] = [
      {
        key: "spec",
        label: "spec.md",
        priority: 1,
        rawBytes: specTxt.length,
        finalBytes: specTxt.length,
        estTokens: approxTokens(specTxt),
        truncated: false,
      },
      {
        key: "design",
        label: "design.md",
        priority: 2,
        rawBytes: designTxt.length,
        finalBytes: designTxt.length,
        estTokens: approxTokens(designTxt),
        truncated: false,
      },
      {
        key: "handoff",
        label: "handoff.md",
        priority: 3,
        rawBytes: handoffTxt.length,
        finalBytes: handoffTxt.length,
        estTokens: approxTokens(handoffTxt),
        truncated: false,
      },
    ].filter((s) => s.finalBytes > 0);
    const totalBytes = sections.reduce((acc, s) => acc + s.finalBytes, 0);
    const cmdFirstLine = stripAnsi(rawLog).split("\n").find((l) => l.startsWith("$ ")) ?? `$ ${inspectedRun.harness} --model ${inspectedRun.model}`;
    return {
      schemaVersion: 1,
      runId: inspectedRun.id,
      requirementId: reqId,
      action: inspectedRun.action,
      capturedAt: inspectedRun.startedAt,
      handoffMode: inspectedRun.handoffMode ?? "first_run",
      dispatchReason: inspectedRun.dispatchReason ?? "route_primary",
      selectedTarget: { harness: inspectedRun.harness, model: inspectedRun.model },
      routeCandidates: [],
      specHashBefore: d.state.specHash ?? "",
      codeSnapshotHashBefore: d.state.baseline?.head ?? null,
      handoffBudgetBytes: 65_536,
      handoffTotalBytes: totalBytes,
      handoffEstTokens: sections.reduce((acc, s) => acc + s.estTokens, 0),
      promptBytes: totalBytes,
      promptEstTokens: sections.reduce((acc, s) => acc + s.estTokens, 0),
      sections,
      truncatedSections: [],
      handoffMarkdown: handoffTxt || designTxt || specTxt,
      promptText: `${cmdFirstLine}\n\n# ${reqId}\n\n${handoffTxt || designTxt || specTxt}`,
    };
  }, [ctxData, d.specMarkdown, d.designMarkdown, d.handoffMarkdown, d.state.specHash, d.state.baseline?.head, rawLog, inspectedRun, reqId]);

  const handoffDiffChunks = useMemo(() => {
    if (!synthesizedContext?.handoffMarkdown || !parentCtxData?.context?.handoffMarkdown) return null;
    return diffLines(parentCtxData.context.handoffMarkdown, synthesizedContext.handoffMarkdown);
  }, [synthesizedContext?.handoffMarkdown, parentCtxData?.context?.handoffMarkdown]);

  const filteredFiles = useMemo(() => {
    if (fileFilter === "all") return analytics.files;
    if (fileFilter === "read") return analytics.files.filter((f) => f.reads > 0);
    if (fileFilter === "write") return analytics.files.filter((f) => f.writes > 0);
    return analytics.files.filter((f) => f.searches > 0);
  }, [analytics.files, fileFilter]);

  const filteredCommands = useMemo(() => {
    if (cmdFilter === "all") return analytics.commands;
    if (cmdFilter === "edits") return analytics.commands.filter((c) => c.category === "edit");
    if (cmdFilter === "wb") return analytics.commands.filter((c) => c.isWb);
    return analytics.commands.filter((c) => c.isError);
  }, [analytics.commands, cmdFilter]);

  const usage = inspectedRun.usage;
  const cost = inspectedRun.cost;
  const ctxWindow = inspectedRun.contextWindow ?? 200_000;
  const hasRealPeak = typeof inspectedRun.peakContextTokens === "number" && inspectedRun.peakContextTokens > 0;
  const pressureTokens = hasRealPeak ? inspectedRun.peakContextTokens! : 0;
  const pressureRatio = ctxWindow > 0 ? Math.min(1, pressureTokens / ctxWindow) : 0;
  const pressureTone = pressureRatio >= 0.85 ? "tone-danger" : pressureRatio >= 0.65 ? "tone-warning" : "";
  const hasExactBreakdown = analytics.exactTokenSegments.length > 0;
  const usageSourceKey: MessageKey =
    analytics.realTurns.length > 0 || cost?.costSource === "reported"
      ? "audit.source.apiExact"
      : cost?.costSource === "estimated"
        ? "audit.source.estimated"
        : "audit.source.reported";
  const donutSegments: DonutSegment[] = hasExactBreakdown
    ? analytics.exactTokenSegments
    : analytics.categories.map((c) => ({
        key: c.key,
        label: c.label,
        value: c.bytes,
        color: c.color,
        hint: `${formatBytes(c.bytes)} · ~${formatTokenCount(c.tokens)}`,
      }));

  return (
    <div className="card audit-inspector-card" data-testid="run-inspector-panel">
      <div className="card-head" style={{ flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <h3 style={{ margin: 0 }}>
            {t(language, "audit.inspectorTitle", { runId: inspectedRun.id })}
          </h3>
          <span className={`badge ${AGENT_RUN_TONE[inspectedRun.status]}`}>
            {formatAgentActionLabel(language, inspectedRun.action)} · {formatAgentStatusLabel(language, inspectedRun.status)}
          </span>
          <span className="muted xs">
            {inspectedRun.harness} / {inspectedRun.effectiveModel ?? inspectedRun.model}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div className="segmented" role="tablist">
            {(["usage", "activity", "context"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={subTab === tab}
                className={subTab === tab ? "active" : ""}
                data-testid={`inspector-tab-${tab}`}
                onClick={() => setSubTab(tab)}
              >
                {t(language, `audit.tab.${tab}` as MessageKey)}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn ghost xs"
            data-testid="inspector-open-drawer-btn"
            onClick={() => void openRunConsole(reqId, inspectedRun.id)}
          >
            <Icon icon={Terminal} size={14} /> {t(language, "timeline.viewOutput")}
          </button>
        </div>
      </div>

      {subTab === "usage" && (
        <div className="audit-usage-pane" data-testid="inspector-pane-usage">
          <div className="audit-metrics-grid">
            <div className="audit-metric-box">
              {hasRealPeak ? (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                    <span className="muted xs">{t(language, "audit.contextPressure")}</span>
                    <span className="badge success xs">{t(language, "audit.source.apiExact")}</span>
                  </div>
                  <div className="audit-metric-val">
                    {formatPercent(pressureRatio)}{" "}
                    <span className="muted xs">({formatTokenCount(pressureTokens)})</span>
                  </div>
                  <div className="audit-pressure-bar">
                    <div
                      className={`audit-pressure-fill ${pressureTone}`}
                      style={{ width: `${Math.max(pressureTokens > 0 ? 3 : 0, Math.round(pressureRatio * 100))}%` }}
                    />
                  </div>
                  <div className="muted xs" style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                    <span>{t(language, "audit.windowCap", { window: formatTokenCount(ctxWindow) })}</span>
                    {(inspectedRun.compactionCount ?? 0) > 0 && (
                      <span>{t(language, "audit.compactionCount", { count: inspectedRun.compactionCount ?? 0 })}</span>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                    <span className="muted xs">{t(language, "audit.sessionTotalTokens")}</span>
                    <span className="badge xs">{t(language, usageSourceKey)}</span>
                  </div>
                  <div className="audit-metric-val">
                    {formatTokenCount(usage?.totalTokens ?? analytics.totalCapturedTokens)}
                  </div>
                  <div className="muted xs" style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                    <span>{t(language, "audit.windowCap", { window: formatTokenCount(ctxWindow) })}</span>
                    <span>{t(language, "audit.turnsTools")}: {inspectedRun.turnsCount ?? 0}/{inspectedRun.toolCallsCount ?? 0}</span>
                  </div>
                </>
              )}
            </div>

            <div className="audit-metric-box">
              <div className="muted xs">{t(language, "audit.tokens")}</div>
              <div className="audit-metric-val">{formatTokenCount(usage?.totalTokens ?? 0)}</div>
              <div className="muted xs">
                in {formatTokenCount(usage?.inputTokens ?? 0)} · cacheRead {formatTokenCount(usage?.cacheReadTokens ?? 0)} · out{" "}
                {formatTokenCount(usage?.outputTokens ?? 0)}
                {usage?.reasoningTokens ? ` · reason ${formatTokenCount(usage.reasoningTokens)}` : ""}
              </div>
              {usage && usage.inputTokens > 0 && (
                <div className="xs" style={{ marginTop: 4 }}>
                  {t(language, "audit.cacheHitRate")}:{" "}
                  <strong>{formatPercent(usage.cacheReadTokens / usage.inputTokens)}</strong>
                </div>
              )}
            </div>

            <div className="audit-metric-box">
              <div className="muted xs">{t(language, "audit.dualCost")}</div>
              <div className="audit-metric-val">
                {formatUsd(cost?.apiCostUsd ?? 0)}{" "}
                <span className="muted xs">/ {t(language, "audit.equivShort")} {formatUsd(cost?.equivalentCostUsd ?? 0)}</span>
              </div>
              <div className="muted xs">
                {t(language, "audit.pool")}: <strong>{inspectedRun.quotaPool ?? cost?.quotaPool ?? "—"}</strong> ·{" "}
                {t(language, `insights.billing.${inspectedRun.billingMode ?? cost?.billingMode ?? "subscription"}` as MessageKey)} ·{" "}
                {formatDurationHuman(inspectedRun.durationMs)}
              </div>
            </div>
          </div>

          <div className="audit-section-card" data-testid="context-composition-grid">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <strong style={{ fontSize: 13 }}>{t(language, "audit.compositionTitle")}</strong>
                <span className="badge xs">
                  {hasExactBreakdown ? t(language, "audit.exactUsageSplit") : t(language, "audit.capturedPayloadTitle")}
                </span>
              </div>
              <span className="muted xs">
                {t(language, "audit.capturedPayloadTitle")}: {formatBytes(analytics.totalCapturedBytes)} (~{formatTokenCount(analytics.totalCapturedTokens)} tok)
              </span>
            </div>

            <div className="composition-bar" role="img" aria-label="Captured payload composition bar">
              {analytics.categories.map((cat) => {
                if (cat.bytes <= 0 || analytics.totalCapturedBytes <= 0) return null;
                const pct = Math.max(2, (cat.bytes / analytics.totalCapturedBytes) * 100);
                return (
                  <div
                    key={cat.key}
                    className="composition-seg"
                    style={{ width: `${pct}%`, background: cat.color }}
                    title={`${cat.label}: ${formatBytes(cat.bytes)} (~${formatTokenCount(cat.tokens)} tok, ${Math.round(pct)}%)`}
                  />
                );
              })}
            </div>

            <div className="audit-composition-layout">
              <DonutRingChart
                segments={donutSegments}
                centerValue={
                  hasExactBreakdown
                    ? formatTokenCount(usage?.totalTokens ?? 0)
                    : formatBytes(analytics.totalCapturedBytes)
                }
                centerLabel={hasExactBreakdown ? t(language, "audit.compositionTotal") : t(language, "audit.capturedPayloadTitle")}
                size={146}
              />

              <div className="audit-cat-grid">
                {analytics.categories.map((cat) => {
                  const CatGlyph = categoryIcon(cat.key);
                  const pct =
                    analytics.totalCapturedBytes > 0
                      ? Math.round((cat.bytes / analytics.totalCapturedBytes) * 100)
                      : 0;
                  return (
                    <div key={cat.key} className="audit-cat-card" data-testid={`context-cat-${cat.key}`}>
                      <div className="audit-cat-head">
                        <span className="audit-cat-title">
                          <span
                            className="audit-cat-icon"
                            style={{ background: `${cat.color}20`, color: cat.color }}
                          >
                            <Icon icon={CatGlyph} size={14} />
                          </span>
                          <span>{cat.label}</span>
                        </span>
                        <span className="badge xs">{pct}%</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6 }}>
                        <strong style={{ fontSize: 13.5 }}>{formatBytes(cat.bytes)}</strong>
                        <span className="muted xs">
                          ~{formatTokenCount(cat.tokens)} tok · {t(language, "audit.catCount", { count: cat.count })}
                        </span>
                      </div>
                      <div className="audit-cat-bar">
                        <div className="audit-cat-bar-fill" style={{ width: `${pct}%`, background: cat.color }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="audit-section-card" data-testid="audit-trend-card">
            {analytics.realTurns.length > 0 ? (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <strong style={{ fontSize: 13 }}>{t(language, "audit.contextStepTrend")}</strong>
                    <span className="badge success xs">{t(language, "audit.source.apiExact")}</span>
                  </div>
                  <div className="segmented">
                    <button
                      type="button"
                      className={chartMode === "area" ? "active" : ""}
                      data-testid="audit-chart-mode-area"
                      onClick={() => setChartMode("area")}
                    >
                      {t(language, "audit.chartMode.area")}
                    </button>
                    <button
                      type="button"
                      className={chartMode === "bars" ? "active" : ""}
                      data-testid="audit-chart-mode-bars"
                      onClick={() => setChartMode("bars")}
                    >
                      {t(language, "audit.chartMode.bars")}
                    </button>
                  </div>
                </div>
                {chartMode === "area" ? (
                  <ContextGrowthChart
                    turns={analytics.realTurns}
                    contextWindow={ctxWindow}
                    compactions={analytics.compactions}
                    emptyText={t(language, "audit.noTurnMetrics")}
                    cacheLabel={t(language, "audit.tok.cacheRead")}
                    uncachedLabel={t(language, "audit.tok.uncachedIn")}
                  />
                ) : (
                  <StackedBarChart
                    data={analytics.realTurns.map((pt) => ({
                      key: String(pt.turnIndex),
                      label: `#${pt.turnIndex}`,
                      tooltip: pt.toolsSummary ? `Turn #${pt.turnIndex} · ${pt.toolsSummary}` : `Turn #${pt.turnIndex}`,
                      segments: [
                        {
                          key: "cacheRead",
                          label: t(language, "audit.tok.cacheRead"),
                          value: pt.cacheReadTokens ?? 0,
                          color: "#10b981",
                        },
                        {
                          key: "uncachedInput",
                          label: t(language, "audit.tok.uncachedIn"),
                          value: pt.uncachedInputTokens ?? Math.max(0, pt.contextTokens - (pt.cacheReadTokens ?? 0)),
                          color: "var(--accent)",
                        },
                        {
                          key: "output",
                          label: t(language, "audit.tok.output"),
                          value: pt.outputTokens ?? 0,
                          color: "#ec4899",
                        },
                        {
                          key: "reasoning",
                          label: t(language, "audit.tok.reasoning"),
                          value: pt.reasoningTokens ?? 0,
                          color: "#8b5cf6",
                        },
                      ],
                    }))}
                    formatValue={(v) => formatTokenCount(v)}
                    emptyText={t(language, "audit.noTurnMetrics")}
                  />
                )}
              </>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <strong style={{ fontSize: 13 }}>{t(language, "audit.stepPayloadTitle")}</strong>
                    <span className="badge xs">{t(language, "audit.source.logSteps")}</span>
                  </div>
                  <span className="muted xs">{t(language, "audit.stepPayloadHint")}</span>
                </div>
                <StepPayloadChart
                  steps={analytics.logSteps}
                  emptyText={t(language, "audit.noTurnMetrics")}
                />
              </>
            )}
          </div>
        </div>
      )}

      {subTab === "activity" && (
        <div className="audit-activity-pane" data-testid="inspector-pane-activity">
          <div className="audit-activity-grid">
            <div className="audit-activity-card" data-testid="audit-tool-distribution">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <strong style={{ fontSize: 13 }}>{t(language, "audit.toolDistTitle")}</strong>
                <span className="muted xs">{analytics.toolDist.reduce((a, b) => a + b.count, 0)} calls</span>
              </div>
              {analytics.toolDist.length === 0 ? (
                <div className="muted xs" style={{ marginTop: 8 }}>{t(language, "audit.cmdEmpty")}</div>
              ) : (
                <div className="audit-dist-list">
                  {analytics.toolDist.slice(0, 12).map((item) => {
                    const maxCount = analytics.toolDist[0]?.count ?? 1;
                    const widthPct = Math.max(4, Math.round((item.count / maxCount) * 100));
                    return (
                      <div key={item.name} className="audit-dist-row">
                        <code style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{item.name}</code>
                        <div className="audit-dist-track">
                          <div className="audit-dist-fill" style={{ width: `${widthPct}%` }} />
                        </div>
                        <span className="muted">
                          {item.count}
                          {item.errors > 0 && <span className="danger-text"> ({item.errors} err)</span>}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="audit-activity-card" data-testid="audit-file-activity">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <strong style={{ fontSize: 13 }}>{t(language, "audit.fileActivityTitle")}</strong>
                <div className="segmented">
                  {(["all", "read", "write", "search"] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      className={fileFilter === f ? "active" : ""}
                      onClick={() => setFileFilter(f)}
                    >
                      {t(language, `audit.fileFilter.${f}` as MessageKey)}
                    </button>
                  ))}
                </div>
              </div>
              {filteredFiles.length === 0 ? (
                <div className="muted xs" style={{ marginTop: 8 }}>{t(language, "audit.fileEmpty")}</div>
              ) : (
                <div className="audit-file-list">
                  {filteredFiles.map((f) => (
                    <div key={f.path} className="audit-file-row">
                      <span className="audit-file-path">{f.path}</span>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                        {f.reads > 0 && (
                          <span className="badge xs" title="Read">
                            <Icon icon={Eye} size={14} /> {f.reads}
                          </span>
                        )}
                        {f.writes > 0 && (
                          <span className="badge info xs" title="Edit / Write">
                            <Icon icon={FileEdit} size={14} /> {f.writes}
                          </span>
                        )}
                        {f.searches > 0 && (
                          <span className="badge xs" title="Search">
                            <Icon icon={Search} size={14} /> {f.searches}
                          </span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="audit-activity-card" data-testid="audit-command-list">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <strong style={{ fontSize: 13 }}>{t(language, "audit.commandListTitle")}</strong>
              <div className="segmented">
                {(["all", "edits", "wb", "errors"] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={cmdFilter === f ? "active" : ""}
                    onClick={() => setCmdFilter(f)}
                  >
                    {t(language, `audit.cmdFilter.${f}` as MessageKey)}
                  </button>
                ))}
              </div>
            </div>
            {filteredCommands.length === 0 ? (
              <div className="muted xs" style={{ marginTop: 8 }}>{t(language, "audit.cmdEmpty")}</div>
            ) : (
              <div className="audit-cmd-list">
                {filteredCommands.map((c) => {
                  const expanded = Boolean(expandedCmdIds[c.id]);
                  return (
                    <div key={c.id} className="audit-cmd-row">
                      <div className="audit-cmd-head">
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <span className="muted xs">#{c.step}</span>
                          <span className={`badge xs ${c.isError ? "danger" : c.category === "edit" ? "info" : ""}`}>
                            {c.toolName}
                          </span>
                          {c.isWb && <span className="badge info xs">wb</span>}
                          <code className="xs">{c.summary}</code>
                        </span>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          {c.durationMs !== undefined && <span className="muted xs">{formatDurationHuman(c.durationMs)}</span>}
                          {c.content && (
                            <button
                              type="button"
                              className="btn ghost xs"
                              onClick={() => setExpandedCmdIds((prev) => ({ ...prev, [c.id]: !expanded }))}
                            >
                              {c.linesCount > 0 ? t(language, "console.lines", { count: c.linesCount }) : t(language, "audit.inspectDetails")}
                            </button>
                          )}
                        </span>
                      </div>
                      {expanded && c.content && <pre className="audit-cmd-pre">{c.content}</pre>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {subTab === "context" && (
        <div className="audit-context-pane" data-testid="inspector-pane-context">
          {ctxLoading && !synthesizedContext ? (
            <div className="muted xs">{t(language, "common.loading")}</div>
          ) : !synthesizedContext ? (
            <div className="callout info xs">{t(language, "audit.noContextSnapshot")}</div>
          ) : (
            <>
              {!ctxData?.hasContext && (
                <div className="callout info xs" style={{ marginBottom: 10 }}>
                  {t(language, "audit.fallbackSnapshotNotice")}
                </div>
              )}
              <div className="audit-kv-grid">
                <div>
                  <span className="muted xs">{t(language, "audit.handoffMode")}</span>
                  <div className="xs"><strong>{handoffModeLabel(language, synthesizedContext.handoffMode)}</strong></div>
                </div>
                <div>
                  <span className="muted xs">{t(language, "audit.dispatchReason")}</span>
                  <div className="xs"><strong>{synthesizedContext.dispatchReason}</strong></div>
                </div>
                <div>
                  <span className="muted xs">{t(language, "audit.promptFootprint")}</span>
                  <div className="xs">
                    <strong>
                      ~{formatTokenCount(synthesizedContext.promptEstTokens)} tok ({formatBytes(synthesizedContext.promptBytes)})
                    </strong>
                  </div>
                </div>
                {synthesizedContext.resumedSessionId && (
                  <div>
                    <span className="muted xs">{t(language, "audit.resumedSession")}</span>
                    <div className="xs"><code>{synthesizedContext.resumedSessionId}</code></div>
                  </div>
                )}
              </div>

              {synthesizedContext.routeCandidates.length > 0 && (
                <div className="audit-route-candidates">
                  <div className="muted xs" style={{ marginBottom: 4 }}>{t(language, "audit.routeCandidates")}</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {synthesizedContext.routeCandidates.map((cand, idx) => {
                      const isPicked =
                        cand.harness === synthesizedContext.selectedTarget.harness &&
                        cand.model === synthesizedContext.selectedTarget.model;
                      return (
                        <span
                          key={`${cand.harness}-${cand.model}-${idx}`}
                          className={`badge xs ${isPicked ? "success" : ""}`}
                        >
                          {cand.harness}/{cand.model}
                          {cand.reasoningEffort ? ` (${cand.reasoningEffort})` : ""}
                          {!isPicked && cand.skippedReason ? ` · ${cand.skippedReason}` : ""}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

              <div style={{ marginTop: 10 }}>
                <div className="muted xs" style={{ marginBottom: 6 }}>{t(language, "audit.handoffComposition")}</div>
                <CompositionBar
                  sections={synthesizedContext.sections}
                  totalBytes={synthesizedContext.handoffTotalBytes}
                  budgetBytes={synthesizedContext.handoffBudgetBytes}
                />
                <div className="audit-section-table">
                  {synthesizedContext.sections.map((s) => (
                    <div key={s.key} className="audit-section-row xs">
                      <span>{s.label}</span>
                      <span className="muted">
                        ~{formatTokenCount(s.estTokens)} tok · {formatBytes(s.finalBytes)}
                        {s.truncated && (
                          <span className="badge warning xs" style={{ marginLeft: 6 }}>
                            {t(language, "audit.trimmedFrom", { raw: formatBytes(s.rawBytes) })}
                          </span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="audit-context-view-bar">
                <div className="segmented">
                  <button
                    type="button"
                    className={contextView === "handoff" ? "active" : ""}
                    onClick={() => setContextView("handoff")}
                  >
                    {t(language, "audit.viewHandoffMd")}
                  </button>
                  <button
                    type="button"
                    className={contextView === "prompt" ? "active" : ""}
                    onClick={() => setContextView("prompt")}
                  >
                    {t(language, "audit.viewFullPrompt")}
                  </button>
                  {parentRun && (
                    <button
                      type="button"
                      className={contextView === "diff" ? "active" : ""}
                      data-testid="handoff-diff-btn"
                      onClick={() => setContextView("diff")}
                    >
                      {t(language, "audit.viewHandoffDiff")}
                    </button>
                  )}
                </div>
              </div>

              {contextView === "handoff" && (
                <div className="audit-context-scroll" data-testid="context-handoff-md">
                  <MarkdownView markdown={synthesizedContext.handoffMarkdown} />
                </div>
              )}
              {contextView === "prompt" && (
                <pre className="audit-context-pre" data-testid="context-full-prompt">
                  {synthesizedContext.promptText}
                </pre>
              )}
              {contextView === "diff" && (
                <div className="audit-context-diff" data-testid="context-handoff-diff">
                  {!handoffDiffChunks ? (
                    <div className="muted xs">{t(language, "audit.noParentContextDiff")}</div>
                  ) : (
                    <pre className="audit-diff-pre">
                      {handoffDiffChunks.map((part, idx) => (
                        <span
                          key={idx}
                          className={part.added ? "diff-add" : part.removed ? "diff-del" : "diff-ctx"}
                        >
                          {part.value}
                        </span>
                      ))}
                    </pre>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function LiveRunsMerge({
  reqId,
  initialRuns,
  children,
}: {
  reqId: string;
  initialRuns: AgentRunRecord[];
  children: (runs: AgentRunRecord[]) => React.ReactNode;
}) {
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const activeRuns = useStreamStore((s) => s.activeRuns);
  const liveRunMetrics = useStreamStore((s) => s.liveRunMetrics);
  const liveRunLogs = useStreamStore((s) => s.liveRunLogs);
  const { data: fetchedRuns } = useRequirementRunsQuery(activeProjectId, reqId, true);

  const mergedRuns = useMemo(() => {
    const byId = new Map<string, AgentRunRecord>();
    for (const r of initialRuns) byId.set(r.id, r);
    for (const r of fetchedRuns ?? []) byId.set(r.id, r);
    for (const r of Object.values(activeRuns)) {
      if (r.requirementId === reqId) byId.set(r.id, r);
    }
    const list = Array.from(byId.values()).map((r) => {
      const m = liveRunMetrics[r.id];
      const merged = m ? { ...r, ...m } : r;
      return enrichRunForDisplay(merged, liveRunLogs[r.id]);
    });
    return list.sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));
  }, [initialRuns, fetchedRuns, activeRuns, liveRunMetrics, liveRunLogs, reqId]);

  return <>{children(mergedRuns)}</>;
}

function TimelineRunsTabInner({
  d,
  runs,
  hasQueryClient,
}: {
  d: RequirementDetail;
  runs: AgentRunRecord[];
  hasQueryClient: boolean;
}) {
  const language = useUiStore((s) => s.language);
  const setInspectedRunId = useUiStore((s) => s.setInspectedRunId);
  const setWorkspaceTab = useUiStore((s) => s.setWorkspaceTab);
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>("all");

  const events = useMemo(() => {
    const rev = [...d.state.timeline].reverse();
    if (timelineFilter === "all") return rev;
    return rev.filter((ev) => timelineCategory(ev) === timelineFilter);
  }, [d.state.timeline, timelineFilter]);

  return (
    <>
      {runs.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h3>{t(language, "timeline.runs")}</h3>
            <button className="btn xs" type="button" onClick={() => void openHandoff(d.state.id)}>
              <Icon icon={FileText} size={14} /> {t(language, "timeline.viewHandoff")}
            </button>
          </div>
          {runs.map((r) => (
            <div
              key={r.id}
              className="timeline-item"
              data-testid={`timeline-run-row-${r.id}`}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span className={`badge ${AGENT_RUN_TONE[r.status]}`}>
                  <Icon
                    icon={
                      r.status === "running"
                        ? Loader2
                        : r.status === "succeeded"
                          ? Check
                          : r.status === "cancelled"
                            ? CircleOff
                            : X
                    }
                    size={14}
                    className={r.status === "running" ? "spin" : undefined}
                  />{" "}
                  {formatAgentActionLabel(language, r.action)} · {formatAgentStatusLabel(language, r.status)}
                </span>
                <strong style={{ fontSize: 13 }}>
                  {r.harness} / {r.model}
                </strong>
                {r.modelFallback && r.effectiveModel && (
                  <span className="badge warning xs">
                    {t(language, "timeline.actual", { model: r.effectiveModel })}
                  </span>
                )}
                <span className="muted xs">
                  {formatDurationHuman(r.durationMs)}
                </span>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {hasQueryClient && (
                  <button
                    className="btn ghost xs"
                    type="button"
                    data-testid={`timeline-inspect-run-btn-${r.id}`}
                    onClick={() => {
                      setInspectedRunId(r.id);
                      setWorkspaceTab("audit");
                    }}
                  >
                    {t(language, "audit.inspectDetails")}
                  </button>
                )}
                <button
                  className="btn ghost xs"
                  type="button"
                  data-testid={`view-run-output-btn-${r.id}`}
                  onClick={() => void openRunConsole(d.state.id, r.id)}
                >
                  <Icon icon={Terminal} size={14} /> {t(language, "timeline.viewOutput")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <div className="card-head" style={{ flexWrap: "wrap", gap: 8 }}>
          <h3>{t(language, "timeline.title")}</h3>
          <div className="segmented">
            {(["all", "agent", "review", "verify", "system"] as const).map((f) => (
              <button
                key={f}
                type="button"
                className={timelineFilter === f ? "active" : ""}
                onClick={() => setTimelineFilter(f)}
              >
                {t(language, `audit.timelineFilter.${f}` as MessageKey)}
              </button>
            ))}
          </div>
        </div>
        {events.map((ev, i) => (
          <div key={`${ev.at}-${i}`} className="timeline-item">
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <strong style={{ fontSize: 13.5 }}>{ev.summary}</strong>
                {ev.runId && (
                  <button
                    type="button"
                    className="btn ghost xs"
                    onClick={() => {
                      setInspectedRunId(ev.runId!);
                      void openRunConsole(d.state.id, ev.runId!);
                    }}
                  >
                    <Icon icon={Terminal} size={14} /> {ev.runId.slice(-6)}
                  </button>
                )}
              </div>
              <span className="muted" style={{ fontSize: 12 }}>
                {formatDateTime(ev.at, language)}
              </span>
            </div>
            {ev.detail && (
              <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
                {ev.detail}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function ExecutionAuditTabInner({
  d,
  runs,
  hasQueryClient,
}: {
  d: RequirementDetail;
  runs: AgentRunRecord[];
  hasQueryClient: boolean;
}) {
  const language = useUiStore((s) => s.language);
  const inspectedRunId = useUiStore((s) => s.inspectedRunId);
  const setInspectedRunId = useUiStore((s) => s.setInspectedRunId);

  const inspectedRun = useMemo(() => {
    if (runs.length === 0) return null;
    if (inspectedRunId) {
      const hit = runs.find((r) => r.id === inspectedRunId);
      if (hit) return hit;
    }
    return runs[0] ?? null;
  }, [runs, inspectedRunId]);

  const totals = useMemo(() => {
    let tokens = 0;
    let cacheRead = 0;
    let inputTokens = 0;
    let apiCost = 0;
    let equivCost = 0;
    let durationMs = 0;
    let toolCalls = 0;
    let toolErrors = 0;
    let compactions = 0;
    for (const r of runs) {
      tokens += r.usage?.totalTokens ?? 0;
      cacheRead += r.usage?.cacheReadTokens ?? 0;
      inputTokens += r.usage?.inputTokens ?? 0;
      apiCost += r.cost?.apiCostUsd ?? 0;
      equivCost += r.cost?.equivalentCostUsd ?? 0;
      durationMs += r.durationMs ?? 0;
      toolCalls += r.toolCallsCount ?? 0;
      toolErrors += r.toolErrorCount ?? 0;
      compactions += r.compactionCount ?? 0;
    }
    return {
      tokens,
      cacheHitRate: inputTokens > 0 ? cacheRead / inputTokens : 0,
      apiCost,
      equivCost,
      durationMs,
      toolCalls,
      toolErrors,
      compactions,
    };
  }, [runs]);

  if (runs.length === 0) {
    return (
      <div className="card" data-testid="audit-empty-state">
        <p className="muted" style={{ margin: 0 }}>{t(language, "audit.emptyRuns")}</p>
      </div>
    );
  }

  return (
    <>
      <div className="audit-summary-strip" data-testid="req-audit-summary">
        <div className="audit-sum-pill">
          <Icon icon={Activity} size={14} />
          <span>{t(language, "audit.runsCount", { count: runs.length })}</span>
        </div>
        <div className="audit-sum-pill">
          <Icon icon={Cpu} size={14} />
          <span>
            {formatTokenCount(totals.tokens)} tok ({t(language, "audit.cacheShort")} {formatPercent(totals.cacheHitRate)})
          </span>
        </div>
        <div className="audit-sum-pill">
          <span>
            API {formatUsd(totals.apiCost)} · {t(language, "audit.equivShort")} {formatUsd(totals.equivCost)}
          </span>
        </div>
        <div className="audit-sum-pill">
          <Icon icon={Clock} size={14} />
          <span>{formatDurationHuman(totals.durationMs)}</span>
        </div>
        <div className="audit-sum-pill">
          <Icon icon={Wrench} size={14} />
          <span>
            {totals.toolCalls} tools{totals.toolErrors > 0 ? ` (${totals.toolErrors} err)` : ""}
          </span>
        </div>
        {totals.compactions > 0 && (
          <div className="audit-sum-pill">
            <Icon icon={Layers} size={14} />
            <span>{totals.compactions} compactions</span>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h3>{t(language, "audit.runsTableTitle")}</h3>
          <button className="btn xs" type="button" onClick={() => void openHandoff(d.state.id)}>
            <Icon icon={FileText} size={14} /> {t(language, "timeline.viewHandoff")}
          </button>
        </div>
        {runs.map((r) => {
          const selected = inspectedRun?.id === r.id;
          const isEstimated = r.cost?.costSource === "estimated" && !r.tracePath;
          return (
            <div
              key={r.id}
              className={`timeline-item audit-run-row ${selected ? "is-selected" : ""}`}
              data-testid={`audit-run-row-${r.id}`}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span className={`badge ${AGENT_RUN_TONE[r.status]}`}>
                  <Icon
                    icon={
                      r.status === "running"
                        ? Loader2
                        : r.status === "succeeded"
                          ? Check
                          : r.status === "cancelled"
                            ? CircleOff
                            : X
                    }
                    size={14}
                    className={r.status === "running" ? "spin" : undefined}
                  />{" "}
                  {formatAgentActionLabel(language, r.action)} · {formatAgentStatusLabel(language, r.status)}
                </span>
                <strong style={{ fontSize: 13 }}>
                  {r.harness} / {r.model}
                </strong>
                {r.modelFallback && r.effectiveModel && (
                  <span className="badge warning xs">
                    {t(language, "timeline.actual", { model: r.effectiveModel })}
                  </span>
                )}
                {r.quotaPool && (
                  <span className="badge xs" title={r.billingMode}>
                    {r.quotaPool} · {r.billingMode ?? "subscription"}
                  </span>
                )}
                {isEstimated && (
                  <span className="badge xs">{t(language, "audit.estimatedTag")}</span>
                )}
                {r.handoffMode && (
                  <span className="muted xs" style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                    <Icon icon={GitBranch} size={14} />
                    {handoffModeLabel(language, r.handoffMode)}
                    {r.parentRunId && (
                      <>
                        <Icon icon={ArrowRight} size={14} />
                        <code>{r.parentRunId.slice(-6)}</code>
                      </>
                    )}
                  </span>
                )}
                <span className="muted xs">
                  {formatDurationHuman(r.durationMs)}
                  {r.usage?.totalTokens ? ` · ${formatTokenCount(r.usage.totalTokens)} tok` : ""}
                  {r.usage && r.usage.inputTokens > 0
                    ? ` (${t(language, "audit.cacheShort")} ${formatPercent(r.usage.cacheReadTokens / r.usage.inputTokens)})`
                    : ""}
                  {r.cost?.equivalentCostUsd ? ` · ${formatUsd(r.cost.equivalentCostUsd)}` : ""}
                </span>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {hasQueryClient && (
                  <button
                    className={`btn xs ${selected ? "primary" : "ghost"}`}
                    type="button"
                    data-testid={`inspect-run-btn-${r.id}`}
                    onClick={() => {
                      setInspectedRunId(r.id);
                      useStreamStore.getState().setSelectedRunForReq(d.state.id, r.id);
                    }}
                  >
                    {t(language, "audit.inspectDetails")}
                  </button>
                )}
                <button
                  className="btn ghost xs"
                  type="button"
                  data-testid={`audit-view-output-btn-${r.id}`}
                  onClick={() => void openRunConsole(d.state.id, r.id)}
                >
                  <Icon icon={Terminal} size={14} /> {t(language, "timeline.viewOutput")}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {hasQueryClient && inspectedRun && (
        <RunInspectorSection d={d} reqId={d.state.id} runs={runs} inspectedRun={inspectedRun} />
      )}
    </>
  );
}

export function TimelineRunsTab({ d }: { d: RequirementDetail }) {
  const hasQueryClient = Boolean(useContext(QueryClientContext));
  const staticRuns = useMemo(
    () =>
      [...(d.state.agentRuns ?? [])]
        .map((r) => enrichRunForDisplay(r))
        .sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id)),
    [d.state.agentRuns],
  );

  if (!hasQueryClient) {
    return <TimelineRunsTabInner d={d} runs={staticRuns} hasQueryClient={false} />;
  }

  return (
    <LiveRunsMerge reqId={d.state.id} initialRuns={d.state.agentRuns ?? []}>
      {(runs) => <TimelineRunsTabInner d={d} runs={runs} hasQueryClient={true} />}
    </LiveRunsMerge>
  );
}

export function ExecutionAuditTab({ d }: { d: RequirementDetail }) {
  const hasQueryClient = Boolean(useContext(QueryClientContext));
  const staticRuns = useMemo(
    () =>
      [...(d.state.agentRuns ?? [])]
        .map((r) => enrichRunForDisplay(r))
        .sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id)),
    [d.state.agentRuns],
  );

  if (!hasQueryClient) {
    return <ExecutionAuditTabInner d={d} runs={staticRuns} hasQueryClient={false} />;
  }

  return (
    <LiveRunsMerge reqId={d.state.id} initialRuns={d.state.agentRuns ?? []}>
      {(runs) => <ExecutionAuditTabInner d={d} runs={runs} hasQueryClient={true} />}
    </LiveRunsMerge>
  );
}
