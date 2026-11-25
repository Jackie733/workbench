#!/usr/bin/env bun
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDaemonHealthy } from "../src/cli/daemon.ts";
import { readDaemonInfo } from "../src/hub/registry.ts";
import { isRecord } from "../src/core/validate.ts";

const STEP_TIMEOUT = 10_000;
const CLI_ENTRY = path.resolve(import.meta.dir, "../src/cli/index.ts");
const TOOL_NAMES = ["wb_list", "wb_get", "wb_propose", "wb_verify", "wb_screenshot"].sort();

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseArgs(args: string[]): { root: string; url?: string } {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if ((arg !== "--root" && arg !== "--url") || flags.has(arg)) {
      throw new Error(`Unknown or repeated argument: ${arg}. Usage: bun run deploy:check [--url http://127.0.0.1:4318] --root <initialized-project-absolute-path>`);
    }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
    flags.set(arg, value);
  }
  const root = flags.get("--root");
  if (!root || !path.isAbsolute(root)) throw new Error("--root must be an explicit absolute path to an initialized project; this check never initializes a project or uses cwd implicitly.");
  return { root, url: flags.get("--url") };
}

function normalizeUrl(raw: string): string {
  const url = new URL(raw);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("--url must be an HTTP(S) Hub origin without credentials, path, query, or fragment.");
  }
  return url.origin;
}

async function fetchText(base: string, resource: string, contentTypes: string[]): Promise<string> {
  const response = await fetch(`${base}${resource}`, {
    signal: AbortSignal.timeout(STEP_TIMEOUT),
    redirect: "error",
  });
  if (response.status !== 200) throw new Error(`GET ${resource}: expected 200, received ${response.status}.`);
  const mime = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!contentTypes.includes(mime)) throw new Error(`GET ${resource}: unexpected Content-Type ${JSON.stringify(mime)}.`);
  const text = await response.text();
  if (!text.trim()) throw new Error(`GET ${resource}: empty response.`);
  return text;
}

async function checkWebSocket(base: string): Promise<void> {
  const url = new URL("/ws?role=ui", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  // Bun exposes terminate in addition to the DOM WebSocket API, allowing bounded cleanup.
  const socket = new WebSocket(url) as WebSocket & { terminate(): void };
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => reject(new Error("Timed out waiting for WebSocket /ws?role=ui open (10s).")), STEP_TIMEOUT);
  socket.onopen = () => resolve();
  socket.onerror = () => reject(new Error(`WebSocket connection failed: ${url}`));
  socket.onclose = (event) => reject(new Error(`WebSocket closed before opening (code ${event.code}).`));
  try {
    await promise;
  } finally {
    clearTimeout(timer);
    socket.onopen = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close(1000, "deployment_check_complete");
    } finally {
      socket.terminate();
    }
  }
}

async function waitUntilClosed(closed: Promise<void>, timeout: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => resolve(false), timeout);
  void closed.then(() => resolve(true));
  try {
    return await promise;
  } finally {
    clearTimeout(timer);
  }
}

async function checkMcp(root: string): Promise<void> {
  if (!fs.statSync(root).isDirectory()) throw new Error(`Project root is not a directory: ${root}`);
  const projectFile = path.join(root, ".workbench", "project.json");
  if (!fs.existsSync(projectFile)) {
    throw new Error(`Project is not initialized: ${root}. Initialize it explicitly with wb --root ${JSON.stringify(root)} init, then rerun this check.`);
  }
  fs.accessSync(projectFile, fs.constants.R_OK);
  const child = spawn(process.execPath, ["run", CLI_ENTRY, "mcp", "--root", root], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const completion = Promise.withResolvers<void>();
  const pending = new Map<number, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  let nextId = 1;
  let buffer = "";
  let stderr = "";
  let fatal: Error | null = null;
  let exited = false;

  function fail(error: Error): void {
    fatal ??= error;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(fatal);
    }
    pending.clear();
  }

  child.once("error", (error) => fail(error));
  child.once("close", (code, signal) => {
    exited = true;
    completion.resolve();
    fail(new Error(`MCP subprocess closed (exit ${code}${signal ? `, signal ${signal}` : ""}).`));
  });
  child.stdin.on("error", (error) => fail(error));
  child.stdout.on("error", (error) => fail(error));
  child.stderr.on("error", (error) => fail(error));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-64 * 1024); });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (fatal) return;
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (!isRecord(value) || value.jsonrpc !== "2.0") throw new Error("Non-JSON-RPC data on MCP stdout.");
        if (value.id === undefined && typeof value.method === "string") continue;
        if (typeof value.id !== "number" || !pending.has(value.id)) throw new Error("Unexpected MCP response id on stdout.");
        const entry = pending.get(value.id)!;
        pending.delete(value.id);
        clearTimeout(entry.timer);
        if (value.error !== undefined) {
          entry.reject(new Error(`MCP JSON-RPC error: ${JSON.stringify(value.error)}`));
        } else if (!isRecord(value.result)) {
          entry.reject(new Error("MCP response is missing an object result."));
        } else {
          entry.resolve(value.result);
        }
      } catch (error) {
        fail(new Error(`Invalid MCP stdout: ${message(error)}`));
        return;
      }
    }
  });

  function rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (fatal) return Promise.reject(fatal);
    const id = nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
    const timer = setTimeout(() => fail(new Error(`MCP ${method} timed out (10s).`)), STEP_TIMEOUT);
    pending.set(id, { resolve, reject, timer });
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    } catch (error) {
      fail(new Error(`MCP ${method} write failed: ${message(error)}`));
    }
    return promise;
  }

  try {
    try {
      const initialized = await rpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "workbench-deployment-check", version: "1.0.0" },
      });
      if (initialized.protocolVersion !== "2025-03-26" || !isRecord(initialized.capabilities) || !isRecord(initialized.capabilities.tools)) {
        throw new Error("MCP initialize did not negotiate protocol 2025-03-26 with tools support.");
      }
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      const listed = await rpc("tools/list", {});
      if (!Array.isArray(listed.tools) || listed.tools.some((tool) => !isRecord(tool) || typeof tool.name !== "string")) {
        throw new Error("MCP tools/list returned invalid tool definitions.");
      }
      const names = listed.tools.map((tool: Record<string, unknown>) => tool.name as string).sort();
      if (names.length !== TOOL_NAMES.length || names.some((name, index) => name !== TOOL_NAMES[index])) {
        throw new Error(`MCP tools/list did not expose the five Workbench tools: ${JSON.stringify(names)}.`);
      }
      const result = await rpc("tools/call", { name: "wb_list", arguments: { scope: "all" } });
      if (result.isError === true) throw new Error(`MCP wb_list failed: ${JSON.stringify(result.content)}`);
      if (!Array.isArray(result.content) || result.content.length === 0) throw new Error("MCP wb_list returned no content.");
      for (const item of result.content) {
        if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") throw new Error("MCP wb_list returned invalid text content.");
        const data: unknown = JSON.parse(item.text);
        if (!isRecord(data) || !Array.isArray(data.items) || typeof data.total !== "number" || data.total !== data.items.length) {
          throw new Error("MCP wb_list did not return a valid JSON requirement list.");
        }
      }
      if (fatal) throw fatal;
    } finally {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("MCP deployment check closed."));
      }
      pending.clear();
      try {
        child.stdin.end();
        if (!exited && !(await waitUntilClosed(completion.promise, 500))) {
          child.kill("SIGTERM");
          if (!(await waitUntilClosed(completion.promise, 500))) {
            child.kill("SIGKILL");
            if (!(await waitUntilClosed(completion.promise, 1_000))) throw new Error("MCP subprocess did not close after SIGKILL.");
          }
        }
      } finally {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
    }
  } catch (error) {
    throw new Error(`${message(error)}${stderr.trim() ? `\nMCP stderr: ${stderr.trim()}` : ""}`);
  }
}

