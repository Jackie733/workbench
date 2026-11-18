import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { WorkbenchError } from "./errors.ts";
import { canonicalRoot } from "./fs.ts";
import { getGitRemoteUrl, resolveDefaultBaseBranch } from "./git.ts";
import type {
  ProjectGitHubConfig,
  RequirementDetail,
  RequirementGitHubIssueLink,
  RequirementGitHubPrLink,
} from "./types.ts";
import { sanitizeOutput, validateGitBranchName, validateGitHubRepoSlug } from "./validate.ts";

export interface GhExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitHubCommandDeps {
  whichGh?: () => string | null;
  runGh?: (
    ghBin: string,
    args: string[],
    options: { cwd: string; stdin?: string; timeoutMs?: number },
  ) => Promise<GhExecResult>;
  getRemoteUrl?: (root: string) => Promise<string | null>;
  resolveDefaultBaseBranch?: (root: string) => Promise<string | null>;
}

export interface GitHubEnvironmentStatus {
  ghInstalled: boolean;
  authenticated: boolean;
  account: string | null;
  repo: string | null;
  remoteUrl: string | null;
  defaultBaseBranch: string | null;
  ready: boolean;
  reason: string | null;
}

export interface ImportedGitHubIssue {
  repo: string;
  number: number;
  url: string;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
}

function defaultWhichGh(): string | null {
  const found = Bun.which("gh");
  if (found) return found;
  for (const candidate of [
    "/home/linuxbrew/.linuxbrew/bin/gh",
    "/opt/homebrew/bin/gh",
    "/usr/local/bin/gh",
    "/usr/bin/gh",
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function defaultRunGh(
  ghBin: string,
  args: string[],
  options: { cwd: string; stdin?: string; timeoutMs?: number },
): Promise<GhExecResult> {
  return new Promise((resolve, reject) => {
    try {
      const child = execFile(
        ghBin,
        args,
        {
          cwd: options.cwd,
          timeout: options.timeoutMs ?? 25_000,
          maxBuffer: 8 * 1024 * 1024,
          encoding: "utf8",
          env: process.env,
        },
        (error, stdout, stderr) => {
          if (error && typeof (error as NodeJS.ErrnoException).code === "string") {
            reject(error);
            return;
          }
          const code =
            error && typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code: number }).code ?? 1)
              : 0;
          resolve({
            code,
            stdout: typeof stdout === "string" ? stdout : String(stdout ?? ""),
            stderr: typeof stderr === "string" ? stderr : String(stderr ?? ""),
          });
        },
      );
      if (options.stdin !== undefined) {
        child.stdin?.end(options.stdin, "utf8");
      } else {
        child.stdin?.end();
      }
    } catch (err) {
      reject(err);
    }
  });
}

function resolveGhRunner(deps?: GitHubCommandDeps) {
  const whichGh = deps?.whichGh ?? defaultWhichGh;
  const runGh = deps?.runGh ?? defaultRunGh;
  return { whichGh, runGh };
}

function assertGhBin(deps?: GitHubCommandDeps): { ghBin: string; runGh: NonNullable<GitHubCommandDeps["runGh"]> } {
  const { whichGh, runGh } = resolveGhRunner(deps);
  const ghBin = whichGh();
  if (!ghBin) {
    throw new WorkbenchError("execution_failed", "未在本机检测到 GitHub CLI (gh)，请先安装并执行 gh auth login");
  }
  return { ghBin, runGh };
}

