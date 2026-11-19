import { WorkbenchError } from "./errors.ts";
import { canonicalRoot } from "./fs.ts";
import { getGitRemoteUrl, resolveDefaultBaseBranch } from "./git.ts";
import { parseGitHubRepoFromRemoteUrl } from "./github.ts";
import type { GitRemoteProvider, ProjectGiteeConfig, RequirementGitHubPrLink } from "./types.ts";
import {
  sanitizeOutput,
  validateGitBranchName,
  validateGiteeEnterpriseSlug,
  validateGiteeIssueIdent,
  validateGiteeRepoSlug,
} from "./validate.ts";

const GITEE_API_BASE = "https://gitee.com/api/v5";
const DEFAULT_TIMEOUT_MS = 15_000;

export type GiteeFetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface GiteeApiDeps {
  fetch?: GiteeFetchFn;
  getRemoteUrl?: (root: string) => Promise<string | null>;
  resolveDefaultBaseBranch?: (root: string) => Promise<string | null>;
  token?: string | null;
}

export interface GiteeEnvironmentStatus {
  tokenConfigured: boolean;
  authenticated: boolean;
  account: string | null;
  accountName: string | null;
  repo: string | null;
  enterprise: string | null;
  remoteUrl: string | null;
  defaultBaseBranch: string | null;
  ready: boolean;
  reason: string | null;
}

export interface GiteeIssueItem {
  ident: string;
  url: string;
  title: string;
  body: string;
  state: "open" | "progressing" | "closed" | "rejected";
  stateName?: string;
  issueType?: string;
  labels: string[];
  assignee?: string | null;
  creator?: string | null;
  repository?: string | null;
  enterprise?: string | null;
  programName?: string | null;
  updatedAt: string;
  createdAt?: string;
}

