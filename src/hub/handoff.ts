import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { attachmentFileName, formatAttachmentSize } from "../core/attachments.ts";
import { discoverProjectContext } from "../core/context.ts";
import {
  getAgentRunTrace,
  getProjectStatus,
  getRequirement,
  getVerificationEvidence,
  readProjectPlaybook,
  saveHandoffMarkdown,
} from "../core/engine.ts";
import { observeGitChanges } from "../core/git.ts";
import { resolveEffectiveOutputLanguage, type ResolvedOutputLanguage } from "../core/language.ts";
import { resolveCodeRoot } from "../core/sandbox.ts";
import {
  WORKBENCH_DIR,
  type AgentAction,
  type AgentRunRecord,
  type HandoffSectionMetric,
  type OutputLanguage,
  type RequirementDetail,
} from "../core/types.ts";
import { sanitizeOutput } from "../core/validate.ts";
import { detectTestTamperingSignals } from "../core/validity.ts";
import { estimateTokens } from "./pricing.ts";
import { readHubConfig } from "./registry.ts";

const HANDOFF_MAX_BYTES = 8 * 1024;

export interface HandoffComposition {
  totalBytes: number;
  budgetBytes: number;
  estTokens: number;
  sections: HandoffSectionMetric[];
  truncatedSections: string[];
}

export interface ConflictHandoffContext {
  branch: string;
  baseHead: string;
  mainHead: string;
  targetRef?: string;
  behindCount: number;
  conflictFiles: string[];
  mainCommitsSummary?: string;
  conflictExcerpt?: string;
}

export interface IncrementalReviewContext {
  fromCommit: string;
  files: string[];
  diff: string;
  truncated: boolean;
}

export interface HandoffSynthesisOptions {
  action: AgentAction;
  humanInstruction?: string;
  anchorIds?: string[];
  previousRun?: AgentRunRecord | null;
  previousLogTail?: string;
  hubOutputLanguage?: OutputLanguage;
  resolveConflict?: boolean;
  conflictContext?: ConflictHandoffContext;
  /** Target harness ID so CLIs that auto-read repo AGENTS.md/CLAUDE.md skip duplicate references. */
  targetHarness?: string;
  /** Exact incremental diff since the prior reviewed commit (`lastReviewCommit..HEAD`) for re-reviews. */
  incrementalReview?: IncrementalReviewContext;
}

interface BudgetedSection {
  key: string;
  label?: string;
  /** Lower number = higher priority (trimmed last). */
  priority: number;
  text: string;
  minText?: string;
  inlineTruncated?: boolean;
}

const SECTION_LABELS: Record<string, string> = {
  header: "Header & Metadata",
  steering: "Review & Feedback",
  failures: "Failure Evidence",
  trace: "Previous Run Trace Summary",
  contract: "File Pointers & Criteria",
  git: "Git Snapshot",
};

function clipTextByBytes(text: string, maxBytes: number, suffix = ""): string {
  const clean = sanitizeOutput(text, maxBytes).text;
  if (!suffix || Buffer.byteLength(text, "utf8") <= maxBytes) {
    return clean;
  }
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (maxBytes <= suffixBytes + 16) {
    return sanitizeOutput(text, maxBytes).text;
  }
  return `${sanitizeOutput(text, maxBytes - suffixBytes).text.trimEnd()}${suffix}`;
}

/** Output order keeps static/stable contract sections FIRST and dynamic latest feedback/failures LAST for prompt cache reuse. */
const CACHE_FRIENDLY_SECTION_ORDER: Record<string, number> = {
  contract: 1,
  git: 2,
  trace: 3,
  failures: 4,
  steering: 5,
};

