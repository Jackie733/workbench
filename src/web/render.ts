export function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^(https?:\/\/|\/|#)/i.test(trimmed)) return trimmed;
  return null;
}

function renderInline(raw: string): string {
  const codeTokens: string[] = [];
  let text = raw.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const idx = codeTokens.length;
    codeTokens.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000CODE${idx}\u0000`;
  });

  text = escapeHtml(text);
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => {
    const clean = safeHref(url);
    return clean
      ? `<a href="${escapeHtml(clean)}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : label;
  });
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  text = text.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");

  return text.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx: string) => codeTokens[Number(idx)] ?? "");
}

export interface MarkdownRenderOptions {
  annotatable?: boolean;
  docLabel?: string;
}

/** Renders GitHub-Flavored Markdown safely to HTML without external runtime libraries. */
export function renderMarkdown(markdown: string, options: MarkdownRenderOptions = {}): string {
  const normalized = markdown.replace(/\r\n/g, "\n").trim();
  if (!normalized) return `<p class="muted">（暂无内容）</p>`;
  const annotatable = options.annotatable === true;
  const docLabel = options.docLabel ?? "doc";
  const wrapHeading = (level: number, rawHeading: string) => {
    const inner = renderInline(rawHeading);
    if (!annotatable) return `<h${level}>${inner}</h${level}>`;
    const anchor = `${docLabel}#${rawHeading.trim().slice(0, 60)}`;
    return `<div class="md-annot-row"><h${level}>${inner}</h${level}><button class="btn ghost xs md-annot-btn" type="button" data-action="annotate-anchor" data-anchor="${escapeHtml(anchor)}" title="对此段提问或批注">💬 批注</button></div>`;
  };

  const lines = normalized.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block
    const fenceMatch = /^```([A-Za-z0-9_-]*)\s*$/.exec(line);
    if (fenceMatch) {
      const lang = fenceMatch[1] ?? "";
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        codeLines.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) i += 1;
      out.push(`<pre><code class="lang-${escapeHtml(lang)}">${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    // Blank line
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // Horizontal rule
    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
      out.push("<hr />");
      i += 1;
      continue;
    }

    // Headings
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      out.push(wrapHeading(level, heading[2]!));
      i += 1;
      continue;
    }

    // Blockquote
    if (line.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) {
        quoteLines.push(lines[i]!.replace(/^>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${renderInline(quoteLines.join(" "))}</blockquote>`);
      continue;
    }

    // Table
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(lines[i + 1]!)) {
      const splitRow = (rowLine: string) =>
        rowLine
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((c) => c.trim());
      const headers = splitRow(line);
      i += 2;
      const bodyRows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) {
        bodyRows.push(splitRow(lines[i]!));
        i += 1;
      }
      const headHtml = headers.map((h) => `<th>${renderInline(h)}</th>`).join("");
      const bodyHtml = bodyRows
        .map((row) => `<tr>${headers.map((_, idx) => `<td>${renderInline(row[idx] ?? "")}</td>`).join("")}</tr>`)
        .join("");
      out.push(`<table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`);
      continue;
    }

    // Unordered / ordered lists
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) {
        const content = lines[i]!.replace(/^\s*[-*+]\s+/, "");
        const taskMatch = /^\[( |x|X)\]\s+(.*)$/.exec(content);
        if (taskMatch) {
          const checked = taskMatch[1]!.toLowerCase() === "x";
          items.push(`<li>${checked ? "☑" : "☐"} ${renderInline(taskMatch[2]!)}</li>`);
        } else {
          items.push(`<li>${renderInline(content)}</li>`);
        }
        i += 1;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        items.push(`<li>${renderInline(lines[i]!.replace(/^\s*\d+\.\s+/, ""))}</li>`);
        i += 1;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // Paragraph
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^```/.test(lines[i]!) &&
      !/^#{1,6}\s+/.test(lines[i]!) &&
      !lines[i]!.startsWith(">") &&
      !/^\s*[-*+]\s+/.test(lines[i]!) &&
      !/^\s*\d+\.\s+/.test(lines[i]!)
    ) {
      para.push(lines[i]!);
      i += 1;
    }
    out.push(`<p>${renderInline(para.join(" "))}</p>`);
  }

  return out.join("\n");
}

export interface ParsedDiffFile {
  path: string;
  additions: number;
  deletions: number;
  lines: string[];
}

/** Splits unified git diff text into per-file sections with line counts. */
export function parseUnifiedDiff(diffText: string): ParsedDiffFile[] {
  if (!diffText.trim()) return [];
  const lines = diffText.split("\n");
  const files: ParsedDiffFile[] = [];
  let current: ParsedDiffFile | null = null;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      const filePath = match ? match[2]! : line.slice("diff --git ".length);
      current = { path: filePath, additions: 0, deletions: 0, lines: [line] };
      files.push(current);
      continue;
    }
    if (!current) {
      current = { path: "diff", additions: 0, deletions: 0, lines: [] };
      files.push(current);
    }
    current.lines.push(line);
    if (line.startsWith("+") && !line.startsWith("+++")) current.additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) current.deletions += 1;
  }

  return files;
}

export function renderDiffLinesHtml(lines: string[]): string {
  return lines
    .map((line) => {
      let cls = "diff-line";
      if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) {
        cls += " meta";
      } else if (line.startsWith("@@")) {
        cls += " hunk";
      } else if (line.startsWith("+")) {
        cls += " add";
      } else if (line.startsWith("-")) {
        cls += " del";
      }
      return `<div class="${cls}">${escapeHtml(line || " ")}</div>`;
    })
    .join("");
}

/** Computes a simple readable line diff between two markdown design versions. */
export function renderSimpleLineDiff(beforeText: string, afterText: string): string {
  const a = beforeText.replace(/\r\n/g, "\n").split("\n");
  const b = afterText.replace(/\r\n/g, "\n").split("\n");
  const m = a.length;
  const n = b.length;

  // Guard LCS memory for very large texts
  if (m * n > 250_000) {
    return renderDiffLinesHtml([
      "@@ 文档较大，显示行级摘要 @@",
      ...a.map((l) => `-${l}`),
      ...b.map((l) => `+${l}`),
    ]);
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? 1 + dp[i + 1]![j + 1]! : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const diffLines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      diffLines.push(` ${a[i]}`);
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      diffLines.push(`-${a[i]}`);
      i += 1;
    } else {
      diffLines.push(`+${b[j]}`);
      j += 1;
    }
  }
  while (i < m) {
    diffLines.push(`-${a[i]}`);
    i += 1;
  }
  while (j < n) {
    diffLines.push(`+${b[j]}`);
    j += 1;
  }
  return renderDiffLinesHtml(diffLines);
}
