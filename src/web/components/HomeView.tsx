import { useLayoutEffect } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CircleAlert,
  Clock,
  Columns3,
  FolderGit2,
  FolderPlus,
  GitBranch,
  GitPullRequest,
  Info,
  Link2,
  List,
  Plus,
  RefreshCw,
  Search,
  WifiOff,
  X,
} from "lucide-react";
import type { OutputLanguage, RequirementSummary, Stage } from "../../core/types.ts";
import { api, type HubProjectSummary, type ProjectSandboxesResponse } from "../api.ts";
import { t, translateRef } from "../i18n.ts";
import {
  initProjectSubmit,
  invalidateAllWorkbenchQueries,
  openAddProjectModal,
  openRequirement,
  queryClient,
  queryKeys,
  runBusy,
  syncSandboxBaseAction,
  useProjectQuery,
  useProjectSandboxesQuery,
  useRequirementsQuery,
} from "../queries.ts";
import { filteredItems, findActiveRequirementRun, partitionPendingDecisions, progressDetail, relativeTime, STAGE_META } from "../state.ts";
import { useStreamStore } from "../stores/streamStore.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { Icon, STAGE_ICONS } from "./Icon.tsx";

function isBlockingDecision(item: RequirementSummary): boolean {
  if (item.decisionReasonKey) {
    return item.decisionReasonKey === "core.decision.blocked" || item.decisionReasonKey === "core.decision.reviewBlock";
  }
  return item.stage === "blocked";
}

export function RemoteNodeOfflineCard({ project }: { project: HubProjectSummary }) {
  const language = useUiStore((s) => s.language);
  const nodeLabel = project.nodeName ?? project.nodeId ?? "remote";
  return (
    <div className="empty-card" data-testid="remote-node-offline-card">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <Icon icon={WifiOff} size={20} />
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
          {t(language, "remote.title", { node: nodeLabel })}
        </h2>
      </div>
      <p className="muted" style={{ margin: "0 0 12px" }}>
        {t(language, "remote.descPrefix")}
        <strong>{project.name}</strong>
        {t(language, "remote.descMiddle")}
        <code>{project.root}</code>
        {t(language, "remote.descMid2")}
        <strong>{nodeLabel}</strong>
        {t(language, "remote.descSuffix")}
      </p>
      <div className="callout info xs" style={{ marginBottom: 14 }}>
        <Icon icon={Info} size={14} />{" "}
        {t(language, "remote.hintPrefix")}
        <strong>{nodeLabel}</strong>
        {t(language, "remote.hintMiddle")}
        <pre style={{ margin: "6px 0 0", fontFamily: "var(--mono)", fontSize: 12 }}>wb node start</pre>
      </div>
      <button
        className="btn primary"
        type="button"
        data-testid="remote-node-refresh-btn"
        onClick={() => void invalidateAllWorkbenchQueries()}
      >
        <Icon icon={RefreshCw} size={14} /> {t(language, "remote.refresh")}
      </button>
    </div>
  );
}

export function EmptyHubCard() {
  const language = useUiStore((s) => s.language);
  return (
    <div className="empty-card" data-testid="empty-hub-card">
      <h2 className="icon-heading" style={{ margin: "0 0 10px", fontSize: 18, fontWeight: 600 }}>
        <Icon icon={FolderPlus} size={20} />
        <span>{t(language, "hub.emptyTitle")}</span>
      </h2>
      <p className="muted" style={{ margin: "0 0 16px" }}>
        {t(language, "hub.emptyDesc")}
      </p>
      <button
        className="btn primary"
        type="button"
        data-testid="empty-hub-add-btn"
        onClick={() => void openAddProjectModal()}
      >
        <Icon icon={Plus} size={16} /> {t(language, "hub.addLocal")}
      </button>
    </div>
  );
}

