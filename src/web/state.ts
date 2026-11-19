import type {
  AgentAction,
  AttachmentMeta,
  CriterionCoverageState,
  EffectiveVerificationState,
  GitRemoteProvider,
  OutputLanguage,
  PrivacyMode,
  RequirementDetail,
  RequirementDiffView,
  RequirementSummary,
  ReviewReport,
  ReviewVerdict,
  Stage,
  TaskStatus,
  ValidityReport,
} from "../core/types.ts";
import type { PainPointCategory } from "../hub/evolution.ts";
import { REASONING_EFFORTS, type DiscoveredModel, type HarnessId, type HarnessInfo, type ModelTarget, type ReasoningEffort, type RoutingConfig } from "../hub/types.ts";
import type { BridgeStatus } from "../server/index.ts";
import type { BrowseResponse, GiteeIssueListItem } from "./api.ts";
import {
  formatDateTime as formatDateTimeIn,
  formatRelativeTime,
  formatNumber,
  pluralMessage,
  t,
  translateRef,
  type MessageKey,
  type MessageParams,
  type UiLanguage,
} from "./i18n.ts";

export type Scope = "active" | "done" | "cancelled" | "all";
export type LayoutMode = "list" | "board";
export type WorkspaceTab = "spec" | "changes" | "timeline";
export type DrawerTab = "discuss" | "console";

export interface CriterionDraft {
  id: string;
  description: string;
  required: boolean;
  command: string;
}

export interface PendingAnnotation {
  id: string;
  anchor: string;
  message: string;
}

export type ModalState =
  | null
  | {
      kind: "new_req";
      goal: string;
      mode?: "create" | "import_issue";
      issueRef?: string;
      giteeFilter?: "assigned" | "created" | "all";
      giteeState?: "active" | "open" | "progressing" | "closed" | "all";
      giteeSearch?: string;
      selectedGiteeIssue?: GiteeIssueListItem | null;
      createGitHubIssue?: boolean;
      attachments?: AttachmentMeta[];
    }
  | { kind: "feedback"; feedback: string; dispatchAgent: boolean }
  | {
      kind: "accept_override";
      verdict: ReviewVerdict | "stale" | "missing";
      summary: string;
      reason: string;
      acceptedRisks: string[];
    }
  | { kind: "lifecycle"; action: "block" | "cancel" | "reopen"; reason: string }
  | {
      kind: "prompt_fallback";
      titleKey: MessageKey;
      titleParams?: MessageParams;
      subtitleKey: MessageKey;
      subtitleParams?: MessageParams;
      prompt: string;
    }
  | {
      kind: "add_project";
      nodeId: string;
      browse: BrowseResponse | null;
      pathInput: string;
      nameInput: string;
      initPrivacy: PrivacyMode | "none";
      showNodeHelp?: boolean;
    }
  | {
      kind: "routing";
      tab?: "global" | "project";
      draft: RoutingConfig | null;
      hubLangDraft?: OutputLanguage;
      giteeTokenDraft?: string;
      clearGiteeToken?: boolean;
      projLangDraft?: OutputLanguage | "inherit";
      projProviderDraft?: GitRemoteProvider;
      ghRepoDraft?: string;
      ghBaseBranchDraft?: string;
      ghAutoCreateDraft?: boolean;
      ghAutoSyncDraft?: boolean;
      giteeRepoDraft?: string;
      giteeEnterpriseDraft?: string;
      giteeBaseBranchDraft?: string;
    }
  | { kind: "annotate_anchor"; anchor: string; message: string; mode: "ask" | "refine" }
  | { kind: "handoff_preview"; markdown: string }
  | {
      kind: "quick_report";
      title: string;
      detail: string;
      category: PainPointCategory;
      domSelector: string;
      pickingElement: boolean;
      autoPromote: boolean;
      createGitHubIssue?: boolean;
      attachments?: AttachmentMeta[];
    }
  | { kind: "evolution"; tab: "inbox" | "playbook" | "telemetry"; playbookDraft: string | null }
  | {
      kind: "deliver";
      commitMessage: string;
      selectedFiles: string[];
      note: string;
      createPr?: boolean;
      branchName?: string;
      baseBranch?: string;
      prTitle?: string;
    }
  | {
      kind: "link_issue";
      requirementId: string;
      provider?: GitRemoteProvider;
      mode: "create" | "link";
      issueRef: string;
    }
  | { kind: "debug_info"; text: string };

export interface StatusMeta {
  labels: Record<UiLanguage, string>;
  tone: string;
}

