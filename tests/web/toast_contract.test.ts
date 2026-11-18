import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

describe("REQ-001 Sonner 统一提示契约（无浏览器环境）", () => {
  test("showToast 兼容入口保留并映射到 Sonner 普通/错误提示", () => {
    const store = read("src/web/stores/uiStore.ts");
    expect(store).toContain('import { toast } from "sonner"');
    expect(store).toContain("showToast: (message: string, isError?: boolean) => void");
    expect(store).toContain("if (isError) toast.error(message)");
    expect(store).toContain("else toast(message)");
  });

  test("旧的单条 toast 状态、计时器与自定义展示实现已移除", () => {
    const store = read("src/web/stores/uiStore.ts");
    expect(store).not.toContain("toastTimer");
    expect(store).not.toContain("toast: { message");
    expect(store).not.toContain("toast: null");

    const primitives = read("src/web/components/Primitives.tsx");
    expect(primitives).not.toContain("ToastBanner");

    const app = read("src/web/app.tsx");
    expect(app).not.toContain("ToastBanner");
    expect(app).not.toContain("toast-root");

    const css = read("src/web/styles.css");
    expect(css).not.toMatch(/^\.toast\b/m);

    for (const rel of ["src/web/queries.ts", "src/web/components/Modals.tsx", "src/web/components/WorkspaceView.tsx"]) {
      const src = read(rel);
      expect(src).not.toContain("ToastBanner");
      expect(src).not.toMatch(/useUiStore\(\(s\) => s\.toast\)/);
    }
  });

  test("应用根部挂载单个 Toaster：右下角、四秒、关闭按钮并同步主题", () => {
    const app = read("src/web/app.tsx");
    expect(app).toContain('import { Toaster } from "sonner"');
    expect(app.match(/<Toaster/g)).toHaveLength(1);
    expect(app).toContain('position="bottom-right"');
    expect(app).toContain("duration={4000}");
    expect(app).toContain("closeButton");
    expect(app).toContain("theme={theme}");
  });

  test("sonner 作为运行时依赖锁定", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies.sonner).toBeTruthy();
    expect(read("bun.lock")).toContain("sonner");
  });
});