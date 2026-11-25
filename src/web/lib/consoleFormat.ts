import type { RunTokenUsage, RunToolCategory, RunTraceEvent } from "../../core/types.ts";
import { t, type UiLanguage } from "../i18n.ts";

export type ConsoleBlockKind =
  | "command_env"
  | "prompt_context"
  | "lifecycle_noise"
  | "thinking"
  | "tool_call"
  | "status"
  | "error"
  | "message";

export type ConsoleBlockTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface ConsoleBlock {
  id: string;
  kind: ConsoleBlockKind;
  title: string;
  summary: string;
  content: string;
  linesCount: number;
  defaultCollapsed: boolean;
  collapsible: boolean;
  tone: ConsoleBlockTone;
  meta?: {
    command?: string;
    toolName?: string;
    duration?: string;
    exitCode?: number;
    itemCount?: number;
  };
}

const QODER_READY_PREFIX = "\u26a1"; // ⚡
const QODER_THINK_PREFIX = "\ud83d\udcad"; // 💭
const QODER_TOOL_PREFIX = "\ud83d\udd27"; // 🔧
const QODER_DONE_PREFIX = "\u2713"; // ✓
const QODER_ERR_PREFIX = "\u274c"; // ❌
const QODER_WARN_CHAR = "\u26a0"; // ⚠

const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_ESC_RE = /\x1b[@-Z\\-_]/g;

const CLI_FALLBACK_NOISE_RE = /^Model ".*" is not available right now; using ".*" instead\.?/i;
const HOOK_LINE_RE = /^hook:\s*(.+)$/i;
const RMCP_NOISE_RE = /^(?:(?:WARN|INFO|DEBUG|ERROR)\s+)?(?:\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+)?(?:(?:WARN|INFO|DEBUG|ERROR)\s+)?.*rmcp::transport::worker/i;
const MCP_NOISE_RE = /^mcp(?:\s+startup)?:\s*(.+)$/i;
const WORKING_LINE_RE = /^Working\.{0,3}$/i;
const STDIN_LINE_RE = /^Reading additional input from stdin\.{0,3}$/i;
const CODEX_BANNER_RE = /^OpenAI Codex v[\w.-]+/i;
const DASH_RULE_RE = /^-{6,}$/;
const ENV_KV_RE = /^(workdir|model|provider|approval|sandbox|reasoning effort|reasoning summaries|session id)\s*:/i;

const PROMPT_START_PATTERNS = [
  /^请接力执行工作台需求\s+REQ-\d+/,
  /^你当前处于「仅提问探讨/,
  /^请你作为独立的代码与交付审查者/,
  /^【强制输出语言规范/,
  /^# REQ-\d+\s+·\s+.*上下文交接简报/,
];