function assembleBudgetedPacket(
  headerText: string,
  sections: BudgetedSection[],
  maxBytes: number,
): { markdown: string; composition: HandoffComposition } {
  const rawSizes = new Map<string, number>();
  for (const sec of sections) {
    rawSizes.set(sec.key, Buffer.byteLength(sec.text, "utf8"));
  }
  const trimmedKeys = new Set<string>();

  const orderedForOutput = [...sections].sort(
    (a, b) => (CACHE_FRIENDLY_SECTION_ORDER[a.key] ?? 99) - (CACHE_FRIENDLY_SECTION_ORDER[b.key] ?? 99),
  );
  const joinAll = () =>
    [headerText, ...orderedForOutput.map((s) => s.text).filter((t) => t.trim().length > 0)].join("\n");

  let assembled = joinAll();
  if (Buffer.byteLength(assembled, "utf8") > maxBytes) {
    const byTrimOrder = [...sections].sort((a, b) => b.priority - a.priority);
    for (const sec of byTrimOrder) {
      const currentBytes = Buffer.byteLength(assembled, "utf8");
      if (currentBytes <= maxBytes) break;
      const secBytes = Buffer.byteLength(sec.text, "utf8");
      const minBytes = sec.minText ? Buffer.byteLength(sec.minText, "utf8") : 0;
      const reducible = Math.max(0, secBytes - minBytes);
      if (reducible === 0) continue;

      const excess = currentBytes - maxBytes;
      const targetSecBytes = Math.max(minBytes, secBytes - excess);
      if (targetSecBytes <= minBytes && sec.minText !== undefined) {
        sec.text = sec.minText;
      } else {
        sec.text = clipTextByBytes(sec.text, targetSecBytes, "\n> …（因简报预算限制已精简此节）");
      }
      trimmedKeys.add(sec.key);
      assembled = joinAll();
    }
  }

  const markdown = sanitizeOutput(assembled, maxBytes).text;
  const headerBytes = Buffer.byteLength(headerText, "utf8");
  const metrics: HandoffSectionMetric[] = [
    {
      key: "header",
      label: SECTION_LABELS.header!,
      priority: 0,
      rawBytes: headerBytes,
      finalBytes: headerBytes,
      estTokens: estimateTokens(headerText),
      truncated: false,
    },
  ];
  for (const sec of sections) {
    const rawBytes = rawSizes.get(sec.key) ?? 0;
    const finalBytes = Buffer.byteLength(sec.text, "utf8");
    const truncated = Boolean(sec.inlineTruncated) || trimmedKeys.has(sec.key) || finalBytes < rawBytes;
    if (rawBytes === 0 && finalBytes === 0) continue;
    metrics.push({
      key: sec.key,
      label: sec.label ?? SECTION_LABELS[sec.key] ?? sec.key,
      priority: sec.priority,
      rawBytes,
      finalBytes,
      estTokens: estimateTokens(sec.text),
      truncated,
    });
  }

  return {
    markdown,
    composition: {
      totalBytes: Buffer.byteLength(markdown, "utf8"),
      budgetBytes: maxBytes,
      estTokens: estimateTokens(markdown),
      sections: metrics,
      truncatedSections: metrics.filter((m) => m.truncated).map((m) => m.key),
    },
  };
}

/**
 * Deterministically extracts objective execution memory (touched files, failed tool calls,
 * final assistant summary) from a prior run's Trace JSONL for zero-friction cross-harness handoff.
 */
