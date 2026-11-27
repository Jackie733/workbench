"use client";

import type { ReactElement, ReactNode } from "react";
import { cn } from "../../lib/utils.ts";
import { ChatBubble, type ChatBubbleProps } from "./chat-bubble.tsx";
import {
  ChatMessageAvatar,
  ChatMessageContent,
  ChatMessageFooter,
  ChatMessageHeader,
  ChatMessageLayout,
  type ChatMessageLayoutProps,
} from "./chat-message-layout.tsx";

export type ChatMessageProps = Omit<
  ChatMessageLayoutProps,
  "align" | "children"
> & {
  side: "incoming" | "outgoing";
  author?: ReactNode;
  avatar?: ReactNode;
  grouped?: boolean;
  children: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  bubble?: boolean;
  bubbleProps?: Omit<ChatBubbleProps, "align" | "grouped" | "children">;
};

export function ChatMessage({
  side,
  author,
  avatar,
  grouped = false,
  children,
  actions,
  footer,
  bubble = true,
  bubbleProps,
  ...props
}: ChatMessageProps): ReactElement {
  const own = side === "outgoing";
  return (
    <ChatMessageLayout align={own ? "end" : "start"} {...props}>
      {!own && !grouped && author && (
        <ChatMessageHeader>{author}</ChatMessageHeader>
      )}
      {!own && avatar && (
        <ChatMessageAvatar>
          {grouped ? <div className="size-7" aria-hidden="true" /> : avatar}
        </ChatMessageAvatar>
      )}
      <ChatMessageContent>
        <div
          className={cn(
            "flex w-full min-w-0 items-center gap-1.5",
            own ? "justify-end" : "justify-start",
          )}
        >
          {own && actions}
          {bubble ? (
            <ChatBubble
              align={own ? "end" : "start"}
              variant={bubbleProps?.variant ?? (own ? "default" : "card")}
              grouped={grouped}
              {...bubbleProps}
              className={cn(
                own ? "max-w-[88%]" : "w-full",
                bubbleProps?.className,
              )}
            >
              {children}
            </ChatBubble>
          ) : (
            children
          )}
          {!own && actions}
        </div>
        {footer && <ChatMessageFooter>{footer}</ChatMessageFooter>}
      </ChatMessageContent>
    </ChatMessageLayout>
  );
}
