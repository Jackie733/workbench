import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import { canonicalRoot } from "../src/core/fs.ts";
import { executeWorkbenchTool, WORKBENCH_TOOL_DEFINITIONS } from "../src/mcp/tools.ts";
import { ensureServerForProject, readServerDiscovery } from "../src/server/runtime.ts";

export interface DeliveryGuardInput {
  available: boolean;
  projectReady: boolean;
  identityFresh: boolean;
  busy: boolean;
  draftText: string;
}

export interface BridgeDispatchMessage {
  dispatchId: string;
  mode: "send" | "prefill";
  prompt: string;
}

export interface BridgeAckPayload {
  type: "bridge.ack";
  dispatchId: string;
  ok: boolean;
  status: "submitted" | "prefilled" | "rejected";
  reason?: string;
}

/** Rejects bridge prompt injection when source is unavailable, stale, busy, or has an unsent draft. */
export function resolveDeliveryRejection(source: DeliveryGuardInput): string | null {
  if (!source.available) return "unsupported_source";
  if (!source.projectReady || !source.identityFresh) return "source_changed";
  if (source.busy) return "source_busy";
  if (source.draftText.length > 0) return "draft_conflict";
  return null;
}

export async function executeBridgeDispatch(
  msg: BridgeDispatchMessage,
  guard: DeliveryGuardInput,
  actions: { setEditorText: (text: string) => void; sendUserMessage: (text: string) => Promise<void> },
): Promise<BridgeAckPayload> {
  const rejection = resolveDeliveryRejection(guard);
  if (rejection) {
    return { type: "bridge.ack", dispatchId: msg.dispatchId, ok: false, status: "rejected", reason: rejection };
  }
  try {
    if (msg.mode === "prefill") {
      actions.setEditorText(msg.prompt);
      return { type: "bridge.ack", dispatchId: msg.dispatchId, ok: true, status: "prefilled" };
    }
    await actions.sendUserMessage(msg.prompt);
    return { type: "bridge.ack", dispatchId: msg.dispatchId, ok: true, status: "submitted" };
  } catch (error) {
    return {
      type: "bridge.ack",
      dispatchId: msg.dispatchId,
      ok: false,
      status: "rejected",
      reason: error instanceof Error ? error.message : "dispatch_failed",
    };
  }
}

function resolveProjectRoot(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return canonicalRoot(out || cwd);
  } catch {
    try { return canonicalRoot(cwd); } catch { return null; }
  }
}

function openBrowserBestEffort(url: string): void {
  try {
    if (process.platform === "linux" && fs.existsSync("/mnt/c/Windows/System32/cmd.exe")) {
      spawn("/mnt/c/Windows/System32/cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch { /* Ignore browser open failure; user still receives URL via notify. */ }
}

export default function workbench(pi: ExtensionAPI): void {
  let ctxRef: ExtensionContext | null = null;
  let sessionId = "";
  let boundCwd = "";
  let projectRoot: string | null = null;
  let socket: WebSocket | null = null;
  let activeTools = 0;

  const currentRunState = (ctx: ExtensionContext): "idle" | "working" | "waiting_user" => {
    if (ctx.getPendingPlanReview() !== undefined) return "waiting_user";
    return !ctx.isIdle() || ctx.hasPendingMessages() || activeTools > 0 ? "working" : "idle";
  };

  const sendBridgeStatus = (ctx: ExtensionContext | null) => {
    if (!ctx || !socket || socket.readyState !== WebSocket.OPEN) return;
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
    socket.send(JSON.stringify({
      type: "bridge.status",
      agent: "omp",
      sessionId,
      state: currentRunState(ctx),
      model,
    }));
  };

  const connectBridge = (url: string, ctx: ExtensionContext) => {
    const wsUrl = `${url.replace(/^http/, "ws")}/ws?role=bridge`;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    const ws = new WebSocket(wsUrl);
    socket = ws;
    ws.addEventListener("open", () => sendBridgeStatus(ctxRef ?? ctx));
    ws.addEventListener("close", () => { if (socket === ws) socket = null; });
    ws.addEventListener("message", async (event) => {
      const live = ctxRef;
      if (!live) return;
      let msg: BridgeDispatchMessage & { type?: string };
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (msg.type !== "bridge.dispatch" || typeof msg.dispatchId !== "string") return;
      const ack = await executeBridgeDispatch(
        msg,
        {
          available: live.agent.kind === "main" && live.mode === "tui" && live.hasUI,
          projectReady: projectRoot !== null,
          identityFresh: live.sessionManager.getSessionId() === sessionId && live.sessionManager.getCwd() === boundCwd,
          busy: currentRunState(live) !== "idle" || live.ui.supportsEditor === false,
          draftText: live.ui.supportsEditor ? live.ui.getEditorText() : "",
        },
        {
          setEditorText: (text) => live.ui.setEditorText(text),
          sendUserMessage: (text) => pi.sendUserMessage(text),
        },
      );
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ack));
    });
  };

  const syncContext = (ctx: ExtensionContext) => {
    if (ctx.agent.kind !== "main") return;
    ctxRef = ctx;
    const nextSession = ctx.sessionManager.getSessionId();
    const nextCwd = ctx.sessionManager.getCwd();
    if (nextSession !== sessionId || nextCwd !== boundCwd) {
      sessionId = nextSession;
      boundCwd = nextCwd;
      projectRoot = resolveProjectRoot(nextCwd);
      activeTools = 0;
    }
    if (projectRoot && !socket) {
      const existing = readServerDiscovery(projectRoot);
      if (existing) connectBridge(existing.url, ctx);
    }
    sendBridgeStatus(ctx);
  };

  pi.setLabel("Spec & Verification Workbench");

  for (const def of WORKBENCH_TOOL_DEFINITIONS) {
    const approval = def.name === "wb_list" || def.name === "wb_get" ? "read" : def.name === "wb_verify" ? "exec" : "write";
    pi.registerTool({
      name: def.name,
      label: def.name,
      description: def.description,
      approval,
      parameters: def.inputSchema,
      async execute(_toolCallId, args, _signal, _update, ctx) {
        const root = resolveProjectRoot(ctx.sessionManager.getCwd());
        if (!root) throw new Error("Unable to resolve workbench project root");
        const result = await executeWorkbenchTool(root, def.name, args);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
      },
    });
  }

  pi.registerCommand("wb", {
    description: "Open the local Spec & Verification Workbench Web UI for this project",
    async handler(args, ctx) {
      if (args.trim()) { ctx.ui.notify("用法: /wb — 启动并打开当前项目工作台", "info"); return; }
      syncContext(ctx);
      if (!projectRoot) { ctx.ui.notify("无法解析当前项目目录", "error"); return; }
      const info = await ensureServerForProject(projectRoot);
      connectBridge(info.url, ctx);
      openBrowserBestEffort(info.url);
      ctx.ui.setStatus("workbench-url", `WB: ${info.url}`);
      ctx.ui.notify(`工作台已就绪: ${info.url}`, "info");
    },
  });

  for (const ev of ["session_start", "session_switch", "session_branch", "session_tree", "agent_start", "agent_end"] as const) {
    pi.on(ev, (_e, ctx) => syncContext(ctx));
  }
  pi.on("tool_execution_start", (_e, ctx) => { activeTools += 1; syncContext(ctx); });
  pi.on("tool_execution_end", (_e, ctx) => { activeTools = Math.max(0, activeTools - 1); syncContext(ctx); });
  pi.on("session_shutdown", () => {
    try { socket?.close(1000, "session_shutdown"); } catch { /* ignore */ }
    socket = null;
  });
}