export async function checkDeployment(args: string[]): Promise<boolean> {
  const options = parseArgs(args);
  const daemon = readDaemonInfo();
  if (!options.url && (!daemon || !(await isDaemonHealthy(daemon)))) {
    throw new Error("No healthy Hub daemon record in the current WORKBENCH_HUB_DIR. Supply --url or start the Hub explicitly; this check never starts it.");
  }
  const base = normalizeUrl(options.url ?? daemon!.url);
  let matchesLocalDaemon = false;
  if (daemon) {
    try { matchesLocalDaemon = normalizeUrl(daemon.url) === base; } catch { /* A malformed local record cannot identify an explicit remote URL. */ }
  }
  let passed = true;
  async function check(label: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
      console.log(`PASS ${label}`);
    } catch (error) {
      passed = false;
      console.error(`FAIL ${label}: ${message(error)}`);
    }
  }
  console.log(`Checking Hub ${base} and independent stdio MCP project ${options.root} (no initialization or task execution).`);
  await check("HTTP /api/health", async () => {
    const body: unknown = JSON.parse(await fetchText(base, "/api/health", ["application/json"]));
    if (!isRecord(body) || body.ok !== true || body.hubMode !== true || typeof body.serverPid !== "number" || !Number.isSafeInteger(body.serverPid) || body.serverPid <= 0) {
      throw new Error("Expected ok=true, hubMode=true, and a positive integer serverPid.");
    }
    if (matchesLocalDaemon && body.serverPid !== daemon!.pid) throw new Error(`Daemon PID mismatch: metadata ${daemon!.pid}, health ${body.serverPid}.`);
  });
  await check("HTTP / (real Web app)", async () => {
    const html = await fetchText(base, "/", ["text/html"]);
    const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
    const links = html.match(/<link\b[^>]*>/gi) ?? [];
    if (!/\bid=["']app["']/i.test(html) ||
        !scripts.some((tag) => /\btype=["']module["']/i.test(tag) && /\bsrc=["']\/app\.js["']/i.test(tag)) ||
        !links.some((tag) => /\brel=["']stylesheet["']/i.test(tag) && /\bhref=["']\/styles\.css["']/i.test(tag))) {
      throw new Error("HTML is missing the actual app mount, module entry, or stylesheet (a backend fallback page is not a working Web UI).");
    }
  });
  await check("HTTP /app.js", async () => { await fetchText(base, "/app.js", ["application/javascript", "text/javascript"]); });
  await check("HTTP /styles.css", async () => { await fetchText(base, "/styles.css", ["text/css"]); });
  await check("WS /ws?role=ui handshake", () => checkWebSocket(base));
  await check("MCP stdio initialize / tools/list / wb_list(scope=all)", () => checkMcp(options.root));
  return passed;
}

if (import.meta.main) {
  try {
    if (!(await checkDeployment(process.argv.slice(2)))) process.exitCode = 1;
  } catch (error) {
    console.error(`FAIL deployment check: ${message(error)}`);
    process.exitCode = 1;
  }
}