export const STAGE_META: Record<Stage, StatusMeta> = {
  draft: { labels: { "zh-CN": "草稿", en: "Draft" }, tone: "neutral" },
  designing: { labels: { "zh-CN": "整理方案中", en: "Designing" }, tone: "info" },
  awaiting_approval: { labels: { "zh-CN": "待批准", en: "Awaiting approval" }, tone: "warning" },
  implementing: { labels: { "zh-CN": "实施中", en: "Implementing" }, tone: "info" },
  awaiting_acceptance: { labels: { "zh-CN": "待验收", en: "Awaiting acceptance" }, tone: "success" },
  done: { labels: { "zh-CN": "已完成", en: "Done" }, tone: "success" },
  blocked: { labels: { "zh-CN": "已阻塞", en: "Blocked" }, tone: "danger" },
  cancelled: { labels: { "zh-CN": "已取消", en: "Cancelled" }, tone: "neutral" },
};

export const TASK_META: Record<TaskStatus, StatusMeta> = {
  pending: { labels: { "zh-CN": "待开始", en: "Pending" }, tone: "neutral" },
  in_progress: { labels: { "zh-CN": "进行中", en: "In progress" }, tone: "info" },
  done: { labels: { "zh-CN": "已完成", en: "Done" }, tone: "success" },
  blocked: { labels: { "zh-CN": "受阻", en: "Blocked" }, tone: "danger" },
};

export const COVERAGE_META: Record<CriterionCoverageState, StatusMeta> = {
  passed: { labels: { "zh-CN": "通过", en: "Passed" }, tone: "success" },
  failed: { labels: { "zh-CN": "失败", en: "Failed" }, tone: "danger" },
  stale: { labels: { "zh-CN": "需重跑", en: "Needs rerun" }, tone: "warning" },
  unverified: { labels: { "zh-CN": "未验证", en: "Unverified" }, tone: "neutral" },
  unavailable: { labels: { "zh-CN": "证据不可用", en: "Evidence unavailable" }, tone: "warning" },
};

export interface EvidenceDisplaySummary {
  isHistorical: boolean;
  tone: "success" | "warning" | "info";
  title: string;
  acceptedAtText: string | null;
  provenanceText: string;
  unavailableReason: string | null;
  truncationFlags: string[];
  scopeNote: string | null;
}

