import type React from "react";
import { cn } from "../../lib/utils.ts";

export function Skeleton({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      aria-hidden="true"
      data-slot="skeleton"
      className={cn("ws-skeleton", className)}
      {...props}
    />
  );
}
