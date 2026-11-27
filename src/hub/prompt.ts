import * as path from "node:path";
import { attachmentFileName, formatAttachmentSize } from "../core/attachments.ts";
import { getVerificationEvidence } from "../core/engine.ts";
import { buildOutputLanguageDirective, buildResumeLanguageReminder, type ResolvedOutputLanguage } from "../core/language.ts";
import { resolveCodeRoot } from "../core/sandbox.ts";
import { WORKBENCH_DIR, type AgentAction, type RequirementDetail } from "../core/types.ts";
import { sanitizeOutput } from "../core/validate.ts";
import type { ConflictHandoffContext } from "./handoff.ts";

export interface PromptBuildInput {
  action: AgentAction;
  root?: string;
  requirementId?: string;
  message?: string;
  anchor?: string;
  mode?: "ask" | "refine";
  resolveConflict?: boolean;
  conflictContext?: ConflictHandoffContext;
}

export interface PromptBuildOptions {
  resumedSession?: boolean;
  outputLanguage?: ResolvedOutputLanguage;
  fastCommand?: string | null;
  fullCommand?: string | null;
  /** Spec hash from the resumed run; when different from current, prompts agent to re-read spec.md/design.md. */
  previousSpecHash?: string | null;
  /** Prior reviewed commit SHA when performing an exact incremental re-review (`fromCommit..HEAD`). */
  incrementalReviewFromCommit?: string | null;
}