export function InitCard() {
  const language = useUiStore((s) => s.language);
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
      <h2 className="icon-heading">
        <Icon icon={FolderGit2} size={20} />
        <span>{t(language, "init.title")}</span>
      </h2>
      <p className="muted" style={{ margin: "0 0 14px" }}>
        {t(language, "init.descPrefix")}
        <code>{rootLabel}</code>
        {t(language, "init.descMiddle")}
        <code>.workbench/</code>
        {t(language, "init.descSuffix")}
      </p>
      <div style={{ marginBottom: 12 }}>
        <label className="muted" style={{ display: "block", fontSize: 12, marginBottom: 4 }}>
          {t(language, "init.nameLabel")}
        </label>
        <input
          className="input"
          id="init-name"
          value={initName}
          placeholder={t(language, "init.namePlaceholder")}
          onChange={(e) => setInitName(e.target.value)}
        />
      </div>
      <div style={{ marginBottom: 12 }}>
        <label className="muted" style={{ display: "block", fontSize: 12, marginBottom: 4 }}>
          {t(language, "init.outputLanguageLabel")}
        </label>
        <select
          className="select"
          id="init-output-language"
          style={{ width: "100%" }}
          value={initOutputLanguage}
          onChange={(e) => setInitOutputLanguage(e.target.value as OutputLanguage | "inherit")}
        >
          <option value="inherit">{t(language, "init.langInherit")}</option>
          <option value="zh-CN">{t(language, "init.langZh")}</option>
          <option value="en">{t(language, "init.langEn")}</option>
          <option value="auto">{t(language, "init.langAuto")}</option>
        </select>
      </div>
      <div className="radio-row">
        <label
          className={`radio-card ${initPrivacy === "local" ? "selected" : ""}`}
          onClick={() => setInitPrivacy("local")}
        >
          <input type="radio" name="privacy" checked={initPrivacy === "local"} readOnly />
          <div>
            <strong>{t(language, "init.localTitle")}</strong>
            <div className="muted" style={{ fontSize: 12 }}>
              {t(language, "init.localDescPrefix")}
              <code>.git/info/exclude</code>
              {t(language, "init.localDescSuffix")}
            </div>
          </div>
        </label>
        <label
          className={`radio-card ${initPrivacy === "tracked" ? "selected" : ""}`}
          onClick={() => setInitPrivacy("tracked")}
        >
          <input type="radio" name="privacy" checked={initPrivacy === "tracked"} readOnly />
          <div>
            <strong>{t(language, "init.trackedTitle")}</strong>
            <div className="muted" style={{ fontSize: 12 }}>
              {t(language, "init.trackedDesc")}
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
        <Icon icon={Check} size={14} /> {t(language, "init.submit")}
      </button>
    </div>
  );
}

