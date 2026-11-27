import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { RequirementListLoadingState } from "../../src/web/components/RequirementListLoadingState.tsx";
import { WorkspaceLoadingState } from "../../src/web/components/WorkspaceLoadingState.tsx";

const ROOT = path.resolve(import.meta.dir, "../..");

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function extractBalancedBlock(source: string, headerIndex: number): string {
  const openIndex = source.indexOf("{", headerIndex);
  if (openIndex < 0) return "";
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  return "";
}

describe("REQ-027 工作区加载变体", () => {
  test("workspace 变体渲染工作区骨架与加载卡片，且隐藏需求 ID 胶囊", () => {
    const html = renderToStaticMarkup(
      <WorkspaceLoadingState variant="workspace" selectedId="REQ-027" language="zh-CN" />,
    );

    expect(html).toContain('data-testid="workspace-loading"');
    expect(html).toContain('data-testid="workspace-loading-card"');
    expect(html).toContain("正在加载工作台…");
    expect(html).toContain("正在准备工作区、需求列表与项目状态");
    expect(html).not.toContain('data-testid="workspace-loading-id"');
    expect(html).not.toContain('data-testid="workspace-load-error"');

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-busy="true"');
    expect((html.match(/role="status"/g) ?? []).length).toBe(1);
    expect((html.match(/data-slot="skeleton"/g) ?? []).length).toBeGreaterThanOrEqual(8);
  });

  test("workspace 变体输出英文文案并保持装饰骨架对读屏隐藏", () => {
    const html = renderToStaticMarkup(
      <WorkspaceLoadingState variant="workspace" selectedId={null} language="en" />,
    );

    expect(html).toContain("Loading workspace…");
    expect(html).toContain("Preparing workspace, requirements, and project state");
    expect(html).toContain('class="ws-loading-pinned" aria-hidden="true"');
    expect(html).toContain('class="ws-loading-cards" aria-hidden="true"');
    expect(html).not.toContain('data-testid="workspace-loading-id"');
  });

  test("默认 detail 变体仍保留既有标题、提示与需求 ID", () => {
    const html = renderToStaticMarkup(
      <WorkspaceLoadingState selectedId="REQ-026" language="zh-CN" />,
    );

    expect(html).toContain("正在加载需求详情…");
    expect(html).toContain("正在同步规范、方案与验证状态");
    expect(html).toContain('data-testid="workspace-loading-id"');
    expect(html).toContain(">REQ-026<");
  });
});

describe("REQ-027 需求列表骨架", () => {
  test("骨架行与真实需求卡片同构，忙碌语义只播报一次", () => {
    const html = renderToStaticMarkup(
      <RequirementListLoadingState language="zh-CN" rows={3} />,
    );

    expect(html).toContain('data-testid="req-list-loading"');
    expect(html).toContain('class="req-list req-list-loading"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-busy="true"');
    expect((html.match(/role="status"/g) ?? []).length).toBe(1);
    expect(html).toContain('<span class="sr-only">正在加载需求列表…</span>');
    expect((html.match(/data-testid="req-row-skeleton"/g) ?? []).length).toBe(3);
    expect((html.match(/data-slot="skeleton"/g) ?? []).length).toBe(18);
    expect(html).toContain('class="req-row req-row-skeleton"');
    expect(html).toContain('<div aria-hidden="true">');
    expect(html).toContain("req-skel-id");
    expect(html).toContain("req-skel-time");
    expect(html).toContain("req-skel-title");
    expect(html).toContain("req-skel-badge");
  });

  test("骨架不包含可交互标记，英文读屏文案正确", () => {
    const html = renderToStaticMarkup(
      <RequirementListLoadingState language="en" />,
    );

    expect(html).toContain('<span class="sr-only">Loading requirements…</span>');
    expect((html.match(/data-testid="req-row-skeleton"/g) ?? []).length).toBe(6);
    expect(html).not.toContain('data-action="open-req"');
    expect(html).not.toContain("tabindex");
    expect(html).not.toContain("data-id=");
    expect(html).not.toContain("aria-current");
  });

  test("rows 参数为 0 时仍保留状态容器但不渲染骨架行", () => {
    const html = renderToStaticMarkup(
      <RequirementListLoadingState language="zh-CN" rows={0} />,
    );

    expect(html).toContain('data-testid="req-list-loading"');
    expect(html).not.toContain('data-testid="req-row-skeleton"');
  });
});

describe("REQ-027 源码接入契约", () => {
  test("中间工作区两处过渡分支均改用 workspace 骨架，不再输出纯文本加载提示", () => {
    const app = read("src/web/app.tsx");

    expect(app).toContain('import { WorkspaceLoadingState } from "./components/WorkspaceLoadingState.tsx";');
    expect((app.match(/variant="workspace"/g) ?? []).length).toBe(2);
    expect(app).not.toContain('"app.loading"');
    expect(app).not.toContain('t(language, "app.loading")');
    expect(app).toContain('t(language, "home.loadFailed")');
  });

  test("需求列表接入骨架并保留错误提示优先", () => {
    const home = read("src/web/components/HomeView.tsx");

    expect(home).toContain('import { RequirementListLoadingState } from "./RequirementListLoadingState.tsx";');
    expect(home).toContain("<RequirementListLoadingState language={language} />");
    expect(home).toContain('t(language, "home.loadFailed")');
    expect(home).not.toContain('"app.loading"');
  });

  test("侧栏在项目查询期间保持需求面板挂载，让列表骨架接管过渡", () => {
    const sidebar = read("src/web/components/HubSidebar.tsx");

    expect(sidebar).toContain("isLoading: projectLoading");
    expect(sidebar).toContain("const projectPending = projectLoading && !project;");
    expect(sidebar).toContain("(project?.initialized || projectPending)");
  });
});

describe("REQ-027 样式与动效契约", () => {
  const styles = read("src/web/styles.css");

  test("列表骨架类存在并复用既有 shimmer 骨架块", () => {
    for (const selector of [
      ".req-list-loading",
      ".req-row-skeleton",
      ".req-skel-id",
      ".req-skel-time",
      ".req-skel-title",
      ".req-skel-badge",
    ]) {
      expect(styles, `缺少样式类 ${selector}`).toContain(selector);
    }
    expect(styles).toMatch(/\.req-row-skeleton\s*\{[^}]*pointer-events:\s*none/);
    expect(styles).toMatch(/\.req-skel-title\s*\{[^}]*width:\s*88%/);
  });

  test("不新增列表骨架专用 keyframes，并保留 reduced-motion 关闭 shimmer", () => {
    expect(styles).not.toMatch(/@keyframes\s+req-/);
    const match = /@media\s*\(prefers-reduced-motion:\s*reduce\)/.exec(styles);
    expect(match).not.toBeNull();
    const block = extractBalancedBlock(styles, match!.index);
    expect(block).toContain(".ws-skeleton::after");
    expect(block).toContain("animation: none !important;");
  });
});