export function extractTraceHandoffSummary(root: string, id: string, runId: string): string | null {
  try {
    const trace = getAgentRunTrace(root, id, runId, { afterSeq: 0, limit: 2000 });
    if (!trace.traceAvailable || trace.events.length === 0) return null;

    const filesTouched = new Set<string>();
    const failedTools: string[] = [];
    let lastAssistant = "";

    for (const ev of trace.events) {
      if ((ev.type === "tool.start" || ev.type === "tool.end") && Array.isArray(ev.filesTouched)) {
        for (const f of ev.filesTouched) {
          if (f && filesTouched.size < 20) filesTouched.add(f);
        }
      }
      if (ev.type === "tool.end" && ev.isError) {
        const line = `${ev.toolName}: ${ev.summary}${ev.exitCode !== undefined && ev.exitCode !== null ? ` (exit ${ev.exitCode})` : ""}`;
        failedTools.push(sanitizeOutput(line, 220).text);
      }
      if (ev.type === "assistant.message" && ev.text.trim()) {
        lastAssistant = ev.text.trim();
      }
    }

    const lines: string[] = [];
    if (filesTouched.size > 0) {
      lines.push(`- **前序触达文件**：${Array.from(filesTouched).slice(0, 12).map((f) => `\`${f}\``).join("、")}`);
    }
    if (failedTools.length > 0) {
      lines.push("- **前序失败工具调用（避免重复踩坑）**：");
      for (const ft of failedTools.slice(-3)) {
        lines.push(`  - ${ft}`);
      }
    }
    if (lastAssistant) {
      lines.push(`- **前序最终结论摘要**：${sanitizeOutput(lastAssistant.replace(/\s+/g, " "), 500).text}`);
    }
    if (lines.length === 0) return null;
    return ["## 前序执行客观轨迹摘要", ...lines, ""].join("\n");
  } catch {
    return null;
  }
}

function isDuplicateText(candidate: string, existing: string | null | undefined): boolean {
  if (!existing) return false;
  const a = candidate.trim().replace(/\s+/g, " ");
  const b = existing.trim().replace(/\s+/g, " ");
  if (!a || !b) return false;
  return a === b || b.includes(a) || a.includes(b);
}

/**
 * Synthesizes a pointer-first, high-signal orientation packet from authoritative disk state,
 * review findings, objective git file status, failed evidence, previous trace memory, and human annotations.
 */
export async function synthesizeHandoffPacket(
  root: string,
  id: string,
  options: HandoffSynthesisOptions,
): Promise<{
  markdown: string;
  detail: RequirementDetail;
  outputLanguage: ResolvedOutputLanguage;
  composition: HandoffComposition;
}> {
  const codeRoot = resolveCodeRoot(root, id);
  const preDetail = getRequirement(root, id);
  const baselineHead = preDetail.state.baseline?.head ?? null;
  const gitChanges = await observeGitChanges(codeRoot, {
    sinceHead: baselineHead,
    maxDiffBytes: options.action === "review" ? 64 * 1024 : 1024,
  });
  const detail = getRequirement(root, id, { currentCodeSnapshotHash: gitChanges.fingerprint ?? null });
  const { state, specMarkdown, designMarkdown, validity } = detail;
  const projectMeta = getProjectStatus(root).project;
  const projectContext = discoverProjectContext(codeRoot, projectMeta);
  const hubLanguage = options.hubOutputLanguage ?? readHubConfig().outputLanguage;
  const outputLanguage = resolveEffectiveOutputLanguage({
    projectLanguage: projectMeta?.outputLanguage,
    hubLanguage,
    contextText: `${state.title}\n${specMarkdown}`,
  });

  const itemDirHint = `${WORKBENCH_DIR}/items/${state.id}`;
  const headerLines: string[] = [
    `# ${state.id} · ${state.title} — 工作上下文简报`,
    "",
    `- **当前阶段**：\`${state.stage}\` | **轨道**：\`${state.track}\` | **档位**：\`${state.tier}\` | **拟执行动作**：\`${options.action}\``,
    `- **权威文件位置**：规范 \`${itemDirHint}/spec.md\` · 方案 \`${itemDirHint}/design.md\` · 状态 \`${itemDirHint}/state.json\``,
    outputLanguage === "en"
      ? "- **Output Language Policy**：`English (en)`"
      : "- **输出语言规范**：`简体中文 (zh-CN)`",
  ];
  if (state.parentId) {
    headerLines.push(
      `- **父架构需求**：\`${state.parentId}\`（父方案参考：\`${WORKBENCH_DIR}/items/${state.parentId}/design.md\`）`,
    );
  }
  const autoReadsRepoInstructions = Boolean(
    options.targetHarness &&
      ["codex", "qodercn", "opencode", "agy", "omp"].includes(options.targetHarness),
  );
  const effectiveArchDocs = autoReadsRepoInstructions
    ? projectContext.archDocs.filter((doc) => doc.path !== "AGENTS.md" && doc.path !== "CLAUDE.md")
    : projectContext.archDocs;
  if (effectiveArchDocs.length > 0) {
    const docSummary = effectiveArchDocs
      .map((doc) =>
        doc.headings.length > 0 ? `\`${doc.path}\`（${doc.headings.slice(0, 4).join(" / ")}）` : `\`${doc.path}\``,
      )
      .join("；");
    headerLines.push(`- **项目架构参考**：${docSummary}`);
  }
  if (projectContext.fastCommand || projectContext.fullCommand) {
    const tierParts = [
      projectContext.fastCommand ? `快速 \`${projectContext.fastCommand}\`` : "",
      projectContext.fullCommand ? `全量 \`${projectContext.fullCommand}\`` : "",
    ].filter(Boolean);
    headerLines.push(`- **项目验证画像**：${tierParts.join(" · ")}`);
  }
  if (codeRoot !== root) {
    const sandboxHint =
      options.action === "implement" || options.action === "fix"
        ? "请在当前沙箱目录修改代码；元数据仍绑定主仓库"
        : options.action === "design"
          ? "设计阶段请勿修改业务源码，可做只读检查；元数据仍绑定主仓库"
          : "只读调研，请勿修改代码；元数据仍绑定主仓库";
    headerLines.push(`- **隔离沙箱目录**：\`${codeRoot}\`（${sandboxHint}）`);
  }
  if (options.previousRun) {
    const prev = options.previousRun;
    const fallbackNote =
      prev.modelFallback && prev.effectiveModel
        ? `（请求 ${prev.model} 未生效，实际由 ${prev.effectiveModel} 执行）`
        : "";
    headerLines.push(
      `- **前序执行**：\`${prev.harness}/${prev.model}\` · 状态 \`${prev.status}\`${prev.rateLimited ? "（疑似额度/限流中断）" : ""}${fallbackNote}`,
    );
  }
  headerLines.push("");
  const headerText = headerLines.join("\n");

  const sections: BudgetedSection[] = [];

  // Highest-priority steering: merge conflict / review findings (non-review actions) / human feedback / unresolved annotations
  const allDiscussions = state.discussions ?? [];
  const unresolvedRefineNotes = allDiscussions.filter(
    (d) => d.actor === "human" && d.mode === "refine" && (!d.kind || d.kind === "annotation") && !d.resolved,
  );
  const instructionTrimmed = options.humanInstruction?.trim() ?? "";
  const recentAskNotes = allDiscussions
    .filter((d) => d.mode === "ask")
    .filter((d) => !(options.action === "ask" && instructionTrimmed && d.actor === "human" && d.message.trim() === instructionTrimmed))
    .slice(-4);
  const pendingIds = new Set([...unresolvedRefineNotes.slice(-10), ...recentAskNotes].map((d) => d.id));
  const pendingNotes = allDiscussions.filter((d) => pendingIds.has(d.id));
  const review = state.reviewReport;
  const includeReviewDetail =
    options.action !== "review" &&
    Boolean(review) &&
    (review!.verdict !== "pass" || options.action === "fix" || options.action === "implement");
  const includeReReviewPriorChecklist =
    options.action === "review" && state.stage !== "planning" && Boolean(review) && review!.verdict !== "pass";
  const revisePlanDiffMatch =
    options.action === "design"
      ? /(?:^|\n)(## 退回修改方案前的代码改动现场（revisePlan）[\s\S]*?)(?=\n## (?!#)|$)/.exec(detail.handoffMarkdown)
      : null;
  const revisePlanDiffSection = revisePlanDiffMatch?.[1]?.trim() || "";
  const hasSteering =
    Boolean(options.resolveConflict) ||
    includeReviewDetail ||
    includeReReviewPriorChecklist ||
    Boolean(revisePlanDiffSection) ||
    pendingNotes.length > 0 ||
    Boolean(state.lastFeedback) ||
    Boolean(options.humanInstruction?.trim());

  if (options.resolveConflict) {
    const cc = options.conflictContext;
    const steerLines: string[] = ["## 主干同步与冲突消解任务"];
    if (cc) {
      steerLines.push(
        `- **沙箱分支**：\`${cc.branch}\`（当前基线 \`${cc.baseHead.slice(0, 7)}\`，落后目标主干 \`${cc.targetRef ?? cc.mainHead.slice(0, 7)}\` 共 ${cc.behindCount} 个提交）`,
      );
      if (cc.conflictFiles.length > 0) {
        steerLines.push(`- **冲突文件清单**：${cc.conflictFiles.map((f) => `\`${f}\``).join("、")}`);
      }
      if (cc.mainCommitsSummary?.trim()) {
        steerLines.push("- **主干新增提交摘要**：");
        steerLines.push("```text");
        steerLines.push(sanitizeOutput(cc.mainCommitsSummary.trim(), 1200).text);
        steerLines.push("```");
      }
      if (cc.conflictExcerpt?.trim()) {
        steerLines.push("- **冲突片段预览**：");
        steerLines.push("```diff");
        steerLines.push(sanitizeOutput(cc.conflictExcerpt.trim(), 1800).text);
        steerLines.push("```");
      }
    }
    if (options.humanInstruction?.trim()) {
      steerLines.push(`- **同步指令**：${sanitizeOutput(options.humanInstruction.trim(), 1600).text}`);
    }
    steerLines.push("");
    sections.push({
      key: "steering",
      priority: 1,
      text: clipTextByBytes(steerLines.join("\n"), 4000),
    });
  } else if (includeReReviewPriorChecklist && review) {
    // Re-review convergence reference: show ONLY the structured checklist from the previous non-pass review
    // (never the full verbose markdown or project playbook) so re-reviews verify fixes without scope creep.
    const priorLines: string[] = [
      "## 上轮审查问题清单（复审收敛参考）",
      `- **上轮审查结论**：\`${review.verdict}\`（${review.reviewerHarness}/${review.reviewerModel} · 代码快照 \`${review.reviewedCodeSnapshotHash.slice(0, 10)}\`）`,
      `- **核心摘要**：${sanitizeOutput(review.summary, 600).text}`,
    ];
    if (review.findings && review.findings.length > 0) {
      priorLines.push("- **上轮问题清单**：");
      for (const f of review.findings.slice(0, 15)) {
        const critTag = f.criterionIds?.length ? ` [${f.criterionIds.join(", ")}]` : "";
        const fileTag = f.files?.length ? ` (${f.files.slice(0, 4).join(", ")})` : "";
        priorLines.push(`  - [${f.severity}] \`${f.id}\` ${f.title}${critTag}${fileTag}`);
        if (f.suggestion) priorLines.push(`    - 建议：${sanitizeOutput(f.suggestion, 260).text}`);
      }
    }
    priorLines.push("");
    sections.push({
      key: "steering",
      priority: 1,
      text: clipTextByBytes(priorLines.join("\n"), 2400),
    });
  } else if (hasSteering) {
    const steerLines: string[] = ["## 待处理反馈与审查意见"];
    const hasFreshHumanGuidance = Boolean(state.lastFeedback) || Boolean(options.humanInstruction?.trim());
    const prioritizeHumanOverStaleReview =
      Boolean(review && includeReviewDetail) &&
      validity.reviewValidity.effectiveState === "stale" &&
      hasFreshHumanGuidance;

    const buildReviewLines = (markdownBudget: number): string[] => {
      if (!review || !includeReviewDetail) return [];
      const out: string[] = [];
      const revStatusLabel =
        validity.reviewValidity.effectiveState === "current"
          ? "当前代码快照有效"
          : `历史参考·已过期：${validity.reviewValidity.reason ?? "代码或规范已变动"}`;
      const verdictText =
        review.verdict === "block"
          ? "阻塞修复 (block)"
          : review.verdict === "concern"
            ? "存在关注点 (concern)"
            : "建议通过 (pass)";
      const headingPrefix = prioritizeHumanOverStaleReview ? "历史跨模型 Code Review" : "最新跨模型 Code Review";
      out.push(`### ${headingPrefix}（${review.reviewerHarness}/${review.reviewerModel} · ${verdictText} · ${revStatusLabel}）`);
      out.push(`- **核心结论**：${sanitizeOutput(review.summary, 900).text}`);
      if (review.findings && review.findings.length > 0) {
        out.push("- **结构化审查问题清单**：");
        for (const f of review.findings.slice(0, 20)) {
          const critTag = f.criterionIds?.length ? ` [${f.criterionIds.join(", ")}]` : "";
          const fileTag = f.files?.length ? ` (${f.files.slice(0, 4).join(", ")})` : "";
          out.push(`  - [${f.severity}] \`${f.id}\` ${f.title}${critTag}${fileTag}`);
          if (f.suggestion) out.push(`    - 建议：${sanitizeOutput(f.suggestion, 320).text}`);
        }
      }
      if (review.markdown.trim() && review.verdict !== "pass") {
        out.push(
          clipTextByBytes(
            review.markdown.trim(),
            markdownBudget,
            `\n…（完整审查原文见 \`${itemDirHint}/state.json\` reviewReport）`,
          ),
        );
      }
      out.push("");
      return out;
    };

    const buildHumanLines = (): string[] => {
      const feedbackText = state.lastFeedback?.trim() ?? "";
      const instructionText = options.humanInstruction?.trim() ?? "";
      const showFeedback =
        Boolean(feedbackText) &&
        !(includeReviewDetail && review && isDuplicateText(feedbackText, review.summary));
      const showInstruction =
        options.action !== "ask" &&
        Boolean(instructionText) &&
        !isDuplicateText(instructionText, showFeedback ? feedbackText : null) &&
        !(includeReviewDetail && review && isDuplicateText(instructionText, review.summary));
      if (!showFeedback && !showInstruction && pendingNotes.length === 0) return [];
      const out: string[] = [
        prioritizeHumanOverStaleReview ? "### 人类最新指令与未解决批注（当前最高优先级）" : "### 人类最新指令与未解决批注",
      ];
      if (showFeedback) {
        out.push(`- **最新打回/修改意见**：${sanitizeOutput(feedbackText, 1200).text}`);
      }
      if (showInstruction) {
        out.push(`- **本次执行特别嘱咐**：${sanitizeOutput(instructionText, 1200).text}`);
      }
      for (const d of pendingNotes.slice(-10)) {
        const anchor = d.anchor ? `[${d.anchor}] ` : "";
        out.push(`- (${d.actor}/${d.mode}) ${anchor}${sanitizeOutput(d.message, 500).text}`);
      }
      out.push("");
      return out;
    };

    if (prioritizeHumanOverStaleReview) {
      steerLines.push(...buildHumanLines(), ...buildReviewLines(1000));
    } else {
      steerLines.push(...buildReviewLines(1600), ...buildHumanLines());
    }
    if (revisePlanDiffSection) {
      steerLines.push(clipTextByBytes(revisePlanDiffSection, 2000), "");
    }
    sections.push({
      key: "steering",
      priority: 1,
      text: clipTextByBytes(steerLines.join("\n"), 3800),
    });
  }

  // Latest unresolved failure evidence or previous run tail (for fix / implement)
  if (options.action === "fix" || options.action === "implement") {
    const passedCriteria = new Set(
      validity.coverage.items.filter((c) => c.state === "passed").map((c) => c.criterion.id),
    );
    const latestByCommand = new Map<string, (typeof validity.verifications)[number]>();
    for (const v of validity.verifications) {
      latestByCommand.set(v.record.command, v);
    }
    const isUnresolvedFailure = (v: (typeof validity.verifications)[number]): boolean => {
      if (v.record.passed) return false;
      const latestForCmd = latestByCommand.get(v.record.command);
      if (
        latestForCmd &&
        latestForCmd.effectiveState === "passed" &&
        latestForCmd.record.specHash === v.record.specHash &&
        latestForCmd.record.codeSnapshotHash === v.record.codeSnapshotHash
      ) {
        return false;
      }
      if (v.record.criterionIds.length > 0 && v.record.criterionIds.every((cid) => passedCriteria.has(cid))) {
        return false;
      }
      return true;
    };
    const failedEvs = [...validity.verifications]
      .reverse()
      .filter((v) => v.effectiveState === "failed" && isUnresolvedFailure(v));
    const unresolvedEvs = (
      failedEvs.length > 0
        ? failedEvs
        : [...validity.verifications].reverse().filter((v) => isUnresolvedFailure(v))
    ).slice(0, 3);
    const includeLogTail =
      Boolean(options.previousLogTail?.trim()) && options.previousRun?.status !== "succeeded";
    if (unresolvedEvs.length > 0 || includeLogTail) {
      const failLines: string[] = ["## 失败与运行现场"];
      const perExcerptBudget = Math.max(600, Math.floor(1800 / Math.max(1, unresolvedEvs.length)));
      for (const failedEv of unresolvedEvs) {
        let excerpt = failedEv.record.outputPreview;
        try {
          const full = getVerificationEvidence(root, id, failedEv.record.id);
          excerpt = full.log.slice(-perExcerptBudget);
        } catch {
          // Fallback to preview.
        }
        const staleTag = failedEv.effectiveState !== "failed" ? " · 代码后续有改动" : "";
        failLines.push(`- 最近失败验证 \`${failedEv.record.command}\`（退出码 ${failedEv.record.exitCode}${staleTag}，完整日志 \`${itemDirHint}/${failedEv.record.outputPath}\`）：`);
        failLines.push("```text");
        failLines.push(sanitizeOutput(excerpt, perExcerptBudget).text);
        failLines.push("```");
      }
      if (includeLogTail && options.previousLogTail?.trim()) {
        failLines.push("- 前序运行末尾输出：");
        failLines.push("```text");
        failLines.push(sanitizeOutput(options.previousLogTail.slice(-1000), 1000).text);
        failLines.push("```");
      }
      failLines.push("");
      sections.push({
        key: "failures",
        priority: 2,
        text: clipTextByBytes(failLines.join("\n"), 3000),
      });
    }
  }

  // Objective Trace summary from previous run (omitted during blind review, and skipped when previous run was a read-only review
  // whose structured findings are already provided in the steering section).
  if (options.action !== "review" && options.previousRun && options.previousRun.action !== "review") {
    const traceSummary = extractTraceHandoffSummary(root, id, options.previousRun.id);
    if (traceSummary) {
      sections.push({
        key: "trace",
        priority: 3,
        text: clipTextByBytes(traceSummary, 1600),
        minText: "",
      });
    }
  }

  // Authoritative file pointers + adopted human decisions + criteria coverage
  const isAskAction = options.action === "ask";
  const contractLines: string[] = [
    "## 权威文件指引与验收条件",
    isAskAction
      ? `- **需求规范**：\`${itemDirHint}/spec.md\`（按需只读查阅）`
      : `- **需求规范**：\`${itemDirHint}/spec.md\`（请用原生工具直接读取全文）`,
    designMarkdown.trim()
      ? isAskAction
        ? `- **技术方案**：\`${itemDirHint}/design.md\`（已存在，按需查阅）`
        : `- **技术方案**：\`${itemDirHint}/design.md\`（已存在，请直接读取全文）`
      : `- **技术方案**：\`${itemDirHint}/design.md\`（尚未起草）`,
  ];
  if (validity.verifications.length > 0) {
    contractLines.push(`- **验证证据目录**：\`${itemDirHint}/evidence/\`（共 ${validity.verifications.length} 条记录）`);
  }
  contractLines.push("");
  if (state.humanDecisions && state.humanDecisions.length > 0) {
    contractLines.push("### 人类已采纳决策（权威裁决）");
    contractLines.push("以下由人类在方案评审中明确拍板的结论具有最高权威，编码、修复与审查均须严格遵守：");
    for (const dec of state.humanDecisions) {
      const optSuffix = dec.optionId ? ` [\`${dec.optionId}\`]` : "";
      contractLines.push(`- **${dec.id}** ${dec.question} → **${dec.answer}**${optSuffix}`);
    }
    contractLines.push("");
  }
  if (validity.coverage.items.length > 0) {
    contractLines.push("### 验收条件状态");
    for (const item of validity.coverage.items) {
      const sym = item.state === "passed" ? "✓" : item.state === "failed" ? "×" : item.state === "stale" ? "⟳" : "○";
      const reqTag = item.criterion.required ? "必需" : "参考";
      const cmdTag =
        item.criterion.kind === "manual"
          ? options.action === "review" && item.state !== "passed"
            ? ` | 人工核验·审查阶段待人类核验，勿判 block${item.criterion.steps ? `: ${item.criterion.steps}` : ""}`
            : ` | 人工核验${item.criterion.steps ? `: ${item.criterion.steps}` : ""}`
          : item.criterion.command
            ? ` | 命令: \`${item.criterion.command}\``
            : "";
      contractLines.push(`- ${sym} **${item.criterion.id}** (${reqTag}, ${item.state}): ${item.criterion.description}${cmdTag}`);
    }
    contractLines.push("");
  }
  if (state.attachments && state.attachments.length > 0) {
    contractLines.push("### 附件清单（可直接读取）");
    contractLines.push("图片可直接读取查看；日志/文本可检索，pdf/zip 请按需解压。");
    for (const meta of state.attachments.slice(0, 8)) {
      let fileName = `${meta.id}`;
      try {
        fileName = attachmentFileName(meta);
      } catch {
        // Keep fallback ID visible for debugging.
      }
      const absPath = path.join(codeRoot, WORKBENCH_DIR, "items", state.id, "attachments", fileName);
      contractLines.push(`- ${meta.name}（${meta.mimeType}，${formatAttachmentSize(meta.size)}）：\`${absPath}\``);
    }
    contractLines.push("");
  }
  if (options.action !== "review" && options.action !== "ask") {
    const playbook = readProjectPlaybook(root);
    if (playbook.lessons.length > 0) {
      contractLines.push("### 项目经验法则（`.workbench/playbook.md`）");
      const recentLessons = playbook.lessons.slice(-12);
      for (const lesson of recentLessons) {
        contractLines.push(`- ${sanitizeOutput(lesson, 260).text}`);
      }
      contractLines.push("");
    }
  }
  sections.push({
    key: "contract",
    priority: 4,
    text: contractLines.join("\n"),
    minText: `## 权威文件指引与验收条件\n- 规范：\`${itemDirHint}/spec.md\` · 方案：\`${itemDirHint}/design.md\`\n`,
  });

  // Objective Git file list & baseline hint
  if (options.action !== "design" || gitChanges.files.length > 0) {
    const gitLines: string[] = ["## Git 变更现场"];
    if (!gitChanges.isGitRepo) {
      gitLines.push("- 当前目录非 Git 仓库");
    } else {
      const baseRef = state.baseline?.head ? ` | 基线: \`${state.baseline.head.slice(0, 10)}\`` : "";
      gitLines.push(`- HEAD: \`${gitChanges.head || "(unborn)"}\`${baseRef} | 变更文件数: ${gitChanges.files.length}`);
      if (gitChanges.files.length > 0) {
        gitLines.push("- 变更文件清单：");
        for (const f of gitChanges.files.slice(0, 30)) {
          gitLines.push(`  - \`${f.status}\` ${f.path}`);
        }
        if (gitChanges.files.length > 30) {
          gitLines.push(`  - …（其余 ${gitChanges.files.length - 30} 个文件请用 git status 查看）`);
        }
      }
      if (options.action === "review") {
        let diffForTampering = gitChanges.diff;
        if (gitChanges.diffTruncated) {
          const testPaths = gitChanges.files
            .map((f) => f.path)
            .filter((p) => /(?:^|\/)(?:__tests__\/.*|test_[^/]+\.py|.*_test\.go|.*\.(?:test|spec)\.[A-Za-z0-9]+)$/i.test(p) || p.endsWith(".rs"));
          if (testPaths.length > 0) {
            try {
              const diffArgs = gitChanges.baselineAvailable && gitChanges.baselineHead
                ? ["-C", codeRoot, "diff", "--no-color", gitChanges.baselineHead, "--", ...testPaths.slice(0, 64)]
                : ["-C", codeRoot, "diff", "--no-color", "HEAD", "--", ...testPaths.slice(0, 64)];
              diffForTampering = execFileSync("git", diffArgs, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
            } catch {
              // Fallback to truncated diff.
            }
          }
        }
        const tampering = detectTestTamperingSignals(gitChanges.files, diffForTampering);
        if (tampering.length > 0) {
          gitLines.push(`- ⚠ **测试完整性提示**：${tampering.join("；")}`);
        }
      }
      const diffCmd = state.baseline?.head ? `git diff ${state.baseline.head}` : "git diff";
      gitLines.push(`- 完整代码差异请直接运行 \`${diffCmd}\`（工作区未暂存改动用 \`git status\` / \`git diff\`）。`);
      if (options.action === "review" && options.incrementalReview) {
        const inc = options.incrementalReview;
        gitLines.push(
          `- **本轮复审增量范围**：\`${inc.fromCommit.slice(0, 7)}..HEAD\`（共变更 ${inc.files.length} 个文件${inc.files.length > 0 ? `：${inc.files.slice(0, 12).map((f) => `\`${f}\``).join("、")}` : ""}）`,
        );
        if (inc.diff.trim()) {
          gitLines.push("```diff");
          gitLines.push(clipTextByBytes(inc.diff.trim(), 2400, "\n…（增量 Diff 已截断，请运行 git diff 查看完整内容）"));
          gitLines.push("```");
        }
      }
    }
    gitLines.push("");
    sections.push({
      key: "git",
      priority: options.action === "review" && options.incrementalReview ? 2 : 5,
      text: gitLines.join("\n"),
      minText: gitChanges.isGitRepo
        ? `## Git 变更现场\n- HEAD: \`${gitChanges.head || "(unborn)"}\` | 变更文件数: ${gitChanges.files.length}\n`
        : "",
    });
  }

  const { markdown, composition } = assembleBudgetedPacket(headerText, sections, HANDOFF_MAX_BYTES);
  const saved = await saveHandoffMarkdown(root, id, markdown, gitChanges.fingerprint ?? null);
  return { markdown, detail: saved, outputLanguage, composition };
}
