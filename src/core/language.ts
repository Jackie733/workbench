import { OUTPUT_LANGUAGES, type OutputLanguage } from "./types.ts";

export type ResolvedOutputLanguage = "zh-CN" | "en";

export const DEFAULT_OUTPUT_LANGUAGE: OutputLanguage = "zh-CN";

export function normalizeOutputLanguage(raw: unknown): OutputLanguage | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return (OUTPUT_LANGUAGES as readonly string[]).includes(trimmed) ? (trimmed as OutputLanguage) : undefined;
}

function stripCodeBlocksAndInlineCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]+`/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
}

export function detectLanguageFromText(text?: string | null): ResolvedOutputLanguage {
  if (!text || !text.trim()) return "zh-CN";
  const prose = stripCodeBlocksAndInlineCode(text);
  const cjkCount = (prose.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latinWords = (prose.match(/\b[A-Za-z]{2,}\b/g) ?? []).length;
  if (cjkCount >= 2 || (cjkCount > 0 && cjkCount >= latinWords * 0.2)) {
    return "zh-CN";
  }
  if (latinWords >= 4 && cjkCount === 0) {
    return "en";
  }
  return "zh-CN";
}

/**
 * Resolves the effective document output language using precedence:
 * project.outputLanguage -> hub.outputLanguage -> DEFAULT_OUTPUT_LANGUAGE ("zh-CN").
 */
export function resolveEffectiveOutputLanguage(options: {
  projectLanguage?: OutputLanguage;
  hubLanguage?: OutputLanguage;
  contextText?: string;
} = {}): ResolvedOutputLanguage {
  const chosen = options.projectLanguage ?? options.hubLanguage ?? DEFAULT_OUTPUT_LANGUAGE;
  if (chosen === "zh-CN" || chosen === "en") return chosen;
  return detectLanguageFromText(options.contextText);
}

export function formatOutputLanguageLabel(lang: OutputLanguage): string {
  switch (lang) {
    case "zh-CN":
      return "简体中文 (zh-CN)";
    case "en":
      return "English (en)";
    case "auto":
      return "跟随需求语言 (auto)";
  }
}

export function buildOutputLanguageDirective(
  lang: ResolvedOutputLanguage,
  scope: "plan" | "review" | "ask" | "all" = "all",
): string {
  if (lang === "en") {
    const scopeHint =
      scope === "review"
        ? "the code review Markdown body and the JSON `summary` field"
        : scope === "ask"
          ? "your consultation response"
          : "all human-readable planning and delivery fields (`title`, `spec.md`, `design.md`, `criteria[].description`, `summary`, review report, and responses)";
    return [
      "[Mandatory Output Language: English (en)]",
      `- Write ${scopeHint} strictly in clear, concise English.`,
      "- Even if earlier requirements, UI labels, or user prompts contain Chinese text, output the generated documentation in English.",
      "- Preserve exact code identifiers, file paths, and shell commands verbatim.",
    ].join("\n");
  }

  const scopeHint =
    scope === "review"
      ? "审查报告正文与末尾 JSON 中的 `summary` 字段"
      : scope === "ask"
        ? "问答探讨回复正文"
        : "所有面向人类阅读的规划与交付字段——包括 `title`、`spec.md`、`design.md`、`criteria[].description`、`summary`、代码审查报告正文与 `summary`";

  return [
    "【强制输出语言规范：简体中文 (zh-CN)】",
    `- ${scopeHint}必须严格使用简体中文编写。`,
    "- 仅代码标识符、文件路径、命令行（`criteria[].command`）、API/配置键名及专有名词保留英文原文。",
    "- 即使代码仓库注释、工具 Schema 或历史需求存在英文，也严禁整篇切换为英文输出。",
  ].join("\n");
}

export function buildResumeLanguageReminder(lang: ResolvedOutputLanguage): string {
  return lang === "en"
    ? "- **Output Language**: Strictly write all titles, specs, designs, criteria descriptions, tasks, and summaries in English (en)."
    : "- **输出语言规范**：所有提交的标题、规范、方案、验收条件描述、任务与总结必须严格使用简体中文 (zh-CN)。";
}

/**
 * Non-blocking check used when an agent calls wb_propose so drift (e.g. English essay under zh-CN)
 * surfaces an immediate gentle reminder without breaking code-heavy specs.
 */
export function checkLanguageMismatchWarning(
  lang: ResolvedOutputLanguage,
  fields: {
    title?: string;
    spec?: string;
    design?: string;
    criteriaDescriptions?: string[];
  },
): string | null {
  const combined = [
    fields.title ?? "",
    fields.spec ?? "",
    fields.design ?? "",
    ...(fields.criteriaDescriptions ?? []),
  ]
    .filter(Boolean)
    .join("\n");

  const prose = stripCodeBlocksAndInlineCode(combined).replace(/\s+/g, " ").trim();
  if (!prose || prose.length < 60) return null;

  const cjkCount = (prose.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latinWords = (prose.match(/\b[A-Za-z]{2,}\b/g) ?? []).length;

  if (lang === "zh-CN" && cjkCount === 0 && latinWords >= 12) {
    return "当前项目/Hub 输出语言配置为简体中文 (zh-CN)，但本次提交的文档正文未检测到中文内容；请使用简体中文重写面向人类阅读的标题、规范、方案与验收条件描述（仅保留代码符号与命令原文）。";
  }
  if (lang === "en" && cjkCount >= 12 && cjkCount > latinWords * 0.5) {
    return "The configured output language is English (en), but the submitted document is predominantly Chinese. Please write human-readable titles, specs, designs, and criteria descriptions in English.";
  }
  return null;
}
