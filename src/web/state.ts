import type {
  AgentAction,
  AttachmentMeta,
  CriterionCoverageState,
  EffectiveVerificationState,
  OutputLanguage,
  PrivacyMode,
  RequirementDetail,
  RequirementDiffView,
  RequirementSummary,
  ReviewVerdict,
  Stage,
  TaskStatus,
  ValidityReport,
} from "../core/types.ts";
import type { PainPointCategory } from "../hub/evolution.ts";
import { REASONING_EFFORTS, type DiscoveredModel, type HarnessId, type HarnessInfo, type ModelTarget, type ReasoningEffort, type RoutingConfig } from "../hub/types.ts";
import type { BridgeStatus } from "../server/index.ts";
import type { BrowseResponse } from "./api.ts";

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
      createGitHubIssue?: boolean;
      attachments?: AttachmentMeta[];
    }
  | { kind: "feedback"; feedback: string; dispatchAgent: boolean }
  | { kind: "lifecycle"; action: "block" | "cancel" | "reopen"; reason: string }
  | { kind: "prompt_fallback"; title: string; subtitle: string; prompt: string }
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
      projLangDraft?: OutputLanguage | "inherit";
      ghRepoDraft?: string;
      ghBaseBranchDraft?: string;
      ghAutoCreateDraft?: boolean;
      ghAutoSyncDraft?: boolean;
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
      mode: "create" | "link";
      issueRef: string;
    }
  | { kind: "debug_info"; text: string };

export const STAGE_META: Record<Stage, { label: string; tone: string }> = {
  draft: { label: "草稿", tone: "neutral" },
  designing: { label: "整理方案中", tone: "info" },
  awaiting_approval: { label: "待批准", tone: "warning" },
  implementing: { label: "实施中", tone: "info" },
  awaiting_acceptance: { label: "待验收", tone: "success" },
  done: { label: "已完成", tone: "success" },
  blocked: { label: "已阻塞", tone: "danger" },
  cancelled: { label: "已取消", tone: "neutral" },
};

export const TASK_META: Record<TaskStatus, { label: string; tone: string }> = {
  pending: { label: "待开始", tone: "neutral" },
  in_progress: { label: "进行中", tone: "info" },
  done: { label: "已完成", tone: "success" },
  blocked: { label: "受阻", tone: "danger" },
};

export const COVERAGE_META: Record<CriterionCoverageState, { label: string; tone: string }> = {
  passed: { label: "通过", tone: "success" },
  failed: { label: "失败", tone: "danger" },
  stale: { label: "需重跑", tone: "warning" },
  unverified: { label: "未验证", tone: "neutral" },
  unavailable: { label: "证据不可用", tone: "warning" },
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
  diffView?: Pick<RequirementDiffView, "context" | "status" | "reason" | "acceptedAt" | "snapshotId" | "scopeNote" | "observation"> | null,
): EvidenceDisplaySummary {
  const p = validity.provenance;
  const acceptedAt = diffView?.acceptedAt ?? p.acceptedAt;
  const acceptedAtText = acceptedAt ? formatDateTime(acceptedAt) : null;
  const obs = diffView?.observation ?? null;
  const truncationFlags: string[] = [];
  if (obs?.diffTruncated || p.diffTruncated) truncationFlags.push("Diff 内容已按上限截断");
  if ((obs?.binaryFiles?.length ?? 0) > 0) truncationFlags.push(`含 ${obs!.binaryFiles.length} 个二进制文件（未内联补丁）`);
  if ((obs?.omittedFiles?.length ?? 0) > 0) truncationFlags.push(`含 ${obs!.omittedFiles.length} 个超大未跟踪文件（内容已省略）`);

  if (p.context === "accepted") {
    const shortSpec = p.specHash ? p.specHash.slice(0, 8) : "-";
    const shortSnap = p.codeSnapshotHash ? p.codeSnapshotHash.slice(0, 8) : "-";
    return {
      isHistorical: true,
      tone: "success",
      title: "已固化验收快照",
      acceptedAtText,
      provenanceText: `快照 ${p.snapshotId ?? "-"} · 规范 ${shortSpec} · 代码指纹 ${shortSnap} · 纳入证据 ${p.verificationIds.length} 条`,
      unavailableReason: diffView?.status === "unavailable" ? (diffView.reason ?? p.reason) : null,
      truncationFlags,
      scopeNote: diffView?.scopeNote ?? p.scopeNote,
    };
  }

  if (p.context === "legacy-unavailable") {
    const shortSpec = p.specHash ? p.specHash.slice(0, 8) : "-";
    const shortSnap = p.codeSnapshotHash ? p.codeSnapshotHash.slice(0, 8) : "-";
    return {
      isHistorical: true,
      tone: "warning",
      title: p.artifactStatus === "corrupt" || p.artifactStatus === "missing" ? "验收快照缺失或损坏" : "旧版验收记录（无 Diff 快照）",
      acceptedAtText,
      provenanceText: `规范 ${shortSpec} · 代码指纹 ${shortSnap} · 纳入证据 ${p.verificationIds.length} 条 · 覆盖来源 ${p.coverageSource}`,
      unavailableReason: diffView?.reason ?? p.reason ?? "历史验收记录未固化代码差异快照，无法从当前工作区回溯",
      truncationFlags,
      scopeNote: null,
    };
  }

  return {
    isHistorical: false,
    tone: "info",
    title: "当前工作区实时证据",
    acceptedAtText: null,
    provenanceText: `规范 ${p.specHash?.slice(0, 8) ?? "-"} · 当前代码指纹 ${p.codeSnapshotHash?.slice(0, 8) ?? "未知"}`,
    unavailableReason: diffView?.status === "unavailable" ? (diffView.reason ?? null) : null,
    truncationFlags,
    scopeNote: diffView?.scopeNote ?? null,
  };
}

