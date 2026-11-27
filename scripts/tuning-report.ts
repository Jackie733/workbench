#!/usr/bin/env bun
import * as path from "node:path";
import { computeTuningReport, type TuningGroupStats } from "../src/hub/ledger.ts";

function fmtMs(ms: number | null): string {
  if (ms === null) return "未知";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(2)}h`;
}

function fmtNum(v: number | null, suffix = ""): string {
  return v === null ? "未知" : `${v}${suffix}`;
}

function fmtPct(v: number | null): string {
  return v === null ? "未知" : `${(v * 100).toFixed(1)}%`;
}

function renderTable(title: string, rows: TuningGroupStats[]): string[] {
  const lines = [
    `## ${title}`,
    "",
    "| 分组 | 已验收 | 已取消 | 进行中 | 平均调用次数 | 可观测总 Token | 均单需求 Token | 缺失遥测运行 | 平均验收耗时 | 验收后重开率 |",
    "| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const r of rows) {
    lines.push(
      `| \`${r.key}\` | ${r.acceptedCount} | ${r.cancelledCount} | ${r.inProgressCount} | ${fmtNum(r.avgModelCallsPerAccepted)} | ${fmtNum(r.observableTokensTotal)} | ${fmtNum(r.avgObservableTokensPerAccepted)} | ${r.unknownTokenRuns}/${r.knownTokenRuns + r.unknownTokenRuns} | ${fmtMs(r.avgTimeToAcceptMs)} | ${fmtPct(r.reopenRateAfterAccept)} |`,
    );
  }
  lines.push("");
  return lines;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: bun run scripts/tuning-report.ts [--json] [projectRoot...]");
    process.exit(0);
  }
  const unknownFlag = args.find((a) => a.startsWith("-") && a !== "--json");
  if (unknownFlag) {
    console.error(`Unknown option: ${unknownFlag}\nUsage: bun run scripts/tuning-report.ts [--json] [projectRoot...]`);
    process.exit(1);
  }
  const asJson = args.includes("--json");
  const roots = args.filter((a) => a !== "--json").map((r) => path.resolve(r));
  const report = computeTuningReport(roots.length > 0 ? { roots } : {});
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const out = [
      `# Workbench 流程调优与遥测报表`,
      "",
      `- 扫描项目数：${report.scannedProjects.length}`,
      `- 需求总数：${report.totals.requirements}（已验收 ${report.totals.accepted} / 已取消 ${report.totals.cancelled} / 进行中 ${report.totals.inProgress}）`,
      `- Token 遥测覆盖：已知 ${report.totals.knownTokenRuns} 次 / 未知 ${report.totals.unknownTokenRuns} 次`,
      "",
      ...renderTable("按轨道对比（plan_first / fast_track / bug）", report.byTrack),
      ...renderTable("按 Harness 对比", report.byHarness),
    ];
    console.log(out.join("\n"));
  }
}
