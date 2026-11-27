"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type RefObject,
} from "react";
import { cn } from "../../lib/utils.ts";
import { ScrollArea } from "./scroll-area.tsx";

export interface ComposerSubmitDetails {
  text: string;
}

export interface ComposerProps
  extends Omit<ComponentProps<"form">, "onSubmit" | "defaultValue"> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  onSubmit?: (details: ComposerSubmitDetails, event?: FormEvent<HTMLFormElement>) => void;
  disabled?: boolean;
  readOnly?: boolean;
  submitDisabled?: boolean;
  allowEmpty?: boolean;
  submitOnEnter?: boolean;
}

interface ComposerContextValue {
  value: string;
  setValue: (next: string) => void;
  isEmpty: boolean;
  canSubmit: boolean;
  disabled: boolean;
  readOnly: boolean;
  submitOnEnter: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  submit: (event?: FormEvent<HTMLFormElement>) => void;
}

const ComposerContext = createContext<ComposerContextValue | null>(null);

export function useComposerContext(): ComposerContextValue {
  const ctx = useContext(ComposerContext);
  if (!ctx) {
    throw new Error("Composer subcomponents must be used within <Composer>.");
  }
  return ctx;
}

function isInteractiveChild(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      "button, a, select, input, textarea, [role='button'], [role='combobox'], [data-slot='composer-header'], [data-slot='composer-actions']",
    ),
  );
}

export function Composer({
  value: controlledValue,
  defaultValue = "",
  onValueChange,
  onSubmit,
  disabled = false,
  readOnly = false,
  submitDisabled = false,
  allowEmpty = false,
  submitOnEnter = true,
  className,
  children,
  onMouseDown,
  onClick,
  ...formProps
}: ComposerProps): ReactElement {
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const value = controlledValue ?? uncontrolledValue;
  const isEmpty = value.trim().length === 0;
  const canSubmit = !disabled && !submitDisabled && (allowEmpty || !isEmpty);

  const setValue = useCallback(
    (next: string) => {
      if (controlledValue === undefined) {
        setUncontrolledValue(next);
      }
      onValueChange?.(next);
    },
    [controlledValue, onValueChange],
  );

  const submit = useCallback(
    (event?: FormEvent<HTMLFormElement>) => {
      if (!canSubmit) return;
      onSubmit?.({ text: value }, event);
    },
    [canSubmit, onSubmit, value],
  );

  const handleFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit(event);
  };

  const focusIfFrameClicked = (target: EventTarget | null) => {
    if (disabled || isInteractiveChild(target)) return;
    inputRef.current?.focus();
  };

  return (
    <ComposerContext.Provider
      value={{
        value,
        setValue,
        isEmpty,
        canSubmit,
        disabled,
        readOnly,
        submitOnEnter,
        inputRef,
        submit,
      }}
    >
      <form
        data-slot="composer"
        data-disabled={disabled ? "" : undefined}
        data-readonly={readOnly ? "" : undefined}
        className={cn(
          "relative flex min-h-0 min-w-0 cursor-text flex-col rounded-2xl border border-input bg-background not-dark:bg-clip-padding text-foreground shadow-xs/5 ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl,1rem)-1px)] focus-within:border-ring focus-within:shadow-none focus-within:ring-[3px] focus-within:before:shadow-none not-data-disabled:not-focus-within:before:shadow-[0_1px_--theme(--color-black/4%)] data-disabled:cursor-default data-disabled:opacity-64 dark:bg-input/32 dark:not-data-disabled:not-focus-within:before:shadow-[0_-1px_--theme(--color-white/6%)]",
          className,
        )}
        onSubmit={handleFormSubmit}
        onMouseDown={(event: MouseEvent<HTMLFormElement>) => {
          onMouseDown?.(event);
          if (!event.defaultPrevented && event.button === 0 && !isInteractiveChild(event.target)) {
            // Keep focus smooth when clicking frame padding around textarea.
            event.preventDefault();
            inputRef.current?.focus();
          }
        }}
        onClick={(event: MouseEvent<HTMLFormElement>) => {
          onClick?.(event);
          if (!event.defaultPrevented) {
            focusIfFrameClicked(event.target);
          }
        }}
        {...formProps}
      >
        {children}
      </form>
    </ComposerContext.Provider>
  );
}

export function ComposerHeader({
  className,
  ...props
}: ComponentProps<"div">): ReactElement {
  return (
    <div
      data-slot="composer-header"
      className={cn(
        "flex flex-col gap-1.5 border-b border-border/60 px-3 py-2 text-xs",
        className,
      )}
      {...props}
    />
  );
}

export function ComposerInput({
  className,
  rows = 2,
  onChange,
  onKeyDown,
  ...props
}: ComponentProps<"textarea">): ReactElement {
  const ctx = useComposerContext();
  const localRef = useRef<HTMLTextAreaElement | null>(null);

  const setMergedRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      localRef.current = node;
      ctx.inputRef.current = node;
    },
    [ctx.inputRef],
  );

  useEffect(() => {
    const el = localRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(el.scrollHeight, 44)}px`;
  }, [ctx.value]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key !== "Enter") return;

    const modSubmit = event.metaKey || event.ctrlKey;
    const plainEnterSubmit = ctx.submitOnEnter && !event.shiftKey && !event.altKey;
    if (modSubmit || plainEnterSubmit) {
      event.preventDefault();
      ctx.submit();
    }
  };

  return (
    <ScrollArea
      data-slot="composer-scroll-area"
      className="flex h-auto! min-h-0 min-w-0 flex-col rounded-t-[inherit] **:data-[slot=scroll-area-viewport]:h-auto! **:data-[slot=scroll-area-viewport]:max-h-[168px] **:data-[slot=scroll-area-viewport]:min-h-0"
      overscrollContain
      scrollFade
    >
      <textarea
        ref={setMergedRef}
        data-slot="composer-input"
        rows={rows}
        disabled={ctx.disabled}
        readOnly={ctx.readOnly}
        value={ctx.value}
        onChange={(event) => {
          ctx.setValue(event.target.value);
          onChange?.(event);
        }}
        onKeyDown={handleKeyDown}
        className={cn(
          "block min-h-[44px] w-full min-w-0 resize-none overflow-hidden border-0 bg-transparent px-3 pt-2.5 pb-1.5 text-[13px] leading-[1.5] text-foreground outline-none placeholder:text-muted-foreground/75 disabled:cursor-default",
          className,
        )}
        {...props}
      />
    </ScrollArea>
  );
}

export function ComposerActions({
  className,
  ...props
}: ComponentProps<"div">): ReactElement {
  return (
    <div
      data-slot="composer-actions"
      className={cn(
        "flex flex-wrap items-center justify-between gap-1.5 px-2 pb-2 pt-1",
        className,
      )}
      {...props}
    />
  );
}

export function ComposerActionGroup({
  align = "start",
  className,
  ...props
}: ComponentProps<"div"> & { align?: "start" | "end" }): ReactElement {
  return (
    <div
      data-slot="composer-action-group"
      data-align={align}
      className={cn(
        "flex min-w-0 items-center gap-1",
        align === "end" && "ms-auto shrink-0",
        className,
      )}
      {...props}
    />
  );
}
