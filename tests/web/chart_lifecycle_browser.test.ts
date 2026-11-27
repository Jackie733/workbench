import { expect, test } from "bun:test";
import type { Browser } from "puppeteer-core";
import { resolveTestBrowser } from "./browser_env.ts";

const browserEnv = resolveTestBrowser();

const fixture = `
import React, { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Chart } from "chart.js";
import { ContextGrowthChart, DonutRingChart, StackedBarChart, StepPayloadChart } from "../../src/web/components/Charts.tsx";
import { useUiStore } from "../../src/web/stores/uiStore.ts";

const data = [{ key: "1", label: "#1", segments: [{ key: "read", label: "Read", value: 12, color: "var(--accent)" }] }];
const steps = [{ stepIndex: 1, label: "#1", tokens: 12, bytes: 24, linesCount: 1, category: "read", categoryLabel: "Read", color: "var(--accent)", summary: "Read file" }];
const segments = [{ key: "read", label: "Read", value: 12, color: "var(--accent)" }];
const turns = [{ turnIndex: 1, contextTokens: 300 }];
const nextTurns = [...turns, { turnIndex: 2, contextTokens: 400 }];
const compactions = [{ turnIndex: 2, mode: "manual", reclaimedTokens: 12 }];
const format = [(n) => n + " old", (n) => n + " new"];
const clicks = [];
const select = [(step) => clicks.push("old #" + step.stepIndex), (step) => clicks.push("new #" + step.stepIndex)];

window.runChartChecks = () => {
  const root = createRoot(document.getElementById("root"));
  const render = (centerLabel, version) => flushSync(() => root.render(
    <StrictMode>
      <StackedBarChart data={data} formatValue={format[version]} />
      <StepPayloadChart steps={steps} onSelectStep={select[version]} />
      <DonutRingChart segments={segments} centerLabel={centerLabel} />
      <ContextGrowthChart turns={version ? nextTurns : turns} contextWindow={1000} compactions={version ? compactions : undefined} />
    </StrictMode>,
  ));

  render("Initial label", 0);
  const canvases = [...document.querySelectorAll("canvas")];
  const charts = canvases.map((canvas) => Chart.getChart(canvas));
  const [bar, step, , line] = charts;
  const mounted = Object.keys(Chart.instances).length;
  const previousData = charts.map((chart) => chart.data);
  const tickBefore = bar.options.scales.y.ticks.callback(12);
  step.options.onClick(null, [{ index: 0 }], step);

  // This is a React rerender, but none of the config inputs changed.
  render("Updated label", 0);
  const skippedUnchanged = charts.every((chart, i) => Chart.getChart(canvases[i]) === chart && chart.data === previousData[i]);

  render("Updated label", 1);
  const retained = charts.every((chart, i) => Chart.getChart(canvases[i]) === chart);
  const tickAfter = bar.options.scales.y.ticks.callback(12);
  step.options.onClick(null, [{ index: 0 }], step);
  const labels = line.data.labels;

  const text = [];
  const fillText = line.ctx.fillText;
  line.ctx.fillText = function (label, ...args) {
    text.push(label);
    return fillText.call(this, label, ...args);
  };
  line.draw();
  line.ctx.fillText = fillText;

  document.documentElement.style.setProperty("--accent", "#123456");
  flushSync(() => useUiStore.getState().toggleTheme());
  const restyled = Chart.getChart(canvases[3]) === line && line.data.datasets[0].borderColor === "#123456";

  root.unmount();
  return { mounted, skippedUnchanged, retained, tickBefore, tickAfter, clicks, labels,
    compactionLabel: text.includes("Compact -12"), restyled, remaining: Object.keys(Chart.instances).length };
};
`;

test.skipIf(!browserEnv)("updates mounted charts and their callbacks without replacing instances", async () => {
  const entrypoint = `${import.meta.dir}/chart_fixture.tsx`;
  const { outputs: [bundle] } = await Bun.build({
    entrypoints: [entrypoint],
    files: { [entrypoint]: fixture },
    target: "browser",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  // The browser resolver may select a system-installed Puppeteer.
  const { default: puppeteer } = (await import(browserEnv!.puppeteerPath)) as {
    default: { launch(options: Record<string, unknown>): Promise<Browser> };
  };
  const browser = await puppeteer.launch({
    executablePath: browserEnv!.chromePath,
    headless: browserEnv!.headless,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<style>#root { width: 480px; } .chart-canvas-box { position: relative; }</style><div id="root"></div>');
    await page.addScriptTag({ type: "module", content: await bundle!.text() });
    await page.waitForFunction('typeof window.runChartChecks === "function"', { timeout: 3000 });
    const result = await page.evaluate(() => {
      if (!("runChartChecks" in window) || typeof window.runChartChecks !== "function") {
        throw new Error("Chart test fixture did not initialize");
      }
      return window.runChartChecks();
    });
    expect(result).toEqual({
      mounted: 4,
      skippedUnchanged: true,
      retained: true,
      tickBefore: "12 old",
      tickAfter: "12 new",
      clicks: ["old #1", "new #1"],
      labels: ["#1", "#2"],
      compactionLabel: true,
      restyled: true,
      remaining: 0,
    });
  } finally {
    await browser.close();
  }
}, 15_000);