const ERROR_LINE_RE =
  /^(?:\[(?:spawn error|timeout|error)\]|AGY_ERROR\s*:|(?:API error|FATAL|Unhandled(?:Rejection| Exception)?|SyntaxError|TypeError|ReferenceError|RangeError|ERROR|Error)\s*:|.*(?:RESOURCE_EXHAUSTED|You've hit your usage limit|\b429\s+Too Many Requests\b|(?:HTTP|status|code)\s*[:=]\s*429\b))/i;

const EXEC_RESULT_RE = /^(.+?)\s+(?:in\s+.+?\s+)?(succeeded|exited\s+(-?\d+))\s+in\s+([^\s:]+):?$/;
const OPENCODE_STEP_RE = /^>\s+\S+\s+·\s+\S+\s*$/;
const OPENCODE_THINK_RE = /^Thinking:\s*(.*)$/;
const OPENCODE_TOOL_ARROW_RE = /^(?:\u2192|\u2190|\u2731|\|)\s+([A-Z][A-Za-z0-9_-]*)\b(.*)$/;
const SHELL_CMD_LINE_RE = /^\$\s+(.+)$/;

/** Strips ANSI CSI/OSC/ESC control sequences and normalizes line endings. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(ANSI_OSC_RE, "")
    .replace(ANSI_CSI_RE, "")
    .replace(ANSI_ESC_RE, "");
}

function isNoiseLine(trimmed: string): boolean {
  if (!trimmed) return false;
  return (
    HOOK_LINE_RE.test(trimmed) ||
    RMCP_NOISE_RE.test(trimmed) ||
    MCP_NOISE_RE.test(trimmed) ||
    WORKING_LINE_RE.test(trimmed) ||
    CLI_FALLBACK_NOISE_RE.test(trimmed)
  );
}

function isErrorStart(trimmed: string): boolean {
  if (!trimmed || RMCP_NOISE_RE.test(trimmed)) return false;
  if (trimmed.startsWith(QODER_ERR_PREFIX)) return true;
  if (ERROR_LINE_RE.test(trimmed)) return true;
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj && typeof obj === "object" && ("error" in obj || obj.status === "RESOURCE_EXHAUSTED" || obj.code === 429)) {
        return true;
      }
    } catch {
      // ignore invalid JSON
    }
  }
  return false;
}

function isLauncherCmdLine(lines: string[], idx: number): boolean {
  const trimmed = (lines[idx] ?? "").trim();
  if (!SHELL_CMD_LINE_RE.test(trimmed)) return false;
  if (idx === 0) return true;
  for (let k = 0; k < idx; k++) {
    const prev = (lines[k] ?? "").trim();
    if (prev && !prev.startsWith("[workbench:")) return false;
  }
  return true;
}

function isAgyJsonLine(trimmed: string): boolean {
  return trimmed.startsWith("{") && /"event"\s*:\s*"(?:init|step_update|result)"/.test(trimmed);
}

function isStructuralBoundary(lines: string[], idx: number): boolean {
  const line = lines[idx] ?? "";
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (isLauncherCmdLine(lines, idx)) return true;
  if (isAgyJsonLine(trimmed)) return true;
  if (
    trimmed === "user" ||
    trimmed === "user:" ||
    trimmed === "thinking" ||
    trimmed === "codex" ||
    trimmed === "assistant" ||
    trimmed === "exec" ||
    trimmed === "tokens used"
  ) {
    return true;
  }
  if (
    trimmed.startsWith(QODER_READY_PREFIX) ||
    trimmed.startsWith(QODER_THINK_PREFIX) ||
    trimmed.startsWith(QODER_TOOL_PREFIX) ||
    trimmed.startsWith(QODER_DONE_PREFIX) ||
    trimmed.startsWith(QODER_ERR_PREFIX)
  ) {
    return true;
  }
  if (CODEX_BANNER_RE.test(trimmed) || STDIN_LINE_RE.test(trimmed)) return true;
  if (OPENCODE_STEP_RE.test(trimmed) || OPENCODE_THINK_RE.test(trimmed) || OPENCODE_TOOL_ARROW_RE.test(trimmed)) return true;
  if (SHELL_CMD_LINE_RE.test(trimmed) && !isLauncherCmdLine(lines, idx)) return true;
  if (isNoiseLine(trimmed)) return true;
  if (/^\[(?:spawn error|timeout)\]/i.test(trimmed)) return true;
  if (PROMPT_START_PATTERNS.some((re) => re.test(trimmed))) return true;
  return false;
}

function isBlockBoundary(lines: string[], idx: number): boolean {
  if (isStructuralBoundary(lines, idx)) return true;
  const trimmed = (lines[idx] ?? "").trim();
  return isErrorStart(trimmed);
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start]!.trim()) start++;
  while (end > start && !lines[end - 1]!.trim()) end--;
  return lines.slice(start, end);
}

function formatErrorContent(raw: string): string {
  const trimmed = raw.trim();
  const braceIdx = trimmed.indexOf("{");
  if (braceIdx >= 0 && trimmed.endsWith("}")) {
    const prefix = trimmed.slice(0, braceIdx).trim();
    const jsonPart = trimmed.slice(braceIdx);
    try {
      const parsed = JSON.parse(jsonPart);
      const pretty = JSON.stringify(parsed, null, 2);
      return prefix ? `${prefix}\n${pretty}` : pretty;
    } catch {
      // Keep original text if JSON is incomplete/invalid during streaming
    }
  }
  return trimmed;
}

function summarizeCommandEnv(content: string, language: UiLanguage): string {
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  const cmdLine = lines.find((l) => l.startsWith("$ ")) ?? "";
  const modelLine = lines.find((l) => /^model\s*:/i.test(l));
  const bannerLine = lines.find((l) => CODEX_BANNER_RE.test(l));

  const parts: string[] = [];
  if (cmdLine) {
    const compact = cmdLine.length > 76 ? `${cmdLine.slice(0, 73)}...` : cmdLine;
    parts.push(compact);
  } else if (bannerLine) {
    parts.push(bannerLine);
  }
  if (modelLine) {
    parts.push(modelLine.replace(/^model\s*:\s*/i, "model="));
  }
  return parts.join(" · ") || t(language, "console.block.envLines", { count: lines.length });
}

function summarizeNoise(lines: string[], language: UiLanguage): { summary: string; itemCount: number } {
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
  const hookNames: string[] = [];
  for (const l of nonEmpty) {
    const m = HOOK_LINE_RE.exec(l);
    if (m) {
      const name = m[1]!.trim().split(/\s+/)[0] ?? m[1]!.trim();
      if (!hookNames.includes(name)) hookNames.push(name);
    }
  }
  if (hookNames.length > 0) {
    const preview = hookNames.slice(0, 3).join(", ") + (hookNames.length > 3 ? "…" : "");
    return {
      summary: t(language, "console.block.noiseHookSummary", { preview, count: nonEmpty.length }),
      itemCount: nonEmpty.length,
    };
  }
  return {
    summary: t(language, "console.block.noiseSummary", { count: nonEmpty.length }),
    itemCount: nonEmpty.length,
  };
}

function previewFirstLine(content: string, maxLen = 72): string {
  const first = content.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return first.length > maxLen ? `${first.slice(0, maxLen - 3)}...` : first;
}

/**
 * Parses raw streaming or persisted agent execution logs into structured semantic blocks.
 * Preserves all content and guarantees stable block IDs during incremental append.
 */
