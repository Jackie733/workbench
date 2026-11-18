import { useLayoutEffect } from "react";
import { ArrowRight, Plus } from "lucide-react";
import type { OutputLanguage, RequirementSummary, Stage } from "../../core/types.ts";
import {
  initProjectSubmit,
  openAddProjectModal,
  openRequirement,
  useProjectQuery,
  useRequirementsQuery,
} from "../queries.ts";
import { filteredItems, progressDetail, relativeTime, STAGE_META } from "../state.ts";
import { useStreamStore } from "../stores/streamStore.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { Icon } from "./Icon.tsx";

export function EmptyHubCard() {
  return (
    <div className="empty-card" data-testid="empty-hub-card">
      <h2 style={{ margin: "0 0 10px", fontSize: 18, fontWeight: 600 }}>尚未添加本地项目</h2>
      <p className="muted" style={{ margin: "0 0 16px" }}>
        在左侧栏点击「添加」或下方按钮选择一个本地 Git 仓库或项目目录，即可开始管理需求、技术方案与自动化验证。
      </p>
      <button
        className="btn primary"
        type="button"
        data-testid="empty-hub-add-btn"
        onClick={() => void openAddProjectModal()}
      >
        <Icon icon={Plus} size={16} /> 添加本地项目
      </button>
    </div>
  );
}

export function InitCard() {
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const initName = useUiStore((s) => s.initName);
  const initPrivacy = useUiStore((s) => s.initPrivacy);
  const initOutputLanguage = useUiStore((s) => s.initOutputLanguage);
  const busy = useUiStore((s) => s.busy);
  const setInitName = useUiStore((s) => s.setInitName);
  const setInitPrivacy = useUiStore((s) => s.setInitPrivacy);
  const setInitOutputLanguage = useUiStore((s) => s.setInitOutputLanguage);

  const { data: project } = useProjectQuery(activeProjectId);
  const rootLabel = project?.root ?? "";

  return (
    <div className="init-card" data-testid="init-card">
      <h2>初始化项目工作台</h2>
      <p className="muted" style={{ margin: "0 0 14px" }}>
        将在项目目录 <code>{rootLabel}</code> 建立轻量级 <code>.workbench/</code> 目录，用于保存可读规范（Markdown）、方案历史与验证证据。
      </p>
      <div style={{ marginBottom: 12 }}>
        <label className="muted" style={{ display: "block", fontSize: 12, marginBottom: 4 }}>
          项目名称
        </label>
        <input
          className="input"
          id="init-name"
          value={initName}
          placeholder="输入项目名称（默认使用目录名）"
          onChange={(e) => setInitName(e.target.value)}
        />
      </div>
      <div style={{ marginBottom: 12 }}>
        <label className="muted" style={{ display: "block", fontSize: 12, marginBottom: 4 }}>
          模型文档输出语言偏好
        </label>
        <select
          className="select"
          id="init-output-language"
          style={{ width: "100%" }}
          value={initOutputLanguage}
          onChange={(e) => setInitOutputLanguage(e.target.value as OutputLanguage | "inherit")}
        >
          <option value="inherit">跟随 Hub 全局默认（简体中文）</option>
          <option value="zh-CN">简体中文 (zh-CN)</option>
          <option value="en">English (en)</option>
          <option value="auto">跟随需求输入语言 (auto)</option>
        </select>
      </div>
      <div className="radio-row">
        <label
          className={`radio-card ${initPrivacy === "local" ? "selected" : ""}`}
          onClick={() => setInitPrivacy("local")}
        >
          <input type="radio" name="privacy" checked={initPrivacy === "local"} readOnly />
          <div>
            <strong>仅本机跟踪（推荐）</strong>
            <div className="muted" style={{ fontSize: 12 }}>
              自动写入 <code>.git/info/exclude</code>，不打扰团队代码库。
            </div>
          </div>
        </label>
        <label
          className={`radio-card ${initPrivacy === "tracked" ? "selected" : ""}`}
          onClick={() => setInitPrivacy("tracked")}
        >
          <input type="radio" name="privacy" checked={initPrivacy === "tracked"} readOnly />
          <div>
            <strong>随仓库 Git 跟踪</strong>
            <div className="muted" style={{ fontSize: 12 }}>
              将规范与方案版本纳入仓库历史，适合多人协同审阅。
            </div>
          </div>
        </label>
      </div>
      <button
        className="btn primary"
        type="button"
        data-action="submit-init"
        data-testid="init-submit-btn"
        disabled={busy}
        onClick={() => void initProjectSubmit()}
      >
        立即初始化
      </button>
    </div>
  );
}

