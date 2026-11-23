import type { ResolvedOutputLanguage } from "../core/language.ts";
import { WORKBENCH_DIR, type RequirementDetail } from "../core/types.ts";
import { buildExecutionPrompt } from "../hub/prompt.ts";

export type DispatchAction = "design" | "implement" | "fix" | "review";

/**
 * Builds a unified, file-native task prompt for Web/Bridge dispatches by delegating
 * directly to the Hub execution prompt builder (single source of truth).
 */
export function buildAgentPrompt(
  detail: RequirementDetail,
  action: DispatchAction,
  options: { outputLanguage?: ResolvedOutputLanguage } = {},
): string {
  const { state, validity } = detail;
  const itemDirHint = `${WORKBENCH_DIR}/items/${state.id}`;

  const inlineContextParts: string[] = [];
  if (state.reviewReport && state.reviewReport.verdict !== "pass" && action === "fix") {
    inlineContextParts.push("## 待处理反馈与审查意见");
    inlineContextParts.push(`- **跨模型审查（${state.reviewReport.verdict}）**：${state.reviewReport.summary}`);
    for (const f of state.reviewReport.findings ?? []) {
      inlineContextParts.push(`  - [${f.severity}] \`${f.id}\` ${f.title}`);
    }
  }
  if (state.lastFeedback) {
    if (inlineContextParts.length === 0) inlineContextParts.push("## 待处理反馈与审查意见");
    inlineContextParts.push(`- **人工反馈意见**：${state.lastFeedback}`);
  }
  const failed = validity.coverage.items.filter(
    (item) => item.state === "failed" || item.state === "stale" || item.state === "unverified",
  );
  if (action === "fix" && failed.length > 0) {
    inlineContextParts.push("", "## 失败与运行现场");
    for (const item of failed) {
      inlineContextParts.push(
        `- ${item.criterion.id}: ${item.criterion.description} [${item.state}${item.reason ? `：${item.reason}` : ""}]`,
      );
    }
  }
  if (state.criteria.length > 0) {
    inlineContextParts.push("", "## 验收条件状态");
    for (const item of validity.coverage.items) {
      const cmdTag = item.criterion.command ? ` | 命令: \`${item.criterion.command}\`` : "";
      inlineContextParts.push(
        `- **${item.criterion.id}** (${item.criterion.required ? "必需" : "参考"}, ${item.state}): ${item.criterion.description}${cmdTag}`,
      );
    }
  }
  inlineContextParts.push(
    "",
    "## 权威文件指引",
    `- 需求规范：\`${itemDirHint}/spec.md\``,
    ...(detail.designMarkdown.trim() ? [`- 技术方案：\`${itemDirHint}/design.md\``] : []),
  );

  return buildExecutionPrompt(
    detail,
    inlineContextParts.join("\n"),
    { action },
    { outputLanguage: options.outputLanguage },
  );
}
