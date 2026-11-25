import * as fs from "node:fs";
import type { ProjectContextSummary } from "../core/context.ts";
import {
  extractInlineCriteriaFromDesign,
  getProjectStatus,
  getRequirement,
  isUiRelatedRequirement,
  propose,
} from "../core/engine.ts";
import { readBoundedText, resolveSafePath } from "../core/fs.ts";
import { observeGitSnapshot } from "../core/git.ts";
import { runAllVerifications } from "../core/runner.ts";
import { captureRequirementScreenshots } from "../core/screenshots.ts";
import {
  MAX_DESIGN_BYTES,
  MAX_SPEC_BYTES,
  WORKBENCH_DIR,
  type CriterionInput,
  type RequirementDetail,
  type ReviewFinding,
  type ReviewVerdict,
} from "../core/types.ts";
import { normalizeCriteria, sanitizeOutput, validateMarkdownContent } from "../core/validate.ts";
import { computeDesignHash, computeSpecHash } from "../core/validity.ts";

export interface ParsedReviewOutput {
  verdict: ReviewVerdict;
  summary: string;
  markdown: string;
  findings?: ReviewFinding[];
}

function parseReviewFindings(rawFindings: unknown): ReviewFinding[] | undefined {
  if (!Array.isArray(rawFindings) || rawFindings.length === 0) return undefined;
  const out: ReviewFinding[] = [];
  for (let idx = 0; idx < rawFindings.length && out.length < 50; idx++) {
    const item = rawFindings[idx];
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const rawTitle = typeof obj.title === "string" ? sanitizeOutput(obj.title.trim(), 380).text.trim() : "";
    if (!rawTitle) continue;
    const sev = obj.severity === "high" || obj.severity === "medium" || obj.severity === "low" ? obj.severity : "medium";
    const id =
      typeof obj.id === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(obj.id.trim())
        ? obj.id.trim()
        : `F-${out.length + 1}`;
    const detail =
      typeof obj.detail === "string" && obj.detail.trim()
        ? sanitizeOutput(obj.detail.trim(), 1800).text.trim()
        : undefined;
    const suggestion =
      typeof obj.suggestion === "string" && obj.suggestion.trim()
        ? sanitizeOutput(obj.suggestion.trim(), 1400).text.trim()
        : undefined;
    const criterionIds = Array.isArray(obj.criterionIds)
      ? obj.criterionIds
          .filter((c): c is string => typeof c === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(c.trim()))
          .map((c) => c.trim())
          .slice(0, 16)
      : undefined;
    const files = Array.isArray(obj.files)
      ? obj.files
          .filter((f): f is string => typeof f === "string" && f.trim().length > 0)
          .map((f) => sanitizeOutput(f.trim(), 480).text.trim())
          .filter(Boolean)
          .slice(0, 16)
      : undefined;
    out.push({
      id,
      severity: sev,
      title: rawTitle,
      ...(detail ? { detail } : {}),
      ...(criterionIds && criterionIds.length > 0 ? { criterionIds } : {}),
      ...(files && files.length > 0 ? { files } : {}),
      ...(suggestion ? { suggestion } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

export function parseReviewOutput(rawOutput: string): ParsedReviewOutput | null {
  const clean = sanitizeOutput(rawOutput, 256 * 1024).text.trim();
  if (!clean) return null;
  const jsonBlocks = Array.from(clean.matchAll(/```json\s*([\s\S]*?)```/gi));
  for (let i = jsonBlocks.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(jsonBlocks[i]![1]!) as { verdict?: string; summary?: string; findings?: unknown };
      if (parsed.verdict === "pass" || parsed.verdict === "concern" || parsed.verdict === "block") {
        const findings = parseReviewFindings(parsed.findings);
        return {
          verdict: parsed.verdict,
          summary: parsed.summary?.trim() || `审查结论：${parsed.verdict}`,
          markdown: clean,
          ...(findings ? { findings } : {}),
        };
      }
    } catch {
      // Try an earlier block.
    }
  }
  const bareMatches = Array.from(
    clean.slice(-8192).matchAll(/\{[^{}]*"verdict"\s*:\s*"(pass|concern|block)"[^{}]*\}/g),
  );
  const bare = bareMatches.pop();
  if (bare) {
    try {
      const parsed = JSON.parse(bare[0]) as { verdict: ReviewVerdict; summary?: string };
      return {
        verdict: parsed.verdict,
        summary: parsed.summary?.trim() || `审查结论：${parsed.verdict}`,
        markdown: clean,
      };
    } catch {
      // Malformed bare object.
    }
  }
  return null;
}

function readDiskDesignCandidate(
  base: string,
  codeRoot: string,
  id: string,
  latestReq: RequirementDetail,
  preSpecMarkdown: string,
  preDesignMarkdown: string,
): { specMarkdown: string; designMarkdown: string; criteria?: CriterionInput[]; criteriaPaths: string[] } | null {
  const itemRel = `${WORKBENCH_DIR}/items/${id}`;
  const readOpt = (rootDir: string, rel: string, maxBytes: number): string | null => {
    try {
      const full = resolveSafePath(rootDir, rel);
      if (!fs.existsSync(full)) return null;
      return readBoundedText(full, maxBytes);
    } catch {
      return null;
    }
  };
  const criteriaPaths = new Set<string>();
  const parseCriteriaFile = (rootDir: string): CriterionInput[] | undefined => {
    const raw = readOpt(rootDir, `${itemRel}/criteria.json`, 64 * 1024);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
      const valid: CriterionInput[] = [];
      for (const entry of parsed.slice(0, 32)) {
        if (!entry || typeof entry !== "object") continue;
        const obj = entry as Record<string, unknown>;
        if (typeof obj.description !== "string" || !obj.description.trim()) continue;
        valid.push({
          ...(typeof obj.id === "string" && obj.id.trim() ? { id: obj.id.trim() } : {}),
          description: obj.description.trim(),
          ...(typeof obj.required === "boolean" ? { required: obj.required } : {}),
          ...(typeof obj.command === "string" && obj.command.trim() ? { command: obj.command.trim() } : {}),
        });
      }
      if (valid.length > 0) {
        criteriaPaths.add(resolveSafePath(rootDir, `${itemRel}/criteria.json`));
        return valid;
      }
      return undefined;
    } catch {
      return undefined;
    }
  };

  let specMarkdown = latestReq.specMarkdown;
  let designMarkdown = latestReq.designMarkdown;
  let criteria = parseCriteriaFile(base);

  if (codeRoot !== base) {
    if (latestReq.specMarkdown === preSpecMarkdown) {
      const mirrorSpec = readOpt(codeRoot, `${itemRel}/spec.md`, MAX_SPEC_BYTES);
      if (mirrorSpec !== null && mirrorSpec !== preSpecMarkdown) specMarkdown = mirrorSpec;
    }
    if (latestReq.designMarkdown === preDesignMarkdown) {
      const mirrorDesign = readOpt(codeRoot, `${itemRel}/design.md`, MAX_DESIGN_BYTES);
      if (mirrorDesign !== null && mirrorDesign !== preDesignMarkdown) designMarkdown = mirrorDesign;
    }
    const mirrorCriteria = parseCriteriaFile(codeRoot);
    if (!criteria && mirrorCriteria) criteria = mirrorCriteria;
  }

  const sanitizedSpec = validateMarkdownContent(specMarkdown, "spec", true);
  const sanitizedDesign = validateMarkdownContent(designMarkdown, "design", true);
  if (!sanitizedDesign.trim()) return null;

  // Prefer inline ```workbench-criteria block inside design.md, falling back to criteria.json.
  const inlineCriteria = extractInlineCriteriaFromDesign(sanitizedDesign);
  const resolvedCriteria = inlineCriteria ?? criteria;

  // Avoid duplicate propose() if the agent already called `wb propose` and hashes on disk match state.json.
  const candidateCriteria = resolvedCriteria ? normalizeCriteria(resolvedCriteria) : latestReq.state.criteria;
  const candidateSpecHash = computeSpecHash(sanitizedSpec, candidateCriteria);
  const candidateDesignHash = computeDesignHash(sanitizedDesign);
  const hashesAlreadyMatch =
    candidateSpecHash === latestReq.state.specHash &&
    candidateDesignHash === latestReq.state.designHash &&
    latestReq.state.designVersion > 0;
  if (hashesAlreadyMatch) {
    return null;
  }

  const changedFromBaseline =
    sanitizedSpec !== preSpecMarkdown ||
    sanitizedDesign !== preDesignMarkdown ||
    resolvedCriteria !== undefined ||
    latestReq.state.designHash !== candidateDesignHash;
  if (!changedFromBaseline) {
    return null;
  }

  return {
    specMarkdown: sanitizedSpec,
    designMarkdown: sanitizedDesign,
    ...(resolvedCriteria ? { criteria: resolvedCriteria } : {}),
    criteriaPaths: [...criteriaPaths],
  };
}

/**
 * Syncs file-native design edits (spec.md, design.md, inline ```workbench-criteria) into state.json
 * without duplicating propose() when the agent already submitted via CLI/MCP.
 */
export async function syncDesignRunResult(input: {
  base: string;
  codeRoot: string;
  id: string;
  latestReq: RequirementDetail;
  preSpecMarkdown: string;
  preDesignMarkdown: string;
  codeChanged: boolean;
  projectContext: ProjectContextSummary;
  snapshotFingerprint: string | null;
  appendNote: (line: string) => void;
}): Promise<RequirementDetail> {
  let latestReq = input.latestReq;
  if (input.codeChanged) {
    input.appendNote("[workbench] ⚠ 提示：设计阶段检测到代码工作区有改动，请确认是否误改了业务源码。\n");
  }
  try {
    const diskDesign = readDiskDesignCandidate(
      input.base,
      input.codeRoot,
      input.id,
      latestReq,
      input.preSpecMarkdown,
      input.preDesignMarkdown,
    );
    if (diskDesign) {
      let criteriaToSet = diskDesign.criteria;
      if (!criteriaToSet && latestReq.state.criteria.length === 0) {
        const fallbackCmd = input.projectContext.fullCommand ?? input.projectContext.fastCommand;
        if (fallbackCmd) {
          criteriaToSet = [
            {
              id: "AC-1",
              description: "项目自动化验证通过",
              required: true,
              command: fallbackCmd,
            },
          ];
        }
      }
      latestReq = await propose(input.base, input.id, {
        specMarkdown: diskDesign.specMarkdown,
        designMarkdown: diskDesign.designMarkdown,
        ...(criteriaToSet ? { criteria: criteriaToSet } : {}),
        actor: "agent",
        currentCodeSnapshotHash: input.snapshotFingerprint,
      });
      for (const criteriaFilePath of diskDesign.criteriaPaths) {
        try {
          if (fs.existsSync(criteriaFilePath)) fs.unlinkSync(criteriaFilePath);
        } catch {
          // Ignore cleanup failure for consumed criteria.json.
        }
      }
      input.appendNote("[workbench] 已自动同步磁盘规范/方案文件并提交人类审阅。\n");
    }
  } catch (err) {
    input.appendNote(
      `[workbench] 同步磁盘方案文件失败：${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  return latestReq;
}

/**
 * Runs deterministic post-coding verification (fast-before-heavy with failFast) whenever required
 * command criteria are not yet passing on the current snapshot, captures UI screenshots on pass,
 * and signals whether auto-heal should run.
 */
export async function runCodingPostGate(input: {
  base: string;
  codeRoot: string;
  id: string;
  latestReq: RequirementDetail;
  snap: Awaited<ReturnType<typeof observeGitSnapshot>>;
  appendNote: (line: string) => void;
}): Promise<{
  latestReq: RequirementDetail;
  snap: Awaited<ReturnType<typeof observeGitSnapshot>>;
  autoHealPending: boolean;
  readyForReview: boolean;
}> {
  let latestReq = input.latestReq;
  let snap = input.snap;
  let autoHealPending = false;
  let readyForReview = false;

  if (latestReq.state.stage !== "coding" || !latestReq.validity.approval.valid) {
    return { latestReq, snap, autoHealPending, readyForReview };
  }

  const requiredCmdItems = latestReq.validity.coverage.items.filter(
    (item) => item.criterion.required && Boolean(item.criterion.command?.trim()),
  );
  const hasPendingCmdVerification = requiredCmdItems.some((item) => item.state !== "passed");

  try {
    if (hasPendingCmdVerification) {
      input.appendNote("\n[workbench] Agent 已完成修改，正在自动执行必需验收命令...\n");
      await runAllVerifications(input.base, input.id, { failFast: true });
      snap = await observeGitSnapshot(input.codeRoot);
      latestReq = getRequirement(input.base, input.id, { currentCodeSnapshotHash: snap?.fingerprint ?? null });
    }

    const updatedRequiredCmdItems = latestReq.validity.coverage.items.filter(
      (item) => item.criterion.required && Boolean(item.criterion.command?.trim()),
    );
    const hasFailedCommandVerification = updatedRequiredCmdItems.some((item) => item.state === "failed");
    const allCommandCriteriaPassed =
      updatedRequiredCmdItems.length > 0 && updatedRequiredCmdItems.every((item) => item.state === "passed");

    if (latestReq.validity.acceptanceGate.ok) {
      readyForReview = true;
      // Opt-in best-effort auto-screenshot capture for UI-related requirements when verification passes.
      const projStatus = getProjectStatus(input.base);
      const wantsAutoScreenshots = projStatus.project?.verification?.autoScreenshots === true;
      if (wantsAutoScreenshots && (await isUiRelatedRequirement(latestReq.state, input.codeRoot))) {
        try {
          const shotResult = await captureRequirementScreenshots(input.base, input.id, {
            trigger: "auto_submit",
            actor: "system",
          });
          if (shotResult.status === "captured" && shotResult.batch) {
            input.appendNote(`[workbench] 已自动采集 ${shotResult.batch.shots.length} 张 UI 验收截图。\n`);
            latestReq = getRequirement(input.base, input.id, { currentCodeSnapshotHash: snap?.fingerprint ?? null });
          }
        } catch {
          // Screenshot capture is strictly best-effort and must never block verification or review.
        }
      }
      input.appendNote("[workbench] 全部必需验收条件已通过，已就绪待审查与人工验收。\n");
    } else if (allCommandCriteriaPassed && !hasFailedCommandVerification) {
      input.appendNote(
        `[workbench] 全部自动化验收命令通过，待人工确认非命令条件：${latestReq.validity.acceptanceGate.blockers.join("；")}\n`,
      );
    } else if (hasFailedCommandVerification) {
      input.appendNote(
        `[workbench] 自动验收未通过：${latestReq.validity.acceptanceGate.blockers.join("；")}\n`,
      );
      autoHealPending = true;
    } else if (hasPendingCmdVerification) {
      input.appendNote(
        `[workbench] 自动验收未就绪：${latestReq.validity.acceptanceGate.blockers.join("；")}\n`,
      );
    }
  } catch (err) {
    input.appendNote(
      `[workbench] 自动验收执行异常：${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  return { latestReq, snap, autoHealPending, readyForReview };
}