/** Extracts canonical "owner/repo" from SSH or HTTPS GitHub remote URLs, or null if non-GitHub. */
export function parseGitHubRepoFromRemoteUrl(remoteUrl: string | null | undefined): string | null {
  if (!remoteUrl || typeof remoteUrl !== "string") return null;
  const raw = remoteUrl.trim();
  if (!raw) return null;

  // git@github.com:Owner/Repo.git
  const scpMatch = /^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(raw);
  if (scpMatch) {
    return `${scpMatch[1]}/${scpMatch[2]}`;
  }

  // https://github.com/Owner/Repo(.git)
  try {
    const parsed = new URL(raw);
    if (parsed.hostname.toLowerCase() === "github.com") {
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

export function parseGitHubIssueRef(
  rawRef: string | number,
  fallbackRepo?: string | null,
): { repo: string | null; number: number } {
  if (typeof rawRef === "number") {
    if (!Number.isSafeInteger(rawRef) || rawRef < 1) {
      throw new WorkbenchError("invalid_input", `无效的 Issue 编号: ${rawRef}`);
    }
    return { repo: fallbackRepo ? validateGitHubRepoSlug(fallbackRepo) : null, number: rawRef };
  }

  const trimmed = rawRef.trim();
  const numMatch = /^#?(\d+)$/.exec(trimmed);
  if (numMatch) {
    const num = Number(numMatch[1]);
    if (!Number.isSafeInteger(num) || num < 1) {
      throw new WorkbenchError("invalid_input", `无效的 Issue 编号: ${rawRef}`);
    }
    return { repo: fallbackRepo ? validateGitHubRepoSlug(fallbackRepo) : null, number: num };
  }

  // owner/repo#123
  const slugRefMatch = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(trimmed);
  if (slugRefMatch) {
    return {
      repo: validateGitHubRepoSlug(slugRefMatch[1]!),
      number: Number(slugRefMatch[2]),
    };
  }

  // https://github.com/owner/repo/issues/123
  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() === "github.com") {
      const m = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)(?:[/?#].*)?$/i.exec(url.pathname);
      if (m) {
        return {
          repo: validateGitHubRepoSlug(`${m[1]}/${m[2]}`),
          number: Number(m[3]),
        };
      }
    }
  } catch {
    // Fall through to error.
  }

  throw new WorkbenchError("invalid_input", "请输入有效的 GitHub Issue 编号（如 #42）或完整 Issue URL");
}

function parseUrlLastNumber(text: string): { url: string; number: number } | null {
  const urlMatch = /(https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/(\d+))/i.exec(text);
  if (!urlMatch) return null;
  const num = Number(urlMatch[2]);
  if (!Number.isSafeInteger(num) || num < 1) return null;
  return { url: urlMatch[1]!, number: num };
}

export async function inspectGitHubEnvironment(
  root: string,
  config?: ProjectGitHubConfig,
  deps?: GitHubCommandDeps,
): Promise<GitHubEnvironmentStatus> {
  const base = canonicalRoot(root);
  const { whichGh, runGh } = resolveGhRunner(deps);
  const ghBin = whichGh();

  const remoteUrl = deps?.getRemoteUrl ? await deps.getRemoteUrl(base) : await getGitRemoteUrl(base);
  const detectedRepo = parseGitHubRepoFromRemoteUrl(remoteUrl);
  const repo = config?.repo ? validateGitHubRepoSlug(config.repo) : detectedRepo;

  const detectedBase = deps?.resolveDefaultBaseBranch
    ? await deps.resolveDefaultBaseBranch(base)
    : await resolveDefaultBaseBranch(base);
  let defaultBaseBranch = config?.defaultBaseBranch ?? detectedBase;

  if (!ghBin) {
    return {
      ghInstalled: false,
      authenticated: false,
      account: null,
      repo,
      remoteUrl,
      defaultBaseBranch,
      ready: false,
      reason: "本机未安装 gh CLI，无法执行 GitHub Issue / PR 同步",
    };
  }

  let authenticated = false;
  let account: string | null = null;
  try {
    const authRes = await runGh(ghBin, ["auth", "status"], { cwd: base, timeoutMs: 8_000 });
    const combined = `${authRes.stdout}\n${authRes.stderr}`;
    authenticated = authRes.code === 0;
    const accMatch = /Logged in to [^\s]+ account ([A-Za-z0-9_-]+)/i.exec(combined);
    if (accMatch) account = accMatch[1]!;
  } catch {
    authenticated = false;
  }

  if (authenticated && repo && !defaultBaseBranch) {
    try {
      const viewRes = await runGh(ghBin, ["repo", "view", repo, "--json", "defaultBranchRef"], {
        cwd: base,
        timeoutMs: 10_000,
      });
      if (viewRes.code === 0) {
        const parsed = JSON.parse(viewRes.stdout) as { defaultBranchRef?: { name?: string } };
        if (parsed.defaultBranchRef?.name) {
          defaultBaseBranch = parsed.defaultBranchRef.name;
        }
      }
    } catch {
      // Ignore remote repo metadata lookup failure.
    }
  }

  let reason: string | null = null;
  if (!authenticated) {
    reason = "gh CLI 尚未登录，请先在终端运行 gh auth login";
  } else if (!repo) {
    reason = "当前项目尚未配置 GitHub 仓库（未检测到 github.com origin 远端，也可在项目设置中手动指定 owner/repo）";
  }

  return {
    ghInstalled: true,
    authenticated,
    account,
    repo,
    remoteUrl,
    defaultBaseBranch: defaultBaseBranch ?? "main",
    ready: authenticated && Boolean(repo),
    reason,
  };
}

export function buildRequirementIssueBody(detail: RequirementDetail): string {
  const { state, specMarkdown } = detail;
  const lines: string[] = [
    `> 由 **Workbench** 本地需求 [\`${state.id}\`] 同步创建（当前阶段：\`${state.stage}\` · 轨道：\`${state.track}\`）`,
    "",
    "## 需求目标与范围",
    sanitizeOutput(specMarkdown.trim(), 16_000).text,
  ];
  if (state.criteria.length > 0) {
    lines.push("", "## 验收条件");
    for (const c of state.criteria) {
      const req = c.required ? "必需" : "参考";
      const cmd = c.command ? ` (\`${c.command}\`)` : "";
      lines.push(`- [ ] **${c.id}** (${req}): ${sanitizeOutput(c.description, 800).text}${cmd}`);
    }
  }
  if (state.attachments && state.attachments.length > 0) {
    lines.push(
      "",
      "## 附件",
      `本需求附带 ${state.attachments.length} 个附件（${state.attachments.map((a) => sanitizeOutput(a.name, 120).text).join("、")}）。`,
      "二进制附件保存在 Workbench 本地工作区，请打开需求详情页查看或下载。",
    );
  }
  return sanitizeOutput(lines.join("\n"), 32_000).text;
}

export function buildRequirementPrBody(detail: RequirementDetail, note?: string): string {
  const { state, specMarkdown, designMarkdown, validity } = detail;
  const lines: string[] = [];

  if (state.github?.issue?.number !== undefined && state.github.issue.number !== "") {
    lines.push(`Closes #${state.github.issue.number}`);
    if (state.github.provider === "gitee" && state.github.issue.url) {
      lines.push(
        `> 关联 Gitee 工作项：[${sanitizeOutput(state.github.issue.title, 200).text} (#${state.github.issue.number})](${state.github.issue.url})`,
      );
    }
    lines.push("");
  }

  lines.push(`> 由 **Workbench** 需求 \`${state.id}\` 验收通过后标准化提交（Snapshot: \`${state.acceptance?.snapshot?.id ?? state.acceptance?.codeSnapshotHash.slice(0, 12) ?? "-"}\`）`, "");
  lines.push("## 需求目标");
  lines.push(sanitizeOutput(specMarkdown.trim(), 4000).text || state.title);

  if (designMarkdown.trim()) {
    lines.push("", "## 技术方案摘要");
    lines.push(sanitizeOutput(designMarkdown.trim(), 6000).text);
  }

  if (validity.coverage.items.length > 0) {
    lines.push("", `## 验证证据（必需条件通过 ${validity.coverage.requiredPassed}/${validity.coverage.requiredTotal}）`);
    for (const item of validity.coverage.items) {
      const mark = item.state === "passed" ? "[x]" : "[ ]";
      const cmd = item.criterion.command ? ` — \`${item.criterion.command}\`` : "";
      lines.push(`- ${mark} **${item.criterion.id}** (${item.state}): ${sanitizeOutput(item.criterion.description, 500).text}${cmd}`);
    }
  }

  if (state.reviewReport) {
    const rev = state.reviewReport;
    lines.push(
      "",
      "## 跨模型 Code Review",
      `- **审查器**：\`${rev.reviewerHarness}/${rev.reviewerModel}\` · 结论：**\`${rev.verdict}\`**`,
      `- **摘要**：${sanitizeOutput(rev.summary, 1000).text}`,
    );
    if (rev.findings && rev.findings.length > 0) {
      for (const f of rev.findings.slice(0, 10)) {
        lines.push(`  - [${f.severity}] \`${f.id}\` ${sanitizeOutput(f.title, 260).text}`);
      }
    }
  }

  if (state.acceptance?.overrideReason) {
    lines.push(
      "",
      "## ⚠️ 人工风险放行说明",
      `- **放行理由**：${sanitizeOutput(state.acceptance.overrideReason, 1000).text}`,
    );
    if (state.acceptance.reviewDisposition?.acceptedRisks?.length) {
      lines.push(
        `- **已确认接受的审查项**：${state.acceptance.reviewDisposition.acceptedRisks.map((r) => sanitizeOutput(r, 200).text).join("；")}`,
      );
    }
  }

  if (note?.trim()) {
    lines.push("", "## 交付备注", sanitizeOutput(note.trim(), 1500).text);
  }

  return sanitizeOutput(lines.join("\n"), 40_000).text;
}

export async function createGitHubIssue(
  input: {
    root: string;
    repo: string;
    title: string;
    body: string;
    labels?: string[];
  },
  deps?: GitHubCommandDeps,
): Promise<RequirementGitHubIssueLink> {
  const base = canonicalRoot(input.root);
  const repo = validateGitHubRepoSlug(input.repo);
  const { ghBin, runGh } = assertGhBin(deps);
  const cleanTitle = sanitizeOutput(input.title.trim(), 240).text.replace(/[\r\n]+/g, " ").trim();
  const cleanBody = sanitizeOutput(input.body.trim(), 32_000).text;
  if (!cleanTitle) {
    throw new WorkbenchError("invalid_input", "GitHub Issue 标题不能为空");
  }

  const buildArgs = (labels?: string[]) => {
    const args = ["issue", "create", "--repo", repo, "--title", cleanTitle, "--body-file", "-"];
    for (const lbl of labels ?? []) {
      const cleanLbl = lbl.trim();
      if (cleanLbl && /^[A-Za-z0-9:._/-]{1,40}$/.test(cleanLbl)) {
        args.push("--label", cleanLbl);
      }
    }
    return args;
  };

  let res = await runGh(ghBin, buildArgs(input.labels), { cwd: base, stdin: cleanBody });
  if (res.code !== 0 && input.labels && input.labels.length > 0 && /label/i.test(`${res.stderr}\n${res.stdout}`)) {
    // Retry without labels when target repo hasn't pre-created custom labels.
    res = await runGh(ghBin, buildArgs(undefined), { cwd: base, stdin: cleanBody });
  }
  if (res.code !== 0) {
    const msg = sanitizeOutput(res.stderr.trim() || res.stdout.trim(), 800).text;
    throw new WorkbenchError("execution_failed", `创建 GitHub Issue 失败: ${msg || "gh issue create 返回非零"}`);
  }

  const parsed = parseUrlLastNumber(`${res.stdout}\n${res.stderr}`);
  if (!parsed) {
    throw new WorkbenchError("execution_failed", `GitHub Issue 已创建但无法解析返回 URL: ${sanitizeOutput(res.stdout, 300).text}`);
  }
  return {
    number: parsed.number,
    url: parsed.url,
    title: cleanTitle,
    state: "open",
    lastSyncedAt: Date.now(),
  };
}

export async function viewGitHubIssue(
  input: { root: string; repo?: string | null; issueRef: string | number },
  deps?: GitHubCommandDeps,
): Promise<ImportedGitHubIssue> {
  const base = canonicalRoot(input.root);
  const { repo: parsedRepo, number } = parseGitHubIssueRef(input.issueRef, input.repo);
  if (!parsedRepo) {
    throw new WorkbenchError("invalid_input", "无法确定目标 GitHub 仓库，请先配置 origin 远端或提供完整 Issue URL");
  }
  const { ghBin, runGh } = assertGhBin(deps);
  const res = await runGh(
    ghBin,
    ["issue", "view", String(number), "--repo", parsedRepo, "--json", "number,title,body,url,state,labels"],
    { cwd: base },
  );
  if (res.code !== 0) {
    const msg = sanitizeOutput(res.stderr.trim() || res.stdout.trim(), 600).text;
    throw new WorkbenchError("execution_failed", `读取 GitHub Issue #${number} 失败: ${msg || "未知错误"}`);
  }
  let parsed: {
    number?: number;
    title?: string;
    body?: string;
    url?: string;
    state?: string;
    labels?: Array<{ name?: string }>;
  };
  try {
    parsed = JSON.parse(res.stdout) as typeof parsed;
  } catch {
    throw new WorkbenchError("execution_failed", "无法解析 gh issue view 返回的 JSON");
  }
  const num = parsed.number ?? number;
  const title = sanitizeOutput(String(parsed.title ?? `Issue #${num}`), 300).text.trim();
  const body = sanitizeOutput(String(parsed.body ?? ""), 64 * 1024).text.trim();
  const url = typeof parsed.url === "string" && parsed.url.startsWith("https://")
    ? parsed.url
    : `https://github.com/${parsedRepo}/issues/${num}`;
  const state: "open" | "closed" = String(parsed.state ?? "").toUpperCase() === "CLOSED" ? "closed" : "open";
  const labels = Array.isArray(parsed.labels)
    ? parsed.labels.map((l) => l.name).filter((n): n is string => typeof n === "string" && n.trim().length > 0)
    : [];
  return { repo: parsedRepo, number: num, url, title, body, state, labels };
}

export async function commentOnGitHubIssue(
  input: { root: string; repo: string; issueNumber: number; body: string },
  deps?: GitHubCommandDeps,
): Promise<void> {
  const base = canonicalRoot(input.root);
  const repo = validateGitHubRepoSlug(input.repo);
  if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber < 1) {
    throw new WorkbenchError("invalid_input", `无效的 Issue 编号: ${input.issueNumber}`);
  }
  const cleanBody = sanitizeOutput(input.body.trim(), 24_000).text;
  if (!cleanBody) return;
  const { ghBin, runGh } = assertGhBin(deps);
  const res = await runGh(
    ghBin,
    ["issue", "comment", String(input.issueNumber), "--repo", repo, "--body-file", "-"],
    { cwd: base, stdin: cleanBody },
  );
  if (res.code !== 0) {
    const msg = sanitizeOutput(res.stderr.trim() || res.stdout.trim(), 600).text;
    throw new WorkbenchError("execution_failed", `向 Issue #${input.issueNumber} 发送评论失败: ${msg || "未知错误"}`);
  }
}

export async function setGitHubIssueState(
  input: { root: string; repo: string; issueNumber: number; state: "open" | "closed"; comment?: string },
  deps?: GitHubCommandDeps,
): Promise<void> {
  const base = canonicalRoot(input.root);
  const repo = validateGitHubRepoSlug(input.repo);
  if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber < 1) {
    throw new WorkbenchError("invalid_input", `无效的 Issue 编号: ${input.issueNumber}`);
  }
  const { ghBin, runGh } = assertGhBin(deps);
  const cmd = input.state === "closed" ? "close" : "reopen";
  const args = ["issue", cmd, String(input.issueNumber), "--repo", repo];
  if (input.comment?.trim()) {
    args.push("--comment", sanitizeOutput(input.comment.trim(), 2000).text);
  }
  const res = await runGh(ghBin, args, { cwd: base });
  if (res.code !== 0) {
    const msg = sanitizeOutput(res.stderr.trim() || res.stdout.trim(), 600).text;
    throw new WorkbenchError("execution_failed", `更新 Issue #${input.issueNumber} 状态失败: ${msg || "未知错误"}`);
  }
}

