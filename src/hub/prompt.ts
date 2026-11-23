import { buildOutputLanguageDirective, buildResumeLanguageReminder, type ResolvedOutputLanguage } from "../core/language.ts";
import { WORKBENCH_DIR, type AgentAction, type RequirementDetail } from "../core/types.ts";

export interface PromptBuildInput {
  action: AgentAction;
  root?: string;
  requirementId?: string;
  message?: string;
  anchor?: string;
  mode?: "ask" | "refine";
  resolveConflict?: boolean;
}

export interface PromptBuildOptions {
  resumedSession?: boolean;
  outputLanguage?: ResolvedOutputLanguage;
  fastCommand?: string | null;
  fullCommand?: string | null;
}

/** Builds a concise, high-signal continuation context for native session resume. */
export function buildCompactResumeContext(
  detail: RequirementDetail,
  input: PromptBuildInput,
  outputLanguage: ResolvedOutputLanguage,
): string {
  const { state, validity } = detail;
  const itemDirHint = `${WORKBENCH_DIR}/items/${state.id}`;
  const parts: string[] = [
    `- **当前阶段**：\`${state.stage}\` | **版本**：rev ${state.revision}（当前为同会话原生续接，最新上下文指引见 \`${itemDirHint}/handoff.md\`）`,
    buildResumeLanguageReminder(outputLanguage),
  ];

  const failedEvs = [...validity.verifications]
    .reverse()
    .filter((v) => v.effectiveState === "failed")
    .slice(0, 3);
  if (failedEvs.length > 0) {
    const perPreviewChars = Math.max(400, Math.floor(1500 / failedEvs.length));
    for (const failedEv of failedEvs) {
      parts.push(`- **最新失败验证**：\`${failedEv.record.command}\`（退出码 ${failedEv.record.exitCode}）`);
      if (failedEv.record.outputPreview?.trim()) {
        parts.push("```text");
        parts.push(failedEv.record.outputPreview.trim().slice(-perPreviewChars));
        parts.push("```");
      }
    }
  }

  if (state.reviewReport && (state.reviewReport.verdict !== "pass" || input.action === "fix")) {
    const rev = state.reviewReport;
    parts.push(
      `- **最新跨模型审查（${rev.verdict} / ${validity.reviewValidity.effectiveState}）**：${rev.summary}`,
    );
    if (rev.findings && rev.findings.length > 0) {
      for (const f of rev.findings.slice(0, 10)) {
        const loc = f.files && f.files.length > 0 ? ` (${f.files.join(", ")})` : "";
        const detailHint = f.detail ? `：${f.detail}` : "";
        const fixHint = f.suggestion ? ` → 建议：${f.suggestion}` : "";
        parts.push(`  - [${f.severity}] \`${f.id}\` ${f.title}${loc}${detailHint}${fixHint}`);
      }
    }
  }

  if (state.lastFeedback) {
    parts.push(`- **最新打回意见**：${state.lastFeedback}`);
  }
  if (input.message?.trim() && input.action !== "ask") {
    parts.push(`- **本次追加指令**：${input.message.trim()}`);
  }
  const pendingNotes = (state.discussions ?? []).filter((d) => !d.resolved);
  if (pendingNotes.length > 0) {
    parts.push("**待处理批注/讨论**：");
    for (const d of pendingNotes.slice(-6)) {
      parts.push(`- (${d.actor}/${d.mode}) ${d.anchor ? `[${d.anchor}] ` : ""}${d.message}`);
    }
  }
  return parts.join("\n");
}

/**
 * Single unified prompt builder shared by Hub Executor and Server Web/Bridge dispatch.
 * Gives agents native file-read/edit freedom while keeping Workbench's deterministic gates in the host.
 */
