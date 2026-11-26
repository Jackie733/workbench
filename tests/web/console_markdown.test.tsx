import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConsoleMarkdown, normalizeConsoleMarkdown } from "../../src/web/components/ConsoleMarkdown.tsx";

function render(markdown: string, variant?: "message" | "thinking"): string {
  return renderToStaticMarkup(createElement(ConsoleMarkdown, { text: markdown, language: "zh-CN", variant }));
}

describe("normalizeConsoleMarkdown", () => {
  test("unwraps whole-message markdown fences for markdown/md/gfm", () => {
    for (const lang of ["markdown", "md", "gfm", "Markdown"]) {
      const wrapped = ["```" + lang, "# 标题", "- 列表", "```"].join("\n");
      expect(normalizeConsoleMarkdown(wrapped)).toBe("# 标题\n- 列表");
    }
  });

  test("keeps ordinary code fences and unclosed fences untouched", () => {
    const ts = "```ts\nconst ok = true;\n```";
    expect(normalizeConsoleMarkdown(ts)).toBe(ts);
    const unclosed = "```markdown\n# 标题";
    expect(normalizeConsoleMarkdown(unclosed)).toBe(unclosed);
    const trailingText = "```markdown\n# 标题\n```\n后续说明";
    expect(normalizeConsoleMarkdown(trailingText)).toBe(trailingText);
  });

  test("does not unwrap when an independent code block closes before the message ends", () => {
    const exampleThenCode = [
      "```markdown",
      "# 示例",
      "```",
      "",
      "下面是独立代码块：",
      "",
      "```ts",
      "const ok = true;",
      "```",
    ].join("\n");
    expect(normalizeConsoleMarkdown(exampleThenCode)).toBe(exampleThenCode);

    const html = render(exampleThenCode);
    expect(html).toContain('<span class="console-msg-code-lang">markdown</span>');
    expect(html).toContain('<span class="console-msg-code-lang">ts</span>');
    expect(html).toContain("const ok = true;");
    expect(html).not.toContain('data-level="1"');
  });

  test("unwraps a longer outer fence while preserving shorter nested fences", () => {
    const wrapped = ["````markdown", "## 摘要", "", "```ts", "const ok = true;", "```", "````"].join("\n");
    expect(normalizeConsoleMarkdown(wrapped)).toBe(
      ["## 摘要", "", "```ts", "const ok = true;", "```"].join("\n"),
    );
  });
});

describe("ConsoleMarkdown rendering contract", () => {
  test("renders ordered lists with order and nested lists inside parent items", () => {
    const html = render(["1. 第一步", "   - 子步骤", "2. 第二步"].join("\n"));
    expect(html).toContain('<ol class="console-msg-list is-ordered">');
    expect(html).toContain("<li>第一步");
    expect(html).toContain('<ul class="console-msg-list">');
    expect(html).toContain("<li>子步骤</li>");
    expect(html).toContain("<li>第二步</li>");
  });

  test("renders GFM task list checkboxes with checked and disabled states", () => {
    const html = render(["- [x] 已完成", "- [ ] 待办"].join("\n"));
    expect(html).toContain('class="task-list-item"');
    expect(html).toContain('<input type="checkbox" disabled="" checked=""/>');
    expect(html).toContain('<input type="checkbox" disabled=""/>');
  });

  test("renders emphasis, strikethrough and bare URL autolinks", () => {
    const html = render("~~删除~~ *斜体* **加粗** https://example.com/path");
    expect(html).toContain("<del>删除</del>");
    expect(html).toContain("<em>斜体</em>");
    expect(html).toContain("<strong>加粗</strong>");
    expect(html).toContain('<a href="https://example.com/path"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test("renders tables with preserved console class and GFM alignment styles", () => {
    const html = render(["| 左 | 中 | 右 |", "| :-- | :-: | --: |", "| a | b | c |"].join("\n"));
    expect(html).toContain('<div class="console-msg-table-wrap">');
    expect(html).toContain('<table class="console-msg-table">');
    expect(html).toContain('style="text-align:left"');
    expect(html).toContain('style="text-align:center"');
    expect(html).toContain('style="text-align:right"');
  });

  test("renders blockquotes, dividers and inline code with existing class contract", () => {
    const html = render(["> 引用内容", "", "---", "", "行内 `code` 片段"].join("\n"));
    expect(html).toContain('<blockquote class="console-msg-quote">');
    expect(html).toContain("<hr/>");
    expect(html).toContain('<code class="console-inline-code">code</code>');
  });

  test("renders fenced code with shell, language label, copy button and unparsed content", () => {
    const html = render(["```ts", "const marker = **不是粗体**;", "```"].join("\n"));
    expect(html).toContain('data-testid="console-msg-codeblock"');
    expect(html).toContain('<pre class="console-msg-code">');
    expect(html).toContain('<span class="console-msg-code-lang">ts</span>');
    expect(html).toContain('aria-label="复制"');
    expect(html).toContain("const marker = **不是粗体**;");
    expect(html).not.toContain("<strong>");
  });

  test("unwraps whole-message markdown fences and still renders inner code fences", () => {
    const html = render(
      ["````markdown", "## 摘要", "", "- 列表项", "", "```ts", "const ok = true;", "```", "````"].join("\n"),
    );
    expect(html).toContain('data-level="2"');
    expect(html).toContain('<ul class="console-msg-list">');
    expect(html).toContain("摘要");
    expect(html).not.toContain("```");
    expect(html).toContain('<span class="console-msg-code-lang">ts</span>');

    const ts = render(["```ts", "# 不是标题", "```"].join("\n"));
    expect(ts).toContain('data-testid="console-msg-codeblock"');
    expect(ts).toContain("# 不是标题");
    expect(ts).not.toContain('data-level="1"');
  });

  test("renders file references as chips without href and external links safely", () => {
    const html = render("[配置文件](file:///repo/src/config.ts) 与 [站点](https://example.com/docs)");
    expect(html).toContain('class="console-file-ref"');
    expect(html).toContain('title="/repo/src/config.ts"');
    expect(html).not.toContain('href="file://');
    expect(html).toContain('<a href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test("escapes raw HTML, drops unsafe URLs and replaces images with a safe placeholder", () => {
    const html = render(
      ['<script>alert("x")</script>', "", "[危险](javascript:alert1)", "", "![示意图](https://example.com/a.png)"].join(
        "\n",
      ),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
    expect(html).toContain('class="console-msg-image-placeholder"');
    expect(html).toContain("图片未加载：示意图");
  });

  test("renders thinking variant with muted modifier while keeping Markdown", () => {
    const html = render("**重点**说明\n\n- 列表项", "thinking");
    expect(html).toContain('class="console-msg-rich is-thinking"');
    expect(html).toContain("<strong>重点</strong>");
    expect(html).toContain("<li>列表项</li>");
  });

  test("keeps soft line breaks inside a single paragraph", () => {
    const html = render("第一行\n第二行");
    expect(html.split("<p>").length - 1).toBe(1);
    expect(html).toContain("第一行\n第二行");
  });

  test("renders nothing for empty or whitespace-only content", () => {
    expect(render("   \n\t  ")).toBe("");
  });
});