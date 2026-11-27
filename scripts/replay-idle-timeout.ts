#!/usr/bin/env bun
/**
 * Replays historical agent run trace files (`run-*.events.jsonl` + `run-*.json`) under `.workbench/items/`
 * to empirically evaluate candidate idle timeout thresholds (FLOW §2.4 / WB-16).
 *
 * Usage:
 *   bun run scripts/replay-idle-timeout.ts [projectRoot] [--thresholds 180,300,600,900]
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface RunIdleSample {
  requirementId: string;
  runId: string;
  action: string;
  status: string;
  durationMs: number;
  maxGapMs: number | null;
  timedOut: boolean;
  insufficientReason?: string;
}

export interface ThresholdReplayStat {
  thresholdSeconds: number;
  falsePositiveSucceeded: number;
  hungRunsDetectedEarlier: number;
  totalTimeSavedMs: number;
  avgTimeSavedMs: number;
}

export interface IdleTimeoutReplayReport {
  scannedRuns: number;
  evaluableRuns: number;
  insufficientLogRuns: number;
  samples: RunIdleSample[];
  thresholds: ThresholdReplayStat[];
}

function readTraceTimestamps(tracePath: string): number[] | null {
  if (!fs.existsSync(tracePath)) return null;
  let content: string;
  try {
    content = fs.readFileSync(tracePath, "utf8");
  } catch {
    return null;
  }
  const timestamps: number[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as { ts?: unknown; type?: unknown };
      // Exclude `run.end` (written after post-run verification finishes) so test-suite runtime does not inflate idle gaps.
      if (parsed.type === "run.end") continue;
      if (typeof parsed.ts === "number" && Number.isFinite(parsed.ts)) {
        timestamps.push(parsed.ts);
      }
    } catch {
      // Skip malformed JSONL line.
    }
  }
  return timestamps.length > 0 ? timestamps : null;
}

export function collectRunIdleSamples(projectRoot: string, actions?: string[]): RunIdleSample[] {
  const itemsDir = path.join(path.resolve(projectRoot), ".workbench", "items");
  if (!fs.existsSync(itemsDir)) return [];
  const samples: RunIdleSample[] = [];
  const actionFilter = actions && actions.length > 0 ? new Set(actions) : null;

  for (const itemEntry of fs.readdirSync(itemsDir, { withFileTypes: true })) {
    if (!itemEntry.isDirectory()) continue;
    const runsDir = path.join(itemsDir, itemEntry.name, "runs");
    if (!fs.existsSync(runsDir)) continue;
    for (const fileEntry of fs.readdirSync(runsDir, { withFileTypes: true })) {
      if (
        !fileEntry.isFile() ||
        !fileEntry.name.startsWith("run-") ||
        !fileEntry.name.endsWith(".json") ||
        fileEntry.name.endsWith(".context.json")
      ) {
        continue;
      }
      const jsonPath = path.join(runsDir, fileEntry.name);
      let meta: Record<string, unknown>;
      try {
        meta = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      const action = typeof meta.action === "string" ? meta.action : "unknown";
      if (actionFilter && !actionFilter.has(action)) continue;
      const runId = typeof meta.id === "string" ? meta.id : fileEntry.name.replace(/^run-|\.json$/g, "");
      const status = typeof meta.status === "string" ? meta.status : "unknown";
      const startedAt = typeof meta.startedAt === "number" ? meta.startedAt : null;
      const durationMs = typeof meta.durationMs === "number" ? meta.durationMs : 0;
      const errorSummary = typeof meta.errorSummary === "string" ? meta.errorSummary : "";
      const timedOut =
        Boolean(meta.timedOut) ||
        /执行超时|无输出|idle|timed?\s*out/i.test(errorSummary);

      const tracePath = path.join(runsDir, `run-${runId}.events.jsonl`);
      const timestamps = readTraceTimestamps(tracePath);
      if (!timestamps || timestamps.length < 2) {
        samples.push({
          requirementId: itemEntry.name,
          runId,
          action,
          status,
          durationMs,
          maxGapMs: null,
          timedOut,
          insufficientReason: !timestamps ? "missing_trace_events" : "too_few_timestamps",
        });
        continue;
      }

      const timeline = [...timestamps];
      if (startedAt !== null && startedAt < timeline[0]!) timeline.unshift(startedAt);
      timeline.sort((a, b) => a - b);

      let maxGapMs = 0;
      for (let i = 1; i < timeline.length; i++) {
        const gap = timeline[i]! - timeline[i - 1]!;
        if (gap > maxGapMs) maxGapMs = gap;
      }
      samples.push({
        requirementId: itemEntry.name,
        runId,
        action,
        status,
        durationMs,
        maxGapMs,
        timedOut,
      });
    }
  }
  return samples;
}

export function replayIdleTimeouts(
  projectRoot: string,
  options: { thresholdSeconds?: number[]; actions?: string[] } = {},
): IdleTimeoutReplayReport {
  const thresholdsSec = options.thresholdSeconds ?? [180, 300, 600, 900];
  const samples = collectRunIdleSamples(projectRoot, options.actions);
  const evaluable = samples.filter((s) => s.maxGapMs !== null);
  const insufficientLogRuns = samples.length - evaluable.length;

  const thresholds: ThresholdReplayStat[] = thresholdsSec.map((sec) => {
    const thresholdMs = sec * 1000;
    let falsePositiveSucceeded = 0;
    let hungRunsDetectedEarlier = 0;
    let totalTimeSavedMs = 0;

    for (const s of evaluable) {
      const gap = s.maxGapMs!;
      if (s.status === "succeeded" && gap > thresholdMs) {
        falsePositiveSucceeded += 1;
      } else if (s.timedOut && gap > thresholdMs) {
        hungRunsDetectedEarlier += 1;
        totalTimeSavedMs += gap - thresholdMs;
      }
    }

    return {
      thresholdSeconds: sec,
      falsePositiveSucceeded,
      hungRunsDetectedEarlier,
      totalTimeSavedMs,
      avgTimeSavedMs: hungRunsDetectedEarlier > 0 ? Math.round(totalTimeSavedMs / hungRunsDetectedEarlier) : 0,
    };
  });

  return {
    scannedRuns: samples.length,
    evaluableRuns: evaluable.length,
    insufficientLogRuns,
    samples,
    thresholds,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let targetRoot = process.cwd();
  let thresholdSeconds: number[] | undefined;
  let actions: string[] | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--thresholds" && args[i + 1]) {
      thresholdSeconds = args[++i]!
        .split(",")
        .map((n) => Number(n.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
    } else if (arg === "--actions" && args[i + 1]) {
      actions = args[++i]!.split(",").map((a) => a.trim()).filter(Boolean);
    } else if (!arg.startsWith("-")) {
      targetRoot = arg;
    }
  }

  const report = replayIdleTimeouts(targetRoot, { thresholdSeconds, actions });
  console.log(
    JSON.stringify(
      {
        projectRoot: path.resolve(targetRoot),
        scannedRuns: report.scannedRuns,
        evaluableRuns: report.evaluableRuns,
        insufficientLogRuns: report.insufficientLogRuns,
        thresholds: report.thresholds,
      },
      null,
      2,
    ),
  );
}
