#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  appendBugRegressionCriteria,
  createRequirement,
  getProjectStatus,
  getRequirement,
  initProject,
  linkRequirementGitHubIssue,
  listRequirements,
  recordReviewReport,
  spawnSubRequirements,
  updateProjectConfig,
} from "../core/engine.ts";
import { discardStagedAttachments, stageUpload } from "../core/attachments.ts";
import { WorkbenchError } from "../core/errors.ts";
import { canonicalRoot, readBoundedText } from "../core/fs.ts";
import { getGitRemoteUrl, observeGitSnapshot } from "../core/git.ts";
import {
  buildRequirementIssueBody,
  createGitHubIssue,
  inspectGitHubEnvironment,
  parseGitHubRepoFromRemoteUrl,
  viewGitHubIssue,
} from "../core/github.ts";
import { DEFAULT_OUTPUT_LANGUAGE, normalizeOutputLanguage, resolveEffectiveOutputLanguage } from "../core/language.ts";
import { runAllVerifications } from "../core/runner.ts";
import { resolveCodeRoot, resolveWorkbenchRootFromCwd } from "../core/sandbox.ts";
import {
  REVIEW_VERDICTS,
  type CriterionInput,
  type OutputLanguage,
  type PrivacyMode,
  type RequirementKind,
  type ReviewVerdict,
} from "../core/types.ts";
import { discoverHarnessesQuick } from "../hub/discovery.ts";
import { isAutoRegistrableProjectRoot, readHubConfig, registerHubProject, updateHubPreferences } from "../hub/registry.ts";
import { buildInitialProjectRouting } from "../hub/routing.ts";
import { startMcpServer } from "../mcp/server.ts";
import { executeWorkbenchTool } from "../mcp/tools.ts";
import { ensureAuthCredentials, isLoopbackBind, resetAuthPassword } from "../server/auth.ts";
import { startWorkbenchServer } from "../server/index.ts";
import { getDaemonStatus, lanUrlFor, openUrlInBrowser, startDaemon, stopDaemon } from "./daemon.ts";
import {
  createNodeServiceManager,
  defaultNodeIdentity,
  promptNodePassword,
  readNodeConfig,
  runNodeForeground,
  startDetachedNode,
  type NodeConfig,
} from "./node_service.ts";
import * as userService from "./service.ts";

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Map<string, string | boolean>;
  /** 可重复参数（目前仅 --attach） */
  attachments: string[];
}

/**
 * 前台 `wb serve` 的默认地址必须保持稳定：浏览器 localStorage 按 origin 隔离，
 * 每次重启都换随机端口会让同一仓库的 Gitee 筛选偏好看起来“丢失”。
 * 仍可通过显式 `--port 0` 申请随机端口。
 */
export const DEFAULT_FOREGROUND_SERVE_PORT = 4318;

export function resolveForegroundServePort(portFlag: string | boolean | undefined): number {
  return typeof portFlag === "string" ? Number(portFlag) : DEFAULT_FOREGROUND_SERVE_PORT;
}

function parseCliArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  const attachments: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq !== -1) {
        const key = token.slice(2, eq);
        const value = token.slice(eq + 1);
        if (key === "attach") attachments.push(value);
        else flags.set(key, value);
      } else if (token === "--attach") {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          attachments.push(next);
          i += 1;
        }
      } else {
        const key = token.slice(2);
        const next = argv[i + 1];
        const booleanFlags = new Set(["json", "diff", "local", "tracked", "all", "help", "fast-track", "sota", "global"]);
        const isBoolean = booleanFlags.has(key) || (key === "hub" && positionals[0] !== "node");
        if (!isBoolean && next !== undefined && !next.startsWith("--")) {
          flags.set(key, next);
          i += 1;
        } else {
          flags.set(key, true);
        }
      }
    } else if (token === "-h") {
      flags.set("help", true);
    } else {
      positionals.push(token);
    }
  }

  const command = positionals.shift() ?? "help";
  return { command, positionals, flags, attachments };
}

function resolveDefaultRoot(): string {
  if (process.env.WORKBENCH_ROOT) {
    return canonicalRoot(process.env.WORKBENCH_ROOT);
  }
  const cwd = process.cwd();
  const sandboxMain = resolveWorkbenchRootFromCwd(cwd);
  if (sandboxMain) {
    return sandboxMain;
  }
  try {
    const gitTop = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (gitTop) return canonicalRoot(gitTop);
  } catch {
    // Fallback to cwd when not inside a git repo.
  }
  return canonicalRoot(cwd);
}

function readValueOrFile(raw: string): string {
  if (!raw.startsWith("@") || raw.length === 1) return raw;
  const target = path.resolve(process.cwd(), raw.slice(1));
  return readBoundedText(target, 512 * 1024);
}

function parseJsonValue<T>(raw: string, label: string): T {
  const text = readValueOrFile(raw);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new WorkbenchError("invalid_input", `${label} 不是合法的 JSON`);
  }
}

function stageCliAttachments(paths: string[]): string[] {
  if (paths.length === 0) return [];
  const inputs = paths.map((raw) => {
    const target = path.resolve(process.cwd(), raw);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(target);
    } catch {
      throw new WorkbenchError("invalid_input", `附件文件不存在: ${raw}`);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new WorkbenchError("invalid_input", `附件必须是普通文件: ${raw}`);
    }
    return { name: path.basename(target), bytes: fs.readFileSync(target) };
  });
  return stageUpload(inputs).map((meta) => meta.id);
}

