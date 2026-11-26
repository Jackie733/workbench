import {
  Children,
  isValidElement,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Check, Copy, FileText } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { t, type UiLanguage } from "../i18n.ts";
import { copyTextToClipboard } from "../lib/clipboard.ts";
import { cn } from "../lib/utils.ts";
import { Icon } from "./Icon.tsx";
import { Button } from "./ui/button.tsx";

export interface ConsoleMarkdownProps {
  text: string;
  language: UiLanguage;
  variant?: "message" | "thinking";
}

const REMARK_PLUGINS = [remarkGfm];
const ALLOWED_URL_RE = /^(?:https?:|mailto:|file:|#)/i;

export function consoleUrlTransform(url: string): string {
  const trimmed = url.trim();
  return ALLOWED_URL_RE.test(trimmed) ? trimmed : "";
}

/**
 * Unwraps a message that is fully wrapped by a ```markdown / ```md / ```gfm fence.
 * Only the first legal closing fence may close the wrapper, and it must be the
 * final line. Messages that merely start with a markdown example fence (and end
 * with an unrelated code block) are therefore left untouched. Legitimate nested
 * code fences inside the wrapper need a longer outer fence, as in CommonMark.
 */
export function normalizeConsoleMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").trim().split("\n");
  const open = /^ {0,3}(`{3,})\s*(?:markdown|md|gfm)\s*$/i.exec(lines[0] ?? "");
  if (!open) return text;
  const fence = open[1]!;
  const closeRe = new RegExp(`^ {0,3}\`{${fence.length},}\\s*$`);
  let closeIdx = -1;
  for (let idx = 1; idx < lines.length; idx++) {
    if (closeRe.test(lines[idx]!)) {
      closeIdx = idx;
      break;
    }
  }
  if (closeIdx !== lines.length - 1) return text;
  return lines.slice(1, closeIdx).join("\n").trim();
}

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

function extractCode(children: ReactNode): { code: string; lang: string } {
  const element = Children.toArray(children).find((child) => isValidElement(child)) as
    | ReactElement<{ className?: string; children?: ReactNode }>
    | undefined;
  if (!element) return { code: nodeText(children), lang: "" };
  const className = typeof element.props.className === "string" ? element.props.className : "";
  const lang = /(?:^|\s)language-([^\s]+)/.exec(className)?.[1] ?? "";
  return { code: nodeText(element.props.children).replace(/\n$/, ""), lang };
}

function makeHeading(level: 1 | 2 | 3 | 4 | 5 | 6): Components["h1"] {
  return ({ node: _node, ...props }) => (
    <div {...props} role="heading" aria-level={level} data-level={level} className="console-msg-heading" />
  );
}

function ConsoleCodeBlock({ code, lang, language }: { code: string; lang: string; language: UiLanguage }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = async () => {
    const ok = await copyTextToClipboard(code);
    if (!ok) return;
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1800);
  };

  const label = t(language, copied ? "console.copied" : "console.copy");

  return (
    <div className="console-msg-codeblock" data-testid="console-msg-codeblock">
      <div className="console-msg-code-head">
        {lang && <span className="console-msg-code-lang">{lang}</span>}
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="console-msg-code-copy"
          aria-label={label}
          title={label}
          onClick={() => void handleCopy()}
        >
          <Icon icon={copied ? Check : Copy} size={14} />
        </Button>
      </div>
      <pre className="console-msg-code">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function createConsoleComponents(language: UiLanguage): Components {
  return {
    h1: makeHeading(1),
    h2: makeHeading(2),
    h3: makeHeading(3),
    h4: makeHeading(4),
    h5: makeHeading(5),
    h6: makeHeading(6),
    ul: ({ node: _node, className, ...props }) => (
      <ul {...props} className={cn("console-msg-list", className)} />
    ),
    ol: ({ node: _node, className, ...props }) => (
      <ol {...props} className={cn("console-msg-list", "is-ordered", className)} />
    ),
    blockquote: ({ node: _node, className, ...props }) => (
      <blockquote {...props} className={cn("console-msg-quote", className)} />
    ),
    table: ({ node: _node, className, ...props }) => (
      <div className="console-msg-table-wrap">
        <table {...props} className={cn("console-msg-table", className)} />
      </div>
    ),
    code: ({ node: _node, className, ...props }) => (
      <code {...props} className={cn("console-inline-code", className)} />
    ),
    pre: ({ node: _node, children }) => {
      const { code, lang } = extractCode(children);
      return <ConsoleCodeBlock code={code} lang={lang} language={language} />;
    },
    a: ({ node: _node, href, children, ...props }) => {
      if (!href) return <span>{children}</span>;
      if (/^file:\/\//i.test(href)) {
        const fsPath = href.replace(/^file:\/\//i, "");
        return (
          <span className="console-file-ref" title={fsPath}>
            <Icon icon={FileText} size={14} />
            <span>{children}</span>
          </span>
        );
      }
      if (!/^(?:https?:|mailto:)/i.test(href)) return <span>{children}</span>;
      return (
        <a {...props} href={href} target="_blank" rel="noopener noreferrer" className="console-link">
          {children}
        </a>
      );
    },
    img: ({ node: _node, alt }) => {
      const altText = alt?.trim() ?? "";
      const message = t(language, "console.imageAlt", { alt: altText });
      return <span className="console-msg-image-placeholder">{altText ? message : message.replace(/[：:]\s*$/, "")}</span>;
    },
  };
}

export const ConsoleMarkdown = memo(function ConsoleMarkdown({
  text,
  language,
  variant = "message",
}: ConsoleMarkdownProps) {
  const components = useMemo(() => createConsoleComponents(language), [language]);
  const normalized = normalizeConsoleMarkdown(text);
  if (!normalized.trim()) return null;

  return (
    <div className={cn("console-msg-rich", variant === "thinking" && "is-thinking")}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        urlTransform={consoleUrlTransform}
        components={components}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
});