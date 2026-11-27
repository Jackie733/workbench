import { describe, expect, test } from "bun:test";
import type { UiLanguageStorage } from "../../src/web/i18n.ts";
import {
  DEFAULT_GITEE_IMPORT_FILTER_PREFS,
  giteeFilterMemoryScope,
  loadGiteeImportFilterPrefs,
  saveGiteeImportFilterPrefs,
} from "../../src/web/giteeFilterPrefs.ts";

function createStorage(initial?: Record<string, string>): UiLanguageStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial ?? {}));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

const SCOPE = "repo:openstring/demo";
const STORAGE_KEY = `wb-gitee-import-filters::${SCOPE}`;

describe("giteeFilterMemoryScope", () => {
  test("repo slug wins, is trimmed/lowercased, then project metadata ID, then Hub project ID, then default", () => {
    expect(
      giteeFilterMemoryScope({
        repo: "OpenString/DeepMDT-Frontend-PC ",
        projectId: "meta-1",
        activeProjectId: "hub-1",
      }),
    ).toBe("repo:openstring/deepmdt-frontend-pc");
    expect(
      giteeFilterMemoryScope({ repo: "  ", projectId: "meta-1", activeProjectId: "hub-1" }),
    ).toBe("project:meta-1");
    expect(
      giteeFilterMemoryScope({ repo: null, projectId: null, activeProjectId: "hub-1" }),
    ).toBe("project:hub-1");
    expect(giteeFilterMemoryScope({})).toBe("default");
  });
});

describe("Gitee import filter preferences", () => {
  test("defaults to assigned-or-created with no facet filters", () => {
    expect(DEFAULT_GITEE_IMPORT_FILTER_PREFS).toEqual({
      filter: "all",
      statuses: [],
      projects: [],
    });
    expect(loadGiteeImportFilterPrefs(SCOPE, createStorage())).toEqual(DEFAULT_GITEE_IMPORT_FILTER_PREFS);
  });

  test("round-trips filters under the documented per-repo storage key", () => {
    const storage = createStorage();
    const saved = saveGiteeImportFilterPrefs(
      SCOPE,
      { filter: "created", statuses: ["开发中", "已验收"], projects: ["DeepMDT 3.0"] },
      storage,
    );

    expect(saved).toBe(true);
    expect(storage.data.has(STORAGE_KEY)).toBe(true);
    expect(JSON.parse(storage.data.get(STORAGE_KEY)!)).toEqual({
      v: 1,
      filter: "created",
      statuses: ["开发中", "已验收"],
      projects: ["DeepMDT 3.0"],
    });
    expect(loadGiteeImportFilterPrefs(SCOPE, storage)).toEqual({
      filter: "created",
      statuses: ["开发中", "已验收"],
      projects: ["DeepMDT 3.0"],
    });
  });

  test("keeps repositories isolated from each other", () => {
    const storage = createStorage();
    saveGiteeImportFilterPrefs(
      "repo:openstring/alpha",
      { filter: "assigned", statuses: ["待办"], projects: ["Alpha"] },
      storage,
    );
    saveGiteeImportFilterPrefs(
      "repo:openstring/beta",
      { filter: "created", statuses: ["已验收"], projects: ["Beta"] },
      storage,
    );

    expect(loadGiteeImportFilterPrefs("repo:openstring/alpha", storage)).toEqual({
      filter: "assigned",
      statuses: ["待办"],
      projects: ["Alpha"],
    });
    expect(loadGiteeImportFilterPrefs("repo:openstring/beta", storage)).toEqual({
      filter: "created",
      statuses: ["已验收"],
      projects: ["Beta"],
    });
    expect(loadGiteeImportFilterPrefs("repo:openstring/gamma", storage)).toEqual(
      DEFAULT_GITEE_IMPORT_FILTER_PREFS,
    );
  });

  test("falls back safely for corrupted JSON, non-objects, and unknown versions", () => {
    for (const raw of [
      "{not-json",
      "[]",
      "null",
      '"text"',
      JSON.stringify({ v: 2, filter: "created", statuses: ["待办"], projects: ["P"] }),
      JSON.stringify({ filter: "created", statuses: ["待办"] }),
    ]) {
      expect(loadGiteeImportFilterPrefs(SCOPE, createStorage({ [STORAGE_KEY]: raw }))).toEqual(
        DEFAULT_GITEE_IMPORT_FILTER_PREFS,
      );
    }
  });

  test("falls back to assigned-or-created for unknown filters while keeping valid facets", () => {
    const loaded = loadGiteeImportFilterPrefs(
      SCOPE,
      createStorage({
        [STORAGE_KEY]: JSON.stringify({
          v: 1,
          filter: "collaborator",
          statuses: ["待办"],
          projects: ["DeepMDT 3.0"],
        }),
      }),
    );
    expect(loaded).toEqual({
      filter: "all",
      statuses: ["待办"],
      projects: ["DeepMDT 3.0"],
    });
  });

  test("drops non-strings and empty values, dedupes, and caps facet lists at 200 entries", () => {
    const loaded = loadGiteeImportFilterPrefs(
      SCOPE,
      createStorage({
        [STORAGE_KEY]: JSON.stringify({
          v: 1,
          filter: "assigned",
          statuses: ["待办", "待办", "", "   ", 3, null, { name: "x" }, "进行中"],
          projects: "not-an-array",
        }),
      }),
    );
    expect(loaded.statuses).toEqual(["待办", "进行中"]);
    expect(loaded.projects).toEqual([]);

    const many = Array.from({ length: 250 }, (_, index) => `状态-${index}`);
    const storage = createStorage();
    saveGiteeImportFilterPrefs(SCOPE, { filter: "all", statuses: many, projects: [] }, storage);
    expect(loadGiteeImportFilterPrefs(SCOPE, storage).statuses).toHaveLength(200);
  });

  test("clears an older record when a new write is rejected, so reopening falls back to defaults", () => {
    const data = new Map<string, string>([
      [
        STORAGE_KEY,
        JSON.stringify({ v: 1, filter: "assigned", statuses: ["开发中"], projects: ["DeepMDT 3.0"] }),
      ],
    ]);
    const quotaStorage: UiLanguageStorage & { data: Map<string, string> } = {
      data,
      getItem: (key) => data.get(key) ?? null,
      setItem: () => {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      },
      removeItem: (key) => {
        data.delete(key);
      },
    };

    expect(
      saveGiteeImportFilterPrefs(
        SCOPE,
        { filter: "created", statuses: [], projects: [] },
        quotaStorage,
      ),
    ).toBe(false);
    expect(data.has(STORAGE_KEY)).toBe(false);
    expect(loadGiteeImportFilterPrefs(SCOPE, quotaStorage)).toEqual(DEFAULT_GITEE_IMPORT_FILTER_PREFS);
  });

  test("returns defaults and false when storage access throws", () => {
    const throwingRead: UiLanguageStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => undefined,
    };
    const throwingWrite: UiLanguageStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };

    expect(loadGiteeImportFilterPrefs(SCOPE, throwingRead)).toEqual(DEFAULT_GITEE_IMPORT_FILTER_PREFS);
    expect(
      saveGiteeImportFilterPrefs(
        SCOPE,
        { filter: "created", statuses: [], projects: [] },
        throwingWrite,
      ),
    ).toBe(false);
  });
});
