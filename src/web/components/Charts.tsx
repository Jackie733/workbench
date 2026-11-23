import {
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  DoughnutController,
  Filler,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
  type ChartConfiguration,
  type Plugin,
} from "chart.js";
import { useEffect, useRef, type CSSProperties } from "react";
import { useUiStore } from "../stores/uiStore.ts";

Chart.register(
  LineController,
  BarController,
  DoughnutController,
  LineElement,
  BarElement,
  PointElement,
  ArcElement,
  CategoryScale,
  LinearScale,
  Filler,
  Tooltip,
  Legend,
);

function resolveCssColor(color: string, fallback = "#3b82f6"): string {
  if (!color) return fallback;
  const trimmed = color.trim();
  if (typeof document !== "undefined" && trimmed.startsWith("var(")) {
    const inner = trimmed.slice(4, -1).split(",")[0]?.trim() ?? "";
    if (inner) {
      const val = getComputedStyle(document.documentElement).getPropertyValue(inner).trim();
      if (val) return val;
    }
    return fallback;
  }
  return trimmed;
}

function parseRgb(color: string): [number, number, number] | null {
  const hex = color.trim();
  if (hex.startsWith("#")) {
    const body = hex.slice(1);
    if (body.length === 3) {
      const r = parseInt(body[0]! + body[0]!, 16);
      const g = parseInt(body[1]! + body[1]!, 16);
      const b = parseInt(body[2]! + body[2]!, 16);
      if ([r, g, b].every((n) => Number.isFinite(n))) return [r, g, b];
    } else if (body.length === 6 || body.length === 8) {
      const r = parseInt(body.slice(0, 2), 16);
      const g = parseInt(body.slice(2, 4), 16);
      const b = parseInt(body.slice(4, 6), 16);
      if ([r, g, b].every((n) => Number.isFinite(n))) return [r, g, b];
    }
  }
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(hex);
  if (m) {
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  return null;
}

function withAlpha(color: string, alpha: number, fallback = "#3b82f6"): string {
  const resolved = resolveCssColor(color, fallback);
  const rgb = parseRgb(resolved);
  if (!rgb) return resolved;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

function formatCompactCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) < 1000) return String(Math.round(n));
  if (Math.abs(n) < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function readChartPalette() {
  return {
    text: resolveCssColor("var(--text)", "#18181b"),
    muted: resolveCssColor("var(--muted)", "#71717a"),
    border: resolveCssColor("var(--border)", "#e4e4e7"),
    surface: resolveCssColor("var(--surface)", "#ffffff"),
    surface2: resolveCssColor("var(--surface-2)", "#f4f4f5"),
    accent: resolveCssColor("var(--accent)", "#2563eb"),
    warning: resolveCssColor("var(--warning)", "#d97706"),
    danger: resolveCssColor("var(--danger)", "#dc2626"),
    success: resolveCssColor("var(--success)", "#16a34a"),
  };
}

function ChartCanvas({
  buildConfig,
  deps,
  height,
  width,
  ariaLabel,
  onElementClick,
}: {
  buildConfig: () => ChartConfiguration;
  deps: unknown[];
  height: number;
  width?: number;
  ariaLabel: string;
  onElementClick?: (index: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const theme = useUiStore((s) => s.theme);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const config = buildConfig();
    if (onElementClick && config.options) {
      config.options.onClick = (_event, elements) => {
        if (elements.length > 0 && typeof elements[0]?.index === "number") {
          onElementClick(elements[0].index);
        }
      };
    }

    const chart = new Chart(ctx, config);
    return () => {
      chart.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, ...deps]);

  return (
    <div
      className="chart-canvas-box"
      style={width ? { width, height } : { height }}
    >
      <canvas ref={canvasRef} role="img" aria-label={ariaLabel} />
    </div>
  );
}

export interface StackedBarSegment {
  key: string;
  label: string;
  value: number;
  color: string;
}

export interface StackedBarDatum {
  key: string;
  label: string;
  segments: StackedBarSegment[];
  tooltip?: string;
}

export function StackedBarChart({
  data,
  height = 195,
  formatValue = (v) => String(Math.round(v)),
  emptyText = "—",
}: {
  data: StackedBarDatum[];
  height?: number;
  formatValue?: (v: number) => string;
  emptyText?: string;
}) {
  if (data.length === 0) {
    return <div className="chart-empty muted xs">{emptyText}</div>;
  }

  const seriesMeta = new Map<string, { label: string; color: string }>();
  for (const d of data) {
    for (const s of d.segments) {
      if (!seriesMeta.has(s.key)) seriesMeta.set(s.key, { label: s.label, color: s.color });
    }
  }
  const seriesKeys = Array.from(seriesMeta.entries());

  return (
    <div className="chart-wrap">
      <ChartCanvas
        height={height}
        ariaLabel="Stacked bar chart"
        deps={[data]}
        buildConfig={() => {
          const pal = readChartPalette();
          return {
            type: "bar",
            data: {
              labels: data.map((d) => d.label),
              datasets: seriesKeys.map(([key, meta], idx) => {
                const resolvedColor = resolveCssColor(meta.color, pal.accent);
                return {
                  label: meta.label,
                  data: data.map((d) => d.segments.find((s) => s.key === key)?.value ?? 0),
                  backgroundColor: withAlpha(resolvedColor, 0.86, pal.accent),
                  hoverBackgroundColor: resolvedColor,
                  borderRadius: idx === seriesKeys.length - 1 ? 4 : 1,
                  borderSkipped: false,
                  maxBarThickness: 28,
                };
              }),
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              animation: { duration: 220 },
              interaction: { mode: "index", intersect: false },
              plugins: {
                legend: { display: false },
                tooltip: {
                  backgroundColor: pal.surface,
                  titleColor: pal.text,
                  bodyColor: pal.text,
                  borderColor: pal.border,
                  borderWidth: 1,
                  padding: 10,
                  cornerRadius: 8,
                  callbacks: {
                    label: (item) => {
                      const val = typeof item.parsed.y === "number" ? item.parsed.y : 0;
                      if (val <= 0) return "";
                      return ` ${item.dataset.label}: ${formatValue(val)}`;
                    },
                    footer: (items) => {
                      const firstIdx = items[0]?.dataIndex;
                      if (typeof firstIdx === "number" && data[firstIdx]?.tooltip) {
                        return data[firstIdx]!.tooltip!;
                      }
                      const total = items.reduce((acc, it) => acc + (it.parsed.y ?? 0), 0);
                      return `Total: ${formatValue(total)}`;
                    },
                  },
                },
              },
              scales: {
                x: {
                  stacked: true,
                  grid: { display: false },
                  border: { color: pal.border },
                  ticks: {
                    color: pal.muted,
                    font: { size: 11 },
                    maxRotation: 0,
                    autoSkip: true,
                    maxTicksLimit: 12,
                  },
                },
                y: {
                  stacked: true,
                  beginAtZero: true,
                  border: { display: false },
                  grid: { color: withAlpha(pal.border, 0.55) },
                  ticks: {
                    color: pal.muted,
                    font: { size: 11 },
                    maxTicksLimit: 5,
                    callback: (v) => formatValue(Number(v)),
                  },
                },
              },
            },
          };
        }}
      />
      {seriesKeys.length > 0 && (
        <div className="chart-legend">
          {seriesKeys.map(([key, meta]) => (
            <span key={key} className="chart-legend-item">
              <span className="chart-swatch" style={{ background: meta.color }} />
              {meta.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export interface ContextTurnPoint {
  turnIndex: number;
  contextTokens: number;
  cacheReadTokens?: number;
  uncachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  durationMs?: number;
  toolsSummary?: string;
}

export function ContextGrowthChart({
  turns,
  contextWindow,
  compactions = [],
  height = 225,
  emptyText = "—",
  cacheLabel = "Cache Read",
  uncachedLabel = "Uncached Input",
}: {
  turns: ContextTurnPoint[];
  contextWindow: number;
  compactions?: Array<{ turnIndex: number; mode: string; reclaimedTokens?: number }>;
  height?: number;
  emptyText?: string;
  cacheLabel?: string;
  uncachedLabel?: string;
}) {
  if (turns.length === 0) {
    return <div className="chart-empty muted xs">{emptyText}</div>;
  }

  const hasCacheBreakdown = turns.some((t) => (t.cacheReadTokens ?? 0) > 0);
  const maxTurnVal = Math.max(...turns.map((t) => t.contextTokens), 1);
  const yCeiling = contextWindow > 0 ? Math.max(contextWindow * 1.05, maxTurnVal * 1.08) : maxTurnVal * 1.15;

  return (
    <div className="chart-wrap">
      <ChartCanvas
        height={height}
        ariaLabel="Context window evolution chart"
        deps={[turns, contextWindow, compactions, cacheLabel, uncachedLabel]}
        buildConfig={() => {
          const pal = readChartPalette();
          const warnLevel = contextWindow > 0 ? contextWindow * 0.8 : 0;
          const limitLevel = contextWindow > 0 ? contextWindow : 0;

          const overlayPlugin: Plugin = {
            id: "workbenchContextOverlay",
            afterDatasetsDraw(chart) {
              const { ctx, chartArea, scales } = chart;
              const yScale = scales.y;
              if (!chartArea || !yScale) return;

              ctx.save();
              const drawThresholdLine = (val: number, color: string, label: string, dash: number[]) => {
                if (val <= 0) return;
                const y = yScale.getPixelForValue(val);
                if (y < chartArea.top - 4 || y > chartArea.bottom + 4) return;
                ctx.beginPath();
                ctx.setLineDash(dash);
                ctx.strokeStyle = withAlpha(color, 0.72);
                ctx.lineWidth = 1.2;
                ctx.moveTo(chartArea.left, y);
                ctx.lineTo(chartArea.right, y);
                ctx.stroke();
                ctx.setLineDash([]);

                ctx.font = "600 10px sans-serif";
                const textW = ctx.measureText(label).width;
                const pillW = textW + 10;
                const pillH = 16;
                const pillX = chartArea.right - pillW - 4;
                const pillY = Math.max(chartArea.top + 2, y - pillH - 2);
                ctx.fillStyle = withAlpha(color, 0.14);
                ctx.beginPath();
                ctx.roundRect(pillX, pillY, pillW, pillH, 4);
                ctx.fill();
                ctx.fillStyle = color;
                ctx.textAlign = "left";
                ctx.textBaseline = "middle";
                ctx.fillText(label, pillX + 5, pillY + pillH / 2);
              };

              drawThresholdLine(warnLevel, pal.warning, "80%", [4, 4]);
              drawThresholdLine(limitLevel, pal.danger, "100%", [5, 3]);

              // Vertical compaction event markers
              const xScale = scales.x;
              if (xScale) {
                for (const c of compactions) {
                  const idx = turns.findIndex((t) => t.turnIndex >= c.turnIndex);
                  const safeIdx = idx >= 0 ? idx : turns.length - 1;
                  const x = xScale.getPixelForValue(safeIdx);
                  ctx.beginPath();
                  ctx.setLineDash([3, 3]);
                  ctx.strokeStyle = pal.warning;
                  ctx.lineWidth = 1.5;
                  ctx.moveTo(x, chartArea.top);
                  ctx.lineTo(x, chartArea.bottom);
                  ctx.stroke();
                  ctx.setLineDash([]);

                  const tag = c.reclaimedTokens
                    ? `Compact -${formatCompactCount(c.reclaimedTokens)}`
                    : "Compact";
                  ctx.font = "600 10px sans-serif";
                  const tw = ctx.measureText(tag).width + 10;
                  const tx = Math.min(chartArea.right - tw - 2, Math.max(chartArea.left + 2, x - tw / 2));
                  ctx.fillStyle = withAlpha(pal.warning, 0.18);
                  ctx.beginPath();
                  ctx.roundRect(tx, chartArea.top + 2, tw, 16, 4);
                  ctx.fill();
                  ctx.fillStyle = pal.warning;
                  ctx.textAlign = "left";
                  ctx.textBaseline = "middle";
                  ctx.fillText(tag, tx + 5, chartArea.top + 10);
                }

                // Active hover vertical crosshair line
                const active = chart.tooltip?.getActiveElements?.() ?? [];
                if (active.length > 0 && active[0]?.element) {
                  const ax = active[0].element.x;
                  ctx.beginPath();
                  ctx.setLineDash([2, 3]);
                  ctx.strokeStyle = withAlpha(pal.muted, 0.65);
                  ctx.lineWidth = 1;
                  ctx.moveTo(ax, chartArea.top);
                  ctx.lineTo(ax, chartArea.bottom);
                  ctx.stroke();
                  ctx.setLineDash([]);
                }
              }
              ctx.restore();
            },
          };

          const makeVerticalGradient = (baseColor: string, topAlpha: number, bottomAlpha: number) =>
            (ctx: { chart: Chart }) => {
              const { ctx: c, chartArea } = ctx.chart;
              if (!chartArea) return withAlpha(baseColor, topAlpha);
              const grad = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
              grad.addColorStop(0, withAlpha(baseColor, topAlpha));
              grad.addColorStop(1, withAlpha(baseColor, bottomAlpha));
              return grad;
            };

          const datasets: ChartConfiguration<"line">["data"]["datasets"] = hasCacheBreakdown
            ? [
                {
                  label: cacheLabel,
                  data: turns.map((t) => t.cacheReadTokens ?? 0),
                  borderColor: "#10b981",
                  backgroundColor: makeVerticalGradient("#10b981", 0.28, 0.02),
                  borderWidth: 2,
                  pointRadius: turns.length <= 24 ? 3 : 1.5,
                  pointHoverRadius: 5,
                  pointBackgroundColor: "#10b981",
                  pointBorderColor: pal.surface,
                  pointBorderWidth: 1.5,
                  tension: 0.34,
                  cubicInterpolationMode: "monotone",
                  fill: "origin",
                },
                {
                  label: uncachedLabel,
                  data: turns.map((t) =>
                    typeof t.uncachedInputTokens === "number"
                      ? t.uncachedInputTokens
                      : Math.max(0, t.contextTokens - (t.cacheReadTokens ?? 0)),
                  ),
                  borderColor: pal.accent,
                  backgroundColor: makeVerticalGradient(pal.accent, 0.26, 0.03),
                  borderWidth: 2.2,
                  pointRadius: turns.length <= 24 ? 3.2 : 1.5,
                  pointHoverRadius: 5.5,
                  pointBackgroundColor: pal.accent,
                  pointBorderColor: pal.surface,
                  pointBorderWidth: 1.5,
                  tension: 0.34,
                  cubicInterpolationMode: "monotone",
                  fill: "-1",
                },
              ]
            : [
                {
                  label: "Context Tokens",
                  data: turns.map((t) => t.contextTokens),
                  borderColor: pal.accent,
                  backgroundColor: makeVerticalGradient(pal.accent, 0.28, 0.02),
                  borderWidth: 2.4,
                  pointRadius: turns.length <= 24 ? 3.5 : 1.5,
                  pointHoverRadius: 6,
                  pointBackgroundColor: pal.accent,
                  pointBorderColor: pal.surface,
                  pointBorderWidth: 2,
                  tension: 0.34,
                  cubicInterpolationMode: "monotone",
                  fill: "origin",
                },
              ];

          return {
            type: "line",
            plugins: [overlayPlugin],
            data: {
              labels: turns.map((t) => `#${t.turnIndex}`),
              datasets,
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              animation: { duration: 240 },
              interaction: { mode: "index", intersect: false },
              plugins: {
                legend: { display: false },
                tooltip: {
                  backgroundColor: pal.surface,
                  titleColor: pal.text,
                  bodyColor: pal.text,
                  footerColor: pal.muted,
                  borderColor: pal.border,
                  borderWidth: 1,
                  padding: 11,
                  cornerRadius: 8,
                  callbacks: {
                    title: (items) => {
                      const idx = items[0]?.dataIndex ?? 0;
                      const pt = turns[idx];
                      if (!pt) return "";
                      const pct = contextWindow > 0 ? ` (${Math.round((pt.contextTokens / contextWindow) * 100)}%)` : "";
                      return `Turn #${pt.turnIndex} · ${formatCompactCount(pt.contextTokens)} tok${pct}`;
                    },
                    label: (item) => {
                      const v = typeof item.parsed.y === "number" ? item.parsed.y : 0;
                      return ` ${item.dataset.label}: ${formatCompactCount(v)} tok`;
                    },
                    afterBody: (items) => {
                      const idx = items[0]?.dataIndex ?? 0;
                      const pt = turns[idx];
                      if (!pt) return [];
                      const lines: string[] = [];
                      if (idx > 0) {
                        const prev = turns[idx - 1]!;
                        const diff = pt.contextTokens - prev.contextTokens;
                        const sign = diff >= 0 ? "+" : "";
                        lines.push(`Delta: ${sign}${formatCompactCount(diff)} tok`);
                      }
                      if ((pt.cacheReadTokens ?? 0) > 0 && pt.contextTokens > 0) {
                        const hit = Math.round(((pt.cacheReadTokens ?? 0) / pt.contextTokens) * 100);
                        lines.push(`Cache hit: ${hit}%`);
                      }
                      if ((pt.outputTokens ?? 0) > 0) {
                        lines.push(`Output: ${formatCompactCount(pt.outputTokens ?? 0)} tok`);
                      }
                      if (pt.durationMs !== undefined) {
                        lines.push(`Duration: ${(pt.durationMs / 1000).toFixed(1)}s`);
                      }
                      if (pt.toolsSummary) {
                        lines.push(`Tools: ${pt.toolsSummary}`);
                      }
                      return lines;
                    },
                  },
                },
              },
              scales: {
                x: {
                  grid: { display: false },
                  border: { color: pal.border },
                  ticks: {
                    color: pal.muted,
                    font: { size: 11 },
                    maxRotation: 0,
                    autoSkip: true,
                    maxTicksLimit: 10,
                  },
                },
                y: {
                  stacked: hasCacheBreakdown,
                  beginAtZero: true,
                  suggestedMax: yCeiling,
                  border: { display: false },
                  grid: { color: withAlpha(pal.border, 0.5) },
                  ticks: {
                    color: pal.muted,
                    font: { size: 11 },
                    maxTicksLimit: 5,
                    callback: (v) => formatCompactCount(Number(v)),
                  },
                },
              },
            },
          };
        }}
      />
      {hasCacheBreakdown && (
        <div className="chart-legend">
          <span className="chart-legend-item">
            <span className="chart-swatch" style={{ background: "#10b981" }} />
            {cacheLabel}
          </span>
          <span className="chart-legend-item">
            <span className="chart-swatch" style={{ background: "var(--accent)" }} />
            {uncachedLabel}
          </span>
        </div>
      )}
    </div>
  );
}

export interface StepPayloadPoint {
  stepIndex: number;
  label: string;
  tokens: number;
  bytes: number;
  linesCount: number;
  category: string;
  categoryLabel: string;
  color: string;
  summary: string;
}

export function StepPayloadChart({
  steps,
  height = 215,
  emptyText = "—",
  onSelectStep,
}: {
  steps: StepPayloadPoint[];
  height?: number;
  emptyText?: string;
  onSelectStep?: (step: StepPayloadPoint) => void;
}) {
  if (steps.length === 0) {
    return <div className="chart-empty muted xs">{emptyText}</div>;
  }

  const catLegend = new Map<string, { label: string; color: string }>();
  for (const s of steps) {
    if (!catLegend.has(s.category)) {
      catLegend.set(s.category, { label: s.categoryLabel, color: s.color });
    }
  }

  return (
    <div className="chart-wrap">
      <ChartCanvas
        height={height}
        ariaLabel="Per-step captured payload chart"
        deps={[steps]}
        onElementClick={
          onSelectStep
            ? (idx) => {
                const hit = steps[idx];
                if (hit) onSelectStep(hit);
              }
            : undefined
        }
        buildConfig={() => {
          const pal = readChartPalette();
          return {
            type: "bar",
            data: {
              labels: steps.map((s) => s.label),
              datasets: [
                {
                  label: "Estimated Tokens",
                  data: steps.map((s) => s.tokens),
                  backgroundColor: steps.map((s) => withAlpha(s.color, 0.82, pal.accent)),
                  hoverBackgroundColor: steps.map((s) => resolveCssColor(s.color, pal.accent)),
                  borderRadius: 4,
                  borderSkipped: false,
                  maxBarThickness: 26,
                },
              ],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              animation: { duration: 220 },
              interaction: { mode: "index", intersect: false },
              plugins: {
                legend: { display: false },
                tooltip: {
                  backgroundColor: pal.surface,
                  titleColor: pal.text,
                  bodyColor: pal.text,
                  footerColor: pal.muted,
                  borderColor: pal.border,
                  borderWidth: 1,
                  padding: 10,
                  cornerRadius: 8,
                  callbacks: {
                    title: (items) => {
                      const idx = items[0]?.dataIndex ?? 0;
                      const st = steps[idx];
                      return st ? `Step #${st.stepIndex} · ${st.categoryLabel}` : "";
                    },
                    label: (item) => {
                      const idx = item.dataIndex;
                      const st = steps[idx];
                      if (!st) return "";
                      const kb = st.bytes >= 1024 ? `${(st.bytes / 1024).toFixed(1)} KB` : `${st.bytes} B`;
                      return ` ~${formatCompactCount(st.tokens)} tok (${kb}, ${st.linesCount} lines)`;
                    },
                    afterBody: (items) => {
                      const idx = items[0]?.dataIndex ?? 0;
                      const st = steps[idx];
                      return st?.summary ? [st.summary.slice(0, 96)] : [];
                    },
                  },
                },
              },
              scales: {
                x: {
                  grid: { display: false },
                  border: { color: pal.border },
                  ticks: {
                    color: pal.muted,
                    font: { size: 11 },
                    maxRotation: 0,
                    autoSkip: true,
                    maxTicksLimit: 14,
                  },
                },
                y: {
                  beginAtZero: true,
                  border: { display: false },
                  grid: { color: withAlpha(pal.border, 0.5) },
                  ticks: {
                    color: pal.muted,
                    font: { size: 11 },
                    maxTicksLimit: 5,
                    callback: (v) => formatCompactCount(Number(v)),
                  },
                },
              },
            },
          };
        }}
      />
      {catLegend.size > 0 && (
        <div className="chart-legend">
          {Array.from(catLegend.entries()).map(([key, meta]) => (
            <span key={key} className="chart-legend-item">
              <span className="chart-swatch" style={{ background: meta.color }} />
              {meta.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const SECTION_PALETTE = [
  "var(--accent)",
  "var(--success)",
  "var(--warning)",
  "#8b5cf6",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
  "#f97316",
];

export function CompositionBar({
  sections,
  totalBytes,
  budgetBytes,
}: {
  sections: Array<{ key: string; label: string; rawBytes: number; finalBytes: number; estTokens: number; truncated: boolean }>;
  totalBytes: number;
  budgetBytes: number;
}) {
  const denom = Math.max(1, totalBytes || sections.reduce((acc, s) => acc + s.finalBytes, 0));
  return (
    <div className="composition-wrap">
      <div className="composition-bar" role="img" aria-label="Handoff section budget">
        {sections.map((sec, idx) => {
          const pct = Math.max(2, (sec.finalBytes / denom) * 100);
          return (
            <div
              key={sec.key}
              className="composition-seg"
              style={{
                width: `${pct}%`,
                background: SECTION_PALETTE[idx % SECTION_PALETTE.length],
              }}
              title={`${sec.label}: ${sec.finalBytes}B (~${sec.estTokens} tok)${sec.truncated ? " [trimmed]" : ""}`}
            />
          );
        })}
      </div>
      <div className="composition-meta muted xs">
        <span>{totalBytes.toLocaleString()} / {budgetBytes.toLocaleString()} B</span>
        <span>{Math.round((totalBytes / Math.max(1, budgetBytes)) * 100)}%</span>
      </div>
    </div>
  );
}

export interface DonutSegment {
  key: string;
  label: string;
  value: number;
  color: string;
  hint?: string;
}

export function DonutRingChart({
  segments,
  centerLabel,
  centerValue,
  size = 144,
  emptyText = "—",
}: {
  segments: DonutSegment[];
  centerLabel?: string;
  centerValue?: string;
  size?: number;
  emptyText?: string;
}) {
  const nonZero = segments.filter((s) => s.value > 0);
  const total = nonZero.reduce((acc, s) => acc + s.value, 0);
  if (total <= 0) {
    return <div className="chart-empty muted xs">{emptyText}</div>;
  }

  return (
    <div className="donut-wrap">
      <div className="donut-canvas-wrap" style={{ width: size, height: size }}>
        <ChartCanvas
          width={size}
          height={size}
          ariaLabel="Donut distribution chart"
          deps={[nonZero]}
          buildConfig={() => {
            const pal = readChartPalette();
            return {
              type: "doughnut",
              data: {
                labels: nonZero.map((s) => s.label),
                datasets: [
                  {
                    data: nonZero.map((s) => s.value),
                    backgroundColor: nonZero.map((s) => resolveCssColor(s.color, pal.accent)),
                    borderColor: pal.surface,
                    borderWidth: 2,
                    hoverOffset: 5,
                  },
                ],
              },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: "68%",
                animation: { duration: 240 },
                plugins: {
                  legend: { display: false },
                  tooltip: {
                    backgroundColor: pal.surface,
                    titleColor: pal.text,
                    bodyColor: pal.text,
                    borderColor: pal.border,
                    borderWidth: 1,
                    padding: 9,
                    cornerRadius: 8,
                    callbacks: {
                      label: (item) => {
                        const seg = nonZero[item.dataIndex];
                        if (!seg) return "";
                        return ` ${seg.label}: ${seg.hint ?? `${Math.round((seg.value / total) * 100)}%`}`;
                      },
                    },
                  },
                },
              },
            };
          }}
        />
        {(centerValue || centerLabel) && (
          <div className="donut-center-overlay">
            {centerValue && <div className="donut-center-val">{centerValue}</div>}
            {centerLabel && <div className="donut-center-lbl">{centerLabel}</div>}
          </div>
        )}
      </div>
      <div className="donut-legend">
        {nonZero.map((seg) => (
          <div key={seg.key} className="donut-legend-row">
            <span className="donut-legend-left">
              <span className="chart-swatch" style={{ background: seg.color }} />
              <span className="donut-legend-name">{seg.label}</span>
            </span>
            <span className="muted xs">
              {seg.hint ?? `${Math.round((seg.value / total) * 100)}%`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ActivityHeatmap({
  days,
  formatTooltip,
}: {
  days: Array<{ date: string; runs: number; tokens: number; equivalentCostUsd: number }>;
  formatTooltip?: (d: { date: string; runs: number; tokens: number; equivalentCostUsd: number }) => string;
}) {
  const maxRuns = Math.max(1, ...days.map((d) => d.runs));
  const levelFor = (runs: number): number => {
    if (runs <= 0) return 0;
    const ratio = runs / maxRuns;
    if (ratio >= 0.75) return 4;
    if (ratio >= 0.45) return 3;
    if (ratio >= 0.2) return 2;
    return 1;
  };

  return (
    <div className="heatmap-grid" role="grid" aria-label="84-day activity heatmap">
      {days.map((d) => {
        const level = levelFor(d.runs);
        const title = formatTooltip
          ? formatTooltip(d)
          : `${d.date}: ${d.runs} runs · ${d.tokens.toLocaleString()} tok`;
        const style: CSSProperties | undefined =
          level === 0 ? undefined : { opacity: 0.28 + level * 0.18 };
        return (
          <div
            key={d.date}
            className={`heatmap-cell level-${level}`}
            style={style}
            title={title}
            data-date={d.date}
          />
        );
      })}
    </div>
  );
}