function printResult(data: unknown, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  if (typeof data === "string") {
    process.stdout.write(`${data}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function helpText(): string {
  return [
    "Workbench CLI (wb) — Lightweight SDD + VDD Agent Workbench",
    "",
    "用法: wb [--root <path>] [--json] <command> [args]",
    "",
    "命令:",
    "  start [--port 4318] [--host 127.0.0.1]     启动全局常驻 Workbench Hub 守护进程",
    "  stop                                       停止全局 Workbench Hub 守护进程",
    "  restart [--port 4318]                      重启全局 Workbench Hub 守护进程",
    "  status                                     查看守护进程与已纳管项目状态",
    "  open                                       确保 Hub 运行并在浏览器打开工作台",
    "  service install [--port 4318] [--host <addr>] 安装并启动当前用户的原生 Hub 服务；--host 0.0.0.0 启用局域网访问",
    "  service start|stop|restart|status|password|uninstall 管理当前用户的原生 Hub 服务；password 重置局域网访问密码",
    "  node install --hub <url> [--token <pwd>] [--id <id>] [--name <name>]",
    "                                             安装远程节点自启后台服务（供 WSL2 接入主控 Hub）",
    "  node start|stop|restart|status|uninstall|connect 管理远程节点轻量桥接服务",
    "  node reconnect                             重连已配置的节点，按需输入当前 Hub 访问密码",
    "  init [--name <name>] [--local|--tracked]   初始化项目 .workbench/ 存储",
    "       [--lang <zh-CN|en|auto>]",
    "  config [--global] [--output-language <zh-CN|en|auto|inherit>]",
    "         [--github-repo <owner/repo>] [--auto-create-issue true|false]",
    "         [--fast-command <cmd>] [--full-command <cmd>]",
    "                                             查看或修改全局/项目输出语言、GitHub 与分层验证配置",
    "  github status | import <issueRef> | link-issue <REQ-ID> [issueRef]",
    "                                             GitHub 仓库探测、Issue 导入或关联",
    "  list [--scope active|done|cancelled|all]   列出需求摘要",
    "  get <REQ-ID> [--diff]                      查看需求详情与覆盖状态",
    "  create <goal|@file> [--title <title>] [--parent <REQ-ID>] [--sota] [--attach <文件路径> ...]",
    "                                             创建一条新需求（--attach 可重复，--sota 启用旗舰主程）",
    "  spawn <REQ-ID> [--fast-track]              从父需求的方案章节一键派生子需求",
    "  propose <REQ-ID> [--title] [--spec]        提交或更新规范、验收条件与技术方案",
    "                   [--design] [--criteria] [--summary] [--revision <n>]",
    "  screenshot <REQ-ID> [--label <text>]       采集 UI 截图验收证据（浏览器缺失时记录跳过批次）",
    "  verify <REQ-ID> (--cmd <cmd> [--criteria AC-1,AC-2] | --all [--force]) [--timeout <ms>]",
    "                                             运行真实验证命令并记录不可变证据",
    "  review <REQ-ID> --verdict <pass|concern|block> --summary <text> [--body <md|@file>]",
    "                                             提交跨模型代码审查结论（不绕过人工验收）",
    "  mcp                                        启动标准 MCP Server (stdio)",
    "  serve [--hub] [--port <n>] [--host <addr>] 前台启动 HTTP/WS 服务与 Web UI",
    "",
    "注: 批准方案与最终验收只能由人类在 Web UI 界面完成，CLI 与 MCP 不提供审批绕过命令。",
  ].join("\n");
}

export async function runCli(argv: string[], services: Pick<typeof userService, "readServiceInstallation" | "installUserService" | "controlUserService"> = userService): Promise<number> {
  const parsed = parseCliArgs(argv);
  const asJson = parsed.flags.get("json") === true;

  if (parsed.flags.get("help") === true || parsed.command === "help") {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }

  try {
    const rootArg = parsed.flags.get("root");
    const root =
      parsed.command === "service" || parsed.command === "node"
        ? process.cwd()
        : typeof rootArg === "string"
          ? canonicalRoot(rootArg)
          : resolveDefaultRoot();

    switch (parsed.command) {
      case "service": {
        const action = parsed.positionals[0];
        if (!action || !["install", "uninstall", "start", "stop", "restart", "status", "password"].includes(action) || parsed.positionals.length !== 1) {
          throw new WorkbenchError("invalid_input", "用法: wb service install [--port <1..65535>] [--host <addr>] | start | stop | restart | status | password | uninstall");
        }
        for (const flag of parsed.flags.keys()) {
          if (flag !== "json" && flag !== "root" && !(action === "install" && (flag === "port" || flag === "host"))) {
            throw new WorkbenchError("invalid_input", `未知服务参数: --${flag}`);
          }
        }
        if (action === "password") {
          const { password } = resetAuthPassword();
          if (asJson) {
            printResult({ password }, true);
          } else {
            process.stdout.write(`已生成新的局域网访问密码（同样用于 wb node --token）：\n\n  ${password}\n\n请妥善保存；浏览器登录或 WSL2 接入时输入此密码即可。\n`);
          }
          return 0;
        }
        const portFlag = parsed.flags.get("port");
        if (portFlag !== undefined && (typeof portFlag !== "string" || !/^\d+$/.test(portFlag) || Number(portFlag) < 1 || Number(portFlag) > 65535)) {
          throw new WorkbenchError("invalid_input", `无效端口号: ${String(portFlag)}`);
        }
        const hostFlag = parsed.flags.get("host");
        if (hostFlag !== undefined && (typeof hostFlag !== "string" || !hostFlag.trim())) {
          throw new WorkbenchError("invalid_input", `无效监听地址: ${String(hostFlag)}`);
        }
        const preCreds =
          action === "install" && typeof hostFlag === "string" && !isLoopbackBind(hostFlag.trim())
            ? ensureAuthCredentials()
            : null;
        const result = action === "install"
          ? await services.installUserService({
              ...(typeof portFlag === "string" ? { port: Number(portFlag) } : {}),
              ...(typeof hostFlag === "string" ? { host: hostFlag.trim() } : {}),
            })
          : await services.controlUserService(action as "start" | "stop" | "restart" | "status" | "uninstall");
        printResult(
          preCreds?.password ? { ...result, generatedPassword: preCreds.password } : result,
          asJson,
        );
        if (!asJson && action === "install" && typeof hostFlag === "string" && !isLoopbackBind(hostFlag.trim())) {
          if (preCreds?.password) {
            process.stderr.write(`\n首次开启局域网访问，已自动生成访问密码：${preCreds.password}\n`);
          } else {
            process.stderr.write(`\n局域网密码已存在；如需查看或重置，请运行：wb service password\n`);
          }
        }
        return 0;
      }

      case "node": {
        const action = parsed.positionals[0];
        if (!action || !["install", "start", "stop", "restart", "reconnect", "status", "uninstall", "connect"].includes(action) || parsed.positionals.length !== 1) {
          throw new WorkbenchError(
            "invalid_input",
            "用法: wb node install --hub <url> [--token <pwd>] [--id <id>] [--name <name>] | start | stop | restart | reconnect | status | uninstall | connect",
          );
        }
        const allowedFlags = new Set(action === "reconnect" ? ["json", "root"] : ["json", "root", "hub", "token", "id", "name"]);
        for (const flag of parsed.flags.keys()) {
          if (!allowedFlags.has(flag)) throw new WorkbenchError("invalid_input", `未知 node 参数: --${flag}`);
        }
        const nodeMgr = createNodeServiceManager();
        if (action === "reconnect") {
          const result = await nodeMgr.reconnect(() => {
            if (asJson) throw new WorkbenchError("invalid_input", "请在交互终端运行 wb node reconnect 更新 Hub 访问密码。");
            return promptNodePassword();
          });
          if (asJson) {
            printResult(result, true);
          } else if (result.connected) {
            printResult(`节点 ${result.nodeName} 已连接到 Hub。`, false);
          } else {
            const detail = result.lastError ? `（${result.lastError}）` : "";
            throw new WorkbenchError("execution_failed", `凭据验证成功，节点尚未建立 WebSocket 连接${detail}。`);
          }
          return result.connected ? 0 : 1;
        }
        if (action === "status" || action === "stop" || action === "uninstall" || action === "restart") {
          const result = await nodeMgr.controlService(action);
          printResult(result, asJson);
          return 0;
        }

        const existingCfg = readNodeConfig();
        const defaults = defaultNodeIdentity();
        const hubFlag = parsed.flags.get("hub");
        const tokenFlag = parsed.flags.get("token");
        const idFlag = parsed.flags.get("id");
        const nameFlag = parsed.flags.get("name");
        const hubUrl = typeof hubFlag === "string" && hubFlag.trim() ? hubFlag.trim() : existingCfg?.hubUrl;
        const token = typeof tokenFlag === "string" && tokenFlag.trim() ? tokenFlag.trim() : existingCfg?.token;
        const nodeId = typeof idFlag === "string" && idFlag.trim() ? idFlag.trim() : existingCfg?.nodeId ?? defaults.nodeId;
        const nodeName = typeof nameFlag === "string" && nameFlag.trim() ? nameFlag.trim() : existingCfg?.nodeName ?? defaults.nodeName;

        if (action === "install") {
          if (!hubUrl) {
            throw new WorkbenchError("invalid_input", "请提供主控 Hub 地址，例如: wb node install --hub http://192.168.1.10:4318 --token <密码>");
          }
          const cfg: NodeConfig = { schemaVersion: 1, hubUrl, ...(token ? { token } : {}), nodeId, nodeName };
          const status = await nodeMgr.installService(cfg);
          printResult(status, asJson);
          return 0;
        }

        if (action === "start") {
          if (nodeMgr.readInstallation() && typeof hubFlag !== "string" && typeof tokenFlag !== "string") {
            const status = await nodeMgr.controlService("start");
            printResult(status, asJson);
            return 0;
          }
          if (!hubUrl) {
            throw new WorkbenchError("invalid_input", "尚未配置远程节点；请传入 --hub http://<ubuntu-ip>:4318 --token <密码>");
          }
          const cfg: NodeConfig = { schemaVersion: 1, hubUrl, ...(token ? { token } : {}), nodeId, nodeName };
          const status = await startDetachedNode(cfg);
          printResult(status, asJson);
          return 0;
        }

        // action === "connect"
        if (!hubUrl) {
          throw new WorkbenchError("invalid_input", "尚未配置远程节点；请传入 --hub http://<ubuntu-ip>:4318 --token <密码>");
        }
        const cfg: NodeConfig = { schemaVersion: 1, hubUrl, ...(token ? { token } : {}), nodeId, nodeName };
        if (!asJson) {
          process.stderr.write(`正在以节点 ${cfg.nodeName} (${cfg.nodeId}) 连接 Hub: ${cfg.hubUrl} ...\n`);
        }
        await runNodeForeground(cfg);
        return 0;
      }

      case "start": {
        const installation = services.readServiceInstallation();
        const portFlag = parsed.flags.get("port");
        const hostFlag = parsed.flags.get("host");
        const expectedHost = installation?.host ?? "127.0.0.1";
        const port = typeof portFlag === "string" ? Number(portFlag) : installation?.port ?? 4318;
        const hostname = typeof hostFlag === "string" ? hostFlag : expectedHost;
        if ((portFlag !== undefined && typeof portFlag !== "string") || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
          throw new WorkbenchError("invalid_input", `无效端口号: ${String(portFlag)}`);
        }
        if (installation && (port !== installation.port || hostname !== expectedHost || hostFlag === true)) {
          throw new WorkbenchError(
            "invalid_input",
            `已托管的 Hub 固定监听 ${expectedHost}:${installation.port}；请使用 wb service install --port <端口> --host <地址> 修改安装配置`,
          );
        }
        const maybeGitOrWb = isAutoRegistrableProjectRoot(root);
        if (maybeGitOrWb) {
          registerHubProject(root, { activate: true });
        }
        if (installation) {
          const service = await services.controlUserService("start");
          const daemon = await getDaemonStatus();
          printResult({ ...daemon.info, started: service.healthy, service }, asJson);
          return 0;
        }
        const creds = !isLoopbackBind(hostname) ? ensureAuthCredentials() : null;
        const res = await startDaemon({
          port,
          hostname,
          registerRoot: maybeGitOrWb ? root : undefined,
        });
        const lanUrl = lanUrlFor(hostname, res.info.port);
        printResult({ ...res.info, started: res.started, ...(lanUrl ? { lanUrl } : {}), ...(creds?.password ? { generatedPassword: creds.password } : {}) }, asJson);
        return 0;
      }

      case "stop": {
        if (services.readServiceInstallation()) {
          printResult(await services.controlUserService("stop"), asJson);
          return 0;
        }
        const res = await stopDaemon();
        printResult(res, asJson);
        return 0;
      }

      case "restart": {
        const installation = services.readServiceInstallation();
        const portFlag = parsed.flags.get("port");
        const hostFlag = parsed.flags.get("host");
        const expectedHost = installation?.host ?? "127.0.0.1";
        const port = typeof portFlag === "string" ? Number(portFlag) : installation?.port ?? 4318;
        const hostname = typeof hostFlag === "string" ? hostFlag : expectedHost;
        if ((portFlag !== undefined && typeof portFlag !== "string") || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
          throw new WorkbenchError("invalid_input", `无效端口号: ${String(portFlag)}`);
        }
        if (installation) {
          if (port !== installation.port || hostname !== expectedHost || hostFlag === true) {
            throw new WorkbenchError(
              "invalid_input",
              `已托管的 Hub 固定监听 ${expectedHost}:${installation.port}；请使用 wb service install --port <端口> --host <地址> 修改安装配置`,
            );
          }
          const service = await services.controlUserService("restart");
          const daemon = await getDaemonStatus();
          printResult({ ...daemon.info, restarted: true, service }, asJson);
          return 0;
        }
        await stopDaemon();
        const res = await startDaemon({ port, hostname });
        printResult({ ...res.info, restarted: true }, asJson);
        return 0;
      }

      case "status": {
        const service = services.readServiceInstallation() ? await services.controlUserService("status") : null;
        const status = await getDaemonStatus();
        printResult({ ...status, service }, asJson);
        return 0;
      }

      case "open": {
        const installation = services.readServiceInstallation();
        if (installation) {
          const expectedHost = installation.host ?? "127.0.0.1";
          const portFlag = parsed.flags.get("port");
          const hostFlag = parsed.flags.get("host");
          if ((portFlag !== undefined && (typeof portFlag !== "string" || Number(portFlag) !== installation.port)) || (hostFlag !== undefined && hostFlag !== expectedHost)) {
            throw new WorkbenchError(
              "invalid_input",
              `已托管的 Hub 固定监听 ${expectedHost}:${installation.port}；请使用 wb service install --port <端口> --host <地址> 修改安装配置`,
            );
          }
        }
        const maybeGitOrWb = isAutoRegistrableProjectRoot(root);
        if (maybeGitOrWb) {
          registerHubProject(root, { activate: true });
        }
        if (installation) {
          const service = await services.controlUserService("start");
          if (!service.healthy || !service.url) throw new WorkbenchError("execution_failed", "用户服务未通过健康检查，不能打开 Web");
          const localOpenUrl = service.url.replace("://0.0.0.0:", "://127.0.0.1:").replace("://[::]:", "://[::1]:");
          openUrlInBrowser(localOpenUrl);
          printResult({ url: service.url, service }, asJson);
          return 0;
        }
        const res = await startDaemon({ registerRoot: maybeGitOrWb ? root : undefined });
        openUrlInBrowser(res.info.url);
        printResult({ url: res.info.url, pid: res.info.pid }, asJson);
        return 0;
      }

      case "mcp": {
        await startMcpServer(root);
        return 0;
      }

      case "serve": {
        const portFlag = parsed.flags.get("port");
        const hostFlag = parsed.flags.get("host");
        const hubMode = parsed.flags.get("hub") === true;
        const port = resolveForegroundServePort(portFlag);
        const hostname = typeof hostFlag === "string" ? hostFlag : "127.0.0.1";
        if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
          throw new WorkbenchError("invalid_input", `无效端口号: ${String(portFlag)}`);
        }
        const handle = await startWorkbenchServer({ root, port, hostname, hubMode });
        printResult({ url: handle.url, port: handle.port, root: handle.root, pid: process.pid, hubMode }, asJson);
        await new Promise<void>((resolve) => {
          const shutdown = () => {
            handle.stop();
            resolve();
          };
          process.once("SIGINT", shutdown);
          process.once("SIGTERM", shutdown);
        });
        return 0;
      }

      case "init": {
        const privacyMode: PrivacyMode = parsed.flags.get("tracked") === true ? "tracked" : "local";
        const nameFlag = parsed.flags.get("name");
        const langFlag = parsed.flags.get("lang");
        let outputLanguage: OutputLanguage | undefined;
        if (langFlag !== undefined) {
          outputLanguage = typeof langFlag === "string" ? normalizeOutputLanguage(langFlag) : undefined;
          if (!outputLanguage) {
            throw new WorkbenchError("invalid_input", `不支持的输出语言: ${String(langFlag)}（可选: zh-CN, en, auto）`);
          }
        }
        const meta = await initProject(root, {
          name: typeof nameFlag === "string" ? nameFlag : undefined,
          privacyMode,
          routing: buildInitialProjectRouting(discoverHarnessesQuick()),
          ...(outputLanguage ? { outputLanguage } : {}),
        });
        printResult(meta, asJson);
        return 0;
      }

      case "config": {
        const isGlobal = parsed.flags.get("global") === true;
        const langFlag = parsed.flags.get("output-language");
        const repoFlag = parsed.flags.get("github-repo");
        const autoCreateFlag = parsed.flags.get("auto-create-issue");
        const autoSyncFlag = parsed.flags.get("auto-sync-issue");
        const baseBranchFlag = parsed.flags.get("base-branch");
        const fastCmdFlag = parsed.flags.get("fast-command");
        const fullCmdFlag = parsed.flags.get("full-command");

        if (isGlobal) {
          if (langFlag !== undefined) {
            const valid = typeof langFlag === "string" ? normalizeOutputLanguage(langFlag) : undefined;
            if (!valid) {
              throw new WorkbenchError("invalid_input", `全局输出语言必须是 zh-CN | en | auto: ${String(langFlag)}`);
            }
            const nextHub = updateHubPreferences({ outputLanguage: valid });
            printResult({ scope: "hub", outputLanguage: nextHub.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE }, asJson);
            return 0;
          }
          const hubCfg = readHubConfig();
          printResult({ scope: "hub", outputLanguage: hubCfg.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE }, asJson);
          return 0;
        }

        const hasProjectUpdates =
          langFlag !== undefined ||
          repoFlag !== undefined ||
          autoCreateFlag !== undefined ||
          autoSyncFlag !== undefined ||
          baseBranchFlag !== undefined ||
          fastCmdFlag !== undefined ||
          fullCmdFlag !== undefined;

        if (hasProjectUpdates) {
          let langPatch: OutputLanguage | null | undefined;
          if (langFlag === "inherit") {
            langPatch = null;
          } else if (langFlag !== undefined) {
            const valid = typeof langFlag === "string" ? normalizeOutputLanguage(langFlag) : undefined;
            if (!valid) {
              throw new WorkbenchError("invalid_input", `输出语言必须是 zh-CN | en | auto | inherit: ${String(langFlag)}`);
            }
            langPatch = valid;
          }
          const parseBoolFlag = (v: string | boolean | undefined): boolean | undefined => {
            if (v === undefined) return undefined;
            if (v === true || v === "true") return true;
            if (v === false || v === "false") return false;
            throw new WorkbenchError("invalid_input", `布尔参数值无效: ${String(v)}`);
          };
          const ghPatch =
            repoFlag !== undefined || autoCreateFlag !== undefined || autoSyncFlag !== undefined || baseBranchFlag !== undefined
              ? {
                  ...(typeof repoFlag === "string" ? { repo: repoFlag } : {}),
                  ...(typeof baseBranchFlag === "string" ? { defaultBaseBranch: baseBranchFlag } : {}),
                  ...(autoCreateFlag !== undefined ? { autoCreateIssue: parseBoolFlag(autoCreateFlag) } : {}),
                  ...(autoSyncFlag !== undefined ? { autoSyncIssue: parseBoolFlag(autoSyncFlag) } : {}),
                }
              : undefined;

          const verPatch =
            fastCmdFlag !== undefined || fullCmdFlag !== undefined
              ? {
                  ...(typeof fastCmdFlag === "string" ? { fastCommand: fastCmdFlag } : {}),
                  ...(typeof fullCmdFlag === "string" ? { fullCommand: fullCmdFlag } : {}),
                }
              : undefined;

          const updated = await updateProjectConfig(root, {
            ...(langPatch !== undefined ? { outputLanguage: langPatch } : {}),
            ...(ghPatch !== undefined ? { github: ghPatch } : {}),
            ...(verPatch !== undefined ? { verification: verPatch } : {}),
          });
          printResult({ scope: "project", project: updated }, asJson);
          return 0;
        }

        const hubCfg = readHubConfig();
        const proj = getProjectStatus(root).project;
        printResult(
          {
            hubOutputLanguage: hubCfg.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE,
            projectOutputLanguage: proj?.outputLanguage ?? null,
            effectiveOutputLanguage: resolveEffectiveOutputLanguage({
              projectLanguage: proj?.outputLanguage,
              hubLanguage: hubCfg.outputLanguage,
            }),
            github: proj?.github ?? null,
            verification: proj?.verification ?? null,
          },
          asJson,
        );
        return 0;
      }

      case "github": {
        const subCmd = parsed.positionals[0] ?? "status";
        const projectMeta = getProjectStatus(root).project;
        if (subCmd === "status") {
          const status = await inspectGitHubEnvironment(root, projectMeta?.github);
          printResult(status, asJson);
          return 0;
        }
        if (subCmd === "import") {
          const issueRef = parsed.positionals[1];
          if (!issueRef) throw new WorkbenchError("invalid_input", "请提供 Issue 编号或 URL，例如: wb github import 42");
          const remoteRepo = projectMeta?.github?.repo ?? parseGitHubRepoFromRemoteUrl(await getGitRemoteUrl(root));
          const issue = await viewGitHubIssue({ root, repo: remoteRepo, issueRef });
          const snap = await observeGitSnapshot(root);
          const existing = listRequirements(root, { scope: "all", currentCodeSnapshotHash: snap?.fingerprint ?? null }).find(
            (i) => i.github?.repo === issue.repo && i.github?.issue?.number === issue.number,
          );
          if (existing) {
            printResult({ alreadyExisted: true, id: existing.id, issue }, asJson);
            return 0;
          }
          const created = await createRequirement(root, {
            title: issue.title,
            goal: `# ${issue.title}\n\n> 导入自 GitHub Issue: ${issue.url}\n\n${issue.body || issue.title}`,
            currentCodeSnapshotHash: snap?.fingerprint ?? null,
          });
          const linked = await linkRequirementGitHubIssue(root, created.state.id, {
            repo: issue.repo,
            issue: {
              number: issue.number,
              url: issue.url,
              title: issue.title,
              state: issue.state,
              lastSyncedAt: Date.now(),
            },
            currentCodeSnapshotHash: snap?.fingerprint ?? null,
          });
          printResult({ alreadyExisted: false, id: linked.state.id, github: linked.state.github }, asJson);
          return 0;
        }
        if (subCmd === "link-issue") {
          const reqId = parsed.positionals[1];
          const issueRef = parsed.positionals[2];
          if (!reqId) throw new WorkbenchError("invalid_input", "用法: wb github link-issue <REQ-ID> [issueRef]");
          const snap = await observeGitSnapshot(resolveCodeRoot(root, reqId));
          const detail = getRequirement(root, reqId, { currentCodeSnapshotHash: snap?.fingerprint ?? null });
          if (issueRef) {
            const remoteRepo = projectMeta?.github?.repo ?? parseGitHubRepoFromRemoteUrl(await getGitRemoteUrl(root));
            const issue = await viewGitHubIssue({ root, repo: remoteRepo, issueRef });
            const linked = await linkRequirementGitHubIssue(root, reqId, {
              repo: issue.repo,
              issue: {
                number: issue.number,
                url: issue.url,
                title: issue.title,
                state: issue.state,
                lastSyncedAt: Date.now(),
              },
              currentCodeSnapshotHash: snap?.fingerprint ?? null,
            });
            printResult({ id: linked.state.id, github: linked.state.github }, asJson);
            return 0;
          }
          const env = await inspectGitHubEnvironment(root, projectMeta?.github);
          if (!env.ready || !env.repo) {
            throw new WorkbenchError("execution_failed", env.reason ?? "GitHub CLI 环境未就绪");
          }
          const issue = await createGitHubIssue({
            root,
            repo: env.repo,
            title: `[${reqId}] ${detail.state.title}`,
            body: buildRequirementIssueBody(detail),
          });
          const linked = await linkRequirementGitHubIssue(root, reqId, {
            repo: env.repo,
            issue,
            currentCodeSnapshotHash: snap?.fingerprint ?? null,
          });
          printResult({ id: linked.state.id, github: linked.state.github }, asJson);
          return 0;
        }
        throw new WorkbenchError("invalid_input", `未知 github 子命令: ${subCmd}（支持 status | import | link-issue）`);
      }

      case "list": {
        const scope = parsed.flags.get("scope");
        const stage = parsed.flags.get("stage");
        const res = (await executeWorkbenchTool(root, "wb_list", {
          ...(typeof scope === "string" ? { scope } : {}),
          ...(typeof stage === "string" ? { stage } : {}),
        })) as { items: Array<Record<string, unknown>>; total: number };
        if (asJson) {
          printResult(res, true);
        } else if (res.items.length === 0) {
          process.stdout.write("暂无匹配的需求。\n");
        } else {
          for (const item of res.items) {
            process.stdout.write(`${item.id}  [${item.stage}]  ${item.title}  (${item.progressText})\n`);
          }
        }
        return 0;
      }

      case "get": {
        const id = parsed.positionals[0];
        if (!id) throw new WorkbenchError("invalid_input", "请提供需求编号，例如: wb get REQ-001");
        const res = await executeWorkbenchTool(root, "wb_get", {
          id,
          includeDiff: parsed.flags.get("diff") === true,
        });
        printResult(res, asJson);
        return 0;
      }

      case "create": {
        const goalRaw = parsed.positionals[0];
        if (!goalRaw) throw new WorkbenchError("invalid_input", "请提供需求目标描述或 @文件路径");
        const goal = readValueOrFile(goalRaw);
        const titleFlag = parsed.flags.get("title");
        const parentFlag = parsed.flags.get("parent");
        const kindFlag = parsed.flags.get("kind");
        const kind: RequirementKind | undefined =
          kindFlag === "bug" ? "bug" : kindFlag === "feature" ? "feature" : undefined;
        if (typeof kindFlag === "string" && kindFlag !== "bug" && kindFlag !== "feature") {
          throw new WorkbenchError("invalid_input", `无效的 kind: ${kindFlag}（应为 feature 或 bug）`);
        }
        const attachmentIds = stageCliAttachments(parsed.attachments);
        let detail: Awaited<ReturnType<typeof createRequirement>>;
        try {
          detail = await createRequirement(root, {
            goal,
            ...(kind ? { kind } : {}),
            title: typeof titleFlag === "string" ? titleFlag : undefined,
            parentId: typeof parentFlag === "string" ? parentFlag : undefined,
            track: parsed.flags.get("fast-track") === true ? "fast_track" : "plan_first",
            tier: parsed.flags.get("sota") === true ? "sota" : "standard",
            ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          });
        } catch (error) {
          discardStagedAttachments(attachmentIds);
          throw error;
        }
        printResult(
          {
            id: detail.state.id,
            kind: detail.state.kind ?? "feature",
            ...(detail.state.parentId ? { parentId: detail.state.parentId } : {}),
            title: detail.state.title,
            stage: detail.state.stage,
            track: detail.state.track,
            revision: detail.state.revision,
            attachments: detail.state.attachments ?? [],
          },
          asJson,
        );
        return 0;
      }

      case "spawn": {
        const parentId = parsed.positionals[0];
        if (!parentId) throw new WorkbenchError("invalid_input", "请提供父需求编号，例如: wb spawn REQ-001");
        const snap = await observeGitSnapshot(root);
        const res = await spawnSubRequirements(root, parentId, {
          track: parsed.flags.get("fast-track") === true ? "fast_track" : "plan_first",
          currentCodeSnapshotHash: snap?.fingerprint ?? null,
        });
        printResult(
          {
            parentId: res.parent.state.id,
            created: res.created.map((c) => ({
              id: c.state.id,
              title: c.state.title,
              stage: c.state.stage,
              track: c.state.track,
            })),
          },
          asJson,
        );
        return 0;
      }

      case "propose": {
        const id = parsed.positionals[0];
        if (!id) throw new WorkbenchError("invalid_input", "请提供需求编号，例如: wb propose REQ-001 ...");
        const title = parsed.flags.get("title");
        const spec = parsed.flags.get("spec");
        const design = parsed.flags.get("design");
        const criteria = parsed.flags.get("criteria");
        const summary = parsed.flags.get("summary");
        const revision = parsed.flags.get("revision");

        const payload: Record<string, unknown> = { id };
        if (typeof title === "string") payload.title = title;
        if (typeof spec === "string") payload.spec = readValueOrFile(spec);
        if (typeof design === "string") payload.design = readValueOrFile(design);
        if (typeof criteria === "string") payload.criteria = parseJsonValue<CriterionInput[]>(criteria, "criteria");
        if (typeof summary === "string") payload.summary = summary;
        if (typeof revision === "string") payload.expectedRevision = Number(revision);

        const res = await executeWorkbenchTool(root, "wb_propose", payload);
        printResult(res, asJson);
        return 0;
      }

      case "bug-criteria": {
        const id = parsed.positionals[0];
        if (!id) throw new WorkbenchError("invalid_input", "请提供需求编号，例如: wb bug-criteria REQ-001 --criteria '[...]'");
        const criteriaFlag = parsed.flags.get("criteria");
        if (typeof criteriaFlag !== "string") {
          throw new WorkbenchError("invalid_input", "请通过 --criteria 提供要追加的回归测试验收条件 JSON 数组");
        }
        const criteria = parseJsonValue<CriterionInput[]>(criteriaFlag, "criteria");
        const revision = parsed.flags.get("revision");
        const snap = await observeGitSnapshot(resolveCodeRoot(root, id));
        const detail = await appendBugRegressionCriteria(root, id, {
          criteria,
          actor: "agent",
          ...(typeof revision === "string" ? { expectedRevision: Number(revision) } : {}),
          currentCodeSnapshotHash: snap?.fingerprint ?? null,
        });
        printResult(
          {
            id: detail.state.id,
            revision: detail.state.revision,
            criteriaCount: detail.state.criteria.length,
          },
          asJson,
        );
        return 0;
      }

      case "screenshot": {
        const id = parsed.positionals[0];
        if (!id) throw new WorkbenchError("invalid_input", "请提供需求编号，例如: wb screenshot REQ-001 --label \"验收截图\"");
        const label = parsed.flags.get("label");
        const res = await executeWorkbenchTool(root, "wb_screenshot", {
          id,
          ...(typeof label === "string" && label.trim() ? { label: label.trim() } : {}),
        });
        printResult(res, asJson);
        return 0;
      }

      case "verify": {
        const id = parsed.positionals[0];
        if (!id) throw new WorkbenchError("invalid_input", "请提供需求编号，例如: wb verify REQ-001 --cmd ...");
        const timeoutFlag = parsed.flags.get("timeout");
        const timeoutMs = typeof timeoutFlag === "string" ? Number(timeoutFlag) : undefined;

        if (parsed.flags.get("all") === true) {
          const runAction = process.env.WORKBENCH_RUN_ACTION?.trim();
          if (process.env.WORKBENCH_HUB_PID?.trim() && (runAction === "implement" || runAction === "fix")) {
            throw new WorkbenchError(
              "invalid_transition",
              "当前处于工作台托管的编码/修复会话中，禁止手动执行 wb verify --all；请仅运行快速或定向测试并直接结束本轮，宿主将在退出后统一执行完整验收。",
            );
          }
          const force = parsed.flags.get("force") === true;
          const allRes = await runAllVerifications(root, id, {
            timeoutMs,
            force,
            onProgress: (line) => process.stderr.write(line),
          });
          printResult(
            {
              id: allRes.detail.state.id,
              stage: allRes.detail.state.stage,
              runs: allRes.runs.map((r) => ({
                id: r.record.id,
                command: r.record.command,
                criterionIds: r.record.criterionIds,
                passed: r.record.passed,
                exitCode: r.record.exitCode,
                ...(r.reused ? { reused: true } : {}),
              })),
              coverage: allRes.detail.validity.coverage,
            },
            asJson,
          );
          return 0;
        }

        const cmd = parsed.flags.get("cmd");
        if (typeof cmd !== "string") {
          throw new WorkbenchError("invalid_input", "请指定 --cmd <命令> 或 --all");
        }
        const criteriaFlag = parsed.flags.get("criteria");
        const criterionIds =
          typeof criteriaFlag === "string"
            ? criteriaFlag
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : [];

        const res = await executeWorkbenchTool(root, "wb_verify", {
          id,
          command: cmd,
          criterionIds,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        });
        printResult(res, asJson);
        return 0;
      }

      case "review": {
        const id = parsed.positionals[0];
        if (!id) throw new WorkbenchError("invalid_input", "请提供需求编号，例如: wb review REQ-001 --verdict pass --summary ...");
        const verdict = parsed.flags.get("verdict");
        const summary = parsed.flags.get("summary");
        if (typeof verdict !== "string" || !REVIEW_VERDICTS.includes(verdict as ReviewVerdict)) {
          throw new WorkbenchError("invalid_input", "--verdict 必须是 pass | concern | block");
        }
        if (typeof summary !== "string" || !summary.trim()) {
          throw new WorkbenchError("invalid_input", "请提供 --summary <一句话结论>");
        }
        const bodyFlag = parsed.flags.get("body");
        const markdown = typeof bodyFlag === "string" ? readValueOrFile(bodyFlag) : summary.trim();
        const harnessFlag = parsed.flags.get("harness");
        const modelFlag = parsed.flags.get("model");
        const snapshot = await observeGitSnapshot(resolveCodeRoot(root, id));
        const detail = getRequirement(root, id, { currentCodeSnapshotHash: snapshot?.fingerprint ?? null });
        const updated = await recordReviewReport(root, id, {
          reviewerHarness: typeof harnessFlag === "string" ? harnessFlag : "cli",
          reviewerModel: typeof modelFlag === "string" ? modelFlag : "manual",
          verdict: verdict as ReviewVerdict,
          summary: summary.trim(),
          markdown,
          reviewedSpecHash: detail.state.specHash,
          reviewedCodeSnapshotHash: snapshot?.fingerprint ?? detail.state.specHash,
        });
        printResult({ id: updated.state.id, reviewReport: updated.state.reviewReport }, asJson);
        return 0;
      }

      default:
        throw new WorkbenchError("invalid_input", `未知子命令: ${parsed.command}（使用 --help 查看帮助）`);
    }
  } catch (error) {
    const errPayload =
      error instanceof WorkbenchError
        ? error.toJSON()
        : { code: "execution_failed", message: error instanceof Error ? error.message : String(error) };
    if (asJson) {
      process.stderr.write(`${JSON.stringify({ error: errPayload }, null, 2)}\n`);
    } else {
      process.stderr.write(`错误 [${errPayload.code}]: ${errPayload.message}\n`);
    }
    return 1;
  }
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}
