import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile, withFileLockSync } from "../core/fs.ts";
import type {
  AgentAction,
  AgentRunRecord,
  RunBillingMode,
  RunCostSource,
  RunDispatchReason,
  RunHandoffMode,
  RunTokenUsage,
} from "../core/types.ts";
import { formatQuotaPoolLabel } from "./pricing.ts";
import { readHubConfig, resolveHubDir } from "./registry.ts";

const LEDGER_MAX_BYTES = 16 * 1024 * 1024;
const LEDGER_KEEP_ENTRIES = 20_000;

export interface RunLedgerEntry {
  schemaVersion: 1;
  runId: string;
  projectId?: string;
  projectName?: string;
  projectRoot: string;
  nodeId: string;
  nodeName?: string;
  requirementId: string;
  requirementTitle?: string;
  action: AgentAction;
  harness: string;
  model: string;
  effectiveModel?: string;
  modelFallback?: boolean;
  reasoningEffort?: string;
  quotaPool: string;
  billingMode: RunBillingMode;
  status: AgentRunRecord["status"];
  dispatchReason?: RunDispatchReason;
  handoffMode?: RunHandoffMode;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  llmDurationMs?: number;
  toolDurationMs?: number;
  ttftMs?: number;
  usage?: RunTokenUsage;
  apiCostUsd: number;
  equivalentCostUsd: number;
  costSource: RunCostSource;
  turnsCount: number;
  toolCallsCount: number;
  toolErrorCount: number;
  compactionCount: number;
  peakContextTokens?: number;
  contextWindow?: number;
  handoffTruncated?: boolean;
  rateLimited?: boolean;
  timedOut?: boolean;
  specChanged?: boolean;
  codeChanged?: boolean;
}

export interface InsightsQueryFilter {
  days?: number; // 7, 30, or 0 (all)
  projectId?: string;
  nodeId?: string;
  quotaPool?: string;
  harness?: string;
  action?: AgentAction;
  billingMode?: RunBillingMode;
  status?: AgentRunRecord["status"];
  now?: number;
}

export interface InsightsDiagnostic {
  id: string;
  severity: "info" | "warning" | "danger";
  kind: "fix_churn" | "low_cache" | "handoff_truncated" | "rate_limited" | "tool_bottleneck";
  titleKey: string;
  detailKey: string;
  params: Record<string, string | number>;
  projectId?: string;
  requirementId?: string;
  harness?: string;
  model?: string;
}

