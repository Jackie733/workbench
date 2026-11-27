import { afterEach, describe, expect, test } from "bun:test";
import type { RequirementState, ValidityReport } from "../../src/core/types.ts";
import { deriveActionBanner, evaluateAcceptanceGate } from "../../src/core/validity.ts";
import { ApiClientError } from "../../src/web/api.ts";
import { buildGiteeReasonMessageDetails } from "../../src/core/gitee.ts";
import { resolveBrowserEnvironment } from "../../src/core/screenshots.ts";
import {
  applyDocumentLanguage,
  CATALOGS,
  DEFAULT_UI_LANGUAGE,
  describeClientError,
  describeClientErrorRef,
  formatAgentActionLabel,
  formatAgentStatusLabel,
  formatDateTime,
  formatGitFileStatusLabel,
  formatGiteeStatusReason,
  formatGitHubStatusReason,
  formatNumber,
  formatPrStateLabel,
  formatRelativeTime,
  normalizeUiLanguage,
  persistUiLanguage,
  pluralMessage,
  prStateRef,
  readStorageItem,
  readStoredUiLanguage,
  resolveWarningParam,
  t,
  translateRef,
  UI_LANGUAGE_STORAGE_KEY,
  uiMessage,
  uiLanguageName,
  writeStorageItem,
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
    expect(readStorageItem("wb-theme", makeThrowingStorage())).toBeNull();
    expect(writeStorageItem("wb-theme", "dark", makeThrowingStorage())).toBe(false);
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
      stage: "planning",
      track: "plan_first",
      designVersion: 0,
      designHash: "",
      criteria: [],
      lastFeedback: null,
    } as unknown as RequirementState;
    const approval = { valid: false, reason: "尚未批准技术方案", reasonKey: "core.approval.notApproved" };
    const coverage = { items: [], requiredTotal: 0, requiredPassed: 0, optionalTotal: 0, optionalPassed: 0 };
    const gate = evaluateAcceptanceGate(state, approval, coverage);
    expect(gate.blockerRefs?.map((r) => r.key)).toEqual([
      "core.approval.notApproved",
      "core.gate.noRequired",
    ]);
    const derived = deriveActionBanner(state, approval, coverage, gate);
    expect(derived.banner.headlineKey).toBe("core.banner.draft");
    expect(translateRef("zh-CN", derived.banner.headlineKey, derived.banner.headline, derived.banner.headlineParams)).toBeTruthy();
    expect(translateRef("en", derived.banner.headlineKey, derived.banner.headline, derived.banner.headlineParams)).toBeTruthy();
    expect(translateRef("en", gate.blockerRefs?.[1]?.key, gate.blockers[1]!)).toBe(
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

  test("already-visible client errors keep message keys so language switches re-render them", () => {
    const detailed = describeClientErrorRef(new ApiClientError("invalid_input", "路径不能为空"));
    expect(detailed.key).toBe("error.withDetail");
    expect(t("en", detailed.key!, detailed.params)).toContain(t("en", "error.invalid_input"));
    expect(t("en", detailed.key!, detailed.params)).toContain("路径不能为空");
    expect(t("zh-CN", detailed.key!, detailed.params)).toContain(t("zh-CN", "error.invalid_input"));
    expect(detailed.text).toBe("路径不能为空");

    const pin = describeClientErrorRef(new ApiClientError("unauthorized", "invalid pin"));
    expect(pin.key).toBe("error.unauthorized");
    expect(t("en", "login.invalidPin")).toBe("Incorrect access PIN; try again");
    expect(t("zh-CN", "login.invalidPin")).toBe("访问密码错误，请重试");

    const network = describeClientErrorRef(new TypeError("fetch failed"));
    expect(network.key).toBe("error.network");
    expect(t("zh-CN", network.key!)).toContain("网络请求失败");

    const unknown = describeClientErrorRef(new Error("upstream said no"));
    expect(unknown.key).toBeNull();
    expect(unknown.text).toBe("upstream said no");
  });

  test("screenshot skips expose stable reason codes with localized prompts", () => {
    const original = process.env.WORKBENCH_CHROME_PATH;
    process.env.WORKBENCH_CHROME_PATH = "/definitely/missing/chrome";
    try {
      const environment = resolveBrowserEnvironment();
      expect(environment.ok).toBe(false);
      expect(environment.reasonCode).toBe("chrome_path_missing");
      expect(t("en", "shot.reason.chrome_path_missing", environment.reasonParams)).toContain("does not exist");
      expect(t("zh-CN", "shot.reason.chrome_path_missing", environment.reasonParams)).toContain("不存在");
    } finally {
      if (original === undefined) delete process.env.WORKBENCH_CHROME_PATH;
      else process.env.WORKBENCH_CHROME_PATH = original;
    }

    for (const key of [
      "shot.reason.browser_missing",
      "shot.reason.puppeteer_path_missing",
      "shot.reason.server_unavailable",
      "shot.reason.browser_launch_failed",
      "shot.reason.no_shots",
    ] as const) {
      expect(t("en", key)).not.toBe(t("zh-CN", key));
    }
  });

  test("review-gated banners keep stable message refs in both languages", () => {
    const state = {
      id: "REQ-001",
      stage: "coding",
      track: "plan_first",
      designVersion: 1,
      designHash: "d".repeat(64),
      criteria: [{ id: "AC-1", description: "passes", required: true, command: "echo ok" }],
      lastFeedback: null,
      reviewReport: {
        verdict: "block",
        summary: "Found two blocking issues",
        findings: [
          { id: "F-1", severity: "high", title: "issue one" },
          { id: "F-2", severity: "medium", title: "issue two" },
        ],
      },
    } as unknown as RequirementState;
    const approval = { valid: true, reason: null };
    const coverage = {
      items: [{ criterion: state.criteria[0]!, state: "passed" as const, verificationIds: ["V-1"], reason: null }],
      requiredTotal: 1,
      requiredPassed: 1,
      optionalTotal: 0,
      optionalPassed: 0,
    };
    const gate = { ok: true, blockers: [], blockerRefs: [] };
    const current = deriveActionBanner(state, approval, coverage, gate, {
      effectiveState: "current",
      reason: null,
    });
    expect(current.banner.headlineKey).toBe("core.banner.review.block");
    expect(current.decisionReasonKey).toBe("core.decision.reviewBlock");
    const enHeadline = translateRef("en", current.banner.headlineKey, current.banner.headline, current.banner.headlineParams);
    expect(enHeadline).toContain("Cross-model review recommends blocking");
    expect(enHeadline).toContain("(high 1 / medium 1)");
    expect(enHeadline).toContain("Found two blocking issues");
    const zhHeadline = translateRef("zh-CN", current.banner.headlineKey, current.banner.headline, current.banner.headlineParams);
    expect(zhHeadline).toContain("跨模型审查建议阻塞");
    expect(zhHeadline).toContain("（高 1 / 中 1）");
    expect(translateRef("en", current.decisionReasonKey!, current.decisionReason!)).toBe(
      "Review recommends blocking",
    );
    expect(
      translateRef(
        "en",
        current.banner.primaryAction?.labelKey,
        current.banner.primaryAction?.label ?? "",
      ),
    ).toBe("Let the agent fix review findings");

    const staleBlock = deriveActionBanner(state, approval, coverage, gate, {
      effectiveState: "stale",
      reason: "审查后工作区代码已有新改动，建议复审",
      reasonKey: "core.review.staleCode",
    });
    expect(staleBlock.banner.headlineKey).toBe("core.banner.review.staleBlock");
    const staleBlockEn = translateRef(
      "en",
      staleBlock.banner.headlineKey,
      staleBlock.banner.headline,
      staleBlock.banner.headlineParams,
    );
    expect(staleBlockEn).toContain("prior blocking review is stale");
    const staleBlockZh = translateRef(
      "zh-CN",
      staleBlock.banner.headlineKey,
      staleBlock.banner.headline,
      staleBlock.banner.headlineParams,
    );
    expect(staleBlockZh).toContain("阻塞级（block）审查已过期");

    const concernState = {
      ...state,
      reviewReport: { ...state.reviewReport!, verdict: "concern" as const },
    };
    const stale = deriveActionBanner(concernState, approval, coverage, gate, {
      effectiveState: "stale",
      reason: "审查后工作区代码已有新改动，建议复审",
      reasonKey: "core.review.staleCode",
    });
    expect(stale.banner.headlineKey).toBe("core.banner.review.stale");
    const staleEn = translateRef("en", stale.banner.headlineKey, stale.banner.headline, stale.banner.headlineParams);
    expect(staleEn).toContain("cross-model review is stale");
    expect(staleEn).toContain("Workspace code changed since the review");
    const staleZh = translateRef("zh-CN", stale.banner.headlineKey, stale.banner.headline, stale.banner.headlineParams);
    expect(staleZh).toContain("跨模型审查已过期");
    expect(staleZh).toContain("审查后工作区代码已有新改动");
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

  test("localizes Gitee and GitHub status reasons while preserving upstream error details", () => {
    expect(
      formatGiteeStatusReason("en", {
        tokenConfigured: false,
        authenticated: false,
        repo: null,
        reason: "尚未配置 Gitee 私人令牌",
        reasonCode: "token_missing",
      }),
    ).toContain("Gitee Access Token is not configured yet");
    expect(
      formatGiteeStatusReason("zh-CN", {
        tokenConfigured: false,
        authenticated: false,
        repo: null,
        reason: null,
      }),
    ).toContain("尚未配置 Gitee 私人令牌");

    expect(
      formatGiteeStatusReason("en", {
        tokenConfigured: true,
        authenticated: false,
        repo: null,
        reason: "Gitee API 请求失败 (401): Unauthorized",
        reasonCode: "auth_failed",
        httpStatus: 401,
        reasonDetail: "Unauthorized",
      }),
    ).toBe("Gitee Access Token verification failed (HTTP 401): Unauthorized");
    expect(
      formatGiteeStatusReason("zh-CN", {
        tokenConfigured: true,
        authenticated: false,
        repo: null,
        reason: "Gitee API 请求失败 (401): Unauthorized",
        reasonCode: "auth_failed",
        httpStatus: 401,
        reasonDetail: "Unauthorized",
      }),
    ).toBe("Gitee 私人令牌验证失败 (HTTP 401)：Unauthorized");
    expect(
      formatGiteeStatusReason("en", {
        tokenConfigured: true,
        authenticated: false,
        repo: null,
        reason: "连接 Gitee API 失败: ECONNREFUSED",
        reasonCode: "network_failed",
        reasonDetail: "ECONNREFUSED",
      }),
    ).toBe("Failed to connect to Gitee API: ECONNREFUSED");
    expect(
      formatGiteeStatusReason("en", {
        tokenConfigured: true,
        authenticated: false,
        repo: null,
        reason: "Upstream auth rejected",
      }),
    ).toBe("Gitee Access Token verification failed: Upstream auth rejected");
    expect(
      describeClientError(
        "en",
        new ApiClientError("execution_failed", "Gitee API 请求失败 (401): Unauthorized", {
          upstreamErrorCode: "gitee_api_http_error",
          upstreamStatus: 401,
          upstreamDetail: "Unauthorized",
        }),
      ),
    ).toBe("Gitee API request failed (HTTP 401): Unauthorized");
    expect(
      formatGiteeStatusReason("en", {
        tokenConfigured: true,
        authenticated: true,
        repo: null,
        reason: "当前项目尚未配置 Gitee 仓库",
      }),
    ).toContain("No Gitee repository configured");

    expect(
      formatGitHubStatusReason("en", {
        ghInstalled: false,
        authenticated: false,
        repo: null,
        reason: "本机未安装 gh CLI",
        reasonCode: "gh_missing",
      }),
    ).toContain("gh CLI is not installed");
    expect(
      formatGitHubStatusReason("en", {
        ghInstalled: true,
        authenticated: false,
        repo: null,
        reason: "gh CLI 尚未登录",
      }),
    ).toContain("gh CLI is not authenticated");
    expect(
      formatGitHubStatusReason("en", {
        ghInstalled: true,
        authenticated: true,
        repo: null,
        reason: "当前项目尚未配置 GitHub 仓库",
      }),
    ).toContain("No GitHub repository configured");

    expect(
      describeClientError(
        "en",
        new ApiClientError("invalid_input", "请输入有效的 Gitee 工作项编号", {
          messageKey: "gitee.errInvalidIssueRef",
        }),
      ),
    ).toBe("Please enter a valid Gitee work item ID (such as I8ABCD or #I8ABCD) or full Gitee work item URL");
    expect(
      describeClientError(
        "zh-CN",
        new ApiClientError("invalid_input", "无效的 Gitee 工作项编号: bad!", {
          messageKey: "gitee.errInvalidIssueIdent",
          messageParams: { ident: "bad!" },
        }),
      ),
    ).toBe("无效的 Gitee 工作项编号：bad!");
    expect(
      describeClientError(
        "en",
        new ApiClientError("invalid_input", "无效的 Gitee 工作项编号: bad!", {
          messageKey: "gitee.errInvalidIssueIdent",
          messageParams: { ident: "bad!" },
        }),
      ),
    ).toBe("Invalid Gitee work item ID: bad!");
    expect(
      describeClientError(
        "en",
        new ApiClientError("invalid_input", "请输入有效的 GitHub Issue 编号（如 #42）或完整 Issue URL", {
          messageKey: "github.errInvalidIssueRef",
        }),
      ),
    ).toBe("Please enter a valid GitHub Issue number (such as #42) or full Issue URL");
    expect(
      describeClientError(
        "en",
        new ApiClientError("invalid_input", "无效的 GitHub 仓库标识（应为 owner/repo）: bad/slug/extra", {
          messageKey: "github.errInvalidRepo",
          messageParams: { repo: "bad/slug/extra" },
        }),
      ),
    ).toBe("Invalid GitHub repository slug (expected owner/repo): bad/slug/extra");
    expect(
      describeClientError(
        "en",
        new ApiClientError("invalid_input", "非法的 Git 分支名: bad branch", {
          messageKey: "git.errInvalidBranch",
          messageParams: { branch: "bad branch" },
        }),
      ),
    ).toBe("Invalid Git branch name: bad branch");
    expect(
      describeClientError(
        "en",
        new ApiClientError("execution_failed", "创建 GitHub Issue 失败: API rate limit exceeded", {
          messageKey: "github.errCreateIssueFailedDetail",
          messageParams: { detail: "API rate limit exceeded" },
        }),
      ),
    ).toBe("Failed to create GitHub Issue: API rate limit exceeded");
    expect(
      describeClientError(
        "en",
        new ApiClientError("execution_failed", "创建 GitHub PR 失败: Permission denied", {
          messageKey: "github.errCreatePrFailedDetail",
          messageParams: { detail: "Permission denied" },
        }),
      ),
    ).toBe("Failed to create GitHub PR: Permission denied");
    expect(
      describeClientError(
        "en",
        new ApiClientError("execution_failed", "查询 PR #42 状态失败: Could not resolve", {
          messageKey: "github.errViewPrFailedDetail",
          messageParams: { number: 42, detail: "Could not resolve" },
        }),
      ),
    ).toBe("Failed to query PR #42 status: Could not resolve");
    expect(
      describeClientError(
        "en",
        new ApiClientError("revision_conflict", "本地分支 feat/demo 已存在", {
          messageKey: "git.errBranchExists",
          messageParams: { branch: "feat/demo" },
        }),
      ),
    ).toBe("Local branch feat/demo already exists; use another branch name or switch to it first");

    const giteeAuthDetails = buildGiteeReasonMessageDetails({
      tokenConfigured: true,
      authenticated: false,
      repo: "owner/repo",
      reasonCode: "auth_failed",
      httpStatus: 401,
      reasonDetail: "Unauthorized",
    });
    expect(
      describeClientError("en", new ApiClientError("execution_failed", "Gitee API 请求失败 (401): Unauthorized", giteeAuthDetails)),
    ).toBe("Gitee Access Token verification failed (HTTP 401): Unauthorized");
    const giteeNetDetails = buildGiteeReasonMessageDetails({
      tokenConfigured: true,
      authenticated: false,
      repo: "owner/repo",
      reasonCode: "network_failed",
      reasonDetail: "ECONNREFUSED",
    });
    expect(
      describeClientError("en", new ApiClientError("execution_failed", "连接 Gitee API 失败: ECONNREFUSED", giteeNetDetails)),
    ).toBe("Failed to connect to Gitee API: ECONNREFUSED");
    expect(
      buildGiteeReasonMessageDetails({
        tokenConfigured: true,
        authenticated: false,
        repo: null,
        reasonCode: "auth_invalid_response",
      }).messageKey,
    ).toBe("gitee.reasonAuthInvalid");

    const nestedWarn = resolveWarningParam("创建 GitHub Issue 失败: API quota exceeded", {
      key: "github.errCreateIssueFailedDetail",
      params: { detail: "API quota exceeded" },
    });
    expect(t("en", "toast.createdWithIssueWarn", { id: "REQ-009", warning: nestedWarn })).toBe(
      "Requirement REQ-009 created (GitHub issue sync warning: Failed to create GitHub Issue: API quota exceeded)",
    );
    expect(t("zh-CN", "toast.createdWithIssueWarn", { id: "REQ-009", warning: nestedWarn })).toBe(
      "需求 REQ-009 已创建（GitHub Issue 未同步：创建 GitHub Issue 失败：API quota exceeded）",
    );
    const syncWarn = resolveWarningParam("向 Issue #12 发送评论失败: Upstream sync blocked", {
      key: "github.errCommentIssueFailedDetail",
      params: { number: 12, detail: "Upstream sync blocked" },
    });
    expect(t("en", "deliver.prCreatedWarn", { num: 42, warning: syncWarn })).toBe(
      "Created PR #42 (issue sync warning: Failed to comment on Issue #12: Upstream sync blocked)",
    );

    const reportWarn = resolveWarningParam("创建 GitHub Issue 失败: API quota exceeded", {
      key: "github.errCreateIssueFailedDetail",
      params: { detail: "API quota exceeded" },
    });
    expect(t("en", "report.promotedWarn", { id: "REQ-010", warning: reportWarn })).toBe(
      "Created requirement REQ-010 with a sandbox (issue sync warning: Failed to create GitHub Issue: API quota exceeded)",
    );

    const gateErr = new ApiClientError("acceptance_gate_failed", "验收门禁未通过", {
      blockers: ["尚未获得实施授权", "仍有 1 项必需验收条件未在当前代码快照下通过（AC-1）"],
      blockerRefs: [
        { key: "core.approval.notApproved" },
        { key: "core.gate.missing", params: { count: 1, ids: "AC-1" } },
      ],
    });
    const enGate = describeClientError("en", gateErr);
    expect(enGate).toContain("Acceptance gate failed:");
    expect(enGate).toContain("The design is not approved yet");
    expect(enGate).toContain("AC-1");
    expect(/[\u4e00-\u9fff]/.test(enGate)).toBe(false);
    const zhGate = describeClientError("zh-CN", gateErr);
    expect(zhGate).toContain("验收门禁未通过：");
    expect(zhGate).toContain("AC-1");

    expect(
      describeClientError(
        "en",
        new ApiClientError("acceptance_gate_failed", "缺少有效的当前代码快照指纹，无法完成验收", {
          messageKey: "accept.errMissingSnapshotHash",
        }),
      ),
    ).toBe("Missing a valid code snapshot fingerprint; cannot complete acceptance");
    expect(
      describeClientError(
        "en",
        new ApiClientError("acceptance_gate_failed", "需要 overrideReason", {
          messageKey: "accept.errReviewBlockRequiresOverride",
        }),
      ),
    ).toContain("blocking findings");

    const liveUnavailableDiff = {
      context: "live",
      status: "unavailable",
      reason: "验收基线 deadbeef1234 在当前仓库中不可用，无法生成基线相对 Diff",
      reasonKey: "core.diff.baselineUnavailable",
      reasonParams: { head: "deadbeef1234" },
      acceptedAt: null,
      snapshotId: null,
      snapshotCapturedAt: null,
      scopeNote: null,
      observation: null,
    } as const;
    const liveEn = describeEvidenceContext(legacyValidity, liveUnavailableDiff, "en");
    expect(liveEn.unavailableReason).toBe(
      "Acceptance baseline deadbeef1234 is unavailable in this repository; cannot generate baseline-relative diff",
    );
    const liveZh = describeEvidenceContext(legacyValidity, liveUnavailableDiff, "zh-CN");
    expect(liveZh.unavailableReason).toBe(
      "验收基线 deadbeef1234 在当前仓库中不可用，无法生成基线相对 Diff",
    );
    for (const k of [
      "core.diff.notGitRepo",
      "core.diff.baselineDiffFailed",
      "core.diff.worktreeDiffFailed",
      "core.diff.cachedDiffFailed",
      "core.evidence.invalidPath",
      "core.evidence.fileMissing",
      "core.evidence.digestMismatch",
      "core.evidence.refMismatch",
      "core.evidence.unreadable",
    ] as const) {
      expect(/[\u4e00-\u9fff]/.test(t("en", k))).toBe(false);
      expect(t("zh-CN", k)).not.toBe(t("en", k));
    }

    const shotMissingValidity = {
      ...legacyValidity,
      provenance: {
        ...legacyValidity.provenance,
        reasonKey: "core.evidence.screenshotMissing",
        reasonParams: { shotId: "SHOT-1" },
        reason: "截图证据不存在：SHOT-1",
      },
    };
    const shotMissingBannerEn = describeEvidenceContext(shotMissingValidity, null, "en");
    expect(shotMissingBannerEn.unavailableReason).toContain("SHOT-1");
    expect(/[\u4e00-\u9fff]/.test(shotMissingBannerEn.unavailableReason ?? "")).toBe(false);
    const shotMissingBannerZh = describeEvidenceContext(shotMissingValidity, null, "zh-CN");
    expect(shotMissingBannerZh.unavailableReason).toContain("SHOT-1");

    const shotMissing = describeEvidenceContext(
      legacyValidity,
      {
        ...liveUnavailableDiff,
        context: "legacy-unavailable",
        reasonKey: "core.evidence.screenshotMissing",
        reasonParams: { shotId: "SHOT-1" },
      },
      "en",
    );
    expect(shotMissing.unavailableReason).toContain("SHOT-1");
    expect(/[\u4e00-\u9fff]/.test(shotMissing.unavailableReason ?? "")).toBe(false);

    for (const action of ["ask", "design", "implement", "fix", "review"] as const) {
      expect(/[\u4e00-\u9fff]/.test(formatAgentActionLabel("en", action))).toBe(false);
      expect(formatAgentActionLabel("zh-CN", action)).not.toBe(action);
      expect(formatAgentActionLabel("en", action)).not.toBe(action);
    }
    for (const status of ["running", "succeeded", "cancelled", "failed"] as const) {
      expect(/[\u4e00-\u9fff]/.test(formatAgentStatusLabel("en", status))).toBe(false);
      expect(formatAgentStatusLabel("zh-CN", status)).not.toBe(status);
      expect(formatAgentStatusLabel("en", status)).not.toBe(status);
    }
    for (const code of ["??", "M", "MM", "A", "AM", "D", "AD", "R", "RM", "C", "CM", "T", "MT", "TM", "AT", "U", "UU"] as const) {
      const en = formatGitFileStatusLabel("en", code);
      const zh = formatGitFileStatusLabel("zh-CN", code);
      expect(/[\u4e00-\u9fff]/.test(en)).toBe(false);
      expect(zh).not.toBe(code);
      expect(en).not.toBe(code);
    }
    expect(formatGitFileStatusLabel("zh-CN", "??")).toBe("未跟踪");
    expect(formatGitFileStatusLabel("en", "??")).toBe("Untracked");
    expect(formatGitFileStatusLabel("zh-CN", "M")).toBe("已修改");
    expect(formatGitFileStatusLabel("en", "M")).toBe("Modified");
    expect(formatGitFileStatusLabel("zh-CN", "T")).toBe("类型变更");
    expect(formatGitFileStatusLabel("en", "T")).toBe("Type changed");
    expect(formatGitFileStatusLabel("zh-CN", "MT")).toBe("类型变更");
    expect(formatGitFileStatusLabel("en", "MT")).toBe("Type changed");

    const ffBranchSkip = resolveWarningParam("主仓库当前位于分支 feat/x（非 main），已保留主仓库现状", {
      key: "git.ff.branchMismatch",
      params: { current: "feat/x", target: "main" },
    });
    expect(t("en", "toast.prMergedReason", { num: 42, reason: ffBranchSkip })).toBe(
      "PR #42 merged, sandbox cleaned (Main repository is currently on branch feat/x (not main); kept main repository as is)",
    );
    expect(formatPrStateLabel("zh-CN", "open")).toBe("开启");
    expect(formatPrStateLabel("en", "open")).toBe("open");
    expect(t("zh-CN", "toast.prStatus", { num: 42, state: prStateRef("merged") })).toBe("PR #42 当前状态：已合并");
    expect(t("en", "toast.prStatus", { num: 42, state: prStateRef("merged") })).toBe("PR #42 status: merged");
  });
});