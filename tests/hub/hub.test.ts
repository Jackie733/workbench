import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getDaemonStatus, startDaemon, stopDaemon } from "../../src/cli/daemon.ts";
import { approveDesign, createRequirement, getRequirement, initProject, propose, updateDesign } from "../../src/core/engine.ts";
import { runVerification } from "../../src/core/runner.ts";
import { classifyTier, discoverHarnesses } from "../../src/hub/discovery.ts";
import { buildHarnessCommand, HubExecutor, resolveRunTimeouts } from "../../src/hub/executor.ts";
import { synthesizeHandoffPacket } from "../../src/hub/handoff.ts";
import {
  applyHubRoutingPreset,
  browseDirectory,
  isAutoRegistrableProjectRoot,
  readHubConfig,
  registerHubProject,
  removeHubProject,
  setActiveHubProject,
} from "../../src/hub/registry.ts";
import { buildPresetRouting, detectRateLimitOrQuotaError, resolveRouteCandidates } from "../../src/hub/routing.ts";
import { clearModelCooldown, isModelCoolingDown, recordModelRunOutcome } from "../../src/hub/telemetry.ts";
import type { HarnessInfo, ModelTarget } from "../../src/hub/types.ts";
import type { AgentAction } from "../../src/core/types.ts";
import { getModelEffortCapability } from "../../src/web/state.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";

const tempDirs: string[] = [];
const servers: WorkbenchServerHandle[] = [];
const origHubEnv = process.env.WORKBENCH_HUB_DIR;

function makeTempHub(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-hub-test-"));
  tempDirs.push(dir);
  process.env.WORKBENCH_HUB_DIR = dir;
  return dir;
}

function makeGitRepo(name = "repo"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wb-${name}-`));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "app.ts"), "export const v = 1;\n");
  execFileSync("git", ["add", "app.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

afterEach(async () => {
  while (servers.length > 0) {
    servers.pop()!.stop();
  }
  await stopDaemon().catch(() => {});
  if (origHubEnv === undefined) delete process.env.WORKBENCH_HUB_DIR;
  else process.env.WORKBENCH_HUB_DIR = origHubEnv;
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("WB-08 multi-project hub registry and daemon", () => {
  test("manages multi-project registry, safe directory browsing, and isolated project API routing", async () => {
    makeTempHub();
    const repoA = makeGitRepo("alpha");
    const repoB = makeGitRepo("beta");
    await initProject(repoA, { name: "Alpha", privacyMode: "local" });
    await initProject(repoB, { name: "Beta", privacyMode: "local" });

    const { project: pA } = registerHubProject(repoA);
    const { project: pB } = registerHubProject(repoB);
    expect(readHubConfig().projects.length).toBe(2);
    expect(readHubConfig().activeProjectId).toBe(pB.id);

    setActiveHubProject(pA.id);
    expect(readHubConfig().activeProjectId).toBe(pA.id);

    const browse = browseDirectory(path.dirname(repoA));
    const entryA = browse.entries.find((e) => e.path === fs.realpathSync(repoA));
    expect(entryA?.isGitRepo).toBe(true);
    expect(entryA?.workbenchInitialized).toBe(true);

    const server = await startWorkbenchServer({ root: repoA, port: 0, writeDiscovery: false, hubMode: true });
    servers.push(server);

    await createRequirement(repoA, { goal: "Alpha only task" });
    await createRequirement(repoB, { goal: "Beta only task" });

    const listA = (await (await fetch(`${server.url}/api/requirements?project=${pA.id}`)).json()) as {
      items: Array<{ title: string }>;
    };
    const listB = (await (await fetch(`${server.url}/api/requirements?project=${pB.id}`)).json()) as {
      items: Array<{ title: string }>;
    };
    expect(listA.items.map((i) => i.title)).toEqual(["Alpha only task"]);
    expect(listB.items.map((i) => i.title)).toEqual(["Beta only task"]);

    removeHubProject(pB.id);
    expect(readHubConfig().projects.length).toBe(1);
  });

  test("starts, queries status, and stops background hub daemon cleanly", async () => {
    makeTempHub();
    const repo = makeGitRepo("daemon");
    const port = 24000 + Math.floor(Math.random() * 10000);

    const started = await startDaemon({ port, registerRoot: repo });
    expect(started.started).toBe(true);
    expect(started.info.port).toBe(port);

    const status = await getDaemonStatus();
    expect(status.running).toBe(true);
    expect(status.info?.pid).toBe(started.info.pid);
    expect(status.projectsCount).toBe(1);

    const stopped = await stopDaemon();
    expect(stopped.stopped).toBe(true);
    const afterStop = await getDaemonStatus();
    expect(afterStop.running).toBe(false);
  });

  test("does not expose defaultRoot or user home directory in hub state unless manually added", async () => {
    makeTempHub();
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "wb-fake-home-"));
    tempDirs.push(fakeHome);
    // Even if HOME happens to contain .git, Hub startup must not auto-register it.
    execFileSync("git", ["init"], { cwd: fakeHome, stdio: "ignore" });
    const origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      expect(isAutoRegistrableProjectRoot(fakeHome)).toBe(false);
      const server = await startWorkbenchServer({ root: fakeHome, port: 0, writeDiscovery: false, hubMode: true });
      servers.push(server);

      const state1 = (await (await fetch(`${server.url}/api/hub/state`)).json()) as {
        hubMode: boolean;
        activeProjectId: string | null;
        projects: Array<{ id: string; root: string }>;
      };
      expect(state1.hubMode).toBe(true);
      expect(state1.activeProjectId).toBeNull();
      expect(state1.projects).toEqual([]);

      const projResp = await fetch(`${server.url}/api/project`);
      expect(projResp.status).toBe(404);

      // Manually adding HOME via API IS allowed and displays it in projects.
      const addResp = await fetch(`${server.url}/api/hub/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: fakeHome }),
      });
      expect(addResp.status).toBe(201);
      const added = (await addResp.json()) as {
        project: { id: string; root: string };
        activeProjectId: string | null;
        projects: Array<{ id: string; root: string }>;
      };
      expect(added.projects.length).toBe(1);
      expect(added.projects[0]?.root).toBe(fs.realpathSync(fakeHome));
      expect(added.activeProjectId).toBe(added.project.id);

      // Removing the last project returns empty projects instead of falling back to defaultRoot.
      const delResp = await fetch(`${server.url}/api/hub/projects/${encodeURIComponent(added.project.id)}`, {
        method: "DELETE",
      });
      expect(delResp.status).toBe(200);
      const afterDel = (await delResp.json()) as {
        activeProjectId: string | null;
        projects: Array<{ id: string; root: string }>;
      };
      expect(afterDel.activeProjectId).toBeNull();
      expect(afterDel.projects).toEqual([]);
    } finally {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
    }
  });
});

