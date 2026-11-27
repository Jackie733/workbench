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
import {
  ChatBubble,
  ChatMessageAvatar,
  ChatMessageContent,
  ChatMessageHeader,
  ChatMessageLayout,
  ChatTypingIndicator,
} from "./chat/index.ts";
import { ConsoleMarkdown } from "./ConsoleMarkdown.tsx";
import { Icon } from "./Icon.tsx";
import { LiveTimer } from "./Primitives.tsx";
import { AsyncButton } from "./ui/async-button.tsx";
import { Badge } from "./ui/badge.tsx";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible.tsx";

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
    <ChatMessageLayout
      align="start"
      className="discuss-streaming"
      data-testid="discuss-stream-card"
    >
      <ChatMessageHeader className="w-full">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="font-semibold text-foreground">
            {run.harness} · {run.model}
          </span>
          <Badge variant="info" size="sm" className="gap-1">
            <Icon icon={Loader2} size={14} className="spin" />
            <span>{t(language, "drawer.askRunning")}</span>
            <span className="opacity-55">·</span>
            <LiveTimer startedAt={run.startedAt} />
          </Badge>
        </div>
        <AsyncButton
          size="xs"
          type="button"
          variant="ghost"
          className="h-6 shrink-0 px-2 text-destructive-foreground hover:bg-destructive/10 hover:text-destructive-foreground"
          data-testid="stop-ask-btn"
          onAction={onStop}
        >
          <Icon icon={Square} size={14} /> {t(language, "drawer.stopAsk")}
        </AsyncButton>
      </ChatMessageHeader>

      <ChatMessageAvatar>
        <span
          className="inline-flex size-7 items-center justify-center rounded-full border border-primary/40 bg-primary/10 text-primary"
          aria-hidden="true"
        >
          <Icon icon={Sparkles} size={14} />
        </span>
      </ChatMessageAvatar>

      <ChatMessageContent>
        <div className="flex w-full min-w-0 flex-col gap-2">
          {hasSteps && (
            <Collapsible
              open={stepsExpanded}
              onOpenChange={setStepsExpanded}
              className="rounded-xl border border-border/80 bg-muted/50 overflow-hidden"
              data-testid="discuss-stream-steps"
            >
              <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11.5px] text-muted-foreground transition-colors hover:text-foreground">
                <Icon icon={stepsExpanded ? ChevronDown : ChevronRight} size={14} />
                {derived.runningTool || derived.isStreamingThinking ? (
                  <Icon icon={Loader2} size={14} className="spin shrink-0" />
                ) : (
                  <Icon icon={Search} size={14} className="shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">{stepLabel}</span>
              </CollapsibleTrigger>

              <CollapsiblePanel>
                <div className="flex max-h-[180px] flex-col gap-1 overflow-y-auto border-t border-border/70 px-2.5 py-2">
                  {derived.tools.map((tool) => (
                    <div
                      key={tool.callId}
                      className={`flex items-center gap-1.5 text-[11.5px] ${
                        tool.isError ? "text-destructive-foreground" : "text-muted-foreground"
                      }`}
                    >
                      {!tool.ended ? (
                        <Icon icon={Loader2} size={14} className="spin shrink-0" />
                      ) : (
                        <Icon icon={tool.isError ? AlertTriangle : Check} size={14} className="shrink-0" />
                      )}
                      <span className="shrink-0 font-mono font-medium text-foreground">{tool.toolName}</span>
                      {tool.summary && (
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={tool.summary}>
                          {shortenDisplayPath(tool.summary)}
                        </span>
                      )}
                    </div>
                  ))}
                  {derived.allThinking.length > 0 && (
                    <div className="mt-1 border-t border-dashed border-border pt-1.5">
                      <ConsoleMarkdown
                        text={derived.allThinking[derived.allThinking.length - 1]!}
                        language={language}
                        variant="thinking"
                      />
                    </div>
                  )}
                </div>
              </CollapsiblePanel>
            </Collapsible>
          )}

          <div className="w-full min-w-0" data-testid="discuss-stream-output">
            {derived.answerMarkdown ? (
              <ChatBubble align="start" variant="card" className="w-full border-primary/35">
                <div className="discuss-ai-body">
                  <ConsoleMarkdown text={derived.answerMarkdown} language={language} />
                  <span className="discuss-stream-cursor" aria-hidden="true" />
                </div>
              </ChatBubble>
            ) : (
              <ChatTypingIndicator
                label={hasSteps ? t(language, "drawer.generatingLive") : t(language, "drawer.connecting")}
              />
            )}
          </div>
        </div>
      </ChatMessageContent>
    </ChatMessageLayout>
  );
}
