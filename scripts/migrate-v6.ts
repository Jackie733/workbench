#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteJson, canonicalRoot } from "../src/core/fs.ts";
import { SCHEMA_VERSION, WORKBENCH_DIR, type Stage } from "../src/core/types.ts";
import { validateProjectMetadata, validateRequirementState } from "../src/core/validate.ts";
import { discoverHarnessesQuick } from "../src/hub/discovery.ts";
import { buildInitialProjectRouting, normalizeRoutingConfig } from "../src/hub/routing.ts";
import type { HarnessInfo, RoutingConfig } from "../src/hub/types.ts";

export interface MigrateProjectResult {
  root: string;
  dryRun: boolean;
  projectMigrated: boolean;
  itemsMigrated: string[];
  itemsSkipped: string[];
  errors: Array<{ file: string; message: string }>;
}

function mapLegacyStage(rawStage: unknown, blockedFrom?: unknown): Stage {
  switch (rawStage) {
    case "planning":
    case "draft":
    case "designing":
    case "awaiting_approval":
      return "planning";
    case "coding":
    case "implementing":
    case "awaiting_acceptance":
      return "coding";
    case "done":
      return "done";
    case "cancelled":
      return "cancelled";
    case "blocked":
      return blockedFrom && blockedFrom !== "blocked" ? mapLegacyStage(blockedFrom) : "planning";
    default:
      return "planning";
  }
}

function convertLegacyRouting(raw: unknown, defaultRouting: RoutingConfig): RoutingConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return structuredClone(defaultRouting);
  }
  const obj = raw as Record<string, unknown>;
  // Already v6 format
  if (obj.defaultLead && obj.sotaLead && obj.reviewer) {
    return normalizeRoutingConfig(obj, defaultRouting);
  }
  // Legacy v4 format: { activePreset, stages: { design, implement, fix, review }, autoReview, autoHeal }
  const stages = obj.stages && typeof obj.stages === "object" ? (obj.stages as Record<string, unknown>) : null;
  const candidate = {
    defaultLead: stages?.implement ?? defaultRouting.defaultLead,
    sotaLead: stages?.design ?? defaultRouting.sotaLead,
    reviewer: stages?.review ?? defaultRouting.reviewer,
    ...(typeof obj.autoReview === "boolean" ? { autoReview: obj.autoReview } : { autoReview: true }),
    ...(typeof obj.autoHeal === "boolean" ? { autoHeal: obj.autoHeal } : { autoHeal: true }),
  };
  return normalizeRoutingConfig(candidate, defaultRouting);
}

export function migrateProjectToV6(
  root: string,
  options: { dryRun?: boolean; harnesses?: HarnessInfo[] } = {},
): MigrateProjectResult {
  const dryRun = options.dryRun === true;
  const base = canonicalRoot(root);
  const wbDir = path.join(base, WORKBENCH_DIR);
  const projectPath = path.join(wbDir, "project.json");
  const result: MigrateProjectResult = {
    root: base,
    dryRun,
    projectMigrated: false,
    itemsMigrated: [],
    itemsSkipped: [],
    errors: [],
  };

  if (!fs.existsSync(projectPath)) {
    result.errors.push({ file: projectPath, message: "未找到 .workbench/project.json" });
    return result;
  }

  const harnesses = options.harnesses ?? discoverHarnessesQuick();
  const defaultRouting = buildInitialProjectRouting(harnesses);

  try {
    const rawProject = JSON.parse(fs.readFileSync(projectPath, "utf8")) as Record<string, unknown>;
    const needsProjectUpdate =
      rawProject.schemaVersion !== SCHEMA_VERSION ||
      !rawProject.routing ||
      !(rawProject.routing as Record<string, unknown>).defaultLead;

    if (needsProjectUpdate) {
      const nextProject = {
        ...rawProject,
        schemaVersion: SCHEMA_VERSION,
        routing: convertLegacyRouting(rawProject.routing, defaultRouting),
        updatedAt: Date.now(),
      };
      validateProjectMetadata(nextProject);
      if (!dryRun) {
        atomicWriteJson(projectPath, nextProject);
      }
      result.projectMigrated = true;
    }
  } catch (err) {
    result.errors.push({ file: projectPath, message: err instanceof Error ? err.message : String(err) });
    return result;
  }

  const itemsDir = path.join(wbDir, "items");
  if (!fs.existsSync(itemsDir)) return result;

  for (const entry of fs.readdirSync(itemsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^REQ-\d{3,}$/.test(entry.name)) continue;
    const statePath = path.join(itemsDir, entry.name, "state.json");
    if (!fs.existsSync(statePath)) continue;

    try {
      const raw = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
      if (raw.schemaVersion === SCHEMA_VERSION) {
        validateRequirementState(raw, entry.name);
        result.itemsSkipped.push(entry.name);
        continue;
      }

      const nextStage = mapLegacyStage(raw.stage, raw.blockedFrom);
      const cancelReason =
        nextStage === "cancelled" && typeof raw.blockedReason === "string" && raw.blockedReason.trim()
          ? raw.blockedReason.trim()
          : undefined;

      const cleaned: Record<string, unknown> = { ...raw };
      delete cleaned.tasks;
      delete cleaned.handoffNote;
      delete cleaned.blockedFrom;
      delete cleaned.blockedReason;
      delete cleaned.reviewHistory;

      if (cleaned.reviewReport && typeof cleaned.reviewReport === "object" && !Array.isArray(cleaned.reviewReport)) {
        const rev = { ...(cleaned.reviewReport as Record<string, unknown>) };
        delete rev.round;
        delete rev.reviewMode;
        delete rev.changedFiles;
        cleaned.reviewReport = rev;
      }

      if (cleaned.github && typeof cleaned.github === "object" && !Array.isArray(cleaned.github)) {
        const gh = { ...(cleaned.github as Record<string, unknown>) };
        if (gh.issue && typeof gh.issue === "object" && !Array.isArray(gh.issue)) {
          const iss = { ...(gh.issue as Record<string, unknown>) };
          if (iss.lastSyncedStage !== undefined) {
            iss.lastSyncedStage = mapLegacyStage(iss.lastSyncedStage);
          }
          gh.issue = iss;
        }
        cleaned.github = gh;
      }

      const nextState = {
        ...cleaned,
        schemaVersion: SCHEMA_VERSION,
        stage: nextStage,
        tier: cleaned.tier === "sota" ? "sota" : "standard",
        ...(cancelReason ? { cancelReason } : {}),
      };

      validateRequirementState(nextState, entry.name);
      if (!dryRun) {
        atomicWriteJson(statePath, nextState);
      }
      result.itemsMigrated.push(entry.name);
    } catch (err) {
      result.errors.push({ file: statePath, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const roots = argv.filter((a) => !a.startsWith("-"));
  if (roots.length === 0) {
    process.stderr.write("用法: bun run scripts/migrate-v6.ts [--dry-run] <projectRoot> [...]\n");
    process.exit(1);
  }
  let hasError = false;
  for (const r of roots) {
    const res = migrateProjectToV6(r, { dryRun });
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    if (res.errors.length > 0) hasError = true;
  }
  process.exit(hasError ? 1 : 0);
}