describe("WB-09 harness discovery and stage-based model routing", () => {
  test("discovers harnesses cleanly with graceful fallbacks", async () => {
    const fakeHome = makeTempHub();
    fs.mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, ".codex/models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: "gpt-6-astra",
            display_name: "GPT-6 Astra",
            default_reasoning_level: "low",
            supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }],
          },
          { slug: "codex-auto-review" },
        ],
      }),
    );
    fs.writeFileSync(path.join(fakeHome, ".codex/config.toml"), 'model = "gpt-6-astra"\n');

    // Create mock ~/.omp/agent/agent.db and models.db for multi-provider OMP discovery
    const ompDir = path.join(fakeHome, ".omp/agent");
    fs.mkdirSync(ompDir, { recursive: true });
    const agentDb = new Database(path.join(ompDir, "agent.db"));
    agentDb.exec("CREATE TABLE auth_credentials (provider TEXT, disabled_cause TEXT)");
    agentDb.exec("INSERT INTO auth_credentials VALUES ('opencode-go', NULL), ('qoder-cn', NULL)");
    agentDb.exec("CREATE TABLE model_usage (model_key TEXT, last_used_at INTEGER)");
    agentDb.exec("INSERT INTO model_usage VALUES ('qoder-cn/DeepSeek-Flash', 100)");
    agentDb.exec("CREATE TABLE model_perf (model_key TEXT, updated_at INTEGER)");
    agentDb.exec("INSERT INTO model_perf VALUES ('openai-codex/gpt-6.1-sol', 200)");
    agentDb.close();

    const modelsDb = new Database(path.join(ompDir, "models.db"));
    modelsDb.exec("CREATE TABLE model_cache (provider_id TEXT, updated_at INTEGER, models TEXT)");
    modelsDb.exec(
      `INSERT INTO model_cache VALUES ('opencode-go:v3', 100, '${JSON.stringify([{ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" }])}')`,
    );
    modelsDb.close();

    const harnesses = await discoverHarnesses({
      homeDir: fakeHome,
      which: (cmd) => (cmd === "codex" || cmd === "opencode" || cmd === "agy" || cmd === "omp" ? `/usr/bin/${cmd}` : null),
      runCmd: async (cmd) => {
        if (cmd.includes("opencode")) {
          return { code: 0, stdout: "opencode/deepseek-v4.1-flash-free\nopencode/glm-5.3-flash-free\n" };
        }
        if (cmd.includes("agy")) {
          return {
            code: 0,
            stdout: "\r⠋ Fetching available models...\ngemini-4-hydrogen-xhigh         Gemini 4 Hydrogen (XHigh)\ngemini-4-argon-medium           Gemini 4 Argon (Medium)\n",
          };
        }
        return { code: 1, stdout: "" };
      },
    });

    const codex = harnesses.find((h) => h.id === "codex")!;
    const qoder = harnesses.find((h) => h.id === "qodercn")!;
    const oc = harnesses.find((h) => h.id === "opencode")!;
    const agy = harnesses.find((h) => h.id === "agy")!;
    const omp = harnesses.find((h) => h.id === "omp")!;
    expect(codex.installed).toBe(true);
    expect(codex.defaultModel).toBe("gpt-6-astra");
    expect(codex.models[0]?.supportedEfforts).toContain("xhigh");
    expect(qoder.installed).toBe(false);
    expect(qoder.models.some((m) => m.id === "DeepSeek-Flash")).toBe(true);
    expect(oc.models.some((m) => m.id === "opencode/deepseek-v4.1-flash-free")).toBe(true);
    expect(oc.models.some((m) => m.id === "opencode-go/deepseek-v4.1-flash")).toBe(false);
    expect(agy.installed).toBe(true);
    expect(agy.models.some((m) => m.id === "gemini-4-hydrogen-xhigh")).toBe(true);
    expect(omp.installed).toBe(true);
    expect(omp.models.some((m) => m.id === "qoder-cn/DeepSeek-Flash")).toBe(true);
    expect(omp.models.some((m) => m.id === "opencode-go/deepseek-v4.1-flash")).toBe(true);
  });

  test("applies presets, routing overrides, and rate-limit detection", () => {
    makeTempHub();
    const sota = buildPresetRouting("sota_first");
    expect(sota.stages.design.primary.model).toBe("gpt-6.2-astra");
    expect(sota.stages.review.primary.harness).toBe("agy");

    const cfg = applyHubRoutingPreset("quota_saver");
    expect(cfg.routing.activePreset).toBe("quota_saver");

    const candidates = resolveRouteCandidates(cfg.routing, null, "implement", {
      harness: "qodercn",
      model: "DeepSeek-V4-Pro",
    });
    expect(candidates[0]).toEqual({ harness: "qodercn", model: "DeepSeek-V4-Pro" });
    expect(detectRateLimitOrQuotaError("HTTP 429 Too Many Requests: quota exceeded", 1)).toBe(true);
    expect(detectRateLimitOrQuotaError("all tests passed", 0)).toBe(false);
  });

  test("accurately classifies model tiers, aggregates AGY effort variants, and dynamically adapts presets", async () => {
    const fakeHome = makeTempHub();
    // 1. Word-boundary tier classification fixes preview/minimax/intelligence misclassifications
    expect(classifyTier("Qwen4-Max-Preview")).toBe("sota");
    expect(classifyTier("Step-5-Preview")).toBe("balanced");
    expect(classifyTier("Kimi-K2.8-Preview")).toBe("balanced");
    expect(classifyTier("codex-auto-review")).toBe("review");
    expect(classifyTier("opencode-go/minimax-m3", { intelligence: 18.9 })).toBe("fast");
    expect(classifyTier("DeepSeek-V4-Pro", { intelligence: 23.1 })).toBe("balanced");
    expect(classifyTier("gpt-6.2-astra")).toBe("sota");

    // 2. AGY variant aggregation + single-variant lock + fixed-policy unsupported effort
    const harnesses = await discoverHarnesses({
      homeDir: fakeHome,
      hubDir: null,
      which: (cmd) => (cmd === "agy" || cmd === "qodercn" || cmd === "codex" ? `/usr/bin/${cmd}` : null),
      runCmd: async (cmd) => {
        if (cmd.includes("agy")) {
          return {
            code: 0,
            stdout: [
              "gemini-4-hydrogen-low           Gemini 4 Hydrogen (Low)",
              "gemini-4-hydrogen-medium        Gemini 4 Hydrogen (Medium)",
              "gemini-4-hydrogen-high          Gemini 4 Hydrogen (High)",
              "gemini-4-hydrogen-xhigh         Gemini 4 Hydrogen (XHigh)",
              "gemini-pro-orchestrator-g1-pro  Orchestrator (Argon)",
              "gpt-oss-120b-medium             GPT-OSS 120B (Medium)",
            ].join("\n"),
          };
        }
        if (cmd.includes("qodercn")) {
          return { code: 0, stdout: "MODEL\nAuto\nFast\nQwen4-Max\n" };
        }
        return { code: 1, stdout: "" };
      },
    });

    const agy = harnesses.find((h) => h.id === "agy")!;
    const hydrogen = agy.models.find((m) => m.id === "gemini-4-hydrogen")!;
    expect(hydrogen).toBeDefined();
    expect(hydrogen.supportedEfforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(hydrogen.effortVariants).toEqual({
      low: "gemini-4-hydrogen-low",
      medium: "gemini-4-hydrogen-medium",
      high: "gemini-4-hydrogen-high",
      xhigh: "gemini-4-hydrogen-xhigh",
    });

    const orch = agy.models.find((m) => m.id === "gemini-pro-orchestrator-g1-pro")!;
    expect(orch.supportedEfforts).toEqual([]);

    const oss = agy.models.find((m) => m.id === "gpt-oss-120b-medium")!;
    expect(oss.effortLocked).toBe(true);
    expect(oss.supportedEfforts).toEqual(["medium"]);

    const qoder = harnesses.find((h) => h.id === "qodercn")!;
    expect(qoder.models.find((m) => m.id === "Auto")?.supportedEfforts).toEqual([]);

    // 3. Three-state UI capability helper
    expect(getModelEffortCapability(harnesses, "agy", "gemini-4-hydrogen")).toEqual({
      mode: "configurable",
      efforts: ["low", "medium", "high", "xhigh"],
      defaultEffort: "high",
    });
    expect(getModelEffortCapability(harnesses, "agy", "gemini-4-hydrogen-high")).toEqual({
      mode: "locked",
      efforts: ["high"],
      defaultEffort: "high",
    });
    expect(getModelEffortCapability(harnesses, "agy", "gpt-oss-120b-medium")).toEqual({
      mode: "locked",
      efforts: ["medium"],
      defaultEffort: "medium",
    });
    expect(getModelEffortCapability(harnesses, "agy", "gemini-pro-orchestrator-g1-pro")).toEqual({
      mode: "unsupported",
      efforts: [],
    });
    expect(getModelEffortCapability(harnesses, "qodercn", "Auto")).toEqual({
      mode: "unsupported",
      efforts: [],
    });

    // 4. buildHarnessCommand resolves aggregated AGY family + effort -> real variant ID, and strips invalid efforts
    const agyAggCmd = buildHarnessCommand(
      { harness: "agy", model: "gemini-4-hydrogen", reasoningEffort: "xhigh" },
      { root: "/repo", action: "design", prompt: "design", harnesses },
    );
    expect(agyAggCmd.args).toContain("gemini-4-hydrogen-xhigh");
    expect(agyAggCmd.args).toContain("xhigh");

    const agyOrchCmd = buildHarnessCommand(
      { harness: "agy", model: "gemini-pro-orchestrator-g1-pro", reasoningEffort: "high" },
      { root: "/repo", action: "design", prompt: "design", harnesses },
    );
    expect(agyOrchCmd.args).not.toContain("--effort");

    const agyLockedCmd = buildHarnessCommand(
      { harness: "agy", model: "gpt-oss-120b-medium", reasoningEffort: "high" },
      { root: "/repo", action: "design", prompt: "design", harnesses },
    );
    expect(agyLockedCmd.args).toContain("--effort");
    expect(agyLockedCmd.args[agyLockedCmd.args.indexOf("--effort") + 1]).toBe("medium");

    // 5. Dynamic preset adapts when vendor ships newer generation models and remaps retired models
    const upgradedHarnesses: HarnessInfo[] = [
      {
        id: "codex",
        label: "Codex CLI",
        subscription: "Plus",
        installed: true,
        executable: "codex",
        models: [
          { id: "gpt-6.1-sol", tier: "sota", source: "detected", isLegacy: true, supportedEfforts: ["low", "medium", "high"] },
          { id: "gpt-7.0-astra", tier: "sota", source: "detected", priority: 1, supportedEfforts: ["low", "medium", "high", "xhigh"] },
        ],
        defaultModel: "gpt-7.0-astra",
        detectedAt: Date.now(),
      },
      agy,
    ];
    const dynamicSota = buildPresetRouting("sota_first", upgradedHarnesses);
    expect(dynamicSota.stages.design.primary.model).toBe("gpt-7.0-astra");

    const legacyRouting = buildPresetRouting("sota_first");
    legacyRouting.stages.design.primary = { harness: "agy", model: "gemini-4-hydrogen-high", reasoningEffort: "high" };
    const normalizedResolved = resolveRouteCandidates(legacyRouting, upgradedHarnesses, "design");
    expect(normalizedResolved[0]).toEqual({ harness: "agy", model: "gemini-4-hydrogen", reasoningEffort: "high" });
  });
});