export interface InsightsResponse {
  generatedAt: number;
  filter: {
    days: number;
    projectId?: string;
    nodeId?: string;
    quotaPool?: string;
    harness?: string;
    action?: AgentAction;
    billingMode?: RunBillingMode;
    status?: AgentRunRecord["status"];
  };
  kpi: {
    totalRuns: number;
    succeededRuns: number;
    failedRuns: number;
    cancelledRuns: number;
    successRate: number;
    totalDurationMs: number;
    avgDurationMs: number;
    p50DurationMs: number;
    p95DurationMs: number;
    totalTokens: number;
    inputTokens: number;
    uncachedInputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheHitRate: number;
    apiCostUsd: number;
    equivalentCostUsd: number;
    totalToolCalls: number;
    totalToolErrors: number;
    totalCompactions: number;
    rateLimitedRuns: number;
    timedOutRuns: number;
    degradedRuns: number;
  };
  dailySeries: Array<{
    date: string;
    runs: number;
    tokens: number;
    apiCostUsd: number;
    equivalentCostUsd: number;
    durationMs: number;
    byAction: Record<string, { runs: number; tokens: number; equivalentCostUsd: number }>;
    byQuotaPool: Record<string, { runs: number; tokens: number; equivalentCostUsd: number }>;
  }>;
  heatmap: Array<{
    date: string;
    runs: number;
    tokens: number;
    equivalentCostUsd: number;
    level: 0 | 1 | 2 | 3 | 4;
  }>;
  byAction: Array<{
    action: AgentAction;
    runs: number;
    succeeded: number;
    tokens: number;
    apiCostUsd: number;
    equivalentCostUsd: number;
    durationMs: number;
  }>;
  byQuotaPool: Array<{
    quotaPool: string;
    label: string;
    billingMode: RunBillingMode;
    runs: number;
    succeeded: number;
    tokens: number;
    cacheReadTokens: number;
    cacheHitRate: number;
    apiCostUsd: number;
    equivalentCostUsd: number;
    durationMs: number;
  }>;
  byHarness: Array<{
    harness: string;
    runs: number;
    succeeded: number;
    tokens: number;
    apiCostUsd: number;
    equivalentCostUsd: number;
    durationMs: number;
  }>;
  byModel: Array<{
    harness: string;
    model: string;
    quotaPool: string;
    billingMode: RunBillingMode;
    action: AgentAction;
    runs: number;
    succeededRuns: number;
    failedRuns: number;
    timedOutRuns: number;
    rateLimitedRuns: number;
    degradedRuns: number;
    avgDurationMs: number;
    avgTokens: number;
    cacheHitRate: number;
    avgEquivalentCostUsd: number;
    totalEquivalentCostUsd: number;
    totalApiCostUsd: number;
    coolingUntil: number | null;
  }>;
  topRequirements: Array<{
    projectId: string;
    projectName: string;
    projectRoot: string;
    nodeId: string;
    requirementId: string;
    requirementTitle: string;
    runs: number;
    fixRuns: number;
    tokens: number;
    cacheHitRate: number;
    apiCostUsd: number;
    equivalentCostUsd: number;
    durationMs: number;
    toolCalls: number;
    lastRunAt: number;
    byAction: Record<string, number>;
  }>;
  diagnostics: InsightsDiagnostic[];
  facets: {
    projects: Array<{ id: string; name: string }>;
    nodes: Array<{ id: string; name: string }>;
    quotaPools: Array<{ id: string; label: string }>;
    harnesses: string[];
  };
}

export function runLedgerFilePath(): string {
  return path.join(resolveHubDir(), "telemetry", "runs-ledger.jsonl");
}

function runLedgerLockPath(): string {
  return path.join(path.dirname(runLedgerFilePath()), ".ledger.lock");
}

export function appendRunLedger(entry: RunLedgerEntry): void {
  const filePath = runLedgerFilePath();
  withFileLockSync(runLedgerLockPath(), () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > LEDGER_MAX_BYTES) {
        const raw = fs.readFileSync(filePath, "utf8");
        const lines = raw
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        const kept = lines.slice(-LEDGER_KEEP_ENTRIES).join("\n");
        atomicWriteFile(filePath, kept ? `${kept}\n` : "", 0o600);
      }
    } catch {
      // Best-effort compaction.
    }
  });
}

export function readRunLedger(filter: InsightsQueryFilter = {}): RunLedgerEntry[] {
  const filePath = runLedgerFilePath();
  if (!fs.existsSync(filePath)) return [];
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const now = filter.now ?? Date.now();
  const days = typeof filter.days === "number" && Number.isFinite(filter.days) && filter.days > 0 ? Math.floor(filter.days) : 0;
  const minTs = days > 0 ? now - days * 86_400_000 : 0;

  const byRunId = new Map<string, RunLedgerEntry>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as RunLedgerEntry;
      if (!obj || typeof obj !== "object" || typeof obj.runId !== "string" || typeof obj.startedAt !== "number") {
        continue;
      }
      byRunId.set(obj.runId, obj);
    } catch {
      // Skip malformed line safely.
    }
  }

  return Array.from(byRunId.values())
    .filter((e) => {
      if (minTs > 0 && e.startedAt < minTs) return false;
      if (filter.projectId && e.projectId !== filter.projectId) return false;
      if (filter.nodeId && e.nodeId !== filter.nodeId) return false;
      if (filter.quotaPool && e.quotaPool !== filter.quotaPool) return false;
      if (filter.harness && e.harness !== filter.harness) return false;
      if (filter.action && e.action !== filter.action) return false;
      if (filter.billingMode && e.billingMode !== filter.billingMode) return false;
      if (filter.status && e.status !== filter.status) return false;
      return true;
    })
    .sort((a, b) => a.startedAt - b.startedAt);
}

function localDayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor((sortedAsc.length - 1) * p)));
  return sortedAsc[idx]!;
}

export function queryHubInsights(
  filter: InsightsQueryFilter,
  options: {
    cooldowns?: Record<string, number>;
    projects?: Array<{ id: string; name: string; root: string; nodeId?: string }>;
  } = {},
): InsightsResponse {
  const now = filter.now ?? Date.now();
  const days = filter.days === 0 ? 0 : filter.days === 30 ? 30 : 7;
  const allEntries = readRunLedger({ now });

  // Collect global filter facets before applying item filters
  const projectsList = options.projects ?? readHubConfig().projects;
  const projectMap = new Map<string, string>();
  const projectByRootAndNode = new Map<string, { id: string; name: string }>();
  const projectByRoot = new Map<string, { id: string; name: string }>();
  const nodeMap = new Map<string, string>();
  const poolSet = new Set<string>();
  const harnessSet = new Set<string>();
  for (const p of projectsList) {
    projectMap.set(p.id, p.name);
    projectByRootAndNode.set(`${p.nodeId ?? "local"}::${p.root}`, { id: p.id, name: p.name });
    if (!projectByRoot.has(p.root)) projectByRoot.set(p.root, { id: p.id, name: p.name });
  }
  const resolveProjectMeta = (e: RunLedgerEntry) => {
    const matched = projectByRootAndNode.get(`${e.nodeId}::${e.projectRoot}`) ?? projectByRoot.get(e.projectRoot);
    return {
      projectId: e.projectId ?? matched?.id,
      projectName: e.projectName ?? matched?.name ?? (e.projectId ? projectMap.get(e.projectId) : undefined),
    };
  };
  for (const e of allEntries) {
    const meta = resolveProjectMeta(e);
    if (meta.projectId) {
      projectMap.set(meta.projectId, meta.projectName ?? projectMap.get(meta.projectId) ?? path.basename(e.projectRoot));
    }
    if (e.nodeId) nodeMap.set(e.nodeId, e.nodeName ?? (e.nodeId === "local" ? "本机" : e.nodeId));
    if (e.quotaPool) poolSet.add(e.quotaPool);
    if (e.harness) harnessSet.add(e.harness);
  }

  const entries = allEntries.filter((e) => {
    if (days > 0 && e.startedAt < now - days * 86_400_000) return false;
    if (filter.projectId && resolveProjectMeta(e).projectId !== filter.projectId) return false;
    if (filter.nodeId && e.nodeId !== filter.nodeId) return false;
    if (filter.quotaPool && e.quotaPool !== filter.quotaPool) return false;
    if (filter.harness && e.harness !== filter.harness) return false;
    if (filter.action && e.action !== filter.action) return false;
    if (filter.billingMode && e.billingMode !== filter.billingMode) return false;
    if (filter.status && e.status !== filter.status) return false;
    return true;
  });

  // KPI aggregation
  let succeededRuns = 0;
  let failedRuns = 0;
  let cancelledRuns = 0;
  let totalDurationMs = 0;
  const durations: number[] = [];
  let inputTokens = 0;
  let uncachedInputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let totalTokens = 0;
  let apiCostUsd = 0;
  let equivalentCostUsd = 0;
  let totalToolCalls = 0;
  let totalToolErrors = 0;
  let totalCompactions = 0;
  let rateLimitedRuns = 0;
  let timedOutRuns = 0;
  let degradedRuns = 0;
  let handoffTruncatedCount = 0;

  const actionAcc = new Map<AgentAction, { runs: number; succeeded: number; tokens: number; apiCostUsd: number; equivalentCostUsd: number; durationMs: number }>();
  const poolAcc = new Map<string, { quotaPool: string; billingMode: RunBillingMode; runs: number; succeeded: number; tokens: number; cacheReadTokens: number; inputTokens: number; apiCostUsd: number; equivalentCostUsd: number; durationMs: number }>();
  const harnessAcc = new Map<string, { runs: number; succeeded: number; tokens: number; apiCostUsd: number; equivalentCostUsd: number; durationMs: number }>();
  const modelAcc = new Map<string, {
    harness: string;
    model: string;
    quotaPool: string;
    billingMode: RunBillingMode;
    action: AgentAction;
    runs: number;
    succeededRuns: number;
    failedRuns: number;
    timedOutRuns: number;
    rateLimitedRuns: number;
    degradedRuns: number;
    durationMs: number;
    tokens: number;
    inputTokens: number;
    cacheReadTokens: number;
    apiCostUsd: number;
    equivalentCostUsd: number;
  }>();
  const reqAcc = new Map<string, {
    projectId: string;
    projectName: string;
    projectRoot: string;
    nodeId: string;
    requirementId: string;
    requirementTitle: string;
    runs: number;
    fixRuns: number;
    tokens: number;
    inputTokens: number;
    cacheReadTokens: number;
    apiCostUsd: number;
    equivalentCostUsd: number;
    durationMs: number;
    toolCalls: number;
    lastRunAt: number;
    byAction: Record<string, number>;
    handoffTruncatedRuns: number;
    toolDurationMs: number;
  }>();

  const dailyMap = new Map<string, InsightsResponse["dailySeries"][number]>();
  const ensureDay = (date: string) => {
    let cur = dailyMap.get(date);
    if (!cur) {
      cur = {
        date,
        runs: 0,
        tokens: 0,
        apiCostUsd: 0,
        equivalentCostUsd: 0,
        durationMs: 0,
        byAction: {},
        byQuotaPool: {},
      };
      dailyMap.set(date, cur);
    }
    return cur;
  };
  if (days > 0) {
    for (let d = days - 1; d >= 0; d--) {
      ensureDay(localDayKey(now - d * 86_400_000));
    }
  }

  for (const e of entries) {
    if (e.status === "succeeded") succeededRuns++;
    else if (e.status === "failed") failedRuns++;
    else if (e.status === "cancelled") cancelledRuns++;

    const dur = Math.max(0, e.durationMs || 0);
    totalDurationMs += dur;
    durations.push(dur);

    const u = e.usage;
    const tok = u?.totalTokens ?? 0;
    const inTok = u?.inputTokens ?? 0;
    const cRead = u?.cacheReadTokens ?? 0;
    inputTokens += inTok;
    uncachedInputTokens += u?.uncachedInputTokens ?? 0;
    cacheReadTokens += cRead;
    cacheWriteTokens += u?.cacheWriteTokens ?? 0;
    outputTokens += u?.outputTokens ?? 0;
    reasoningTokens += u?.reasoningTokens ?? 0;
    totalTokens += tok;
    apiCostUsd += e.apiCostUsd || 0;
    equivalentCostUsd += e.equivalentCostUsd || 0;
    totalToolCalls += e.toolCallsCount || 0;
    totalToolErrors += e.toolErrorCount || 0;
    totalCompactions += e.compactionCount || 0;
    if (e.rateLimited) rateLimitedRuns++;
    if (e.timedOut) timedOutRuns++;
    if (e.modelFallback) degradedRuns++;
    if (e.handoffTruncated) handoffTruncatedCount++;

    // Daily
    const dayKey = localDayKey(e.startedAt);
    const day = ensureDay(dayKey);
    day.runs += 1;
    day.tokens += tok;
    day.apiCostUsd += e.apiCostUsd || 0;
    day.equivalentCostUsd += e.equivalentCostUsd || 0;
    day.durationMs += dur;
    day.byAction[e.action] = {
      runs: (day.byAction[e.action]?.runs ?? 0) + 1,
      tokens: (day.byAction[e.action]?.tokens ?? 0) + tok,
      equivalentCostUsd: (day.byAction[e.action]?.equivalentCostUsd ?? 0) + (e.equivalentCostUsd || 0),
    };
    day.byQuotaPool[e.quotaPool] = {
      runs: (day.byQuotaPool[e.quotaPool]?.runs ?? 0) + 1,
      tokens: (day.byQuotaPool[e.quotaPool]?.tokens ?? 0) + tok,
      equivalentCostUsd: (day.byQuotaPool[e.quotaPool]?.equivalentCostUsd ?? 0) + (e.equivalentCostUsd || 0),
    };

    // By action
    const aPrev = actionAcc.get(e.action) ?? { runs: 0, succeeded: 0, tokens: 0, apiCostUsd: 0, equivalentCostUsd: 0, durationMs: 0 };
    aPrev.runs += 1;
    if (e.status === "succeeded") aPrev.succeeded += 1;
    aPrev.tokens += tok;
    aPrev.apiCostUsd += e.apiCostUsd || 0;
    aPrev.equivalentCostUsd += e.equivalentCostUsd || 0;
    aPrev.durationMs += dur;
    actionAcc.set(e.action, aPrev);

    // By quotaPool
    const pPrev = poolAcc.get(e.quotaPool) ?? {
      quotaPool: e.quotaPool,
      billingMode: e.billingMode,
      runs: 0,
      succeeded: 0,
      tokens: 0,
      cacheReadTokens: 0,
      inputTokens: 0,
      apiCostUsd: 0,
      equivalentCostUsd: 0,
      durationMs: 0,
    };
    pPrev.runs += 1;
    if (e.status === "succeeded") pPrev.succeeded += 1;
    pPrev.tokens += tok;
    pPrev.cacheReadTokens += cRead;
    pPrev.inputTokens += inTok;
    pPrev.apiCostUsd += e.apiCostUsd || 0;
    pPrev.equivalentCostUsd += e.equivalentCostUsd || 0;
    pPrev.durationMs += dur;
    poolAcc.set(e.quotaPool, pPrev);

    // By harness
    const hPrev = harnessAcc.get(e.harness) ?? { runs: 0, succeeded: 0, tokens: 0, apiCostUsd: 0, equivalentCostUsd: 0, durationMs: 0 };
    hPrev.runs += 1;
    if (e.status === "succeeded") hPrev.succeeded += 1;
    hPrev.tokens += tok;
    hPrev.apiCostUsd += e.apiCostUsd || 0;
    hPrev.equivalentCostUsd += e.equivalentCostUsd || 0;
    hPrev.durationMs += dur;
    harnessAcc.set(e.harness, hPrev);

    // By model + action
    const mKey = `${e.harness}::${e.model}::${e.action}`;
    const mPrev = modelAcc.get(mKey) ?? {
      harness: e.harness,
      model: e.model,
      quotaPool: e.quotaPool,
      billingMode: e.billingMode,
      action: e.action,
      runs: 0,
      succeededRuns: 0,
      failedRuns: 0,
      timedOutRuns: 0,
      rateLimitedRuns: 0,
      degradedRuns: 0,
      durationMs: 0,
      tokens: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      apiCostUsd: 0,
      equivalentCostUsd: 0,
    };
    mPrev.runs += 1;
    if (e.status === "succeeded" && !e.modelFallback) mPrev.succeededRuns += 1;
    if (e.status === "failed") mPrev.failedRuns += 1;
    if (e.timedOut) mPrev.timedOutRuns += 1;
    if (e.rateLimited) mPrev.rateLimitedRuns += 1;
    if (e.modelFallback) mPrev.degradedRuns += 1;
    mPrev.durationMs += dur;
    mPrev.tokens += tok;
    mPrev.inputTokens += inTok;
    mPrev.cacheReadTokens += cRead;
    mPrev.apiCostUsd += e.apiCostUsd || 0;
    mPrev.equivalentCostUsd += e.equivalentCostUsd || 0;
    modelAcc.set(mKey, mPrev);

    // By requirement
    const meta = resolveProjectMeta(e);
    const projId = meta.projectId ?? e.projectRoot;
    const rKey = `${projId}::${e.requirementId}`;
    const rPrev = reqAcc.get(rKey) ?? {
      projectId: projId,
      projectName: meta.projectName ?? path.basename(e.projectRoot),
      projectRoot: e.projectRoot,
      nodeId: e.nodeId,
      requirementId: e.requirementId,
      requirementTitle: e.requirementTitle ?? e.requirementId,
      runs: 0,
      fixRuns: 0,
      tokens: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      apiCostUsd: 0,
      equivalentCostUsd: 0,
      durationMs: 0,
      toolCalls: 0,
      lastRunAt: 0,
      byAction: {},
      handoffTruncatedRuns: 0,
      toolDurationMs: 0,
    };
    rPrev.runs += 1;
    if (e.action === "fix") rPrev.fixRuns += 1;
    if (e.requirementTitle) rPrev.requirementTitle = e.requirementTitle;
    rPrev.tokens += tok;
    rPrev.inputTokens += inTok;
    rPrev.cacheReadTokens += cRead;
    rPrev.apiCostUsd += e.apiCostUsd || 0;
    rPrev.equivalentCostUsd += e.equivalentCostUsd || 0;
    rPrev.durationMs += dur;
    rPrev.toolCalls += e.toolCallsCount || 0;
    rPrev.lastRunAt = Math.max(rPrev.lastRunAt, e.startedAt);
    rPrev.byAction[e.action] = (rPrev.byAction[e.action] ?? 0) + 1;
    if (e.handoffTruncated) rPrev.handoffTruncatedRuns += 1;
    rPrev.toolDurationMs += e.toolDurationMs || 0;
    reqAcc.set(rKey, rPrev);
  }

  durations.sort((a, b) => a - b);
  const totalRuns = entries.length;
  const cooldowns = options.cooldowns ?? {};

  // Build 84-day activity heatmap across matching project/node/pool/harness/action filters (ignoring 7d window so heatmap stays rich).
  const heatEntries = allEntries.filter((e) => {
    if (e.startedAt < now - 84 * 86_400_000) return false;
    if (filter.projectId && e.projectId !== filter.projectId) return false;
    if (filter.nodeId && e.nodeId !== filter.nodeId) return false;
    if (filter.quotaPool && e.quotaPool !== filter.quotaPool) return false;
    if (filter.harness && e.harness !== filter.harness) return false;
    if (filter.action && e.action !== filter.action) return false;
    if (filter.billingMode && e.billingMode !== filter.billingMode) return false;
    if (filter.status && e.status !== filter.status) return false;
    return true;
  });
  const heatMap = new Map<string, { runs: number; tokens: number; equivalentCostUsd: number }>();
  for (let d = 83; d >= 0; d--) {
    heatMap.set(localDayKey(now - d * 86_400_000), { runs: 0, tokens: 0, equivalentCostUsd: 0 });
  }
  for (const e of heatEntries) {
    const k = localDayKey(e.startedAt);
    const cell = heatMap.get(k);
    if (!cell) continue;
    cell.runs += 1;
    cell.tokens += e.usage?.totalTokens ?? 0;
    cell.equivalentCostUsd += e.equivalentCostUsd || 0;
  }
  const maxHeatRuns = Math.max(1, ...Array.from(heatMap.values()).map((c) => c.runs));
  const heatmap = Array.from(heatMap.entries()).map(([date, cell]) => {
    const ratio = cell.runs / maxHeatRuns;
    const level: 0 | 1 | 2 | 3 | 4 =
      cell.runs === 0 ? 0 : ratio >= 0.75 ? 4 : ratio >= 0.5 ? 3 : ratio >= 0.25 ? 2 : 1;
    return { date, ...cell, level };
  });

  const topRequirements = Array.from(reqAcc.values())
    .map((r) => ({
      projectId: r.projectId,
      projectName: r.projectName,
      projectRoot: r.projectRoot,
      nodeId: r.nodeId,
      requirementId: r.requirementId,
      requirementTitle: r.requirementTitle,
      runs: r.runs,
      fixRuns: r.fixRuns,
      tokens: r.tokens,
      cacheHitRate: r.inputTokens > 0 ? r.cacheReadTokens / r.inputTokens : 0,
      apiCostUsd: r.apiCostUsd,
      equivalentCostUsd: r.equivalentCostUsd,
      durationMs: r.durationMs,
      toolCalls: r.toolCalls,
      lastRunAt: r.lastRunAt,
      byAction: r.byAction,
    }))
    .sort((a, b) => b.equivalentCostUsd - a.equivalentCostUsd || b.tokens - a.tokens || b.runs - a.runs)
    .slice(0, 20);

  // Rule-based diagnostic suggestions
  const diagnostics: InsightsDiagnostic[] = [];
  for (const r of topRequirements) {
    if (r.fixRuns >= 3) {
      diagnostics.push({
        id: `diag-fix-${r.projectId}-${r.requirementId}`,
        severity: "warning",
        kind: "fix_churn",
        titleKey: "insights.diag.fixChurnTitle",
        detailKey: "insights.diag.fixChurnDetail",
        params: { id: r.requirementId, project: r.projectName, count: r.fixRuns },
        projectId: r.projectId,
        requirementId: r.requirementId,
      });
    }
  }
  const cacheHitRate = inputTokens > 0 ? cacheReadTokens / inputTokens : 0;
  if (totalRuns >= 4 && inputTokens > 20_000 && cacheHitRate < 0.25) {
    diagnostics.push({
      id: "diag-low-cache",
      severity: "info",
      kind: "low_cache",
      titleKey: "insights.diag.lowCacheTitle",
      detailKey: "insights.diag.lowCacheDetail",
      params: { rate: Math.round(cacheHitRate * 100) },
    });
  }
  if (totalRuns >= 3 && handoffTruncatedCount / totalRuns >= 0.25) {
    diagnostics.push({
      id: "diag-handoff-trunc",
      severity: "warning",
      kind: "handoff_truncated",
      titleKey: "insights.diag.handoffTruncTitle",
      detailKey: "insights.diag.handoffTruncDetail",
      params: { count: handoffTruncatedCount, total: totalRuns },
    });
  }
  for (const m of modelAcc.values()) {
    if (m.rateLimitedRuns >= 2) {
      diagnostics.push({
        id: `diag-rl-${m.harness}-${m.model}-${m.action}`,
        severity: "danger",
        kind: "rate_limited",
        titleKey: "insights.diag.rateLimitedTitle",
        detailKey: "insights.diag.rateLimitedDetail",
        params: { harness: m.harness, model: m.model, count: m.rateLimitedRuns },
        harness: m.harness,
        model: m.model,
      });
    }
  }
  const totalToolDuration = entries.reduce((acc, e) => acc + (e.toolDurationMs ?? 0), 0);
  if (totalDurationMs > 60_000 && totalToolDuration / totalDurationMs > 0.65) {
    diagnostics.push({
      id: "diag-tool-bottleneck",
      severity: "info",
      kind: "tool_bottleneck",
      titleKey: "insights.diag.toolBottleneckTitle",
      detailKey: "insights.diag.toolBottleneckDetail",
      params: { pct: Math.round((totalToolDuration / totalDurationMs) * 100) },
    });
  }

  return {
    generatedAt: now,
    filter: {
      days,
      ...(filter.projectId ? { projectId: filter.projectId } : {}),
      ...(filter.nodeId ? { nodeId: filter.nodeId } : {}),
      ...(filter.quotaPool ? { quotaPool: filter.quotaPool } : {}),
      ...(filter.harness ? { harness: filter.harness } : {}),
      ...(filter.action ? { action: filter.action } : {}),
      ...(filter.billingMode ? { billingMode: filter.billingMode } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
    kpi: {
      totalRuns,
      succeededRuns,
      failedRuns,
      cancelledRuns,
      successRate: totalRuns > 0 ? succeededRuns / totalRuns : 0,
      totalDurationMs,
      avgDurationMs: totalRuns > 0 ? Math.round(totalDurationMs / totalRuns) : 0,
      p50DurationMs: percentile(durations, 0.5),
      p95DurationMs: percentile(durations, 0.95),
      totalTokens,
      inputTokens,
      uncachedInputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      reasoningTokens,
      cacheHitRate,
      apiCostUsd,
      equivalentCostUsd,
      totalToolCalls,
      totalToolErrors,
      totalCompactions,
      rateLimitedRuns,
      timedOutRuns,
      degradedRuns,
    },
    dailySeries: Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
    heatmap,
    byAction: Array.from(actionAcc.entries()).map(([action, v]) => ({ action, ...v })),
    byQuotaPool: Array.from(poolAcc.values())
      .map((p) => ({
        quotaPool: p.quotaPool,
        label: formatQuotaPoolLabel(p.quotaPool),
        billingMode: p.billingMode,
        runs: p.runs,
        succeeded: p.succeeded,
        tokens: p.tokens,
        cacheReadTokens: p.cacheReadTokens,
        cacheHitRate: p.inputTokens > 0 ? p.cacheReadTokens / p.inputTokens : 0,
        apiCostUsd: p.apiCostUsd,
        equivalentCostUsd: p.equivalentCostUsd,
        durationMs: p.durationMs,
      }))
      .sort((a, b) => b.equivalentCostUsd - a.equivalentCostUsd || b.tokens - a.tokens || b.runs - a.runs),
    byHarness: Array.from(harnessAcc.entries())
      .map(([harness, v]) => ({ harness, ...v }))
      .sort((a, b) => b.runs - a.runs),
    byModel: Array.from(modelAcc.values())
      .map((m) => {
        const until = cooldowns[`${m.harness}::${m.model}`];
        return {
          harness: m.harness,
          model: m.model,
          quotaPool: m.quotaPool,
          billingMode: m.billingMode,
          action: m.action,
          runs: m.runs,
          succeededRuns: m.succeededRuns,
          failedRuns: m.failedRuns,
          timedOutRuns: m.timedOutRuns,
          rateLimitedRuns: m.rateLimitedRuns,
          degradedRuns: m.degradedRuns,
          avgDurationMs: m.runs > 0 ? Math.round(m.durationMs / m.runs) : 0,
          avgTokens: m.runs > 0 ? Math.round(m.tokens / m.runs) : 0,
          cacheHitRate: m.inputTokens > 0 ? m.cacheReadTokens / m.inputTokens : 0,
          avgEquivalentCostUsd: m.runs > 0 ? m.equivalentCostUsd / m.runs : 0,
          totalEquivalentCostUsd: m.equivalentCostUsd,
          totalApiCostUsd: m.apiCostUsd,
          coolingUntil: typeof until === "number" && until > now ? until : null,
        };
      })
      .sort((a, b) => b.runs - a.runs || b.totalEquivalentCostUsd - a.totalEquivalentCostUsd),
    topRequirements,
    diagnostics: diagnostics.slice(0, 8),
    facets: {
      projects: Array.from(projectMap.entries()).map(([id, name]) => ({ id, name })),
      nodes: Array.from(nodeMap.entries()).map(([id, name]) => ({ id, name })),
      quotaPools: Array.from(poolSet.values())
        .sort()
        .map((id) => ({ id, label: formatQuotaPoolLabel(id) })),
      harnesses: Array.from(harnessSet.values()).sort(),
    },
  };
}
