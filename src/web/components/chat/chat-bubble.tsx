"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type { ReactElement } from "react";
import { cn } from "../../lib/utils.ts";

export type ChatBubbleProps = useRender.ComponentProps<"div"> & {
  align?: "start" | "end";
  variant?: "default" | "muted" | "card";
  grouped?: boolean;
};

export function ChatBubble({
  align = "start",
  variant = "default",
  grouped = false,
  className,
  render,
  ...props
}: ChatBubbleProps): ReactElement {
  const defaultProps = {
    "data-slot": "chat-bubble",
    "data-align": align,
    "data-variant": variant,
    "data-grouped": grouped || undefined,
    className: cn(
      "relative flex min-w-0 flex-col gap-2 rounded-2xl px-3.5 py-2.5 text-foreground",
      variant === "default"
        ? "bg-primary/10 dark:bg-primary/15 border border-primary/15"
        : variant === "card"
          ? "bg-card border border-border shadow-2xs"
          : "bg-muted/80",
      !grouped && (align === "end" ? "rounded-se-md" : "rounded-ss-md"),
      className,
    ),
  };

  return useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">(defaultProps, props),
  });
}
