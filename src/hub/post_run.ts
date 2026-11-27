import * as fs from "node:fs";
import type { ProjectContextSummary } from "../core/context.ts";
import {
  extractInlineCriteriaFromDesign,
  extractInlineDecisionsFromDesign,
  getProjectStatus,
  getRequirement,
  getVerificationEvidence,
  isUiRelatedRequirement,
  propose,
} from "../core/engine.ts";
import { readBoundedText, resolveSafePath } from "../core/fs.ts";
import { observeGitChanges, observeGitSnapshot } from "../core/git.ts";
import { isHeavyVerificationCommand, runAllVerifications } from "../core/runner.ts";
import { captureRequirementScreenshots } from "../core/screenshots.ts";
import {
  MAX_DESIGN_BYTES,
  MAX_SPEC_BYTES,
  WORKBENCH_DIR,
  type AgentAction,
  type Criterion,
  type CriterionInput,
  type DecisionItem,
  type RequirementDetail,
  type ReviewFinding,
  type ReviewVerdict,
} from "../core/types.ts";
import { normalizeCriteria, sanitizeOutput, validateMarkdownContent } from "../core/validate.ts";
import {
  computeDesignHash,
  computeSpecHash,
  isEnvironmentVerificationFailure,
  isManualCriterion,
} from "../core/validity.ts";

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

const MANUAL_UNVERIFIED_RE =
  /(人工验收|人工核验|人工确认|尚未完成|未核验|未勾选|manual.*(?:accept|verif|check|sign[- ]?off)|unverified.*manual|not yet (?:manually )?verified)/i;

/**
 * Prevents reviewers from falsely blocking a coding review solely because human-only
 * `kind: "manual"` criteria are still `unverified` prior to human acceptance.
 */
export function normalizeReviewVerdictForManualCriteria(
  parsed: ParsedReviewOutput,
  criteria: Criterion[],
): ParsedReviewOutput {
  const manualIds = new Set(criteria.filter((c) => isManualCriterion(c)).map((c) => c.id));
  if (manualIds.size === 0 || !parsed.findings || parsed.findings.length === 0) {
    return parsed;
  }

  let anyDowngraded = false;
  const updatedFindings = parsed.findings.map((finding) => {
    const cids = finding.criterionIds ?? [];
    const referencesOnlyManual = cids.length > 0 && cids.every((cid) => manualIds.has(cid));
    if (!referencesOnlyManual) return finding;
    const text = `${finding.title} ${finding.detail ?? ""}`;
    if (!MANUAL_UNVERIFIED_RE.test(text)) return finding;
    if (finding.severity !== "low") {
      anyDowngraded = true;
      return { ...finding, severity: "low" as const };
    }
    return finding;
  });

  if (!anyDowngraded) return parsed;

  let verdict = parsed.verdict;
  if (verdict === "block") {
    const hasHigh = updatedFindings.some((f) => f.severity === "high");
    if (!hasHigh) {
      const hasMedium = updatedFindings.some((f) => f.severity === "medium");
      verdict = hasMedium ? "concern" : "pass";
    }
  }
  return {
    ...parsed,
    verdict,
    findings: updatedFindings,
  };
}

function normalizeRelPath(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Classifies heavy verification failures where every failing test file is an untouched
 * file that timed out without assertion mismatches, so auto-heal does not mutate unrelated tests.
 */
export function classifyUnrelatedTimeoutFailure(
  log: string,
  changedFilePaths: string[],
): { unrelatedTimeoutOnly: boolean; failedFiles: string[] } {
  const changedSet = new Set(changedFilePaths.map(normalizeRelPath).filter(Boolean));
  if (changedSet.size === 0) return { unrelatedTimeoutOnly: false, failedFiles: [] };

  const markerIdx = log.indexOf("=== Failed Test File Outputs ===");
  const scope = markerIdx !== -1 ? log.slice(markerIdx) : log;
  const headerRe = /^---\s+(.+?)\s+\(exit\s+\d+\)\s+---$/gm;
  const headers: Array<{ file: string; start: number; bodyStart: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(scope)) !== null) {
    headers.push({
      file: normalizeRelPath(match[1]!),
      start: match.index,
      bodyStart: match.index + match[0].length,
    });
  }
  if (headers.length === 0) return { unrelatedTimeoutOnly: false, failedFiles: [] };

  const failedFiles: string[] = [];
  for (let i = 0; i < headers.length; i++) {
    const cur = headers[i]!;
    const end = i + 1 < headers.length ? headers[i + 1]!.start : scope.length;
    const section = scope.slice(cur.bodyStart, end);
    if (changedSet.has(cur.file)) {
      return { unrelatedTimeoutOnly: false, failedFiles: [] };
    }
    const hasTimeout = /TimeoutError:|timed out after \d+ms/i.test(section);
    const hasAssertionMismatch = /expect\(received\)/i.test(section);
    if (!hasTimeout || hasAssertionMismatch) {
      return { unrelatedTimeoutOnly: false, failedFiles: [] };
    }
    if (!failedFiles.includes(cur.file)) {
      failedFiles.push(cur.file);
    }
  }
  return { unrelatedTimeoutOnly: failedFiles.length > 0, failedFiles };
}

