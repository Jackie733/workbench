import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { Check } from "lucide-react";
import { COVERAGE_ICONS, Icon, TASK_ICONS } from "../../src/web/components/Icon.tsx";
import { renderMarkdown } from "../../src/web/render.ts";

const ROOT = path.resolve(import.meta.dir, "../..");
const COMPONENT_DIR = path.join(ROOT, "src/web/components");

const COMPONENT_FILES = [
  "Topbar.tsx",
  "HubSidebar.tsx",
  "HomeView.tsx",
  "WorkspaceView.tsx",
  "RightDrawer.tsx",
  "ConsoleOutput.tsx",
  "Modals.tsx",
  "Primitives.tsx",
  "Icon.tsx",
] as const;

// Glyphs the application used to render as ad-hoc status / action icons.
// Emoji ranges plus the common text symbols that are not covered by
// Extended_Pictographic (for example ○ ● ✓ × ⟳).
const ICON_GLYPH = /[\u{1F300}-\u{1FAFF}\u2600-\u27BF\u2B00-\u2BFF\u25A0-\u25FF\u2713\u2714\u2717\u2718\u27F3\uFE0F\u00D7]/u;

// Documented exception: checkboxes in user-authored Markdown task lists.
const ALLOWED_GLYPH_LINES: Record<string, RegExp[]> = {
  "src/web/render.ts": [/checked \? "☑" : "☐"/],
};

const EXPECTED_LUCIDE = {
  "Topbar.tsx": [
    "ArrowLeft",
    "PanelLeftClose",
    "PanelLeftOpen",
    "PanelRightClose",
    "PanelRightOpen",
    "Sun",
    "Moon",
    "Settings",
    "Sparkles",
    "Zap",
  ],
  "HubSidebar.tsx": ["Plus", "Settings", "X"],
  "HomeView.tsx": ["ArrowRight", "Plus"],
  "WorkspaceView.tsx": ["Ellipsis", "MessageSquare", "Plus", "Search", "Zap"],
  "RightDrawer.tsx": ["FileText", "Lightbulb", "MessageSquare", "Pencil", "Terminal", "X", "Zap"],
  "ConsoleOutput.tsx": [
    "AlertTriangle",
    "ArrowDown",
    "Check",
    "CheckCircle2",
    "ChevronDown",
    "ChevronRight",
    "Copy",
    "FileText",
    "Layers",
    "Sparkles",
    "Terminal",
    "Wrench",
    "Zap",
  ],
  "Modals.tsx": ["ArrowUp", "Folder", "Lightbulb", "Pencil", "RefreshCw"],
  "Primitives.tsx": ["MessageSquare"],
} as const;

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

