import type { AgentRunRecord, OutputLanguage } from "../core/types.ts";

export const HARNESS_IDS = ["codex", "qodercn", "opencode", "agy", "omp"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra", "auto"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const ROUTING_PRESETS = ["balanced", "sota_first", "quota_saver"] as const;
export type RoutingPreset = (typeof ROUTING_PRESETS)[number];

export const ROUTING_STAGES = ["design", "implement", "fix", "review"] as const;
export type RoutingStage = (typeof ROUTING_STAGES)[number];

export interface ModelTarget {
  harness: HarnessId;
  model: string;
  reasoningEffort?: ReasoningEffort;
}

export interface StageRouteRule {
  primary: ModelTarget;
  fallbacks: ModelTarget[];
}

export interface RoutingConfig {
  activePreset: RoutingPreset;
  stages: Record<RoutingStage, StageRouteRule>;
  /** Automatically dispatch cross-model review after agent submits readyForAcceptance (defaults to true). */
  autoReview?: boolean;
}

export interface DiscoveredModel {
  id: string;
  label?: string;
  provider?: string;
  tier: "sota" | "balanced" | "fast" | "review";
  source: "detected" | "builtin";
  supportedEfforts?: ReasoningEffort[];
  defaultEffort?: ReasoningEffort;
  /** Optional capability metadata enriched from local caches (models.db / models_cache.json) */
  intelligence?: number;
  cost?: { input: number; output: number };
  isFree?: boolean;
  isLegacy?: boolean;
  priority?: number;
  /** True when the model's effort is fixed/locked (e.g. single-effort variant) */
  effortLocked?: boolean;
  /** For aggregated family models (e.g. agy), maps reasoningEffort -> underlying CLI variant ID */
  effortVariants?: Partial<Record<ReasoningEffort, string>>;
}

export interface HarnessInfo {
  id: HarnessId;
  label: string;
  subscription: string;
  installed: boolean;
  executable: string | null;
  models: DiscoveredModel[];
  defaultModel: string | null;
  detectedAt: number;
  note?: string;
}

export interface HubProjectEntry {
  id: string;
  name: string;
  root: string;
  /** 所属节点 ID；省略或 "local" 表示当前 Hub 本机项目 */
  nodeId?: string;
  /** 所属节点显示名称缓存，便于节点离线时在侧边栏展示 */
  nodeName?: string;
  addedAt: number;
  lastOpenedAt: number;
}

export interface RemoteNodeInfo {
  nodeId: string;
  name: string;
  isLocal: boolean;
  hostname: string;
  platform: string;
  connected: boolean;
  connectedAt: number | null;
  lastSeenAt: number | null;
  harnesses: HarnessInfo[];
  activeRuns: Array<AgentRunRecord & { requirementId: string; root?: string; projectId?: string }>;
  workbenchVersion?: string;
  revision?: string;
}

export interface HubConfig {
  schemaVersion: 1;
  activeProjectId: string | null;
  projects: HubProjectEntry[];
  routing: RoutingConfig;
  outputLanguage?: OutputLanguage;
  giteeAccessToken?: string;
}

export interface DaemonInfo {
  pid: number;
  port: number;
  hostname: string;
  url: string;
  startedAt: number;
  version: string;
}

export interface BrowseEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isGitRepo: boolean;
  workbenchInitialized: boolean;
}
