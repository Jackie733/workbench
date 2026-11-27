import { describe, expect, test } from "bun:test";
import { DEFAULT_FOREGROUND_SERVE_PORT, resolveForegroundServePort } from "../../src/cli/index.ts";

describe("前台 wb serve 的默认访问地址", () => {
  test("默认使用稳定端口，显式 --port 仍可覆盖或申请随机端口", () => {
    expect(DEFAULT_FOREGROUND_SERVE_PORT).toBe(4318);
    expect(resolveForegroundServePort(undefined)).toBe(4318);
    expect(resolveForegroundServePort(true)).toBe(4318);
    expect(resolveForegroundServePort("4317")).toBe(4317);
    expect(resolveForegroundServePort("0")).toBe(0);
  });
});
