import { getProjectStatus, getRequirement, getVerificationEvidence, saveHandoffMarkdown } from "../core/engine.ts";
import { observeGitChanges } from "../core/git.ts";
import { resolveEffectiveOutputLanguage, type ResolvedOutputLanguage } from "../core/language.ts";
import { readPlaybook } from "../core/playbook.ts";
import { resolveCodeRoot } from "../core/sandbox.ts";
import type { AgentAction, AgentRunRecord, RequirementDetail } from "../core/types.ts";
import { sanitizeOutput } from "../core/validate.ts";
import { readHubConfig } from "./registry.ts";

const HANDOFF_MAX_BYTES = 10 * 1024;

export interface HandoffSynthesisOptions {
  action: AgentAction;
  humanInstruction?: string;
  anchorIds?: string[];
  previousRun?: AgentRunRecord | null;
  previousLogTail?: string;
}

/**
 * Synthesizes a high-signal, token-bounded (~1.5k-3k tokens) handoff brief from authoritative
 * disk state, objective git working-tree delta, failed evidence, and unresolved human annotations.
 */
export async function synthesizeHandoffPacket(
  root: string,
  id: string,
  options: HandoffSynthesisOptions,
): Promise<{ markdown: string; detail: RequirementDetail; outputLanguage: ResolvedOutputLanguage }> {
  const codeRoot = resolveCodeRoot(root, id);
  const gitChanges = await observeGitChanges(codeRoot, { maxDiffBytes: 4096 });
  const detail = getRequirement(root, id, { currentCodeSnapshotHash: gitChanges.fingerprint ?? null });
  const { state, specMarkdown, designMarkdown, validity } = detail;
  const projectMeta = getProjectStatus(root).project;
  const hubCfg = readHubConfig();
  const outputLanguage = resolveEffectiveOutputLanguage({
    projectLanguage: projectMeta?.outputLanguage,
    hubLanguage: hubCfg.outputLanguage,
    contextText: `${state.title}\n${specMarkdown}`,
  });

  const lines: string[] = [];
  lines.push(`# ${state.id} · ${state.title} — 上下文交接简报`);
  lines.push("");
  lines.push(`- **当前阶段**：\`${state.stage}\` | **轨道**：\`${state.track}\` | **拟执行动作**：\`${options.action}\``);
  lines.push(
    outputLanguage === "en"
      ? "- **Output Language Policy**：`English (en)` — Write all titles, specs, designs, criteria descriptions, tasks, reviews, and handoff memos strictly in English."
      : "- **输出语言规范**：`简体中文 (zh-CN)` — 所有提交的标题、规范、方案、验收条件描述、任务、审查意见与交接备忘必须严格使用简体中文（代码符号与命令原文除外）。",
  );
  if (codeRoot !== root) {
    lines.push(`- **隔离沙箱目录**：\`${codeRoot}\`（请在当前沙箱目录修改代码并运行验证；数据仍绑定主仓库）`);
  }

  if (options.previousRun) {
    lines.push(
      `- **前序执行**：\`${options.previousRun.harness}/${options.previousRun.model}\` · 状态 \`${options.previousRun.status}\`${options.previousRun.rateLimited ? "（疑似额度/限流中断）" : ""}`,
    );
  }
  lines.push("");

  const playbook = readPlaybook(root);
  if (playbook.rules.length > 0) {
    lines.push("## 0. 项目持久避坑与偏好法则（Playbook）");
    let usedBytes = 0;
    for (const rule of playbook.rules.slice(-12)) {
      const cleanRule = sanitizeOutput(rule, 600).text.trim();
      if (!cleanRule) continue;
      const bullet = `- ${cleanRule}`;
      const bulletBytes = Buffer.byteLength(bullet, "utf8") + 1;
      if (usedBytes > 0 && usedBytes + bulletBytes > 1200) break;
      if (bulletBytes > 1200) {
        lines.push(`- ${sanitizeOutput(cleanRule, 1180).text}`);
        break;
      }
      lines.push(bullet);
      usedBytes += bulletBytes;
    }
    lines.push("");
  }

  // 1. Contract summary
  lines.push("## 1. 权威目标、方案与验收条件");
  lines.push("### 需求目标（spec.md 摘要）");
  lines.push(specMarkdown.trim().slice(0, 1400) || "（暂无）");
  lines.push("");
  if (designMarkdown.trim()) {
    lines.push("### 当前技术方案（design.md 摘要）");
    lines.push(designMarkdown.trim().slice(0, 1800));
    lines.push("");
  }
  if (validity.coverage.items.length > 0) {
    lines.push("### 验收条件覆盖状态");
    for (const item of validity.coverage.items) {
      const sym = item.state === "passed" ? "✓" : item.state === "failed" ? "×" : item.state === "stale" ? "⟳" : "○";
      const reqTag = item.criterion.required ? "必需" : "参考";
      const cmdTag = item.criterion.command ? ` | 命令: \`${item.criterion.command}\`` : "";
      lines.push(`- ${sym} **${item.criterion.id}** (${reqTag}, ${item.state}): ${item.criterion.description}${cmdTag}`);
    }
    lines.push("");
  }

  // 2. Tasks & HandoffNote
  if (state.tasks.length > 0 || state.handoffNote) {
    lines.push("## 2. 实施进度与前序备忘（Dead-Ends & Decisions）");
    if (state.tasks.length > 0) {
      for (const t of state.tasks) {
        const mark = t.status === "done" ? "✓" : t.status === "in_progress" ? "●" : t.status === "blocked" ? "!" : "○";
        lines.push(`- ${mark} \`${t.id}\` ${t.title}${t.note ? `（${t.note}）` : ""}`);
      }
      lines.push("");
    }
    if (state.handoffNote) {
      if (state.handoffNote.keyDecisions.length > 0) {
        lines.push("**关键定位/决策**：");
        for (const d of state.handoffNote.keyDecisions) lines.push(`- ${d}`);
      }
      if (state.handoffNote.deadEnds.length > 0) {
        lines.push("**已证实走不通的死胡同（切勿重复踩坑）**：");
        for (const d of state.handoffNote.deadEnds) lines.push(`- ⚠ ${d}`);
      }
      if (state.handoffNote.nextSteps.length > 0) {
        lines.push("**建议下一步**：");
        for (const d of state.handoffNote.nextSteps) lines.push(`- ${d}`);
      }
      lines.push("");
    }
  }

  // 3. Objective Git Ground Truth
  lines.push("## 3. 当前客观 Git 代码现场");
  if (!gitChanges.isGitRepo) {
    lines.push("- 当前目录非 Git 仓库");
  } else {
    lines.push(`- HEAD: \`${gitChanges.head || "(unborn)"}\` | 脏文件数: ${gitChanges.files.length}`);
    if (gitChanges.files.length > 0) {
      lines.push("- 变更文件清单：");
      for (const f of gitChanges.files.slice(0, 25)) {
        lines.push(`  - \`${f.status}\` ${f.path}`);
      }
    }
    if (gitChanges.diff.trim()) {
      lines.push("```diff");
      lines.push(sanitizeOutput(gitChanges.diff, 2500).text);
      lines.push("```");
    }
  }
  lines.push("");

  // 4. Latest failure evidence or previous run tail
  const failedEv = [...validity.verifications].reverse().find((v) => v.effectiveState === "failed");
  if (failedEv || options.previousLogTail?.trim()) {
    lines.push("## 4. 最新失败证据与尾部现场");
    if (failedEv) {
      let excerpt = failedEv.record.outputPreview;
      try {
        const full = getVerificationEvidence(root, id, failedEv.record.id);
        excerpt = full.log.slice(-1500);
      } catch {
        // Fallback to preview.
      }
      lines.push(`- 最近失败验证 \`${failedEv.record.command}\`（退出码 ${failedEv.record.exitCode}）：`);
      lines.push("```text");
      lines.push(sanitizeOutput(excerpt, 1500).text);
      lines.push("```");
    }
    if (options.previousLogTail?.trim()) {
      lines.push("- 前序 Agent 运行末尾输出：");
      lines.push("```text");
      lines.push(sanitizeOutput(options.previousLogTail.slice(-1500), 1500).text);
      lines.push("```");
    }
    lines.push("");
  }

  // 5. Unresolved discussions & human steering
  const pendingNotes = (state.discussions ?? []).filter((d) => !d.resolved);
  if (pendingNotes.length > 0 || state.lastFeedback || options.humanInstruction?.trim()) {
    lines.push("## 5. 人类最新反馈、段落批注与纠偏指令");
    if (state.lastFeedback) {
      lines.push(`- **最新打回意见**：${state.lastFeedback}`);
    }
    if (options.humanInstruction?.trim()) {
      lines.push(`- **本次执行特别嘱咐**：${options.humanInstruction.trim()}`);
    }
    for (const d of pendingNotes.slice(-10)) {
      const anchor = d.anchor ? `[${d.anchor}] ` : "";
      lines.push(`- (${d.actor}/${d.mode}) ${anchor}${d.message}`);
    }
    lines.push("");
  }

  const markdown = sanitizeOutput(lines.join("\n"), HANDOFF_MAX_BYTES).text;
  const saved = await saveHandoffMarkdown(root, id, markdown, gitChanges.fingerprint ?? null);
  return { markdown, detail: saved, outputLanguage };
}
