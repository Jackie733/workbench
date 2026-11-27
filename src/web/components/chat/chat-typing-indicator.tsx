"use client";

import type { ComponentProps, ReactElement } from "react";
import { cn } from "../../lib/utils.ts";

export type ChatTypingIndicatorProps = Omit<ComponentProps<"div">, "children"> & {
  label: string;
  visible?: boolean;
};

export function ChatTypingIndicator({
  label,
  visible = true,
  className,
  ...props
}: ChatTypingIndicatorProps): ReactElement | null {
  if (!visible) return null;
  return (
    <div
      role="status"
      data-slot="chat-typing-indicator"
      className={cn("flex items-center gap-2.5 py-1", className)}
      {...props}
    >
      <div
        aria-hidden="true"
        className="flex items-center gap-1 rounded-2xl rounded-es-md bg-muted/80 px-3 py-2.5"
      >
        <span className="discuss-typing-dot block size-1.5 rounded-full bg-muted-foreground motion-reduce:animate-none" />
        <span className="discuss-typing-dot block size-1.5 rounded-full bg-muted-foreground [animation-delay:160ms] motion-reduce:animate-none" />
        <span className="discuss-typing-dot block size-1.5 rounded-full bg-muted-foreground [animation-delay:320ms] motion-reduce:animate-none" />
      </div>
      <span className="min-w-0 text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
