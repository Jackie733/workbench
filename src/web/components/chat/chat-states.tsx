"use client";

import type { ReactElement, ReactNode } from "react";
import { cn } from "../../lib/utils.ts";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty.tsx";

export function ChatEmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <Empty className={cn("px-4 py-8 md:py-10 gap-4", className)}>
      <EmptyHeader>
        <EmptyMedia variant="icon" className="mb-3">
          {icon}
        </EmptyMedia>
        <EmptyTitle className="text-sm font-semibold">{title}</EmptyTitle>
        {description && (
          <EmptyDescription className="mt-1 text-xs leading-relaxed">
            {description}
          </EmptyDescription>
        )}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}
