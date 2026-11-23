import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendRunLedger, queryHubInsights, readRunLedger, type RunLedgerEntry } from "../../src/hub/ledger.ts";
import { computeRunCost, enrichAgentRunRecord, inferRunMetricsFromRawLog, resolveModelSpec, resolveQuotaPool } from "../../src/hub/pricing.ts";
import { readHubConfig, updateHubObservability } from "../../src/hub/registry.ts";

const tempDirs: string[] = [];
const origHubDir = process.env.WORKBENCH_HUB_DIR;

function makeTempHub(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-pricing-ledger-"));
  tempDirs.push(dir);
  process.env.WORKBENCH_HUB_DIR = dir;
  return dir;
}

afterEach(() => {
  if (origHubDir === undefined) delete process.env.WORKBENCH_HUB_DIR;
  else process.env.WORKBENCH_HUB_DIR = origHubDir;
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("quota pool attribution, dual pricing & global insights ledger", () => {
  test("classifies opencode-go as subscription and delegates omp runs to underlying provider quota pools", () => {
    expect(resolveQuotaPool("opencode", "opencode-go/glm-5")).toMatchObject({
      quotaPool: "opencode-go",
      billingMode: "subscription",
    });
    expect(resolveQuotaPool("opencode", "opencode/big-pickle")).toMatchObject({
      quotaPool: "opencode-free",
      billingMode: "free",
    });

    // omp never provides models itself; it delegates strictly by <provider>/ prefix
    expect(resolveQuotaPool("omp", "openai-codex/gpt-5.4")).toMatchObject({
      quotaPool: "openai-codex",
      billingMode: "subscription",
    });
    expect(resolveQuotaPool("omp", "qoder-cn/qwen3-coder")).toMatchObject({
      quotaPool: "qoder-cn",
      billingMode: "subscription",
    });
    expect(resolveQuotaPool("omp", "google-antigravity/gemini-2.5-pro")).toMatchObject({
      quotaPool: "google-antigravity",
      billingMode: "subscription",
    });
    expect(resolveQuotaPool("omp", "opencode-go/glm-5")).toMatchObject({
      quotaPool: "opencode-go",
      billingMode: "subscription",
    });
    expect(resolveQuotaPool("omp", "opencode/grok-code-free")).toMatchObject({
      quotaPool: "opencode-free",
      billingMode: "free",
    });
    expect(resolveQuotaPool("omp", "anthropic/claude-sonnet-4")).toMatchObject({
      quotaPool: "anthropic",
      billingMode: "api",
    });

    expect(resolveQuotaPool("codex", "gpt-5.4")).toMatchObject({
      quotaPool: "openai-codex",
      billingMode: "subscription",
    });
    expect(resolveQuotaPool("qodercn", "Qwen4-Max-Preview")).toMatchObject({
      quotaPool: "qoder-cn",
      billingMode: "subscription",
    });
    expect(resolveQuotaPool("agy", "gemini-2.5-pro")).toMatchObject({
      quotaPool: "google-antigravity",
      billingMode: "subscription",
    });
  });

  test("computes dual cost (API actual vs subscription equivalent) and honors billing/pricing overrides", () => {
    makeTempHub();
    updateHubObservability({
      traceRetentionDays: 45,
      billingOverrides: { "opencode-go": "api" },
      pricingOverrides: {
        "opencode-go::glm-5": { input: 10, output: 30, cacheRead: 1, contextWindow: 131_072 },
      },
    });
    const obs = readHubConfig().observability;
    expect(obs?.traceRetentionDays).toBe(45);

    const subPool = resolveQuotaPool("codex", "gpt-5.4", { billingOverrides: obs?.billingOverrides });
    const subSpec = resolveModelSpec("codex", "gpt-5.4", [], obs);
    const subCost = computeRunCost(
      {
        inputTokens: 100_000,
        uncachedInputTokens: 20_000,
        cacheReadTokens: 80_000,
        cacheWriteTokens: 0,
        outputTokens: 10_000,
        reasoningTokens: 0,
        totalTokens: 110_000,
      },
      subSpec,
      subPool.billingMode,
      subPool.quotaPool,
    );
    expect(subCost.apiCostUsd).toBe(0);
    expect(subCost.equivalentCostUsd).toBeGreaterThan(0);

    const overriddenPool = resolveQuotaPool("omp", "opencode-go/glm-5", { billingOverrides: obs?.billingOverrides });
    expect(overriddenPool).toMatchObject({ quotaPool: "opencode-go", billingMode: "api" });
    const overriddenSpec = resolveModelSpec("omp", "opencode-go/glm-5", [], obs);
    expect(overriddenSpec.contextWindow).toBe(131_072);
    expect(overriddenSpec.source).toBe("override");
  });

  test("aggregates ledger entries with filters, quota pool rollups (no omp bucket), P50/P95, heatmap, and diagnostics", () => {
    makeTempHub();
    const now = Date.now();
    const baseEntry = (idx: number, patch: Partial<RunLedgerEntry>): RunLedgerEntry => ({
      schemaVersion: 1,
      runId: `RUN-${idx}`,
      projectId: "proj-a",
      projectName: "Alpha",
      projectRoot: "/tmp/proj-a",
      nodeId: "local",
      nodeName: "devbox",
      requirementId: "REQ-001",
      requirementTitle: "Fix auth",
      action: "implement",
      harness: "omp",
      model: "opencode-go/glm-5",
      quotaPool: "opencode-go",
      billingMode: "subscription",
      status: "succeeded",
      dispatchReason: "route_primary",
      handoffMode: "first_run",
      startedAt: now - (idx + 1) * 60_000,
      endedAt: now - idx * 60_000,
      durationMs: 20_000,
      llmDurationMs: 5_000,
      toolDurationMs: 15_000,
      usage: {
        inputTokens: 10_000,
        uncachedInputTokens: 9_000,
        cacheReadTokens: 1_000,
        cacheWriteTokens: 0,
        outputTokens: 1_000,
        reasoningTokens: 0,
        totalTokens: 11_000,
      },
      apiCostUsd: 0,
      equivalentCostUsd: 0.25,
      costSource: "estimated",
      turnsCount: 2,
      toolCallsCount: 4,
      toolErrorCount: 0,
      compactionCount: 0,
      handoffTruncated: true,
      ...patch,
    });

    // 4 fix churn runs + rate limits + tool bottleneck + low cache + handoff truncation
    appendRunLedger(baseEntry(1, { action: "fix", durationMs: 30_000, toolDurationMs: 25_000, rateLimited: true }));
    appendRunLedger(baseEntry(2, { action: "fix", durationMs: 40_000, toolDurationMs: 30_000, rateLimited: true }));
    appendRunLedger(baseEntry(3, { action: "fix", durationMs: 50_000, toolDurationMs: 40_000 }));
    appendRunLedger(
      baseEntry(4, {
        projectId: "proj-b",
        projectName: "Beta",
        projectRoot: "/tmp/proj-b",
        requirementId: "REQ-002",
        harness: "omp",
        model: "anthropic/claude-sonnet-4",
        quotaPool: "anthropic",
        billingMode: "api",
        action: "review",
        apiCostUsd: 0.4,
        equivalentCostUsd: 0.4,
        durationMs: 10_000,
        toolDurationMs: 8_000,
        handoffTruncated: false,
      }),
    );

    expect(readRunLedger({ days: 7 }).length).toBe(4);
    expect(readRunLedger({ billingMode: "api" }).length).toBe(1);

    const insights = queryHubInsights({ days: 7 }, { cooldowns: {} });
    expect(insights.kpi.totalRuns).toBe(4);
    expect(insights.kpi.apiCostUsd).toBeCloseTo(0.4, 5);
    expect(insights.kpi.equivalentCostUsd).toBeCloseTo(1.15, 5);
    expect(insights.kpi.p50DurationMs).toBeGreaterThan(0);
    expect(insights.kpi.p95DurationMs).toBeGreaterThanOrEqual(insights.kpi.p50DurationMs);
    expect(insights.heatmap.length).toBe(84);

    // Quota pools strictly reflect underlying providers, never "omp"
    const poolIds = insights.byQuotaPool.map((p) => p.quotaPool);
    expect(poolIds).toContain("opencode-go");
    expect(poolIds).toContain("anthropic");
    expect(poolIds).not.toContain("omp");

    const diagKinds = insights.diagnostics.map((d) => d.kind);
    expect(diagKinds).toContain("fix_churn");
    expect(diagKinds).toContain("low_cache");
    expect(diagKinds).toContain("handoff_truncated");
    expect(diagKinds).toContain("rate_limited");
    expect(diagKinds).toContain("tool_bottleneck");

    const filteredPool = queryHubInsights({ days: 7, quotaPool: "opencode-go" }, { cooldowns: {} });
    expect(filteredPool.kpi.totalRuns).toBe(3);
  });

  test("infers token usage and cost from legacy codex and opencode raw logs", () => {
    const codexLog = [
      "$ codex exec --model gpt-6.1-sol",
      "Some work happened",
      "tokens used",
      "69,615",
    ].join("\n");
    const codexInferred = inferRunMetricsFromRawLog(codexLog);
    expect(codexInferred.usage?.totalTokens).toBe(69615);
    expect(codexInferred.estimated).toBe(true);

    const enrichedCodex = enrichAgentRunRecord(
      {
        id: "RUN-CODEX-1",
        action: "design",
        harness: "codex",
        model: "gpt-6.1-sol",
        status: "succeeded",
        startedAt: 1000,
        endedAt: 189133,
        exitCode: 0,
        durationMs: 188133,
        logPath: "runs/run-RUN-CODEX-1.log",
      },
      codexLog,
    );
    expect(enrichedCodex.quotaPool).toBe("openai-codex");
    expect(enrichedCodex.billingMode).toBe("subscription");
    expect(enrichedCodex.usage?.totalTokens).toBe(69615);
    expect(enrichedCodex.cost?.equivalentCostUsd).toBeGreaterThan(0);

    const opencodeLog = [
      "[workbench:agent] harness=opencode model=opencode-go/deepseek-v4.1-flash",
      "$ opencode run --standalone --model opencode-go/deepseek-v4.1-flash",
      "|  Read     package.json",
      "|  Grep     src/components",
      "Finished analyzing components and editing routes.",
    ].join("\n");
    const enrichedOpencode = enrichAgentRunRecord(
      {
        id: "RUN-OC-1",
        action: "implement",
        harness: "opencode",
        model: "opencode-go/deepseek-v4.1-flash",
        status: "running",
        startedAt: Date.now() - 10_000,
        endedAt: null,
        exitCode: null,
        durationMs: 0,
        logPath: "runs/run-RUN-OC-1.log",
      },
      opencodeLog,
    );
    expect(enrichedOpencode.quotaPool).toBe("opencode-go");
    expect(enrichedOpencode.toolCallsCount).toBe(2);
    expect(enrichedOpencode.turnsCount).toBe(3);
    expect(enrichedOpencode.usage?.totalTokens).toBeGreaterThan(0);
    expect(enrichedOpencode.cost?.equivalentCostUsd).toBeGreaterThan(0);
  });
});