describe("WB-10 active executor, two-tier handoff, co-design discussions, and cross-review", () => {
  test("executes ask/review/fallback/cancel flows and preserves git ground truth in handoff.md", async () => {
    makeTempHub();
    const repo = makeGitRepo("exec");
    await initProject(repo, { name: "ExecRepo", privacyMode: "local" });
    registerHubProject(repo);
    await createRequirement(repo, {
      goal: "Add subtraction helper",
      criteria: [{ id: "AC-1", description: "passes echo check", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", {
      designMarkdown: "# Design\nAdd `sub(a, b)`.",
      handoffNote: {
        keyDecisions: ["Keep pure helper in app.ts"],
        deadEnds: ["Do not rewrite git.ts"],
        nextSteps: ["Implement sub helper"],
      },
      actor: "agent",
    });
    await approveDesign(repo, "REQ-001");
    await runVerification(repo, "REQ-001", { command: "echo ok", criterionIds: ["AC-1"] });

    // Edit file cleanly so handoff captures dirty state + stale state
    fs.writeFileSync(path.join(repo, "app.ts"), "export const v = 2;\nexport const sub = (a: number, b: number) => a - b;\n");
    await updateDesign(repo, "REQ-001", { designMarkdown: "# Design v2\nUpdated by human.", actor: "human" });
    await approveDesign(repo, "REQ-001");

    const seenCommands: string[] = [];
    const seenPrompts: string[] = [];
    const executor = new HubExecutor({
      initialHarnesses: [
        { id: "codex", label: "Codex", subscription: "Plus", installed: true, executable: "codex", models: [], defaultModel: "gpt-6-astra", detectedAt: Date.now() },
        { id: "qodercn", label: "QoderCN", subscription: "Qoder", installed: true, executable: "qodercn", models: [], defaultModel: "Qwen4-Max", detectedAt: Date.now() },
        { id: "opencode", label: "OpenCode", subscription: "Go", installed: true, executable: "opencode", models: [], defaultModel: "opencode/deepseek-v4.1-flash-free", detectedAt: Date.now() },
      ],
      commandBuilder: (target, ctx) => {
        seenCommands.push(`${target.harness}:${target.model}:${ctx.nativeSessionId ?? "none"}`);
        seenPrompts.push(ctx.prompt);
        if (ctx.action === "ask") {
          return {
            command: "bash",
            args: ["-c", "echo 'session_id: sess-abc123\n使用文件锁可以避免跨进程竞态写入。'"],
            displayCommand: "mock-ask",
          };
        }
        if (ctx.action === "review") {
          return {
            command: "bash",
            args: [
              "-c",
              `cat <<'EOF'\n检查完毕，Diff 清晰安全。\n\`\`\`json\n{"verdict":"pass","summary":"实现与方案一致，逻辑安全"}\n\`\`\`\nEOF`,
            ],
            displayCommand: "mock-review",
          };
        }
        if (target.model === "rate-limit-me") {
          return {
            command: "bash",
            args: ["-c", "echo '429 quota exceeded' >&2; exit 1"],
            displayCommand: "mock-rate-limit",
          };
        }
        if (ctx.action === "fix") {
          return {
            command: "bash",
            args: ["-c", "exec sleep 5"],
            displayCommand: "mock-long-sleep",
          };
        }
        return {
          command: "bash",
          args: ["-c", "echo 'fallback ok'"],
          displayCommand: "mock-ok",
        };
      },
    });

    const events: string[] = [];
    const finishedWaiters = new Map<string, Array<() => void>>();
    executor.subscribe((ev) => {
      events.push(ev.type);
      if (ev.type === "agent.run.finished") {
        const list = finishedWaiters.get(ev.runId) ?? [];
        finishedWaiters.delete(ev.runId);
        for (const fn of list) fn();
      }
    });
    const waitForRunFinished = (runId: string) =>
      new Promise<void>((resolve) => {
        const list = finishedWaiters.get(runId) ?? [];
        list.push(resolve);
        finishedWaiters.set(runId, list);
      });

    // 1. Ask mode: read-only consultation, preserves stage & approval, records answer + nativeSessionId
    const askStart = await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "ask",
      harness: "codex",
      model: "gpt-6-astra",
      message: "为什么要用文件锁？",
      anchor: "design.md#架构",
    });
    await waitForRunFinished(askStart.run.id);
    const afterAsk = getRequirement(repo, "REQ-001");
    expect(afterAsk.state.stage).toBe("implementing");
    expect(afterAsk.validity.approval.valid).toBe(true);
    expect(afterAsk.state.discussions?.length).toBe(2);
    expect(afterAsk.state.discussions?.[1]?.actor).toBe("agent");
    expect(afterAsk.state.discussions?.[1]?.message).toContain("避免跨进程竞态写入");
    expect(afterAsk.state.agentRuns?.[0]?.nativeSessionId).toBe("sess-abc123");
    expect(events).toContain("agent.run.started");
    expect(events).toContain("agent.run.finished");

    // 2. Same-harness continuation reuses nativeSessionId AND uses compact resume prompt!
    const run2 = await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "implement",
      harness: "codex",
      model: "gpt-6-astra",
    });
    await waitForRunFinished(run2.run.id);
    expect(seenCommands[1]).toBe("codex:gpt-6-astra:sess-abc123");
    expect(seenPrompts[1]).toContain("同会话原生续接");
    expect(seenPrompts[1]).not.toContain("Do not rewrite git.ts");

    // 3. Rate limit detection + fallback retry switches cleanly and injects handoff.md
    const rlRun = await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "implement",
      harness: "qodercn",
      model: "rate-limit-me",
    });
    await waitForRunFinished(rlRun.run.id);
    const afterRl = getRequirement(repo, "REQ-001");
    const lastRun = afterRl.state.agentRuns?.slice(-1)[0];
    expect(lastRun?.status).toBe("failed");
    expect(lastRun?.rateLimited).toBe(true);
    expect(afterRl.handoffMarkdown).toContain("Do not rewrite git.ts");
    expect(afterRl.handoffMarkdown).toContain("app.ts");

    const fbRun = await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "implement",
      useFallback: true,
    });
    await waitForRunFinished(fbRun.run.id);
    // Fallback did not pick rate-limit-me and saw cross-harness handoff!
    expect(seenPrompts.slice(-1)[0]).toContain("已证实走不通的死胡同");

    // 4. Cross-model review records verdict & goes stale on subsequent code edit
    const revRun = await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "review",
      harness: "codex",
      model: "codex-auto-review",
    });
    await waitForRunFinished(revRun.run.id);
    const afterReview = getRequirement(repo, "REQ-001", {
      currentCodeSnapshotHash: (await synthesizeHandoffPacket(repo, "REQ-001", { action: "review" })).detail.state.reviewReport?.reviewedCodeSnapshotHash ?? null,
    });
    expect(afterReview.state.reviewReport?.verdict).toBe("pass");
    expect(afterReview.validity.reviewValidity.effectiveState).toBe("current");

    fs.writeFileSync(path.join(repo, "app.ts"), "export const v = 3;\n");
    const { detail: staleReviewDetail } = await synthesizeHandoffPacket(repo, "REQ-001", { action: "review" });
    expect(staleReviewDetail.validity.reviewValidity.effectiveState).toBe("stale");

    // 5. Cancel running job kills process group cleanly
    const longRun = await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "fix",
      harness: "opencode",
      model: "opencode/deepseek-v4.1-flash-free",
    });
    const longDone = waitForRunFinished(longRun.run.id);
    await new Promise((r) => setTimeout(r, 80));
    expect(executor.cancelRun(longRun.run.id)).toBe(true);
    await longDone;
    const afterCancel = getRequirement(repo, "REQ-001");
    const cancelledObj = afterCancel.state.agentRuns?.find((r) => r.id === longRun.run.id);
    expect(cancelledObj?.status).toBe("cancelled");
  }, { timeout: 15000 });

  test("builds valid codex/qodercn CLI flags and parses qodercn stream-json cleanly", async () => {
    makeTempHub();
    const repo = makeGitRepo("stream-repo");
    await initProject(repo, { name: "StreamRepo", privacyMode: "local" });
    await createRequirement(repo, {
      goal: "测试模型命令与流式解析",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });

    const codexExec = buildHarnessCommand(
      { harness: "codex", model: "gpt-6-luna", reasoningEffort: "medium" },
      { root: repo, action: "implement", prompt: "do work", harnesses: [] },
    );
    expect(codexExec.args).not.toContain("--full-auto");
    expect(codexExec.args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(codexExec.args).toContain("-m");
    expect(codexExec.args).toContain("gpt-6-luna");

    const codexRead = buildHarnessCommand(
      { harness: "codex", model: "codex-auto-review" },
      { root: repo, action: "review", prompt: "review", harnesses: [] },
    );
    expect(codexRead.args).toContain("-s");
    expect(codexRead.args).toContain("read-only");

    const codexResume = buildHarnessCommand(
      { harness: "codex", model: "gpt-6.1-sol", reasoningEffort: "medium" },
      { root: repo, action: "implement", prompt: "continue", nativeSessionId: "sess-codex-1", harnesses: [] },
    );
    expect(codexResume.args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(codexResume.args).toContain("-m");
    expect(codexResume.args).toContain("gpt-6.1-sol");
    expect(codexResume.args).toContain('model_reasoning_effort="medium"');
    expect(codexResume.args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(codexResume.args).toContain("sess-codex-1");

    const codexAskResume = buildHarnessCommand(
      { harness: "codex", model: "gpt-6.1-sol", reasoningEffort: "low" },
      { root: repo, action: "ask", prompt: "why?", nativeSessionId: "sess-codex-1", harnesses: [] },
    );
    expect(codexAskResume.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(codexAskResume.args).toContain('sandbox_mode="read-only"');

    const qoderCmd = buildHarnessCommand(
      { harness: "qodercn", model: "Qwen3.8-Flash", reasoningEffort: "high" },
      { root: repo, action: "ask", prompt: "explain", harnesses: [] },
    );
    expect(qoderCmd.args).toContain("-o");
    expect(qoderCmd.args).toContain("stream-json");
    expect(qoderCmd.args).toContain("--permission-mode");
    expect(qoderCmd.args).toContain("auto");
    expect(qoderCmd.args).toContain("--reasoning-effort");
    expect(qoderCmd.args).toContain("high");
    expect(qoderCmd.args).toContain("-p");

    const qoderImplResume = buildHarnessCommand(
      { harness: "qodercn", model: "Qwen4-Max" },
      { root: repo, action: "implement", prompt: "go", nativeSessionId: "q-sess-1", harnesses: [] },
    );
    expect(qoderImplResume.args).toContain("--dangerously-skip-permissions");
    expect(qoderImplResume.args).not.toContain("--permission-mode");
    expect(qoderImplResume.args).toContain("-r");
    expect(qoderImplResume.args).toContain("q-sess-1");

    const opencodeCmd = buildHarnessCommand(
      { harness: "opencode", model: "opencode-go/deepseek-v4.1-flash", reasoningEffort: "medium" },
      { root: repo, action: "implement", prompt: "do", harnesses: [] },
    );
    expect(opencodeCmd.args).toContain("--standalone");
    expect(opencodeCmd.args).toContain("--auto");
    expect(opencodeCmd.args).toContain("opencode-go/deepseek-v4.1-flash");

    const agyCmd = buildHarnessCommand(
      { harness: "agy", model: "gemini-4-hydrogen-high", reasoningEffort: "xhigh" },
      { root: repo, action: "review", prompt: "review", harnesses: [] },
    );
    expect(agyCmd.args).toContain("--mode");
    expect(agyCmd.args).toContain("plan");
    expect(agyCmd.args).toContain("--model");
    expect(agyCmd.args).toContain("gemini-4-hydrogen-high");
    expect(agyCmd.args).toContain("--effort");
    expect(agyCmd.args).toContain("xhigh");

    const ompCmd = buildHarnessCommand(
      { harness: "omp", model: "opencode-go/deepseek-v4.1-flash", reasoningEffort: "max" },
      { root: repo, action: "implement", prompt: "do", harnesses: [] },
    );
    expect(ompCmd.args).toContain("--model=opencode-go/deepseek-v4.1-flash");
    expect(ompCmd.args).toContain("--thinking=max");

    const streamChunks: string[] = [];
    const executor = new HubExecutor({
      initialHarnesses: [
        {
          id: "qodercn",
          label: "QoderCN",
          subscription: "QoderCN",
          installed: true,
          executable: "qodercn",
          models: [{ id: "Qwen3.8-Flash", tier: "fast", source: "detected" }],
          defaultModel: "Qwen3.8-Flash",
          detectedAt: Date.now(),
        },
      ],
      commandBuilder: () => ({
        command: "bash",
        args: [
          "-c",
          `printf '%s\n' 'Model "DeepSeek-Flash" is not available right now; using "auto" instead.'
           printf '%s\n' '{"type":"system","subtype":"init","model":"qfmodel","session_id":"q-sess-999"}'
           printf '%s\n' '{"type":"assistant","session_id":"q-sess-999","message":{"content":[{"type":"thinking","thinking":"Inspecting code"}]}}'
           printf '%s\n' '{"type":"assistant","session_id":"q-sess-999","message":{"content":[{"type":"text","text":"建议使用原子锁避免并发写入。"}]}}'
           printf '%s\n' '{"type":"result","subtype":"success","duration_ms":1200,"result":"建议使用原子锁避免并发写入。","session_id":"q-sess-999"}'`,
        ],
        displayCommand: "qoder-stream-mock",
      }),
    });
    executor.subscribe((ev) => {
      if (ev.type === "agent.run.output" && ev.chunk) streamChunks.push(ev.chunk);
    });

    await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "ask",
      harness: "qodercn",
      model: "Qwen3.8-Flash",
      message: "为什么要用锁？",
    });
    await new Promise((r) => setTimeout(r, 300));

    const combinedStream = streamChunks.join("");
    expect(combinedStream).toContain("⚡ Qoder 引擎已就绪");
    expect(combinedStream).toContain("💭 Inspecting code");
    expect(combinedStream).not.toContain("not available right now");

    const detail = getRequirement(repo, "REQ-001");
    expect(detail.state.agentRuns?.[0]?.nativeSessionId).toBe("q-sess-999");
    expect(detail.state.discussions?.slice(-1)[0]?.message).toBe("建议使用原子锁避免并发写入。");
  });

  test("passes the Hub process environment, including proxy variables, to agent CLI children", async () => {
    makeTempHub();
    const repo = makeGitRepo("env-repo");
    await initProject(repo, { name: "EnvRepo", privacyMode: "local" });
    await createRequirement(repo, {
      goal: "测试代理环境透传",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    const proxy = "http://127.0.0.1:20890";
    // Bun's process.env does not enumerate keys added at runtime, so replace it as a process
    // startup would. This mirrors a Hub launched by systemd/launchd with proxy variables set.
    const originalEnv = process.env;
    process.env = { ...process.env, HTTPS_PROXY: proxy };
    try {
      const executor = new HubExecutor({
        initialHarnesses: [
          { id: "codex", label: "Codex", subscription: "Plus", installed: true, executable: "codex", models: [], defaultModel: "gpt-6-astra", detectedAt: Date.now() },
        ],
        commandBuilder: () => ({
          command: "bash",
          args: ["-c", 'printf %s "$HTTPS_PROXY"'],
          displayCommand: "proxy-env-echo",
        }),
      });
      let finishRun!: () => void;
      const finished = new Promise<void>((resolve) => { finishRun = resolve; });
      const seenChunks: string[] = [];
      executor.subscribe((ev) => {
        if (ev.type === "agent.run.output") seenChunks.push(ev.chunk ?? "");
        if (ev.type === "agent.run.finished") finishRun();
      });
      const started = await executor.startRun({
        root: repo,
        requirementId: "REQ-001",
        action: "ask",
        harness: "codex",
        model: "gpt-6-astra",
        message: "当前代理是什么？",
      });
      await finished;
      expect(seenChunks.join("")).toBe(proxy);
      expect(executor.getLiveLog(started.run.id)).toContain(proxy);
      expect(getRequirement(repo, "REQ-001").state.discussions?.slice(-1)[0]?.message).toBe(proxy);
    } finally {
      process.env = originalEnv;
    }
  }, { timeout: 15000 });

  test("uses sliding inactivity watchdog and action-tiered ceilings instead of fixed 600s hard timeout", async () => {
    expect(resolveRunTimeouts("ask")).toEqual({ idleTimeoutMs: 5 * 60_000, maxDurationMs: 20 * 60_000 });
    expect(resolveRunTimeouts("design")).toEqual({ idleTimeoutMs: 10 * 60_000, maxDurationMs: 60 * 60_000 });
    expect(resolveRunTimeouts("implement")).toEqual({ idleTimeoutMs: 15 * 60_000, maxDurationMs: 2 * 60 * 60_000 });
    expect(resolveRunTimeouts("implement", { timeoutMs: 120 })).toEqual({ idleTimeoutMs: 120, maxDurationMs: 120 });

    makeTempHub();
    const repo = makeGitRepo("watchdog-repo");
    await initProject(repo, { name: "WatchdogRepo", privacyMode: "local" });
    await createRequirement(repo, {
      goal: "Verify sliding inactivity watchdog",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design", actor: "agent" });
    await approveDesign(repo, "REQ-001");

    let mode: "heartbeat" | "stall" | "ceiling" = "heartbeat";
    const executor = new HubExecutor({
      initialHarnesses: [
        { id: "qodercn", label: "QoderCN", subscription: "Qoder", installed: true, executable: "qodercn", models: [], defaultModel: "Qwen4-Max", detectedAt: Date.now() },
      ],
      commandBuilder: () => {
        if (mode === "heartbeat") {
          // Total duration ~350ms (> 180ms idleTimeoutMs), but emits output every 70ms -> must succeed!
          return {
            command: "bash",
            args: ["-c", "for i in 1 2 3 4 5; do echo tick-$i; sleep 0.07; done"],
            displayCommand: "mock-heartbeat",
          };
        }
        if (mode === "stall") {
          return {
            command: "bash",
            args: ["-c", "echo started; sleep 5"],
            displayCommand: "mock-stall",
          };
        }
        return {
          command: "bash",
          args: ["-c", "while true; do echo busy; sleep 0.04; done"],
          displayCommand: "mock-ceiling",
        };
      },
    });

    const waitFinish = (runId: string) =>
      new Promise<void>((resolve) => {
        const unsub = executor.subscribe((ev) => {
          if (ev.type === "agent.run.finished" && ev.runId === runId) {
            unsub();
            resolve();
          }
        });
      });

    // 1. Active output keeps sliding watchdog alive beyond idleTimeoutMs
    mode = "heartbeat";
    const hb = await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "implement",
      harness: "qodercn",
      model: "Qwen4-Max",
      idleTimeoutMs: 180,
      timeoutMs: 3000,
    });
    await waitFinish(hb.run.id);
    const afterHb = getRequirement(repo, "REQ-001").state.agentRuns?.find((r) => r.id === hb.run.id);
    expect(afterHb?.status).toBe("succeeded");

    // 2. Silent process hits inactivity watchdog
    mode = "stall";
    const st = await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "implement",
      harness: "qodercn",
      model: "Qwen4-Max",
      idleTimeoutMs: 120,
      timeoutMs: 3000,
    });
    await waitFinish(st.run.id);
    const afterSt = getRequirement(repo, "REQ-001").state.agentRuns?.find((r) => r.id === st.run.id);
    expect(afterSt?.status).toBe("failed");
    expect(afterSt?.errorSummary).toContain("连续");

    // 3. Continuously active process hits maxDurationMs ceiling cleanly
    mode = "ceiling";
    const ce = await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "implement",
      harness: "qodercn",
      model: "Qwen4-Max",
      idleTimeoutMs: 500,
      timeoutMs: 180,
    });
    await waitFinish(ce.run.id);
    const afterCe = getRequirement(repo, "REQ-001").state.agentRuns?.find((r) => r.id === ce.run.id);
    expect(afterCe?.status).toBe("failed");
    expect(afterCe?.errorSummary).toContain("安全上限");
  }, { timeout: 15000 });
});

