import type { RequirementDetail } from "../core/types.ts";

export type DispatchAction = "design" | "implement" | "fix";

/** Builds a clear, tool-grounded task prompt for any Coding Agent from current requirement state. */
export function buildAgentPrompt(detail: RequirementDetail, action: DispatchAction): string {
  const { state, specMarkdown, designMarkdown, validity } = detail;
  const header = `请处理工作台需求 ${state.id}：${state.title}`;

  if (action === "design") {
    const feedback = state.lastFeedback ? `\n人工修改意见：\n${state.lastFeedback}\n` : "";
    return [
      header,
      "",
      "当前需求目标（spec.md）：",
      specMarkdown.trim(),
      feedback,
      "请执行以下步骤：",
      `1. 先调用 wb_get({ id: "${state.id}" }) 读取完整上下文，并结合代码库调研现状。`,
      `2. 调用 wb_propose({ id: "${state.id}", title, spec, criteria, design, summary }) 提交清晰的规范正文、结构化验收条件（尽可能附带可执行验证命令 command）和技术方案 Markdown。`,
      "3. 提交后状态将变为待批准，等待我在工作台审阅拍板。",
    ]
      .filter((line, idx, arr) => !(line === "" && arr[idx - 1] === ""))
      .join("\n");
  }

  if (action === "fix") {
    const failed = validity.coverage.items
      .filter((item) => item.state === "failed" || item.state === "stale" || item.state === "unverified")
      .map((item) => `- ${item.criterion.id}: ${item.criterion.description} [${item.state}${item.reason ? `：${item.reason}` : ""}]`);
    return [
      header,
      "",
      state.lastFeedback ? `人工反馈意见：\n${state.lastFeedback}\n` : "",
      failed.length > 0 ? `当前未通过或需重跑的验收条件：\n${failed.join("\n")}\n` : "",
      "请执行以下步骤：",
      `1. 调用 wb_get({ id: "${state.id}", includeDiff: true }) 查看最新状态、错误详情与代码改动。`,
      "2. 修复代码或补充测试，并通过 wb_verify 运行真实测试命令，确保全部必需验收条件通过。",
      `3. 更新任务清单并在全部验证通过后调用 wb_update_tasks({ id: "${state.id}", readyForAcceptance: true }) 提交验收。`,
    ]
      .filter((line, idx, arr) => !(line === "" && arr[idx - 1] === ""))
      .join("\n");
  }

  // "implement"
  const criteriaLines = state.criteria.map(
    (c) => `- ${c.id} (${c.required ? "必需" : "参考"}): ${c.description}${c.command ? ` [命令: ${c.command}]` : ""}`,
  );
  return [
    header,
    "",
    `当前阶段：${state.stage} · 轨道：${state.track === "fast_track" ? "快速通道" : "方案已批准"}`,
    criteriaLines.length > 0 ? `\n验收条件：\n${criteriaLines.join("\n")}` : "",
    designMarkdown.trim() ? `\n已批准方案摘要（完整内容请通过 wb_get 读取）：\n${designMarkdown.trim().slice(0, 1200)}` : "",
    "",
    "请执行以下步骤：",
    `1. 先调用 wb_get({ id: "${state.id}" }) 读取完整需求与方案，使用 wb_update_tasks 拆解并实时维护实施任务进度。`,
    "2. 在代码库完成开发修改，并通过 wb_verify 运行真实的验证命令绑定对应 criterionIds。",
    `3. 全部必需验收条件在最新代码快照下通过后，调用 wb_update_tasks({ id: "${state.id}", readyForAcceptance: true }) 提交人工验收。`,
  ]
    .filter((line, idx, arr) => !(line === "" && arr[idx - 1] === ""))
    .join("\n");
}
