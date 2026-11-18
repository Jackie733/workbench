import { afterEach, describe, expect, test } from "bun:test";
import type { RequirementState, ValidityReport } from "../../src/core/types.ts";
import { deriveActionBanner, evaluateAcceptanceGate } from "../../src/core/validity.ts";
import { ApiClientError } from "../../src/web/api.ts";
import {
  applyDocumentLanguage,
  CATALOGS,
  DEFAULT_UI_LANGUAGE,
  describeClientError,
  formatDateTime,
  formatNumber,
  formatRelativeTime,
  normalizeUiLanguage,
  persistUiLanguage,
  pluralMessage,
  readStoredUiLanguage,
  t,
  translateRef,
  UI_LANGUAGE_STORAGE_KEY,
  uiMessage,
  uiLanguageName,
  type MessageKey,
} from "../../src/web/i18n.ts";
import { describeEvidenceContext } from "../../src/web/state.ts";
import { useUiStore } from "../../src/web/stores/uiStore.ts";

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

function makeThrowingStorage(): { getItem(key: string): string | null; setItem(key: string, value: string): void } {
  return {
    getItem: () => {
      throw new Error("storage blocked");
    },
    setItem: () => {
      throw new Error("storage blocked");
    },
  };
}

const legacyValidity = {
  evidenceContext: "legacy-unavailable",
  provenance: {
    context: "legacy-unavailable",
    coverageSource: "unavailable",
    artifactStatus: "none",
    reason: "历史验收记录未固化代码差异快照，无法从当前工作区回溯",
    acceptedAt: Date.now() - 60_000,
    snapshotId: null,
    snapshotPath: null,
    snapshotCapturedAt: null,
    specHash: "a".repeat(64),
    codeSnapshotHash: "b".repeat(64),
    verificationIds: ["V-1"],
    diffStatus: "unavailable",
    diffBytes: 0,
    diffTruncated: false,
    fileCount: 0,
    commitCount: 0,
    baselineHead: null,
    observedHead: null,
    scopeNote: null,
  },
} as unknown as ValidityReport;

describe("i18n catalogs", () => {
  test("both languages expose exactly the same typed message keys", () => {
    expect(Object.keys(CATALOGS.en).sort()).toEqual(Object.keys(CATALOGS["zh-CN"]).sort());
    expect(Object.keys(CATALOGS["zh-CN"]).length).toBeGreaterThan(300);
  });

  test("every message pair keeps identical placeholders", () => {
    for (const key of Object.keys(CATALOGS["zh-CN"]) as MessageKey[]) {
      expect(placeholders(CATALOGS.en[key]), `placeholder mismatch for ${key}`).toEqual(
        placeholders(CATALOGS["zh-CN"][key]),
      );
    }
  });

  test("runtime gaps fall back to Chinese and unknown keys keep readable fallback text", () => {
    const saved = CATALOGS.en["common.cancel"];
    try {
      delete (CATALOGS.en as Record<string, string>)["common.cancel"];
      expect(t("en", "common.cancel")).toBe("取消");
    } finally {
      (CATALOGS.en as Record<string, string>)["common.cancel"] = saved;
    }
    expect(translateRef("en", "legacy.unknown.key", "旧版原文详情")).toBe("旧版原文详情");
    expect(translateRef("en", undefined, "旧版原文详情")).toBe("旧版原文详情");
    expect(uiMessage("en", { key: "toast.unblocked" }, "fallback")).toBe(t("en", "toast.unblocked"));
    expect(uiMessage("en", undefined, "raw detail")).toBe("raw detail");
  });

  test("language normalization accepts only supported values", () => {
    expect(normalizeUiLanguage("en")).toBe("en");
    expect(normalizeUiLanguage(" zh-CN ")).toBe("zh-CN");
    expect(normalizeUiLanguage("fr")).toBeUndefined();
    expect(normalizeUiLanguage(null)).toBeUndefined();
    expect(normalizeUiLanguage(42)).toBeUndefined();
    expect(uiLanguageName("zh-CN")).toBe("简体中文");
    expect(uiLanguageName("en")).toBe("English");
  });
});

describe("preference storage", () => {
  test("missing, invalid, or unreadable preferences resolve to Simplified Chinese", () => {
    expect(DEFAULT_UI_LANGUAGE).toBe("zh-CN");
    expect(readStoredUiLanguage({ getItem: () => null, setItem: () => {} })).toBe("zh-CN");
    expect(readStoredUiLanguage({ getItem: () => "fr", setItem: () => {} })).toBe("zh-CN");
    expect(readStoredUiLanguage(makeThrowingStorage())).toBe("zh-CN");
    expect(readStoredUiLanguage(null)).toBe("zh-CN");
    expect(readStoredUiLanguage({ getItem: () => "en", setItem: () => {} })).toBe("en");
  });

  test("storage write failures keep the in-memory language and do not throw", () => {
    expect(persistUiLanguage("en", makeThrowingStorage())).toBe(false);
    expect(persistUiLanguage("en", null)).toBe(false);
    let stored: Record<string, string> = {};
    expect(
      persistUiLanguage("en", {
        getItem: (key) => stored[key] ?? null,
        setItem: (key, value) => {
          stored = { ...stored, [key]: value };
        },
      }),
    ).toBe(true);
    expect(stored[UI_LANGUAGE_STORAGE_KEY]).toBe("en");
  });

  test("store switches language in memory even when persistence is unavailable", () => {
    const original = useUiStore.getState().language;
    try {
      useUiStore.getState().setLanguage("en");
      expect(useUiStore.getState().language).toBe("en");
      useUiStore.getState().setLanguage("zh-CN");
      expect(useUiStore.getState().language).toBe("zh-CN");
    } finally {
      useUiStore.getState().setLanguage(original);
    }
  });
});

