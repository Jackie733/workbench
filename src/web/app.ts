import type {
  Criterion,
  CriterionCoverageState,
  EffectiveVerificationState,
  PrivacyMode,
  RequirementDetail,
  RequirementSummary,
  Stage,
  TaskStatus,
} from "../core/types.ts";
import type { GitObservation } from "../core/git.ts";
import type { BridgeStatus, DispatchOutcome } from "../server/index.ts";
import { api, ApiClientError, connectUiWebSocket, type ProjectInfoResponse } from "./api.ts";
import { escapeHtml, parseUnifiedDiff, renderDiffLinesHtml, renderMarkdown, renderSimpleLineDiff } from "./render.ts";

type Scope = "active" | "done" | "cancelled" | "all";
type LayoutMode = "list" | "board";
type WorkspaceTab = "spec" | "changes" | "timeline";

interface CriterionDraft {
  id: string;
  description: string;
  required: boolean;
  command: string;
}

interface AppState {
  theme: "light" | "dark";
  loading: boolean;
  busy: boolean;
  project: ProjectInfoResponse | null;
  initPrivacy: PrivacyMode;
  initName: string;
  scope: Scope;
  layout: LayoutMode;
  query: string;
  items: RequirementSummary[];
  homeScrollY: number;

  selectedId: string | null;
  workspaceTab: WorkspaceTab;
  detail: RequirementDetail | null;
  diffObs: GitObservation | null;
  selectedDiffFile: string | null;

  designViewVersion: number | null;
  designComparePrev: boolean;
  designCompareText: { prev: string; curr: string; prevVer: number; currVer: number } | null;

  expandedLogs: Record<string, string>;
  editingSpec: boolean;
  specDraftTitle: string;
  specDraftBody: string;
  specDraftCriteria: CriterionDraft[];

  moreMenuOpen: boolean;
  modal:
    | null
    | { kind: "new_req"; goal: string }
    | { kind: "feedback"; feedback: string; dispatchAgent: boolean }
    | { kind: "lifecycle"; action: "block" | "cancel" | "reopen"; reason: string }
    | { kind: "prompt_fallback"; title: string; subtitle: string; prompt: string }
    | { kind: "debug_info"; text: string };
  toast: { message: string; isError: boolean } | null;
}

const STAGE_META: Record<Stage, { label: string; tone: string }> = {
  draft: { label: "草稿", tone: "neutral" },
  designing: { label: "整理方案中", tone: "info" },
  awaiting_approval: { label: "待批准", tone: "warning" },
  implementing: { label: "实施中", tone: "info" },
  awaiting_acceptance: { label: "待验收", tone: "success" },
  done: { label: "已完成", tone: "success" },
  blocked: { label: "已阻塞", tone: "danger" },
  cancelled: { label: "已取消", tone: "neutral" },
};

const TASK_META: Record<TaskStatus, { symbol: string; label: string; tone: string }> = {
  pending: { symbol: "○", label: "待开始", tone: "neutral" },
  in_progress: { symbol: "●", label: "进行中", tone: "info" },
  done: { symbol: "✓", label: "已完成", tone: "success" },
  blocked: { symbol: "!", label: "受阻", tone: "danger" },
};

const COVERAGE_META: Record<CriterionCoverageState, { symbol: string; label: string; tone: string }> = {
  passed: { symbol: "✓", label: "通过", tone: "success" },
  failed: { symbol: "×", label: "失败", tone: "danger" },
  stale: { symbol: "⟳", label: "需重跑", tone: "warning" },
  unverified: { symbol: "○", label: "未验证", tone: "neutral" },
};

const EVIDENCE_META: Record<EffectiveVerificationState, { label: string; tone: string }> = {
  passed: { label: "当前有效通过", tone: "success" },
  failed: { label: "验证失败", tone: "danger" },
  stale: { label: "已过期（代码/规范已变）", tone: "warning" },
  unknown: { label: "快照缺失", tone: "warning" },
};

function initialTheme(): "light" | "dark" {
  const saved = localStorage.getItem("wb-theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const state: AppState = {
  theme: initialTheme(),
  loading: true,
  busy: false,
  project: null,
  initPrivacy: "local",
  initName: "",
  scope: "active",
  layout: "list",
  query: "",
  items: [],
  homeScrollY: 0,

  selectedId: null,
  workspaceTab: "spec",
  detail: null,
  diffObs: null,
  selectedDiffFile: null,

  designViewVersion: null,
  designComparePrev: false,
  designCompareText: null,

  expandedLogs: {},
  editingSpec: false,
  specDraftTitle: "",
  specDraftBody: "",
  specDraftCriteria: [],

  moreMenuOpen: false,
  modal: null,
  toast: null,
};

let refreshEpoch = 0;
let lastMainHtml = "";
let lastModalHtml = "";
let lastToastHtml = "";

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function renderToast(): void {
  const toastRoot = document.getElementById("toast-root");
  if (!toastRoot) return;
  const nextToast = state.toast
    ? `<div class="toast ${state.toast.isError ? "error" : ""}" role="status">${escapeHtml(state.toast.message)}</div>`
    : "";
  if (nextToast !== lastToastHtml) {
    toastRoot.innerHTML = nextToast;
    lastToastHtml = nextToast;
  }
}

function showToast(message: string, isError = false): void {
  state.toast = { message, isError };
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    state.toast = null;
    renderToast();
  }, 4000);
  renderToast();
}

function applyTheme(): void {
  document.documentElement.setAttribute("data-theme", state.theme);
  localStorage.setItem("wb-theme", state.theme);
}

function relativeTime(ms: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return "刚刚";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  return `${Math.floor(diffSec / 86400)} 天前`;
}

function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function bridgePillHtml(bridge: BridgeStatus | undefined): string {
  if (!bridge || !bridge.connected) {
    return `<span class="bridge-pill" title="未检测到活跃 omp 终端，仍可通过 MCP 或 CLI 协同"><span class="dot"></span>MCP / CLI 模式</span>`;
  }
  const working = bridge.state !== "idle";
  const label = bridge.state === "idle" ? "omp 在线" : bridge.state === "waiting_user" ? "omp 等待输入" : "omp 工作中";
  return `<span class="bridge-pill"><span class="dot ${working ? "working" : "online"}"></span>${escapeHtml(label)}</span>`;
}

function filteredItems(): RequirementSummary[] {
  const q = state.query.trim().toLowerCase();
  if (!q) return state.items;
  return state.items.filter(
    (item) =>
      item.id.toLowerCase().includes(q) ||
      item.title.toLowerCase().includes(q) ||
      item.progressText.toLowerCase().includes(q),
  );
}

function handleDispatchOutcome(dispatch: DispatchOutcome | null, fallbackTitle: string): void {
  if (!dispatch) return;
  if (dispatch.delivered && dispatch.status === "submitted") {
    showToast("已将任务指令发送给当前 omp 会话");
    return;
  }
  if (dispatch.delivered && dispatch.status === "prefilled") {
    showToast("已将任务指令预填到 omp 输入框");
    return;
  }
  const subtitle =
    dispatch.reason === "draft_conflict"
      ? "检测到 omp 输入框已有未发送草稿，为防覆盖未自动写入，请复制下方指令："
      : dispatch.reason === "source_busy"
        ? "当前 omp 会话正在执行其他任务，请复制下方指令或稍后重试："
        : "当前未连接实时 omp 会话，请复制下方指令发给任意 Coding Agent（omp / Claude Code / Codex / Cursor）：";
  state.modal = { kind: "prompt_fallback", title: fallbackTitle, subtitle, prompt: dispatch.prompt };
}

