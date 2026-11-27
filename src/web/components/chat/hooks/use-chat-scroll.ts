"use client";

import {
  type UIEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export type ChatScrollOptions = {
  active?: boolean;
  paused?: boolean;
  itemCount: number;
  layoutKey?: string | number;
  onReachEnd?: () => void;
};

export function useChatScroll({
  active = true,
  paused = false,
  itemCount,
  layoutKey,
  onReachEnd,
}: ChatScrollOptions) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const programmaticTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrollTopRef = useRef(0);
  const [showJump, setShowJump] = useState(false);

  const clearProgrammaticLock = useCallback(() => {
    programmaticScrollRef.current = false;
    if (programmaticTimerRef.current) {
      clearTimeout(programmaticTimerRef.current);
      programmaticTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearProgrammaticLock, [clearProgrammaticLock]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!active || paused || !viewport) return;
    if (atBottomRef.current) {
      viewport.scrollTop = viewport.scrollHeight;
      lastScrollTopRef.current = viewport.scrollTop;
      setShowJump(false);
    } else {
      setShowJump(
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 64,
      );
    }
  }, [active, paused, itemCount, layoutKey]);

  useEffect(() => {
    if (!active || paused) return;
    let observer: ResizeObserver | undefined;
    const frame = requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      observer = new ResizeObserver(() => {
        if (atBottomRef.current) {
          viewport.scrollTop = viewport.scrollHeight;
          lastScrollTopRef.current = viewport.scrollTop;
        }
      });
      observer.observe(viewport);
      if (viewport.firstElementChild) {
        observer.observe(viewport.firstElementChild);
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [active, paused]);

  const updatePosition = useCallback((): void => {
    const viewport = viewportRef.current;
    atBottomRef.current = Boolean(
      viewport &&
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 64,
    );
  }, []);

  const onScroll = (_event: UIEvent<HTMLDivElement>): void => {
    if (paused) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const currentTop = viewport.scrollTop;
    const distFromBottom = viewport.scrollHeight - currentTop - viewport.clientHeight;

    if (programmaticScrollRef.current) {
      const userScrolledUp = currentTop < lastScrollTopRef.current - 2;
      lastScrollTopRef.current = currentTop;
      if (distFromBottom < 64) {
        clearProgrammaticLock();
        atBottomRef.current = true;
        setShowJump(false);
        onReachEnd?.();
        return;
      }
      if (!userScrolledUp) {
        return;
      }
      clearProgrammaticLock();
    } else {
      lastScrollTopRef.current = currentTop;
    }

    updatePosition();
    setShowJump(!atBottomRef.current);
    if (atBottomRef.current) onReachEnd?.();
  };

  const resetScroll = useCallback(
    (atBottom = true): void => {
      clearProgrammaticLock();
      atBottomRef.current = atBottom;
      setShowJump(!atBottom);
      requestAnimationFrame(() => {
        const viewport = viewportRef.current;
        if (viewport) {
          viewport.scrollTop = atBottom ? viewport.scrollHeight : 0;
          lastScrollTopRef.current = viewport.scrollTop;
        }
      });
    },
    [clearProgrammaticLock],
  );

  const scrollToLatest = useCallback((): void => {
    atBottomRef.current = true;
    setShowJump(false);
    const viewport = viewportRef.current;
    if (!viewport) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    lastScrollTopRef.current = viewport.scrollTop;
    if (reduceMotion) {
      clearProgrammaticLock();
      viewport.scrollTop = viewport.scrollHeight;
      lastScrollTopRef.current = viewport.scrollTop;
      return;
    }
    clearProgrammaticLock();
    programmaticScrollRef.current = true;
    programmaticTimerRef.current = setTimeout(() => {
      clearProgrammaticLock();
      const el = viewportRef.current;
      if (!el) return;
      if (atBottomRef.current) {
        el.scrollTop = el.scrollHeight;
        lastScrollTopRef.current = el.scrollTop;
      }
    }, 650);
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: "smooth",
    });
  }, [clearProgrammaticLock]);

  return {
    viewportRef,
    atBottomRef,
    showJump,
    onScroll,
    resetScroll,
    updatePosition,
    scrollToLatest,
  };
}

export type ChatScrollController = ReturnType<typeof useChatScroll>;
