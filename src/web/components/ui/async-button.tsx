"use client";

import { useRef, useState, type MouseEvent, type ReactElement } from "react";
import { useUiStore } from "../../stores/uiStore.ts";
import { Button, type ButtonProps } from "./button.tsx";

export interface AsyncButtonProps extends Omit<ButtonProps, "onClick" | "loading"> {
  /** 点击后执行的异步动作；允许返回任意值。 */
  onAction: (event: MouseEvent<HTMLButtonElement>) => Promise<unknown> | unknown;
  /** 外部追加的 loading（例如 react-query mutation 状态）。 */
  loading?: boolean;
}

/**
 * 局部异步按钮：只让实际被点击的按钮显示 loading，并同步阻止同一 tick 的重复点击。
 * 不复用全局 busy 作为 loading，避免任意操作进行时页面所有按钮一起转圈。
 */
export function AsyncButton({ onAction, loading, disabled, ...props }: AsyncButtonProps): ReactElement {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);

  const handleClick = async (event: MouseEvent<HTMLButtonElement>) => {
    if (pendingRef.current || disabled) return;
    // 必须在 setPending 之前同步置位，才能拦住 React 尚未重渲染时的第二次点击。
    pendingRef.current = true;
    setPending(true);
    try {
      await onAction(event);
    } catch (error) {
      useUiStore.getState().showToastError(error);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <Button
      {...props}
      data-pending={pending ? "" : undefined}
      disabled={Boolean(disabled)}
      loading={Boolean(loading || pending)}
      onClick={handleClick}
    />
  );
}