export async function findOpenPrForBranch(
  input: { root: string; repo: string; headBranch: string },
  deps?: GitHubCommandDeps,
): Promise<RequirementGitHubPrLink | null> {
  const base = canonicalRoot(input.root);
  const repo = validateGitHubRepoSlug(input.repo);
  const headBranch = validateGitBranchName(input.headBranch);
  const { ghBin, runGh } = assertGhBin(deps);
  const res = await runGh(
    ghBin,
    [
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      headBranch,
      "--state",
      "open",
      "--json",
      "number,url,title,state,baseRefName,headRefName",
    ],
    { cwd: base },
  );
  if (res.code !== 0) return null;
  try {
    const list = JSON.parse(res.stdout) as Array<{
      number?: number;
      url?: string;
      title?: string;
      state?: string;
      baseRefName?: string;
      headRefName?: string;
    }>;
    const first = Array.isArray(list) ? list[0] : undefined;
    if (!first || typeof first.number !== "number" || typeof first.url !== "string") return null;
    return {
      number: first.number,
      url: first.url,
      title: String(first.title ?? `PR #${first.number}`),
      headBranch: String(first.headRefName ?? headBranch),
      baseBranch: String(first.baseRefName ?? "main"),
      state: "open",
      mergedAt: null,
      lastSyncedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

export async function createOrUpdateGitHubPr(
  input: {
    root: string;
    repo: string;
    headBranch: string;
    baseBranch: string;
    title: string;
    body: string;
  },
  deps?: GitHubCommandDeps,
): Promise<RequirementGitHubPrLink & { created: boolean }> {
  const base = canonicalRoot(input.root);
  const repo = validateGitHubRepoSlug(input.repo);
  const headBranch = validateGitBranchName(input.headBranch);
  const baseBranch = validateGitBranchName(input.baseBranch);
  if (headBranch === baseBranch) {
    throw new WorkbenchError("invalid_input", `源分支与目标分支不能同为 ${baseBranch}，请先创建特性分支`);
  }
  const cleanTitle = sanitizeOutput(input.title.trim(), 240).text.replace(/[\r\n]+/g, " ").trim();
  const cleanBody = sanitizeOutput(input.body.trim(), 40_000).text;
  if (!cleanTitle) {
    throw new WorkbenchError("invalid_input", "PR 标题不能为空");
  }

  const { ghBin, runGh } = assertGhBin(deps);
  const existing = await findOpenPrForBranch({ root: base, repo, headBranch }, deps);
  if (existing) {
    const editRes = await runGh(
      ghBin,
      ["pr", "edit", String(existing.number), "--repo", repo, "--title", cleanTitle, "--body-file", "-"],
      { cwd: base, stdin: cleanBody },
    );
    if (editRes.code !== 0) {
      const msg = sanitizeOutput(editRes.stderr.trim() || editRes.stdout.trim(), 600).text;
      throw new WorkbenchError("execution_failed", `更新已有 PR #${existing.number} 失败: ${msg || "未知错误"}`);
    }
    return {
      ...existing,
      title: cleanTitle,
      baseBranch,
      lastSyncedAt: Date.now(),
      created: false,
    };
  }

  const res = await runGh(
    ghBin,
    [
      "pr",
      "create",
      "--repo",
      repo,
      "--base",
      baseBranch,
      "--head",
      headBranch,
      "--title",
      cleanTitle,
      "--body-file",
      "-",
    ],
    { cwd: base, stdin: cleanBody },
  );
  if (res.code !== 0) {
    const msg = sanitizeOutput(res.stderr.trim() || res.stdout.trim(), 800).text;
    throw new WorkbenchError("execution_failed", `创建 GitHub PR 失败: ${msg || "gh pr create 返回非零"}`);
  }

  const parsed = parseUrlLastNumber(`${res.stdout}\n${res.stderr}`);
  if (parsed) {
    return {
      number: parsed.number,
      url: parsed.url,
      title: cleanTitle,
      headBranch,
      baseBranch,
      state: "open",
      mergedAt: null,
      lastSyncedAt: Date.now(),
      created: true,
    };
  }

  const viewed = await findOpenPrForBranch({ root: base, repo, headBranch }, deps);
  if (!viewed) {
    throw new WorkbenchError("execution_failed", "PR 已提交但无法获取 PR 编号与 URL");
  }
  return { ...viewed, created: true };
}

export async function viewGitHubPr(
  input: { root: string; repo: string; prNumber: number },
  deps?: GitHubCommandDeps,
): Promise<RequirementGitHubPrLink> {
  const base = canonicalRoot(input.root);
  const repo = validateGitHubRepoSlug(input.repo);
  if (!Number.isSafeInteger(input.prNumber) || input.prNumber < 1) {
    throw new WorkbenchError("invalid_input", `无效的 PR 编号: ${input.prNumber}`);
  }
  const { ghBin, runGh } = assertGhBin(deps);
  const res = await runGh(
    ghBin,
    [
      "pr",
      "view",
      String(input.prNumber),
      "--repo",
      repo,
      "--json",
      "number,url,title,state,mergedAt,baseRefName,headRefName",
    ],
    { cwd: base },
  );
  if (res.code !== 0) {
    const msg = sanitizeOutput(res.stderr.trim() || res.stdout.trim(), 600).text;
    throw new WorkbenchError("execution_failed", `查询 PR #${input.prNumber} 状态失败: ${msg || "未知错误"}`);
  }
  let parsed: {
    number?: number;
    url?: string;
    title?: string;
    state?: string;
    mergedAt?: string | null;
    baseRefName?: string;
    headRefName?: string;
  };
  try {
    parsed = JSON.parse(res.stdout) as typeof parsed;
  } catch {
    throw new WorkbenchError("execution_failed", "无法解析 gh pr view 返回的 JSON");
  }

  const rawState = String(parsed.state ?? "").toUpperCase();
  const state: "open" | "merged" | "closed" =
    rawState === "MERGED" ? "merged" : rawState === "CLOSED" ? "closed" : "open";
  const mergedAt = parsed.mergedAt ? Date.parse(parsed.mergedAt) || Date.now() : null;

  return {
    number: parsed.number ?? input.prNumber,
    url:
      typeof parsed.url === "string" && parsed.url.startsWith("https://")
        ? parsed.url
        : `https://github.com/${repo}/pull/${input.prNumber}`,
    title: sanitizeOutput(String(parsed.title ?? `PR #${input.prNumber}`), 300).text,
    headBranch: String(parsed.headRefName ?? ""),
    baseBranch: String(parsed.baseRefName ?? "main"),
    state,
    mergedAt,
    lastSyncedAt: Date.now(),
  };
}