export function parseConsoleLog(rawText: string, language: UiLanguage = "zh-CN"): ConsoleBlock[] {
  const normalized = stripAnsi(rawText);
  if (!normalized.trim()) return [];

  const lines = normalized.split("\n");
  const blocks: ConsoleBlock[] = [];
  let i = 0;

  const pushBlock = (spec: Omit<ConsoleBlock, "id" | "linesCount">) => {
    const trimmedContent = spec.content.replace(/^\n+|\n+$/g, "");
    if (!trimmedContent) return;
    const idx = blocks.length;
    blocks.push({
      ...spec,
      id: `block-${idx}-${spec.kind}`,
      content: trimmedContent,
      linesCount: countLines(trimmedContent),
    });
  };

  // 0. AGY stream-json NDJSON pre-pass when raw text contains AGY event envelopes
  if (/"event"\s*:\s*"(?:init|step_update|result)"/.test(normalized)) {
    const reconstructed = reconstructAgyTraceEvents(normalized);
    if (reconstructed && reconstructed.length > 0) {
      const agyBlocks: ConsoleBlock[] = [];
      const pushAgy = (spec: Omit<ConsoleBlock, "id" | "linesCount">) => {
        const trimmedContent = spec.content.replace(/^\n+|\n+$/g, "");
        if (!trimmedContent) return;
        const idx = agyBlocks.length;
        agyBlocks.push({
          ...spec,
          id: `block-${idx}-${spec.kind}`,
          content: trimmedContent,
          linesCount: countLines(trimmedContent),
        });
      };

      const cmdLine = lines.find((l) => isLauncherCmdLine([l.trim()], 0))?.trim();
      if (cmdLine) {
        pushAgy({
          kind: "command_env",
          title: t(language, "console.block.commandEnv"),
          summary: summarizeCommandEnv(cmdLine, language),
          content: cmdLine,
          defaultCollapsed: true,
          collapsible: true,
          tone: "neutral",
        });
      }

      const starts = new Map<string, Extract<RunTraceEvent, { type: "tool.start" }>>();
      for (const ev of reconstructed) {
        if (ev.type === "thinking") {
          const preview = previewFirstLine(ev.text, 64);
          pushAgy({
            kind: "thinking",
            title: t(language, "console.block.thinking"),
            summary: preview,
            content: ev.text,
            defaultCollapsed: true,
            collapsible: true,
            tone: "neutral",
          });
        } else if (ev.type === "tool.start") {
          starts.set(ev.callId, ev);
        } else if (ev.type === "tool.end") {
          const st = starts.get(ev.callId);
          const body = [st?.inputText, ev.output].filter(Boolean).join("\n---\n") || ev.summary || ev.toolName;
          const durStr = typeof ev.durationMs === "number" ? `${(ev.durationMs / 1000).toFixed(1)}s` : undefined;
          pushAgy({
            kind: "tool_call",
            title: ev.toolName,
            summary: `${shortenDisplayPath(ev.summary || ev.toolName)}${durStr ? ` · ${durStr}` : ""}`,
            content: body,
            defaultCollapsed: !ev.isError,
            collapsible: Boolean(st?.inputText || ev.output),
            tone: ev.isError ? "danger" : "info",
            meta: { toolName: ev.toolName, ...(durStr ? { duration: durStr } : {}) },
          });
        } else if (ev.type === "assistant.message") {
          pushAgy({
            kind: "message",
            title: t(language, "console.block.agentReply"),
            summary: previewFirstLine(ev.text, 72),
            content: ev.text,
            defaultCollapsed: false,
            collapsible: false,
            tone: "neutral",
          });
        } else if (ev.type === "run.error") {
          pushAgy({
            kind: "error",
            title: t(language, "console.block.error"),
            summary: previewFirstLine(ev.message, 80),
            content: ev.message,
            defaultCollapsed: false,
            collapsible: countLines(ev.message) > 12,
            tone: "danger",
          });
        }
      }
      if (agyBlocks.length > 0) return agyBlocks;
    }
  }

  while (i < lines.length) {
    const rawLine = lines[i]!;
    const trimmed = rawLine.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // 1. Startup command & CLI session environment banner
    if (
      isLauncherCmdLine(lines, i) ||
      STDIN_LINE_RE.test(trimmed) ||
      CODEX_BANNER_RE.test(trimmed) ||
      (DASH_RULE_RE.test(trimmed) && i + 1 < lines.length && ENV_KV_RE.test(lines[i + 1]!.trim()))
    ) {
      const buf: string[] = [];
      let inDashHeader = false;
      while (i < lines.length) {
        const cur = lines[i]!;
        const t = cur.trim();
        if (buf.length === 0) {
          buf.push(cur);
          if (DASH_RULE_RE.test(t)) inDashHeader = true;
          i++;
          continue;
        }
        if (inDashHeader) {
          buf.push(cur);
          i++;
          if (DASH_RULE_RE.test(t)) {
            inDashHeader = false;
          }
          continue;
        }
        if (!t) {
          // Consume single blank line only if next line continues command_env
          if (
            i + 1 < lines.length &&
            (STDIN_LINE_RE.test(lines[i + 1]!.trim()) ||
              CODEX_BANNER_RE.test(lines[i + 1]!.trim()) ||
              DASH_RULE_RE.test(lines[i + 1]!.trim()))
          ) {
            buf.push(cur);
            i++;
            continue;
          }
          break;
        }
        if (STDIN_LINE_RE.test(t) || CODEX_BANNER_RE.test(t) || ENV_KV_RE.test(t)) {
          buf.push(cur);
          i++;
          continue;
        }
        if (DASH_RULE_RE.test(t)) {
          buf.push(cur);
          inDashHeader = true;
          i++;
          continue;
        }
        break;
      }
      const content = trimBlankEdges(buf).join("\n");
      pushBlock({
        kind: "command_env",
        title: t(language, "console.block.commandEnv"),
        summary: summarizeCommandEnv(content, language),
        content,
        defaultCollapsed: true,
        collapsible: true,
        tone: "neutral",
      });
      continue;
    }

    // 2. Injected prompt & handoff context block
    if (trimmed === "user" || trimmed === "user:" || PROMPT_START_PATTERNS.some((re) => re.test(trimmed))) {
      const isUserMarker = trimmed === "user" || trimmed === "user:";
      const buf: string[] = [];
      if (!isUserMarker) {
        buf.push(rawLine);
      }
      i++;
      let inFence = false;
      while (i < lines.length) {
        const cur = lines[i]!;
        const t = cur.trim();
        if (/^```/.test(t)) {
          inFence = !inFence;
          buf.push(cur);
          i++;
          continue;
        }
        if (!inFence && isStructuralBoundary(lines, i) && !PROMPT_START_PATTERNS.some((re) => re.test(t))) {
          break;
        }
        buf.push(cur);
        i++;
      }
      const content = trimBlankEdges(buf).join("\n");
      if (content) {
        const lineTotal = countLines(content);
        pushBlock({
          kind: "prompt_context",
          title: t(language, "console.block.promptContext"),
          summary: t(language, "console.block.promptLines", { count: lineTotal }),
          content,
          defaultCollapsed: true,
          collapsible: true,
          tone: "neutral",
        });
      }
      continue;
    }

    // 3. Consecutive lifecycle hooks & transport noise
    if (isNoiseLine(trimmed)) {
      const buf: string[] = [];
      while (i < lines.length) {
        const cur = lines[i]!;
        const t = cur.trim();
        if (!t) {
          if (i + 1 < lines.length && isNoiseLine(lines[i + 1]!.trim())) {
            i++;
            continue;
          }
          break;
        }
        if (isNoiseLine(t)) {
          buf.push(cur);
          i++;
          continue;
        }
        break;
      }
      const content = trimBlankEdges(buf).join("\n");
      const info = summarizeNoise(buf, language);
      pushBlock({
        kind: "lifecycle_noise",
        title: t(language, "console.block.lifecycleNoise"),
        summary: info.summary,
        content,
        defaultCollapsed: true,
        collapsible: true,
        tone: "neutral",
        meta: { itemCount: info.itemCount },
      });
      continue;
    }

    // 4. Qoder status ready / done & Codex tokens used
    if (trimmed.startsWith(QODER_READY_PREFIX)) {
      const clean = trimmed.slice(QODER_READY_PREFIX.length).replace(QODER_WARN_CHAR, "").replace(/\s+/g, " ").trim();
      const isWarn = trimmed.includes(QODER_WARN_CHAR) || trimmed.includes("回退");
      pushBlock({
        kind: "status",
        title: t(language, isWarn ? "console.block.modelFallback" : "console.block.engineReady"),
        summary: clean,
        content: clean,
        defaultCollapsed: false,
        collapsible: false,
        tone: isWarn ? "warning" : "info",
      });
      i++;
      continue;
    }

    if (trimmed.startsWith(QODER_DONE_PREFIX)) {
      const clean = trimmed.slice(QODER_DONE_PREFIX.length).trim();
      pushBlock({
        kind: "status",
        title: t(language, "console.block.runDone"),
        summary: clean,
        content: clean,
        defaultCollapsed: false,
        collapsible: false,
        tone: "success",
      });
      i++;
      continue;
    }

    if (trimmed === "tokens used") {
      const nextVal = i + 1 < lines.length ? lines[i + 1]!.trim() : "";
      if (/^[\d,]+$/.test(nextVal)) {
        const text = `tokens used: ${nextVal}`;
        pushBlock({
          kind: "status",
          title: t(language, "console.block.tokenUsed"),
          summary: text,
          content: text,
          defaultCollapsed: false,
          collapsible: false,
          tone: "info",
        });
        i += 2;
        continue;
      }
    }

    // 4b. OpenCode step divider (`> build · deepseek-v4.1-flash`)
    if (OPENCODE_STEP_RE.test(trimmed)) {
      i++;
      continue;
    }

    // 5. Thinking blocks (Qoder 💭, Codex `thinking`, or OpenCode `Thinking:`)
    const openCodeThink = OPENCODE_THINK_RE.exec(trimmed);
    if (trimmed.startsWith(QODER_THINK_PREFIX) || trimmed === "thinking" || openCodeThink) {
      const buf: string[] = [];
      if (trimmed.startsWith(QODER_THINK_PREFIX)) {
        const first = trimmed.slice(QODER_THINK_PREFIX.length).trim();
        if (first) buf.push(first);
        i++;
        while (i < lines.length) {
          const cur = lines[i]!;
          const t = cur.trim();
          if (t.startsWith(QODER_THINK_PREFIX)) {
            const extra = t.slice(QODER_THINK_PREFIX.length).trim();
            if (extra) buf.push(extra);
            i++;
            continue;
          }
          break;
        }
      } else if (openCodeThink) {
        if (openCodeThink[1]?.trim()) buf.push(openCodeThink[1].trim());
        i++;
        while (i < lines.length) {
          const cur = lines[i]!;
          const t = cur.trim();
          if (!t) break;
          if (isStructuralBoundary(lines, i)) break;
          buf.push(cur);
          i++;
        }
      } else {
        i++;
        while (i < lines.length) {
          const cur = lines[i]!;
          const t = cur.trim();
          if (t && isStructuralBoundary(lines, i)) break;
          buf.push(cur);
          i++;
        }
      }
      const content = trimBlankEdges(buf).join("\n");
      if (content) {
        const lineTotal = countLines(content);
        const preview = previewFirstLine(content, 64);
        pushBlock({
          kind: "thinking",
          title: t(language, "console.block.thinking"),
          summary: lineTotal > 1 ? t(language, "console.block.thinkingLines", { preview, count: lineTotal }) : preview,
          content,
          defaultCollapsed: true,
          collapsible: true,
          tone: "neutral",
        });
      }
      continue;
    }

    // 6. Tool calls (Qoder 🔧, OpenCode →/←/✱/|, shell `$ cmd`, or Codex `exec`)
    const openCodeTool = OPENCODE_TOOL_ARROW_RE.exec(trimmed);
    if (openCodeTool) {
      const toolName = openCodeTool[1]!;
      const toolArg = (openCodeTool[2] ?? "").trim();
      const bodyBuf: string[] = [];
      i++;
      while (i < lines.length) {
        const cur = lines[i]!;
        const curTrim = cur.trim();
        if (!curTrim) {
          if (i + 1 < lines.length && isStructuralBoundary(lines, i + 1)) {
            break;
          }
          if (bodyBuf.length === 0) {
            break;
          }
          bodyBuf.push(cur);
          i++;
          continue;
        }
        if (isStructuralBoundary(lines, i)) break;
        // Stop collecting tool output when regular unindented assistant prose starts after a diff/diagnostic block
        if (
          bodyBuf.length > 0 &&
          !cur.startsWith(" ") &&
          !cur.startsWith("\t") &&
          !/^(?:Index:|===|---|\+\+\+|@@|\+|-|\\|<\/?diagnostics|ERROR\b)/.test(curTrim)
        ) {
          break;
        }
        bodyBuf.push(cur);
        i++;
      }
      const bodyClean = trimBlankEdges(bodyBuf);
      const fullContent = [rawLine, ...bodyClean].join("\n");
      const hasError = /\b(?:error|failed|enoent)\b/i.test(toolArg) || bodyClean.some((l) => /^ERROR\s+\[/i.test(l.trim()));
      const compactArg = toolArg.length > 76 ? `${toolArg.slice(0, 73)}...` : toolArg;
      const countTag = bodyClean.length > 0 ? t(language, "console.block.execOutputLines", { count: bodyClean.length }) : "";
      pushBlock({
        kind: "tool_call",
        title: toolName,
        summary: `${compactArg || toolName}${countTag}`,
        content: fullContent,
        defaultCollapsed: bodyClean.length > 0,
        collapsible: bodyClean.length > 0,
        tone: hasError ? "danger" : "info",
        meta: { toolName, ...(toolArg ? { command: toolArg } : {}) },
      });
      continue;
    }

    const shellCmd = !isLauncherCmdLine(lines, i) ? SHELL_CMD_LINE_RE.exec(trimmed) : null;
    if (shellCmd) {
      const cmdText = shellCmd[1]!.trim();
      const bodyBuf: string[] = [];
      i++;
      while (i < lines.length) {
        const cur = lines[i]!;
        const curTrim = cur.trim();
        if (curTrim && isStructuralBoundary(lines, i)) break;
        bodyBuf.push(cur);
        i++;
      }
      const bodyClean = trimBlankEdges(bodyBuf);
      const bodyText = bodyClean.join("\n");
      const compactCmd = cmdText.length > 68 ? `${cmdText.slice(0, 65)}...` : cmdText;
      const countTag = bodyClean.length > 0 ? t(language, "console.block.execOutputLines", { count: bodyClean.length }) : "";
      pushBlock({
        kind: "tool_call",
        title: t(language, "console.block.execOk"),
        summary: `${compactCmd}${countTag}`,
        content: [cmdText, ...bodyClean].join("\n"),
        defaultCollapsed: bodyClean.length > 6 || bodyText.length > 400,
        collapsible: bodyClean.length > 0,
        tone: "info",
        meta: { toolName: "Bash", command: cmdText },
      });
      continue;
    }

    if (trimmed.startsWith(QODER_TOOL_PREFIX)) {
      const toolText = trimmed.slice(QODER_TOOL_PREFIX.length).replace(/^调用工具:\s*/, "").trim();
      pushBlock({
        kind: "tool_call",
        title: t(language, "console.block.toolCall"),
        summary: toolText,
        content: toolText,
        defaultCollapsed: false,
        collapsible: false,
        tone: "info",
        meta: { toolName: toolText.split(/\s+/)[0] },
      });
      i++;
      continue;
    }

    if (trimmed === "exec") {
      i++;
      const buf: string[] = [];
      while (i < lines.length) {
        const cur = lines[i]!;
        const t = cur.trim();
        if (t && isStructuralBoundary(lines, i)) break;
        buf.push(cur);
        i++;
      }
      const cleaned = trimBlankEdges(buf);
      if (cleaned.length > 0) {
        const headerLine = cleaned[0]!.trim();
        const bodyLines = cleaned.slice(1);
        const bodyText = bodyLines.join("\n");
        const execMatch = EXEC_RESULT_RE.exec(headerLine);
        const cmdText = execMatch ? execMatch[1]!.trim() : headerLine;
        const isExit = execMatch?.[2]?.startsWith("exited");
        const exitCode = execMatch?.[3] ? Number(execMatch[3]) : isExit ? 1 : 0;
        const duration = execMatch?.[4];
        const failed = exitCode !== 0;
        const bodyLinesCount = bodyLines.length;
        const isLongOutput = bodyLinesCount > 6 || bodyText.length > 400;
        const compactCmd = cmdText.length > 68 ? `${cmdText.slice(0, 65)}...` : cmdText;
        const statusTag = failed
          ? t(language, "console.block.execExitCode", { code: exitCode })
          : duration
            ? t(language, "console.block.execSuccess", { duration })
            : t(language, "console.block.execRunning");
        const countTag = bodyLinesCount > 0 ? t(language, "console.block.execOutputLines", { count: bodyLinesCount }) : "";
        const fullContent = cleaned.join("\n");

        pushBlock({
          kind: "tool_call",
          title: t(language, failed ? "console.block.execFailed" : "console.block.execOk"),
          summary: `${compactCmd} · ${statusTag}${countTag}`,
          content: fullContent,
          defaultCollapsed: !failed && isLongOutput,
          collapsible: bodyLinesCount > 0,
          tone: failed ? "danger" : "info",
          meta: {
            command: cmdText,
            ...(duration ? { duration } : {}),
            ...(failed ? { exitCode } : {}),
          },
        });
      }
      continue;
    }

    // 7. Errors & rate limits
    if (isErrorStart(trimmed)) {
      const buf: string[] = [];
      const firstLine = trimmed.startsWith(QODER_ERR_PREFIX)
        ? trimmed.slice(QODER_ERR_PREFIX.length).trim()
        : rawLine;
      buf.push(firstLine);
      i++;
      // Collect continuation stack / indented / JSON error lines until next boundary or blank line
      while (i < lines.length) {
        const cur = lines[i]!;
        const t = cur.trim();
        if (!t) break;
        if (isBlockBoundary(lines, i) && !isErrorStart(t)) break;
        if (
          /^(?:\s+|at\s+|Caused by:|\{|\}|\[|\]|"|Error:|ERROR:)/i.test(cur) ||
          isErrorStart(t)
        ) {
          buf.push(t.startsWith(QODER_ERR_PREFIX) ? t.slice(QODER_ERR_PREFIX.length).trim() : cur);
          i++;
          continue;
        }
        break;
      }
      const formatted = formatErrorContent(trimBlankEdges(buf).join("\n"));
      pushBlock({
        kind: "error",
        title: t(language, "console.block.error"),
        summary: previewFirstLine(formatted, 80),
        content: formatted,
        defaultCollapsed: false,
        collapsible: countLines(formatted) > 12,
        tone: "danger",
      });
      continue;
    }

    // 8. Main Agent reply & general stdout text
    const isAgentMarker = trimmed === "codex" || trimmed === "assistant";
    if (isAgentMarker) {
      i++;
    }
    const buf: string[] = [];
    let inFence = false;
    if (!isAgentMarker) {
      if (/^```/.test(trimmed)) inFence = true;
      buf.push(rawLine);
      i++;
    }
    while (i < lines.length) {
      const cur = lines[i]!;
      const t = cur.trim();
      if (/^```/.test(t)) {
        inFence = !inFence;
        buf.push(cur);
        i++;
        continue;
      }
      if (!inFence && t && isBlockBoundary(lines, i)) {
        // Keep merging consecutive plain message paragraphs, break on non-message markers
        if (t === "codex" || t === "assistant") {
          i++;
          continue;
        }
        break;
      }
      buf.push(cur);
      i++;
    }
    const content = trimBlankEdges(buf).join("\n");
    if (content) {
      pushBlock({
        kind: "message",
        title: t(language, isAgentMarker ? "console.block.agentReply" : "console.block.stdout"),
        summary: previewFirstLine(content, 72),
        content,
        defaultCollapsed: false,
        collapsible: false,
        tone: "neutral",
      });
    }
  }

  return blocks;
}

/** Shortens long worktree or absolute workspace paths for compact UI display. */
export function shortenDisplayPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const wtMatch = /\/\.workbench-hub\/[^/]+\/worktrees\/[^/]+\/REQ-\d+\/(.+)$/.exec(trimmed);
  if (wtMatch?.[1]) return wtMatch[1];
  const repoMarker = /\/((?:src|tests|\.workbench)\/.+)$/.exec(trimmed);
  if (repoMarker?.[1] && trimmed.startsWith("/")) return repoMarker[1];
  if (trimmed.length > 68 && trimmed.includes("/")) {
    const parts = trimmed.split("/").filter(Boolean);
    if (parts.length > 3) return `…/${parts.slice(-3).join("/")}`;
  }
  return trimmed;
}

function classifyAgyTool(toolName: string, input: unknown): RunToolCategory {
  if (input && typeof input === "object") {
    const rec = input as Record<string, unknown>;
    const cmd = typeof rec.CommandLine === "string" ? rec.CommandLine : typeof rec.command === "string" ? rec.command : "";
    if (/(?:^|[;&|\s(])wb\s+(propose|verify|tasks|screenshot|get|list|show)\b/.test(cmd)) return "wb_cli";
  }
  const lower = toolName.trim().toLowerCase();
  if (/^(?:bash|sh|shell|exec|run_command|execute|terminal)$/.test(lower)) return "bash";
  if (lower.startsWith("mcp__") || lower.includes("mcp")) return "mcp";
  if (/subagent|invoke_subagent|delegate|spawn_agent/.test(lower)) return "subagent";
  if (/web_search|search_web|fetch|read_url|browser/.test(lower)) return "web";
  if (/write|edit|replace|patch|create_file|delete_file|notebook_edit|sed_file/.test(lower)) return "write";
  if (/grep|glob|search|find|list_dir/.test(lower)) return "search";
  if (/read|view|cat|open_file/.test(lower)) return "read";
  return "other";
}

function summarizeAgyParams(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const rec = input as Record<string, unknown>;
  const raw =
    typeof rec.CommandLine === "string"
      ? rec.CommandLine
      : typeof rec.command === "string"
        ? rec.command
        : typeof rec.Path === "string"
          ? rec.Path
          : typeof rec.AbsolutePath === "string"
            ? rec.AbsolutePath
            : typeof rec.TargetFile === "string"
              ? rec.TargetFile
              : typeof rec.file_path === "string"
                ? rec.file_path
                : typeof rec.DirectoryPath === "string"
                  ? rec.DirectoryPath
                  : typeof rec.SearchPath === "string"
                    ? rec.SearchPath
                    : typeof rec.Query === "string"
                      ? rec.Query
                      : typeof rec.Pattern === "string"
                        ? rec.Pattern
                        : "";
  return raw.replace(/\s+/g, " ").trim().slice(0, 120);
}

function extractAgyFiles(cat: RunToolCategory, input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const rec = input as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ["Path", "AbsolutePath", "TargetFile", "file_path", "path", "DirectoryPath", "SearchPath"]) {
    const v = rec[k];
    if (typeof v === "string" && v.trim() && v.length < 400 && !v.includes("\n")) {
      if (!out.includes(v.trim())) out.push(v.trim());
    }
  }
  return cat === "bash" ? [] : out.slice(0, 12);
}

function parseAgyUsage(raw: Record<string, unknown>): RunTokenUsage {
  const uncached = Math.max(0, Math.floor(Number(raw.input_tokens) || 0));
  const cacheRead = Math.max(0, Math.floor(Number(raw.cache_read_tokens ?? raw.cache_read_input_tokens) || 0));
  const rawOutput = Math.max(0, Math.floor(Number(raw.output_tokens) || 0));
  const thinking = Math.max(0, Math.floor(Number(raw.thinking_tokens ?? raw.reasoning_tokens) || 0));
  const rawTotal = Math.max(0, Math.floor(Number(raw.total_tokens) || 0));
  const thinkingIncluded = thinking > 0 && (rawTotal === uncached + rawOutput || (rawTotal === 0 && thinking <= rawOutput));
  const output = thinkingIncluded ? Math.max(0, rawOutput - thinking) : rawOutput;
  const inputTokens = uncached + cacheRead;
  return {
    inputTokens,
    uncachedInputTokens: uncached,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
    outputTokens: output,
    reasoningTokens: thinking,
    totalTokens: inputTokens + output + thinking,
  };
}

/**
 * Reconstructs structured `RunTraceEvent[]` from historical AGY NDJSON raw logs or `raw.line` traces
 * so older persisted AGY runs render cleanly in the structured trace view.
 */
export function reconstructAgyTraceEvents(
  rawLog: string,
  existingTrace?: RunTraceEvent[],
): RunTraceEvent[] | null {
  const sourceLines: Array<{ text: string; ts?: number }> = [];
  if (rawLog.trim()) {
    for (const l of stripAnsi(rawLog).split("\n")) {
      if (l.trim()) sourceLines.push({ text: l.trim() });
    }
  } else if (existingTrace && existingTrace.length > 0) {
    for (const ev of existingTrace) {
      if (ev.type === "raw.line") {
        for (const l of stripAnsi(ev.text).split("\n")) {
          if (l.trim()) sourceLines.push({ text: l.trim(), ts: ev.ts });
        }
      }
    }
  }

  const hasAgyEnvelope = sourceLines.some((l) => isAgyJsonLine(l.text));
  if (!hasAgyEnvelope) return null;

  const reconstructed: RunTraceEvent[] = [];
  let seq = 0;
  const baseTs = existingTrace?.[0]?.ts ?? Date.now();
  const push = (ev: Record<string, unknown>, ts?: number) => {
    seq += 1;
    reconstructed.push({ ...ev, seq, ts: ts ?? baseTs + seq } as RunTraceEvent);
  };

  if (existingTrace) {
    for (const ev of existingTrace) {
      if (ev.type === "run.init" || ev.type === "handoff.snapshot") {
        push({ ...ev }, ev.ts);
      }
    }
  }

  let turnIndex = 0;
  let hasReply = false;
  let lastErrorMsg = "";
  const stepTurns = new Map<number, number>();
  const pendingText = new Map<number, string>();
  const pendingThink = new Map<number, string>();
  const startedTools = new Set<string>();
  const completedTools = new Set<string>();
  const completedTurns = new Set<number>();

  const formatAgyOutput = (raw: unknown): string | undefined => {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw === "string") return raw.length > 32 * 1024 ? `${raw.slice(0, 16 * 1024)}\n…\n${raw.slice(-16 * 1024)}` : raw;
    try {
      const s = JSON.stringify(raw, null, 2);
      return s.length > 32 * 1024 ? `${s.slice(0, 16 * 1024)}\n…\n${s.slice(-16 * 1024)}` : s;
    } catch {
      return String(raw);
    }
  };

  const formatAgyError = (errObj: unknown, fallbackOutput: unknown): string => {
    if (typeof errObj === "string" && errObj.trim()) return errObj.trim();
    if (errObj && typeof errObj === "object") {
      const rec = errObj as Record<string, unknown>;
      const errType = typeof rec.type === "string" ? rec.type.trim() : "";
      const msg = typeof rec.message === "string" ? rec.message.trim() : "";
      if (errType && msg) return `${errType}: ${msg}`;
      if (msg) return msg;
      if (errType) return errType;
    }
    return formatAgyOutput(fallbackOutput) ?? "Tool failed";
  };

  const pushErrorUnique = (msg: string, ts?: number) => {
    const clean = msg.trim();
    if (!clean) return;
    if (lastErrorMsg && (lastErrorMsg === clean || lastErrorMsg.includes(clean) || clean.includes(lastErrorMsg))) {
      return;
    }
    lastErrorMsg = clean;
    push({ type: "run.error", message: clean }, ts);
  };

  const ensureTurn = (stepIdx: number, ts?: number): number => {
    const existing = stepTurns.get(stepIdx);
    if (existing !== undefined) return existing;
    turnIndex += 1;
    stepTurns.set(stepIdx, turnIndex);
    push({ type: "turn.start", turnIndex }, ts);
    return turnIndex;
  };

  for (const line of sourceLines) {
    const trimmed = line.text;
    if (trimmed.startsWith("AGY_ERROR:")) {
      try {
        const errObj = JSON.parse(trimmed.slice("AGY_ERROR:".length).trim()) as Record<string, unknown>;
        const msg = typeof errObj.short_error === "string" ? errObj.short_error : trimmed;
        pushErrorUnique(msg, line.ts);
        continue;
      } catch {
        // ignore
      }
    }
    if (!trimmed.startsWith("{")) continue;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (evt.event === "step_update" && evt.step_update && typeof evt.step_update === "object") {
      const su = evt.step_update as Record<string, unknown>;
      const stepIdx = typeof su.step_index === "number" ? su.step_index : 0;
      const state = String(su.state ?? "").toUpperCase();
      const stepType = String(su.step_type ?? "");

      if (stepType === "agent_response") {
        const thinkChunk =
          typeof su.thinking_delta === "string"
            ? su.thinking_delta
            : typeof su.thinking === "string"
              ? su.thinking
              : "";
        if (thinkChunk) pendingThink.set(stepIdx, (pendingThink.get(stepIdx) ?? "") + thinkChunk);
        const delta = typeof su.text_delta === "string" ? su.text_delta : typeof su.text === "string" ? su.text : "";
        if (delta) pendingText.set(stepIdx, (pendingText.get(stepIdx) ?? "") + delta);

        if (state === "DONE" || state === "ERROR") {
          const turn = ensureTurn(stepIdx, line.ts);
          const thinkTxt = (pendingThink.get(stepIdx) ?? "").trim();
          pendingThink.delete(stepIdx);
          if (thinkTxt) push({ type: "thinking", turnIndex: turn, text: thinkTxt }, line.ts);

          const bodyTxt = (pendingText.get(stepIdx) ?? "").trim();
          pendingText.delete(stepIdx);
          if (bodyTxt) {
            hasReply = true;
            push({ type: "assistant.message", turnIndex: turn, text: bodyTxt }, line.ts);
          }

          if (!completedTurns.has(stepIdx)) {
            completedTurns.add(stepIdx);
            const usage = su.usage && typeof su.usage === "object" ? parseAgyUsage(su.usage as Record<string, unknown>) : undefined;
            const durationMs =
              typeof su.duration_seconds === "number" ? Math.round(su.duration_seconds * 1000) : undefined;
            push(
              {
                type: "turn.end",
                turnIndex: turn,
                ...(durationMs !== undefined ? { durationMs } : {}),
                ...(usage && usage.inputTokens > 0 ? { contextTokens: usage.inputTokens } : {}),
                ...(usage ? { usage } : {}),
              },
              line.ts,
            );
          }
        }
      } else if (stepType === "tool") {
        const callId = `agy-step-${stepIdx}`;
        const toolInfo = (su.tool_info && typeof su.tool_info === "object" ? su.tool_info : {}) as Record<string, unknown>;
        const toolName = String(su.tool_name ?? toolInfo.name ?? "tool");
        const params = toolInfo.parameters ?? toolInfo.input;
        const cat = classifyAgyTool(toolName, params);
        const summary = summarizeAgyParams(params);
        const files = extractAgyFiles(cat, params);
        const paramsRec = params && typeof params === "object" ? (params as Record<string, unknown>) : null;
        const cmdStr =
          paramsRec && typeof paramsRec.CommandLine === "string"
            ? paramsRec.CommandLine
            : paramsRec && typeof paramsRec.command === "string"
              ? paramsRec.command
              : paramsRec && typeof paramsRec.cmd === "string"
                ? paramsRec.cmd
                : "";
        const lowerTool = toolName.trim().toLowerCase();
        const wbToolMatch = /^(?:mcp__.*__)?wb_(list|get|propose|update_tasks|verify|screenshot)$/.exec(lowerTool);
        const wbCmdMatch = /(?:^|[;&|\s(])wb\s+(propose|verify|tasks|screenshot|get|list|show)\b/.exec(cmdStr);
        const wbCommand = wbToolMatch ? `wb_${wbToolMatch[1]}` : wbCmdMatch ? `wb ${wbCmdMatch[1]}` : undefined;
        const turn = turnIndex > 0 ? turnIndex : ensureTurn(stepIdx, line.ts);

        if ((state === "ACTIVE" || state === "DONE" || state === "ERROR") && !startedTools.has(callId)) {
          startedTools.add(callId);
          let inputText: string | undefined;
          if (params !== undefined && params !== null) {
            try {
              inputText = JSON.stringify(params, null, 2);
            } catch {
              inputText = String(params);
            }
          }
          push(
            {
              type: "tool.start",
              turnIndex: turn,
              callId,
              toolName,
              category: cat,
              summary,
              ...(inputText ? { inputText } : {}),
              ...(files.length > 0 ? { filesTouched: files } : {}),
              ...(wbCommand ? { wbCommand } : {}),
            },
            line.ts,
          );
        }
        if ((state === "DONE" || state === "ERROR") && !completedTools.has(callId)) {
          completedTools.add(callId);
          const isError = state === "ERROR" || Boolean(toolInfo.error);
          const output = isError
            ? formatAgyError(toolInfo.error, toolInfo.output)
            : formatAgyOutput(toolInfo.output);
          const durationMs =
            typeof su.duration_seconds === "number" ? Math.round(su.duration_seconds * 1000) : undefined;
          push(
            {
              type: "tool.end",
              turnIndex: turn,
              callId,
              toolName,
              category: cat,
              summary,
              ...(output !== undefined ? { output } : {}),
              ...(isError ? { isError: true } : {}),
              ...(durationMs !== undefined ? { durationMs } : {}),
              ...(files.length > 0 ? { filesTouched: files } : {}),
              ...(wbCommand ? { wbCommand } : {}),
            },
            line.ts,
          );
        }
      }
    } else if (evt.event === "result" && evt.result && typeof evt.result === "object") {
      const res = evt.result as Record<string, unknown>;
      const status = String(res.status ?? "").toUpperCase();
      if (status === "ERROR" || res.is_error === true) {
        const msg = typeof res.error === "string" && res.error.trim() ? res.error.trim() : "AGY execution failed";
        pushErrorUnique(msg, line.ts);
      } else if (!hasReply && typeof res.response === "string" && res.response.trim()) {
        hasReply = true;
        push({ type: "assistant.message", turnIndex: Math.max(1, turnIndex), text: res.response.trim() }, line.ts);
      }
    }
  }

  for (const [stepIdx, thinkTxt] of pendingThink.entries()) {
    if (!thinkTxt.trim()) continue;
    const turn = ensureTurn(stepIdx);
    push({ type: "thinking", turnIndex: turn, text: thinkTxt.trim() });
  }

  for (const [stepIdx, txt] of pendingText.entries()) {
    if (!txt.trim()) continue;
    const turn = ensureTurn(stepIdx);
    push({ type: "assistant.message", turnIndex: turn, text: txt.trim() });
  }

  if (existingTrace) {
    for (const ev of existingTrace) {
      if (ev.type === "run.end" || ev.type === "trace.truncated") {
        push({ ...ev }, ev.ts);
      }
    }
  }

  return reconstructed.length > 0 ? reconstructed : null;
}
