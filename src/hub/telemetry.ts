import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentAction, AgentRunRecord } from "../core/types.ts";
import { atomicWriteJson, readJsonStrict } from "../core/fs.ts";
import { resolveHubDir } from "./registry.ts";

const DEFAULT_COOLDOWN_MS = 15 * 60_000;

export interface ModelStageStats {
  harness: string;
  model: string;
  action: AgentAction;
  totalRuns: number;
  succeededRuns: number;
  failedRuns: number;
  timedOutRuns: number;
  rateLimitedRuns: number;
  totalDurationMs: number;
  avgDurationMs: number;
  lastRunAt: number;
  lastRateLimitedAt?: number;
}

export interface ModelTelemetrySnapshot {
  schemaVersion: 1;
  updatedAt: number;
  entries: Record<string, ModelStageStats>;
  cooldowns: Record<string, number>;
}

export function telemetryFilePath(): string {
  return path.join(resolveHubDir(), "evolution", "model-stats.json");
}

function emptySnapshot(): ModelTelemetrySnapshot {
  return {
    schemaVersion: 1,
    updatedAt: Date.now(),
    entries: {},
    cooldowns: {},
  };
}

export function readModelTelemetry(): ModelTelemetrySnapshot {
  const filePath = telemetryFilePath();
  if (!fs.existsSync(filePath)) return emptySnapshot();
  try {
    const raw = readJsonStrict<Partial<ModelTelemetrySnapshot>>(filePath, 512 * 1024);
    if (!raw || typeof raw !== "object") return emptySnapshot();
    const entries: Record<string, ModelStageStats> = {};
    if (raw.entries && typeof raw.entries === "object") {
      for (const [k, v] of Object.entries(raw.entries)) {
        if (v && typeof v === "object" && typeof v.harness === "string" && typeof v.model === "string") {
          entries[k] = v;
        }
      }
    }
    const cooldowns: Record<string, number> = {};
    if (raw.cooldowns && typeof raw.cooldowns === "object") {
      for (const [k, v] of Object.entries(raw.cooldowns)) {
        if (typeof v === "number" && Number.isFinite(v)) {
          cooldowns[k] = v;
        }
      }
    }
    return {
      schemaVersion: 1,
      updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
      entries,
      cooldowns,
    };
  } catch {
    return emptySnapshot();
  }
}

function writeModelTelemetry(snapshot: ModelTelemetrySnapshot): ModelTelemetrySnapshot {
  const filePath = telemetryFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  atomicWriteJson(filePath, snapshot);
  return snapshot;
}

export function recordModelRunOutcome(input: {
  harness: string;
  model: string;
  action: AgentAction;
  status: AgentRunRecord["status"];
  durationMs: number;
  rateLimited?: boolean;
  timedOut?: boolean;
  cooldownMs?: number;
  now?: number;
}): ModelTelemetrySnapshot {
  const now = input.now ?? Date.now();
  const snap = readModelTelemetry();
  const entryKey = `${input.harness}::${input.model}::${input.action}`;
  const modelKey = `${input.harness}::${input.model}`;

  const prev = snap.entries[entryKey] ?? {
    harness: input.harness,
    model: input.model,
    action: input.action,
    totalRuns: 0,
    succeededRuns: 0,
    failedRuns: 0,
    timedOutRuns: 0,
    rateLimitedRuns: 0,
    totalDurationMs: 0,
    avgDurationMs: 0,
    lastRunAt: now,
  };

  const totalRuns = prev.totalRuns + 1;
  const succeededRuns = prev.succeededRuns + (input.status === "succeeded" ? 1 : 0);
  const failedRuns = prev.failedRuns + (input.status === "failed" ? 1 : 0);
  const timedOutRuns = prev.timedOutRuns + (input.timedOut ? 1 : 0);
  const rateLimitedRuns = prev.rateLimitedRuns + (input.rateLimited ? 1 : 0);
  const totalDurationMs = prev.totalDurationMs + Math.max(0, Math.round(input.durationMs));
  const avgDurationMs = Math.round(totalDurationMs / totalRuns);

  snap.entries[entryKey] = {
    ...prev,
    totalRuns,
    succeededRuns,
    failedRuns,
    timedOutRuns,
    rateLimitedRuns,
    totalDurationMs,
    avgDurationMs,
    lastRunAt: now,
    ...(input.rateLimited ? { lastRateLimitedAt: now } : prev.lastRateLimitedAt ? { lastRateLimitedAt: prev.lastRateLimitedAt } : {}),
  };

  if (input.rateLimited) {
    snap.cooldowns[modelKey] = now + (input.cooldownMs ?? DEFAULT_COOLDOWN_MS);
  } else if (input.status === "succeeded") {
    delete snap.cooldowns[modelKey];
  }

  snap.updatedAt = now;
  return writeModelTelemetry(snap);
}

export function getModelCooldownUntil(harness: string, model: string, now = Date.now()): number | null {
  const snap = readModelTelemetry();
  const until = snap.cooldowns[`${harness}::${model}`];
  if (typeof until === "number" && until > now) {
    return until;
  }
  return null;
}

export function isModelCoolingDown(harness: string, model: string, now = Date.now()): boolean {
  return getModelCooldownUntil(harness, model, now) !== null;
}

export function clearModelCooldown(harness?: string, model?: string): ModelTelemetrySnapshot {
  const snap = readModelTelemetry();
  if (harness && model) {
    delete snap.cooldowns[`${harness}::${model}`];
  } else {
    snap.cooldowns = {};
  }
  snap.updatedAt = Date.now();
  return writeModelTelemetry(snap);
}

export function summarizeTelemetry(now = Date.now()): {
  entries: ModelStageStats[];
  activeCooldowns: Array<{ harness: string; model: string; until: number }>;
} {
  const snap = readModelTelemetry();
  const entries = Object.values(snap.entries).sort((a, b) => b.totalRuns - a.totalRuns || b.lastRunAt - a.lastRunAt);
  const activeCooldowns: Array<{ harness: string; model: string; until: number }> = [];
  for (const [key, until] of Object.entries(snap.cooldowns)) {
    if (until > now) {
      const [harness = "", ...modelParts] = key.split("::");
      activeCooldowns.push({ harness, model: modelParts.join("::"), until });
    }
  }
  return { entries, activeCooldowns };
}
