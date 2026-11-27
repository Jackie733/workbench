import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Search,
  Sparkles,
  Square,
} from "lucide-react";
import type { AgentRunRecord, RunTraceEvent } from "../../core/types.ts";
import { t, type UiLanguage } from "../i18n.ts";
import { shortenDisplayPath } from "../lib/consoleFormat.ts";
import type { LiveStreamDelta } from "../stores/streamStore.ts";
import { ConsoleMarkdown } from "./ConsoleMarkdown.tsx";
import { Icon } from "./Icon.tsx";
import { LiveTimer } from "./Primitives.tsx";
import { AsyncButton } from "./ui/async-button.tsx";

interface LiveToolStep {
  callId: string;
  toolName: string;
  category: string;
  summary: string;
  ended: boolean;
  isError: boolean;
}

function stripCommandHeader(rawLog: string): string {
  const withoutCmd = rawLog.replace(/^\$ [^\n]*\n?/, "");
  return withoutCmd
    .split(/\r?\n/)
    .filter((line) => !/^\u26A1\s|^session id:/i.test(line.trim()))
    .join("\n")
    .trim();
}

export function DiscussStreamCard({
  run,
  traceEvents,
  liveDelta,
  rawLog,
  language,
  onStop,
}: {
  run: AgentRunRecord;
  traceEvents?: RunTraceEvent[];
  liveDelta?: LiveStreamDelta;
  rawLog: string;
  language: UiLanguage;
  onStop: () => Promise<void>;
}) {
  const [stepsExpanded, setStepsExpanded] = useState(false);

  const derived = useMemo(() => {
    const tools: LiveToolStep[] = [];
    const toolIndexById = new Map<string, number>();
    const thinkingBlocks: string[] = [];
    const assistantMessages: string[] = [];

    for (const ev of traceEvents ?? []) {
      if (ev.type === "thinking" && ev.text.trim()) {
        thinkingBlocks.push(ev.text.trim());
      } else if (ev.type === "assistant.message" && ev.text.trim()) {
        assistantMessages.push(ev.text.trim());
      } else if (ev.type === "tool.start") {
        const idx = tools.length;
        toolIndexById.set(ev.callId, idx);
        tools.push({
          callId: ev.callId,
          toolName: ev.toolName,
          category: ev.category,
          summary: ev.summary,
          ended: false,
          isError: false,
        });
      } else if (ev.type === "tool.end") {
        const idx = toolIndexById.get(ev.callId);
        if (idx !== undefined && tools[idx]) {
          tools[idx] = {
            ...tools[idx]!,
            ended: true,
            isError: Boolean(ev.isError),
          };
        } else {
          tools.push({
            callId: ev.callId,
            toolName: ev.toolName,
            category: ev.category,
            summary: ev.summary,
            ended: true,
            isError: Boolean(ev.isError),
          });
        }
      }
    }

    const liveThinking = liveDelta?.thinking?.trim() ?? "";
    const allThinking = [...thinkingBlocks, ...(liveThinking ? [liveThinking] : [])];

    const liveText = liveDelta?.text ?? "";
    const structuredAnswer = [...assistantMessages, ...(liveText ? [liveText] : [])].join("\n\n").trim();

    const hasStructuredActivity =
      tools.length > 0 || allThinking.length > 0 || structuredAnswer.length > 0;
    const fallbackText = !hasStructuredActivity ? stripCommandHeader(rawLog) : "";
    const answerMarkdown = structuredAnswer || fallbackText;

    const runningTool = [...tools].reverse().find((item) => !item.ended) ?? null;

    return {
      tools,
      allThinking,
      answerMarkdown,
      runningTool,
      isStreamingThinking: Boolean(liveThinking) && !liveText,
    };
  }, [traceEvents, liveDelta, rawLog]);

  const hasSteps = derived.tools.length > 0 || derived.allThinking.length > 0;
  const stepLabel = derived.runningTool
    ? `${t(language, "drawer.toolStepRunning", { tool: derived.runningTool.toolName })}${
        derived.runningTool.summary ? ` · ${shortenDisplayPath(derived.runningTool.summary)}` : ""
      }`
    : derived.isStreamingThinking
      ? t(language, "drawer.thinkingLive")
      : derived.tools.length > 0
        ? t(language, "drawer.toolStepsSummary", { count: derived.tools.length })
        : t(language, "drawer.thinkingLive");

  return (
    <div className="discuss-msg agent discuss-streaming" data-testid="discuss-stream-card">
      <div className="discuss-ai-head">
        <div className="discuss-ai-identity">
          <span className="discuss-ai-avatar is-live" aria-hidden="true">
            <Icon icon={Sparkles} size={14} />
          </span>
          <span className="discuss-ai-name">
            {run.harness} · {run.model}
          </span>
          <span className="discuss-live-pill">
            <Icon icon={Loader2} size={14} className="spin" />
            <span>{t(language, "drawer.askRunning")}</span>
            <span className="discuss-live-sep">·</span>
            <LiveTimer startedAt={run.startedAt} />
          </span>
        </div>
        <AsyncButton
          size="xs"
          type="button"
          variant="ghost"
          className="discuss-stop-btn"
          data-testid="stop-ask-btn"
          onAction={onStop}
        >
          <Icon icon={Square} size={14} /> {t(language, "drawer.stopAsk")}
        </AsyncButton>
      </div>

      {hasSteps && (
        <div className="discuss-steps-box" data-testid="discuss-stream-steps">
          <button
            type="button"
            className="discuss-steps-toggle"
            aria-expanded={stepsExpanded}
            onClick={() => setStepsExpanded((v) => !v)}
          >
            <Icon icon={stepsExpanded ? ChevronDown : ChevronRight} size={14} />
            {derived.runningTool || derived.isStreamingThinking ? (
              <Icon icon={Loader2} size={14} className="spin" />
            ) : (
              <Icon icon={Search} size={14} />
            )}
            <span className="discuss-steps-label">{stepLabel}</span>
          </button>

          {stepsExpanded && (
            <div className="discuss-steps-detail">
              {derived.tools.map((tool) => (
                <div key={tool.callId} className={`discuss-step-row ${tool.isError ? "is-error" : ""}`}>
                  {!tool.ended ? (
                    <Icon icon={Loader2} size={14} className="spin" />
                  ) : (
                    <Icon icon={tool.isError ? AlertTriangle : Check} size={14} />
                  )}
                  <span className="discuss-step-tool">{tool.toolName}</span>
                  {tool.summary && (
                    <span className="discuss-step-summary" title={tool.summary}>
                      {shortenDisplayPath(tool.summary)}
                    </span>
                  )}
                </div>
              ))}
              {derived.allThinking.length > 0 && (
                <div className="discuss-thinking-preview">
                  <ConsoleMarkdown
                    text={derived.allThinking[derived.allThinking.length - 1]!}
                    language={language}
                    variant="thinking"
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="discuss-stream-body" data-testid="discuss-stream-output">
        {derived.answerMarkdown ? (
          <div className="discuss-stream-md">
            <ConsoleMarkdown text={derived.answerMarkdown} language={language} />
            <span className="discuss-stream-cursor" aria-hidden="true" />
          </div>
        ) : (
          <div className="discuss-connecting-row">
            <span className="discuss-typing-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span>{t(language, "drawer.connecting")}</span>
          </div>
        )}
      </div>
    </div>
  );
}
