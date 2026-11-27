import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { approveDesign, createRequirement, initProject, propose } from "../../src/core/engine.ts";
import { HubExecutor } from "../../src/hub/executor.ts";
import { registerHubProject } from "../../src/hub/registry.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";
import {
  type BrowserInstance,
  cleanupE2eResources,
  clickReady,
  closeE2eBrowser,
  controlledRunScript,
  HAS_BROWSER,
  initGitRepoIn,
  launchE2eBrowser,
} from "./e2e_helpers.ts";

const tempDirs: string[] = [];
const servers: WorkbenchServerHandle[] = [];
const origHubDir = process.env.WORKBENCH_HUB_DIR;
let browser: BrowserInstance | null = null;
const initGitRepo = () => initGitRepoIn(tempDirs);

beforeAll(async () => {
  browser = await launchE2eBrowser();
}, 15_000);

afterEach(() => {
  cleanupE2eResources(servers, tempDirs, origHubDir);
});

afterAll(async () => {
  await closeE2eBrowser(browser);
}, 15_000);

const suite = HAS_BROWSER ? describe : describe.skip;

suite("Discussion & Annotation Workspace Browser E2E (P0/P1/P2)", () => {
  test("streaming ask uses rich AI markdown without locking workspace, coexists with active implement, and persists annotations across reload", async () => {
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-e2e-discuss-"));
    tempDirs.push(hubDir);
    process.env.WORKBENCH_HUB_DIR = hubDir;

    const repo = initGitRepo();
    await initProject(repo, {
      name: "DiscussUX",
      privacyMode: "local",
      routing: {
        defaultLead: { primary: { harness: "agy", model: "gemini-4-argon" }, fallbacks: [] },
        sotaLead: { primary: { harness: "agy", model: "gemini-4-argon" }, fallbacks: [] },
        reviewer: { primary: { harness: "agy", model: "gemini-4-argon" }, fallbacks: [] },
        autoReview: false,
        autoHeal: false,
      },
    });
    registerHubProject(repo, { name: "DiscussUX", activate: true });

    await createRequirement(repo, {
      goal: "研讨工作区流式渲染与双轨并发验证",
      criteria: [{ id: "AC-1", description: "验证通过", required: true, command: "echo ok" }],
    });
    await propose(repo, "REQ-001", {
      designMarkdown: "# 核心架构\n\n采用双轨并发模型。\n\n## 缓存策略\n\n使用内存缓冲。",
      actor: "agent",
    });

    const askDoneFile = path.join(hubDir, "ask-done");
    const implDoneFile = path.join(hubDir, "impl-done");
    const implCodeFile = path.join(hubDir, "impl-code");

    const executor = new HubExecutor({
      initialHarnesses: [
        {
          id: "agy",
          label: "AGY",
          subscription: "Pro",
          installed: true,
          executable: "agy",
          models: [{ id: "gemini-4-argon", tier: "sota", source: "detected" }],
          defaultModel: "gemini-4-argon",
          detectedAt: Date.now(),
        },
      ],
      commandBuilder: (_target, ctx) => {
        if (ctx.action === "ask") {
          return {
            command: process.execPath,
            args: [
              "-e",
              [
                `const fs=require('fs');const done=${JSON.stringify(askDoneFile)};`,
                `console.log(JSON.stringify({event:"step_update",step_update:{conversation_id:"c1",step_index:1,state:"ACTIVE",step_type:"agent_response",thinking_delta:"正在分析双轨并发"}}));`,
                `console.log(JSON.stringify({event:"step_update",step_update:{conversation_id:"c1",step_index:1,state:"ACTIVE",step_type:"agent_response",text_delta:"### 流式结论\\n\\n**第一部分**：已通过增量推送。"}}));`,
                `const t=setInterval(()=>{if(fs.existsSync(done)){clearInterval(t);`,
                `console.log(JSON.stringify({event:"step_update",step_update:{conversation_id:"c1",step_index:1,state:"ACTIVE",step_type:"agent_response",text_delta:"\\n\\n**第二部分**：回答完毕。"}}));`,
                `console.log(JSON.stringify({event:"step_update",step_update:{conversation_id:"c1",step_index:1,state:"DONE",step_type:"agent_response",duration_seconds:0.5}}));`,
                `process.exit(0);}},30);`,
              ].join(""),
            ],
            displayCommand: "mock-agy-ask-stream",
          };
        }
        return {
          command: "bash",
          args: ["-c", controlledRunScript(implDoneFile, implCodeFile)],
          displayCommand: "mock-impl-hold",
        };
      },
    });

    const server = await startWorkbenchServer({ root: repo, port: 0, writeDiscovery: false, hubMode: true, executor });
    servers.push(server);

    const page = await browser!.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err: Error) => pageErrors.push(err.message));

    try {
      await page.setViewport({ width: 1400, height: 900 });
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="stage-stepper"]', { timeout: 5000 });

      // 1. Open drawer and trigger streaming Ask
      await clickReady(page, '[data-testid="toggle-drawer-btn"]');
      await page.waitForSelector('#discuss-input', { timeout: 5000 });
      await page.type('#discuss-input', '双轨并发的优势是什么？');
      await clickReady(page, '[data-testid="run-ask-btn"]');

      // The first stream chunk can arrive before the dispatch response clears the composer.
      await page.waitForFunction(
        () => {
          const composer = document.querySelector("#discuss-input");
          return composer instanceof HTMLTextAreaElement && composer.value === "" &&
            Boolean(document.querySelector('[data-testid="discuss-stream-output"]')?.textContent?.includes("第一部分"));
        },
        { timeout: 8000 },
      );

      const duringAsk = await page.evaluate(() => ({
        hasLiveBanner: Boolean(document.querySelector('[data-testid="live-agent-banner"]')),
        hasStopAskBtn: Boolean(document.querySelector('[data-testid="stop-ask-btn"]')),
        hasRawPre: Boolean(document.querySelector('.discuss-stream-pre')),
        hasRichMarkdown: Boolean(document.querySelector('[data-testid="discuss-stream-output"] .console-msg-rich')),
        hasChatConversation: Boolean(document.querySelector('[data-slot="chat-conversation"]')),
        hasComposer: Boolean(document.querySelector('[data-slot="composer"]')),
        runnerInComposerActions: Boolean(
          document.querySelector('[data-slot="composer-actions"] [data-testid="drawer-runner-select-trigger"]'),
        ),
        refineInComposerActions: Boolean(
          document.querySelector('[data-slot="composer-actions"] [data-testid="run-refine-btn"]'),
        ),
        askInComposerActions: Boolean(
          document.querySelector('[data-slot="composer-actions"] [data-testid="run-ask-btn"]'),
        ),
        editDesignDisabled: Boolean(
          (document.querySelector('[data-testid="start-edit-design-btn"]') as HTMLButtonElement | null)?.disabled,
        ),
        approveDisabled: Boolean(
          (document.querySelector('[data-testid="action-approve_only"]') as HTMLButtonElement | null)?.disabled,
        ),
        refineDisabled: Boolean(
          (document.querySelector('[data-testid="run-refine-btn"]') as HTMLButtonElement | null)?.disabled,
        ),
      }));

      expect(duringAsk).toEqual({
        hasLiveBanner: false,
        hasStopAskBtn: true,
        hasRawPre: false,
        hasRichMarkdown: true,
        hasChatConversation: true,
        hasComposer: true,
        runnerInComposerActions: true,
        refineInComposerActions: true,
        askInComposerActions: true,
        editDesignDisabled: false,
        approveDisabled: false,
        refineDisabled: false,
      });

      // Finish Ask and verify persisted rich AI message + metadata
      fs.writeFileSync(askDoneFile, "go", "utf8");
      await page.waitForFunction(
        () =>
          !document.querySelector('[data-testid="discuss-stream-card"]') &&
          Boolean(document.querySelector('[data-testid="discuss-thread"]')?.textContent?.includes("第二部分")),
        { timeout: 8000 },
      );

      // 2. Non-blocking annotation dock + server persistence across reload + anchor jump
      await clickReady(page, '[data-action="annotate-anchor"][data-anchor="design.md#核心架构"]');
      await page.waitForSelector('[data-testid="annotate-modal"]', { timeout: 5000 });
      await page.type('[data-testid="annotate-msg"]', "补充失败回退细节");
      await clickReady(page, '[data-testid="annotate-queue-btn"]');
      await page.waitForFunction(
        () =>
          !document.querySelector('[data-testid="annotate-modal"]') &&
          Boolean(document.querySelector('[data-testid="pending-annotations"]')?.textContent?.includes("补充失败回退细节")),
        { timeout: 5000 },
      );

      // Reload page -> pending annotation & heading count badge still present from server!
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="anchor-annot-count"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="toggle-drawer-btn"]');
      await page.waitForSelector('[data-testid="pending-annotations"]', { timeout: 5000 });

      const afterReload = await page.evaluate(() => ({
        pendingText: document.querySelector('[data-testid="pending-annotations"]')?.textContent ?? "",
        badgeText: document.querySelector('[data-testid="anchor-annot-count"]')?.textContent ?? "",
      }));
      expect(afterReload.pendingText).toContain("补充失败回退细节");
      expect(afterReload.badgeText).toBe("1");

      // Clicking anchor pill jumps & highlights target heading
      await clickReady(page, '[data-testid="pending-annotations"] [data-testid="anchor-jump-btn"]');
      await page.waitForFunction(
        () => Boolean(document.querySelector('[data-anchor-target="design.md#核心架构"].anchor-jump-highlight')),
        { timeout: 3000 },
      );

      // 3. Approve -> start implement -> verify Ask still works concurrently!
      await approveDesign(repo, "REQ-001");
      await page.goto(server.url, { waitUntil: "networkidle0" });
      await clickReady(page, '[data-testid="req-row-REQ-001"]');
      await page.waitForSelector('[data-testid="action-dispatch_implement"]', { timeout: 5000 });
      await clickReady(page, '[data-testid="action-dispatch_implement"]');
      await page.waitForSelector('[data-testid="live-agent-banner"]', { timeout: 5000 });

      await clickReady(page, '[data-testid="drawer-tab-discuss"]');
      await page.waitForSelector('#discuss-input', { timeout: 5000 });
      const askEnabledDuringImpl = await page.evaluate(() => ({
        askDisabled: Boolean((document.querySelector('[data-testid="run-ask-btn"]') as HTMLButtonElement | null)?.disabled),
        refineDisabled: Boolean((document.querySelector('[data-testid="run-refine-btn"]') as HTMLButtonElement | null)?.disabled),
      }));
      expect(askEnabledDuringImpl).toEqual({ askDisabled: false, refineDisabled: true });

      // Release implement run cleanly
      fs.writeFileSync(implCodeFile, "0", "utf8");
      fs.writeFileSync(implDoneFile, "go", "utf8");
      await page.waitForFunction(() => !document.querySelector('[data-testid="live-agent-banner"]'), { timeout: 8000 });

      // Narrow drawer (360px) + dark theme layout check: ComposerActions must not overflow horizontally
      await page.evaluate(() => {
        document.documentElement.setAttribute("data-theme", "dark");
        const ws = document.querySelector(".workspace-shell") as HTMLElement | null;
        if (ws) ws.style.setProperty("--drawer-w", "360px");
      });
      await new Promise((r) => setTimeout(r, 80));
      const narrowOverflow = await page.evaluate(() => {
        const actions = document.querySelector('[data-slot="composer-actions"]') as HTMLElement | null;
        const drawer = document.querySelector('[data-testid="discuss-pane"]') as HTMLElement | null;
        if (!actions || !drawer) return { missing: true, overflows: true };
        return {
          missing: false,
          overflows: actions.scrollWidth > drawer.clientWidth + 2,
        };
      });
      expect(narrowOverflow).toEqual({ missing: false, overflows: false });

      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 45_000);
});
