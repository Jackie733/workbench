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
  type Scope,
  STAGE_META,
} from "../state.ts";
import { useStreamStore } from "../stores/streamStore.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { Icon, STAGE_ICONS } from "./Icon.tsx";
import { Alert, AlertDescription } from "./ui/alert.tsx";
import { AsyncButton } from "./ui/async-button.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Card, CardDescription, CardFooter, CardHeader, CardPanel, CardTitle } from "./ui/card.tsx";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty.tsx";
import { Input } from "./ui/input.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group.tsx";
import { Label } from "./ui/label.tsx";
import { Radio, RadioGroup, RadioGroupPrimitive, RadioPrimitive } from "./ui/radio-group.tsx";
import { SegmentedControl, SegmentedControlItem } from "./ui/segmented-control.tsx";
import { SimpleSelect } from "./ui/select.tsx";

export function RemoteNodeOfflineCard({ project }: { project: HubProjectSummary }) {
  const language = useUiStore((s) => s.language);
  const nodeLabel = project.nodeName ?? project.nodeId ?? "remote";
  return (
    <Card className="mx-auto my-6 max-w-2xl" data-testid="remote-node-offline-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon icon={WifiOff} size={20} />
          <span>{t(language, "remote.title", { node: nodeLabel })}</span>
        </CardTitle>
        <CardDescription>
          {t(language, "remote.descPrefix")}
          <strong>{project.name}</strong>
          {t(language, "remote.descMiddle")}
          <code>{project.root}</code>
          {t(language, "remote.descMid2")}
          <strong>{nodeLabel}</strong>
          {t(language, "remote.descSuffix")}
        </CardDescription>
      </CardHeader>
      <CardPanel>
        <Alert variant="info" className="text-xs">
          <Icon icon={Info} size={14} />
          <AlertDescription className="text-foreground">
            <div>
              {t(language, "remote.hintPrefix")}
              <strong>{nodeLabel}</strong>
              {t(language, "remote.hintMiddle")}
            </div>
            <pre className="mt-1.5 font-mono text-xs">wb node start</pre>
          </AlertDescription>
        </Alert>
      </CardPanel>
      <CardFooter>
        <Button
          type="button"
          data-testid="remote-node-refresh-btn"
          onClick={() => void invalidateAllWorkbenchQueries()}
        >
          <Icon icon={RefreshCw} size={14} /> {t(language, "remote.refresh")}
        </Button>
      </CardFooter>
    </Card>
  );
}

export function EmptyHubCard() {
  const language = useUiStore((s) => s.language);
  return (
    <Card className="mx-auto my-6 max-w-2xl" data-testid="empty-hub-card">
      <Empty className="py-10 md:py-12">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon icon={FolderPlus} size={20} />
          </EmptyMedia>
          <EmptyTitle>{t(language, "hub.emptyTitle")}</EmptyTitle>
          <EmptyDescription>{t(language, "hub.emptyDesc")}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            type="button"
            data-testid="empty-hub-add-btn"
            onClick={() => void openAddProjectModal()}
          >
            <Icon icon={Plus} size={16} /> {t(language, "hub.addLocal")}
          </Button>
        </EmptyContent>
      </Empty>
    </Card>
  );
}

