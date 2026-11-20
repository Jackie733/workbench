import { buildOutputLanguageDirective, type ResolvedOutputLanguage } from "../core/language.ts";
import type { RequirementDetail } from "../core/types.ts";

export type DispatchAction = "design" | "implement" | "fix" | "review";

/** Builds a clear, tool-grounded task prompt for any Coding Agent from current requirement state. */
export function buildAgentPrompt(
  detail: RequirementDetail,
  action: DispatchAction,
  options: { outputLanguage?: ResolvedOutputLanguage } = {},
): string {
  const { state, specMarkdown, designMarkdown, validity } = detail;
  const lang: ResolvedOutputLanguage = options.outputLanguage ?? "zh-CN";
  const langDirective = buildOutputLanguageDirective(lang, action === "review" ? "review" : "plan");
  const header = `请处理工作台需求 ${state.id}：${state.title}`;

  if (action === "review") {
    return [
      `请作为独立代码审查者对工作台需求 ${state.id}（${state.title}）执行只读 Code Review。`,
      "",
      langDirective,
      "",
      "请执行以下步骤（严禁修改代码或批准/验收）：",
      `1. 调用 wb_get({ id: "${state.id}", includeDiff: true }) 检查需求规范、验收证据与 Git Diff。`,
      "2. 在工作台或通过 `wb review` 提交结构化审查结论（pass / concern / block）。",
    ].join("\n");
  }

  if (action === "design") {
    const feedback = state.lastFeedback ? `\n人工修改意见：\n${state.lastFeedback}\n` : "";
    return [
      header,
      "",
      langDirective,
      "",
      "当前需求目标（spec.md）：",
      specMarkdown.trim(),
      feedback,
      "请执行以下步骤：",
      `1. 先调用 wb_get({ id: "${state.id}" }) 读取完整上下文，并结合代码库调研现状。`,
      `2. 调用 wb_propose({ id: "${state.id}", title, spec, criteria, design, summary }) 提交清晰的规范正文、分层验收条件（快速检查 + 针对性局部测试命令，仅在修改核心逻辑时附加单条全量门禁，纯文档勿捆绑全量）和技术方案 Markdown。`,
      "3. 提交后状态将变为待批准，等待我在工作台审阅拍板。",
    ]
      .filter((line, idx, arr) => !(line === "" && arr[idx - 1] === ""))
      .join("\n");
  }

  if (action === "fix") {
    const failed = validity.coverage.items
      .filter((item) => item.state === "failed" || item.state === "stale" || item.state === "unverified")
      .map((item) => `- ${item.criterion.id}: ${item.criterion.description} [${item.state}${item.reason ? `：${item.reason}` : ""}]`);
    const reviewNote =
      state.reviewReport && state.reviewReport.verdict !== "pass"
        ? `最新跨模型 Code Review（${state.reviewReport.verdict}）：\n${state.reviewReport.summary}\n${
            state.reviewReport.findings?.length
              ? state.reviewReport.findings.map((f) => `- [${f.severity}] ${f.id}: ${f.title}`).join("\n")
              : ""
          }\n`
        : "";
    return [
      header,
      "",
      langDirective,
      "",
      reviewNote,
      state.lastFeedback ? `人工反馈意见：\n${state.lastFeedback}\n` : "",
      failed.length > 0 ? `当前未通过或需重跑的验收条件：\n${failed.join("\n")}\n` : "",
      "请执行以下步骤：",
      `1. 调用 wb_get({ id: "${state.id}", includeDiff: true }) 查看最新状态、审查问题、错误详情与代码改动。`,
      "2. 逐条修复问题并补充必要回归测试；开发期仅跑相关局部测试，全量验证统一通过 wb_verify 执行，确保全部必需验收条件通过。",
      "3. 严禁修改与本需求无关的文件或无关失败测试；如需更新交接说明请用 wb_update_tasks({ id, handoffNote })，禁止调用 wb_propose；全部通过后调用 wb_update_tasks({ id: \"" +
        state.id +
        "\", readyForAcceptance: true }) 提交验收。",
    ]
      .filter((line, idx, arr) => !(line === "" && arr[idx - 1] === ""))
      .join("\n");
  }

  // "implement"
  const criteriaLines = state.criteria.map(
    (c) => `- ${c.id} (${c.required ? "必需" : "参考"}): ${c.description}${c.command ? ` [命令: ${c.command}]` : ""}`,
  );
  const isFastTrack = state.track === "fast_track";
  return [
    header,
    "",
    langDirective,
    "",
    `当前阶段：${state.stage} · 轨道：${isFastTrack ? "快速通道" : "方案已批准"}`,
    criteriaLines.length > 0 ? `\n验收条件：\n${criteriaLines.join("\n")}` : "",
    designMarkdown.trim() ? `\n已批准方案摘要（完整内容见 .workbench/items/${state.id}/design.md）：\n${designMarkdown.trim().slice(0, 1200)}` : "",
    "",
    "请执行以下步骤：",
    ...(isFastTrack
      ? [
          "1. 根据需求目标与验收条件在代码库完成修改（快速通道无需额外拆解 tasks；开发期仅跑局部测试，勿直接跑全量）。",
          "2. 通过 wb_verify 运行真实测试/检查命令绑定对应 criterionIds（只修改本需求相关文件，勿改无关测试）。",
          `3. 全部必需验收条件通过后，调用 wb_update_tasks({ id: "${state.id}", readyForAcceptance: true }) 提交人类验收。`,
        ]
      : [
          `1. 如需完整上下文可调用 wb_get({ id: "${state.id}" })，使用 wb_update_tasks 拆解并实时维护实施任务进度。`,
          "2. 在代码库完成开发修改（仅改相关文件，开发期仅跑局部测试），并通过 wb_verify 运行真实的验证命令绑定对应 criterionIds。",
          `3. 全部必需验收条件在最新代码快照下通过后，调用 wb_update_tasks({ id: "${state.id}", readyForAcceptance: true }) 提交人工验收。`,
        ]),
  ]
    .filter((line, idx, arr) => !(line === "" && arr[idx - 1] === ""))
    .join("\n");
}
