import { describe, expect, test } from "bun:test";
import { parseUnifiedDiff, renderMarkdown, renderSimpleLineDiff } from "../../src/web/render.ts";

describe("web markdown and diff renderers", () => {
  test("renders GFM markdown safely and strips XSS vectors", () => {
    const html = renderMarkdown(
      [
        "# 方案标题",
        "",
        "包含 **加粗**、`inline_code`、[安全链接](https://example.com) 与 [危险链接](javascript:alert(1))。",
        "",
        "- [x] 已完成",
        "- [ ] 待完成",
        "",
        "| 字段 | 说明 |",
        "| --- | --- |",
        "| id | 编号 |",
        "",
        "```ts",
        "const x = '<script>alert(1)</script>';",
        "```",
      ].join("\n"),
    );

    expect(html).toContain("<h1>方案标题</h1>");
    expect(html).toContain("<strong>加粗</strong>");
    expect(html).toContain("<code>inline_code</code>");
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain("javascript:alert");
    expect(html).toContain("☑ 已完成");
    expect(html).toContain("☐ 待完成");
    expect(html).toContain("<table>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  test("parses unified git diff per file and counts additions/deletions", () => {
    const parsed = parseUnifiedDiff(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "index 111..222 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,2 +1,3 @@",
        " const a = 1;",
        "-const b = 2;",
        "+const b = 3;",
        "+const c = 4;",
      ].join("\n"),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.path).toBe("src/a.ts");
    expect(parsed[0]!.additions).toBe(2);
    expect(parsed[0]!.deletions).toBe(1);
  });

  test("computes readable line diff between markdown design versions", () => {
    const html = renderSimpleLineDiff("第一行\n旧方案\n第三行", "第一行\n新方案\n第三行");
    expect(html).toContain("-旧方案");
    expect(html).toContain("+新方案");
  });
});
