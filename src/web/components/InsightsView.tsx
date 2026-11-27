import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  CheckCircle2,
  Clock,
  Cpu,
  Download,
  RotateCcw,
  Settings,
  Wrench,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { AgentAction, RunBillingMode } from "../../core/types.ts";

const INSIGHT_ACTIONS: readonly AgentAction[] = ["ask", "design", "implement", "fix", "review"];
import { api, type InsightsQueryFilter } from "../api.ts";
import { formatAgentActionLabel, t, type MessageKey } from "../i18n.ts";
import {
  invalidateAllWorkbenchQueries,
  jumpToRequirementFromInsights,
  runBusy,
  useHubInsightsQuery,
} from "../queries.ts";
import { formatDurationHuman, formatPercent, formatTokenCount, formatUsd } from "../state.ts";
import { useUiStore } from "../stores/uiStore.ts";
import { ActivityHeatmap, DonutRingChart, StackedBarChart, type DonutSegment, type StackedBarDatum } from "./Charts.tsx";
import { Icon } from "./Icon.tsx";
import { Alert, AlertDescription } from "./ui/alert.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Card } from "./ui/card.tsx";
import { RadioGroupPrimitive, RadioPrimitive } from "./ui/radio-group.tsx";
import { SegmentedControl, SegmentedControlItem } from "./ui/segmented-control.tsx";
import { SimpleSelect } from "./ui/select.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table.tsx";

type DailyMetricMode = "tokens" | "cost" | "runs";
type ModelSortKey =
  | "runs"
  | "successRate"
  | "avgDurationMs"
  | "avgTokens"
  | "cacheHitRate"
  | "totalEquivalentCostUsd";

const POOL_COLORS = [
  "var(--accent)",
  "var(--success)",
  "#8b5cf6",
  "var(--warning)",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
];

const ACTION_COLORS: Record<AgentAction, string> = {
  design: "#8b5cf6",
  implement: "var(--accent)",
  fix: "var(--warning)",
  review: "var(--success)",
  ask: "#06b6d4",
};

