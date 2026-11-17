import { useEffect, useState } from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export type CollapsePhase = "closed" | "entering" | "opening" | "open" | "closing";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

/**
 * Coordinates expand/collapse mount lifecycle so inner panels paint at offset 0/hidden
 * before transitioning open, expose `.open` once settled, and hide cleanly after exit.
 */
export function useCollapsePhase(open: boolean, enterMs = 245, exitMs = 195): CollapsePhase {
  const [phase, setPhase] = useState<CollapsePhase>(open ? "open" : "closed");

  useEffect(() => {
    if (prefersReducedMotion()) {
      setPhase(open ? "open" : "closed");
      return;
    }

    if (open) {
      if (phase === "open") return;
      if (phase === "closed") {
        setPhase("entering");
        return;
      }
      if (phase === "entering" || phase === "closing") {
        let raf2 = 0;
        const raf1 = requestAnimationFrame(() => {
          raf2 = requestAnimationFrame(() => setPhase("opening"));
        });
        return () => {
          cancelAnimationFrame(raf1);
          if (raf2) cancelAnimationFrame(raf2);
        };
      }
      // phase === "opening"
      const timer = setTimeout(() => setPhase("open"), enterMs);
      return () => clearTimeout(timer);
    }

    if (phase === "closed") return;
    if (phase !== "closing") {
      setPhase("closing");
      return;
    }
    const timer = setTimeout(() => setPhase("closed"), exitMs);
    return () => clearTimeout(timer);
  }, [open, phase, enterMs, exitMs]);

  return phase;
}