/** Builds a concise, high-signal continuation context for native session resume. */
export function buildCompactResumeContext(
  detail: RequirementDetail,
  input: PromptBuildInput,
  outputLanguage: ResolvedOutputLanguage,
  options: { previousSpecHash?: string | null } = {},
): string {
  const { state, validity } = detail;
  const itemDirHint = `${WORKBENCH_DIR}/items/${state.id}`;
  const isEn = outputLanguage === "en";
  const parts: string[] = [
    isEn
      ? `- **Stage**: \`${state.stage}\` | **Rev**: ${state.revision} (native session resume; latest brief at \`${itemDirHint}/handoff.md\`)`
      : `- **当前阶段**：\`${state.stage}\` | **版本**：rev ${state.revision}（当前为同会话原生续接，最新上下文指引见 \`${itemDirHint}/handoff.md\`）`,
    buildResumeLanguageReminder(outputLanguage),
  ];

  if (options.previousSpecHash && options.previousSpecHash !== state.specHash) {
    parts.push(
      isEn
        ? `- **Document Updated**: \`${itemDirHint}/spec.md\` or criteria changed since your last turn; re-read \`${itemDirHint}/spec.md\` and \`${itemDirHint}/design.md\` before editing.`
        : `- **规范/方案已更新**：自上次运行以来需求规范或验收条件有变更，请先重读 \`${itemDirHint}/spec.md\` 与 \`${itemDirHint}/design.md\`。`,
    );
  }

  if (input.resolveConflict && input.conflictContext) {
    const cc = input.conflictContext;
    parts.push(
      isEn
        ? `- **Conflict Sync**: branch \`${cc.branch}\` is behind \`${cc.targetRef ?? cc.mainHead.slice(0, 7)}\` by ${cc.behindCount} commits; conflicting files: ${cc.conflictFiles.map((f) => `\`${f}\``).join(", ")}`
        : `- **冲突同步任务**：分支 \`${cc.branch}\` 落后 \`${cc.targetRef ?? cc.mainHead.slice(0, 7)}\` 共 ${cc.behindCount} 个提交；冲突文件：${cc.conflictFiles.map((f) => `\`${f}\``).join("、")}`,
    );
  }

  const failedEvs = [...validity.verifications]
    .reverse()
    .filter((v) => v.effectiveState === "failed")
    .slice(0, 3);
  if (failedEvs.length > 0) {
    const perExcerptChars = Math.max(600, Math.floor(2000 / failedEvs.length));
    for (const failedEv of failedEvs) {
      let excerpt = failedEv.record.outputPreview ?? "";
      if (input.root) {
        try {
          const full = getVerificationEvidence(input.root, state.id, failedEv.record.id);
          if (full.log.trim()) {
            excerpt = full.log.trim().slice(-perExcerptChars);
          }
        } catch {
          // Fallback to head+tail outputPreview.
        }
      }
      parts.push(
        isEn
          ? `- **Failed Verification**: \`${failedEv.record.command}\` (exit ${failedEv.record.exitCode}, full log \`${itemDirHint}/${failedEv.record.outputPath}\`)`
          : `- **最新失败验证**：\`${failedEv.record.command}\`（退出码 ${failedEv.record.exitCode}，完整日志 \`${itemDirHint}/${failedEv.record.outputPath}\`）`,
      );
      if (excerpt.trim()) {
        parts.push("```text");
        parts.push(sanitizeOutput(excerpt.trim().slice(-perExcerptChars), perExcerptChars).text);
        parts.push("```");
      }
    }
  }

  const emittedReview = Boolean(
    state.reviewReport && (state.reviewReport.verdict !== "pass" || input.action === "fix"),
  );
  if (emittedReview && state.reviewReport) {
    const rev = state.reviewReport;
    parts.push(
      isEn
        ? `- **Latest Cross-Model Review (${rev.verdict} / ${validity.reviewValidity.effectiveState})**: ${rev.summary}`
        : `- **最新跨模型审查（${rev.verdict} / ${validity.reviewValidity.effectiveState}）**：${rev.summary}`,
    );
    if (rev.findings && rev.findings.length > 0) {
      for (const f of rev.findings.slice(0, 10)) {
        const loc = f.files && f.files.length > 0 ? ` (${f.files.join(", ")})` : "";
        const detailHint = f.detail ? `：${f.detail}` : "";
        const fixHint = f.suggestion ? ` → ${isEn ? "Suggestion" : "建议"}: ${f.suggestion}` : "";
        parts.push(`  - [${f.severity}] \`${f.id}\` ${f.title}${loc}${detailHint}${fixHint}`);
      }
    }
  }

  const feedback = state.lastFeedback?.trim() ?? "";
  const extraMsg = input.message?.trim() ?? "";
  const reviewSummary = emittedReview ? state.reviewReport?.summary?.trim() ?? "" : "";
  const extraDuplicatesReview = Boolean(
    extraMsg && reviewSummary && extraMsg.includes(reviewSummary),
  );
  if (feedback && !(reviewSummary && feedback === reviewSummary)) {
    parts.push(isEn ? `- **Latest Feedback**: ${feedback}` : `- **最新打回意见**：${feedback}`);
  }
  if (
    extraMsg &&
    input.action !== "ask" &&
    extraMsg !== feedback &&
    !feedback.includes(extraMsg) &&
    !extraDuplicatesReview
  ) {
    parts.push(isEn ? `- **Additional Instruction**: ${extraMsg}` : `- **本次追加指令**：${extraMsg}`);
  }

  if (state.attachments && state.attachments.length > 0 && input.root) {
    const codeRoot = resolveCodeRoot(input.root, state.id);
    const attLines = state.attachments.slice(0, 6).map((meta) => {
      let fileName = meta.id;
      try {
        fileName = attachmentFileName(meta);
      } catch {
        // Fallback to ID.
      }
      const absPath = path.join(codeRoot, WORKBENCH_DIR, "items", state.id, "attachments", fileName);
      return `\`${absPath}\` (${meta.name}, ${formatAttachmentSize(meta.size)})`;
    });
    parts.push(isEn ? `- **Attachments**: ${attLines.join(", ")}` : `- **附件清单**：${attLines.join("、")}`);
  }

  const pendingNotes = (state.discussions ?? []).filter((d) => !d.resolved);
  if (pendingNotes.length > 0) {
    parts.push(isEn ? "**Unresolved Annotations**:" : "**待处理批注/讨论**：");
    for (const d of pendingNotes.slice(-6)) {
      parts.push(`- (${d.actor}/${d.mode}) ${d.anchor ? `[${d.anchor}] ` : ""}${d.message}`);
    }
  }
  return parts.join("\n");
}