describe("shared icon wrapper", () => {
  test("renders a decorative, non-focusable currentColor SVG with shared defaults", () => {
    const html = renderToStaticMarkup(<Icon icon={Check} />);

    expect(html).toContain("ui-icon");
    expect(html).toContain('width="16"');
    expect(html).toContain('height="16"');
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('stroke-width="2"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('focusable="false"');
  });

  test("supports compact and prominent sizes plus extra classes", () => {
    const compact = renderToStaticMarkup(<Icon icon={Check} size={14} className="status-icon" />);
    expect(compact).toContain('width="14"');
    expect(compact).toContain('height="14"');
    expect(compact).toContain("ui-icon status-icon");

    const prominent = renderToStaticMarkup(<Icon icon={Check} size={20} />);
    expect(prominent).toContain('width="20"');
    expect(prominent).toContain('height="20"');
  });

  test("documents the shared CSS contract for alignment", () => {
    const css = read("src/web/styles.css");
    expect(css).toMatch(/\.ui-icon\s*\{[^}]*flex-shrink:\s*0/);
    expect(css).toMatch(/\.ui-icon\s*\{[^}]*vertical-align:/);
    expect(css).toMatch(/\.md-annot-icon\s*\{[^}]*display:\s*inline-flex/);
  });
});

describe("exhaustive status icon maps", () => {
  test("covers every task status with a real Lucide component", () => {
    expect([...Object.keys(TASK_ICONS)].sort()).toEqual(["blocked", "done", "in_progress", "pending"]);
    for (const [status, glyph] of Object.entries(TASK_ICONS)) {
      const html = renderToStaticMarkup(<Icon icon={glyph} size={14} />);
      expect(html).toContain("<svg");
      expect(html, `status ${status} must stay decorative`).toContain('aria-hidden="true"');
    }
  });

  test("covers every coverage state with a real Lucide component", () => {
    expect([...Object.keys(COVERAGE_ICONS)].sort()).toEqual(["failed", "passed", "stale", "unavailable", "unverified"]);
    for (const [state, glyph] of Object.entries(COVERAGE_ICONS)) {
      const html = renderToStaticMarkup(<Icon icon={glyph} size={14} />);
      expect(html).toContain("<svg");
      expect(html, `coverage ${state} must stay decorative`).toContain('aria-hidden="true"');
    }
  });

  test("status metadata carries text labels and no legacy symbols", () => {
    const stateSource = read("src/web/state.ts");
    expect(stateSource).not.toContain("symbol:");
    for (const label of ["待开始", "进行中", "已完成", "受阻", "通过", "失败", "需重跑", "未验证", "证据不可用"]) {
      expect(stateSource).toContain(label);
    }
  });
});

describe("application icon inventory", () => {
  test("selected component files use the expected static Lucide imports", () => {
    for (const [file, icons] of Object.entries(EXPECTED_LUCIDE)) {
      const source = read(`src/web/components/${file}`);
      expect(source, `${file} must import from lucide-react`).toContain('from "lucide-react"');
      expect(source, `${file} must not load the dynamic catalog`).not.toContain("lucide-react/dynamic");
      for (const icon of icons) {
        expect(source, `${file} is missing ${icon}`).toContain(icon);
      }
    }
  });

  test("lucide imports are static named imports, never namespace/dynamic imports", () => {
    for (const file of [...COMPONENT_FILES, "../../render.ts"] as const) {
      const rel = file.startsWith("..") ? `src/web/${file.replace("../../", "")}` : `src/web/components/${file}`;
      const source = read(rel);
      for (const match of source.matchAll(/import\s+(?!type\b)([\s\S]*?)\s+from\s+"lucide-react"/g)) {
        const clause = match[1]!.trim();
        expect(clause, `${rel} has a non-named lucide import: ${clause}`).toContain("{");
        expect(clause, `${rel} must not namespace-import lucide`).not.toContain("*");
      }
      expect(source, `${rel} must not dynamically import lucide`).not.toMatch(/import\s*\(\s*["']lucide-react/);
    }
  });

  test("removes every legacy application-owned icon glyph outside documented exceptions", () => {
    const offenders: string[] = [];
    for (const rel of [
      ...COMPONENT_FILES.map((file) => `src/web/components/${file}`),
      "src/web/render.ts",
      "src/web/state.ts",
    ]) {
      const allowed = ALLOWED_GLYPH_LINES[rel] ?? [];
      read(rel)
        .split("\n")
        .forEach((line, index) => {
          if (!ICON_GLYPH.test(line)) return;
          if (allowed.some((pattern) => pattern.test(line))) return;
          offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  test("does not reintroduce ASCII substitutes as icon-only content", () => {
    for (const file of COMPONENT_FILES) {
      const source = read(`src/web/components/${file}`);
      // A button whose entire content is +, x/X, or >_ is an ad-hoc icon.
      expect(source, `${file} contains an ASCII icon glyph`).not.toMatch(/<button[^>]*>\s*(?:\+|x|X|>_)\s*<\/button>/);
      expect(source, `${file} contains a terminal ASCII icon`).not.toContain(">_");
    }
  });

  test("keeps all native option elements text-only", () => {
    const optionFiles = COMPONENT_FILES.map((file) => `src/web/components/${file}`);
    for (const rel of optionFiles) {
      const source = read(rel);
      for (const match of source.matchAll(/<option\b[\s\S]*?<\/option>/g)) {
        const block = match[0];
        expect(block, `${rel} option must not contain an Icon component`).not.toContain("<Icon");
        expect(block, `${rel} option must not contain SVG markup`).not.toContain("<svg");
        expect(ICON_GLYPH.test(block), `${rel} option must stay text-only: ${block}`).toBe(false);
      }
    }
    const primitives = read("src/web/components/Primitives.tsx");
    const modelBar = read("src/web/components/ui/ModelRunnerBar.tsx");
    const i18n = read("src/web/i18n.ts");
    expect(modelBar).toContain('"runner.manual"');
    expect(i18n).toContain("仅生成提示词 (手动复制)");
    expect(primitives).not.toContain("📋");
    expect(modelBar).not.toContain("📋");
  });

  test("preserves documented text/prose exceptions", () => {
    const workspace = read("src/web/components/WorkspaceView.tsx");
    expect(workspace).toContain("+{f.additions}/-{f.deletions}");
    expect(workspace).toContain('"spec.compare"');
    expect(read("src/web/i18n.ts")).toContain("对比 v{prev} → v{curr}");
    const sidebar = read("src/web/components/HubSidebar.tsx");
    expect(sidebar).toContain('<span className="sb-logo">W</span>');
    const renderSource = read("src/web/render.ts");
    expect(renderSource).toContain('checked ? "☑" : "☐"');
  });
});

describe("generated Markdown annotation controls", () => {
  test("renders an empty icon slot plus the textual action label", () => {
    const html = renderMarkdown("# 第一节\n\n正文", { annotatable: true, docLabel: "design.md" });

    expect(html).toContain('data-action="annotate-anchor"');
    expect(html).toContain('data-icon-slot="annotate"');
    expect(html).toContain(">批注<");
    expect(html).not.toMatch(/📝|📋|💬/u);
    expect((html.match(/data-icon-slot="annotate"/g) ?? []).length).toBe(1);
  });

  test("creates one correctly escaped anchor per heading and none when not annotatable", () => {
    const html = renderMarkdown("# Alpha\n\n## Beta\n\n正文", { annotatable: true, docLabel: "spec.md" });
    expect((html.match(/data-icon-slot="annotate"/g) ?? []).length).toBe(2);
    expect(html).toContain('data-anchor="spec.md#Alpha"');
    expect(html).toContain('data-anchor="spec.md#Beta"');

    const plain = renderMarkdown("# Alpha\n\n正文");
    expect(plain).not.toContain("data-icon-slot");
    expect(plain).not.toContain("annotate-anchor");
    expect(plain).not.toContain("批注");
  });

  test("keeps user-authored Markdown escaped and unable to forge application slots", () => {
    const html = renderMarkdown('# 安全 <img src=x onerror="alert(1)"> data-icon-slot="annotate"', {
      annotatable: true,
      docLabel: "spec.md",
    });

    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror=\"alert");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    // Only the application-generated control may own the live slot attribute.
    expect((html.match(/data-icon-slot="annotate"/g) ?? []).length).toBe(1);
  });

  test("preserves user-authored task-list checkboxes and prose arrows", () => {
    const html = renderMarkdown("- [x] 已完成\n- [ ] 待完成", { annotatable: true, docLabel: "spec.md" });
    expect(html).toContain("☑ 已完成");
    expect(html).toContain("☐ 待完成");
    expect(html).not.toContain("data-icon-slot");
  });
});
