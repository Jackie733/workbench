import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { Check } from "lucide-react";
import { BrandMark } from "../../src/web/components/BrandMark.tsx";
import {
  BANNER_ACTION_ICONS,
  CALLOUT_TONE_ICONS,
  COVERAGE_ICONS,
  EVIDENCE_ICONS,
  Icon,
  STAGE_ICONS,
  TASK_ICONS,
  VERDICT_ICONS,
} from "../../src/web/components/Icon.tsx";
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
  "LoginView.tsx",
  "AttachmentGallery.tsx",
  "AttachmentPicker.tsx",
  "BrandMark.tsx",
] as const;

const UI_COMPONENT_FILES = [
  "ui/ModelPickerMenu.tsx",
  "ui/ModelRunnerBar.tsx",
  "ui/RoutingModelPicker.tsx",
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
  "HubSidebar.tsx": ["Check", "ChevronDown", "ChevronRight", "Folder", "Plus", "Settings", "Star", "X"],
  "HomeView.tsx": [
    "AlertTriangle",
    "ArrowRight",
    "Check",
    "ChevronDown",
    "ChevronRight",
    "CircleAlert",
    "Clock",
    "FolderGit2",
    "FolderPlus",
    "GitBranch",
    "GitPullRequest",
    "Info",
    "Link2",
    "Plus",
    "RefreshCw",
    "Search",
    "WifiOff",
    "X",
  ],
  "WorkspaceView.tsx": [
    "AlertTriangle",
    "Ban",
    "Bug",
    "Check",
    "CheckCircle2",
    "ChevronLeft",
    "ChevronRight",
    "CircleOff",
    "Columns2",
    "Ellipsis",
    "Eye",
    "EyeOff",
    "FileDiff",
    "FileEdit",
    "FileText",
    "GitBranch",
    "GitCommit",
    "GitMerge",
    "GitPullRequest",
    "History",
    "Link2",
    "Loader2",
    "Lock",
    "Maximize2",
    "MessageSquare",
    "Minimize2",
    "PanelRightOpen",
    "Pencil",
    "Play",
    "Plus",
    "RefreshCw",
    "RotateCcw",
    "Save",
    "Search",
    "ShieldCheck",
    "Square",
    "Terminal",
    "Trash2",
    "Undo2",
    "Wrench",
    "X",
    "XCircle",
    "Zap",
  ],
  "RightDrawer.tsx": [
    "AlertTriangle",
    "Check",
    "FileDiff",
    "FileText",
    "Lightbulb",
    "Loader2",
    "MessageSquare",
    "Pencil",
    "RotateCcw",
    "Square",
    "Terminal",
    "Trash2",
    "X",
    "Zap",
  ],
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
  "Modals.tsx": [
    "Activity",
    "ArrowLeft",
    "ArrowUp",
    "Ban",
    "BookOpen",
    "Bug",
    "Check",
    "CircleAlert",
    "CircleHelp",
    "CircleOff",
    "ClipboardCheck",
    "Copy",
    "Download",
    "ExternalLink",
    "FileText",
    "Folder",
    "FolderOpen",
    "FolderPlus",
    "GitBranch",
    "GitCommit",
    "GitPullRequest",
    "Inbox",
    "Info",
    "Link2",
    "ListChecks",
    "MessageSquare",
    "Pencil",
    "Plus",
    "RefreshCw",
    "RotateCcw",
    "Save",
    "Send",
    "Settings",
    "Sparkles",
    "Terminal",
    "Trash2",
    "X",
    "XCircle",
    "Zap",
  ],
  "Primitives.tsx": ["MessageSquare"],
  "LoginView.tsx": ["AlertTriangle", "KeyRound", "Lock"],
} as const;

const EXPECTED_LUCIDE_APP = ["Crosshair", "X"] as const;

