import * as fs from "node:fs";
import { atomicWriteFile, canonicalRoot, readBoundedText, resolveSafePath, withProjectWriteLock } from "./fs.ts";
import { isProjectInitialized } from "./store.ts";
import { WORKBENCH_DIR, type RequirementDetail } from "./types.ts";
import { validateMarkdownContent } from "./validate.ts";

export const MAX_PLAYBOOK_BYTES = 16 * 1024;
const PLAYBOOK_HEADER = "# 项目持久避坑与偏好法则（Playbook）\n\n> 由 Workbench 自进化引擎从历史需求经验与人工反馈中自动沉淀，每次执行任务时自动注入交接简报。";

export function playbookFilePath(root: string): string {
  return resolveSafePath(canonicalRoot(root), `${WORKBENCH_DIR}/playbook.md`);
}

function normalizeRuleKey(rule: string): string {
  return rule
    .replace(/^[-*]\s+/, "")
    .replace(/^\[[^\]]+\]\s*/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function extractPlaybookRules(markdown: string): string[] {
  const rules: string[] = [];
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("- ") && !line.startsWith("* ")) continue;
    const body = line.slice(2).trim();
    if (body) rules.push(body);
  }
  return rules;
}

export function readPlaybook(root: string): {
  exists: boolean;
  markdown: string;
  rules: string[];
  updatedAt: number | null;
} {
  const base = canonicalRoot(root);
  if (!isProjectInitialized(base)) {
    return { exists: false, markdown: "", rules: [], updatedAt: null };
  }
  const filePath = playbookFilePath(base);
  if (!fs.existsSync(filePath)) {
    return { exists: false, markdown: "", rules: [], updatedAt: null };
  }
  const markdown = validateMarkdownContent(readBoundedText(filePath, MAX_PLAYBOOK_BYTES), "playbook", true);
  const stat = fs.statSync(filePath);
  return {
    exists: true,
    markdown,
    rules: extractPlaybookRules(markdown),
    updatedAt: Math.round(stat.mtimeMs),
  };
}

export async function writePlaybook(
  root: string,
  markdown: string,
): Promise<{ markdown: string; rules: string[]; updatedAt: number }> {
  const base = canonicalRoot(root);
  const clean = validateMarkdownContent(markdown, "playbook", true);
  if (Buffer.byteLength(clean, "utf8") > MAX_PLAYBOOK_BYTES) {
    throw new Error(`playbook.md 超过 ${MAX_PLAYBOOK_BYTES} 字节上限`);
  }
  return withProjectWriteLock(base, () => {
    const filePath = playbookFilePath(base);
    atomicWriteFile(filePath, clean ? `${clean.trimEnd()}\n` : "");
    return {
      markdown: clean,
      rules: extractPlaybookRules(clean),
      updatedAt: Date.now(),
    };
  });
}

export async function distillRequirementToPlaybook(
  root: string,
  detail: RequirementDetail,
  extra?: { feedback?: string | null },
): Promise<{ added: number; rules: string[]; markdown: string }> {
  const base = canonicalRoot(root);
  if (!isProjectInitialized(base)) {
    return { added: 0, rules: [], markdown: "" };
  }

  const candidates: string[] = [];
  const reqId = detail.state.id;
  for (const deadEnd of detail.state.handoffNote?.deadEnds ?? []) {
    const clean = deadEnd.trim().replace(/\s+/g, " ");
    if (clean.length >= 6) {
      candidates.push(`[避坑 · ${reqId}] ${clean.slice(0, 260)}`);
    }
  }
  const feedback = (extra?.feedback ?? detail.state.lastFeedback)?.trim().replace(/\s+/g, " ");
  if (feedback && feedback.length >= 6) {
    candidates.push(`[人工纠偏 · ${reqId}] ${feedback.slice(0, 260)}`);
  }

  if (candidates.length === 0) {
    const existing = readPlaybook(base);
    return { added: 0, rules: existing.rules, markdown: existing.markdown };
  }

  return withProjectWriteLock(base, () => {
    const filePath = playbookFilePath(base);
    const current = fs.existsSync(filePath)
      ? validateMarkdownContent(readBoundedText(filePath, MAX_PLAYBOOK_BYTES), "playbook", true)
      : "";
    const existingRules = extractPlaybookRules(current);
    const seen = new Set(existingRules.map(normalizeRuleKey));

    const toAppend: string[] = [];
    for (const cand of candidates) {
      const key = normalizeRuleKey(cand);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      toAppend.push(cand);
    }

    if (toAppend.length === 0) {
      return { added: 0, rules: existingRules, markdown: current };
    }

    const baseDoc = current.trim() ? current.trimEnd() : PLAYBOOK_HEADER;
    const appendedBlock = toAppend.map((r) => `- ${r}`).join("\n");
    let nextMarkdown = `${baseDoc}\n${current.trim() ? "" : "\n"}${appendedBlock}\n`;

    // Trim oldest bullet rules if exceeding MAX_PLAYBOOK_BYTES
    while (Buffer.byteLength(nextMarkdown, "utf8") > MAX_PLAYBOOK_BYTES) {
      const lines = nextMarkdown.split("\n");
      const firstBulletIdx = lines.findIndex((l) => l.trim().startsWith("- ") || l.trim().startsWith("* "));
      if (firstBulletIdx === -1) break;
      lines.splice(firstBulletIdx, 1);
      nextMarkdown = lines.join("\n");
    }

    atomicWriteFile(filePath, nextMarkdown);
    return {
      added: toAppend.length,
      rules: extractPlaybookRules(nextMarkdown),
      markdown: nextMarkdown,
    };
  });
}