/**
 * Single unified prompt builder for Hub Executor CLI runs.
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
  const isEn = lang === "en";
  const fastVerifyHint = options.fastCommand
    ? `\`${options.fastCommand}\` ${isEn ? "or lightweight checks" : "或相关轻量检查"}`
    : isEn
      ? "lightweight type/lint checks"
      : "轻量类型/语法检查";

  if (input.action === "ask") {
    return (
      isEn
        ? [
            `You are in read-only Q&A mode for requirement ${reqId} (${detail.state.title}).`,
            "- Perform read-only research only; do NOT modify repository files or requirement state.",
            buildOutputLanguageDirective(lang, "ask"),
            "",
            ...(options.resumedSession
              ? [`(Native session resume; latest brief at \`${itemDirHint}/handoff.md\`)`]
              : [handoffMarkdown ? `Context Brief:\n${handoffMarkdown}` : `Read \`${itemDirHint}/spec.md\` and \`${itemDirHint}/design.md\`.`]),
            "",
            input.anchor ? `Anchor: ${input.anchor}` : "",
            `Question: ${input.message?.trim() || "Explain the core design approach and main risks."}`,
          ]
        : [
            `你当前处于「只读问答探讨」模式，请针对工作台需求 ${reqId}（${detail.state.title}）回答用户问题。`,
            "- 仅做只读调研与解答，不要修改仓库文件或需求状态。",
            buildOutputLanguageDirective(lang, "ask"),
            "",
            ...(options.resumedSession
              ? [`（同会话原生续接；完整指引见 \`${itemDirHint}/handoff.md\`）`]
              : [handoffMarkdown ? `上下文指引：\n${handoffMarkdown}` : `请先读取 \`${itemDirHint}/spec.md\` 与 \`${itemDirHint}/design.md\`。`]),
            "",
            input.anchor ? `提问锚点：${input.anchor}` : "",
            `用户问题：${input.message?.trim() || "请解释当前技术方案的核心思路与风险点。"}`,
          ]
    )
      .filter(Boolean)
      .join("\n");
  }

  if (input.action === "review") {
    // WB-22 / FLOW §1.3: independent heterogeneous design review when stage === "planning" and design exists
    if (detail.state.stage === "planning" && detail.state.designHash !== "") {
      const hasOriginalGoal = Boolean(
        detail.state.originalGoal?.trim() && detail.state.originalGoal.trim() !== detail.specMarkdown.trim(),
      );
      const specInline = detail.specMarkdown.trim().slice(0, 4096);
      const designInline = detail.designMarkdown.trim().slice(0, 8192);
      return (
        isEn
          ? [
              `Act as an independent Cross-Model Design Reviewer performing a read-only architecture & plan review for ${reqId} (${detail.state.title}).`,
              "",
              "Design Review Guidelines:",
              `1. Inspect \`${itemDirHint}/spec.md\`, \`${itemDirHint}/design.md\`, declared acceptance criteria, and any adopted human decisions (inlined below).`,
              "2. Do NOT modify any repository files. Focus on alignment with original user intent, missing critical edge cases, public contract/migration risks, and over-engineering.",
              "3. Distinguish severities: `block` only for confirmed architectural flaws, contract breakages, security/data-loss risks, or direct misalignment with the goal; `concern` for trade-offs worth human attention; `low` for minor suggestions (return `pass` when sound).",
              "",
              buildOutputLanguageDirective(lang, "review"),
              "",
              "Append a structured JSON verdict block at the end of your response:",
              '```json\n{"verdict":"pass"|"concern"|"block","summary":"One-sentence core design review summary in English","findings":[{"id":"DF-1","severity":"high"|"medium"|"low","title":"Short design issue title","detail":"Concrete risk or misalignment","suggestion":"Actionable design adjustment"}]}\n```',
              "",
              ...(hasOriginalGoal ? ["### Original User Goal (read-only)", "```markdown", detail.state.originalGoal!.trim().slice(0, 2048), "```", ""] : []),
              ...(specInline ? [`### Spec (\`${itemDirHint}/spec.md\`)`, "```markdown", specInline, "```", ""] : []),
              ...(designInline ? [`### Design (\`${itemDirHint}/design.md\`)`, "```markdown", designInline, "```", ""] : []),
              handoffMarkdown,
            ]
          : [
              `请作为独立异构方案评审者（Cross-Model Design Reviewer），对工作台需求 ${reqId}（${detail.state.title}）的技术方案执行只读评审。`,
              "",
              "方案评审要求：",
              `1. 核对 \`${itemDirHint}/spec.md\`、\`${itemDirHint}/design.md\`、验收条件与人类已采纳决策（正文已内联如下），可按需只读查看相关源码验证假设。`,
              "2. 严禁修改任何仓库文件或提交提案。聚焦真实架构漏洞、与原始需求偏离、公共契约/数据安全风险、关键边界遗漏及过度设计。",
              "3. 严格区分严重度：`block` 仅用于确定性架构缺陷、契约破坏、数据/安全风险或明显偏离原始目标；`concern` 用于值得人类权衡的风险点；非关键建议放 `findings`（`low`）并直接给 `pass`。",
              "",
              buildOutputLanguageDirective(lang, "review"),
              "",
              "请在输出末尾附上一个结构化结论 JSON 块：",
              '```json\n{"verdict":"pass"|"concern"|"block","summary":"用简体中文写出的一句话方案评审核心结论","findings":[{"id":"DF-1","severity":"high"|"medium"|"low","title":"简明方案问题","detail":"具体风险或偏离点","suggestion":"可执行的方案修订建议"}]}\n```',
              "",
              ...(hasOriginalGoal ? ["### 人类原始需求原话（只读参考）", "```markdown", detail.state.originalGoal!.trim().slice(0, 2048), "```", ""] : []),
              ...(specInline ? [`### 需求规范（\`${itemDirHint}/spec.md\`）`, "```markdown", specInline, "```", ""] : []),
              ...(designInline ? [`### 技术方案（\`${itemDirHint}/design.md\`）`, "```markdown", designInline, "```", ""] : []),
              handoffMarkdown,
            ]
      )
        .filter((line, idx, arr) => !(line === "" && arr[idx - 1] === ""))
        .join("\n");
    }

    const isReReview = Boolean(detail.state.reviewReport && detail.state.reviewReport.verdict !== "pass");
    const incCommit = options.incrementalReviewFromCommit?.trim() || null;
    const incHintEn = incCommit
      ? ` Focus first on the exact incremental diff since your prior review (\`git diff ${incCommit.slice(0, 7)}..HEAD\`, also summarized below) and verify each prior blocking finding plus adjacent behavior for regressions.`
      : "";
    const incHintZh = incCommit
      ? ` 请优先核查自上轮审查以来的精确增量 Diff（\`git diff ${incCommit.slice(0, 7)}..HEAD\`，下文已附摘要），逐条确认上轮阻塞项是否已附回归验证并关闭，同时检查本次改动触及的相邻行为是否回归。`
      : "";
    const reReviewRuleEn = isReReview
      ? `5. Re-review convergence: first verify whether every item in the prior review checklist was resolved with regression coverage/evidence and whether the fix introduced any regression.${incHintEn} Do NOT expand scope beyond \`spec.md\` or raise new \`block\` verdicts for speculative edge cases outside the requirement; put non-essential suggestions under \`low\` and return \`pass\` once prior blockers are closed with no confirmed regressions.`
      : "";
    const reReviewRuleZh = isReReview
      ? `5. 复审收敛原则：优先逐条核验「上轮审查问题清单」是否已修复并提供回归用例或可复现验证证据，以及本次修复是否引入新回归。${incHintZh} 严禁在复审中脱离 \`spec.md\` 范围不断拔高要求或为极端边界场景新增 \`block\`。非必需优化放 \`low\` 建议，若上轮阻塞项已关闭且无新增确定性缺陷，请直接给 \`pass\`。`
      : "";
    return (
      isEn
        ? [
            `Act as an independent Cross-Model Reviewer performing a read-only Code Review for ${reqId} (${detail.state.title}).`,
            "",
            "Review Guidelines:",
            `1. Use native file & Git tools to inspect \`${itemDirHint}/spec.md\`, \`${itemDirHint}/design.md\`, actual Git Diff (or \`wb_get({ id: "${reqId}", includeDiff: true })\`), and verification evidence.`,
            `2. Reuse matching verification logs under \`${itemDirHint}/evidence/\` first; only run ${fastVerifyHint} if evidence is missing or stale.`,
            "3. Do NOT modify repository files or run background commands (`&` / `run_in_background`). Focus on real bugs, missing requirements, security issues, or test tampering.",
            "4. Distinguish severities strictly within `spec.md` scope: `block` only for confirmed functional bugs, data/security risks, or unmet required criteria (for every `block` finding, include minimal reproduction and expected behavior in `detail`/`suggestion`); `concern` for medium risks; put minor nits or out-of-scope edge cases in `findings` (`low`) and use `pass` when acceptable.",
            reReviewRuleEn,
            "",
            buildOutputLanguageDirective(lang, "review"),
            "",
            "Append a structured JSON verdict block at the end of your response:",
            '```json\n{"verdict":"pass"|"concern"|"block","summary":"One-sentence core review summary in English","findings":[{"id":"F-1","severity":"high"|"medium"|"low","title":"Short issue title","detail":"Minimal reproduction and expected behavior","criterionIds":["AC-1"],"files":["src/path.ts:10"],"suggestion":"Concrete fix"}]}\n```',
            "",
            handoffMarkdown || `Authoritative files: \`${itemDirHint}/spec.md\`, \`${itemDirHint}/design.md\`, \`${itemDirHint}/evidence/\`.`,
          ]
        : [
            `请作为独立代码审查者（Cross-Model Reviewer）对工作台需求 ${reqId}（${detail.state.title}）执行只读 Code Review。`,
            "",
            "审查要求：",
            `1. 使用原生文件与 Git 工具检查 \`${itemDirHint}/spec.md\`、\`${itemDirHint}/design.md\`、实际 Git Diff（或调用 \`wb_get({ id: "${reqId}", includeDiff: true })\`）与验收证据。`,
            `2. 优先复用匹配证据：先核验 \`${itemDirHint}/evidence/\` 中与当前代码快照一致的验证日志，无需重跑已匹配的耗时测试（仅在证据缺失或过期时按需运行${fastVerifyHint}）。`,
            "3. 禁止修改任何仓库代码，禁止在后台运行命令（如 `&` 或 `run_in_background`）或等待外部通知；同步完成检查并聚焦真实问题：实现是否满足需求、是否存在功能/安全缺陷、是否存在删改或跳过测试的迹象。",
            "4. 严格结合 `spec.md` 范围区分严重度：`block` 仅用于确定性功能故障、数据/安全风险或必需验收条件未满足（每条阻塞项请在 `detail`/`suggestion` 中附上最小复现与预期行为）；`concern` 用于待确认的中等风险；低优先级优化或超出需求边界的极端假设放 `findings`（`low`）即可，若达标直接给 `pass`。",
            reReviewRuleZh,
            "",
            buildOutputLanguageDirective(lang, "review"),
            "",
            "请在输出末尾附上一个结构化结论 JSON 块：",
            '```json\n{"verdict":"pass"|"concern"|"block","summary":"用简体中文写出的一句话核心审查结论","findings":[{"id":"F-1","severity":"high"|"medium"|"low","title":"简明问题描述","detail":"最小复现与预期行为","criterionIds":["AC-1"],"files":["src/path.ts:10"],"suggestion":"具体修复建议"}]}\n```',
            "",
            handoffMarkdown || `权威文件：\`${itemDirHint}/spec.md\`、\`${itemDirHint}/design.md\`、\`${itemDirHint}/evidence/\`。`,
          ]
    )
      .filter((line, idx, arr) => !(line === "" && arr[idx - 1] === ""))
      .join("\n");
  }

  if (input.action === "design") {
    const inlineSpecText = sanitizeOutput(detail.specMarkdown.trim(), 6144);
    const hasOriginalDiff = Boolean(
      detail.state.originalGoal?.trim() &&
        detail.state.originalGoal.trim() !== detail.specMarkdown.trim(),
    );
    const inlinedSpecBlock = !options.resumedSession
      ? [
          ...(hasOriginalDiff
            ? [
                isEn ? "### Original Human Request (Read-Only Reference)" : "### 人类原始需求原话（只读参考）",
                "```markdown",
                sanitizeOutput(detail.state.originalGoal!.trim(), 2048).text,
                "```",
                "",
              ]
            : []),
          isEn
            ? `### Inlined Specification (\`${itemDirHint}/spec.md\`)`
            : `### 已内联需求规范全文（\`${itemDirHint}/spec.md\`）`,
          "```markdown",
          inlineSpecText.text || (isEn ? "(empty)" : "（空）"),
          "```",
          ...(inlineSpecText.truncated
            ? [
                isEn
                  ? `> Truncated above; read \`${itemDirHint}/spec.md\` from disk if you need the remainder.`
                  : `> 上文已截断；如需后半部分请直接读取磁盘 \`${itemDirHint}/spec.md\`。`,
              ]
            : []),
        ].join("\n")
      : "";

    const contextBlock = options.resumedSession
      ? buildCompactResumeContext(detail, input, lang, { previousSpecHash: options.previousSpecHash })
      : handoffMarkdown || (isEn ? `Read \`${itemDirHint}/spec.md\` and inspect the codebase.` : `请直接读取 \`${itemDirHint}/spec.md\` 并结合仓库现状调研。`);
    return (
      isEn
        ? [
            `Produce the specification refinement and technical design for ${reqId} (${detail.state.title}).`,
            "",
            "Workflow:",
            `1. The full \`spec.md\`, latest feedback, and unresolved annotations are already inlined below — do NOT run \`wb --help\` or \`wb get\`. Inspect only relevant source files (avoid redundant exploration or running full test suites); lightweight read-only checks are allowed.`,
            `2. Edit \`${itemDirHint}/spec.md\` if needed and write a clear technical plan in \`${itemDirHint}/design.md\` (adapt detail to complexity; skip boilerplate sections).`,
            "3. Append verifiable acceptance criteria in a fenced `workbench-criteria` JSON block at the end of `design.md` (supports executable `command` or `manual` human-checked items with `steps`):",
            '```workbench-criteria\n[{"id":"AC-1","description":"Core behavior passes unit test","required":true,"command":"bun test tests/feature.test.ts"},{"id":"AC-2","description":"Visual layout verified","required":true,"kind":"manual","steps":"Open workspace page and verify alignment"}]\n```',
            "4. ONLY when genuine architectural/product forks require human sign-off, append an optional `workbench-decisions` JSON block (2-4 options per item, marking one `recommended: true`); when pending decisions exist, you may defer criteria until resolved:",
            '```workbench-decisions\n[{"id":"D-1","question":"Choose storage strategy?","options":[{"id":"opt-a","label":"SQLite local file","description":"Zero external dependency","recommended":true},{"id":"opt-b","label":"JSON file","description":"Simpler diff"}]}]\n```',
            "5. Design only in this turn — do NOT edit business source code. End the turn once design.md is written; Workbench will automatically sync and submit it for human approval.",
            "",
            buildOutputLanguageDirective(lang, "plan"),
            "",
            inlinedSpecBlock,
            "",
            contextBlock,
          ]
        : [
            `请完成工作台需求 ${reqId}（${detail.state.title}）的规范整理与技术方案设计。`,
            "",
            "工作方式：",
            `1. 下文已直接内联 \`spec.md\` 全文、最新打回意见与未解决批注，无需执行 \`wb --help\` 或 \`wb get\` 反复回读；仅精准调研相关源码（避免无关探索或跑全量耗时测试），可按需运行只读测试或检查命令复现定位。`,
            `2. 如需细化目标/边界可直接编辑 \`${itemDirHint}/spec.md\`，并在 \`${itemDirHint}/design.md\` 中写出清晰的技术方案（按复杂度自适应详略，无需凑固定模板章节）。`,
            "3. 在 `design.md` 末尾附带一个 `workbench-criteria` JSON 代码块声明验收条件（支持可执行 `command` 或标注 `kind: \"manual\"` 及人工检查 `steps`）：",
            '```workbench-criteria\n[{"id":"AC-1","description":"核心逻辑单元测试通过","required":true,"command":"bun test tests/feature.test.ts"},{"id":"AC-2","description":"页面交互与布局人工核验","required":true,"kind":"manual","steps":"打开工作区页面检查对齐与状态切换"}]\n```',
            "4. 仅当存在真正需要人类拍板的选型/边界分叉时，在 `design.md` 末尾可选附带 `workbench-decisions` JSON 代码块（每题 2-4 个选项并标出 `recommended: true`；存在待拍板决策时可暂缓补齐验收条件）：",
            '```workbench-decisions\n[{"id":"D-1","question":"数据持久化选型？","options":[{"id":"opt-a","label":"本地 JSON 文件","description":"零外部依赖、易于审计","recommended":true},{"id":"opt-b","label":"SQLite 数据库","description":"查询更强"}]}]\n```',
            "5. 本轮仅完成设计方案，不要修改业务源码或进入编码实施；方案写完后直接结束本轮，工作台将自动同步文件并提交人类审阅批准。",
            "",
            buildOutputLanguageDirective(lang, "plan"),
            "",
            inlinedSpecBlock,
            "",
            contextBlock,
          ]
    )
      .filter((line, idx, arr) => !(line === "" && arr[idx - 1] === ""))
      .join("\n");
  }

  // "implement" | "fix"
  const hasReviewToFix = Boolean(detail.state.reviewReport && detail.state.reviewReport.verdict !== "pass");
  const isCurrentReview = detail.validity.reviewValidity.effectiveState === "current";
  const hasHumanFeedback = Boolean(detail.state.lastFeedback) || Boolean(input.message?.trim());
  const isFastTrack = detail.state.track === "fast_track";
  const isBug = detail.state.kind === "bug";

  let objectiveLine: string;
  if (isEn) {
    if (input.action === "fix" && input.resolveConflict) {
      objectiveLine = `Resolve the merge conflict between ${reqId}'s sandbox branch and the target base branch, preserving both sides' valid changes, then end the turn so Workbench can run verification.`;
    } else if (input.action === "fix") {
      objectiveLine =
        hasReviewToFix && isCurrentReview
          ? `Address each cross-model review finding and failing verification for ${reqId}, adding a regression test or reproducible verification evidence for every blocking finding.`
          : `Diagnose and fix the failing checks or human feedback for ${reqId}.`;
    } else if (isBug) {
      objectiveLine = `Reproduce, root-cause, write a regression test, and minimally fix Bug ${reqId} (${detail.state.title}) in this single session.`;
    } else if (isFastTrack) {
      objectiveLine = `Implement ${reqId} (${detail.state.title}) via fast-track and add necessary tests.`;
    } else {
      objectiveLine = `Implement ${reqId} (${detail.state.title}) according to the approved specification and design, with necessary tests.`;
    }
  } else {
    if (input.action === "fix" && input.resolveConflict) {
      objectiveLine = `请仅解决 ${reqId} 沙箱分支与目标主干的合并冲突：安全暂存未提交业务改动、合并主干并保留双方正确逻辑，完成后直接结束本轮，工作台将自动运行验证。`;
    } else if (input.action === "fix") {
      if (hasReviewToFix && isCurrentReview) {
        objectiveLine = `请结合「待处理反馈与审查意见」及「失败与运行现场」，逐条修复 ${reqId} 的阻塞项，并为每条阻塞问题补充覆盖该复现的回归用例或可复现验证证据。`;
      } else if (hasReviewToFix && hasHumanFeedback) {
        objectiveLine = `请优先落实「待处理反馈与审查意见」中的人类最新指令（历史过期审查意见仅供参考），修复 ${reqId} 的问题。`;
      } else {
        objectiveLine = `请结合「待处理反馈与审查意见」或「失败与运行现场」，诊断并修复 ${reqId} 当前失败或未达标的问题。`;
      }
    } else if (isBug) {
      objectiveLine = `请在当前单会话内完成 Bug ${reqId}（${detail.state.title}）的复现定位、编写覆盖根因的回归测试与最小化修复。`;
    } else if (isFastTrack) {
      objectiveLine = `请依据需求规范（快速通道）完成 ${reqId}（${detail.state.title}）的代码实现与必要测试。`;
    } else {
      objectiveLine = `请依据已批准的规范与技术方案完成 ${reqId}（${detail.state.title}）的代码实现与必要测试。`;
    }
  }

  const contextBlock = options.resumedSession
    ? buildCompactResumeContext(detail, input, lang, { previousSpecHash: options.previousSpecHash })
    : handoffMarkdown || (isEn
        ? `Read \`${itemDirHint}/spec.md\`${detail.designMarkdown.trim() ? ` and \`${itemDirHint}/design.md\`` : ""}.`
        : `请直接读取 \`${itemDirHint}/spec.md\`${detail.designMarkdown.trim() ? ` 与 \`${itemDirHint}/design.md\`` : ""}。`);

  const bugRuleEn = isBug
    ? `4. Bug closure rules: append a regression test criterion covering this bug via \`wb bug-criteria ${reqId} --criteria '[{"id":"AC-REG-1","description":"...","command":"...","required":true}]'\` (append-only — NEVER delete or weaken existing criteria). If you cannot reproduce the bug or fixing it requires public contract/architecture changes, do NOT guess or switch stage — output a \`\`\`workbench-pause\\n{"reason":"..."}\\n\`\`\` block and exit cleanly so a human can decide.`
    : "";
  const bugRuleZh = isBug
    ? `4. Bug 闭环规则：请为该 Bug 补充覆盖根因的回归测试，并通过 \`wb bug-criteria ${reqId} --criteria '[{"id":"AC-REG-1","description":"...","command":"...","required":true}]'\`「只增不删」追加回归测试验收条件（严禁删除或削弱已有条件）。若无法复现或修复涉及公共契约/架构变更，切勿臆测或擅自切换阶段，请在输出末尾附带 \`\`\`workbench-pause\\n{"reason":"具体阻塞原因"}\\n\`\`\` 代码块并结束本轮，由人类决定补充信息或转常规方案流程。`
    : "";

  const screenshotHint =
    detail.state.uiRelated === true
      ? isEn
        ? `${isBug ? "5" : "4"}. This requirement is UI-related; Workbench will auto-capture screenshots once verification passes (or run \`wb screenshot ${reqId}\`).`
        : `${isBug ? "5" : "4"}. 本需求涉及 UI，验收命令通过后工作台会自动采集界面截图；如有需要也可运行 \`wb screenshot ${reqId}\`。`
      : "";

  const hasDesign = Boolean(detail.designMarkdown.trim());
  const specUnchangedOnResume = Boolean(
    options.resumedSession &&
      (!options.previousSpecHash || options.previousSpecHash === detail.state.specHash),
  );
  const fullCmd = options.fullCommand?.trim() || null;
  const hasDistinctFullCmd = Boolean(fullCmd && fullCmd !== options.fastCommand?.trim());

  const hasDecisions = Boolean(detail.state.humanDecisions && detail.state.humanDecisions.length > 0);
  const decisionRuleEn = hasDecisions
    ? "Treat the human-adopted decisions in the brief as authoritative — do NOT contradict or re-open them."
    : "";
  const decisionRuleZh = hasDecisions
    ? "简报中「人类已采纳决策」为最高权威裁决，请严格遵守，勿擅自推翻。"
    : "";

  const step1En = specUnchangedOnResume
    ? `1. You are resuming the same session and the spec is unchanged; go straight to the target files and feedback (re-read \`${itemDirHint}/spec.md\`${hasDesign ? ` or \`${itemDirHint}/design.md\`` : ""} only if needed).${decisionRuleEn ? ` ${decisionRuleEn}` : ""}`
    : `1. Read \`${itemDirHint}/spec.md\`${hasDesign ? ` and \`${itemDirHint}/design.md\`` : ""} directly from disk.${decisionRuleEn ? ` ${decisionRuleEn}` : ""}`;
  const step1Zh = specUnchangedOnResume
    ? `1. 当前为同会话续接且规范未变，无需重读全文，直接聚焦目标文件与反馈修改（需核对细节时再按需读取 \`${itemDirHint}/spec.md\`${hasDesign ? ` 或 \`${itemDirHint}/design.md\`` : ""}）。${decisionRuleZh}`
    : `1. 使用原生文件工具完整阅读 \`${itemDirHint}/spec.md\`${hasDesign ? ` 与 \`${itemDirHint}/design.md\`` : ""}，以磁盘完整原文为准。${decisionRuleZh}`;

  const step2En = hasDistinctFullCmd
    ? `2. Modify only code and tests relevant to this requirement; run ${fastVerifyHint} and targeted tests for your changes locally, and do NOT manually run the slow full suite (\`${fullCmd}\`) via raw shell — Workbench runs it automatically on exit (or run \`wb verify ${reqId} --all\` if you need full-suite output early so Workbench can reuse the evidence).`
    : "2. Modify only code and tests relevant to this requirement, and run fast or targeted checks locally as needed.";
  const step2Zh = hasDistinctFullCmd
    ? `2. 只改动与本需求相关的代码与测试；本地验证只需运行${fastVerifyHint}及本次新增/相关的定向测试，不要通过普通 shell 手动跑耗时的全量测试（\`${fullCmd}\`），工作台会在你退出后统一执行并记录验收证据（若确需提前跑全量，请调用 \`wb verify ${reqId} --all\` 以便工作台复用结果）。`
    : "2. 只改动与本需求相关的代码与测试，并按需在本地运行快速检查或定向测试验证改动正确性。";

  return (
    isEn
      ? [
          objectiveLine,
          "",
          "Workflow:",
          step1En,
          step2En,
          "3. End the turn once done — Workbench will automatically run required verification commands, capture screenshots if UI-related, and dispatch blind review on pass (or hand failures back to you for auto-heal).",
          bugRuleEn,
          screenshotHint,
          "",
          buildOutputLanguageDirective(lang, "plan"),
          "",
          contextBlock,
        ]
      : [
          objectiveLine,
          "",
          "工作方式：",
          step1Zh,
          step2Zh,
          "3. 完成后直接结束本轮即可——工作台会在你退出后自动执行必需验收命令，全部通过则自动触发独立审查与人工验收，若有失败会自动把报错交回给你继续修复（勿在后台留下未结束命令或等待人工确认；批准与最终验收仅由人类在工作台触发）。",
          bugRuleZh,
          screenshotHint,
          "",
          buildOutputLanguageDirective(lang, "plan"),
          "",
          contextBlock,
        ]
  )
    .filter((line, idx, arr) => !(line === "" && arr[idx - 1] === ""))
    .join("\n");
}
