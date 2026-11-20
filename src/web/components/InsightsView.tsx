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
import { ActivityHeatmap, DonutRingChart, StackedBarChart, type StackedBarDatum } from "./Charts.tsx";
import { Icon } from "./Icon.tsx";

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
    if (!insights) return [];
    return insights.dailySeries.map((day) => {
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
    });
  }, [insights, metricMode, language]);

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
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn xs"
            data-testid="insights-pricing-btn"
            onClick={() => setModal({ kind: "observability_pricing" })}
          >
            <Icon icon={Settings} size={14} /> {t(language, "insights.configPricing")}
          </button>
          <button
            type="button"
            className="btn xs"
            data-testid="insights-export-btn"
            disabled={!insights}
            onClick={handleExportJson}
          >
            <Icon icon={Download} size={14} /> {t(language, "insights.exportJson")}
          </button>
          <button
            type="button"
            className="btn ghost xs"
            data-testid="insights-back-btn"
            onClick={() => setMainView("workspace")}
          >
            <Icon icon={ArrowLeft} size={14} /> {t(language, "insights.backWorkspace")}
          </button>
        </div>
      </div>

      <div className="card insights-filter-bar" data-testid="insights-filter-bar">
        <div className="segmented">
          {([7, 30, 0] as const).map((dOpt) => (
            <button
              key={dOpt}
              type="button"
              className={days === dOpt ? "active" : ""}
              data-testid={`insights-days-${dOpt}`}
              onClick={() => setDays(dOpt)}
            >
              {t(language, `insights.days.${dOpt}` as MessageKey)}
            </button>
          ))}
        </div>

        <select
          className="select xs"
          aria-label={t(language, "insights.filterProject")}
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        >
          <option value="">{t(language, "insights.allProjects")}</option>
          {(insights?.facets.projects ?? []).map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>

        <select
          className="select xs"
          aria-label={t(language, "insights.filterAction")}
          value={action}
          onChange={(e) => setAction(e.target.value as AgentAction | "")}
        >
          <option value="">{t(language, "insights.allActions")}</option>
          {INSIGHT_ACTIONS.map((a) => (
            <option key={a} value={a}>{formatAgentActionLabel(language, a)}</option>
          ))}
        </select>

        <select
          className="select xs"
          aria-label={t(language, "insights.filterQuotaPool")}
          data-testid="insights-pool-filter"
          value={quotaPool}
          onChange={(e) => setQuotaPool(e.target.value)}
        >
          <option value="">{t(language, "insights.allPools")}</option>
          {(insights?.facets.quotaPools ?? []).map((q) => (
            <option key={q.id} value={q.id}>{q.label}</option>
          ))}
        </select>

        <select
          className="select xs"
          aria-label={t(language, "insights.filterBilling")}
          value={billingMode}
          onChange={(e) => setBillingMode(e.target.value as RunBillingMode | "")}
        >
          <option value="">{t(language, "insights.allBilling")}</option>
          <option value="subscription">{t(language, "insights.billing.subscription")}</option>
          <option value="api">{t(language, "insights.billing.api")}</option>
          <option value="free">{t(language, "insights.billing.free")}</option>
        </select>

        <select
          className="select xs"
          aria-label={t(language, "insights.filterHarness")}
          value={harness}
          onChange={(e) => setHarness(e.target.value)}
        >
          <option value="">{t(language, "insights.allHarnesses")}</option>
          {(insights?.facets.harnesses ?? []).map((h) => (
            <option key={h} value={h}>{h}</option>
          ))}
        </select>

        {(projectId || quotaPool || harness || action || billingMode) && (
          <button
            type="button"
            className="btn ghost xs"
            onClick={() => {
              setProjectId("");
              setQuotaPool("");
              setHarness("");
              setAction("");
              setBillingMode("");
            }}
          >
            {t(language, "insights.resetFilters")}
          </button>
        )}
      </div>

      {isLoading && !insights ? (
        <div className="muted">{t(language, "common.loading")}</div>
      ) : kpi && kpi.totalRuns === 0 ? (
        <div className="card">
          <div className="muted">{t(language, "insights.empty")}</div>
        </div>
      ) : kpi ? (
        <>
          <div className="insights-kpi-grid" data-testid="insights-kpi-grid">
            <div className="card insights-kpi-card">
              <div className="muted xs"><Icon icon={Activity} size={14} /> {t(language, "insights.kpi.runs")}</div>
              <div className="insights-kpi-val">{kpi.totalRuns}</div>
              <div className="muted xs">
                {t(language, "insights.kpi.successRate")}: <strong>{formatPercent(kpi.successRate)}</strong> ({kpi.succeededRuns}/{kpi.failedRuns} err)
              </div>
            </div>
            <div className="card insights-kpi-card">
              <div className="muted xs"><Icon icon={Cpu} size={14} /> {t(language, "insights.kpi.tokens")}</div>
              <div className="insights-kpi-val">{formatTokenCount(kpi.totalTokens)}</div>
              <div className="muted xs">
                {t(language, "audit.cacheHitRate")}: <strong>{formatPercent(kpi.cacheHitRate)}</strong> ({formatTokenCount(kpi.cacheReadTokens)})
              </div>
            </div>
            <div className="card insights-kpi-card">
              <div className="muted xs">{t(language, "audit.dualCost")}</div>
              <div className="insights-kpi-val">{formatUsd(kpi.apiCostUsd)}</div>
              <div className="muted xs">
                {t(language, "audit.equivShort")}: <strong>{formatUsd(kpi.equivalentCostUsd)}</strong>
              </div>
            </div>
            <div className="card insights-kpi-card">
              <div className="muted xs"><Icon icon={Clock} size={14} /> {t(language, "insights.kpi.duration")}</div>
              <div className="insights-kpi-val">{formatDurationHuman(kpi.avgDurationMs)}</div>
              <div className="muted xs">
                P50 {formatDurationHuman(kpi.p50DurationMs)} · P95 {formatDurationHuman(kpi.p95DurationMs)}
              </div>
            </div>
            <div className="card insights-kpi-card">
              <div className="muted xs"><Icon icon={Wrench} size={14} /> {t(language, "insights.kpi.tools")}</div>
              <div className="insights-kpi-val">{kpi.totalToolCalls}</div>
              <div className="muted xs">
                {t(language, "insights.kpi.toolErrors")}: <strong>{kpi.totalToolErrors}</strong>
              </div>
            </div>
            <div className="card insights-kpi-card">
              <div className="muted xs">{t(language, "insights.kpi.reliability")}</div>
              <div className="insights-kpi-val">{kpi.totalCompactions}</div>
              <div className="muted xs">
                429 {kpi.rateLimitedRuns} · timeout {kpi.timedOutRuns} · fallback {kpi.degradedRuns}
              </div>
            </div>
          </div>

          <div className="insights-charts-grid">
            <div className="card">
              <div className="card-head">
                <h3>{t(language, "insights.dailyTrend")}</h3>
                <div className="segmented">
                  {(["tokens", "cost", "runs"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={metricMode === m ? "active" : ""}
                      onClick={() => setMetricMode(m)}
                    >
                      {t(language, `insights.metric.${m}` as MessageKey)}
                    </button>
                  ))}
                </div>
              </div>
              <StackedBarChart
                data={stackedData}
                formatValue={(v) =>
                  metricMode === "cost"
                    ? formatUsd(v)
                    : metricMode === "tokens"
                      ? formatTokenCount(v)
                      : String(Math.round(v))
                }
              />
            </div>

            <div className="card">
              <div className="card-head">
                <h3>{t(language, "insights.heatmap84d")}</h3>
              </div>
              <ActivityHeatmap
                days={insights.heatmap}
                formatTooltip={(d) => `${d.date}: ${d.runs} runs · ${formatTokenCount(d.tokens)} tok · ${formatUsd(d.equivalentCostUsd)}`}
              />
            </div>
          </div>

          <div className="insights-charts-grid">
            <div className="card" data-testid="insights-quota-pools-card">
              <div className="card-head">
                <h3>{t(language, "insights.byQuotaPool")}</h3>
              </div>
              <DonutRingChart
                centerValue={formatUsd(kpi.equivalentCostUsd)}
                centerLabel={t(language, "audit.equivShort")}
                segments={insights.byQuotaPool.map((p, idx) => ({
                  key: p.quotaPool,
                  label: `${p.label} (${t(language, `insights.billing.${p.billingMode}` as MessageKey)})`,
                  value: p.equivalentCostUsd > 0 ? p.equivalentCostUsd : Math.max(1, p.tokens),
                  color: POOL_COLORS[idx % POOL_COLORS.length]!,
                  hint: `${p.runs} runs · ${formatTokenCount(p.tokens)} · ${formatUsd(p.equivalentCostUsd)}`,
                }))}
              />
              <div className="audit-section-table" style={{ marginTop: 10 }}>
                {insights.byQuotaPool.map((p) => (
                  <div key={p.quotaPool} className="audit-section-row xs" data-testid={`pool-row-${p.quotaPool}`}>
                    <span>
                      <strong>{p.label}</strong>{" "}
                      <span className={`badge xs ${p.billingMode === "api" ? "warning" : p.billingMode === "free" ? "success" : "info"}`}>
                        {t(language, `insights.billing.${p.billingMode}` as MessageKey)}
                      </span>
                    </span>
                    <span className="muted">
                      {p.runs} runs · {formatTokenCount(p.tokens)} · cache {formatPercent(p.cacheHitRate)} · API {formatUsd(p.apiCostUsd)} / eq{" "}
                      {formatUsd(p.equivalentCostUsd)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <h3>{t(language, "insights.byStage")}</h3>
              </div>
              <DonutRingChart
                centerValue={String(kpi.totalRuns)}
                centerLabel="runs"
                segments={insights.byAction.map((a) => ({
                  key: a.action,
                  label: formatAgentActionLabel(language, a.action),
                  value: a.runs,
                  color: ACTION_COLORS[a.action] ?? "var(--accent)",
                  hint: `${a.runs} · ${formatTokenCount(a.tokens)} · ${formatUsd(a.equivalentCostUsd)}`,
                }))}
              />
            </div>
          </div>

          {insights.diagnostics.length > 0 && (
            <div className="card" data-testid="insights-diagnostics-card">
              <div className="card-head">
                <h3>{t(language, "insights.diagnosticsTitle")}</h3>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {insights.diagnostics.map((diag) => (
                  <div
                    key={diag.id}
                    className={`callout ${diag.severity} xs`}
                    style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}
                  >
                    <div>
                      <Icon icon={diag.severity === "info" ? CheckCircle2 : AlertTriangle} size={14} />{" "}
                      <strong>{t(language, diag.titleKey as MessageKey, diag.params)}</strong>
                      <div className="muted" style={{ marginTop: 2 }}>
                        {t(language, diag.detailKey as MessageKey, diag.params)}
                      </div>
                    </div>
                    {diag.requirementId && (
                      <button
                        type="button"
                        className="btn ghost xs"
                        onClick={() => void jumpToRequirementFromInsights(diag.projectId, diag.requirementId!)}
                      >
                        {diag.requirementId} →
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="card" data-testid="insights-model-table-card">
            <div className="card-head">
              <h3>{t(language, "insights.modelEfficiencyTitle")}</h3>
            </div>
            <div className="insights-table-wrap">
              <table className="insights-table">
                <thead>
                  <tr>
                    <th>Harness / Model</th>
                    <th>{t(language, "insights.col.stage")}</th>
                    <th>{t(language, "insights.col.pool")}</th>
                    <th>
                      <button type="button" className="table-sort-btn" onClick={() => handleSort("runs")}>
                        Runs
                      </button>
                    </th>
                    <th>
                      <button type="button" className="table-sort-btn" onClick={() => handleSort("successRate")}>
                        {t(language, "insights.kpi.successRate")}
                      </button>
                    </th>
                    <th>
                      <button type="button" className="table-sort-btn" onClick={() => handleSort("avgDurationMs")}>
                        {t(language, "insights.kpi.duration")}
                      </button>
                    </th>
                    <th>
                      <button type="button" className="table-sort-btn" onClick={() => handleSort("avgTokens")}>
                        Avg Tok
                      </button>
                    </th>
                    <th>
                      <button type="button" className="table-sort-btn" onClick={() => handleSort("cacheHitRate")}>
                        Cache
                      </button>
                    </th>
                    <th>
                      <button type="button" className="table-sort-btn" onClick={() => handleSort("totalEquivalentCostUsd")}>
                        Equiv USD
                      </button>
                    </th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedModels.map((m) => (
                    <tr key={`${m.harness}-${m.model}-${m.action}`}>
                      <td>
                        <strong>{m.harness}</strong> / {m.model}
                      </td>
                      <td>{formatAgentActionLabel(language, m.action)}</td>
                      <td className="muted xs">{m.quotaPool}</td>
                      <td>{m.runs}</td>
                      <td>{formatPercent(m.runs > 0 ? m.succeededRuns / m.runs : 0)}</td>
                      <td>{formatDurationHuman(m.avgDurationMs)}</td>
                      <td>{formatTokenCount(m.avgTokens)}</td>
                      <td>{formatPercent(m.cacheHitRate)}</td>
                      <td>{formatUsd(m.totalEquivalentCostUsd)}</td>
                      <td>
                        {m.coolingUntil ? (
                          <button
                            type="button"
                            className="btn warning xs"
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
                          </button>
                        ) : (
                          <span className="badge success xs">{t(language, "insights.healthy")}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {insights.topRequirements.length > 0 && (
            <div className="card" data-testid="insights-top-reqs-card">
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
                      <button
                        type="button"
                        className="btn ghost xs"
                        data-testid={`insights-jump-req-${r.requirementId}`}
                        onClick={() => void jumpToRequirementFromInsights(r.projectId, r.requirementId)}
                      >
                        <strong>{r.requirementId}</strong>
                      </button>{" "}
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
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
