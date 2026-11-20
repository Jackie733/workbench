import { afterEach, describe, expect, test } from "bun:test";
import { resolveReloadUiAction } from "../../src/web/queries.ts";
import { RELOAD_PENDING_TOAST_ID, useUiStore } from "../../src/web/stores/uiStore.ts";

const base = { manual: false, modalOpen: false, busy: false, activeTag: undefined };

afterEach(() => {
  useUiStore.getState().setPendingWebReload(false);
});

describe("workbench.reload_ui 刷新门控矩阵", () => {
  test("空闲且无输入焦点时立即热刷新", () => {
    expect(resolveReloadUiAction(base)).toBe("reload-now");
    expect(resolveReloadUiAction({ ...base, activeTag: "BUTTON" })).toBe("reload-now");
    expect(resolveReloadUiAction({ ...base, activeTag: "DIV", contentEditable: false })).toBe("reload-now");
  });

  test("弹窗打开或忙碌时暂缓整页刷新", () => {
    expect(resolveReloadUiAction({ ...base, modalOpen: true })).toBe("defer");
    expect(resolveReloadUiAction({ ...base, busy: true })).toBe("defer");
    expect(resolveReloadUiAction({ ...base, modalOpen: true, busy: true, activeTag: "TEXTAREA" })).toBe("defer");
  });

  test("输入框、下拉框与可编辑区域聚焦时暂缓", () => {
    expect(resolveReloadUiAction({ ...base, activeTag: "TEXTAREA" })).toBe("defer");
    expect(resolveReloadUiAction({ ...base, activeTag: "INPUT" })).toBe("defer");
    expect(resolveReloadUiAction({ ...base, activeTag: "SELECT" })).toBe("defer");
    expect(resolveReloadUiAction({ ...base, contentEditable: true })).toBe("defer");
  });

  test("手动热重建立即刷新，优先于弹窗与输入焦点", () => {
    expect(resolveReloadUiAction({ ...base, manual: true })).toBe("reload-now");
    expect(resolveReloadUiAction({ ...base, manual: true, modalOpen: true })).toBe("reload-now");
    expect(resolveReloadUiAction({ ...base, manual: true, busy: true, activeTag: "TEXTAREA" })).toBe("reload-now");
  });
});

describe("暂缓刷新标记", () => {
  test("初始为 false，可显式置位与清除，且使用固定 toast id 避免提示堆叠", () => {
    expect(useUiStore.getState().pendingWebReload).toBe(false);
    useUiStore.getState().setPendingWebReload(true);
    expect(useUiStore.getState().pendingWebReload).toBe(true);
    useUiStore.getState().setPendingWebReload(false);
    expect(useUiStore.getState().pendingWebReload).toBe(false);
    expect(RELOAD_PENDING_TOAST_ID).toBe("web-reload-pending");
  });
});