async function refreshAll(preserveFocusId?: string): Promise<void> {
  const epoch = ++refreshEpoch;
  const startSelectedId = state.selectedId;
  try {
    const project = await api.getProject();
    if (state.busy || epoch !== refreshEpoch || state.selectedId !== startSelectedId) return;
    state.project = project;
    if (!project.initialized) {
      state.items = [];
      state.detail = null;
      state.loading = false;
      render(preserveFocusId);
      return;
    }

    if (state.selectedId) {
      try {
        const prevDesignVer = state.detail?.state.designVersion;
        const res = await api.getRequirement(state.selectedId);
        if (state.busy || epoch !== refreshEpoch || state.selectedId !== startSelectedId) return;
        state.detail = res.detail;
        if (prevDesignVer !== res.detail.state.designVersion) {
          state.designCompareText = null;
        }
        if (state.workspaceTab === "changes") {
          const diffRes = await api.getDiff(state.selectedId);
          if (state.busy || epoch !== refreshEpoch || state.selectedId !== startSelectedId) return;
          state.diffObs = diffRes.changes;
        }
      } catch (error) {
        if (error instanceof ApiClientError && error.code === "not_found") {
          state.selectedId = null;
          state.detail = null;
        } else {
          throw error;
        }
      }
    } else {
      const listRes = await api.listRequirements(state.scope);
      if (state.busy || epoch !== refreshEpoch || state.selectedId !== startSelectedId) return;
      state.items = listRes.items;
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : "读取工作台状态失败", true);
  } finally {
    if (!state.busy && epoch === refreshEpoch) {
      state.loading = false;
      render(preserveFocusId);
    }
  }
}

async function openRequirement(id: string): Promise<void> {
  state.homeScrollY = window.scrollY;
  state.selectedId = id;
  state.workspaceTab = "spec";
  state.editingSpec = false;
  state.moreMenuOpen = false;
  state.designViewVersion = null;
  state.designComparePrev = false;
  state.designCompareText = null;
  state.diffObs = null;
  state.selectedDiffFile = null;
  state.expandedLogs = {};
  await refreshAll();
  window.scrollTo(0, 0);
}

async function goHome(): Promise<void> {
  const restoreY = state.homeScrollY;
  state.selectedId = null;
  state.detail = null;
  state.editingSpec = false;
  state.moreMenuOpen = false;
  await refreshAll();
  requestAnimationFrame(() => window.scrollTo(0, restoreY));
}

async function runBusy<T>(fn: () => Promise<T>): Promise<T | null> {
  if (state.busy) return null;
  refreshEpoch += 1;
  state.busy = true;
  render();
  try {
    return await fn();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), true);
    return null;
  } finally {
    state.busy = false;
    render();
  }
}

function renderTopbar(): string {
  const projName = state.project?.project?.name ?? (state.project?.root.split("/").filter(Boolean).pop() || "Workbench");
  const bridgeHtml = bridgePillHtml(state.project?.bridge);
  const themeIcon = state.theme === "dark" ? "☀️" : "🌙";
  const canCreate = Boolean(state.project?.initialized && !state.selectedId);

  return `
    <header class="topbar">
      <div class="topbar-left">
        <span class="brand">${escapeHtml(projName)}</span>
        ${bridgeHtml}
      </div>
      <div class="topbar-right">
        <button class="btn ghost sm" type="button" data-action="toggle-theme" title="切换亮/暗色主题">${themeIcon}</button>
        <button class="btn ghost sm" type="button" data-action="refresh" title="刷新">刷新</button>
        ${canCreate ? `<button class="btn primary" type="button" data-action="open-new-req" data-testid="new-req-btn">+ 新建需求</button>` : ""}
      </div>
    </header>
  `;
}

function renderInitCard(): string {
  const defaultName = state.initName || state.project?.root.split("/").filter(Boolean).pop() || "my-project";
  return `
    <div class="empty-card" data-testid="init-card">
      <h2 style="margin:0 0 8px;font-size:18px;">初始化工作台</h2>
      <p class="muted" style="margin:0 0 16px;">在当前项目创建 <code class="mono">.workbench/</code> 目录，以 Markdown 规范和轻量状态文件管理需求与验证证据。</p>
      <label class="small muted" style="display:block;margin-bottom:4px;">项目名称</label>
      <input class="input" id="init-name" value="${escapeHtml(defaultName)}" style="margin-bottom:14px;" />
      <label class="small muted" style="display:block;margin-bottom:6px;">Git 隐私策略</label>
      <label class="radio-option ${state.initPrivacy === "local" ? "selected" : ""}" data-action="set-privacy" data-value="local">
        <input type="radio" name="privacy" ${state.initPrivacy === "local" ? "checked" : ""} />
        <div>
          <div style="font-weight:600;font-size:13px;">仅本机排除（推荐）</div>
          <div class="small muted">自动将 <code class="mono">/.workbench/</code> 加入本地 <code class="mono">.git/info/exclude</code>，不污染团队仓库。</div>
        </div>
      </label>
      <label class="radio-option ${state.initPrivacy === "tracked" ? "selected" : ""}" data-action="set-privacy" data-value="tracked">
        <input type="radio" name="privacy" ${state.initPrivacy === "tracked" ? "checked" : ""} />
        <div>
          <div style="font-weight:600;font-size:13px;">随 Git 仓库提交</div>
          <div class="small muted">将规范文档与交付记录纳入版本库，方便团队评审与跨设备同步。</div>
        </div>
      </label>
      <div class="modal-actions">
        <button class="btn primary" type="button" data-action="init-project" data-testid="init-submit-btn" ${state.busy ? "disabled" : ""}>初始化项目</button>
      </div>
    </div>
  `;
}