function RequirementBoard({ items }: { items: RequirementSummary[] }) {
  const cols: Array<{ key: string; title: string; stages: Stage[] }> = [
    { key: "prep", title: "准备中", stages: ["draft", "designing", "awaiting_approval"] },
    { key: "doing", title: "执行中", stages: ["implementing"] },
    { key: "accept", title: "待验收", stages: ["awaiting_acceptance"] },
    { key: "done", title: "已完成", stages: ["done"] },
  ];
  const blockedItems = items.filter((i) => i.stage === "blocked");

  return (
    <>
      {blockedItems.length > 0 && (
        <div className="callout danger" style={{ marginBottom: 14 }}>
          <strong>存在 {blockedItems.length} 项受阻需求：</strong>
          {blockedItems.map((b) => (
            <button
              key={b.id}
              className="btn ghost xs"
              type="button"
              onClick={() => void openRequirement(b.id)}
            >
              {b.id} · {b.title}
            </button>
          ))}
        </div>
      )}
      <div className="board" data-testid="req-board">
        {cols.map((col) => {
          const list = items.filter((item) => col.stages.includes(item.stage));
          return (
            <div key={col.key} className="board-col">
              <div className="board-col-head">
                <span>{col.title}</span>
                <span>{list.length}</span>
              </div>
              {list.length === 0 ? (
                <div className="muted" style={{ fontSize: 12, padding: "8px 2px" }}>
                  暂无需求
                </div>
              ) : (
                list.map((item) => {
                  const meta = STAGE_META[item.stage];
                  const detail = progressDetail(item);
                  return (
                    <div
                      key={item.id}
                      className="board-card"
                      data-action="open-req"
                      data-id={item.id}
                      data-testid={`req-card-${item.id}`}
                      tabIndex={0}
                      onClick={() => void openRequirement(item.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          void openRequirement(item.id);
                        }
                      }}
                    >
                      <div className="board-card-top">
                        <span className="req-id">{item.id}</span>
                        <span className={`badge ${meta.tone}`}>{meta.label}</span>
                      </div>
                      <div style={{ fontWeight: 500, fontSize: 13.5, marginBottom: 6 }}>{item.title}</div>
                      {detail && (
                        <div className="muted" style={{ fontSize: 12 }}>
                          {detail}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

export function HomeView() {
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const scope = useUiStore((s) => s.scope);
  const layout = useUiStore((s) => s.layout);
  const query = useUiStore((s) => s.query);
  const homeScrollY = useUiStore((s) => s.homeScrollY);
  const setScope = useUiStore((s) => s.setScope);
  const setLayout = useUiStore((s) => s.setLayout);
  const setQuery = useUiStore((s) => s.setQuery);
  const setModal = useUiStore((s) => s.setModal);

  const activeRuns = useStreamStore((s) => s.activeRuns);

  const { data: project } = useProjectQuery(activeProjectId);
  const { data: reqList } = useRequirementsQuery(activeProjectId, scope, Boolean(project?.initialized));
  const rawItems = reqList?.items ?? [];

  useLayoutEffect(() => {
    if (homeScrollY > 0) {
      window.scrollTo(0, homeScrollY);
    }
  }, [homeScrollY]);

  const activeCnt = rawItems.filter((i) => i.stage !== "done" && i.stage !== "cancelled").length;
  const decisionCnt = rawItems.filter((i) => i.needsDecision).length;
  const doneCnt = rawItems.filter((i) => i.stage === "done").length;

  const visible = filteredItems(rawItems, query);
  const pendingDecisions = rawItems.filter((i) => i.needsDecision);

  return (
    <div data-testid="home-view">
      <div className="mission-stats">
        <div className="stat-pill">
          <span className="muted xs">活跃需求</span>
          <strong>{activeCnt}</strong>
        </div>
        <div className={`stat-pill ${decisionCnt > 0 ? "warn" : ""}`}>
          <span className="muted xs">待拍板</span>
          <strong>{decisionCnt}</strong>
        </div>
        <div className="stat-pill">
          <span className="muted xs">已完成</span>
          <strong>{doneCnt}</strong>
        </div>
      </div>

      <div className="toolbar">
        <input
          className="search-box"
          id="search-input"
          data-testid="search-input"
          type="search"
          value={query}
          placeholder="搜索需求编号、标题或进度…"
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="segmented" role="tablist" data-testid="scope-tabs">
          {(["active", "done", "all"] as const).map((sc) => (
            <button
              key={sc}
              type="button"
              className={scope === sc ? "active" : ""}
              data-action="set-scope"
              data-value={sc}
              onClick={() => setScope(sc)}
            >
              {sc === "active" ? "活跃" : sc === "done" ? "已完成" : "全部"}
            </button>
          ))}
        </div>
        <div className="segmented" data-testid="layout-toggle">
          <button
            type="button"
            className={layout === "list" ? "active" : ""}
            data-action="set-layout"
            data-value="list"
            onClick={() => setLayout("list")}
          >
            列表
          </button>
          <button
            type="button"
            className={layout === "board" ? "active" : ""}
            data-action="set-layout"
            data-value="board"
            onClick={() => setLayout("board")}
          >
            看板
          </button>
        </div>
        <button
          className="btn primary"
          type="button"
          data-action="open-new-req"
          data-testid="new-req-btn"
          onClick={() => setModal({ kind: "new_req", goal: "" })}
        >
          <Icon icon={Plus} size={14} /> 新建需求
        </button>
      </div>

      <div id="home-content">
        {pendingDecisions.length > 0 && !query.trim() && (
          <section className="decision-box" data-testid="decision-box">
            <h2>待你拍板 ({pendingDecisions.length})</h2>
            {pendingDecisions.map((item) => (
              <div key={item.id} className="decision-row">
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <span className="req-id">{item.id}</span>
                  <span
                    style={{
                      fontWeight: 500,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {item.title}
                  </span>
                  <span className="badge warning">{item.decisionReason ?? "待确认"}</span>
                </div>
                <button className="btn xs" type="button" onClick={() => void openRequirement(item.id)}>
                  去处理 <Icon icon={ArrowRight} size={14} />
                </button>
              </div>
            ))}
          </section>
        )}

        <div id="home-body">
          {rawItems.length === 0 ? (
            <div className="empty-card" data-testid="empty-state" style={{ textAlign: "center" }}>
              <p style={{ margin: "0 0 8px", fontWeight: 500 }}>还没有需求</p>
              <p className="muted" style={{ margin: "0 0 14px", fontSize: 13 }}>
                用一句话描述你想实现或修复的内容，工作台会自动组织规范、方案、验证与代码对比。
              </p>
              <button
                className="btn primary"
                type="button"
                data-action="open-new-req"
                data-testid="empty-new-req-btn"
                onClick={() => setModal({ kind: "new_req", goal: "" })}
              >
                <Icon icon={Plus} size={14} /> 新建第一条需求
              </button>
            </div>
          ) : visible.length === 0 ? (
            <div className="empty-card" data-testid="empty-state" style={{ textAlign: "center" }}>
              <p className="muted" style={{ margin: "0 0 12px" }}>
                没有匹配“{query}”的需求
              </p>
              <button
                className="btn"
                type="button"
                data-action="clear-search"
                onClick={() => setQuery("")}
              >
                清除搜索
              </button>
            </div>
          ) : layout === "list" ? (
            <div className="req-list" data-testid="req-list">
              {visible.map((item) => {
                const meta = STAGE_META[item.stage];
                const detail = progressDetail(item);
                const activeReqRun = Object.values(activeRuns).find(
                  (r) => r.requirementId === item.id && r.status === "running",
                );
                return (
                  <div
                    key={item.id}
                    className="req-row"
                    data-action="open-req"
                    data-id={item.id}
                    data-testid={`req-row-${item.id}`}
                    tabIndex={0}
                    onClick={() => void openRequirement(item.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        void openRequirement(item.id);
                      }
                    }}
                  >
                    <span className="req-id">{item.id}</span>
                    <div data-testid={`req-card-${item.id}`}>
                      <div className="req-title">{item.title}</div>
                      <div className="req-sub">
                        <span className={`badge ${meta.tone}`}>{meta.label}</span>
                        {item.github?.issue && (
                          <span className="badge neutral">Issue #{item.github.issue.number}</span>
                        )}
                        {item.github?.pr && (
                          <span className={`badge ${item.github.pr.state === "merged" ? "success" : "info"}`}>
                            PR #{item.github.pr.number}
                          </span>
                        )}
                        {activeReqRun && (
                          <span className="badge info">
                            <span className="pulse-dot" /> {activeReqRun.harness}/{activeReqRun.model} 执行中
                          </span>
                        )}
                        {detail && <span>{detail}</span>}
                      </div>
                    </div>
                    <span className="req-time">{relativeTime(item.updatedAt)}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <RequirementBoard items={visible} />
          )}
        </div>
      </div>
    </div>
  );
}