function readDiskDesignCandidate(
  base: string,
  codeRoot: string,
  id: string,
  latestReq: RequirementDetail,
  preSpecMarkdown: string,
  preDesignMarkdown: string,
): {
  specMarkdown: string;
  designMarkdown: string;
  criteria?: CriterionInput[];
  decisions?: DecisionItem[];
  criteriaPaths: string[];
} | null {
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
        const rawKind = obj.kind === "manual" || obj.type === "manual" || obj.manual === true ? "manual" : undefined;
        valid.push({
          ...(typeof obj.id === "string" && obj.id.trim() ? { id: obj.id.trim() } : {}),
          description: obj.description.trim(),
          ...(rawKind ? { kind: rawKind } : {}),
          ...(typeof obj.required === "boolean" ? { required: obj.required } : {}),
          ...(rawKind !== "manual" && typeof obj.command === "string" && obj.command.trim() ? { command: obj.command.trim() } : {}),
          ...(typeof obj.steps === "string" && obj.steps.trim() ? { steps: obj.steps.trim() } : {}),
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
  const inlineDecisions = extractInlineDecisionsFromDesign(sanitizedDesign);
  const resolvedCriteria = inlineCriteria ?? criteria;

  // Avoid duplicate propose() if the agent already called `wb propose` and hashes on disk match state.json.
  const candidateCriteria = resolvedCriteria ? normalizeCriteria(resolvedCriteria) : latestReq.state.criteria;
  const candidateSpecHash = computeSpecHash(sanitizedSpec, candidateCriteria);
  const candidateDesignHash = computeDesignHash(sanitizedDesign);
  const hashesAlreadyMatch =
    candidateSpecHash === latestReq.state.specHash &&
    candidateDesignHash === latestReq.state.designHash &&
    latestReq.state.designVersion > 0 &&
    Boolean(inlineDecisions?.length) === Boolean(latestReq.state.pendingDecisions?.length);
  if (hashesAlreadyMatch) {
    return null;
  }

  const changedFromBaseline =
    sanitizedSpec !== preSpecMarkdown ||
    sanitizedDesign !== preDesignMarkdown ||
    resolvedCriteria !== undefined ||
    inlineDecisions !== null ||
    latestReq.state.designHash !== candidateDesignHash;
  if (!changedFromBaseline) {
    return null;
  }

  return {
    specMarkdown: sanitizedSpec,
    designMarkdown: sanitizedDesign,
    ...(resolvedCriteria ? { criteria: resolvedCriteria } : {}),
    ...(inlineDecisions ? { decisions: inlineDecisions } : {}),
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
      const hasPendingDecisions = Boolean(diskDesign.decisions && diskDesign.decisions.length > 0);
      // FLOW §1.2 / WB-18: when first design proposes pending decisions without criteria, defer criteria until resolved.
      if (!criteriaToSet && !hasPendingDecisions && latestReq.state.criteria.length === 0) {
        const fallbackCmd = input.projectContext.fullCommand ?? input.projectContext.fastCommand;
        if (fallbackCmd) {
          criteriaToSet = [
            {
              id: "AC-1",
              description: "项目自动化验证通过",
              required: true,
              command: fallbackCmd,
              systemInjected: true,
            },
          ];
        }
      }
      latestReq = await propose(input.base, input.id, {
        specMarkdown: diskDesign.specMarkdown,
        designMarkdown: diskDesign.designMarkdown,
        ...(criteriaToSet ? { criteria: criteriaToSet } : {}),
        ...(diskDesign.decisions ? { decisions: diskDesign.decisions } : {}),
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
 * applies zero-change and environment-failure guards, and signals whether auto-heal / auto-review should run.
 */
export async function runCodingPostGate(input: {
  base: string;
  codeRoot: string;
  id: string;
  action?: AgentAction;
  codeChanged?: boolean;
  lockLeaseId?: string;
  latestReq: RequirementDetail;
  snap: Awaited<ReturnType<typeof observeGitSnapshot>>;
  appendNote: (line: string) => void;
}): Promise<{
  latestReq: RequirementDetail;
  snap: Awaited<ReturnType<typeof observeGitSnapshot>>;
  autoHealPending: boolean;
  readyForReview: boolean;
  noCodeChange: boolean;
  environmentFailure: boolean;
  unrelatedTimeoutFiles?: string[];
}> {
  let latestReq = input.latestReq;
  let snap = input.snap;
  let autoHealPending = false;
  let readyForReview = false;
  let noCodeChange = false;
  let environmentFailure = false;
  let unrelatedTimeoutFiles: string[] | undefined;

  if (latestReq.state.stage !== "coding" || !latestReq.validity.approval.valid) {
    return { latestReq, snap, autoHealPending, readyForReview, noCodeChange, environmentFailure };
  }

  // Zero-change hard guard (WB-16 / FLOW §2.4): if an `implement` run produced zero changes relative to baseline,
  // refuse to auto-mark as ready for acceptance/review and hand back to human inspection.
  const baselineFp = latestReq.state.baseline?.fingerprint ?? null;
  if (
    input.action === "implement" &&
    baselineFp &&
    snap?.fingerprint === baselineFp
  ) {
    noCodeChange = true;
    input.appendNote(
      "\n[workbench] ⚠ 编码运行正常结束，但相对基线未产出任何代码改动，已暂停自动推进待验收/审查，请人工核查（如确认无需改动可直接人工确认关闭）。\n",
    );
    return { latestReq, snap, autoHealPending, readyForReview, noCodeChange, environmentFailure };
  }

  const requiredCmdItems = latestReq.validity.coverage.items.filter(
    (item) => item.criterion.required && Boolean(item.criterion.command?.trim()),
  );
  const hasPendingCmdVerification = requiredCmdItems.some((item) => item.state !== "passed");

  try {
    if (hasPendingCmdVerification) {
      input.appendNote("\n[workbench] Agent 已完成修改，正在自动执行必需验收命令...\n");
      await runAllVerifications(input.base, input.id, {
        failFast: true,
        lockLeaseId: input.lockLeaseId,
        onProgress: input.appendNote,
      });
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
      // FLOW §3.2 / WB-14: trigger heterogeneous review as soon as all automated command criteria pass,
      // without waiting for human manual checkboxes.
      readyForReview = true;
      input.appendNote(
        `[workbench] 全部自动化验收命令通过，已就绪触发审查（待人工核验非命令条件：${latestReq.validity.acceptanceGate.blockers.join("；")}）。\n`,
      );
    } else if (hasFailedCommandVerification) {
      const failedCriterionIds = new Set(
        updatedRequiredCmdItems.filter((item) => item.state === "failed").map((item) => item.criterion.id),
      );
      const latestFailedByCriterion = Array.from(failedCriterionIds)
        .map((cid) =>
          [...latestReq.validity.verifications]
            .reverse()
            .find((v) => v.effectiveState === "failed" && v.record.criterionIds.includes(cid)),
        )
        .filter((v): v is NonNullable<typeof v> => Boolean(v));
      const allEnvFailure =
        latestFailedByCriterion.length > 0 &&
        latestFailedByCriterion.every((v) => isEnvironmentVerificationFailure(v.record));
      if (allEnvFailure) {
        environmentFailure = true;
        autoHealPending = false;
        input.appendNote(
          "[workbench] ⚠ 检测到验证失败属于环境/基础设施故障（命令不存在或执行超时），已跳过自动修复，请人工排查环境后重跑验证。\n",
        );
      } else {
        const allHeavy =
          latestFailedByCriterion.length > 0 &&
          latestFailedByCriterion.every((v) => isHeavyVerificationCommand(v.record.command));
        let detectedUnrelatedTimeout: string[] | null = null;
        if (allHeavy) {
          try {
            const gitObs = await observeGitChanges(input.codeRoot, {
              sinceHead: latestReq.state.baseline?.head ?? null,
              maxDiffBytes: 32 * 1024,
            });
            const changedPaths = gitObs.files.map((f) => f.path);
            if (changedPaths.length > 0) {
              const collectedFiles: string[] = [];
              let allMatch = true;
              for (const ev of latestFailedByCriterion) {
                let fullLog = ev.record.outputPreview ?? "";
                try {
                  const loaded = getVerificationEvidence(input.base, input.id, ev.record.id);
                  if (loaded.log) fullLog = loaded.log;
                } catch {
                  // Fallback to preview.
                }
                const classified = classifyUnrelatedTimeoutFailure(fullLog, changedPaths);
                if (!classified.unrelatedTimeoutOnly) {
                  allMatch = false;
                  break;
                }
                for (const ff of classified.failedFiles) {
                  if (!collectedFiles.includes(ff)) collectedFiles.push(ff);
                }
              }
              if (allMatch && collectedFiles.length > 0) {
                detectedUnrelatedTimeout = collectedFiles;
              }
            }
          } catch {
            // Best-effort classification; fall through to normal auto-heal on inspection error.
          }
        }

        if (detectedUnrelatedTimeout) {
          environmentFailure = true;
          autoHealPending = false;
          unrelatedTimeoutFiles = detectedUnrelatedTimeout;
          input.appendNote(
            `[workbench] ⚠ 检测到全量测试失败仅来自无关测试文件的超时波动（${detectedUnrelatedTimeout.join("、")}），已跳过自动修复以避免越界修改无关文件，请核查环境或重跑验证。\n`,
          );
        } else {
          input.appendNote(
            `[workbench] 自动验收未通过：${latestReq.validity.acceptanceGate.blockers.join("；")}\n`,
          );
          autoHealPending = true;
        }
      }
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

  return {
    latestReq,
    snap,
    autoHealPending,
    readyForReview,
    noCodeChange,
    environmentFailure,
    ...(unrelatedTimeoutFiles ? { unrelatedTimeoutFiles } : {}),
  };
}
