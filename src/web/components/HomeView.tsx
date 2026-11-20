import { useLayoutEffect, useRef, useState } from "react";
import {
  Check,
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
  orderUnifiedRequirements,
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
  const activeRunList = Object.values(activeRuns);

  const { items: listSource, pendingDecisions, pendingIdSet } = orderUnifiedRequirements({
    allItems: allBaseItems,
    scope,
    runs: activeRunList,
    projectId: activeProjectId,
    mergeOrder,
    activeSandboxes,
  });

  const activeCnt = activeBaseItems.length;
  const decisionCnt = pendingDecisions.length;
  const doneCnt = filterRequirementsByScope(allBaseItems, "done").length;

  const mergeEntryMap = new Map<string, { entry: NonNullable<typeof mergeOrder>["ordered"][number]; rank: number }>();
  (mergeOrder?.ordered ?? []).forEach((entry, idx) => {
    mergeEntryMap.set(entry.requirementId, { entry, rank: idx + 1 });
  });
  const sandboxMap = new Map(activeSandboxes.map((s) => [s.requirementId, s]));
  const hasSandboxConflict = (mergeOrder?.ordered ?? []).some(
    (entry) => entry.reason === "main_conflict" || entry.reason === "sibling_conflict",
  );

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
          <button
            type="button"
            className={`stat-pill ${scope === "active" ? "active" : ""}`}
            onClick={() => setScope("active")}
          >
            <span className="muted xs">{t(language, "home.active")}</span>
            <strong>{activeCnt}</strong>
          </button>
          <button
            type="button"
            className={`stat-pill ${decisionCnt > 0 ? "warn" : ""} ${scope === "decisions" ? "active" : ""}`}
            onClick={() => setScope("decisions")}
          >
            <span className="muted xs">{t(language, "home.decisions")}</span>
            <strong>{decisionCnt}</strong>
          </button>
          <button
            type="button"
            className={`stat-pill ${scope === "done" ? "active" : ""}`}
            onClick={() => setScope("done")}
          >
            <span className="muted xs">{t(language, "home.done")}</span>
            <strong>{doneCnt}</strong>
          </button>
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

        {activeSandboxes.length > 0 && mergeOrder && mergeOrder.ordered.length > 0 && (
          <div className="sb-sandbox-toolbar" data-testid="sandbox-toolbar">
            <button
              type="button"
              className={`btn xs sb-sandbox-filter-btn ${scope === "sandboxes" ? "primary" : ""}`}
              data-testid="scope-sandboxes-btn"
              aria-pressed={scope === "sandboxes"}
              title={t(language, "home.mergeOrderHint")}
              onClick={() => setScope(scope === "sandboxes" ? "active" : "sandboxes")}
            >
              <Icon icon={GitBranch} size={14} />
              <span>{t(language, "home.scope.sandboxes", { count: mergeOrder.ordered.length })}</span>
              {hasSandboxConflict && <span className="sb-sandbox-alert-dot" aria-hidden="true" />}
            </button>
            <button
              className="btn ghost xs"
              type="button"
              data-testid="refresh-sandboxes-remote-btn"
              disabled={busy}
              title={t(language, "home.sandboxesRefresh")}
              aria-label={t(language, "home.sandboxesRefresh")}
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
        )}
      </div>

      <div
        id="home-content"
        ref={scrollRef}
        className="sb-req-scroll"
        onScroll={(e) => {
          scrollTopRef.current = e.currentTarget.scrollTop;
        }}
      >
        <div id="home-body">
          {listSource.length === 0 ? (
            <div className="empty-card sb-empty-box" data-testid="sb-empty-state" style={{ textAlign: "center", margin: 0, padding: 14 }}>
              <p className="muted xs" style={{ margin: "0 0 10px" }}>
                {allBaseItems.length === 0
                  ? t(language, "home.emptyTitle")
                  : scope === "decisions"
                    ? t(language, "home.emptyDecisions")
                    : scope === "sandboxes"
                      ? t(language, "home.emptySandboxes")
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
                const isPendingDecision = pendingIdSet.has(item.id);
                const isBlockingDecision = isPendingDecision && isBlockingDecisionRequirement(item);
                const mergeInfo = mergeEntryMap.get(item.id);
                const sbItem = sandboxMap.get(item.id);
                const canAutoSync = Boolean(sbItem?.drift?.canAutoSync);
                const reasonKey = mergeInfo ? (`home.orderReason.${mergeInfo.entry.reason}` as const) : null;
                const reasonTone = mergeInfo
                  ? mergeInfo.entry.reason === "main_conflict"
                    ? "danger"
                    : mergeInfo.entry.reason === "sibling_conflict"
                      ? "warning"
                      : mergeInfo.entry.reason === "auto_mergeable"
                        ? "info"
                        : "success"
                  : null;
                return (
                  <div
                    key={item.id}
                    className={`req-row ${isSelected ? "active" : ""} ${isBlockingDecision ? "is-blocking" : isPendingDecision ? "is-decision" : ""}`}
                    data-action="open-req"
                    data-id={item.id}
                    data-testid={`req-row-${item.id}`}
                    data-pending-decision={isPendingDecision ? "true" : undefined}
                    data-merge-rank={mergeInfo ? String(mergeInfo.rank) : undefined}
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
                        <div className="sb-req-item-id-group">
                          <span className="req-id">{item.id}</span>
                          {isPendingDecision && (
                            <span
                              className={`badge ${isBlockingDecision ? "danger" : "warning"}`}
                              data-testid={`req-decision-badge-${item.id}`}
                            >
                              <Icon icon={isBlockingDecision ? CircleAlert : Clock} size={14} />{" "}
                              {translateRef(
                                language,
                                item.decisionReasonKey,
                                item.decisionReason ?? t(language, "home.decisionFallback"),
                                item.decisionReasonParams,
                              )}
                            </span>
                          )}
                        </div>
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
                      {mergeInfo && reasonKey && reasonTone && (
                        <div className="req-sandbox-strip" data-testid={`req-sandbox-strip-${item.id}`}>
                          <div className="req-sandbox-badges">
                            <span className="badge neutral" data-testid={`merge-order-rank-${item.id}`}>
                              #{mergeInfo.rank}
                            </span>
                            <span className={`badge ${reasonTone}`}>{t(language, reasonKey)}</span>
                            {mergeInfo.entry.behindCount > 0 && (
                              <span className={`badge ${mergeInfo.entry.conflictFiles.length > 0 ? "danger" : "warning"}`}>
                                -{mergeInfo.entry.behindCount}
                              </span>
                            )}
                          </div>
                          {canAutoSync && (
                            <button
                              className="btn xs"
                              type="button"
                              data-testid={`req-sync-sandbox-btn-${item.id}`}
                              disabled={busy}
                              onClick={(e) => {
                                e.stopPropagation();
                                void syncSandboxBaseAction(item.id);
                              }}
                            >
                              <Icon icon={RefreshCw} size={14} /> {t(language, "ws.sandboxDrift.sync")}
                            </button>
                          )}
                        </div>
                      )}
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