export function EmptyRequirementsCard() {
  const language = useUiStore((s) => s.language);
  const setModal = useUiStore((s) => s.setModal);
  return (
    <Card className="mx-auto my-6 max-w-2xl" data-testid="empty-state">
      <Empty className="py-10 md:py-12">
        <EmptyHeader>
          <EmptyTitle>{t(language, "home.emptyTitle")}</EmptyTitle>
          <EmptyDescription>{t(language, "home.emptyDesc")}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            type="button"
            data-action="open-new-req"
            data-testid="empty-new-req-btn"
            onClick={() => setModal({ kind: "new_req", goal: "" })}
          >
            <Icon icon={Plus} size={14} /> {t(language, "home.emptyNew")}
          </Button>
        </EmptyContent>
      </Empty>
    </Card>
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
    <Card className="mx-auto my-6 max-w-2xl" data-testid="init-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon icon={FolderGit2} size={20} />
          <span>{t(language, "init.title")}</span>
        </CardTitle>
        <CardDescription>
          {t(language, "init.descPrefix")}
          <code>{rootLabel}</code>
          {t(language, "init.descMiddle")}
          <code>.workbench/</code>
          {t(language, "init.descSuffix")}
        </CardDescription>
      </CardHeader>
      <CardPanel className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground" htmlFor="init-name">
            {t(language, "init.nameLabel")}
          </Label>
          <Input
            id="init-name"
            value={initName}
            placeholder={t(language, "init.namePlaceholder")}
            onChange={(e) => setInitName(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground" htmlFor="init-output-language">
            {t(language, "init.outputLanguageLabel")}
          </Label>
          <SimpleSelect
            id="init-output-language"
            className="w-full"
            options={[
              { value: "inherit", label: t(language, "init.langInherit") },
              { value: "zh-CN", label: t(language, "init.langZh") },
              { value: "en", label: t(language, "init.langEn") },
              { value: "auto", label: t(language, "init.langAuto") },
            ]}
            value={initOutputLanguage}
            onValueChange={(next) => setInitOutputLanguage(next as OutputLanguage | "inherit")}
          />
        </div>
        <RadioGroup
          className="gap-2"
          value={initPrivacy}
          onValueChange={(next) => setInitPrivacy(next as "local" | "tracked")}
        >
          <Label className="flex w-full cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition-colors has-data-checked:border-primary/48 has-data-checked:bg-accent/50">
            <Radio className="mt-0.5" value="local" />
            <div className="flex flex-col gap-1">
              <strong className="text-sm font-medium">{t(language, "init.localTitle")}</strong>
              <span className="text-xs font-normal text-muted-foreground">
                {t(language, "init.localDescPrefix")}
                <code>.git/info/exclude</code>
                {t(language, "init.localDescSuffix")}
              </span>
            </div>
          </Label>
          <Label className="flex w-full cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition-colors has-data-checked:border-primary/48 has-data-checked:bg-accent/50">
            <Radio className="mt-0.5" value="tracked" />
            <div className="flex flex-col gap-1">
              <strong className="text-sm font-medium">{t(language, "init.trackedTitle")}</strong>
              <span className="text-xs font-normal text-muted-foreground">
                {t(language, "init.trackedDesc")}
              </span>
            </div>
          </Label>
        </RadioGroup>
      </CardPanel>
      <CardFooter>
        <Button
          type="button"
          data-action="submit-init"
          data-testid="init-submit-btn"
          disabled={busy}
          loading={busy}
          onClick={() => void initProjectSubmit()}
        >
          <Icon icon={Check} size={14} /> {t(language, "init.submit")}
        </Button>
      </CardFooter>
    </Card>
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
  const scopeCounts = {
    active: activeCnt,
    decisions: decisionCnt,
    done: doneCnt,
    all: allBaseItems.length,
  } as const;

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
          <Button
            size="xs"
            type="button"
            data-action="open-new-req"
            data-testid="new-req-btn"
            onClick={() => setModal({ kind: "new_req", goal: "" })}
          >
            <Icon icon={Plus} size={14} /> {t(language, "home.newRequirement")}
          </Button>
        </div>

        <InputGroup>
          <InputGroupAddon>
            <Icon icon={Search} size={14} />
          </InputGroupAddon>
          <InputGroupInput
            id="search-input"
            data-testid="search-input"
            size="sm"
            type="search"
            value={query}
            placeholder={t(language, "home.searchPlaceholder")}
            onChange={(e) => setQuery(e.target.value)}
          />
        </InputGroup>

        <SegmentedControl
          size="sm"
          className="sb-scope-tabs w-full"
          data-testid="scope-tabs"
          render={
            <RadioGroupPrimitive
              aria-label={t(language, "sidebar.requirementsTitle")}
              value={scope === "sandboxes" ? "" : scope}
              onValueChange={(next) => {
                if (next) setScope(next as Scope);
              }}
            />
          }
        >
          {(["active", "decisions", "done", "all"] as const).map((sc) => (
            <SegmentedControlItem
              key={sc}
              className="grow min-w-0 px-1.5 text-[11.5px]"
              render={
                <RadioPrimitive.Root
                  value={sc}
                  data-action="set-scope"
                  data-value={sc}
                />
              }
            >
              <span className="sb-scope-tab">
                <span className="truncate">
                  {sc === "active"
                    ? t(language, "home.scope.active")
                    : sc === "decisions"
                      ? t(language, "home.scope.decisions")
                      : sc === "done"
                        ? t(language, "home.scope.done")
                        : t(language, "home.scope.all")}
                </span>
                <span className="sb-scope-count" data-testid={`scope-count-${sc}`}>
                  {scopeCounts[sc]}
                </span>
                {sc === "decisions" && decisionCnt > 0 && (
                  <span className="sb-scope-alert-dot" data-testid="scope-decisions-alert" aria-hidden="true" />
                )}
              </span>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>

        {activeSandboxes.length > 0 && mergeOrder && mergeOrder.ordered.length > 0 && (
          <div className="sb-sandbox-toolbar" data-testid="sandbox-toolbar">
            <Button
              type="button"
              size="xs"
              variant={scope === "sandboxes" ? "default" : "outline"}
              className="sb-sandbox-filter-btn flex-1 shrink min-w-0 justify-start"
              data-testid="scope-sandboxes-btn"
              aria-pressed={scope === "sandboxes"}
              title={t(language, "home.mergeOrderHint")}
              onClick={() => setScope(scope === "sandboxes" ? "active" : "sandboxes")}
            >
              <Icon icon={GitBranch} size={14} />
              <span className="truncate">{t(language, "home.scope.sandboxes", { count: mergeOrder.ordered.length })}</span>
              {hasSandboxConflict && <span className="sb-sandbox-alert-dot" aria-hidden="true" />}
            </Button>
            <AsyncButton
              size="icon-xs"
              type="button"
              variant="ghost"
              data-testid="refresh-sandboxes-remote-btn"
              disabled={busy}
              title={t(language, "home.sandboxesRefresh")}
              aria-label={t(language, "home.sandboxesRefresh")}
              onAction={async () => {
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
            </AsyncButton>
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
            <Card className="sb-empty-box text-center p-3.5" data-testid="sb-empty-state">
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
                <Button
                  size="xs"
                  type="button"
                  data-action="open-new-req"
                  onClick={() => setModal({ kind: "new_req", goal: "" })}
                >
                  <Icon icon={Plus} size={14} /> {t(language, "home.emptyNew")}
                </Button>
              ) : (
                scope !== "all" && (
                  <Button
                    size="xs"
                    type="button"
                    variant="outline"
                    data-testid="empty-scope-all-btn"
                    onClick={() => setScope("all")}
                  >
                    {t(language, "home.viewAll")}
                  </Button>
                )
              )}
            </Card>
          ) : visible.length === 0 ? (
            <Card className="sb-empty-box text-center p-3.5" data-testid="sb-empty-search">
              <p className="muted xs" style={{ margin: "0 0 10px" }}>
                {t(language, "home.noMatch", { query })}
              </p>
              <Button
                size="xs"
                type="button"
                variant="outline"
                data-action="clear-search"
                onClick={() => setQuery("")}
              >
                <Icon icon={X} size={14} /> {t(language, "home.clearSearch")}
              </Button>
            </Card>
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
                    ? "error"
                    : mergeInfo.entry.reason === "sibling_conflict"
                      ? "warning"
                      : mergeInfo.entry.reason === "auto_mergeable"
                        ? "info"
                        : "success"
                  : null;
                const stageBadgeTone: "secondary" | "info" | "success" | "warning" | "error" =
                  meta.tone === "danger"
                    ? "error"
                    : meta.tone === "warning"
                      ? "warning"
                      : meta.tone === "success"
                        ? "success"
                        : meta.tone === "info"
                          ? "info"
                          : "secondary";
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
                            <Badge
                              variant={isBlockingDecision ? "error" : "warning"}
                              data-testid={`req-decision-badge-${item.id}`}
                            >
                              <Icon icon={isBlockingDecision ? CircleAlert : Clock} size={14} />{" "}
                              {translateRef(
                                language,
                                item.decisionReasonKey,
                                item.decisionReason ?? t(language, "home.decisionFallback"),
                                item.decisionReasonParams,
                              )}
                            </Badge>
                          )}
                        </div>
                        <span className="req-time">{relativeTime(item.updatedAt, language)}</span>
                      </div>
                      <div className="req-title">{item.title}</div>
                      <div className="req-sub">
                        <Badge variant={stageBadgeTone}>
                          <Icon icon={STAGE_ICONS[item.stage]} size={14} /> {meta.labels[language]}
                        </Badge>
                        {item.github?.issue && (
                          <Badge variant="secondary">
                            <Icon icon={Link2} size={14} /> Issue #{item.github.issue.number}
                          </Badge>
                        )}
                        {item.github?.pr && (
                          <Badge variant={item.github.pr.state === "merged" ? "success" : "info"}>
                            <Icon icon={GitPullRequest} size={14} /> PR #{item.github.pr.number}
                          </Badge>
                        )}
                        {activeReqRun && (
                          <Badge variant="info">
                            <span className="pulse-dot" />{" "}
                            {t(language, "home.running", {
                              harness: activeReqRun.harness,
                              model: activeReqRun.model,
                            })}
                          </Badge>
                        )}
                        {detail && <span>{detail}</span>}
                      </div>
                      {mergeInfo && reasonKey && reasonTone && (
                        <div className="req-sandbox-strip" data-testid={`req-sandbox-strip-${item.id}`}>
                          <div className="req-sandbox-badges">
                            <Badge variant="secondary" data-testid={`merge-order-rank-${item.id}`}>
                              #{mergeInfo.rank}
                            </Badge>
                            <Badge variant={reasonTone}>{t(language, reasonKey)}</Badge>
                            {mergeInfo.entry.behindCount > 0 && (
                              <Badge variant={mergeInfo.entry.conflictFiles.length > 0 ? "error" : "warning"}>
                                -{mergeInfo.entry.behindCount}
                              </Badge>
                            )}
                          </div>
                          {canAutoSync && (
                            <AsyncButton
                              size="xs"
                              type="button"
                              variant="outline"
                              data-testid={`req-sync-sandbox-btn-${item.id}`}
                              disabled={busy}
                              onAction={(event) => {
                                event.stopPropagation();
                                return syncSandboxBaseAction(item.id);
                              }}
                            >
                              <Icon icon={RefreshCw} size={14} /> {t(language, "ws.sandboxDrift.sync")}
                            </AsyncButton>
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
