import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getDaemonStatus, startDaemon, stopDaemon } from "../../src/cli/daemon.ts";
import { approveDesign, createRequirement, getRequirement, initProject, propose, updateDesign } from "../../src/core/engine.ts";
import { runVerification } from "../../src/core/runner.ts";
import { discoverHarnesses } from "../../src/hub/discovery.ts";
import { buildHarnessCommand, HubExecutor } from "../../src/hub/executor.ts";
import { synthesizeHandoffPacket } from "../../src/hub/handoff.ts";
import {
  addCustomModel,
  applyHubRoutingPreset,
  browseDirectory,
  isAutoRegistrableProjectRoot,
  readHubConfig,
  registerHubProject,
  removeHubProject,
  setActiveHubProject,
} from "../../src/hub/registry.ts";
import { buildPresetRouting, detectRateLimitOrQuotaError, resolveRouteCandidates } from "../../src/hub/routing.ts";
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
  test("discovers harnesses cleanly with custom models and graceful fallbacks", async () => {
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

    const harnesses = await discoverHarnesses(
      { opencode: ["opencode-go/custom-coder"] },
      {
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
      },
    );

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
    expect(oc.models.some((m) => m.id === "opencode-go/custom-coder" && m.source === "custom")).toBe(true);
    expect(oc.models.some((m) => m.id === "opencode-go/deepseek-v4.1-flash")).toBe(true);
    expect(agy.installed).toBe(true);
    expect(agy.models.some((m) => m.id === "gemini-4-hydrogen-xhigh")).toBe(true);
    expect(omp.installed).toBe(true);
    expect(omp.models.some((m) => m.id === "qoder-cn/DeepSeek-Flash")).toBe(true);
    expect(omp.models.some((m) => m.id === "opencode-go/deepseek-v4.1-flash")).toBe(true);
  });

  test("applies presets, custom models, routing overrides, and rate-limit detection", () => {
    makeTempHub();
    const sota = buildPresetRouting("sota_first");
    expect(sota.stages.design.primary.model).toBe("gpt-6.1-sol");
    expect(sota.stages.review.primary.harness).toBe("agy");

    applyHubRoutingPreset("quota_saver");
    const cfg = addCustomModel("opencode", "opencode-go/pro-model");
    expect(cfg.routing.activePreset).toBe("quota_saver");
    expect(cfg.customModels.opencode).toContain("opencode-go/pro-model");

    const candidates = resolveRouteCandidates(cfg.routing, null, "implement", {
      harness: "qodercn",
      model: "DeepSeek-V4-Pro",
    });
    expect(candidates[0]).toEqual({ harness: "qodercn", model: "DeepSeek-V4-Pro" });
    expect(detectRateLimitOrQuotaError("HTTP 429 Too Many Requests: quota exceeded", 1)).toBe(true);
    expect(detectRateLimitOrQuotaError("all tests passed", 0)).toBe(false);
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

    // 2. Same-harness continuation reuses nativeSessionId!
    const run2 = await executor.startRun({
      root: repo,
      requirementId: "REQ-001",
      action: "implement",
      harness: "codex",
      model: "gpt-6-astra",
    });
    await waitForRunFinished(run2.run.id);
    expect(seenCommands[1]).toBe("codex:gpt-6-astra:sess-abc123");

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
});