/** Extracts canonical "owner/repo" from SSH or HTTPS Gitee remote URLs, or null if non-Gitee. */
export function parseGiteeRepoFromRemoteUrl(remoteUrl: string | null | undefined): string | null {
  if (!remoteUrl || typeof remoteUrl !== "string") return null;
  const raw = remoteUrl.trim();
  if (!raw) return null;

  // git@gitee.com:Owner/Repo.git or ssh://git@gitee.com/Owner/Repo.git
  const scpMatch = /^(?:ssh:\/\/)?git@gitee\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(raw);
  if (scpMatch) {
    return `${scpMatch[1]}/${scpMatch[2]}`;
  }

  // https://gitee.com/Owner/Repo(.git)
  try {
    const parsed = new URL(raw);
    if (parsed.hostname.toLowerCase() === "gitee.com") {
      const segments = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
      if (segments.length === 2 && segments[0] && segments[1]) {
        const repoName = segments[1].replace(/\.git$/i, "");
        if (/^[A-Za-z0-9_.-]+$/.test(segments[0]) && /^[A-Za-z0-9_.-]+$/.test(repoName)) {
          return `${segments[0]}/${repoName}`;
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Detects whether a Git remote URL belongs to GitHub or Gitee. */
export function detectGitRemoteProvider(remoteUrl: string | null | undefined): GitRemoteProvider | null {
  if (parseGiteeRepoFromRemoteUrl(remoteUrl)) return "gitee";
  if (parseGitHubRepoFromRemoteUrl(remoteUrl)) return "github";
  return null;
}

export function extractGiteeOwner(repoSlug: string | null | undefined): string | null {
  if (!repoSlug) return null;
  const slashIdx = repoSlug.indexOf("/");
  if (slashIdx <= 0) return null;
  return repoSlug.slice(0, slashIdx);
}

function extractIssueIdentFromUrlHash(rawHash: string): string | null {
  const hash = rawHash.replace(/^#/, "").trim();
  if (!hash) return null;
  const qIdx = hash.indexOf("?");
  if (qIdx >= 0) {
    const issueFromHashQuery = new URLSearchParams(hash.slice(qIdx + 1)).get("issue");
    if (issueFromHashQuery) return issueFromHashQuery;
  } else {
    const issueFromHashParams = new URLSearchParams(hash).get("issue");
    if (issueFromHashParams) return issueFromHashParams;
  }
  const hashPath = (qIdx >= 0 ? hash.slice(0, qIdx) : hash).replace(/^\/+|\/+$/g, "");
  const segments = hashPath.split("/").filter(Boolean);
  const issuesIdx = segments.indexOf("issues");
  if (issuesIdx >= 0 && segments[issuesIdx + 1] && segments[issuesIdx + 1] !== "list") {
    return segments[issuesIdx + 1]!;
  }
  return null;
}

function extractEnterpriseFromGiteeHtmlUrl(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    const segments = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
    if (host === "e.gitee.com" && segments[0]) {
      return validateGiteeEnterpriseSlug(segments[0]);
    }
    if (host === "gitee.com" && segments[0] === "enterprises" && segments[1]) {
      return validateGiteeEnterpriseSlug(segments[1]);
    }
  } catch {
    return null;
  }
  return null;
}

/** Parses Gitee issue ident (#I8ABCD, I8ABCD, owner/repo#I8ABCD, or Gitee/e.gitee.com URL). */
export function parseGiteeIssueRef(
  rawRef: string,
  fallback?: { enterprise?: string | null; repo?: string | null },
): { ident: string; enterprise: string | null; repo: string | null } {
  const trimmed = rawRef.trim();
  if (!trimmed) {
    throw new WorkbenchError("invalid_input", "请提供 Gitee 工作项编号或 URL");
  }

  const fallbackEnterprise = fallback?.enterprise ? validateGiteeEnterpriseSlug(fallback.enterprise) : null;
  const fallbackRepo = fallback?.repo ? validateGiteeRepoSlug(fallback.repo) : null;

  // #I8ABCD or I8ABCD
  const bareMatch = /^#?([A-Za-z0-9]{4,16})$/.exec(trimmed);
  if (bareMatch) {
    return {
      ident: validateGiteeIssueIdent(bareMatch[1]!),
      enterprise: fallbackEnterprise,
      repo: fallbackRepo,
    };
  }

  // owner/repo#I8ABCD
  const slugMatch = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([A-Za-z0-9]{4,16})$/.exec(trimmed);
  if (slugMatch) {
    const repo = validateGiteeRepoSlug(slugMatch[1]!);
    return {
      ident: validateGiteeIssueIdent(slugMatch[2]!),
      enterprise: fallbackEnterprise ?? extractGiteeOwner(repo),
      repo,
    };
  }

  // URL formats:
  // - https://gitee.com/owner/repo/issues/I8ABCD
  // - https://gitee.com/enterprises/ent/issues/I8ABCD
  // - https://gitee.com/enterprises/ent/issues/list?issue=I8ABCD
  // - https://e.gitee.com/ent/issues/list?issue=I8ABCD
  // - https://e.gitee.com/ent/issues/list#?issue=I8ABCD
  // - https://e.gitee.com/ent/.../issues/I8ABCD
  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    if (host === "gitee.com" || host === "e.gitee.com") {
      const issueQuery = url.searchParams.get("issue") || extractIssueIdentFromUrlHash(url.hash);
      const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
      if (host === "e.gitee.com") {
        const enterprise = segments[0] ? validateGiteeEnterpriseSlug(segments[0]) : fallbackEnterprise;
        const issuesIdx = segments.indexOf("issues");
        const pathIdent =
          issuesIdx >= 0 && segments[issuesIdx + 1] && segments[issuesIdx + 1] !== "list"
            ? segments[issuesIdx + 1]
            : null;
        const identCandidate = issueQuery || pathIdent;
        if (identCandidate) {
          return {
            ident: validateGiteeIssueIdent(identCandidate),
            enterprise,
            repo: fallbackRepo,
          };
        }
      } else {
        if (segments[0] === "enterprises" && segments[1] && segments[2] === "issues") {
          const pathIdent = segments[3] && segments[3] !== "list" ? segments[3] : null;
          const identCandidate = issueQuery || pathIdent;
          if (identCandidate) {
            return {
              ident: validateGiteeIssueIdent(identCandidate),
              enterprise: validateGiteeEnterpriseSlug(segments[1]),
              repo: fallbackRepo,
            };
          }
        }
        if (segments[0] && segments[1] && segments[2] === "issues" && segments[3] && segments[3] !== "list") {
          const repo = validateGiteeRepoSlug(`${segments[0]}/${segments[1]}`);
          return {
            ident: validateGiteeIssueIdent(segments[3]),
            enterprise: fallbackEnterprise ?? extractGiteeOwner(repo),
            repo,
          };
        }
      }
    }
  } catch {
    // Fall through to error.
  }

  throw new WorkbenchError(
    "invalid_input",
    "请输入有效的 Gitee 工作项编号（如 I8ABCD 或 #I8ABCD）或完整 Gitee 工作项 URL",
  );
}

function getFetch(deps?: GiteeApiDeps): GiteeFetchFn {
  return deps?.fetch ?? fetch;
}

async function giteeRequest<T>(
  apiPath: string,
  token: string,
  options: { method?: string; body?: unknown; timeoutMs?: number } = {},
  deps?: GiteeApiDeps,
): Promise<{ status: number; data: T }> {
  const fetchFn = getFetch(deps);
  const url = `${GITEE_API_BASE}${apiPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `token ${token}`,
    };
    const init: RequestInit = {
      method: options.method ?? "GET",
      headers,
      signal: controller.signal,
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    const resp = await fetchFn(url, init);
    const rawText = await resp.text();
    let parsed: unknown = null;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = null;
    }
    if (!resp.ok) {
      const apiMsg =
        parsed && typeof parsed === "object" && "message" in parsed && typeof (parsed as { message?: unknown }).message === "string"
          ? (parsed as { message: string }).message
          : rawText;
      const cleanMsg = sanitizeOutput(apiMsg || `HTTP ${resp.status}`, 400).text;
      const err = new WorkbenchError("execution_failed", `Gitee API 请求失败 (${resp.status}): ${cleanMsg}`, {
        httpStatus: resp.status,
      });
      throw err;
    }
    return { status: resp.status, data: parsed as T };
  } catch (err) {
    if (err instanceof WorkbenchError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new WorkbenchError("execution_failed", `连接 Gitee API 失败: ${sanitizeOutput(msg, 300).text}`);
  } finally {
    clearTimeout(timer);
  }
}

interface RawGiteeUser {
  login?: string;
  name?: string;
}

interface RawGiteeIssue {
  number?: string;
  html_url?: string;
  url?: string;
  title?: string;
  body?: string;
  state?: string;
  issue_state_detail?: { title?: string } | null;
  issue_type_detail?: { title?: string } | null;
  labels?: Array<{ name?: string }>;
  assignee?: { login?: string; name?: string } | null;
  user?: { login?: string; name?: string } | null;
  repository?: { full_name?: string; path_with_namespace?: string } | null;
  program?: { name?: string } | null;
  updated_at?: string;
  created_at?: string;
}

interface RawGiteePr {
  number?: number;
  html_url?: string;
  url?: string;
  title?: string;
  state?: string;
  merged_at?: string | null;
  head?: { ref?: string } | string;
  base?: { ref?: string } | string;
}

function normalizeGiteeIssueState(raw: string | undefined): GiteeIssueItem["state"] {
  const lower = String(raw ?? "").toLowerCase();
  if (lower === "progressing") return "progressing";
  if (lower === "closed") return "closed";
  if (lower === "rejected") return "rejected";
  return "open";
}

function mapRawGiteeIssue(raw: RawGiteeIssue, enterprise?: string | null): GiteeIssueItem | null {
  const ident = typeof raw.number === "string" ? raw.number.trim().toUpperCase() : "";
  if (!ident) return null;
  const resolvedEnterprise = enterprise ?? extractEnterpriseFromGiteeHtmlUrl(raw.html_url);
  const repoName = raw.repository?.full_name ?? raw.repository?.path_with_namespace ?? null;
  const fallbackUrl = resolvedEnterprise
    ? `https://e.gitee.com/${resolvedEnterprise}/issues/list?issue=${encodeURIComponent(ident)}`
    : repoName
      ? `https://gitee.com/${repoName}/issues/${encodeURIComponent(ident)}`
      : `https://gitee.com`;
  const url = typeof raw.html_url === "string" && raw.html_url.startsWith("https://") ? raw.html_url : fallbackUrl;

  return {
    ident,
    url,
    title: sanitizeOutput(String(raw.title ?? `工作项 #${ident}`), 360).text.trim(),
    body: sanitizeOutput(String(raw.body ?? ""), 64 * 1024).text.trim(),
    state: normalizeGiteeIssueState(raw.state),
    ...(raw.issue_state_detail?.title ? { stateName: sanitizeOutput(raw.issue_state_detail.title, 60).text } : {}),
    ...(raw.issue_type_detail?.title ? { issueType: sanitizeOutput(raw.issue_type_detail.title, 60).text } : {}),
    labels: Array.isArray(raw.labels)
      ? raw.labels.map((l) => l.name).filter((n): n is string => typeof n === "string" && n.trim().length > 0)
      : [],
    assignee: raw.assignee?.login ?? raw.assignee?.name ?? null,
    creator: raw.user?.login ?? raw.user?.name ?? null,
    repository: repoName,
    enterprise: resolvedEnterprise ?? null,
    programName: raw.program?.name ? sanitizeOutput(raw.program.name, 160).text : null,
    updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : new Date().toISOString(),
    ...(typeof raw.created_at === "string" ? { createdAt: raw.created_at } : {}),
  };
}

/** Inspects local git remote and Gitee token authentication status. */
export async function inspectGiteeEnvironment(
  root: string,
  config?: ProjectGiteeConfig,
  tokenInput?: string | null,
  deps?: GiteeApiDeps,
): Promise<GiteeEnvironmentStatus> {
  const base = canonicalRoot(root);
  const remoteUrl = deps?.getRemoteUrl ? await deps.getRemoteUrl(base) : await getGitRemoteUrl(base);
  const detectedRepo = parseGiteeRepoFromRemoteUrl(remoteUrl);
  const repo = config?.repo ? validateGiteeRepoSlug(config.repo) : detectedRepo;
  const enterprise = config?.enterprise
    ? validateGiteeEnterpriseSlug(config.enterprise)
    : extractGiteeOwner(repo);

  const detectedBase = deps?.resolveDefaultBaseBranch
    ? await deps.resolveDefaultBaseBranch(base)
    : await resolveDefaultBaseBranch(base);
  const defaultBaseBranch = config?.defaultBaseBranch ?? detectedBase ?? "master";

  const token = (tokenInput ?? deps?.token ?? process.env.GITEE_ACCESS_TOKEN ?? "").trim();
  if (!token) {
    return {
      tokenConfigured: false,
      authenticated: false,
      account: null,
      accountName: null,
      repo,
      enterprise,
      remoteUrl,
      defaultBaseBranch,
      ready: false,
      reason: "尚未配置 Gitee 私人令牌 (Access Token)，请在「工作台设置 -> 全局设置」中填写",
    };
  }

  let authenticated = false;
  let account: string | null = null;
  let accountName: string | null = null;
  let authReason: string | null = null;
  try {
    const { data } = await giteeRequest<RawGiteeUser>("/user", token, { timeoutMs: 8_000 }, deps);
    if (data && typeof data.login === "string" && data.login.trim()) {
      authenticated = true;
      account = data.login.trim();
      accountName = typeof data.name === "string" && data.name.trim() ? data.name.trim() : account;
    } else {
      authReason = "Gitee 私人令牌验证未返回有效账号信息";
    }
  } catch (err) {
    authenticated = false;
    authReason = err instanceof Error ? err.message : "Gitee 私人令牌无效或已过期";
  }

  let reason: string | null = null;
  if (!authenticated) {
    reason = authReason ?? "Gitee 私人令牌无效或连接失败";
  } else if (!repo) {
    reason = "当前项目尚未配置 Gitee 仓库（未检测到 gitee.com origin 远端，可在项目设置中手动指定 owner/repo）";
  }

  return {
    tokenConfigured: true,
    authenticated,
    account,
    accountName,
    repo,
    enterprise,
    remoteUrl,
    defaultBaseBranch,
    ready: authenticated && Boolean(repo),
    reason,
  };
}

/**
 * Fetches Gitee issues relevant to the authenticated user.
 * Combines `/v5/user/issues` and `/v5/enterprises/{enterprise}/issues` so issues with
 * `repository: null` (unlinked enterprise work items) are reliably retrieved.
 */
export async function listGiteeMyIssues(
  input: {
    token: string;
    enterprise?: string | null;
    filter?: "assigned" | "created" | "all";
    state?: "active" | "open" | "progressing" | "closed" | "all";
    search?: string;
    perPage?: number;
  },
  deps?: GiteeApiDeps,
): Promise<{ account: string; enterprise: string | null; items: GiteeIssueItem[] }> {
  const token = input.token.trim();
  if (!token) {
    throw new WorkbenchError("invalid_input", "尚未配置 Gitee 私人令牌 (Access Token)");
  }

  const filter = input.filter ?? "assigned";
  const stateFilter = input.state ?? "active";
  const perPage = Math.min(100, Math.max(10, input.perPage ?? 50));
  const enterprise = input.enterprise ? validateGiteeEnterpriseSlug(input.enterprise) : null;

  const { data: user } = await giteeRequest<RawGiteeUser>("/user", token, {}, deps);
  const account = user?.login?.trim();
  if (!account) {
    throw new WorkbenchError("execution_failed", "无法识别当前 Gitee 登录账号");
  }

  const apiStates: Array<"open" | "progressing" | "closed" | "all"> =
    stateFilter === "active" ? ["open", "progressing"] : [stateFilter];

  type IssueBatchResult =
    | { ok: true; sourceEnterprise: string | null; list: RawGiteeIssue[] }
    | { ok: false; error: unknown };
  const requests: Array<Promise<IssueBatchResult>> = [];

  for (const st of apiStates) {
    const qs = new URLSearchParams({
      filter,
      state: st,
      sort: "updated",
      direction: "desc",
      page: "1",
      per_page: String(perPage),
    });
    requests.push(
      giteeRequest<RawGiteeIssue[]>(`/user/issues?${qs.toString()}`, token, {}, deps)
        .then(
          (res): IssueBatchResult => ({
            ok: true,
            sourceEnterprise: null,
            list: Array.isArray(res.data) ? res.data : [],
          }),
        )
        .catch((error): IssueBatchResult => ({ ok: false, error })),
    );

    if (enterprise) {
      const roles: Array<"assignee" | "creator"> =
        filter === "assigned" ? ["assignee"] : filter === "created" ? ["creator"] : ["assignee", "creator"];
      for (const role of roles) {
        const entQs = new URLSearchParams({
          state: st,
          [role]: account,
          sort: "updated",
          direction: "desc",
          page: "1",
          per_page: String(perPage),
        });
        requests.push(
          giteeRequest<RawGiteeIssue[]>(
            `/enterprises/${encodeURIComponent(enterprise)}/issues?${entQs.toString()}`,
            token,
            {},
            deps,
          )
            .then(
              (res): IssueBatchResult => ({
                ok: true,
                sourceEnterprise: enterprise,
                list: Array.isArray(res.data) ? res.data : [],
              }),
            )
            .catch((error): IssueBatchResult => ({ ok: false, error })),
        );
      }
    }
  }

  const results = await Promise.all(requests);
  const succeeded = results.filter((r): r is Extract<IssueBatchResult, { ok: true }> => r.ok);
  if (succeeded.length === 0) {
    const firstErr = results.find((r): r is Extract<IssueBatchResult, { ok: false }> => !r.ok)?.error;
    throw firstErr instanceof Error
      ? firstErr
      : new WorkbenchError("execution_failed", "获取 Gitee 工作项列表失败");
  }

  const byIdent = new Map<string, GiteeIssueItem>();
  for (const batch of succeeded) {
    for (const raw of batch.list) {
      const mapped = mapRawGiteeIssue(raw, batch.sourceEnterprise);
      if (!mapped) continue;
      const key = mapped.ident.toUpperCase();
      if (!byIdent.has(key)) {
        byIdent.set(key, mapped);
      }
    }
  }

  let items = [...byIdent.values()];
  const search = input.search?.trim().toLowerCase();
  if (search) {
    items = items.filter(
      (item) =>
        item.ident.toLowerCase().includes(search) ||
        item.title.toLowerCase().includes(search) ||
        (item.programName?.toLowerCase().includes(search) ?? false) ||
        (item.repository?.toLowerCase().includes(search) ?? false),
    );
  }

  items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return { account, enterprise, items };
}

/** Fetches a single Gitee issue from enterprise or repository scope (supports repository-unlinked issues). */
export async function viewGiteeIssue(
  input: {
    token: string;
    issueRef: string;
    enterprise?: string | null;
    repo?: string | null;
  },
  deps?: GiteeApiDeps,
): Promise<GiteeIssueItem> {
  const token = input.token.trim();
  if (!token) {
    throw new WorkbenchError("invalid_input", "尚未配置 Gitee 私人令牌 (Access Token)");
  }

  const parsed = parseGiteeIssueRef(input.issueRef, {
    enterprise: input.enterprise,
    repo: input.repo,
  });

  const attempts: Array<() => Promise<RawGiteeIssue>> = [];
  if (parsed.enterprise) {
    const ent = parsed.enterprise;
    attempts.push(async () => {
      const res = await giteeRequest<RawGiteeIssue>(
        `/enterprises/${encodeURIComponent(ent)}/issues/${encodeURIComponent(parsed.ident)}`,
        token,
        {},
        deps,
      );
      return res.data;
    });
  }
  if (parsed.repo) {
    const [owner, repo] = parsed.repo.split("/") as [string, string];
    attempts.push(async () => {
      const res = await giteeRequest<RawGiteeIssue>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(parsed.ident)}`,
        token,
        {},
        deps,
      );
      return res.data;
    });
  }

  if (attempts.length === 0) {
    throw new WorkbenchError(
      "invalid_input",
      "无法确定 Gitee 企业或仓库路径，请提供完整工作项 URL 或在项目设置中配置企业空间标识",
    );
  }

  let lastErr: unknown = null;
  for (const run of attempts) {
    try {
      const raw = await run();
      const mapped = mapRawGiteeIssue(raw, parsed.enterprise);
      if (mapped) return mapped;
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new WorkbenchError("execution_failed", `读取 Gitee 工作项 #${parsed.ident} 失败`);
}

function mapRawGiteePr(raw: RawGiteePr, repo: string, fallbackHead: string, fallbackBase: string): RequirementGitHubPrLink {
  const num = typeof raw.number === "number" ? raw.number : 0;
  const rawState = String(raw.state ?? "").toLowerCase();
  const state: "open" | "merged" | "closed" =
    rawState === "merged" ? "merged" : rawState === "closed" ? "closed" : "open";
  const headBranch =
    typeof raw.head === "string" ? raw.head : (raw.head?.ref ?? fallbackHead);
  const baseBranch =
    typeof raw.base === "string" ? raw.base : (raw.base?.ref ?? fallbackBase);
  const mergedAt = raw.merged_at ? Date.parse(raw.merged_at) || Date.now() : null;
  const url =
    typeof raw.html_url === "string" && raw.html_url.startsWith("https://")
      ? raw.html_url
      : `https://gitee.com/${repo}/pulls/${num}`;

  return {
    number: num,
    url,
    title: sanitizeOutput(String(raw.title ?? `PR !${num}`), 300).text,
    headBranch,
    baseBranch,
    state,
    mergedAt,
    lastSyncedAt: Date.now(),
  };
}

export async function findOpenGiteePrForBranch(
  input: { repo: string; headBranch: string; baseBranch?: string; token: string },
  deps?: GiteeApiDeps,
): Promise<RequirementGitHubPrLink | null> {
  const repo = validateGiteeRepoSlug(input.repo);
  const headBranch = validateGitBranchName(input.headBranch);
  const baseBranch = input.baseBranch ? validateGitBranchName(input.baseBranch) : undefined;
  const [owner, repoName] = repo.split("/") as [string, string];
  const qs = new URLSearchParams({
    state: "open",
    head: headBranch,
    ...(baseBranch ? { base: baseBranch } : {}),
  });
  try {
    const { data } = await giteeRequest<RawGiteePr[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/pulls?${qs.toString()}`,
      input.token.trim(),
      {},
      deps,
    );
    const list = Array.isArray(data) ? data : [];
    const matched = list.find((item) => {
      if (!item || typeof item.number !== "number") return false;
      const itemState = String(item.state ?? "").toLowerCase();
      if (itemState && itemState !== "open" && itemState !== "opened") return false;
      const rawHead = typeof item.head === "string" ? item.head : item.head?.ref;
      const rawBase = typeof item.base === "string" ? item.base : item.base?.ref;
      const headMatches = rawHead === headBranch || rawHead === `${owner}:${headBranch}`;
      const baseMatches = !baseBranch || !rawBase || rawBase === baseBranch;
      return headMatches && baseMatches;
    });
    if (!matched) return null;
    return mapRawGiteePr(matched, repo, headBranch, baseBranch ?? "master");
  } catch {
    return null;
  }
}

export async function createOrUpdateGiteePr(
  input: {
    repo: string;
    headBranch: string;
    baseBranch: string;
    title: string;
    body: string;
    token: string;
  },
  deps?: GiteeApiDeps,
): Promise<RequirementGitHubPrLink & { created: boolean }> {
  const repo = validateGiteeRepoSlug(input.repo);
  const headBranch = validateGitBranchName(input.headBranch);
  const baseBranch = validateGitBranchName(input.baseBranch);
  if (headBranch === baseBranch) {
    throw new WorkbenchError("invalid_input", `源分支与目标分支不能同为 ${baseBranch}，请先创建特性分支`);
  }
  const token = input.token.trim();
  if (!token) {
    throw new WorkbenchError("invalid_input", "尚未配置 Gitee 私人令牌 (Access Token)");
  }
  const cleanTitle = sanitizeOutput(input.title.trim(), 240).text.replace(/[\r\n]+/g, " ").trim();
  const cleanBody = sanitizeOutput(input.body.trim(), 40_000).text;
  if (!cleanTitle) {
    throw new WorkbenchError("invalid_input", "PR 标题不能为空");
  }

  const [owner, repoName] = repo.split("/") as [string, string];
  const existing = await findOpenGiteePrForBranch({ repo, headBranch, baseBranch, token }, deps);
  if (existing) {
    const { data } = await giteeRequest<RawGiteePr>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/pulls/${existing.number}`,
      token,
      {
        method: "PATCH",
        body: {
          title: cleanTitle,
          body: cleanBody,
        },
      },
      deps,
    );
    return {
      ...mapRawGiteePr(data, repo, headBranch, baseBranch),
      created: false,
    };
  }

  const { data } = await giteeRequest<RawGiteePr>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/pulls`,
    token,
    {
      method: "POST",
      body: {
        title: cleanTitle,
        head: headBranch,
        base: baseBranch,
        body: cleanBody,
        prune_source_branch: false,
      },
    },
    deps,
  );

  if (!data || typeof data.number !== "number") {
    throw new WorkbenchError("execution_failed", "Gitee PR 已请求创建但未返回有效 PR 编号");
  }
  return {
    ...mapRawGiteePr(data, repo, headBranch, baseBranch),
    created: true,
  };
}

export async function viewGiteePr(
  input: { repo: string; prNumber: number; token: string },
  deps?: GiteeApiDeps,
): Promise<RequirementGitHubPrLink> {
  const repo = validateGiteeRepoSlug(input.repo);
  if (!Number.isSafeInteger(input.prNumber) || input.prNumber < 1) {
    throw new WorkbenchError("invalid_input", `无效的 PR 编号: ${input.prNumber}`);
  }
  const token = input.token.trim();
  if (!token) {
    throw new WorkbenchError("invalid_input", "尚未配置 Gitee 私人令牌 (Access Token)");
  }
  const [owner, repoName] = repo.split("/") as [string, string];
  const { data } = await giteeRequest<RawGiteePr>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/pulls/${input.prNumber}`,
    token,
    {},
    deps,
  );
  return mapRawGiteePr(data, repo, "", "master");
}