function renderHomeContent(): string {
  const visible = filteredItems();
  const decisions = visible.filter((item) => item.needsDecision);

  const decisionHtml =
    decisions.length > 0
      ? `
        <section class="decision-box" data-testid="needs-decision">
          <div class="decision-box-head">待你拍板 · ${decisions.length}</div>
          ${decisions
            .map(
              (item) => `
            <div class="decision-row" tabindex="0" data-action="open-req" data-id="${escapeHtml(item.id)}">
              <div style="display:flex;align-items:center;gap:10px;min-width:0;">
                <span class="req-id">${escapeHtml(item.id)}</span>
                <span class="req-title">${escapeHtml(item.title)}</span>
              </div>
              <div style="display:flex;align-items:center;gap:8px;">
                <span class="status-badge ${STAGE_META[item.stage].tone}">${escapeHtml(item.decisionReason ?? STAGE_META[item.stage].label)}</span>
                <span class="small muted">去处理 →</span>
              </div>
            </div>
          `,
            )
            .join("")}
        </section>
      `
      : "";

  let bodyHtml = "";
  if (state.items.length === 0) {
    const emptyMsg =
      state.scope === "active"
        ? "暂无活跃需求。点击右上角「+ 新建需求」，用一句话交给 Agent 开始。"
        : "当前筛选范围内没有需求。";
    bodyHtml = `
      <div class="empty-card" style="text-align:center;">
        <p class="muted" style="margin:0 0 14px;">${emptyMsg}</p>
        ${state.scope === "active" ? `<button class="btn primary" type="button" data-action="open-new-req">+ 新建需求</button>` : ""}
      </div>
    `;
  } else if (visible.length === 0) {
    bodyHtml = `
      <div class="empty-card" style="text-align:center;">
        <p class="muted" style="margin:0 0 12px;">没有匹配“${escapeHtml(state.query)}”的需求</p>
        <button class="btn" type="button" data-action="clear-search">清除搜索</button>
      </div>
    `;
  } else if (state.layout === "list") {
    bodyHtml = `
      <div class="req-list" data-testid="req-list">
        ${visible
          .map((item) => {
            const meta = STAGE_META[item.stage];
            return `
              <div class="req-row" tabindex="0" data-action="open-req" data-id="${escapeHtml(item.id)}" data-testid="req-row-${escapeHtml(item.id)}">
                <span class="req-id">${escapeHtml(item.id)}</span>
                <span class="req-title">${escapeHtml(item.title)}</span>
                <span class="req-progress"><span class="status-badge ${meta.tone}">${escapeHtml(meta.label)}</span> ${escapeHtml(item.progressText)}</span>
                <span class="req-time">${relativeTime(item.updatedAt)}</span>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  } else {
    const cols: Array<{ title: string; stages: Stage[] }> = [
      { title: "准备中", stages: ["draft", "designing", "awaiting_approval"] },
      { title: "执行中", stages: ["implementing"] },
      { title: "待验收", stages: ["awaiting_acceptance"] },
      { title: "已完成", stages: ["done"] },
    ];
    const blocked = visible.filter((i) => i.stage === "blocked");
    const cancelled = visible.filter((i) => i.stage === "cancelled");

    const blockedBanner =
      blocked.length > 0
        ? `
        <div class="decision-box" style="margin-bottom:12px;">
          <div class="decision-box-head" style="color:var(--danger);background:var(--danger-tint);">受阻需求 · ${blocked.length}</div>
          ${blocked
            .map(
              (item) => `
            <div class="decision-row" tabindex="0" data-action="open-req" data-id="${escapeHtml(item.id)}">
              <span><strong class="mono">${escapeHtml(item.id)}</strong> ${escapeHtml(item.title)}</span>
              <span class="small muted">${escapeHtml(item.blockedReason ?? "")}</span>
            </div>
          `,
            )
            .join("")}
        </div>
      `
        : "";

    const colsHtml = `
      <div class="board-grid" data-testid="req-board">
        ${cols
          .map((col) => {
            const cards = visible.filter((i) => col.stages.includes(i.stage));
            return `
              <div class="board-col">
                <div class="board-col-head"><span>${col.title}</span><span>${cards.length}</span></div>
                ${cards
                  .map(
                    (c) => `
                  <div class="board-card" tabindex="0" data-action="open-req" data-id="${escapeHtml(c.id)}">
                    <div class="board-card-meta">
                      <span class="mono">${escapeHtml(c.id)}</span>
                      <span class="status-badge ${STAGE_META[c.stage].tone}">${escapeHtml(STAGE_META[c.stage].label)}</span>
                    </div>
                    <div class="board-card-title">${escapeHtml(c.title)}</div>
                    <div class="board-card-meta"><span>${escapeHtml(c.progressText)}</span><span>${relativeTime(c.updatedAt)}</span></div>
                  </div>
                `,
                  )
                  .join("")}
              </div>
            `;
          })
          .join("")}
      </div>
    `;

    const cancelledHtml =
      cancelled.length > 0
        ? `<div class="section" style="margin-top:16px;"><div class="small muted" style="margin-bottom:6px;">已取消 (${cancelled.length})</div><div class="req-list">${cancelled
            .map(
              (item) =>
                `<div class="req-row" tabindex="0" data-action="open-req" data-id="${escapeHtml(item.id)}"><span class="req-id">${escapeHtml(item.id)}</span><span class="req-title muted">${escapeHtml(item.title)}</span><span class="req-progress">已取消</span><span class="req-time">${relativeTime(item.updatedAt)}</span></div>`,
            )
            .join("")}</div></div>`
        : "";

    bodyHtml = `${blockedBanner}${colsHtml}${cancelledHtml}`;
  }

  return `${decisionHtml}${bodyHtml}`;
}

function renderHome(): string {
  const toolbarHtml = `
    <div class="toolbar">
      <div class="search-wrap">
        <input class="input" id="search-input" data-testid="search-input" type="search" placeholder="搜索需求编号、标题或状态…" value="${escapeHtml(state.query)}" />
      </div>
      <div class="toolbar-controls">
        <div class="segmented" role="group" aria-label="范围筛选">
          ${(
            [
              ["active", "活跃"],
              ["done", "已完成"],
              ["all", "全部"],
            ] as const
          )
            .map(
              ([val, label]) =>
                `<button type="button" class="${state.scope === val ? "active" : ""}" data-action="set-scope" data-value="${val}">${label}</button>`,
            )
            .join("")}
        </div>
        <div class="segmented" role="group" aria-label="视图切换">
          ${(
            [
              ["list", "列表"],
              ["board", "看板"],
            ] as const
          )
            .map(
              ([val, label]) =>
                `<button type="button" class="${state.layout === val ? "active" : ""}" data-action="set-layout" data-value="${val}">${label}</button>`,
            )
            .join("")}
        </div>
      </div>
    </div>
  `;

  return `${toolbarHtml}<div id="home-content">${renderHomeContent()}</div>`;
}

function renderSpecTab(d: RequirementDetail): string {
  const { state: s, specMarkdown, designMarkdown, designHistoryVersions, validity } = d;

  let specSection = "";
  if (state.editingSpec) {
    specSection = `
      <div class="panel" style="padding:14px;" data-testid="spec-editor">
        <div class="section-head">
          <h3 class="section-title">编辑规范与验收条件</h3>
        </div>
        <label class="small muted">标题</label>
        <input class="input" id="edit-title" value="${escapeHtml(state.specDraftTitle)}" style="margin:4px 0 12px;" />
        <label class="small muted">目标与范围（Markdown）</label>
        <textarea class="textarea" id="edit-spec" style="min-height:130px;margin:4px 0 12px;">${escapeHtml(state.specDraftBody)}</textarea>
        <div class="section-head" style="margin-top:6px;">
          <span class="small muted">验收条件</span>
          <button class="btn sm" type="button" data-action="add-criterion">+ 添加条件</button>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;">
          ${state.specDraftCriteria
            .map(
              (c, idx) => `
            <div style="display:grid;grid-template-columns:80px 1fr 180px auto auto;gap:6px;align-items:center;" data-criterion-idx="${idx}">
              <input class="input mono" data-crit-field="id" value="${escapeHtml(c.id)}" placeholder="AC-1" />
              <input class="input" data-crit-field="description" value="${escapeHtml(c.description)}" placeholder="可验证结果描述" />
              <input class="input mono" data-crit-field="command" value="${escapeHtml(c.command)}" placeholder="验证命令（可选）" />
              <label class="small" style="display:flex;align-items:center;gap:4px;white-space:nowrap;">
                <input type="checkbox" data-crit-field="required" ${c.required ? "checked" : ""} /> 必需
              </label>
              <button class="btn sm ghost" type="button" data-action="remove-criterion" data-index="${idx}">删除</button>
            </div>
          `,
            )
            .join("")}
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="btn" type="button" data-action="cancel-edit-spec">取消</button>
          <button class="btn primary" type="button" data-action="save-spec" data-testid="save-spec-btn" ${state.busy ? "disabled" : ""}>保存修改</button>
        </div>
      </div>
    `;
  } else {
    const canEdit = s.stage !== "done" && s.stage !== "cancelled" && s.stage !== "blocked";
    specSection = `
      <div class="section">
        <div class="section-head">
          <h3 class="section-title">目标与范围</h3>
          ${canEdit ? `<button class="btn sm ghost" type="button" data-action="start-edit-spec">编辑</button>` : ""}
        </div>
        <div class="prose">${renderMarkdown(specMarkdown)}</div>
      </div>
    `;
  }

  const criteriaHtml = `
    <div class="section">
      <div class="section-head">
        <h3 class="section-title">验收条件 · 已通过 ${validity.coverage.requiredPassed} / ${validity.coverage.requiredTotal} 项必需</h3>
      </div>
      ${
        validity.coverage.items.length === 0
          ? `<p class="small muted">尚未定义验收条件。可让 Agent 自动梳理，或点击上方「编辑」手动添加。</p>`
          : `
        <div class="panel">
          ${validity.coverage.items
            .map((item) => {
              const meta = COVERAGE_META[item.state];
              const canRunSingle = Boolean(item.criterion.command && s.stage !== "done" && s.stage !== "cancelled");
              return `
                <div class="panel-row">
                  <div class="criterion-main">
                    <span class="status-badge ${meta.tone}">${meta.symbol} ${meta.label}</span>
                    <div style="min-width:0;">
                      <div>
                        <strong class="mono small">${escapeHtml(item.criterion.id)}</strong>
                        <span>${escapeHtml(item.criterion.description)}</span>
                        <span class="tag">${item.criterion.required ? "必需" : "参考"}</span>
                      </div>
                      ${item.criterion.command ? `<div class="criterion-cmd">${escapeHtml(item.criterion.command)}</div>` : ""}
                      ${item.reason && item.state !== "unverified" ? `<div class="small muted" style="margin-top:2px;">${escapeHtml(item.reason)}</div>` : ""}
                    </div>
                  </div>
                  ${
                    canRunSingle
                      ? `<button class="btn sm" type="button" data-action="verify-criterion" data-id="${escapeHtml(item.criterion.id)}" ${state.busy ? "disabled" : ""}>运行</button>`
                      : ""
                  }
                </div>
              `;
            })
            .join("")}
        </div>
      `
      }
    </div>
  `;

  let designContent = "";
  if (!designMarkdown.trim() && designHistoryVersions.length === 0) {
    designContent = `<p class="small muted">${s.track === "fast_track" ? "快速通道模式，未要求技术方案。" : "尚无技术方案，可点击上方横幅让 Agent 整理生成。"}</p>`;
  } else if (state.designComparePrev && state.designCompareText) {
    designContent = `
      <div class="small muted" style="margin-bottom:8px;">对比 v${state.designCompareText.prevVer} → v${state.designCompareText.currVer}</div>
      <div class="diff-code">${renderSimpleLineDiff(state.designCompareText.prev, state.designCompareText.curr)}</div>
    `;
  } else {
    const body =
      state.designViewVersion !== null && state.designCompareText && state.designCompareText.currVer === state.designViewVersion
        ? state.designCompareText.curr
        : designMarkdown;
    designContent = `<div class="prose">${renderMarkdown(body)}</div>`;
  }

  const versionControls =
    designHistoryVersions.length > 0
      ? `
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          ${
            designHistoryVersions.length > 1
              ? `<select class="select" id="design-version-select" style="width:auto;height:26px;padding:0 8px;font-size:12px;">
                  ${designHistoryVersions
                    .map((v) => {
                      const activeVer = state.designViewVersion ?? s.designVersion;
                      return `<option value="${v}" ${v === activeVer ? "selected" : ""}>版本 v${v}${v === s.designVersion ? " (最新)" : ""}</option>`;
                    })
                    .join("")}
                </select>
                <button class="btn sm ${state.designComparePrev ? "primary" : ""}" type="button" data-action="toggle-design-diff">对比上一版差异</button>`
              : `<span class="tag">版本 v${s.designVersion}</span>`
          }
        </div>
      `
      : "";

  const designSection = `
    <div class="section">
      <div class="section-head">
        <h3 class="section-title">技术方案</h3>
        ${versionControls}
      </div>
      ${designContent}
    </div>
  `;

  return `${specSection}${criteriaHtml}${designSection}`;
}

