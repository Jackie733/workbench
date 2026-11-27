import type { GiteeIssueFilter } from "../core/gitee.ts";
import { readStorageItem, removeStorageItem, writeStorageItem, type UiLanguageStorage } from "./i18n.ts";

const STORAGE_KEY_PREFIX = "wb-gitee-import-filters::";
const PREFS_VERSION = 1;
const MAX_FACET_VALUES = 200;
const VALID_FILTERS: readonly GiteeIssueFilter[] = ["assigned", "created", "all"];

export interface GiteeImportFilterPrefs {
  filter: GiteeIssueFilter;
  statuses: string[];
  projects: string[];
}

export const DEFAULT_GITEE_IMPORT_FILTER_PREFS: GiteeImportFilterPrefs = {
  filter: "all",
  statuses: [],
  projects: [],
};

function defaultPrefs(): GiteeImportFilterPrefs {
  return {
    filter: DEFAULT_GITEE_IMPORT_FILTER_PREFS.filter,
    statuses: [],
    projects: [],
  };
}

function nonEmptyScopeValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Builds a stable per-repository localStorage scope.
 * Repository slug wins so multiple Hub projects sharing one Gitee repo share the same
 * remembered filters; enterprise-only projects fall back to their project ID.
 */
export function giteeFilterMemoryScope(input: {
  repo?: string | null;
  projectId?: string | null;
  activeProjectId?: string | null;
}): string {
  const repo = nonEmptyScopeValue(input.repo);
  if (repo) return `repo:${repo.toLowerCase()}`;
  const projectId = nonEmptyScopeValue(input.projectId);
  if (projectId) return `project:${projectId}`;
  const activeProjectId = nonEmptyScopeValue(input.activeProjectId);
  if (activeProjectId) return `project:${activeProjectId}`;
  return "default";
}

function storageKey(scope: string): string {
  return `${STORAGE_KEY_PREFIX}${scope}`;
}

function normalizeFacetValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "" || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= MAX_FACET_VALUES) break;
  }
  return out;
}

function normalizeFilter(value: unknown): GiteeIssueFilter {
  return typeof value === "string" && (VALID_FILTERS as readonly string[]).includes(value)
    ? (value as GiteeIssueFilter)
    : DEFAULT_GITEE_IMPORT_FILTER_PREFS.filter;
}

/** Reads and validates the remembered filters for one repository scope. Never throws. */
export function loadGiteeImportFilterPrefs(
  scope: string,
  storage?: UiLanguageStorage | null,
): GiteeImportFilterPrefs {
  const raw = readStorageItem(storageKey(scope), storage);
  if (!raw) return defaultPrefs();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaultPrefs();
    const record = parsed as Record<string, unknown>;
    if (record.v !== PREFS_VERSION) return defaultPrefs();
    return {
      filter: normalizeFilter(record.filter),
      statuses: normalizeFacetValues(record.statuses),
      projects: normalizeFacetValues(record.projects),
    };
  } catch {
    return defaultPrefs();
  }
}

/** Persists filters for one repository scope. Returns false when storage is unavailable. */
export function saveGiteeImportFilterPrefs(
  scope: string,
  prefs: GiteeImportFilterPrefs,
  storage?: UiLanguageStorage | null,
): boolean {
  const payload = {
    v: PREFS_VERSION,
    filter: normalizeFilter(prefs.filter),
    statuses: normalizeFacetValues(prefs.statuses),
    projects: normalizeFacetValues(prefs.projects),
  };
  const key = storageKey(scope);
  const saved = writeStorageItem(key, JSON.stringify(payload), storage);
  if (!saved) {
    // A failed write must not resurrect an older preference set on the next open.
    // Remove the stale record when storage still allows deletion so reopening falls back to defaults.
    removeStorageItem(key, storage);
  }
  return saved;
}