describe("locale formatting", () => {
  test("numbers use the explicit locale", () => {
    expect(formatNumber("en", 1234567)).toBe(new Intl.NumberFormat("en-US").format(1234567));
    expect(formatNumber("zh-CN", 1234567)).toBe(new Intl.NumberFormat("zh-CN").format(1234567));
  });

  test("dates render in the explicit locale", () => {
    const fixed = new Date(2026, 10, 18, 8, 5, 9).getTime();
    const en = formatDateTime("en", fixed);
    const zh = formatDateTime("zh-CN", fixed);
    expect(en).toBe(
      new Intl.DateTimeFormat("en-US", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(new Date(fixed)),
    );
    expect(zh).toBe(
      new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(new Date(fixed)),
    );
    expect(en).not.toBe(zh);
  });

  test("relative time and plural counts follow the language", () => {
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    expect(formatRelativeTime("en", fiveMinutesAgo)).toBe(
      new Intl.RelativeTimeFormat("en-US", { numeric: "auto" }).format(-5, "minute"),
    );
    expect(formatRelativeTime("zh-CN", fiveMinutesAgo)).toBe(
      new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" }).format(-5, "minute"),
    );
    expect(pluralMessage("en", 1, "shot.countOne", "shot.countOther", { count: 1 })).toBe("1 screenshot");
    expect(pluralMessage("en", 2, "shot.countOne", "shot.countOther", { count: 2 })).toBe("2 screenshots");
    expect(pluralMessage("zh-CN", 2, "shot.countOne", "shot.countOther", { count: 2 })).toBe("2 张");
  });

  test("document language and title follow the selected interface language", () => {
    const attrs: Record<string, string> = {};
    const fakeDoc = {
      documentElement: { setAttribute: (name: string, value: string) => void (attrs[name] = value) },
      title: "",
    } as unknown as Document;
    applyDocumentLanguage("en", fakeDoc);
    expect(attrs.lang).toBe("en");
    expect(fakeDoc.title).toContain("Spec & Verification");
    applyDocumentLanguage("zh-CN", fakeDoc);
    expect(attrs.lang).toBe("zh-CN");
    expect(fakeDoc.title).toContain("规范与验证");
  });
});

describe("status and error messages", () => {
  test("core banners and blockers expose stable message refs in both languages", () => {
    const state = {
      id: "REQ-001",
      stage: "blocked",
      track: "plan_first",
      designVersion: 0,
      designHash: "",
      criteria: [],
      tasks: [],
      blockedReason: "等待上游接口",
      lastFeedback: null,
    } as unknown as RequirementState;
    const approval = { valid: false, reason: "尚未批准技术方案", reasonKey: "core.approval.notApproved" };
    const coverage = { items: [], requiredTotal: 0, requiredPassed: 0, optionalTotal: 0, optionalPassed: 0 };
    const gate = evaluateAcceptanceGate(state, approval, coverage);
    expect(gate.blockerRefs?.map((r) => r.key)).toEqual([
      "core.gate.blocked",
      "core.approval.notApproved",
      "core.gate.noRequired",
    ]);
    const derived = deriveActionBanner(state, approval, coverage, gate);
    expect(derived.banner.headlineKey).toBe("core.banner.blocked");
    expect(translateRef("zh-CN", derived.banner.headlineKey, derived.banner.headline, derived.banner.headlineParams)).toBe(
      "需求受阻：等待上游接口",
    );
    expect(translateRef("en", derived.banner.headlineKey, derived.banner.headline, derived.banner.headlineParams)).toBe(
      "Requirement blocked: 等待上游接口",
    );
    expect(translateRef("en", gate.blockerRefs?.[2]?.key, gate.blockers[2]!)).toBe(
      "At least one required acceptance criterion is needed; empty coverage cannot pass",
    );
  });

  test("API error codes map to localized prompts while details stay readable", () => {
    expect(describeClientError("en", new ApiClientError("revision_conflict", "revision conflict"))).toBe(
      t("en", "error.revision_conflict"),
    );
    expect(describeClientError("zh-CN", new ApiClientError("not_found", "记录不存在"))).toContain(
      t("zh-CN", "error.not_found"),
    );
    const detailed = describeClientError("en", new ApiClientError("invalid_input", "路径不能为空"));
    expect(detailed).toContain(t("en", "error.invalid_input"));
    expect(detailed).toContain("路径不能为空");
    expect(describeClientError("en", new TypeError("fetch failed"))).toBe(t("en", "error.network"));
  });

  test("legacy evidence without message refs stays readable in English", () => {
    const diffView = {
      context: "legacy-unavailable",
      status: "unavailable",
      reason: "历史验收记录未固化代码差异快照，无法从当前工作区回溯",
      acceptedAt: Date.now(),
      snapshotId: null,
      snapshotCapturedAt: null,
      scopeNote: null,
      observation: null,
    } as const;
    const description = describeEvidenceContext(legacyValidity, diffView, "en");
    expect(description.title).toBe("Legacy acceptance record (no diff snapshot)");
    expect(description.unavailableReason).toContain("历史验收记录");
    expect(description.provenanceText).toContain("coverage source unavailable");
  });
});