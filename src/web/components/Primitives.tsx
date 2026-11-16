import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { MessageSquare } from "lucide-react";
import type { AgentAction } from "../../core/types.ts";
import { useWorkbench } from "../context.tsx";
import { renderMarkdown } from "../render.ts";
import { activeRunnerChoice, collectModelOptions } from "../state.ts";
import { Icon } from "./Icon.tsx";

export function LiveTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = React.useState(() => Date.now());
  useEffect(() => {
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
  const html = React.useMemo(
    () => renderMarkdown(markdown, { annotatable, docLabel }),
    [markdown, annotatable, docLabel],
  );
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const slotGen = React.useRef(0);
  const [iconSlots, setIconSlots] = React.useState<Array<{ el: Element; key: string }>>([]);

  // Generated annotation buttons live inside dangerouslySetInnerHTML; mount the
  // shared icon into their marked slots via portals scoped to this view only.
  React.useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const gen = ++slotGen.current;
    const els = Array.from(root.querySelectorAll('[data-icon-slot="annotate"]'));
    setIconSlots(els.map((el, i) => ({ el, key: `${gen}-${i}` })));
  }, [html]);

  // Portal content bubbles through the React tree, not through the host div,
  // so use a native delegated listener to keep SVG/path clicks working too.
  const annotateRef = React.useRef(onAnnotate);
  annotateRef.current = onAnnotate;
  React.useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const btn = target.closest('[data-action="annotate-anchor"]');
      const anchor = btn?.getAttribute("data-anchor");
      if (anchor) annotateRef.current?.(anchor);
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, []);

  return (
    <>
      <div ref={containerRef} className={className} dangerouslySetInnerHTML={{ __html: html }} />
      {iconSlots.map(({ el, key }) => createPortal(<Icon icon={MessageSquare} size={14} />, el, key))}
    </>
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
  const { state, setSelectedRunnerKey } = useWorkbench();
  const modelOptions = collectModelOptions(state.harnesses);
  const choice = activeRunnerChoice(state.selectedRunnerKey, state.routing, stageAction);
  const selectedKey =
    state.selectedRunnerKey === "manual_copy"
      ? "manual_copy"
      : state.selectedRunnerKey || (choice.harness && choice.model ? `${choice.harness}::${choice.model}` : "");

  return (
    <select
      className="select xs"
      data-field="runner-select"
      data-testid={testId}
      value={selectedKey}
      onChange={(e) => setSelectedRunnerKey(e.target.value)}
    >
      <option value="">
        {includeManualCopy ? "自动路由" : "默认路由"}
        {choice.harness ? ` (${choice.harness}/${choice.model ?? ""})` : ""}
      </option>
      {modelOptions.map((o) => (
        <option key={o.key} value={o.key}>
          {o.label}
        </option>
      ))}
      {includeManualCopy && <option value="manual_copy">仅生成提示词 (手动复制)</option>}
    </select>
  );
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" data-testid={testId}>
        {children}
      </div>
    </div>
  );
}

export function ToastBanner() {
  const { state } = useWorkbench();
  if (!state.toast) return null;
  return (
    <div className={`toast ${state.toast.isError ? "error" : ""}`} role="status">
      {state.toast.message}
    </div>
  );
}