const EXPECTED_LUCIDE_UI = {
  "ui/ModelPickerMenu.tsx": ["Check", "Search", "Star"],
  "ui/ModelRunnerBar.tsx": ["ChevronsUpDown", "Cpu", "Gauge"],
  "ui/RoutingModelPicker.tsx": ["ChevronsUpDown"],
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

  test("iconified controls keep their alignment and width contracts", () => {
    const css = read("src/web/styles.css");
    // Workspace tabs and search box must stay vertically centered after adding 14px glyphs.
    expect(css).toMatch(/\.tab\s*\{[^}]*display:\s*inline-flex/);
    expect(css).toMatch(/\.tab\s*\{[^}]*align-items:\s*center/);
    expect(css).toMatch(/\.tab\s*\{[^}]*gap:\s*6px/);
    expect(css).toContain(".search-wrap");
    expect(css).toMatch(/\.decision-box h2\s*\{[^}]*display:\s*flex/);
    expect(css).toMatch(/\.icon-heading\s*\{[^}]*display:\s*flex/);
    expect(css).toMatch(/\.callout-lead\s*\{[^}]*display:\s*inline-flex/);
    // REQ-005: keep menu items content-sized; never stretch or blockify them.
    expect(css).toMatch(/\.more-menu button\s*\{[^}]*width:\s*auto/);
    expect(css).toMatch(/\.more-menu button\s*\{[^}]*display:\s*flex/);
    expect(css).toMatch(/\.more-menu button\s*\{[^}]*gap:\s*8px/);
    expect(css).not.toMatch(/\.more-menu button\s*\{[^}]*display:\s*block/);
    expect(css).not.toMatch(/\.more-menu button\s*\{[^}]*width:\s*100%/);
    // Spinner utility used by running badges.
    expect(css).toMatch(/\.ui-icon\.spin\s*\{[^}]*animation:/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.ui-icon\.spin/);
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

  test("covers every stage with a decorative Lucide glyph", () => {
    expect([...Object.keys(STAGE_ICONS)].sort()).toEqual([
      "awaiting_acceptance",
      "awaiting_approval",
      "blocked",
      "cancelled",
      "designing",
      "done",
      "draft",
      "implementing",
    ]);
    for (const [stage, glyph] of Object.entries(STAGE_ICONS)) {
      const html = renderToStaticMarkup(<Icon icon={glyph} size={14} />);
      expect(html).toContain("<svg");
      expect(html, `stage ${stage} must stay decorative`).toContain('aria-hidden="true"');
      expect(html, `stage ${stage} must stay non-focusable`).toContain('focusable="false"');
    }
  });

  test("covers every evidence state with a decorative Lucide glyph", () => {
    expect([...Object.keys(EVIDENCE_ICONS)].sort()).toEqual(["failed", "passed", "stale", "unknown"]);
    for (const [state, glyph] of Object.entries(EVIDENCE_ICONS)) {
      const html = renderToStaticMarkup(<Icon icon={glyph} size={14} />);
      expect(html).toContain("<svg");
      expect(html, `evidence ${state} must stay decorative`).toContain('aria-hidden="true"');
    }
  });

  test("covers every review verdict with a decorative Lucide glyph", () => {
    expect([...Object.keys(VERDICT_ICONS)].sort()).toEqual(["block", "concern", "pass"]);
    for (const [verdict, glyph] of Object.entries(VERDICT_ICONS)) {
      const html = renderToStaticMarkup(<Icon icon={glyph} size={14} />);
      expect(html).toContain("<svg");
      expect(html, `verdict ${verdict} must stay decorative`).toContain('aria-hidden="true"');
    }
  });

  test("covers every banner action with a decorative Lucide glyph", () => {
    expect([...Object.keys(BANNER_ACTION_ICONS)].sort()).toEqual([
      "accept",
      "approve_and_implement",
      "approve_only",
      "authorize_fast_track",
      "dispatch_design",
      "dispatch_fix",
      "dispatch_fix_review",
      "dispatch_implement",
      "dispatch_review",
      "reopen",
      "request_changes",
      "run_all_verifications",
      "sync_base",
      "unblock",
    ]);
    for (const [action, glyph] of Object.entries(BANNER_ACTION_ICONS)) {
      const html = renderToStaticMarkup(<Icon icon={glyph} size={14} />);
      expect(html).toContain("<svg");
      expect(html, `banner action ${action} must stay decorative`).toContain('aria-hidden="true"');
    }
  });

  test("covers every callout tone with a decorative Lucide glyph", () => {
    expect([...Object.keys(CALLOUT_TONE_ICONS)].sort()).toEqual(["danger", "info", "success", "warning"]);
    for (const [tone, glyph] of Object.entries(CALLOUT_TONE_ICONS)) {
      const html = renderToStaticMarkup(<Icon icon={glyph} size={14} />);
      expect(html).toContain("<svg");
      expect(html, `callout tone ${tone} must stay decorative`).toContain('aria-hidden="true"');
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
    for (const [file, icons] of Object.entries(EXPECTED_LUCIDE_UI)) {
      const source = read(`src/web/components/${file}`);
      expect(source, `${file} must import from lucide-react`).toContain('from "lucide-react"');
      expect(source, `${file} must not load the dynamic catalog`).not.toContain("lucide-react/dynamic");
      for (const icon of icons) {
        expect(source, `${file} is missing ${icon}`).toContain(icon);
      }
    }
    const appSource = read("src/web/app.tsx");
    expect(appSource, "app.tsx must import from lucide-react").toContain('from "lucide-react"');
    for (const icon of EXPECTED_LUCIDE_APP) {
      expect(appSource, `app.tsx is missing ${icon}`).toContain(icon);
    }
    expect(appSource).toContain('from "./components/Icon.tsx"');
  });

  test("lucide imports are static named imports, never namespace/dynamic imports", () => {
    const rels = [
      ...COMPONENT_FILES.map((file) => `src/web/components/${file}`),
      ...UI_COMPONENT_FILES.map((file) => `src/web/components/${file}`),
      "src/web/app.tsx",
      "src/web/render.ts",
    ];
    for (const rel of rels) {
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
      ...UI_COMPONENT_FILES.map((file) => `src/web/components/${file}`),
      "src/web/app.tsx",
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
    for (const file of [
      ...COMPONENT_FILES.map((name) => `src/web/components/${name}`),
      ...UI_COMPONENT_FILES.map((name) => `src/web/components/${name}`),
    ]) {
      const source = read(file);
      // A button whose entire content is +, x/X, or >_ is an ad-hoc icon.
      expect(source, `${file} contains an ASCII icon glyph`).not.toMatch(/<button[^>]*>\s*(?:\+|x|X|>_)\s*<\/button>/);
      expect(source, `${file} contains a terminal ASCII icon`).not.toContain(">_");
    }
  });

  test("keeps all native option elements text-only", () => {
    const optionFiles = [
      ...COMPONENT_FILES.map((file) => `src/web/components/${file}`),
      ...UI_COMPONENT_FILES.map((file) => `src/web/components/${file}`),
      "src/web/app.tsx",
    ];
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
    expect(sidebar).toContain("<BrandMark />");
    const renderSource = read("src/web/render.ts");
    expect(renderSource).toContain('checked ? "☑" : "☐"');
  });
});

describe("shared brand mark and browser icons", () => {
  test("renders a decorative fixed-size compact symbol from the public brand path", () => {
    const html = renderToStaticMarkup(<BrandMark />);

    expect(html).toContain('class="brand-mark"');
    expect(html).toContain('src="/brand/symbol-compact.svg"');
    expect(html).toContain('alt=""');
    expect(html).toContain('width="22"');
    expect(html).toContain('height="22"');
  });

  test("all three brand entry points share the component and keep their visible product text", () => {
    for (const file of ["Topbar.tsx", "HubSidebar.tsx", "LoginView.tsx"]) {
      const source = read(`src/web/components/${file}`);
      expect(source, `${file} must import the shared brand mark`).toContain(
        'import { BrandMark } from "./BrandMark.tsx";',
      );
      expect(source, `${file} must render the shared brand mark`).toContain("<BrandMark />");
      expect(source, `${file} must not keep the letter placeholder`).not.toContain("sb-logo");
      expect(source, `${file} must not keep a letter-only brand glyph`).not.toMatch(/>\s*W\s*</);
    }
    expect(read("src/web/components/Topbar.tsx")).toContain('<span className="app-brand-name">Workbench</span>');
    expect(read("src/web/components/HubSidebar.tsx")).toContain("<span>Workbench</span>");
    expect(read("src/web/components/LoginView.tsx")).toContain('t(language, "login.title")');
    expect(read("src/web/i18n.ts")).toContain('"login.title": "Workbench 局域网登录"');
  });

  test("brand styles keep the mark at a fixed ratio and remove the placeholder tile", () => {
    const css = read("src/web/styles.css");
    expect(css).toMatch(/\.brand-mark\s*\{[^}]*width:\s*22px/);
    expect(css).toMatch(/\.brand-mark\s*\{[^}]*height:\s*22px/);
    expect(css).toMatch(/\.brand-mark\s*\{[^}]*flex-shrink:\s*0/);
    expect(css).toMatch(/\.brand-mark\s*\{[^}]*object-fit:\s*contain/);
    expect(css).not.toContain(".sb-logo");
  });

  test("page declares the vector, compatibility, and apple touch icons", () => {
    const html = read("src/web/index.html");
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
    expect(html).toContain('<link rel="alternate icon" href="/favicon.ico" />');
    expect(html).toContain('<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />');
    expect(html).not.toContain("site.webmanifest");
    expect(html).not.toContain("og:image");
  });

  test("brand folder contains only the four used originals plus provenance notes", () => {
    const dir = path.join(ROOT, "src/web/brand");
    expect(fs.readdirSync(dir).sort()).toEqual([
      "README.md",
      "apple-touch-icon.png",
      "favicon.ico",
      "favicon.svg",
      "symbol-compact.svg",
    ]);
    for (const svg of ["symbol-compact.svg", "favicon.svg"]) {
      const content = fs.readFileSync(path.join(dir, svg), "utf8");
      expect(content, `${svg} must stay an SVG source`).toContain("<svg");
      expect(content).toContain("Workbench");
    }
    expect(fs.readFileSync(path.join(dir, "favicon.ico")).subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]));
    expect(fs.readFileSync(path.join(dir, "apple-touch-icon.png")).subarray(1, 4)).toEqual(Buffer.from("PNG"));
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toContain("Workbench_Logo_Assets_v1");
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
