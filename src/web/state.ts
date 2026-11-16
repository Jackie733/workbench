import type {
  AgentAction,
  CriterionCoverageState,
  EffectiveVerificationState,
  PrivacyMode,
  RequirementDetail,
  RequirementSummary,
  ReviewVerdict,
  Stage,
  TaskStatus,
} from "../core/types.ts";
import type { PainPointCategory } from "../hub/evolution.ts";
import { REASONING_EFFORTS, type HarnessId, type HarnessInfo, type ModelTarget, type ReasoningEffort, type RoutingConfig } from "../hub/types.ts";
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
  | { kind: "new_req"; goal: string }
  | { kind: "feedback"; feedback: string; dispatchAgent: boolean }
  | { kind: "lifecycle"; action: "block" | "cancel" | "reopen"; reason: string }
  | { kind: "prompt_fallback"; title: string; subtitle: string; prompt: string }
  | { kind: "add_project"; browse: BrowseResponse | null; pathInput: string; nameInput: string; initPrivacy: PrivacyMode | "none" }
  | { kind: "routing"; draft: RoutingConfig | null; customHarness: HarnessId; customModel: string }
  | { kind: "annotate_anchor"; anchor: string; message: string; mode: "ask" | "refine" }
  | { kind: "handoff_preview"; markdown: string }
  | {
      kind: "quick_report";
      title: string;
      detail: string;
      category: PainPointCategory;
      domSelector: string;
      autoPromote: boolean;
    }
  | { kind: "evolution"; tab: "inbox" | "playbook" | "telemetry"; playbookDraft: string | null }
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
};

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

export function activeRunnerChoice(
  selectedRunnerKey: string,
  routing: RoutingConfig | null,
  action: AgentAction,
  selectedEffort?: ReasoningEffort | "",
): { harness?: string; model?: string; effort?: ReasoningEffort } {
  if (selectedRunnerKey && selectedRunnerKey !== "manual_copy") {
    const [harness, model] = selectedRunnerKey.split("::");
    if (harness && model) {
      return { harness, model, ...(selectedEffort ? { effort: selectedEffort } : {}) };
    }
  }
  const primary = routedTargetForAction(routing, action);
  const effort = selectedEffort || primary?.reasoningEffort;
  return primary ? { harness: primary.harness, model: primary.model, ...(effort ? { effort } : {}) } : {};
}

export function supportedEffortsForModel(
  harnesses: HarnessInfo[],
  harnessId?: string,
  modelId?: string,
): ReasoningEffort[] {
  if (!harnessId || !modelId) return ["low", "medium", "high", "xhigh"];
  const h = harnesses.find((x) => x.id === harnessId);
  const m = h?.models.find((x) => x.id === modelId);
  if (m?.supportedEfforts && m.supportedEfforts.length > 0) return m.supportedEfforts;
  if (harnessId === "codex" || harnessId === "agy" || harnessId === "qodercn") {
    return ["low", "medium", "high", "xhigh", "max"];
  }
  if (harnessId === "omp") return ["minimal", "low", "medium", "high", "xhigh", "max", "auto"];
  if (harnessId === "opencode") return ["low", "medium", "high"];
  return [...REASONING_EFFORTS];
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
  tier: string;
  provider?: string;
}> {
  const opts: Array<{
    key: string;
    label: string;
    harnessId: HarnessId;
    harnessLabel: string;
    modelId: string;
    displayLabel: string;
    tier: string;
    provider?: string;
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
      });
    }
  }
  return opts;
}

export function bridgeStatusLabel(bridge: BridgeStatus | undefined): string {
  if (!bridge || !bridge.connected) return "MCP / CLI";
  return bridge.state === "idle" ? "omp 在线" : bridge.state === "waiting_user" ? "omp 等待" : "omp 运行中";
}
