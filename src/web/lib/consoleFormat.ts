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
  /^(?:\[(?:spawn error|timeout|error)\]|(?:API error|FATAL|Unhandled(?:Rejection| Exception)?|SyntaxError|TypeError|ReferenceError|RangeError|ERROR|Error)\s*:|.*(?:RESOURCE_EXHAUSTED|You've hit your usage limit|\b429\s+Too Many Requests\b|(?:HTTP|status|code)\s*[:=]\s*429\b))/i;

const EXEC_RESULT_RE = /^(.+?)\s+(?:in\s+.+?\s+)?(succeeded|exited\s+(-?\d+))\s+in\s+([^\s:]+):?$/;

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

function isStructuralBoundary(lines: string[], idx: number): boolean {
  const line = lines[idx] ?? "";
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (idx === 0 && trimmed.startsWith("$ ")) return true;
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

  while (i < lines.length) {
    const rawLine = lines[i]!;
    const trimmed = rawLine.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // 1. Startup command & CLI session environment banner
    if (
      (i === 0 && trimmed.startsWith("$ ")) ||
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

    // 5. Thinking blocks (Qoder 💭 or Codex `thinking`)
    if (trimmed.startsWith(QODER_THINK_PREFIX) || trimmed === "thinking") {
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

    // 6. Tool calls (Qoder 🔧 or Codex `exec`)
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
