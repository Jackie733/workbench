"use client";

import { ArrowDown } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { cn } from "../../lib/utils.ts";
import { Icon } from "../Icon.tsx";
import { Button, type ButtonProps } from "../ui/button.tsx";

export type ChatJumpToLatestButtonProps = Omit<
  ButtonProps,
  "children" | "size" | "variant"
> & {
  children: ReactNode;
};

export function ChatJumpToLatestButton({
  className,
  children,
  ...props
}: ChatJumpToLatestButtonProps): ReactElement {
  return (
    <div
      data-slot="chat-jump-to-latest"
      className="rounded-full bg-popover/90 shadow-md backdrop-blur-xs"
    >
      <Button
        type="button"
        variant="outline"
        size="xs"
        className={cn(
          "pointer-events-auto gap-1.5 rounded-full before:rounded-full",
          className,
        )}
        {...props}
      >
        <Icon icon={ArrowDown} size={14} />
        {children}
      </Button>
    </div>
  );
}