function RequirementBoard({ items }: { items: RequirementSummary[] }) {
  const language = useUiStore((s) => s.language);
  const cols: Array<{ key: string; title: string; stages: Stage[] }> = [
    {
      key: "prep",
      title: t(language, "board.preparing"),
      stages: ["draft", "designing", "awaiting_approval"],
    },
    { key: "doing", title: t(language, "board.doing"), stages: ["implementing"] },
    { key: "accept", title: t(language, "board.accepting"), stages: ["awaiting_acceptance"] },
    { key: "done", title: t(language, "board.completed"), stages: ["done"] },
  ];
  const blockedItems = items.filter((i) => i.stage === "blocked");

  return (
    <>
      {blockedItems.length > 0 && (
        <div className="callout danger" style={{ marginBottom: 14 }}>
          <strong className="callout-lead">
            <Icon icon={AlertTriangle} size={14} />
            <span>{t(language, "board.blocked", { count: blockedItems.length })}</span>
          </strong>
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
                  {t(language, "board.empty")}
                </div>
              ) : (
                list.map((item) => {
                  const meta = STAGE_META[item.stage];
                  const detail = progressDetail(item, language);
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
                        <span className={`badge ${meta.tone}`}>
                          <Icon icon={STAGE_ICONS[item.stage]} size={14} /> {meta.labels[language]}
                        </span>
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
  const language = useUiStore((s) => s.language);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const scope = useUiStore((s) => s.scope);
  const layout = useUiStore((s) => s.layout);
  const query = useUiStore((s) => s.query);
  const homeScrollY = useUiStore((s) => s.homeScrollY);
  const setScope = useUiStore((s) => s.setScope);
  const setLayout = useUiStore((s) => s.setLayout);
  const setQuery = useUiStore((s) => s.setQuery);
  const setModal = useUiStore((s) => s.setModal);

  const busy = useUiStore((s) => s.busy);
  const activeRuns = useStreamStore((s) => s.activeRuns);

  const { data: project } = useProjectQuery(activeProjectId);
  const { data: reqList } = useRequirementsQuery(activeProjectId, scope, Boolean(project?.initialized));
  const { data: sandboxesData } = useProjectSandboxesQuery(activeProjectId, Boolean(project?.initialized));
  const rawItems = reqList?.items ?? [];
  const mergeOrder = sandboxesData?.mergeOrder ?? null;
  const activeSandboxes = sandboxesData?.sandboxes ?? [];

  useLayoutEffect(() => {
    if (homeScrollY > 0) {
      window.scrollTo(0, homeScrollY);
    }
  }, [homeScrollY]);

  const activeRunList = Object.values(activeRuns);
  const pendingDecisions = partitionPendingDecisions(rawItems, activeRunList, activeProjectId).humanPending.sort(
    (a, b) => {
      const aBlock = isBlockingDecision(a) ? 0 : 1;
      const bBlock = isBlockingDecision(b) ? 0 : 1;
      if (aBlock !== bBlock) return aBlock - bBlock;
      return a.updatedAt - b.updatedAt;
    },
  );

  const activeCnt = rawItems.filter((i) => i.stage !== "done" && i.stage !== "cancelled").length;
  const decisionCnt = pendingDecisions.length;
  const doneCnt = rawItems.filter((i) => i.stage === "done").length;

  const visible = filteredItems(rawItems, query, language);

  return (
    <div data-testid="home-view">
      <div className="mission-stats">
        <div className="stat-pill">
          <span className="muted xs">{t(language, "home.active")}</span>
          <strong>{activeCnt}</strong>
        </div>
        <div className={`stat-pill ${decisionCnt > 0 ? "warn" : ""}`}>
          <span className="muted xs">{t(language, "home.decisions")}</span>
          <strong>{decisionCnt}</strong>
        </div>
        <div className="stat-pill">
          <span className="muted xs">{t(language, "home.done")}</span>
          <strong>{doneCnt}</strong>
        </div>
      </div>

      <div className="toolbar">
        <div className="search-wrap">
          <Icon icon={Search} size={14} />
          <input
            className="search-box"
            id="search-input"
            data-testid="search-input"
            type="search"
            value={query}
            placeholder={t(language, "home.searchPlaceholder")}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
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
              {sc === "active"
                ? t(language, "home.scope.active")
                : sc === "done"
                  ? t(language, "home.scope.done")
                  : t(language, "home.scope.all")}
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
            <Icon icon={List} size={14} /> {t(language, "home.layout.list")}
          </button>
          <button
            type="button"
            className={layout === "board" ? "active" : ""}
            data-action="set-layout"
            data-value="board"
            onClick={() => setLayout("board")}
          >
            <Icon icon={Columns3} size={14} /> {t(language, "home.layout.board")}
          </button>
        </div>
        <button
          className="btn primary"
          type="button"
          data-action="open-new-req"
          data-testid="new-req-btn"
          onClick={() => setModal({ kind: "new_req", goal: "" })}
        >
          <Icon icon={Plus} size={14} /> {t(language, "home.newRequirement")}
        </button>
      </div>

      <div id="home-content">
        {pendingDecisions.length > 0 && !query.trim() && (
          <section className="decision-box" data-testid="decision-box">
            <h2>
              <Icon icon={AlertTriangle} size={14} />
              <span>{t(language, "home.decisionBox", { count: pendingDecisions.length })}</span>
            </h2>
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
                  <span className={`badge ${isBlockingDecision(item) ? "danger" : "warning"}`}>
                    <Icon icon={isBlockingDecision(item) ? CircleAlert : Clock} size={14} />{" "}
                    {translateRef(
                      language,
                      item.decisionReasonKey,
                      item.decisionReason ?? t(language, "home.decisionFallback"),
                      item.decisionReasonParams,
                    )}
                  </span>
                  <span className="muted xs" style={{ flexShrink: 0 }}>
                    {relativeTime(item.updatedAt, language)}
                  </span>
                </div>
                <button className="btn xs" type="button" onClick={() => void openRequirement(item.id)}>
                  {t(language, "home.goto")} <Icon icon={ArrowRight} size={14} />
                </button>
              </div>
            ))}
          </section>
        )}

        {activeSandboxes.length > 0 && mergeOrder && mergeOrder.ordered.length > 0 && !query.trim() && (
          <section
            className="callout"
            data-testid="worktree-merge-order-panel"
            style={{ marginBottom: 14 }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Icon icon={GitBranch} size={14} />
                <strong style={{ fontSize: 13.5 }}>
                  {t(language, "home.sandboxesTitle", { count: mergeOrder.ordered.length })}
                </strong>
              </div>
              <button
                className="btn ghost xs"
                type="button"
                data-testid="refresh-sandboxes-remote-btn"
                disabled={busy}
                onClick={async () => {
                  const fresh = await runBusy(() => api.getProjectSandboxes(true));
                  if (fresh) {
                    queryClient.setQueryData<ProjectSandboxesResponse>(
                      queryKeys.projectSandboxes(activeProjectId),
                      fresh,
                    );
                    await queryClient.invalidateQueries({ queryKey: ["requirement"] });
                  }
                }}
              >
                <Icon icon={RefreshCw} size={14} /> {t(language, "home.sandboxesRefresh")}
              </button>
            </div>
            <div className="xs muted" style={{ marginBottom: 8 }}>
              {t(language, "home.mergeOrderHint")}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {mergeOrder.ordered.map((entry, idx) => {
                const sbItem = activeSandboxes.find((s) => s.requirementId === entry.requirementId);
                const canAutoSync = Boolean(sbItem?.drift?.canAutoSync);
                const reasonKey = `home.orderReason.${entry.reason}` as const;
                const reasonTone =
                  entry.reason === "main_conflict"
                    ? "danger"
                    : entry.reason === "sibling_conflict"
                      ? "warning"
                      : entry.reason === "auto_mergeable"
                        ? "info"
                        : "success";
                return (
                  <div
                    key={entry.requirementId}
                    data-testid={`merge-order-row-${entry.requirementId}`}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 8,
                      flexWrap: "wrap",
                      padding: "6px 8px",
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      background: "var(--surface)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flexWrap: "wrap" }}>
                      <span className="badge neutral">#{idx + 1}</span>
                      <span className="req-id">{entry.requirementId}</span>
                      <span style={{ fontWeight: 500, fontSize: 13 }}>{entry.title}</span>
                      <code className="xs muted">{entry.branch}</code>
                      <span className={`badge ${STAGE_META[entry.stage].tone}`}>
                        <Icon icon={STAGE_ICONS[entry.stage]} size={14} />
                        {STAGE_META[entry.stage].labels[language]}
                      </span>
                      <span className={`badge ${reasonTone}`}>{t(language, reasonKey)}</span>
                      {entry.behindCount > 0 && (
                        <span className={`badge ${entry.conflictFiles.length > 0 ? "danger" : "warning"}`}>
                          -{entry.behindCount}
                        </span>
                      )}
                      {entry.conflictsWithSiblings.length > 0 && (
                        <span className="xs muted">
                          ↔ {entry.conflictsWithSiblings.join(", ")}
                        </span>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      {canAutoSync && (
                        <button
                          className="btn xs"
                          type="button"
                          disabled={busy}
                          onClick={() => void syncSandboxBaseAction(entry.requirementId)}
                        >
                          <Icon icon={RefreshCw} size={14} /> {t(language, "ws.sandboxDrift.sync")}
                        </button>
                      )}
                      <button
                        className="btn xs"
                        type="button"
                        onClick={() => void openRequirement(entry.requirementId)}
                      >
                        {t(language, "home.goto")} <Icon icon={ArrowRight} size={14} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <div id="home-body">
          {rawItems.length === 0 ? (
            <div className="empty-card" data-testid="empty-state" style={{ textAlign: "center" }}>
              <p style={{ margin: "0 0 8px", fontWeight: 500 }}>{t(language, "home.emptyTitle")}</p>
              <p className="muted" style={{ margin: "0 0 14px", fontSize: 13 }}>
                {t(language, "home.emptyDesc")}
              </p>
              <button
                className="btn primary"
                type="button"
                data-action="open-new-req"
                data-testid="empty-new-req-btn"
                onClick={() => setModal({ kind: "new_req", goal: "" })}
              >
                <Icon icon={Plus} size={14} /> {t(language, "home.emptyNew")}
              </button>
            </div>
          ) : visible.length === 0 ? (
            <div className="empty-card" data-testid="empty-state" style={{ textAlign: "center" }}>
              <p className="muted" style={{ margin: "0 0 12px" }}>
                {t(language, "home.noMatch", { query })}
              </p>
              <button
                className="btn"
                type="button"
                data-action="clear-search"
                onClick={() => setQuery("")}
              >
                <Icon icon={X} size={14} /> {t(language, "home.clearSearch")}
              </button>
            </div>
          ) : layout === "list" ? (
            <div className="req-list" data-testid="req-list">
              {visible.map((item) => {
                const meta = STAGE_META[item.stage];
                const detail = progressDetail(item, language);
                const activeReqRun = findActiveRequirementRun(activeRunList, item.id, activeProjectId);
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
                        <span className={`badge ${meta.tone}`}>
                          <Icon icon={STAGE_ICONS[item.stage]} size={14} /> {meta.labels[language]}
                        </span>
                        {item.github?.issue && (
                          <span className="badge neutral">
                            <Icon icon={Link2} size={14} /> Issue #{item.github.issue.number}
                          </span>
                        )}
                        {item.github?.pr && (
                          <span className={`badge ${item.github.pr.state === "merged" ? "success" : "info"}`}>
                            <Icon icon={GitPullRequest} size={14} /> PR #{item.github.pr.number}
                          </span>
                        )}
                        {activeReqRun && (
                          <span className="badge info">
                            <span className="pulse-dot" />{" "}
                            {t(language, "home.running", {
                              harness: activeReqRun.harness,
                              model: activeReqRun.model,
                            })}
                          </span>
                        )}
                        {detail && <span>{detail}</span>}
                      </div>
                    </div>
                    <span className="req-time">{relativeTime(item.updatedAt, language)}</span>
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