export function buildExecutionPrompt(
  detail: RequirementDetail,
  handoffMarkdown: string,
  input: PromptBuildInput,
  options: PromptBuildOptions = {},
): string {
  const reqId = detail.state.id;
  const itemDirHint = `${WORKBENCH_DIR}/items/${reqId}`;
  const lang: ResolvedOutputLanguage = options.outputLanguage ?? "zh-CN";
  const fastVerifyHint = options.fastCommand
    ? `\`${options.fastCommand}\` 或相关轻量检查`
    : "轻量类型/语法检查";

  if (input.action === "ask") {
    return [
      `你当前处于「只读问答探讨」模式，请针对工作台需求 ${reqId}（${detail.state.title}）回答用户问题。`,
      "- 仅做只读调研与解答，不要修改仓库文件或需求状态。",
      buildOutputLanguageDirective(lang, "ask"),
      "",
      input.anchor ? `提问锚点：${input.anchor}` : "",
      `用户问题：${input.message?.trim() || "请解释当前技术方案的核心思路与风险点。"}`,
      "",
      ...(options.resumedSession
        ? [`（同会话原生续接；完整指引见 \`${itemDirHint}/handoff.md\`）`]
        : [handoffMarkdown ? `上下文指引：\n${handoffMarkdown}` : `请先读取 \`${itemDirHint}/spec.md\` 与 \`${itemDirHint}/design.md\`。`]),
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (input.action === "review") {
    return [
      `请作为独立代码审查者（Cross-Model Reviewer）对工作台需求 ${reqId}（${detail.state.title}）执行只读 Code Review。`,
      "",
      "审查要求：",
      `1. 使用原生文件与 Git 工具检查 \`${itemDirHint}/spec.md\`、\`${itemDirHint}/design.md\`、实际 Git Diff（或调用 \`wb_get({ id: "${reqId}", includeDiff: true })\`）与验收证据。`,
      `2. 优先复用匹配证据：先核验 \`${itemDirHint}/evidence/\` 中与当前代码快照一致的验证日志，无需重跑已匹配的耗时测试（仅在证据缺失或过期时按需运行${fastVerifyHint}）。`,
      "3. 禁止修改任何仓库代码，禁止在后台运行命令（如 `&` 或 `run_in_background`）或等待外部通知；同步完成检查并聚焦真实问题：实现是否满足需求、是否存在功能/安全缺陷、是否存在删改或跳过测试的迹象。",
      "4. 严格区分严重度：`block` 仅用于确定性功能故障、数据/安全风险或必需验收条件未满足；`concern` 用于待确认的中等风险；低优先级优化建议放 `findings`（`low`）即可，若达标直接给 `pass`。",
      "",
      buildOutputLanguageDirective(lang, "review"),
      "",
      "请在输出末尾附上一个结构化结论 JSON 块：",
      lang === "en"
        ? '```json\n{"verdict":"pass"|"concern"|"block","summary":"One-sentence core review summary in English","findings":[{"id":"F-1","severity":"high"|"medium"|"low","title":"Short issue title","criterionIds":["AC-1"],"files":["src/path.ts:10"],"suggestion":"Concrete fix"}]}\n```'
        : '```json\n{"verdict":"pass"|"concern"|"block","summary":"用简体中文写出的一句话核心审查结论","findings":[{"id":"F-1","severity":"high"|"medium"|"low","title":"简明问题描述","criterionIds":["AC-1"],"files":["src/path.ts:10"],"suggestion":"具体修复建议"}]}\n```',
      "",
      handoffMarkdown || `权威文件：\`${itemDirHint}/spec.md\`、\`${itemDirHint}/design.md\`、\`${itemDirHint}/evidence/\`。`,
    ]
      .filter((line, idx, arr) => !(line === "" && arr[idx - 1] === ""))
      .join("\n");
  }

  if (input.action === "design") {
    const contextBlock = options.resumedSession
      ? buildCompactResumeContext(detail, input, lang)
      : handoffMarkdown || `请直接读取 \`${itemDirHint}/spec.md\` 并结合仓库现状调研。`;
    return [
      `请完成工作台需求 ${reqId}（${detail.state.title}）的规范整理与技术方案设计。`,
      "",
      "工作方式：",
      `1. 使用原生文件工具完整阅读 \`${itemDirHint}/spec.md\` 并调研相关源码；如需排查 Bug 或确认现有行为，可运行只读测试或检查命令复现定位。`,
      `2. 直接编辑 \`${itemDirHint}/spec.md\`（如需细化目标/边界）并在 \`${itemDirHint}/design.md\` 中写出清晰的技术方案；如同时明确了自动化验证命令，可通过 \`wb propose ${reqId}\` / \`wb_propose\` 或 \`${itemDirHint}/criteria.json\` 提交验收条件。`,
      "3. 本轮仅完成设计方案，不要修改业务源码或进入编码实施；方案写完后直接结束本轮，工作台将自动同步文件并提交人类审阅批准。",
      "",
      buildOutputLanguageDirective(lang, "plan"),
      "",
      contextBlock,
    ]
      .filter((line, idx, arr) => !(line === "" && arr[idx - 1] === ""))
      .join("\n");
  }

  // "implement" | "fix"
  const hasReviewToFix = Boolean(detail.state.reviewReport && detail.state.reviewReport.verdict !== "pass");
  const isCurrentReview = detail.validity.reviewValidity.effectiveState === "current";
  const hasHumanFeedback = Boolean(detail.state.lastFeedback) || Boolean(input.message?.trim());
  const isFastTrack = detail.state.track === "fast_track";

  let objectiveLine: string;
  if (input.action === "fix" && input.resolveConflict) {
    objectiveLine = `请仅解决 ${reqId} 沙箱分支与目标主干的合并冲突：安全暂存未提交业务改动、合并主干并保留双方正确逻辑，完成后直接结束本轮，工作台将自动运行验证。`;
  } else if (input.action === "fix") {
    if (hasReviewToFix && isCurrentReview) {
      objectiveLine = `请结合「待处理反馈与审查意见」及「失败与运行现场」，逐条修复 ${reqId} 的问题并补充必要回归测试。`;
    } else if (hasReviewToFix && hasHumanFeedback) {
      objectiveLine = `请优先落实「待处理反馈与审查意见」中的人类最新指令（历史过期审查意见仅供参考），修复 ${reqId} 的问题。`;
    } else {
      objectiveLine = `请结合「待处理反馈与审查意见」或「失败与运行现场」，诊断并修复 ${reqId} 当前失败或未达标的问题。`;
    }
  } else if (isFastTrack) {
    objectiveLine = `请依据需求规范（快速通道）完成 ${reqId}（${detail.state.title}）的代码实现与必要测试。`;
  } else {
    objectiveLine = `请依据已批准的规范与技术方案完成 ${reqId}（${detail.state.title}）的代码实现与必要测试。`;
  }

  const contextBlock = options.resumedSession
    ? buildCompactResumeContext(detail, input, lang)
    : handoffMarkdown || `请直接读取 \`${itemDirHint}/spec.md\`${detail.designMarkdown.trim() ? ` 与 \`${itemDirHint}/design.md\`` : ""}。`;

  const screenshotHint =
    detail.state.uiRelated === true
      ? `4. 本需求涉及 UI，提交验收时工作台会自动采集界面截图；如有需要也可运行 \`wb screenshot ${reqId}\`。`
      : "";

  return [
    objectiveLine,
    "",
    "工作方式：",
    `1. 使用原生文件工具完整阅读 \`${itemDirHint}/spec.md\`${detail.designMarkdown.trim() ? ` 与 \`${itemDirHint}/design.md\`` : ""}，以磁盘完整原文为准。`,
    "2. 只改动与本需求相关的代码与测试，并按需在本地运行测试验证改动正确性。",
    "3. 完成后直接结束本轮即可——工作台会在你退出后自动执行必需验收命令，全部通过则自动进入人工验收，若有失败会自动把报错交回给你继续修复（勿在后台留下未结束命令或等待人工确认；批准与最终验收仅由人类在工作台触发）。",
    screenshotHint,
    "",
    buildOutputLanguageDirective(lang, "plan"),
    "",
    contextBlock,
  ]
    .filter((line, idx, arr) => !(line === "" && arr[idx - 1] === ""))
    .join("\n");
}