/** Formats shared accepted/legacy/live evidence provenance consistently for UI rendering & tests. */
export function describeEvidenceContext(
  validity: ValidityReport,
  diffView?: Pick<
    RequirementDiffView,
    | "context"
    | "status"
    | "reason"
    | "reasonKey"
    | "reasonParams"
    | "acceptedAt"
    | "snapshotId"
    | "scopeNote"
    | "scopeNoteKey"
    | "observation"
  > | null,
  language: UiLanguage = "zh-CN",
): EvidenceDisplaySummary {
  const p = validity.provenance;
  const acceptedAt = diffView?.acceptedAt ?? p.acceptedAt;
  const acceptedAtText = acceptedAt ? formatDateTimeIn(language, acceptedAt) : null;
  const obs = diffView?.observation ?? null;
  const truncationFlags: string[] = [];
  if (obs?.diffTruncated || p.diffTruncated) truncationFlags.push(t(language, "evidence.trunc.diff"));
  if ((obs?.binaryFiles?.length ?? 0) > 0) {
    truncationFlags.push(
      pluralMessage(language, obs!.binaryFiles.length, "evidence.trunc.binaryOne", "evidence.trunc.binaryOther", {
        count: formatNumber(language, obs!.binaryFiles.length),
      }),
    );
  }
  if ((obs?.omittedFiles?.length ?? 0) > 0) {
    truncationFlags.push(
      pluralMessage(language, obs!.omittedFiles.length, "evidence.trunc.omittedOne", "evidence.trunc.omittedOther", {
        count: formatNumber(language, obs!.omittedFiles.length),
      }),
    );
  }
  const scopeNote =
    p.scopeNoteKey || diffView?.scopeNoteKey
      ? t(language, (p.scopeNoteKey ?? diffView?.scopeNoteKey) as MessageKey)
      : (diffView?.scopeNote ?? p.scopeNote);

  const resolveEvidenceReason = (): string | null => {
    if (diffView?.reasonKey) {
      return localizedReason(diffView.reasonKey, diffView.reason ?? p.reason ?? null, language, diffView.reasonParams);
    }
    if (diffView?.status === "unavailable" && diffView.reason) {
      return localizedReason(undefined, diffView.reason, language, undefined);
    }
    return localizedReason(p.reasonKey, p.reason ?? diffView?.reason ?? null, language, p.reasonParams);
  };

  if (p.context === "accepted") {
    const shortSpec = p.specHash ? p.specHash.slice(0, 8) : "-";
    const shortSnap = p.codeSnapshotHash ? p.codeSnapshotHash.slice(0, 8) : "-";
    return {
      isHistorical: true,
      tone: "success",
      title: t(language, "evidence.title.accepted"),
      acceptedAtText,
      provenanceText: t(language, "evidence.provenance.accepted", {
        snapshot: p.snapshotId ?? "-",
        spec: shortSpec,
        code: shortSnap,
        count: formatNumber(language, p.verificationIds.length),
      }),
      unavailableReason: diffView?.status === "unavailable" ? resolveEvidenceReason() : null,
      truncationFlags,
      scopeNote,
    };
  }

  if (p.context === "legacy-unavailable") {
    const shortSpec = p.specHash ? p.specHash.slice(0, 8) : "-";
    const shortSnap = p.codeSnapshotHash ? p.codeSnapshotHash.slice(0, 8) : "-";
    const reason = resolveEvidenceReason();
    const coverageSuffix = p.coverageReasonKey
      ? `${language === "en" ? "; " : "；"}${t(language, p.coverageReasonKey as MessageKey)}`
      : "";
    const unavailableReason = diffView?.status === "unavailable" || p.context === "legacy-unavailable"
      ? reason
        ? `${reason}${coverageSuffix}`
        : t(language, "evidence.unavailable.legacy")
      : null;
    return {
      isHistorical: true,
      tone: "warning",
      title:
        p.artifactStatus === "corrupt" || p.artifactStatus === "missing"
          ? t(language, "evidence.title.missing")
          : t(language, "evidence.title.legacy"),
      acceptedAtText,
      provenanceText: t(language, "evidence.provenance.legacy", {
        spec: shortSpec,
        code: shortSnap,
        count: formatNumber(language, p.verificationIds.length),
        source: p.coverageSource,
      }),
      unavailableReason,
      truncationFlags,
      scopeNote: null,
    };
  }

  return {
    isHistorical: false,
    tone: "info",
    title: t(language, "evidence.title.live"),
    acceptedAtText: null,
    provenanceText: t(language, "evidence.provenance.live", {
      spec: p.specHash?.slice(0, 8) ?? "-",
      code: p.codeSnapshotHash?.slice(0, 8) ?? (language === "en" ? "unknown" : "未知"),
    }),
    unavailableReason: diffView?.status === "unavailable" ? resolveEvidenceReason() : null,
    truncationFlags,
    scopeNote,
  };
}

function localizedReason(
  key: string | undefined | null,
  raw: string | null,
  language: UiLanguage,
  params?: MessageParams,
): string | null {
  const translated = translateRef(language, key, raw ?? "", params);
  if (translated) return translated;
  return language === "en" ? "Reason unavailable" : "原因不可用";
}

export const EVIDENCE_META: Record<EffectiveVerificationState, StatusMeta> = {
  passed: { labels: { "zh-CN": "当前有效通过", en: "Currently valid & passed" }, tone: "success" },
  failed: { labels: { "zh-CN": "验证失败", en: "Verification failed" }, tone: "danger" },
  stale: { labels: { "zh-CN": "已过期（代码/规范已变）", en: "Expired (code/spec changed)" }, tone: "warning" },
  unknown: { labels: { "zh-CN": "快照缺失", en: "Snapshot missing" }, tone: "warning" },
};

export const VERDICT_META: Record<ReviewVerdict, StatusMeta> = {
  pass: { labels: { "zh-CN": "建议通过", en: "Recommend pass" }, tone: "success" },
  concern: { labels: { "zh-CN": "存在关注点", en: "Concerns" }, tone: "warning" },
  block: { labels: { "zh-CN": "建议阻塞修改", en: "Recommend blocking changes" }, tone: "danger" },
};

export const EFFORT_LABEL_KEYS: Record<ReasoningEffort, MessageKey> = {
  minimal: "effort.minimal",
  low: "effort.low",
  medium: "effort.medium",
  high: "effort.high",
  xhigh: "effort.xhigh",
  max: "effort.max",
  ultra: "effort.ultra",
  auto: "effort.auto",
};

export function effortLabel(language: UiLanguage, effort: ReasoningEffort): string {
  return t(language, EFFORT_LABEL_KEYS[effort]);
}