function renderChangesTab(d: RequirementDetail): string {
  const { state: s, validity } = d;
  const doneCount = s.tasks.filter((t) => t.status === "done").length;

  const tasksHtml = `
    <div class="section">
      <div class="section-head">
        <h3 class="section-title">实施任务${s.tasks.length > 0 ? ` · ${doneCount}/${s.tasks.length}` : ""}</h3>
      </div>
      ${
        s.tasks.length === 0
          ? `<p class="small muted">Agent 在实施阶段会自动拆解并更新任务步骤。</p>`
          : `
        <div class="panel">
          ${s.tasks
            .map((t) => {
              const m = TASK_META[t.status];
              return `
                <div class="panel-row">
                  <div style="display:flex;align-items:center;gap:8px;min-width:0;">
                    <span class="status-badge ${m.tone}">${m.symbol} ${m.label}</span>
                    <span class="mono small muted">${escapeHtml(t.id)}</span>
                    <span>${escapeHtml(t.title)}</span>
                  </div>
                  ${t.note ? `<span class="small muted">${escapeHtml(t.note)}</span>` : ""}
                </div>
              `;
            })
            .join("")}
        </div>
      `
      }
    </div>
  `;

  const hasCommands = s.criteria.some((c) => Boolean(c.command));
  const evList = [...validity.verifications].reverse();
  const evidenceHtml = `
    <div class="section">
      <div class="section-head">
        <h3 class="section-title">验证证据 · ${evList.length} 条</h3>
        ${
          hasCommands && s.stage !== "done" && s.stage !== "cancelled"
            ? `<button class="btn sm" type="button" data-action="banner-action" data-id="run_all_verifications" ${state.busy ? "disabled" : ""}>运行全部验证</button>`
            : ""
        }
      </div>
      ${
        evList.length === 0
          ? `<p class="small muted">尚无验证记录。验证必须由工作台真实执行命令产生。</p>`
          : `
        <div class="panel">
          ${evList
            .map((ev) => {
              const r = ev.record;
              const m = EVIDENCE_META[ev.effectiveState];
              const expanded = state.expandedLogs[r.id];
              return `
                <div class="panel-row" style="display:block;">
                  <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;">
                      <span class="status-badge ${m.tone}">${m.label}</span>
                      <code class="criterion-cmd" style="margin:0;">${escapeHtml(r.command)}</code>
                      <span class="small muted">退出码 ${r.timedOut ? "超时" : String(r.exitCode ?? "-")} · ${r.durationMs}ms</span>
                      ${r.criterionIds.length > 0 ? `<span class="tag">${escapeHtml(r.criterionIds.join(", "))}</span>` : ""}
                    </div>
                    <div style="display:flex;gap:6px;">
                      <button class="btn sm ghost" type="button" data-action="toggle-log" data-id="${escapeHtml(r.id)}">${expanded !== undefined ? "收起日志" : "查看日志"}</button>
                      ${
                        s.stage !== "done" && s.stage !== "cancelled"
                          ? `<button class="btn sm" type="button" data-action="rerun-verification" data-command="${escapeHtml(r.command)}" data-criteria="${escapeHtml(r.criterionIds.join(","))}" ${state.busy ? "disabled" : ""}>重跑</button>`
                          : ""
                      }
                    </div>
                  </div>
                  ${ev.staleReason ? `<div class="small muted" style="margin-top:4px;">${escapeHtml(ev.staleReason)}</div>` : ""}
                  ${expanded !== undefined ? `<div class="evidence-log">${escapeHtml(expanded || "（无命令输出）")}</div>` : ""}
                </div>
              `;
            })
            .join("")}
        </div>
      `
      }
      ${
        s.stage !== "done" && s.stage !== "cancelled"
          ? `
        <details style="margin-top:10px;">
          <summary class="small muted" style="cursor:pointer;">手动运行自定义验证命令</summary>
          <div class="panel" style="padding:12px;margin-top:8px;">
            <div style="display:grid;grid-template-columns:1fr 180px auto;gap:8px;align-items:center;">
              <input class="input mono" id="manual-verify-cmd" placeholder="例如: bun test" />
              <input class="input mono" id="manual-verify-criteria" placeholder="绑定条件ID，如 AC-1" />
              <button class="btn" type="button" data-action="run-manual-verify" ${state.busy ? "disabled" : ""}>运行</button>
            </div>
          </div>
        </details>
      `
          : ""
      }
    </div>
  `;

  const parsedFiles = state.diffObs ? parseUnifiedDiff(state.diffObs.diff) : [];
  if (parsedFiles.length > 0 && (!state.selectedDiffFile || !parsedFiles.some((f) => f.path === state.selectedDiffFile))) {
    state.selectedDiffFile = parsedFiles[0]!.path;
  }
  const activeDiff = parsedFiles.find((f) => f.path === state.selectedDiffFile) ?? parsedFiles[0] ?? null;

  const diffHtml = `
    <div class="section">
      <div class="section-head">
        <h3 class="section-title">代码改动（Git Diff）</h3>
        <button class="btn sm ghost" type="button" data-action="refresh-diff">刷新 Diff</button>
      </div>
      ${
        !state.diffObs
          ? `<p class="small muted">正在读取工作区代码改动…</p>`
          : !state.diffObs.isGitRepo
            ? `<p class="small muted">当前目录不是 Git 仓库。</p>`
            : parsedFiles.length === 0
              ? `<p class="small muted">当前工作区与基线之间没有代码改动。</p>`
              : `
            <div class="diff-layout">
              <div class="diff-files">
                ${parsedFiles
                  .map(
                    (f) => `
                  <button type="button" class="diff-file-btn ${f.path === activeDiff?.path ? "active" : ""}" data-action="select-diff-file" data-path="${escapeHtml(f.path)}">
                    <span class="mono" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(f.path)}</span>
                    <span class="small"><span style="color:var(--ok);">+${f.additions}</span> <span style="color:var(--danger);">-${f.deletions}</span></span>
                  </button>
                `,
                  )
                  .join("")}
              </div>
              <div class="diff-code">${activeDiff ? renderDiffLinesHtml(activeDiff.lines) : ""}</div>
            </div>
          `
      }
    </div>
  `;

  return `${tasksHtml}${evidenceHtml}${diffHtml}`;
}