export function InsightsView() {
  const language = useUiStore((s) => s.language);
  const busy = useUiStore((s) => s.busy);
  const setMainView = useUiStore((s) => s.setMainView);
  const setModal = useUiStore((s) => s.setModal);
  const showToastKey = useUiStore((s) => s.showToastKey);

  const [days, setDays] = useState<number>(7);
  const [projectId, setProjectId] = useState<string>("");
  const [quotaPool, setQuotaPool] = useState<string>("");
  const [harness, setHarness] = useState<string>("");
  const [action, setAction] = useState<AgentAction | "">("");
  const [billingMode, setBillingMode] = useState<RunBillingMode | "">("");
  const [metricMode, setMetricMode] = useState<DailyMetricMode>("tokens");
  const [sortBy, setSortBy] = useState<ModelSortKey>("runs");
  const [sortAsc, setSortAsc] = useState<boolean>(false);

  const filter: InsightsQueryFilter = useMemo(
    () => ({
      days,
      ...(projectId ? { projectId } : {}),
      ...(quotaPool ? { quotaPool } : {}),
      ...(harness ? { harness } : {}),
      ...(action ? { action } : {}),
      ...(billingMode ? { billingMode } : {}),
    }),
    [days, projectId, quotaPool, harness, action, billingMode],
  );

  const { data: insights, isLoading } = useHubInsightsQuery(filter, true);

  const stackedData: StackedBarDatum[] = useMemo(() => {
    return insights?.dailySeries.map((day) => {
      const label = day.date.slice(5);
      if (metricMode === "runs") {
        return {
          key: day.date,
          label,
          tooltip: `${day.date}: ${day.runs} runs`,
          segments: INSIGHT_ACTIONS.map((act) => ({
            key: act,
            label: formatAgentActionLabel(language, act),
            value: day.byAction[act]?.runs ?? 0,
            color: ACTION_COLORS[act],
          })),
        };
      }
      if (metricMode === "cost") {
        const subOnly = Math.max(0, day.equivalentCostUsd - day.apiCostUsd);
        return {
          key: day.date,
          label,
          tooltip: `${day.date}: API ${formatUsd(day.apiCostUsd)} · ${t(language, "audit.equivShort")} ${formatUsd(day.equivalentCostUsd)}`,
          segments: [
            { key: "api", label: t(language, "insights.billing.api"), value: day.apiCostUsd, color: "var(--danger)" },
            { key: "sub", label: t(language, "insights.billing.subscription"), value: subOnly, color: "var(--accent)" },
          ],
        };
      }
      return {
        key: day.date,
        label,
        tooltip: `${day.date}: ${formatTokenCount(day.tokens)} tokens`,
        segments: INSIGHT_ACTIONS.map((act) => ({
          key: act,
          label: formatAgentActionLabel(language, act),
          value: day.byAction[act]?.tokens ?? 0,
          color: ACTION_COLORS[act],
        })),
      };
    }) ?? [];
  }, [insights?.dailySeries, metricMode, language]);

  const quotaPoolSegments = useMemo<DonutSegment[]>(
    () => insights?.byQuotaPool.map((p, idx) => ({
      key: p.quotaPool,
      label: `${p.label} (${t(language, `insights.billing.${p.billingMode}` as MessageKey)})`,
      value: p.equivalentCostUsd > 0 ? p.equivalentCostUsd : Math.max(1, p.tokens),
      color: POOL_COLORS[idx % POOL_COLORS.length]!,
      hint: `${p.runs} runs · ${formatTokenCount(p.tokens)} · ${formatUsd(p.equivalentCostUsd)}`,
    })) ?? [],
    [insights?.byQuotaPool, language],
  );

  const actionSegments = useMemo<DonutSegment[]>(
    () => insights?.byAction.map((a) => ({
      key: a.action,
      label: formatAgentActionLabel(language, a.action),
      value: a.runs,
      color: ACTION_COLORS[a.action] ?? "var(--accent)",
      hint: `${a.runs} runs · ${formatTokenCount(a.tokens)} · ${formatUsd(a.equivalentCostUsd)}`,
    })) ?? [],
    [insights?.byAction, language],
  );

  const sortedModels = useMemo(() => {
    const list = [...(insights?.byModel ?? [])];
    list.sort((a, b) => {
      const valFor = (item: typeof a): number => {
        if (sortBy === "successRate") return item.runs > 0 ? item.succeededRuns / item.runs : 0;
        return Number(item[sortBy] ?? 0);
      };
      const diff = valFor(a) - valFor(b);
      return sortAsc ? diff : -diff;
    });
    return list;
  }, [insights?.byModel, sortBy, sortAsc]);

  const handleSort = (key: ModelSortKey) => {
    if (sortBy === key) {
      setSortAsc((v) => !v);
    } else {
      setSortBy(key);
      setSortAsc(false);
    }
  };

  const handleExportJson = () => {
    if (!insights || typeof document === "undefined") return;
    const blob = new Blob([JSON.stringify(insights, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `workbench-insights-${days}d.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const kpi = insights?.kpi;

  return (
    <div className="insights-page" data-testid="insights-view">
      <div className="insights-header">
        <div>
          <h1 className="insights-title">
            <Icon icon={BarChart3} size={20} /> {t(language, "insights.title")}
          </h1>
          <p className="muted xs" style={{ margin: "2px 0 0" }}>
            {t(language, "insights.subtitle")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-testid="insights-pricing-btn"
            onClick={() => setModal({ kind: "observability_pricing" })}
          >
            <Icon icon={Settings} size={14} /> {t(language, "insights.configPricing")}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-testid="insights-export-btn"
            disabled={!insights}
            onClick={handleExportJson}
          >
            <Icon icon={Download} size={14} /> {t(language, "insights.exportJson")}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            data-testid="insights-back-btn"
            onClick={() => setMainView("workspace")}
          >
            <Icon icon={ArrowLeft} size={14} /> {t(language, "insights.backWorkspace")}
          </Button>
        </div>
      </div>

      <Card className="insights-filter-bar flex-row flex-wrap items-center gap-2 p-2.5" data-testid="insights-filter-bar">
        <SegmentedControl
          size="sm"
          render={
            <RadioGroupPrimitive
              className="flex items-center"
              value={String(days)}
              onValueChange={(next) => next && setDays(Number(next))}
            />
          }
        >
          {([7, 30, 0] as const).map((dOpt) => (
            <SegmentedControlItem
              key={dOpt}
              render={<RadioPrimitive.Root value={String(dOpt)} data-testid={`insights-days-${dOpt}`} />}
            >
              {t(language, `insights.days.${dOpt}` as MessageKey)}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>

        <SimpleSelect
          aria-label={t(language, "insights.filterProject")}
          className="w-auto min-w-[130px] text-xs"
          options={[
            { value: "", label: t(language, "insights.allProjects") },
            ...(insights?.facets.projects ?? []).map((p) => ({ value: p.id, label: p.name })),
          ]}
          size="sm"
          value={projectId}
          onValueChange={setProjectId}
        />

        <SimpleSelect
          aria-label={t(language, "insights.filterAction")}
          className="w-auto min-w-[130px] text-xs"
          options={[
            { value: "", label: t(language, "insights.allActions") },
            ...INSIGHT_ACTIONS.map((a) => ({ value: a, label: formatAgentActionLabel(language, a) })),
          ]}
          size="sm"
          value={action}
          onValueChange={(next) => setAction(next as AgentAction | "")}
        />

        <SimpleSelect
          aria-label={t(language, "insights.filterQuotaPool")}
          className="w-auto min-w-[130px] text-xs"
          data-testid="insights-pool-filter"
          options={[
            { value: "", label: t(language, "insights.allPools") },
            ...(insights?.facets.quotaPools ?? []).map((q) => ({ value: q.id, label: q.label })),
          ]}
          size="sm"
          value={quotaPool}
          onValueChange={setQuotaPool}
        />

        <SimpleSelect
          aria-label={t(language, "insights.filterBilling")}
          className="w-auto min-w-[120px] text-xs"
          options={[
            { value: "", label: t(language, "insights.allBilling") },
            { value: "subscription", label: t(language, "insights.billing.subscription") },
            { value: "api", label: t(language, "insights.billing.api") },
            { value: "free", label: t(language, "insights.billing.free") },
          ]}
          size="sm"
          value={billingMode}
          onValueChange={(next) => setBillingMode(next as RunBillingMode | "")}
        />

        <SimpleSelect
          aria-label={t(language, "insights.filterHarness")}
          className="w-auto min-w-[120px] text-xs"
          options={[
            { value: "", label: t(language, "insights.allHarnesses") },
            ...(insights?.facets.harnesses ?? []).map((h) => ({ value: h, label: h })),
          ]}
          size="sm"
          value={harness}
          onValueChange={setHarness}
        />

        {(projectId || quotaPool || harness || action || billingMode) && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => {
              setProjectId("");
              setQuotaPool("");
              setHarness("");
              setAction("");
              setBillingMode("");
            }}
          >
            {t(language, "insights.resetFilters")}
          </Button>
        )}
      </Card>

      {isLoading && !insights ? (
        <div className="muted">{t(language, "common.loading")}</div>
      ) : kpi && kpi.totalRuns === 0 ? (
        <Card className="p-4">
          <div className="muted">{t(language, "insights.empty")}</div>
        </Card>
      ) : kpi ? (
        <>
          <div className="insights-kpi-grid" data-testid="insights-kpi-grid">
            <Card className="insights-kpi-card p-3">
              <div className="muted xs"><Icon icon={Activity} size={14} /> {t(language, "insights.kpi.runs")}</div>
              <div className="insights-kpi-val">{kpi.totalRuns}</div>
              <div className="muted xs">
                {t(language, "insights.kpi.successRate")}: <strong>{formatPercent(kpi.successRate)}</strong> ({kpi.succeededRuns}/{kpi.failedRuns} err)
              </div>
            </Card>
            <Card className="insights-kpi-card p-3">
              <div className="muted xs"><Icon icon={Cpu} size={14} /> {t(language, "insights.kpi.tokens")}</div>
              <div className="insights-kpi-val">{formatTokenCount(kpi.totalTokens)}</div>
              <div className="muted xs">
                {t(language, "audit.cacheHitRate")}: <strong>{formatPercent(kpi.cacheHitRate)}</strong> ({formatTokenCount(kpi.cacheReadTokens)})
              </div>
            </Card>
            <Card className="insights-kpi-card p-3">
              <div className="muted xs">{t(language, "audit.dualCost")}</div>
              <div className="insights-kpi-val">{formatUsd(kpi.apiCostUsd)}</div>
              <div className="muted xs">
                {t(language, "audit.equivShort")}: <strong>{formatUsd(kpi.equivalentCostUsd)}</strong>
              </div>
            </Card>
            <Card className="insights-kpi-card p-3">
              <div className="muted xs"><Icon icon={Clock} size={14} /> {t(language, "insights.kpi.duration")}</div>
              <div className="insights-kpi-val">{formatDurationHuman(kpi.avgDurationMs)}</div>
              <div className="muted xs">
                P50 {formatDurationHuman(kpi.p50DurationMs)} · P95 {formatDurationHuman(kpi.p95DurationMs)}
              </div>
            </Card>
            <Card className="insights-kpi-card p-3">
              <div className="muted xs"><Icon icon={Wrench} size={14} /> {t(language, "insights.kpi.tools")}</div>
              <div className="insights-kpi-val">{kpi.totalToolCalls}</div>
              <div className="muted xs">
                {t(language, "insights.kpi.toolErrors")}: <strong>{kpi.totalToolErrors}</strong>
              </div>
            </Card>
            <Card className="insights-kpi-card p-3">
              <div className="muted xs">{t(language, "insights.kpi.reliability")}</div>
              <div className="insights-kpi-val">{kpi.totalCompactions}</div>
              <div className="muted xs">
                429 {kpi.rateLimitedRuns} · timeout {kpi.timedOutRuns} · fallback {kpi.degradedRuns}
              </div>
            </Card>
          </div>

          <div className="insights-charts-grid">
            <Card className="p-4">
              <div className="card-head">
                <h3>{t(language, "insights.dailyTrend")}</h3>
                <SegmentedControl
                  size="sm"
                  render={
                    <RadioGroupPrimitive
                      className="flex items-center"
                      value={metricMode}
                      onValueChange={(next) => next && setMetricMode(next as DailyMetricMode)}
                    />
                  }
                >
                  {(["tokens", "cost", "runs"] as const).map((m) => (
                    <SegmentedControlItem
                      key={m}
                      render={<RadioPrimitive.Root value={m} />}
                    >
                      {t(language, `insights.metric.${m}` as MessageKey)}
                    </SegmentedControlItem>
                  ))}
                </SegmentedControl>
              </div>
              <StackedBarChart
                data={stackedData}
                formatValue={metricMode === "cost" ? formatUsd : metricMode === "tokens" ? formatTokenCount : undefined}
              />
            </Card>

            <Card className="p-4">
              <div className="card-head">
                <h3>{t(language, "insights.heatmap84d")}</h3>
              </div>
              <ActivityHeatmap
                days={insights.heatmap}
                formatTooltip={(d) => `${d.date}: ${d.runs} runs · ${formatTokenCount(d.tokens)} tok · ${formatUsd(d.equivalentCostUsd)}`}
              />
            </Card>
          </div>

          <div className="insights-charts-grid">
            <Card className="p-4" data-testid="insights-quota-pools-card">
              <div className="card-head">
                <h3>{t(language, "insights.byQuotaPool")}</h3>
              </div>
              <DonutRingChart
                centerValue={formatUsd(kpi.equivalentCostUsd)}
                centerLabel={t(language, "audit.equivShort")}
                segments={quotaPoolSegments}
              />
              <div className="audit-section-table" style={{ marginTop: 10 }}>
                {insights.byQuotaPool.map((p) => (
                  <div key={p.quotaPool} className="audit-section-row xs" data-testid={`pool-row-${p.quotaPool}`}>
                    <span>
                      <strong>{p.label}</strong>{" "}
                      <Badge size="sm" variant={p.billingMode === "api" ? "warning" : p.billingMode === "free" ? "success" : "info"}>
                        {t(language, `insights.billing.${p.billingMode}` as MessageKey)}
                      </Badge>
                    </span>
                    <span className="muted">
                      {p.runs} runs · {formatTokenCount(p.tokens)} · cache {formatPercent(p.cacheHitRate)} · API {formatUsd(p.apiCostUsd)} / eq{" "}
                      {formatUsd(p.equivalentCostUsd)}
                    </span>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="p-4">
              <div className="card-head">
                <h3>{t(language, "insights.byStage")}</h3>
              </div>
              <DonutRingChart
                centerValue={String(kpi.totalRuns)}
                centerLabel="runs"
                segments={actionSegments}
              />
            </Card>
          </div>

          {insights.diagnostics.length > 0 && (
            <Card className="p-4" data-testid="insights-diagnostics-card">
              <div className="card-head">
                <h3>{t(language, "insights.diagnosticsTitle")}</h3>
              </div>
              <div className="flex flex-col gap-2">
                {insights.diagnostics.map((diag) => (
                  <Alert
                    key={diag.id}
                    variant={diag.severity === "info" ? "info" : diag.severity === "warning" ? "warning" : "error"}
                    className="text-xs"
                  >
                    <Icon icon={diag.severity === "info" ? CheckCircle2 : AlertTriangle} size={14} />
                    <AlertDescription className="flex w-full flex-wrap items-center justify-between gap-2 text-foreground">
                      <div>
                        <strong>{t(language, diag.titleKey as MessageKey, diag.params)}</strong>
                        <div className="mt-0.5 text-muted-foreground">
                          {t(language, diag.detailKey as MessageKey, diag.params)}
                        </div>
                      </div>
                      {diag.requirementId && (
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          onClick={() => void jumpToRequirementFromInsights(diag.projectId, diag.requirementId!)}
                        >
                          {diag.requirementId} →
                        </Button>
                      )}
                    </AlertDescription>
                  </Alert>
                ))}
              </div>
            </Card>
          )}

          <Card className="p-4" data-testid="insights-model-table-card">
            <div className="card-head">
              <h3>{t(language, "insights.modelEfficiencyTitle")}</h3>
            </div>
            <Table className="text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead>Harness / Model</TableHead>
                  <TableHead>{t(language, "insights.col.stage")}</TableHead>
                  <TableHead>{t(language, "insights.col.pool")}</TableHead>
                  <TableHead>
                    <button type="button" className="table-sort-btn" onClick={() => handleSort("runs")}>
                      Runs
                    </button>
                  </TableHead>
                  <TableHead>
                    <button type="button" className="table-sort-btn" onClick={() => handleSort("successRate")}>
                      {t(language, "insights.kpi.successRate")}
                    </button>
                  </TableHead>
                  <TableHead>
                    <button type="button" className="table-sort-btn" onClick={() => handleSort("avgDurationMs")}>
                      {t(language, "insights.kpi.duration")}
                    </button>
                  </TableHead>
                  <TableHead>
                    <button type="button" className="table-sort-btn" onClick={() => handleSort("avgTokens")}>
                      Avg Tok
                    </button>
                  </TableHead>
                  <TableHead>
                    <button type="button" className="table-sort-btn" onClick={() => handleSort("cacheHitRate")}>
                      Cache
                    </button>
                  </TableHead>
                  <TableHead>
                    <button type="button" className="table-sort-btn" onClick={() => handleSort("totalEquivalentCostUsd")}>
                      Equiv USD
                    </button>
                  </TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedModels.map((m) => (
                  <TableRow key={`${m.harness}-${m.model}-${m.action}`}>
                    <TableCell>
                      <strong>{m.harness}</strong> / {m.model}
                    </TableCell>
                    <TableCell>{formatAgentActionLabel(language, m.action)}</TableCell>
                    <TableCell className="text-muted-foreground">{m.quotaPool}</TableCell>
                    <TableCell>{m.runs}</TableCell>
                    <TableCell>{formatPercent(m.runs > 0 ? m.succeededRuns / m.runs : 0)}</TableCell>
                    <TableCell>{formatDurationHuman(m.avgDurationMs)}</TableCell>
                    <TableCell>{formatTokenCount(m.avgTokens)}</TableCell>
                    <TableCell>{formatPercent(m.cacheHitRate)}</TableCell>
                    <TableCell>{formatUsd(m.totalEquivalentCostUsd)}</TableCell>
                    <TableCell>
                      {m.coolingUntil ? (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={busy}
                          onClick={async () => {
                            const ok = await runBusy(() => api.clearModelCooldown(m.harness, m.model));
                            if (ok) {
                              await invalidateAllWorkbenchQueries();
                              showToastKey("evo.clearedCooldowns");
                            }
                          }}
                        >
                          <Icon icon={RotateCcw} size={14} /> {t(language, "insights.clearCooldown")}
                        </Button>
                      ) : (
                        <Badge size="sm" variant="success">{t(language, "insights.healthy")}</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          {insights.topRequirements.length > 0 && (
            <Card className="p-4" data-testid="insights-top-reqs-card">
              <div className="card-head">
                <h3>{t(language, "insights.topRequirementsTitle")}</h3>
              </div>
              <div className="audit-section-table">
                {insights.topRequirements.map((r) => (
                  <div
                    key={`${r.projectId}-${r.requirementId}`}
                    className="audit-section-row"
                    style={{ alignItems: "center", gap: 8, flexWrap: "wrap" }}
                  >
                    <div>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        data-testid={`insights-jump-req-${r.requirementId}`}
                        onClick={() => void jumpToRequirementFromInsights(r.projectId, r.requirementId)}
                      >
                        <strong>{r.requirementId}</strong>
                      </Button>{" "}
                      <span className="xs">{r.requirementTitle}</span>{" "}
                      <span className="muted xs">({r.projectName})</span>
                    </div>
                    <div className="muted xs">
                      {r.runs} runs{r.fixRuns > 0 ? ` (${r.fixRuns} fix)` : ""} · {formatTokenCount(r.tokens)} tok · API{" "}
                      {formatUsd(r.apiCostUsd)} / eq {formatUsd(r.equivalentCostUsd)}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      ) : null}
    </div>
  );
}
