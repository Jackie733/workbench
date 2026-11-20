import { useLayoutEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock,
  FolderGit2,
  FolderPlus,
  GitBranch,
  GitPullRequest,
  Info,
  Link2,
  Plus,
  RefreshCw,
  Search,
  WifiOff,
  X,
} from "lucide-react";
import type { OutputLanguage } from "../../core/types.ts";
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
import {
  filteredItems,
  filterRequirementsByScope,
  findActiveRequirementRun,
  isBlockingDecisionRequirement,
  partitionPendingDecisions,
  progressDetail,
  relativeTime,
  STAGE_META,
} from "../state.ts";
import { useStreamStore } from "../stores/streamStore.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { Icon, STAGE_ICONS } from "./Icon.tsx";

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

export function EmptyRequirementsCard() {
  const language = useUiStore((s) => s.language);
  const setModal = useUiStore((s) => s.setModal);
  return (
    <div className="empty-card" data-testid="empty-state" style={{ textAlign: "center" }}>
      <p style={{ margin: "0 0 8px", fontWeight: 600, fontSize: 16 }}>{t(language, "home.emptyTitle")}</p>
      <p className="muted" style={{ margin: "0 0 16px", fontSize: 13 }}>
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

export function HomeView() {
  const language = useUiStore((s) => s.language);
  const activeProjectId = useUiStore((s) => s.activeProjectId);
  const selectedId = useUiStore((s) => s.selectedId);
  const scope = useUiStore((s) => s.scope);
  const query = useUiStore((s) => s.query);
  const setScope = useUiStore((s) => s.setScope);
  const setQuery = useUiStore((s) => s.setQuery);
  const setModal = useUiStore((s) => s.setModal);

  const busy = useUiStore((s) => s.busy);
  const activeRuns = useStreamStore((s) => s.activeRuns);
  const [sandboxesExpanded, setSandboxesExpanded] = useState<boolean | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollTopRef = useRef(0);
  const prevProjectRef = useRef(activeProjectId);

  const { data: project } = useProjectQuery(activeProjectId);
  const { data: allReqList } = useRequirementsQuery(activeProjectId, "all", Boolean(project?.initialized));
  const { data: sandboxesData } = useProjectSandboxesQuery(activeProjectId, Boolean(project?.initialized));

  const allBaseItems = allReqList?.items ?? [];
  const activeBaseItems = filterRequirementsByScope(allBaseItems, "active");
  const mergeOrder = sandboxesData?.mergeOrder ?? null;
  const activeSandboxes = sandboxesData?.sandboxes ?? [];
  const isSandboxesExpanded = sandboxesExpanded ?? (mergeOrder ? mergeOrder.ordered.length <= 4 : false);

  const activeRunList = Object.values(activeRuns);
  const pendingDecisions = partitionPendingDecisions(activeBaseItems, activeRunList, activeProjectId).humanPending.sort(
    (a, b) => {
      const aBlock = isBlockingDecisionRequirement(a) ? 0 : 1;
      const bBlock = isBlockingDecisionRequirement(b) ? 0 : 1;
      if (aBlock !== bBlock) return aBlock - bBlock;
      return a.updatedAt - b.updatedAt;
    },
  );

  const activeCnt = activeBaseItems.length;
  const decisionCnt = pendingDecisions.length;
  const doneCnt = filterRequirementsByScope(allBaseItems, "done").length;

  const listSource = scope === "decisions" ? pendingDecisions : filterRequirementsByScope(allBaseItems, scope);
  const visible = filteredItems(listSource, query, language);

  useLayoutEffect(() => {
    if (prevProjectRef.current !== activeProjectId) {
      prevProjectRef.current = activeProjectId;
      scrollTopRef.current = 0;
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
      return;
    }
    if (scrollRef.current && scrollTopRef.current > 0 && Math.abs(scrollRef.current.scrollTop - scrollTopRef.current) > 2) {
      scrollRef.current.scrollTop = scrollTopRef.current;
    }
  }, [activeProjectId, listSource.length, scope]);

  return (
    <div className="sb-req-panel" data-testid="home-view">
      <div className="sb-req-top">
        <div className="sb-head" style={{ padding: "0 2px" }}>
          <span>{t(language, "sidebar.requirementsTitle")}</span>
          <button
            className="btn primary xs"
            type="button"
            data-action="open-new-req"
            data-testid="new-req-btn"
            onClick={() => setModal({ kind: "new_req", goal: "" })}
          >
            <Icon icon={Plus} size={14} /> {t(language, "home.newRequirement")}
          </button>
        </div>

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

        <div className="segmented sb-scope-tabs" role="tablist" data-testid="scope-tabs">
          {(["active", "decisions", "done", "all"] as const).map((sc) => (
            <button
              key={sc}
              type="button"
              role="tab"
              aria-selected={scope === sc}
              className={scope === sc ? "active" : ""}
              data-action="set-scope"
              data-value={sc}
              onClick={() => setScope(sc)}
            >
              {sc === "active"
                ? t(language, "home.scope.active")
                : sc === "decisions"
                  ? `${t(language, "home.scope.decisions")}${decisionCnt > 0 ? ` (${decisionCnt})` : ""}`
                  : sc === "done"
                    ? t(language, "home.scope.done")
                    : t(language, "home.scope.all")}
            </button>
          ))}
        </div>
      </div>

      <div
        id="home-content"
        ref={scrollRef}
        className="sb-req-scroll"
        onScroll={(e) => {
          scrollTopRef.current = e.currentTarget.scrollTop;
        }}
      >
        {pendingDecisions.length > 0 && !query.trim() && scope !== "done" && scope !== "decisions" && (
          <section className="decision-box sb-decision-box" data-testid="decision-box">
            <h2>
              <Icon icon={AlertTriangle} size={14} />
              <span>{t(language, "home.decisionBox", { count: pendingDecisions.length })}</span>
            </h2>
            {pendingDecisions.map((item) => (
              <div
                key={item.id}
                className="decision-row"
                onClick={() => void openRequirement(item.id)}
                style={{ cursor: "pointer" }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                    <span className="req-id">{item.id}</span>
                    <span className={`badge ${isBlockingDecisionRequirement(item) ? "danger" : "warning"}`}>
                      <Icon icon={isBlockingDecisionRequirement(item) ? CircleAlert : Clock} size={14} />{" "}
                      {translateRef(
                        language,
                        item.decisionReasonKey,
                        item.decisionReason ?? t(language, "home.decisionFallback"),
                        item.decisionReasonParams,
                      )}
                    </span>
                  </div>
                  <span
                    style={{
                      fontWeight: 500,
                      fontSize: 12.5,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {item.title}
                  </span>
                </div>
                <button
                  className="btn xs"
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void openRequirement(item.id);
                  }}
                >
                  {t(language, "home.goto")} <Icon icon={ArrowRight} size={14} />
                </button>
              </div>
            ))}
          </section>
        )}

        {activeSandboxes.length > 0 && mergeOrder && mergeOrder.ordered.length > 0 && !query.trim() && (
          <section
            className="callout sb-sandbox-panel"
            data-testid="worktree-merge-order-panel"
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
              <button
                type="button"
                className="btn ghost xs"
                data-testid="toggle-sandbox-order-btn"
                aria-expanded={isSandboxesExpanded}
                style={{ padding: "2px 4px", minWidth: 0, flex: 1, justifyContent: "flex-start" }}
                onClick={() => setSandboxesExpanded(!isSandboxesExpanded)}
              >
                <Icon icon={isSandboxesExpanded ? ChevronDown : ChevronRight} size={14} />
                <Icon icon={GitBranch} size={14} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}>
                  {t(language, "home.sandboxesTitle", { count: mergeOrder.ordered.length })}
                </span>
              </button>
              <button
                className="btn ghost xs"
                type="button"
                data-testid="refresh-sandboxes-remote-btn"
                disabled={busy}
                title={t(language, "home.sandboxesRefresh")}
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
                <Icon icon={RefreshCw} size={14} />
              </button>
            </div>
            {isSandboxesExpanded && (
              <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 6 }}>
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
                        flexDirection: "column",
                        gap: 4,
                        padding: "5px 7px",
                        borderRadius: 6,
                        border: "1px solid var(--border)",
                        background: "var(--surface)",
                        cursor: "pointer",
                      }}
                      onClick={() => void openRequirement(entry.requirementId)}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                        <span className="badge neutral">#{idx + 1}</span>
                        <span className="req-id">{entry.requirementId}</span>
                        <span className={`badge ${reasonTone}`}>{t(language, reasonKey)}</span>
                        {entry.behindCount > 0 && (
                          <span className={`badge ${entry.conflictFiles.length > 0 ? "danger" : "warning"}`}>
                            -{entry.behindCount}
                          </span>
                        )}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                        <span className="xs" style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {entry.title}
                        </span>
                        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                          {canAutoSync && (
                            <button
                              className="btn xs"
                              type="button"
                              disabled={busy}
                              onClick={(e) => {
                                e.stopPropagation();
                                void syncSandboxBaseAction(entry.requirementId);
                              }}
                            >
                              <Icon icon={RefreshCw} size={14} /> {t(language, "ws.sandboxDrift.sync")}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        <div id="home-body">
          {listSource.length === 0 ? (
            <div className="empty-card sb-empty-box" data-testid="sb-empty-state" style={{ textAlign: "center", margin: 0, padding: 14 }}>
              <p className="muted xs" style={{ margin: "0 0 10px" }}>
                {allBaseItems.length === 0
                  ? t(language, "home.emptyTitle")
                  : scope === "decisions"
                    ? t(language, "home.emptyDecisions")
                    : scope === "done"
                      ? t(language, "home.emptyDone")
                      : t(language, "home.emptyActive")}
              </p>
              {allBaseItems.length === 0 ? (
                <button
                  className="btn primary xs"
                  type="button"
                  data-action="open-new-req"
                  onClick={() => setModal({ kind: "new_req", goal: "" })}
                >
                  <Icon icon={Plus} size={14} /> {t(language, "home.emptyNew")}
                </button>
              ) : (
                scope !== "all" && (
                  <button
                    className="btn xs"
                    type="button"
                    data-testid="empty-scope-all-btn"
                    onClick={() => setScope("all")}
                  >
                    {t(language, "home.viewAll")}
                  </button>
                )
              )}
            </div>
          ) : visible.length === 0 ? (
            <div className="empty-card sb-empty-box" data-testid="sb-empty-search" style={{ textAlign: "center", margin: 0, padding: 14 }}>
              <p className="muted xs" style={{ margin: "0 0 10px" }}>
                {t(language, "home.noMatch", { query })}
              </p>
              <button
                className="btn xs"
                type="button"
                data-action="clear-search"
                onClick={() => setQuery("")}
              >
                <Icon icon={X} size={14} /> {t(language, "home.clearSearch")}
              </button>
            </div>
          ) : (
            <div className="req-list" data-testid="req-list">
              {visible.map((item) => {
                const meta = STAGE_META[item.stage];
                const detail = progressDetail(item, language);
                const activeReqRun = findActiveRequirementRun(activeRunList, item.id, activeProjectId);
                const isSelected = selectedId === item.id;
                return (
                  <div
                    key={item.id}
                    className={`req-row ${isSelected ? "active" : ""}`}
                    data-action="open-req"
                    data-id={item.id}
                    data-testid={`req-row-${item.id}`}
                    aria-current={isSelected ? "true" : undefined}
                    tabIndex={0}
                    onClick={() => void openRequirement(item.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        void openRequirement(item.id);
                      }
                    }}
                  >
                    <div data-testid={`req-card-${item.id}`} className="sb-req-item-body">
                      <div className="sb-req-item-head">
                        <span className="req-id">{item.id}</span>
                        <span className="req-time">{relativeTime(item.updatedAt, language)}</span>
                      </div>
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
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
