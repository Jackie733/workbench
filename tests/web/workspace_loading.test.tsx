import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { Skeleton } from "../../src/web/components/ui/skeleton.tsx";
import { WorkspaceLoadingState } from "../../src/web/components/WorkspaceLoadingState.tsx";

const ROOT = path.resolve(import.meta.dir, "../..");
const STYLES_CSS = fs.readFileSync(path.join(ROOT, "src/web/styles.css"), "utf8");

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

function extractKeyframeProperties(css: string, name: string): string[] {
  const match = new RegExp(`@keyframes\\s+${name}\\b`).exec(css);
  expect(match, `Missing @keyframes ${name}`).not.toBeNull();
  const block = extractBalancedBlock(css, match!.index);
  const props: string[] = [];
  for (const frameMatch of block.matchAll(/\{([^}]*)\}/g)) {
    const declarations = frameMatch[1] ?? "";
    for (const decl of declarations.split(";")) {
      const trimmed = decl.trim();
      if (!trimmed) continue;
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx > 0) {
        props.push(trimmed.slice(0, colonIdx).trim().toLowerCase());
      }
    }
  }
  return props;
}

describe("Skeleton primitive", () => {
  test("renders decorative skeleton slot and merges custom className", () => {
    const html = renderToStaticMarkup(<Skeleton className="h-4 w-32" data-testid="demo-skel" />);
    expect(html).toContain('data-slot="skeleton"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("ws-skeleton");
    expect(html).toContain("h-4 w-32");
    expect(html).toContain('data-testid="demo-skel"');
  });
});

describe("WorkspaceLoadingState", () => {
  test("renders structured skeleton and centered loading card with accessibility semantics in zh-CN", () => {
    const html = renderToStaticMarkup(
      <WorkspaceLoadingState selectedId="REQ-026" language="zh-CN" />,
    );

    expect(html).toContain('data-testid="workspace-loading"');
    expect(html).toContain('data-testid="workspace-loading-card"');
    expect(html).not.toContain('data-testid="workspace-detail"');
    expect(html).not.toContain('data-testid="workspace-load-error"');

    // Live region & busy semantics on root; no duplicate role="status" inside Spinner.
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-busy="true"');
    expect((html.match(/role="status"/g) ?? []).length).toBe(1);

    // Decorative structure & progress visuals hidden from assistive tech.
    expect(html).toContain('class="ws-loading-pinned" aria-hidden="true"');
    expect(html).toContain('class="ws-loading-cards" aria-hidden="true"');
    expect(html).toContain('class="ws-loading-orbit" aria-hidden="true"');
    expect(html).toContain('class="ws-loading-bar" aria-hidden="true"');
    expect(html).toContain('data-slot="skeleton"');

    // Bilingual copy & requirement ID pill.
    expect(html).toContain("正在加载需求详情…");
    expect(html).toContain("正在同步规范、方案与验证状态");
    expect(html).toContain('data-testid="workspace-loading-id"');
    expect(html).toContain(">REQ-026<");
  });

  test("renders English copy and omits ID pill when selectedId is null", () => {
    const html = renderToStaticMarkup(
      <WorkspaceLoadingState selectedId={null} language="en" />,
    );

    expect(html).toContain("Loading requirement details…");
    expect(html).toContain("Syncing spec, design, and verification state");
    expect(html).not.toContain('data-testid="workspace-loading-id"');
  });

  test("renders centered alert error fallback with retry action and without shimmer skeletons", () => {
    const html = renderToStaticMarkup(
      <WorkspaceLoadingState
        selectedId="REQ-026"
        language="zh-CN"
        isError
        errorMessage="网络请求失败，请检查服务是否在线"
        onRetry={async () => {}}
      />,
    );

    expect(html).toContain('data-testid="workspace-load-error"');
    expect(html).toContain('data-testid="workspace-load-error-card"');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('data-testid="workspace-loading"');
    expect(html).not.toContain('data-testid="workspace-detail"');
    expect(html).not.toContain('data-slot="skeleton"');

    expect(html).toContain("加载需求详情失败");
    expect(html).toContain(">REQ-026<");
    expect(html).toContain("网络请求失败，请检查服务是否在线");
    expect(html).toContain('data-testid="workspace-retry-btn"');
    expect(html).toContain('type="button"');
    expect(html).toContain("重新加载");
  });

  test("renders English error fallback and omits retry button when onRetry is not provided", () => {
    const html = renderToStaticMarkup(
      <WorkspaceLoadingState
        selectedId="REQ-026"
        language="en"
        isError
        errorMessage="Server returned 500"
      />,
    );

    expect(html).toContain("Failed to load requirement details");
    expect(html).toContain("Server returned 500");
    expect(html).not.toContain('data-testid="workspace-retry-btn"');
  });
});

describe("Workspace loading CSS animation & accessibility contract", () => {
  test("new keyframes strictly animate GPU-composited properties (transform and opacity)", () => {
    const allowed = new Set(["transform", "opacity"]);
    for (const name of [
      "ws-loading-enter",
      "ws-skeleton-shimmer",
      "ws-loading-orbit-ring",
      "ws-loading-bar-slide",
    ]) {
      const props = extractKeyframeProperties(STYLES_CSS, name);
      expect(props.length, `@keyframes ${name} should declare properties`).toBeGreaterThan(0);
      for (const prop of props) {
        expect(allowed.has(prop), `@keyframes ${name} must not animate non-composited property "${prop}"`).toBe(true);
      }
    }
  });

  test("prefers-reduced-motion disables every workspace loading animation and stabilizes decorative overlays", () => {
    const match = /@media\s*\(prefers-reduced-motion:\s*reduce\)/.exec(STYLES_CSS);
    expect(match).not.toBeNull();
    const block = extractBalancedBlock(STYLES_CSS, match!.index);

    for (const selector of [
      ".workspace-loading",
      ".ws-skeleton::after",
      ".ws-loading-orbit::before",
      ".ws-loading-spinner",
      ".ws-loading-bar-thumb",
    ]) {
      expect(block, `reduced-motion block missing ${selector}`).toContain(selector);
    }
    expect(block).toContain("animation: none !important;");
    expect(block).toContain("opacity: 0;");
  });

  test("supports dark theme tokens and low-height vertical scroll fallback", () => {
    expect(STYLES_CSS).toContain('[data-theme="dark"] .ws-skeleton');
    expect(STYLES_CSS).toContain('[data-theme="dark"] .ws-loading-card');
    expect(STYLES_CSS).toMatch(/\.workspace-loading\s*\{[^}]*overflow-y:\s*auto/);
    expect(STYLES_CSS).toMatch(/@media\s*\(max-height:\s*540px\)\s*\{[\s\S]*?\.ws-loading-pinned\s*\{[^}]*display:\s*none/);
  });
});