describe("REQ-008 selected model continuity at the Codex process boundary", () => {
  const FAKE_SESSION_ID = "01a1e74e-98bb-7503-97dd-e8709f8e5022";
  const CLI_DEFAULT_MODEL = "gpt-6-astra";
  const CLI_DEFAULT_EFFORT = "low";
  const SELECTED_MODEL = "gpt-6.2-astra";
  const OPTION_LIKE_SENTINEL = "--force-not-a-real-flag=req008";
  const PROMPT = [
    "请接力执行工作台需求 REQ-001。",
    `追加指令：${OPTION_LIKE_SENTINEL} 请视为提示词文本，不要当作 CLI 参数。`,
    "第二行提示词内容",
  ].join("\n");

  function fakeCodexHarness(executable: string | null): HarnessInfo {
    return {
      id: "codex",
      label: "Codex CLI",
      subscription: "Plus",
      installed: true,
      executable,
      models: [
        { id: SELECTED_MODEL, tier: "sota", source: "detected", supportedEfforts: ["low", "medium", "high", "xhigh"] },
        { id: CLI_DEFAULT_MODEL, tier: "sota", source: "detected" },
        { id: "gpt-6-luna", tier: "fast", source: "detected" },
        { id: "codex-auto-review", tier: "review", source: "detected" },
      ],
      defaultModel: CLI_DEFAULT_MODEL,
      detectedAt: Date.now(),
    };
  }

  function qoderHarness(): HarnessInfo {
    return {
      id: "qodercn",
      label: "QoderCN",
      subscription: "Qoder",
      installed: true,
      executable: "qodercn",
      models: [{ id: "DeepSeek-V4-Pro", tier: "sota", source: "detected" }],
      defaultModel: "DeepSeek-V4-Pro",
      detectedAt: Date.now(),
    };
  }

  function writeFakeCodexCli(dir: string): string {
    const scriptPath = path.join(dir, "codex-fake");
    const script = `#!/usr/bin/env bash
# Offline Codex CLI stand-in. It performs no provider request: it records the exact argv it
# received and reports the model/effort it resolved locally from that argv, falling back to the
# conflicting built-in defaults below when the caller omitted an override.
set -u
capture_dir="${dir}"
mkdir -p "$capture_dir/argv"
seq=0
if [ -f "$capture_dir/seq" ]; then seq="$(cat "$capture_dir/seq")"; fi
seq=$((seq + 1))
printf '%s' "$seq" > "$capture_dir/seq"
printf '%s\\0' "$@" > "$capture_dir/argv/run-$seq"
config_model="${CLI_DEFAULT_MODEL}"
config_effort="${CLI_DEFAULT_EFFORT}"
model_token=""
effort_token=""
mode="new"
previous=""
for arg in "$@"; do
  case "$previous" in
    -m) model_token="$arg" ;;
  esac
  case "$arg" in
    resume) mode="resume" ;;
    model_reasoning_effort=*) effort_token="$arg" ;;
  esac
  previous="$arg"
done
model="$config_model"
if [ -n "$model_token" ]; then model="$model_token"; fi
effort="$config_effort"
if [ -n "$effort_token" ]; then
  effort="$(printf '%s' "$effort_token" | sed -e 's/^model_reasoning_effort=//' -e 's/"//g')"
fi
printf 'Codex fixture (offline; no provider request performed)\\n'
printf 'mode: exec %s\\n' "$mode"
printf 'model: %s\\n' "$model"
printf 'reasoning effort: %s\\n' "$effort"
printf 'session_id: ${FAKE_SESSION_ID}\\n'
if [ "$model" != "$config_model" ]; then
  printf 'warning: switching away from the recorded model %s\\n' "$config_model"
fi
printf 'done\\n'
`;
    fs.writeFileSync(scriptPath, script, "utf8");
    fs.chmodSync(scriptPath, 0o755);
    return scriptPath;
  }

  function readCapturedArgv(dir: string, runIndex: number): string[] {
    const parts = fs.readFileSync(path.join(dir, "argv", `run-${runIndex}`), "utf8").split("\0");
    parts.pop();
    return parts;
  }

  async function createBoundaryRepo(): Promise<string> {
    const repo = makeGitRepo("codex-boundary");
    await initProject(repo, { name: "BoundaryRepo", privacyMode: "local" });
    await createRequirement(repo, {
      goal: "在原生续接时保持所选模型与推理强度",
      criteria: [{ id: "AC-1", description: "ok", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", { designMarkdown: "# Design" });
    await approveDesign(repo, "REQ-001");
    return repo;
  }

  function makeTrackedExecutor(executable: string) {
    const executor = new HubExecutor({ initialHarnesses: [fakeCodexHarness(executable)] });
    const startedEvents: Array<{ runId: string; harness?: string; model?: string }> = [];
    const waiters = new Map<string, Array<() => void>>();
    executor.subscribe((ev) => {
      if (ev.type === "agent.run.started") {
        startedEvents.push({ runId: ev.runId, harness: ev.harness, model: ev.model });
      }
      if (ev.type === "agent.run.finished") {
        const pending = waiters.get(ev.runId) ?? [];
        waiters.delete(ev.runId);
        for (const resolve of pending) resolve();
      }
    });
    const waitFinished = (runId: string) =>
      new Promise<void>((resolve) => {
        waiters.set(runId, [...(waiters.get(runId) ?? []), resolve]);
      });
    return { executor, startedEvents, waitFinished };
  }

  interface BuilderCase {
    name: string;
    target: ModelTarget;
    action: AgentAction;
    sessionId?: string;
    expectedArgs: string[];
    expectedSummary: string;
  }

  const BUILDER_CASES: BuilderCase[] = [
    {
      name: "new-session-with-selection",
      target: { harness: "codex", model: SELECTED_MODEL, reasoningEffort: "medium" },
      action: "implement",
      expectedArgs: [
        "exec", "-C", "/repo", "--skip-git-repo-check", "-m", SELECTED_MODEL,
        "-c", 'model_reasoning_effort="medium"', "--dangerously-bypass-approvals-and-sandbox", PROMPT,
      ],
      expectedSummary: `codex exec -C /repo --dangerously-bypass-approvals-and-sandbox (model=${SELECTED_MODEL}, effort=medium)`,
    },
    {
      name: "resume-with-selection",
      target: { harness: "codex", model: SELECTED_MODEL, reasoningEffort: "medium" },
      action: "implement",
      sessionId: "sess-codex-1",
      expectedArgs: [
        "exec", "resume", "--skip-git-repo-check", "-m", SELECTED_MODEL,
        "-c", 'model_reasoning_effort="medium"', "--dangerously-bypass-approvals-and-sandbox", "sess-codex-1", PROMPT,
      ],
      expectedSummary: `codex exec resume sess-codex-1 (model=${SELECTED_MODEL}, effort=medium)`,
    },
    {
      name: "resume-read-only-ask",
      target: { harness: "codex", model: SELECTED_MODEL, reasoningEffort: "high" },
      action: "ask",
      sessionId: "sess-codex-1",
      expectedArgs: [
        "exec", "resume", "--skip-git-repo-check", "-m", SELECTED_MODEL,
        "-c", 'model_reasoning_effort="high"', "-c", 'sandbox_mode="read-only"', "sess-codex-1", PROMPT,
      ],
      expectedSummary: `codex exec resume sess-codex-1 (model=${SELECTED_MODEL}, effort=high)`,
    },
    {
      name: "resume-default-model-without-effort",
      target: { harness: "codex", model: "default" },
      action: "implement",
      sessionId: "sess-codex-1",
      expectedArgs: [
        "exec", "resume", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "sess-codex-1", PROMPT,
      ],
      expectedSummary: "codex exec resume sess-codex-1 (model=default)",
    },
    {
      name: "review-never-resumes",
      target: { harness: "codex", model: "codex-auto-review" },
      action: "review",
      sessionId: "sess-codex-1",
      expectedArgs: [
        "exec", "-C", "/repo", "--skip-git-repo-check", "-m", "codex-auto-review", "-s", "read-only", PROMPT,
      ],
      expectedSummary: "codex exec -C /repo -s read-only (model=codex-auto-review)",
    },
  ];

  function buildCase(c: BuilderCase) {
    return buildHarnessCommand(c.target, {
      root: "/repo",
      action: c.action,
      prompt: PROMPT,
      ...(c.sessionId ? { nativeSessionId: c.sessionId } : {}),
      harnesses: [],
    });
  }

  test("builds identical model/effort overrides for new sessions and native resume and summarizes them without the prompt", () => {
    makeTempHub();
    const built = BUILDER_CASES.map((c) => buildCase(c));

    expect(built.map((b, i) => [BUILDER_CASES[i]!.name, b.args])).toEqual(
      BUILDER_CASES.map((c) => [c.name, c.expectedArgs]),
    );
    expect(built.map((b, i) => [BUILDER_CASES[i]!.name, b.displayCommand])).toEqual(
      BUILDER_CASES.map((c) => [c.name, c.expectedSummary]),
    );

    expect(BUILDER_CASES.filter((c, i) => built[i]!.args.at(-1) !== PROMPT).map((c) => c.name)).toEqual([]);
    expect(
      BUILDER_CASES.filter((c, i) => built[i]!.args.filter((a) => a.includes(OPTION_LIKE_SENTINEL)).length !== 1).map((c) => c.name),
    ).toEqual([]);
    expect(BUILDER_CASES.filter((c, i) => built[i]!.displayCommand.includes(OPTION_LIKE_SENTINEL)).map((c) => c.name)).toEqual([]);
    expect(BUILDER_CASES.filter((c, i) => built[i]!.args.includes("--full-auto")).map((c) => c.name)).toEqual([]);

    const defaultCase = built[BUILDER_CASES.findIndex((c) => c.name === "resume-default-model-without-effort")]!;
    expect(defaultCase.args).not.toContain("-m");
    expect(defaultCase.args.filter((a) => a.startsWith("model_reasoning_effort="))).toEqual([]);
    expect(defaultCase.displayCommand).not.toContain("effort=");
  });

  test("spawns the production Codex command with the selected model and effort across resume, model change, and review", async () => {
    makeTempHub();
    applyHubRoutingPreset("sota_first");
    const repo = await createBoundaryRepo();
    const codeRoot = fs.realpathSync(repo);
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-fake-codex-"));
    tempDirs.push(fixtureDir);
    const fake = writeFakeCodexCli(fixtureDir);
    const { executor, startedEvents, waitFinished } = makeTrackedExecutor(fake);

    // 1. Fresh session with the explicit picker selection.
    const run1 = await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "design",
      harness: "codex",
      model: SELECTED_MODEL,
      reasoningEffort: "medium",
    });
    await waitFinished(run1.run.id);
    const argv1 = readCapturedArgv(fixtureDir, 1);
    expect(argv1.slice(0, -1)).toEqual([
      "exec", "-C", codeRoot, "--skip-git-repo-check", "-m", SELECTED_MODEL,
      "-c", 'model_reasoning_effort="medium"', "--dangerously-bypass-approvals-and-sandbox",
    ]);
    expect(argv1).toHaveLength(10);
    expect(argv1.at(-1)).toContain("REQ-001");
    expect(run1.target).toEqual({ harness: "codex", model: SELECTED_MODEL, reasoningEffort: "medium" });
    expect(startedEvents[0]).toEqual({ runId: run1.run.id, harness: "codex", model: SELECTED_MODEL });
    const after1 = getRequirement(repo, "REQ-001");
    expect(after1.state.agentRuns?.[0]).toMatchObject({
      id: run1.run.id,
      harness: "codex",
      model: SELECTED_MODEL,
      reasoningEffort: "medium",
      status: "succeeded",
      nativeSessionId: FAKE_SESSION_ID,
    });
    const log1 = executor.getLiveLog(run1.run.id) ?? "";
    expect(log1.split("\n")[0]).toBe(`$ ${fake} exec -C ${codeRoot} --dangerously-bypass-approvals-and-sandbox (model=${SELECTED_MODEL}, effort=medium)`);
    expect(log1).toContain(`model: ${SELECTED_MODEL}`);
    expect(log1).toContain("reasoning effort: medium");
    expect(log1).toContain(`warning: switching away from the recorded model ${CLI_DEFAULT_MODEL}`);
    expect(log1).not.toContain("请接力执行工作台需求");

    // 2. Eligible native resume keeps the session and still carries both overrides.
    const run2 = await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "implement",
      harness: "codex",
      model: SELECTED_MODEL,
      reasoningEffort: "medium",
      message: `请补充注释 ${OPTION_LIKE_SENTINEL}`,
    });
    await waitFinished(run2.run.id);
    const argv2 = readCapturedArgv(fixtureDir, 2);
    expect(argv2.slice(0, -2)).toEqual([
      "exec", "resume", "--skip-git-repo-check", "-m", SELECTED_MODEL,
      "-c", 'model_reasoning_effort="medium"', "--dangerously-bypass-approvals-and-sandbox",
    ]);
    expect(argv2).toHaveLength(10);
    expect(argv2[8]).toBe(FAKE_SESSION_ID);
    const prompt2 = argv2[9]!;
    expect(prompt2).toContain(OPTION_LIKE_SENTINEL);
    expect(argv2.filter((a) => a.includes(OPTION_LIKE_SENTINEL))).toEqual([prompt2]);
    const after2 = getRequirement(repo, "REQ-001");
    expect(after2.state.agentRuns?.[1]).toMatchObject({
      harness: "codex",
      model: SELECTED_MODEL,
      reasoningEffort: "medium",
      status: "succeeded",
      nativeSessionId: FAKE_SESSION_ID,
    });
    const log2 = executor.getLiveLog(run2.run.id) ?? "";
    expect(log2.split("\n")[0]).toBe(`$ ${fake} exec resume ${FAKE_SESSION_ID} (model=${SELECTED_MODEL}, effort=medium)`);
    expect(log2).not.toContain(OPTION_LIKE_SENTINEL);
    expect(log2).toContain("mode: exec resume");
    expect(log2).toContain(`model: ${SELECTED_MODEL}`);

    // 3. Same-harness model change resumes the session and dispatches the new model.
    const run3 = await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "implement",
      harness: "codex",
      model: "gpt-6-luna",
    });
    await waitFinished(run3.run.id);
    const argv3 = readCapturedArgv(fixtureDir, 3);
    expect(argv3.slice(0, -2)).toEqual([
      "exec", "resume", "--skip-git-repo-check", "-m", "gpt-6-luna", "--dangerously-bypass-approvals-and-sandbox",
    ]);
    expect(argv3[6]).toBe(FAKE_SESSION_ID);
    expect(argv3).toHaveLength(8);
    expect(argv3.filter((a) => a.startsWith("model_reasoning_effort="))).toEqual([]);
    expect(run3.target).toEqual({ harness: "codex", model: "gpt-6-luna" });
    expect(executor.getLiveLog(run3.run.id)).toContain("model: gpt-6-luna");

    // 4. Review stays a fresh read-only session and never inherits the native session.
    const run4 = await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "review",
      harness: "codex",
      model: "codex-auto-review",
    });
    await waitFinished(run4.run.id);
    const argv4 = readCapturedArgv(fixtureDir, 4);
    expect(argv4.slice(0, -1)).toEqual([
      "exec", "-C", codeRoot, "--skip-git-repo-check", "-m", "codex-auto-review", "-s", "read-only",
    ]);
    expect(argv4).not.toContain(FAKE_SESSION_ID);
    expect(argv4).not.toContain("resume");
    expect(executor.getLiveLog(run4.run.id)?.split("\n")[0]).toBe(
      `$ ${fake} exec -C ${codeRoot} -s read-only (model=codex-auto-review)`,
    );
    expect(startedEvents.map((e) => e.model)).toEqual([SELECTED_MODEL, SELECTED_MODEL, "gpt-6-luna", "codex-auto-review"]);
  }, { timeout: 25000 });

  test("dispatches a deliberate fallback target consistently across argv, response, record, and event", async () => {
    makeTempHub();
    applyHubRoutingPreset("sota_first");
    const repo = await createBoundaryRepo();
    const codeRoot = fs.realpathSync(repo);
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-fake-codex-fallback-"));
    tempDirs.push(fixtureDir);
    const fake = writeFakeCodexCli(fixtureDir);
    const { executor, startedEvents, waitFinished } = makeTrackedExecutor(fake);

    const first = await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "design",
      harness: "codex",
      model: CLI_DEFAULT_MODEL,
    });
    await waitFinished(first.run.id);
    expect(readCapturedArgv(fixtureDir, 1)).toContain(CLI_DEFAULT_MODEL);

    const fallback = await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "design",
      harness: "codex",
      model: CLI_DEFAULT_MODEL,
      useFallback: true,
    });
    await waitFinished(fallback.run.id);
    const argv = readCapturedArgv(fixtureDir, 2);
    expect(fallback.target).toEqual({ harness: "codex", model: SELECTED_MODEL, reasoningEffort: "high" });
    expect(argv.slice(0, -1)).toEqual([
      "exec", "-C", codeRoot, "--skip-git-repo-check", "-m", SELECTED_MODEL,
      "-c", 'model_reasoning_effort="high"', "--dangerously-bypass-approvals-and-sandbox",
    ]);
    expect(argv).not.toContain("resume");
    expect(argv).not.toContain(FAKE_SESSION_ID);
    expect(startedEvents[1]).toEqual({ runId: fallback.run.id, harness: "codex", model: SELECTED_MODEL });
    expect(getRequirement(repo, "REQ-001").state.agentRuns?.[1]).toMatchObject({
      harness: "codex",
      model: SELECTED_MODEL,
      reasoningEffort: "high",
    });
  }, { timeout: 25000 });

  test("keeps native session isolation for review, cancelled, rate-limited, cross-harness, and fallback runs", async () => {
    makeTempHub();
    const repo = makeGitRepo("iso");
    await initProject(repo, { name: "IsoRepo", privacyMode: "local" });

    const seen: string[] = [];
    let sessionSeq = 0;
    const executor = new HubExecutor({
      initialHarnesses: [fakeCodexHarness("codex"), qoderHarness()],
      commandBuilder: (target, ctx) => {
        sessionSeq += 1;
        seen.push(`${target.harness}/${target.model}:${ctx.nativeSessionId ?? "none"}`);
        const sessionId = `sess-iso-${sessionSeq}`;
        if (target.model === "rate-limit-me") {
          return {
            command: "bash",
            args: ["-c", `printf 'session_id: ${sessionId}\\n'; echo '429 quota exceeded' >&2; exit 1`],
            displayCommand: "mock-rate-limit",
          };
        }
        if (target.model === "cancel-me") {
          return {
            command: "bash",
            args: ["-c", `printf 'session_id: ${sessionId}\\n'; exec sleep 5`],
            displayCommand: "mock-cancel",
          };
        }
        return { command: "bash", args: ["-c", `printf 'session_id: ${sessionId}\\n'; echo ok`], displayCommand: "mock-ok" };
      },
    });
    const waiters = new Map<string, Array<() => void>>();
    executor.subscribe((ev) => {
      if (ev.type !== "agent.run.finished") return;
      const pending = waiters.get(ev.runId) ?? [];
      waiters.delete(ev.runId);
      for (const resolve of pending) resolve();
    });
    const waitFinished = (runId: string) =>
      new Promise<void>((resolve) => {
        waiters.set(runId, [...(waiters.get(runId) ?? []), resolve]);
      });

    let reqIndex = 0;
    const nextId = () => {
      reqIndex += 1;
      return `REQ-${String(reqIndex).padStart(3, "0")}`;
    };

    const lastDispatch = () => seen[seen.length - 1]!;
    const sessionOf = (requirementId: string, runId: string) =>
      getRequirement(repo, requirementId).state.agentRuns?.find((r) => r.id === runId)?.nativeSessionId ?? null;
    const approveForImplementation = async (requirementId: string) => {
      await propose(repo, requirementId, { designMarkdown: "# Design" });
      await approveDesign(repo, requirementId);
    };

    // 1. A resume-eligible continuation reuses the previous native session; a review run never does.
    const eligible = nextId();
    await createRequirement(repo, { goal: "续接资格" });
    await approveForImplementation(eligible);
    const seed = await executor.startRun({
      root: repo,
      requirementId: eligible,
      action: "ask",
      harness: "codex",
      model: SELECTED_MODEL,
      message: "为什么要用文件锁？",
    });
    await waitFinished(seed.run.id);
    expect(lastDispatch()).toBe(`codex/${SELECTED_MODEL}:none`);
    const seedSession = sessionOf(eligible, seed.run.id);
    expect(seedSession).toBeTruthy();

    const continued = await executor.startRun({
      root: repo,
      requirementId: eligible,
      action: "implement",
      harness: "codex",
      model: SELECTED_MODEL,
    });
    await waitFinished(continued.run.id);
    expect(lastDispatch()).toBe(`codex/${SELECTED_MODEL}:${seedSession}`);

    const reviewed = await executor.startRun({
      root: repo,
      requirementId: eligible,
      action: "review",
      harness: "codex",
      model: "codex-auto-review",
    });
    await waitFinished(reviewed.run.id);
    expect(lastDispatch()).toBe("codex/codex-auto-review:none");

    // 2. A cancelled previous run must not hand its session to the next continuation.
    const cancelledReq = nextId();
    await createRequirement(repo, { goal: "取消后隔离" });
    const cancelled = await executor.startRun({
      root: repo,
      requirementId: cancelledReq,
      action: "design",
      harness: "codex",
      model: "cancel-me",
    });
    const cancelledDone = waitFinished(cancelled.run.id);
    await new Promise((r) => setTimeout(r, 120));
    expect(executor.cancelRun(cancelled.run.id)).toBe(true);
    await cancelledDone;
    expect(getRequirement(repo, cancelledReq).state.agentRuns?.[0]).toMatchObject({ status: "cancelled" });
    expect(sessionOf(cancelledReq, cancelled.run.id)).toBeTruthy();
    const afterCancel = await executor.startRun({
      root: repo,
      requirementId: cancelledReq,
      action: "design",
      harness: "codex",
      model: SELECTED_MODEL,
    });
    await waitFinished(afterCancel.run.id);
    expect(lastDispatch()).toBe(`codex/${SELECTED_MODEL}:none`);

    // 3. A rate-limited previous run must not hand its session to the next continuation.
    const rateReq = nextId();
    await createRequirement(repo, { goal: "限流后隔离" });
    const limited = await executor.startRun({
      root: repo,
      requirementId: rateReq,
      action: "design",
      harness: "codex",
      model: "rate-limit-me",
    });
    await waitFinished(limited.run.id);
    expect(getRequirement(repo, rateReq).state.agentRuns?.[0]).toMatchObject({ rateLimited: true });
    expect(sessionOf(rateReq, limited.run.id)).toBeTruthy();
    const afterRate = await executor.startRun({
      root: repo,
      requirementId: rateReq,
      action: "design",
      harness: "codex",
      model: SELECTED_MODEL,
    });
    await waitFinished(afterRate.run.id);
    expect(lastDispatch()).toBe(`codex/${SELECTED_MODEL}:none`);
    clearModelCooldown("codex", "rate-limit-me");

    // 4. Cross-harness continuation and a deliberate fallback request both start a fresh session.
    const crossReq = nextId();
    await createRequirement(repo, { goal: "跨 Harness 隔离" });
    await approveForImplementation(crossReq);
    const crossSeed = await executor.startRun({
      root: repo,
      requirementId: crossReq,
      action: "ask",
      harness: "codex",
      model: SELECTED_MODEL,
      message: "为什么要用文件锁？",
    });
    await waitFinished(crossSeed.run.id);
    expect(lastDispatch()).toBe(`codex/${SELECTED_MODEL}:none`);
    const crossRun = await executor.startRun({
      root: repo,
      requirementId: crossReq,
      action: "implement",
      harness: "qodercn",
      model: "DeepSeek-V4-Pro",
    });
    await waitFinished(crossRun.run.id);
    expect(lastDispatch()).toBe("qodercn/DeepSeek-V4-Pro:none");

    const fbReq = nextId();
    await createRequirement(repo, { goal: "备援后隔离" });
    await approveForImplementation(fbReq);
    const fbSeed = await executor.startRun({
      root: repo,
      requirementId: fbReq,
      action: "ask",
      harness: "codex",
      model: SELECTED_MODEL,
      message: "为什么要用文件锁？",
    });
    await waitFinished(fbSeed.run.id);
    const fbRun = await executor.startRun({
      root: repo,
      requirementId: fbReq,
      action: "implement",
      harness: "codex",
      model: SELECTED_MODEL,
      useFallback: true,
    });
    await waitFinished(fbRun.run.id);
    expect(fbRun.target).toEqual({ harness: "qodercn", model: "DeepSeek-V4-Pro" });
    expect(lastDispatch()).toBe("qodercn/DeepSeek-V4-Pro:none");
  }, { timeout: 25000 });

  test("prioritizes an explicit selection over a conflicting preset and cooldown while automatic routing keeps stage semantics", () => {
    makeTempHub();
    applyHubRoutingPreset("quota_saver");
    const harnesses = [fakeCodexHarness("codex"), qoderHarness()];
    const cfg = readHubConfig();
    expect(cfg.routing.stages.design.primary).toEqual({ harness: "qodercn", model: "Qwen4-Max" });

    // Automatic mode keeps action routing semantics: ask maps onto the design stage rule (remapped to available qodercn model).
    const automatic = resolveRouteCandidates(cfg.routing, harnesses, "ask");
    expect(automatic[0]).toEqual({ harness: "qodercn", model: "DeepSeek-V4-Pro" });
    expect(resolveRouteCandidates(cfg.routing, harnesses, "design")[0]).toEqual(automatic[0]);

    const explicit: ModelTarget = { harness: "codex", model: SELECTED_MODEL, reasoningEffort: "medium" };
    expect(resolveRouteCandidates(cfg.routing, harnesses, "design", explicit)[0]).toEqual(explicit);
    expect(resolveRouteCandidates(buildPresetRouting("sota_first"), harnesses, "implement", explicit)[0]).toEqual(explicit);

    recordModelRunOutcome({
      harness: "codex",
      model: SELECTED_MODEL,
      action: "design",
      status: "failed",
      durationMs: 100,
      rateLimited: true,
    });
    expect(isModelCoolingDown("codex", SELECTED_MODEL)).toBe(true);
    expect(resolveRouteCandidates(cfg.routing, harnesses, "design", explicit)[0]).toEqual(explicit);

    // Automatic routing only demotes the cooling model instead of substituting a selection.
    const sota = buildPresetRouting("sota_first");
    const cooled = resolveRouteCandidates(sota, harnesses, "design");
    expect(cooled[0]).toEqual({ harness: "qodercn", model: "DeepSeek-V4-Pro", reasoningEffort: "high" });
    expect(cooled.at(-1)).toEqual({ harness: "codex", model: SELECTED_MODEL, reasoningEffort: "high" });

    clearModelCooldown("codex", SELECTED_MODEL);
    expect(isModelCoolingDown("codex", SELECTED_MODEL)).toBe(false);
    expect(resolveRouteCandidates(sota, harnesses, "design")[0]).toEqual({
      harness: "codex",
      model: SELECTED_MODEL,
      reasoningEffort: "high",
    });
  });
});