export function initialTheme(): "light" | "dark" {
  if (typeof localStorage === "undefined") return "light";
  const saved = localStorage.getItem("wb-theme");
  if (saved === "light" || saved === "dark") return saved;
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function relativeTime(ms: number, language: UiLanguage = "zh-CN"): string {
  return formatRelativeTime(language, ms);
}

export function formatDateTime(ms: number, language: UiLanguage = "zh-CN"): string {
  return formatDateTimeIn(language, ms);
}

export function filteredItems(items: RequirementSummary[], query: string, language: UiLanguage = "zh-CN"): RequirementSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (item) =>
      item.id.toLowerCase().includes(q) ||
      item.title.toLowerCase().includes(q) ||
      item.progressText.toLowerCase().includes(q) ||
      progressDetail(item, language).toLowerCase().includes(q),
  );
}

/** 去除与阶段徽章重复的进度文本，仅保留增量信息。 */
export function progressDetail(item: RequirementSummary, language: UiLanguage = "zh-CN"): string {
  switch (item.stage) {
    case "draft":
    case "designing":
    case "done":
    case "cancelled":
      return "";
    case "awaiting_approval":
      return item.designVersion > 0
        ? t(language, "progress.designVersion", { version: item.designVersion })
        : t(language, "progress.specChanged");
    case "implementing": {
      const parts: string[] = [];
      if (item.tasksTotal > 0) {
        parts.push(t(language, "progress.implementingTasks", { done: item.tasksDone, total: item.tasksTotal }));
      }
      if (item.requiredTotal > 0) {
        parts.push(t(language, "progress.verify", { passed: item.requiredPassed, total: item.requiredTotal }));
      }
      return parts.join(" · ");
    }
    case "awaiting_acceptance":
      return t(language, "progress.verify", { passed: item.requiredPassed, total: item.requiredTotal });
    case "blocked":
      return item.blockedReason ?? "";
  }
}

export function defaultActionForRequirement(d: RequirementDetail): AgentAction {
  const act = d.validity.banner.primaryAction?.id;
  if (act === "dispatch_fix" || act === "dispatch_fix_review") return "fix";
  if (act === "dispatch_review") return "review";
  if (act === "dispatch_implement" || act === "approve_and_implement") return "implement";
  if (d.state.stage === "awaiting_acceptance" || d.validity.acceptanceGate.ok) return "review";
  if (d.state.stage === "implementing") return "implement";
  return "design";
}

export function formatReviewFixFeedback(report: ReviewReport, selectedFindingIds?: string[]): string {
  const lines: string[] = [
    `请根据跨模型 Code Review（${report.reviewerHarness}/${report.reviewerModel} · ${report.verdict}）的问题进行修复：`,
    `核心结论：${report.summary}`,
  ];
  const findings = report.findings ?? [];
  const chosen =
    selectedFindingIds && selectedFindingIds.length > 0
      ? findings.filter((f) => selectedFindingIds.includes(f.id))
      : findings;
  if (chosen.length > 0) {
    lines.push("", "待修复审查项：");
    for (const f of chosen) {
      const crit = f.criterionIds?.length ? ` [${f.criterionIds.join(", ")}]` : "";
      const files = f.files?.length ? ` (${f.files.join(", ")})` : "";
      lines.push(`- [${f.severity}] ${f.id} ${f.title}${crit}${files}`);
      if (f.suggestion) lines.push(`  修复建议：${f.suggestion}`);
    }
  } else if (report.markdown.trim()) {
    lines.push("", "审查详情摘要：", report.markdown.trim().slice(0, 1400));
  }
  return lines.join("\n").slice(0, 1950);
}

export function routedTargetForAction(routing: RoutingConfig | null, action: AgentAction): ModelTarget | null {
  if (!routing) return null;
  const stage = action === "ask" ? "design" : action;
  return routing.stages[stage]?.primary ?? null;
}

export function parseRunnerKey(key: string): { harness: string; model: string } | null {
  const sepIdx = key.indexOf("::");
  if (sepIdx <= 0) return null;
  const harness = key.slice(0, sepIdx);
  const model = key.slice(sepIdx + 2);
  return harness && model ? { harness, model } : null;
}

export function activeRunnerChoice(
  selectedRunnerKey: string,
  routing: RoutingConfig | null,
  action: AgentAction,
  selectedEffort?: ReasoningEffort | "",
): { harness?: string; model?: string; effort?: ReasoningEffort } {
  if (selectedRunnerKey && selectedRunnerKey !== "manual_copy") {
    const parsed = parseRunnerKey(selectedRunnerKey);
    if (parsed) {
      return { harness: parsed.harness, model: parsed.model, ...(selectedEffort ? { effort: selectedEffort } : {}) };
    }
  }
  const primary = routedTargetForAction(routing, action);
  const effort = selectedEffort || primary?.reasoningEffort;
  return primary ? { harness: primary.harness, model: primary.model, ...(effort ? { effort } : {}) } : {};
}

