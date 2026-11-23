import * as path from "node:path";
import { attachmentFileName, formatAttachmentSize } from "../core/attachments.ts";
import { discoverProjectContext } from "../core/context.ts";
import { getProjectStatus, getRequirement, getVerificationEvidence, saveHandoffMarkdown } from "../core/engine.ts";
import { observeGitChanges } from "../core/git.ts";
import { resolveEffectiveOutputLanguage, type ResolvedOutputLanguage } from "../core/language.ts";
import { readPlaybook } from "../core/playbook.ts";
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
const PLAYBOOK_SECTION_MAX_BYTES = 1200;

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

export interface HandoffSynthesisOptions {
  action: AgentAction;
  humanInstruction?: string;
  anchorIds?: string[];
  previousRun?: AgentRunRecord | null;
  previousLogTail?: string;
  hubOutputLanguage?: OutputLanguage;
  resolveConflict?: boolean;
  conflictContext?: ConflictHandoffContext;
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
  playbook: "Playbook",
  steering: "Review & Feedback",
  failures: "Failure Evidence",
  progress: "Tasks & HandoffNote",
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

  const joinAll = () =>
    [headerText, ...sections.map((s) => s.text).filter((t) => t.trim().length > 0)].join("\n");

  let assembled = joinAll();
  if (Buffer.byteLength(assembled, "utf8") > maxBytes) {
    // Trim lowest-priority sections first so review findings, human feedback, and failures survive.
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
 * Synthesizes a pointer-first, high-signal orientation packet from authoritative disk state,
 * review findings, objective git file status, failed evidence, and human annotations.
 * Never pre-truncates spec.md, design.md, or git diffs so agents read full ground truth natively.
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
    `- **当前阶段**：\`${state.stage}\` | **轨道**：\`${state.track}\` | **拟执行动作**：\`${options.action}\``,
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
  if (projectContext.archDocs.length > 0) {
    const docSummary = projectContext.archDocs
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

  // Playbook is omitted during blind review to avoid biasing independent judgment.
  if (options.action !== "review") {
    const playbook = readPlaybook(root);
    if (playbook.rules.length > 0) {
      const pbLines: string[] = [
        "## 项目持久避坑与偏好法则（Playbook）",
        `> 完整法则文件见 \`${WORKBENCH_DIR}/playbook.md\`（共 ${playbook.rules.length} 条）。`,
      ];
      let usedBytes = 0;
      for (const rule of playbook.rules.slice(-12)) {
        const cleanRule = sanitizeOutput(rule, 480).text.trim();
        if (!cleanRule) continue;
        const bullet = `- ${cleanRule}`;
        const bulletBytes = Buffer.byteLength(bullet, "utf8") + 1;
        if (usedBytes > 0 && usedBytes + bulletBytes > PLAYBOOK_SECTION_MAX_BYTES) break;
        if (bulletBytes > PLAYBOOK_SECTION_MAX_BYTES) {
          pbLines.push(`- ${sanitizeOutput(cleanRule, PLAYBOOK_SECTION_MAX_BYTES - 20).text}`);
          break;
        }
        pbLines.push(bullet);
        usedBytes += bulletBytes;
      }
      pbLines.push("");
      sections.push({
        key: "playbook",
        priority: 6,
        text: pbLines.join("\n"),
        minText: "",
      });
    }
  }

  // Highest-priority steering: merge conflict / review findings (non-review actions) / human feedback / unresolved annotations
  const allDiscussions = state.discussions ?? [];
  const unresolvedRefineNotes = allDiscussions.filter((d) => d.mode === "refine" && !d.resolved);
  const recentAskNotes = allDiscussions.filter((d) => d.mode === "ask").slice(-4);
  const pendingIds = new Set([...unresolvedRefineNotes.slice(-10), ...recentAskNotes].map((d) => d.id));
  const pendingNotes = allDiscussions.filter((d) => pendingIds.has(d.id));
  const review = state.reviewReport;
  // Blind review should not be biased by prior review verdicts; only non-review actions see review findings.
  const includeReviewDetail =
    options.action !== "review" &&
    Boolean(review) &&
    (review!.verdict !== "pass" || options.action === "fix" || options.action === "implement");
  const hasSteering =
    Boolean(options.resolveConflict) ||
    includeReviewDetail ||
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
      if (!state.lastFeedback && !options.humanInstruction?.trim() && pendingNotes.length === 0) return [];
      const out: string[] = [
        prioritizeHumanOverStaleReview ? "### 人类最新指令与未解决批注（当前最高优先级）" : "### 人类最新指令与未解决批注",
      ];
      if (state.lastFeedback) {
        out.push(`- **最新打回/修改意见**：${sanitizeOutput(state.lastFeedback, 1200).text}`);
      }
      if (options.humanInstruction?.trim()) {
        out.push(`- **本次执行特别嘱咐**：${sanitizeOutput(options.humanInstruction.trim(), 1200).text}`);
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
    if (unresolvedEvs.length > 0 || options.previousLogTail?.trim()) {
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
      if (options.previousLogTail?.trim()) {
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

  // Tasks & HandoffNote (omitted during review to keep blind review clean)
  if (options.action !== "review" && (state.tasks.length > 0 || state.handoffNote)) {
    const progLines: string[] = ["## 进度与备忘（Dead-Ends & Decisions）"];
    if (state.tasks.length > 0) {
      for (const t of state.tasks) {
        const mark = t.status === "done" ? "✓" : t.status === "in_progress" ? "●" : t.status === "blocked" ? "!" : "○";
        progLines.push(`- ${mark} \`${t.id}\` ${t.title}${t.note ? `（${t.note}）` : ""}`);
      }
      progLines.push("");
    }
    if (state.handoffNote) {
      if (state.handoffNote.keyDecisions.length > 0) {
        progLines.push("**关键定位/决策**：");
        for (const d of state.handoffNote.keyDecisions) progLines.push(`- ${d}`);
      }
      if (state.handoffNote.deadEnds.length > 0) {
        progLines.push("**已证实走不通的死胡同（切勿重复踩坑）**：");
        for (const d of state.handoffNote.deadEnds) progLines.push(`- ⚠ ${d}`);
      }
      if (state.handoffNote.nextSteps.length > 0) {
        progLines.push("**建议下一步**：");
        for (const d of state.handoffNote.nextSteps) progLines.push(`- ${d}`);
      }
      progLines.push("");
    }
    sections.push({
      key: "progress",
      priority: 3,
      text: clipTextByBytes(progLines.join("\n"), 2200),
    });
  }

  // Authoritative file pointers + criteria coverage (NO spec/design body truncation!)
  const contractLines: string[] = [
    "## 权威文件指引与验收条件",
    `- **需求规范**：\`${itemDirHint}/spec.md\`（请用原生工具直接读取全文）`,
    designMarkdown.trim()
      ? `- **技术方案**：\`${itemDirHint}/design.md\`（已存在，请直接读取全文）`
      : `- **技术方案**：\`${itemDirHint}/design.md\`（尚未起草）`,
  ];
  if (validity.verifications.length > 0) {
    contractLines.push(`- **验证证据目录**：\`${itemDirHint}/evidence/\`（共 ${validity.verifications.length} 条记录）`);
  }
  contractLines.push("");
  if (validity.coverage.items.length > 0) {
    contractLines.push("### 验收条件状态");
    for (const item of validity.coverage.items) {
      const sym = item.state === "passed" ? "✓" : item.state === "failed" ? "×" : item.state === "stale" ? "⟳" : "○";
      const reqTag = item.criterion.required ? "必需" : "参考";
      const cmdTag = item.criterion.command ? ` | 命令: \`${item.criterion.command}\`` : "";
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
  sections.push({
    key: "contract",
    priority: 4,
    text: contractLines.join("\n"),
    minText: `## 权威文件指引与验收条件\n- 规范：\`${itemDirHint}/spec.md\` · 方案：\`${itemDirHint}/design.md\`\n`,
  });

  // Objective Git file list & baseline hint (NO truncated diff!)
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
        const tampering = detectTestTamperingSignals(gitChanges.files, gitChanges.diff);
        if (tampering.length > 0) {
          gitLines.push(`- ⚠ **测试完整性提示**：${tampering.join("；")}`);
        }
      }
      const diffCmd = state.baseline?.head ? `git diff ${state.baseline.head}` : "git diff";
      gitLines.push(`- 完整代码差异请直接运行 \`${diffCmd}\`（工作区未暂存改动用 \`git status\` / \`git diff\`）。`);
    }
    gitLines.push("");
    sections.push({
      key: "git",
      priority: 5,
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