export const EVIDENCE_META: Record<EffectiveVerificationState, { label: string; tone: string }> = {
  passed: { label: "当前有效通过", tone: "success" },
  failed: { label: "验证失败", tone: "danger" },
  stale: { label: "已过期（代码/规范已变）", tone: "warning" },
  unknown: { label: "快照缺失", tone: "warning" },
};

export const VERDICT_META: Record<ReviewVerdict, { label: string; tone: string }> = {
  pass: { label: "建议通过", tone: "success" },
  concern: { label: "存在关注点", tone: "warning" },
  block: { label: "建议阻塞修改", tone: "danger" },
};

export const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  minimal: "Minimal (极速)",
  low: "Low (低)",
  medium: "Medium (中)",
  high: "High (高)",
  xhigh: "XHigh (极高)",
  max: "Max (最大)",
  ultra: "Ultra (极致)",
  auto: "Auto (自动)",
};

export function initialTheme(): "light" | "dark" {
  if (typeof localStorage === "undefined") return "light";
  const saved = localStorage.getItem("wb-theme");
  if (saved === "light" || saved === "dark") return saved;
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function relativeTime(ms: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return "刚刚";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  return `${Math.floor(diffSec / 86400)} 天前`;
}

export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function filteredItems(items: RequirementSummary[], query: string): RequirementSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (item) =>
      item.id.toLowerCase().includes(q) ||
      item.title.toLowerCase().includes(q) ||
      item.progressText.toLowerCase().includes(q),
  );
}

/** 去除与阶段徽章重复的进度文本，仅保留增量信息。 */
export function progressDetail(item: RequirementSummary): string {
  switch (item.stage) {
    case "draft":
    case "designing":
    case "done":
    case "cancelled":
      return "";
    case "awaiting_approval":
      return item.designVersion > 0 ? `方案 v${item.designVersion}` : "规范变更待确认";
    case "implementing":
      return item.progressText === "实施中" ? "" : item.progressText;
    case "awaiting_acceptance":
      return `验证 ${item.requiredPassed}/${item.requiredTotal}`;
    case "blocked":
      return item.blockedReason ?? "";
  }
}

export function defaultActionForRequirement(d: RequirementDetail): AgentAction {
  const act = d.validity.banner.primaryAction?.id;
  if (act === "dispatch_fix") return "fix";
  if (act === "dispatch_implement" || act === "approve_and_implement") return "implement";
  if (d.state.stage === "awaiting_acceptance" || d.validity.acceptanceGate.ok) return "review";
  if (d.state.stage === "implementing") return "implement";
  return "design";
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

export function bridgeStatusLabel(bridge: BridgeStatus | undefined): string {
  if (!bridge || !bridge.connected) return "MCP / CLI";
  return bridge.state === "idle" ? "omp 在线" : bridge.state === "waiting_user" ? "omp 等待" : "omp 运行中";
}
