"use client";

import type { ComponentProps, ReactElement, ReactNode } from "react";
import { cn } from "../../lib/utils.ts";
import { ScrollAreaPrimitive, ScrollBar } from "../ui/scroll-area.tsx";
import { ChatJumpToLatestButton } from "./chat-jump-to-latest-button.tsx";
import type { ChatScrollController } from "./hooks/use-chat-scroll.ts";

export type ChatConversationProps = ComponentProps<"div"> & {
  scroll: ChatScrollController;
  label: string;
  jumpLabel: ReactNode;
  contentClassName?: string;
  viewportTestId?: string;
  jumpTestId?: string;
  overlay?: ReactNode;
  inactive?: boolean;
  live?: "polite" | "off";
};

export function ChatConversation({
  scroll,
  label,
  jumpLabel,
  contentClassName,
  viewportTestId,
  jumpTestId,
  children,
  overlay,
  inactive = false,
  live,
  className,
  ...props
}: ChatConversationProps): ReactElement {
  return (
    <div
      data-slot="chat-conversation"
      className={cn("relative isolate flex min-h-0 flex-1 flex-col", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Root
        inert={inactive}
        className="size-full min-h-0 touch-auto before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:z-10 before:h-5 before:bg-linear-to-b before:from-background before:to-transparent before:opacity-0 before:transition-opacity before:content-[''] after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:z-10 after:h-5 after:bg-linear-to-t after:from-background after:to-transparent after:opacity-0 after:transition-opacity after:content-[''] data-overflow-y-end:after:opacity-100 data-overflow-y-start:before:opacity-100"
      >
        <ScrollAreaPrimitive.Viewport
          ref={scroll.viewportRef}
          role="log"
          aria-label={label}
          aria-live={live}
          aria-relevant="additions text"
          data-slot="scroll-area-viewport"
          data-testid={viewportTestId}
          className="h-full rounded-[inherit] outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-has-overflow-y:overscroll-y-contain data-has-overflow-x:overscroll-x-contain"
          onScroll={scroll.onScroll}
        >
          <ScrollAreaPrimitive.Content
            data-slot="scroll-area-content"
            className={cn("flex flex-col gap-3 px-1 pb-3 pt-1", contentClassName)}
            style={{ minWidth: 0 }}
          >
            {children}
          </ScrollAreaPrimitive.Content>
        </ScrollAreaPrimitive.Viewport>
        <ScrollBar orientation="vertical" />
        <ScrollAreaPrimitive.Corner data-slot="scroll-area-corner" />
      </ScrollAreaPrimitive.Root>
      {scroll.showJump && !inactive && (
        <div className="pointer-events-none absolute inset-x-0 bottom-2.5 z-30 flex justify-center">
          <ChatJumpToLatestButton
            data-testid={jumpTestId}
            onClick={scroll.scrollToLatest}
          >
            {jumpLabel}
          </ChatJumpToLatestButton>
        </div>
      )}
      {overlay}
    </div>
  );
}
