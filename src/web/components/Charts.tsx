import type { CSSProperties } from "react";

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
  height = 180,
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

  const maxTotal = Math.max(
    1,
    ...data.map((d) => d.segments.reduce((acc, s) => acc + Math.max(0, s.value), 0)),
  );
  const w = Math.max(360, data.length * 24);
  const padL = 44;
  const padR = 12;
  const padT = 12;
  const padB = 26;
  const plotW = w - padL - padR;
  const plotH = height - padT - padB;
  const slotW = plotW / data.length;
  const barW = Math.max(6, Math.min(24, slotW * 0.68));

  const legendMap = new Map<string, { label: string; color: string }>();
  for (const d of data) {
    for (const s of d.segments) {
      if (!legendMap.has(s.key)) legendMap.set(s.key, { label: s.label, color: s.color });
    }
  }

  const xLabelStep = data.length > 20 ? 5 : data.length > 10 ? 3 : 1;

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${w} ${height}`} className="chart-svg" role="img" aria-label="Stacked bar chart">
        {[0, 0.5, 1].map((frac) => {
          const y = padT + plotH * (1 - frac);
          return (
            <g key={frac}>
              <line
                x1={padL}
                y1={y}
                x2={w - padR}
                y2={y}
                stroke="var(--border)"
                strokeDasharray={frac > 0 ? "3 3" : undefined}
                strokeWidth={1}
              />
              <text
                x={padL - 6}
                y={y + 3}
                textAnchor="end"
                fontSize="10"
                fill="var(--muted)"
              >
                {formatValue(maxTotal * frac)}
              </text>
            </g>
          );
        })}

        {data.map((d, idx) => {
          const x = padL + idx * slotW + (slotW - barW) / 2;
          let yBottom = padT + plotH;
          const total = d.segments.reduce((acc, s) => acc + Math.max(0, s.value), 0);
          return (
            <g key={d.key}>
              <title>{d.tooltip ?? `${d.label}: ${formatValue(total)}`}</title>
              {d.segments.map((seg) => {
                const v = Math.max(0, seg.value);
                if (v <= 0) return null;
                const segH = (v / maxTotal) * plotH;
                const yTop = yBottom - segH;
                yBottom = yTop;
                return (
                  <rect
                    key={seg.key}
                    x={x}
                    y={yTop}
                    width={barW}
                    height={Math.max(1, segH)}
                    rx={2}
                    fill={seg.color}
                  />
                );
              })}
              {(idx % xLabelStep === 0 || idx === data.length - 1) && (
                <text
                  x={x + barW / 2}
                  y={height - 6}
                  textAnchor="middle"
                  fontSize="10"
                  fill="var(--muted)"
                >
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {legendMap.size > 0 && (
        <div className="chart-legend">
          {Array.from(legendMap.entries()).map(([key, meta]) => (
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

export function ContextGrowthChart({
  turns,
  contextWindow,
  compactions = [],
  height = 170,
  emptyText = "—",
}: {
  turns: Array<{ turnIndex: number; contextTokens: number }>;
  contextWindow: number;
  compactions?: Array<{ turnIndex: number; mode: string; reclaimedTokens?: number }>;
  height?: number;
  emptyText?: string;
}) {
  if (turns.length === 0) {
    return <div className="chart-empty muted xs">{emptyText}</div>;
  }

  const maxY = Math.max(contextWindow || 1000, ...turns.map((t) => t.contextTokens));
  const w = 520;
  const padL = 48;
  const padR = 16;
  const padT = 14;
  const padB = 26;
  const plotW = w - padL - padR;
  const plotH = height - padT - padB;
  const xForIdx = (idx: number) =>
    turns.length === 1 ? padL + plotW / 2 : padL + (idx / (turns.length - 1)) * plotW;
  const yForVal = (v: number) => padT + plotH * (1 - Math.min(1, Math.max(0, v) / maxY));

  const points = turns.map((t, idx) => `${xForIdx(idx).toFixed(1)},${yForVal(t.contextTokens).toFixed(1)}`);
  const areaPoints = [
    `${xForIdx(0).toFixed(1)},${(padT + plotH).toFixed(1)}`,
    ...points,
    `${xForIdx(turns.length - 1).toFixed(1)},${(padT + plotH).toFixed(1)}`,
  ].join(" ");

  const yWin = yForVal(contextWindow);
  const yWarn = yForVal(contextWindow * 0.8);

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${w} ${height}`} className="chart-svg" role="img" aria-label="Context window growth">
        <line x1={padL} y1={padT + plotH} x2={w - padR} y2={padT + plotH} stroke="var(--border)" />
        {contextWindow > 0 && (
          <>
            <line
              x1={padL}
              y1={yWin}
              x2={w - padR}
              y2={yWin}
              stroke="var(--danger)"
              strokeDasharray="4 4"
              strokeWidth={1}
            />
            <text x={padL - 5} y={yWin + 3} textAnchor="end" fontSize="10" fill="var(--danger)">
              100%
            </text>
            <line
              x1={padL}
              y1={yWarn}
              x2={w - padR}
              y2={yWarn}
              stroke="var(--warning)"
              strokeDasharray="3 3"
              strokeWidth={1}
            />
            <text x={padL - 5} y={yWarn + 3} textAnchor="end" fontSize="10" fill="var(--warning)">
              80%
            </text>
          </>
        )}

        <polygon points={areaPoints} fill="var(--accent)" opacity={0.14} />
        {turns.length > 1 && (
          <polyline
            fill="none"
            stroke="var(--accent)"
            strokeWidth={2}
            points={points.join(" ")}
          />
        )}

        {compactions.map((c, idx) => {
          const turnIdx = turns.findIndex((t) => t.turnIndex >= c.turnIndex);
          const x = turnIdx >= 0 ? xForIdx(turnIdx) : xForIdx(turns.length - 1);
          return (
            <line
              key={`${c.turnIndex}-${idx}`}
              x1={x}
              y1={padT}
              x2={x}
              y2={padT + plotH}
              stroke="var(--warning)"
              strokeWidth={1.5}
              strokeDasharray="2 2"
            >
              <title>{`Turn #${c.turnIndex} compaction (${c.mode})`}</title>
            </line>
          );
        })}

        {turns.map((t, idx) => {
          const cx = xForIdx(idx);
          const cy = yForVal(t.contextTokens);
          return (
            <g key={t.turnIndex}>
              <circle cx={cx} cy={cy} r={3.5} fill="var(--accent)">
                <title>{`Turn #${t.turnIndex}: ${t.contextTokens.toLocaleString()} tokens`}</title>
              </circle>
              {(turns.length <= 12 || idx % Math.ceil(turns.length / 8) === 0 || idx === turns.length - 1) && (
                <text x={cx} y={height - 6} textAnchor="middle" fontSize="10" fill="var(--muted)">
                  #{t.turnIndex}
                </text>
              )}
            </g>
          );
        })}
      </svg>
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
  size = 132,
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

  const r = 42;
  const c = 2 * Math.PI * r;
  let offset = 0;

  return (
    <div className="donut-wrap">
      <svg width={size} height={size} viewBox="0 0 112 112" className="donut-svg" role="img">
        <circle cx="56" cy="56" r={r} fill="none" stroke="var(--surface-2)" strokeWidth="14" />
        {nonZero.map((seg) => {
          const frac = seg.value / total;
          const dash = frac * c;
          const curOffset = offset;
          offset += dash;
          return (
            <circle
              key={seg.key}
              cx="56"
              cy="56"
              r={r}
              fill="none"
              stroke={seg.color}
              strokeWidth="14"
              strokeDasharray={`${dash} ${c - dash}`}
              strokeDashoffset={-curOffset}
              transform="rotate(-90 56 56)"
            >
              <title>{`${seg.label}: ${seg.hint ?? seg.value}`}</title>
            </circle>
          );
        })}
        {centerValue && (
          <text x="56" y="54" textAnchor="middle" fontSize="13" fontWeight="700" fill="var(--text)">
            {centerValue}
          </text>
        )}
        {centerLabel && (
          <text x="56" y="68" textAnchor="middle" fontSize="9.5" fill="var(--muted)">
            {centerLabel}
          </text>
        )}
      </svg>
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