function renderTimelineTab(d: RequirementDetail): string {
  const events = [...d.state.timeline].reverse();
  const actorLabel: Record<string, string> = { human: "人工", agent: "Agent", system: "系统" };
  return `
    <div class="section">
      <div class="section-head"><h3 class="section-title">事件时间线 · ${events.length}</h3></div>
      <div class="panel">
        ${events
          .map(
            (ev) => `
          <div class="timeline-item">
            <span class="small mono subtle">${formatDateTime(ev.at)}</span>
            <span class="tag">${actorLabel[ev.actor] ?? ev.actor}</span>
            <div style="min-width:0;">
              <div>${escapeHtml(ev.summary)}</div>
              ${ev.detail ? `<div class="small muted" style="margin-top:2px;white-space:pre-wrap;">${escapeHtml(ev.detail)}</div>` : ""}
            </div>
          </div>
        `,
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderWorkspace(): string {
  const d = state.detail;
  if (!d) return `<p class="muted">正在加载需求详情…</p>`;
  const { state: s, validity } = d;
  const meta = STAGE_META[s.stage];
  const { banner } = validity;
  const canFastTrack = s.stage === "draft" || s.stage === "designing" || s.stage === "awaiting_approval";
  const isTerminal = s.stage === "done" || s.stage === "cancelled";

  const moreMenu = state.moreMenuOpen
    ? `
      <div class="menu-pop" data-testid="more-menu">
        ${!isTerminal && s.stage !== "blocked" ? `<button type="button" class="menu-item" data-action="start-edit-spec">编辑规范与条件</button>` : ""}
        ${canFastTrack ? `<button type="button" class="menu-item" data-action="banner-action" data-id="authorize_fast_track">快速通道：直接实施</button>` : ""}
        ${s.stage === "blocked" ? `<button type="button" class="menu-item" data-action="banner-action" data-id="unblock">解除阻塞</button>` : ""}
        ${!isTerminal && s.stage !== "blocked" ? `<button type="button" class="menu-item" data-action="open-lifecycle" data-kind="block">标记阻塞…</button>` : ""}
        ${!isTerminal ? `<button type="button" class="menu-item danger" data-action="open-lifecycle" data-kind="cancel">取消需求…</button>` : ""}
        ${isTerminal ? `<button type="button" class="menu-item" data-action="open-lifecycle" data-kind="reopen">重新打开…</button>` : ""}
        <button type="button" class="menu-item" data-action="open-debug">复制调试信息</button>
      </div>
    `
    : "";

  const headerHtml = `
    <div class="ws-head">
      <div class="ws-head-main">
        <button class="btn ghost sm" type="button" data-action="go-home" data-testid="back-home-btn">← 工作</button>
        <span class="req-id">${escapeHtml(s.id)}</span>
        <h1 class="ws-title">${escapeHtml(s.title)}</h1>
        <span class="status-badge ${meta.tone}" data-testid="ws-stage-badge">${escapeHtml(meta.label)}</span>
        ${s.track === "fast_track" ? `<span class="tag">快速通道</span>` : ""}
      </div>
      <div class="menu-wrap">
        <button class="btn sm" type="button" data-action="toggle-more" data-testid="more-menu-btn">⋯ 更多</button>
        ${moreMenu}
      </div>
    </div>
  `;

  const bannerSubParts: string[] = [];
  if (s.lastFeedback) bannerSubParts.push(`修改意见：${s.lastFeedback}`);
  if (s.stage === "awaiting_acceptance" && !validity.acceptanceGate.ok) {
    bannerSubParts.push(validity.acceptanceGate.blockers.join("；"));
  }

  const bannerHtml = `
    <section class="action-banner ${banner.tone}" data-testid="action-banner">
      <div class="banner-text">
        <div class="banner-headline">${escapeHtml(banner.headline)}</div>
        ${bannerSubParts.length > 0 ? `<div class="banner-sub">${escapeHtml(bannerSubParts.join(" · "))}</div>` : ""}
      </div>
      <div class="banner-actions">
        ${banner.secondaryActions
          .map(
            (act) =>
              `<button class="btn" type="button" data-action="banner-action" data-id="${act.id}" data-testid="action-${act.id}" ${state.busy ? "disabled" : ""}>${escapeHtml(act.label)}</button>`,
          )
          .join("")}
        ${
          banner.primaryAction
            ? `<button class="btn primary" type="button" data-action="banner-action" data-id="${banner.primaryAction.id}" data-testid="action-${banner.primaryAction.id}" ${state.busy ? "disabled" : ""}>${escapeHtml(banner.primaryAction.label)}</button>`
            : ""
        }
      </div>
    </section>
  `;

  const tabsHtml = `
    <nav class="tabs" role="tablist">
      ${(
        [
          ["spec", "规范与方案"],
          ["changes", "变更与验证"],
          ["timeline", "时间线"],
        ] as const
      )
        .map(
          ([id, label]) =>
            `<button type="button" role="tab" aria-selected="${state.workspaceTab === id}" class="tab-btn ${state.workspaceTab === id ? "active" : ""}" data-action="set-ws-tab" data-tab="${id}" data-testid="tab-${id}">${label}</button>`,
        )
        .join("")}
    </nav>
  `;

  const contentHtml =
    state.workspaceTab === "spec"
      ? renderSpecTab(d)
      : state.workspaceTab === "changes"
        ? renderChangesTab(d)
        : renderTimelineTab(d);

  return `${headerHtml}${bannerHtml}${tabsHtml}${contentHtml}`;
}

function renderModal(): string {
  const m = state.modal;
  if (!m) return "";

  if (m.kind === "new_req") {
    return `
      <div class="modal-backdrop" data-action="close-modal-backdrop">
        <div class="modal-card" role="dialog" aria-modal="true" data-testid="new-req-modal">
          <h2 class="modal-title">新建需求</h2>
          <textarea class="textarea" id="new-req-goal" data-testid="new-req-goal" placeholder="你想实现或修复什么？写一句话即可…" style="min-height:110px;">${escapeHtml(m.goal)}</textarea>
          <div class="modal-actions">
            <button class="btn ghost" type="button" data-action="close-modal">取消</button>
            <button class="btn" type="button" data-action="submit-new-req" data-dispatch="false" data-testid="save-draft-btn" ${state.busy ? "disabled" : ""}>仅保存草稿</button>
            <button class="btn primary" type="button" data-action="submit-new-req" data-dispatch="true" data-testid="create-dispatch-btn" ${state.busy ? "disabled" : ""}>创建并让 Agent 整理方案</button>
          </div>
        </div>
      </div>
    `;
  }

  if (m.kind === "feedback") {
    return `
      <div class="modal-backdrop" data-action="close-modal-backdrop">
        <div class="modal-card" role="dialog" aria-modal="true" data-testid="feedback-modal">
          <h2 class="modal-title">提出修改意见</h2>
          <textarea class="textarea" id="feedback-input" placeholder="说明希望调整的地方…" style="min-height:100px;">${escapeHtml(m.feedback)}</textarea>
          <label class="small" style="display:flex;align-items:center;gap:6px;margin-top:10px;">
            <input type="checkbox" id="feedback-dispatch" ${m.dispatchAgent ? "checked" : ""} /> 提交后立即通知 Agent 修改
          </label>
          <div class="modal-actions">
            <button class="btn ghost" type="button" data-action="close-modal">取消</button>
            <button class="btn primary" type="button" data-action="submit-feedback" ${state.busy ? "disabled" : ""}>确认退回</button>
          </div>
        </div>
      </div>
    `;
  }

  if (m.kind === "lifecycle") {
    const titles = { block: "标记需求阻塞", cancel: "取消需求", reopen: "重新打开需求" };
    return `
      <div class="modal-backdrop" data-action="close-modal-backdrop">
        <div class="modal-card" role="dialog" aria-modal="true" data-testid="lifecycle-modal">
          <h2 class="modal-title">${titles[m.action]}</h2>
          <textarea class="textarea" id="lifecycle-reason" placeholder="请填写原因…" style="min-height:86px;">${escapeHtml(m.reason)}</textarea>
          <div class="modal-actions">
            <button class="btn ghost" type="button" data-action="close-modal">返回</button>
            <button class="btn ${m.action === "cancel" ? "danger-solid" : "primary"}" type="button" data-action="submit-lifecycle" ${state.busy ? "disabled" : ""}>确认</button>
          </div>
        </div>
      </div>
    `;
  }

  if (m.kind === "prompt_fallback") {
    return `
      <div class="modal-backdrop" data-action="close-modal-backdrop">
        <div class="modal-card" role="dialog" aria-modal="true" data-testid="prompt-fallback-modal">
          <h2 class="modal-title">${escapeHtml(m.title)}</h2>
          <p class="small muted" style="margin:0 0 10px;">${escapeHtml(m.subtitle)}</p>
          <textarea class="textarea mono" id="fallback-prompt-text" readonly style="min-height:180px;font-size:12px;">${escapeHtml(m.prompt)}</textarea>
          <div class="modal-actions">
            <button class="btn ghost" type="button" data-action="close-modal">关闭</button>
            <button class="btn primary" type="button" data-action="copy-fallback-prompt">复制任务指令</button>
          </div>
        </div>
      </div>
    `;
  }

  return `
    <div class="modal-backdrop" data-action="close-modal-backdrop">
      <div class="modal-card" role="dialog" aria-modal="true">
        <h2 class="modal-title">调试信息</h2>
        <textarea class="textarea mono" readonly style="min-height:140px;font-size:12px;">${escapeHtml(m.text)}</textarea>
        <div class="modal-actions">
          <button class="btn" type="button" data-action="close-modal">关闭</button>
        </div>
      </div>
    </div>
  `;
}

function render(focusSelector?: string): void {
  const rootEl = document.getElementById("app");
  if (!rootEl) return;

  let mainRoot = document.getElementById("main-root");
  let modalRoot = document.getElementById("modal-root");
  let toastRoot = document.getElementById("toast-root");
  if (!mainRoot || !modalRoot || !toastRoot) {
    rootEl.innerHTML = `<div id="main-root"></div><div id="modal-root"></div><div id="toast-root"></div>`;
    mainRoot = document.getElementById("main-root")!;
    modalRoot = document.getElementById("modal-root")!;
    toastRoot = document.getElementById("toast-root")!;
  }

  const activeSearch =
    !state.loading &&
    state.project?.initialized &&
    !state.selectedId &&
    document.activeElement?.id === "search-input";
  const existingHomeContent = activeSearch ? document.getElementById("home-content") : null;
  if (existingHomeContent) {
    const nextHome = renderHomeContent();
    if (existingHomeContent.innerHTML !== nextHome) {
      existingHomeContent.innerHTML = nextHome;
    }
    lastMainHtml = "";
  } else {
    const mainHtml = state.loading
      ? `<p class="muted">正在加载工作台…</p>`
      : !state.project?.initialized
        ? renderInitCard()
        : state.selectedId
          ? renderWorkspace()
          : renderHome();

    const nextMain = `<div class="shell">${renderTopbar()}${mainHtml}</div>`;
    if (nextMain !== lastMainHtml) {
      mainRoot.innerHTML = nextMain;
      lastMainHtml = nextMain;
    }
  }

  const nextModal = renderModal();
  if (nextModal !== lastModalHtml) {
    modalRoot.innerHTML = nextModal;
    lastModalHtml = nextModal;
  }

  renderToast();

  const searchInput = document.getElementById("search-input") as HTMLInputElement | null;
  if (searchInput && document.activeElement?.id !== "search-input" && focusSelector === "search") {
    searchInput.focus();
    searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
  }
  if (focusSelector && focusSelector !== "search") {
    const target = document.getElementById(focusSelector) as HTMLElement | null;
    target?.focus();
  }
}

async function executeVerify(id: string, body: Parameters<typeof api.verify>[1]) {
  return runBusy(async () => {
    const out = await api.verify(id, body);
    state.detail = out.detail;
    if (state.workspaceTab === "changes") {
      state.diffObs = (await api.getDiff(id)).changes;
    }
    return out;
  });
}

async function handleBannerAction(actionId: string): Promise<void> {
  const d = state.detail;
  if (!d) return;
  const id = d.state.id;
  const rev = d.state.revision;

  switch (actionId) {
    case "dispatch_design": {
      const res = await runBusy(async () => {
        const out = await api.dispatch(id, { action: "design" });
        state.detail = out.detail;
        handleDispatchOutcome(out.dispatch, "已生成方案整理指令");
        return out;
      });
      void res;
      break;
    }
    case "authorize_fast_track": {
      const dispatch = Boolean(state.project?.bridge.connected);
      const res = await runBusy(async () => {
        const out = await api.fastTrack(id, { expectedRevision: rev, dispatchAgent: dispatch });
        state.detail = out.detail;
        if (dispatch && out.dispatch) handleDispatchOutcome(out.dispatch, "快速通道已开启");
        return out;
      });
      if (res && !(dispatch && res.dispatch)) showToast("已开启快速通道，进入实施与验证阶段");
      break;
    }
    case "approve_and_implement": {
      const res = await runBusy(async () => {
        const out = await api.approve(id, { expectedRevision: rev, dispatchAgent: true });
        state.detail = out.detail;
        handleDispatchOutcome(out.dispatch, "方案已批准 · 开始实施指令");
        return out;
      });
      void res;
      break;
    }
    case "approve_only": {
      const res = await runBusy(async () => {
        const out = await api.approve(id, { expectedRevision: rev, dispatchAgent: false });
        state.detail = out.detail;
        return out;
      });
      if (res) showToast("已批准方案，可随时点击开始实施");
      break;
    }
    case "dispatch_implement": {
      const res = await runBusy(async () => {
        const out = await api.dispatch(id, { action: "implement" });
        state.detail = out.detail;
        handleDispatchOutcome(out.dispatch, "开始实施指令");
        return out;
      });
      void res;
      break;
    }
    case "dispatch_fix": {
      const res = await runBusy(async () => {
        const out = await api.dispatch(id, { action: "fix" });
        state.detail = out.detail;
        handleDispatchOutcome(out.dispatch, "修复失败项指令");
        return out;
      });
      void res;
      break;
    }
    case "request_changes":
      state.modal = { kind: "feedback", feedback: "", dispatchAgent: Boolean(state.project?.bridge.connected) };
      render("feedback-input");
      break;
    case "run_all_verifications": {
      const res = await executeVerify(id, { all: true });
      if (res) {
        const passed = res.runs.filter((r) => r.passed).length;
        showToast(`验证执行完成：${passed}/${res.runs.length} 条命令通过`, passed < res.runs.length);
      }
      break;
    }
    case "accept": {
      const res = await runBusy(async () => {
        const out = await api.accept(id, { expectedRevision: rev });
        state.detail = out.detail;
        return out;
      });
      if (res) showToast(`${id} 已验收完成`);
      break;
    }
    case "unblock": {
      const res = await runBusy(async () => {
        const out = await api.unblock(id, { expectedRevision: rev });
        state.detail = out.detail;
        return out;
      });
      if (res) showToast("已解除阻塞");
      break;
    }
    case "reopen":
      state.modal = { kind: "lifecycle", action: "reopen", reason: "" };
      render("lifecycle-reason");
      break;
  }
}

document.addEventListener("input", (event) => {
  const target = event.target as HTMLElement;
  if (target.id === "search-input") {
    state.query = (target as HTMLInputElement).value;
    const container = document.getElementById("home-content");
    if (container) {
      container.innerHTML = renderHomeContent();
      lastMainHtml = "";
    } else {
      render("search");
    }
  } else if (target.id === "init-name") {
    state.initName = (target as HTMLInputElement).value;
  } else if (target.id === "new-req-goal" && state.modal?.kind === "new_req") {
    state.modal.goal = (target as HTMLTextAreaElement).value;
  } else if (target.id === "feedback-input" && state.modal?.kind === "feedback") {
    state.modal.feedback = (target as HTMLTextAreaElement).value;
  } else if (target.id === "lifecycle-reason" && state.modal?.kind === "lifecycle") {
    state.modal.reason = (target as HTMLTextAreaElement).value;
  } else if (target.id === "edit-title") {
    state.specDraftTitle = (target as HTMLInputElement).value;
  } else if (target.id === "edit-spec") {
    state.specDraftBody = (target as HTMLTextAreaElement).value;
  } else if (target.hasAttribute("data-crit-field")) {
    const row = target.closest("[data-criterion-idx]");
    const idx = row ? Number(row.getAttribute("data-criterion-idx")) : -1;
    const item = state.specDraftCriteria[idx];
    const field = target.getAttribute("data-crit-field");
    if (item && field) {
      if (field === "required") item.required = (target as HTMLInputElement).checked;
      else if (field === "id") item.id = (target as HTMLInputElement).value;
      else if (field === "description") item.description = (target as HTMLInputElement).value;
      else if (field === "command") item.command = (target as HTMLInputElement).value;
    }
  }
});

document.addEventListener("change", async (event) => {
  const target = event.target as HTMLElement;
  if (target.id === "feedback-dispatch" && state.modal?.kind === "feedback") {
    state.modal.dispatchAgent = (target as HTMLInputElement).checked;
  } else if (target.id === "design-version-select" && state.detail) {
    const ver = Number((target as HTMLSelectElement).value);
    state.designViewVersion = ver;
    const id = state.detail.state.id;
    const curr =
      ver === state.detail.state.designVersion
        ? state.detail.designMarkdown
        : (await api.getDesignHistory(id, ver)).markdown;
    const prevVer = ver > 1 ? ver - 1 : ver;
    const prev = ver > 1 ? (await api.getDesignHistory(id, prevVer)).markdown : curr;
    state.designCompareText = { prev, curr, prevVer, currVer: ver };
    render();
  }
});

document.addEventListener("click", async (event) => {
  const rawTarget = event.target as HTMLElement;
  if (state.moreMenuOpen && !rawTarget.closest(".menu-wrap")) {
    state.moreMenuOpen = false;
    render();
  }

  const el = rawTarget.closest("[data-action]") as HTMLElement | null;
  if (!el) return;
  const action = el.getAttribute("data-action");

  if (action === "close-modal-backdrop" && rawTarget !== el) return;

  switch (action) {
    case "toggle-theme":
      state.theme = state.theme === "dark" ? "light" : "dark";
      applyTheme();
      render();
      break;
    case "refresh":
      await refreshAll();
      break;
    case "set-privacy":
      state.initPrivacy = el.getAttribute("data-value") === "tracked" ? "tracked" : "local";
      render();
      break;
    case "init-project": {
      const nameInput = document.getElementById("init-name") as HTMLInputElement | null;
      const res = await runBusy(() =>
        api.initProject({ name: nameInput?.value ?? state.initName, privacyMode: state.initPrivacy }),
      );
      if (res) {
        showToast("工作台初始化完成");
        await refreshAll();
      }
      break;
    }
    case "set-scope":
      state.scope = (el.getAttribute("data-value") ?? "active") as Scope;
      await refreshAll();
      break;
    case "set-layout":
      state.layout = el.getAttribute("data-value") === "board" ? "board" : "list";
      render();
      break;
    case "clear-search":
      state.query = "";
      render("search");
      break;
    case "open-new-req":
      state.modal = { kind: "new_req", goal: "" };
      render("new-req-goal");
      break;
    case "close-modal":
    case "close-modal-backdrop":
      state.modal = null;
      render();
      break;
    case "submit-new-req": {
      if (state.modal?.kind !== "new_req") break;
      const goal = state.modal.goal.trim();
      if (!goal) {
        showToast("请先输入需求目标", true);
        break;
      }
      const dispatchAgent = el.getAttribute("data-dispatch") === "true";
      const res = await runBusy(async () => {
        const out = await api.createRequirement({ goal, dispatchAgent });
        state.homeScrollY = window.scrollY;
        state.selectedId = out.detail.state.id;
        state.workspaceTab = "spec";
        state.editingSpec = false;
        state.moreMenuOpen = false;
        state.designViewVersion = null;
        state.designComparePrev = false;
        state.designCompareText = null;
        state.diffObs = null;
        state.selectedDiffFile = null;
        state.expandedLogs = {};
        state.detail = out.detail;
        state.modal = null;
        return out;
      });
      if (res) {
        window.scrollTo(0, 0);
        if (dispatchAgent && res.dispatch) {
          handleDispatchOutcome(res.dispatch, `${res.detail.state.id} · 方案整理指令`);
          render();
        } else {
          showToast(`已创建 ${res.detail.state.id}`);
        }
      }
      break;
    }
    case "open-req": {
      const id = el.getAttribute("data-id");
      if (id) await openRequirement(id);
      break;
    }
    case "go-home":
      await goHome();
      break;
    case "set-ws-tab": {
      const tab = (el.getAttribute("data-tab") ?? "spec") as WorkspaceTab;
      state.workspaceTab = tab;
      state.moreMenuOpen = false;
      if (tab === "changes" && state.selectedId) {
        try {
          state.diffObs = (await api.getDiff(state.selectedId)).changes;
        } catch {
          // Non-fatal; render handles null.
        }
      }
      render();
      break;
    }
    case "toggle-more":
      state.moreMenuOpen = !state.moreMenuOpen;
      render();
      break;
    case "banner-action": {
      state.moreMenuOpen = false;
      const actionId = el.getAttribute("data-id");
      if (actionId) await handleBannerAction(actionId);
      break;
    }
    case "start-edit-spec": {
      if (!state.detail) break;
      state.moreMenuOpen = false;
      state.workspaceTab = "spec";
      state.editingSpec = true;
      state.specDraftTitle = state.detail.state.title;
      state.specDraftBody = state.detail.specMarkdown;
      state.specDraftCriteria = state.detail.state.criteria.map((c: Criterion) => ({
        id: c.id,
        description: c.description,
        required: c.required,
        command: c.command ?? "",
      }));
      render("edit-title");
      break;
    }
    case "cancel-edit-spec":
      state.editingSpec = false;
      render();
      break;
    case "add-criterion":
      state.specDraftCriteria.push({
        id: `AC-${state.specDraftCriteria.length + 1}`,
        description: "",
        required: true,
        command: "",
      });
      render();
      break;
    case "remove-criterion": {
      const idx = Number(el.getAttribute("data-index"));
      state.specDraftCriteria.splice(idx, 1);
      render();
      break;
    }
    case "save-spec": {
      if (!state.detail) break;
      const id = state.detail.state.id;
      const rev = state.detail.state.revision;
      const criteria = state.specDraftCriteria
        .filter((c) => c.description.trim().length > 0)
        .map((c) => ({
          id: c.id.trim() || undefined,
          description: c.description.trim(),
          required: c.required,
          command: c.command.trim() || undefined,
        }));
      const res = await runBusy(async () => {
        const out = await api.updateSpec(id, {
          title: state.specDraftTitle,
          specMarkdown: state.specDraftBody,
          criteria,
          expectedRevision: rev,
        });
        state.detail = out.detail;
        state.editingSpec = false;
        return out;
      });
      if (res) showToast("已保存规范与验收条件");
      break;
    }
    case "toggle-design-diff": {
      if (!state.detail) break;
      state.designComparePrev = !state.designComparePrev;
      if (state.designComparePrev && !state.designCompareText) {
        const ver = state.designViewVersion ?? state.detail.state.designVersion;
        const curr =
          ver === state.detail.state.designVersion
            ? state.detail.designMarkdown
            : (await api.getDesignHistory(state.detail.state.id, ver)).markdown;
        const prevVer = ver > 1 ? ver - 1 : ver;
        const prev = ver > 1 ? (await api.getDesignHistory(state.detail.state.id, prevVer)).markdown : curr;
        state.designCompareText = { prev, curr, prevVer, currVer: ver };
      }
      render();
      break;
    }
    case "verify-criterion": {
      if (!state.detail) break;
      const cid = el.getAttribute("data-id")!;
      const crit = state.detail.state.criteria.find((c) => c.id === cid);
      if (!crit?.command) break;
      const res = await executeVerify(state.detail.state.id, { command: crit.command, criterionIds: [cid] });
      if (res) {
        showToast(res.runs[0]?.passed ? `${cid} 验证通过` : `${cid} 验证未通过`, !res.runs[0]?.passed);
      }
      break;
    }
    case "rerun-verification": {
      if (!state.detail) break;
      const cmd = el.getAttribute("data-command") ?? "";
      const cids = (el.getAttribute("data-criteria") ?? "").split(",").filter(Boolean);
      const res = await executeVerify(state.detail.state.id, { command: cmd, criterionIds: cids });
      if (res) {
        showToast(res.runs[0]?.passed ? "验证通过" : "验证失败", !res.runs[0]?.passed);
      }
      break;
    }
    case "run-manual-verify": {
      if (!state.detail) break;
      const cmd = (document.getElementById("manual-verify-cmd") as HTMLInputElement | null)?.value ?? "";
      const cidsRaw = (document.getElementById("manual-verify-criteria") as HTMLInputElement | null)?.value ?? "";
      const criterionIds = cidsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await executeVerify(state.detail.state.id, { command: cmd, criterionIds });
      if (res) {
        showToast(res.runs[0]?.passed ? "命令验证通过" : "命令验证未通过", !res.runs[0]?.passed);
      }
      break;
    }
    case "toggle-log": {
      if (!state.detail) break;
      const vid = el.getAttribute("data-id")!;
      if (state.expandedLogs[vid] !== undefined) {
        delete state.expandedLogs[vid];
        render();
      } else {
        const res = await api.getEvidence(state.detail.state.id, vid);
        state.expandedLogs[vid] = res.log;
        render();
      }
      break;
    }
    case "refresh-diff":
      if (state.selectedId) {
        state.diffObs = (await api.getDiff(state.selectedId)).changes;
        render();
      }
      break;
    case "select-diff-file":
      state.selectedDiffFile = el.getAttribute("data-path");
      render();
      break;
    case "submit-feedback": {
      if (state.modal?.kind !== "feedback" || !state.detail) break;
      const feedback = state.modal.feedback.trim();
      if (!feedback) {
        showToast("请填写修改意见", true);
        break;
      }
      const dispatchAgent = state.modal.dispatchAgent;
      const reqId = state.detail.state.id;
      const rev = state.detail.state.revision;
      const res = await runBusy(async () => {
        const out = await api.requestChanges(reqId, {
          feedback,
          expectedRevision: rev,
          dispatchAgent,
        });
        state.modal = null;
        state.detail = out.detail;
        if (dispatchAgent && out.dispatch) handleDispatchOutcome(out.dispatch, "已退回 · 通知 Agent 修改指令");
        return out;
      });
      if (res && !(dispatchAgent && res.dispatch)) showToast("已退回修改");
      break;
    }
    case "open-lifecycle":
      state.moreMenuOpen = false;
      state.modal = {
        kind: "lifecycle",
        action: (el.getAttribute("data-kind") ?? "block") as "block" | "cancel" | "reopen",
        reason: "",
      };
      render("lifecycle-reason");
      break;
    case "submit-lifecycle": {
      if (state.modal?.kind !== "lifecycle" || !state.detail) break;
      const reason = state.modal.reason.trim();
      if (!reason) {
        showToast("请填写原因", true);
        break;
      }
      const id = state.detail.state.id;
      const rev = state.detail.state.revision;
      const kind = state.modal.action;
      const res = await runBusy(async () => {
        const out = await (kind === "block"
          ? api.block(id, { reason, expectedRevision: rev })
          : kind === "cancel"
            ? api.cancel(id, { reason, expectedRevision: rev })
            : api.reopen(id, { reason, expectedRevision: rev }));
        state.modal = null;
        state.detail = out.detail;
        return out;
      });
      if (res) showToast("状态已更新");
      break;
    }
    case "open-debug": {
      if (!state.detail) break;
      state.moreMenuOpen = false;
      const s = state.detail.state;
      state.modal = {
        kind: "debug_info",
        text: JSON.stringify(
          {
            projectRoot: state.project?.root,
            projectId: state.project?.project?.projectId,
            id: s.id,
            revision: s.revision,
            specHash: s.specHash,
            designVersion: s.designVersion,
            designHash: s.designHash,
            baseline: s.baseline,
          },
          null,
          2,
        ),
      };
      render();
      break;
    }
    case "copy-fallback-prompt": {
      if (state.modal?.kind !== "prompt_fallback") break;
      try {
        await navigator.clipboard.writeText(state.modal.prompt);
        showToast("已复制到剪贴板");
      } catch {
        const elArea = document.getElementById("fallback-prompt-text") as HTMLTextAreaElement | null;
        elArea?.select();
        showToast("请按 Ctrl+C 复制选中文本");
      }
      break;
    }
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && document.activeElement instanceof HTMLElement) {
    const row = document.activeElement.closest('[data-action="open-req"]') as HTMLElement | null;
    if (row && document.activeElement === row) {
      event.preventDefault();
      const id = row.getAttribute("data-id");
      if (id) void openRequirement(id);
      return;
    }
  }
  if (event.key === "Escape") {
    if (state.modal) {
      state.modal = null;
      render();
    } else if (state.moreMenuOpen) {
      state.moreMenuOpen = false;
      render();
    }
    return;
  }
  if (
    event.key.toLowerCase() === "n" &&
    !state.modal &&
    !state.selectedId &&
    state.project?.initialized &&
    document.activeElement?.tagName !== "INPUT" &&
    document.activeElement?.tagName !== "TEXTAREA"
  ) {
    event.preventDefault();
    state.modal = { kind: "new_req", goal: "" };
    render("new-req-goal");
  }
});

applyTheme();
connectUiWebSocket((ev) => {
  const activeEl = document.activeElement;
  const typingNonSearch =
    (activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement) && activeEl.id !== "search-input";
  if (ev.type === "bridge.status" && state.project) {
    state.project.bridge = ev.bridge as BridgeStatus;
    if (!state.editingSpec && !state.modal && !state.busy && !typingNonSearch) render();
  } else if (ev.type === "workbench.updated") {
    if (!state.editingSpec && !state.modal && !state.busy && !typingNonSearch) {
      const prevMain = lastMainHtml;
      const y = window.scrollY;
      void refreshAll().then(() => {
        if (lastMainHtml !== prevMain) {
          requestAnimationFrame(() => window.scrollTo(0, y));
        }
      });
    }
  }
});
void refreshAll();
