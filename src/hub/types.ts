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
}

export interface DiscoveredModel {
  id: string;
  label?: string;
  provider?: string;
  tier: "sota" | "balanced" | "fast" | "review";
  source: "detected" | "custom";
  supportedEfforts?: ReasoningEffort[];
  defaultEffort?: ReasoningEffort;
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
  addedAt: number;
  lastOpenedAt: number;
}

export interface HubConfig {
  schemaVersion: 1;
  activeProjectId: string | null;
  projects: HubProjectEntry[];
  routing: RoutingConfig;
  customModels: Record<string, string[]>;
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