export interface ModelEffortCapability {
  mode: "configurable" | "locked" | "unsupported";
  efforts: ReasoningEffort[];
  defaultEffort?: ReasoningEffort;
}

export function getModelEffortCapability(
  harnesses: HarnessInfo[],
  harnessId?: string,
  modelId?: string,
): ModelEffortCapability {
  if (!harnessId || !modelId) {
    return { mode: "configurable", efforts: ["low", "medium", "high", "xhigh"] };
  }
  const h = harnesses.find((x) => x.id === harnessId);
  const exact = h?.models.find((x) => x.id === modelId);
  if (exact) {
    if (exact.effortLocked) {
      const lockedEff = exact.defaultEffort ?? exact.supportedEfforts?.[0];
      return {
        mode: "locked",
        efforts: lockedEff ? [lockedEff] : [],
        defaultEffort: lockedEff,
      };
    }
    if (exact.supportedEfforts !== undefined) {
      if (exact.supportedEfforts.length === 0) {
        return { mode: "unsupported", efforts: [] };
      }
      if (exact.supportedEfforts.length === 1) {
        return {
          mode: "locked",
          efforts: exact.supportedEfforts,
          defaultEffort: exact.defaultEffort ?? exact.supportedEfforts[0],
        };
      }
      return {
        mode: "configurable",
        efforts: exact.supportedEfforts,
        defaultEffort: exact.defaultEffort,
      };
    }
  } else if (h) {
    for (const candidate of h.models) {
      if (!candidate.effortVariants) continue;
      for (const [eff, variantId] of Object.entries(candidate.effortVariants) as Array<[ReasoningEffort, string]>) {
        if (variantId === modelId) {
          return {
            mode: "locked",
            efforts: [eff],
            defaultEffort: eff,
          };
        }
      }
    }
  }

  if (harnessId === "codex" || harnessId === "agy" || harnessId === "qodercn") {
    return { mode: "configurable", efforts: ["low", "medium", "high", "xhigh", "max"] };
  }
  if (harnessId === "omp") {
    return { mode: "configurable", efforts: ["minimal", "low", "medium", "high", "xhigh", "max", "auto"] };
  }
  if (harnessId === "opencode") {
    return { mode: "configurable", efforts: ["low", "medium", "high"] };
  }
  return { mode: "configurable", efforts: [...REASONING_EFFORTS] };
}

export function supportedEffortsForModel(
  harnesses: HarnessInfo[],
  harnessId?: string,
  modelId?: string,
): ReasoningEffort[] {
  return getModelEffortCapability(harnesses, harnessId, modelId).efforts;
}

export function collectModelOptions(
  harnesses: HarnessInfo[],
): Array<{
  key: string;
  label: string;
  harnessId: HarnessId;
  harnessLabel: string;
  modelId: string;
  displayLabel: string;
  tier: DiscoveredModel["tier"];
  provider?: string;
  intelligence?: number;
  isLegacy?: boolean;
}> {
  const opts: Array<{
    key: string;
    label: string;
    harnessId: HarnessId;
    harnessLabel: string;
    modelId: string;
    displayLabel: string;
    tier: DiscoveredModel["tier"];
    provider?: string;
    intelligence?: number;
    isLegacy?: boolean;
  }> = [];
  for (const h of harnesses) {
    if (!h.installed) continue;
    for (const m of h.models) {
      opts.push({
        key: `${h.id}::${m.id}`,
        label: `${h.label} · ${m.id}`,
        harnessId: h.id,
        harnessLabel: h.label,
        modelId: m.id,
        displayLabel: m.label ?? m.id,
        tier: m.tier,
        ...(m.provider ? { provider: m.provider } : {}),
        ...(typeof m.intelligence === "number" ? { intelligence: m.intelligence } : {}),
        ...(m.isLegacy ? { isLegacy: true } : {}),
      });
    }
  }
  return opts;
}

export function bridgeStatusLabel(bridge: BridgeStatus | undefined, language: UiLanguage = "zh-CN"): string {
  if (!bridge || !bridge.connected) return t(language, "bridge.mcp");
  if (bridge.state === "idle") return t(language, "bridge.idle");
  return bridge.state === "waiting_user" ? t(language, "bridge.waiting") : t(language, "bridge.running");
}
