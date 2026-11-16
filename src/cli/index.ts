#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequirement, getRequirement, initProject, recordReviewReport } from "../core/engine.ts";
import { WorkbenchError } from "../core/errors.ts";
import { canonicalRoot } from "../core/fs.ts";
import { observeGitSnapshot } from "../core/git.ts";
import { runAllVerifications } from "../core/runner.ts";
import { REVIEW_VERDICTS, WORKBENCH_DIR, type CriterionInput, type PrivacyMode, type ReviewVerdict, type TaskInput } from "../core/types.ts";
import { registerHubProject } from "../hub/registry.ts";
import { startMcpServer } from "../mcp/server.ts";
import { executeWorkbenchTool } from "../mcp/tools.ts";
import { startWorkbenchServer } from "../server/index.ts";
import { getDaemonStatus, openUrlInBrowser, startDaemon, stopDaemon } from "./daemon.ts";

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

function parseCliArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq !== -1) {
        flags.set(token.slice(2, eq), token.slice(eq + 1));
      } else {
        const key = token.slice(2);
        const next = argv[i + 1];
        const booleanFlags = new Set(["json", "diff", "local", "tracked", "ready", "all", "help", "fast-track", "hub"]);
        if (!booleanFlags.has(key) && next !== undefined && !next.startsWith("--")) {
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
  return { command, positionals, flags };
}

function resolveDefaultRoot(): string {
  if (process.env.WORKBENCH_ROOT) {
    return canonicalRoot(process.env.WORKBENCH_ROOT);
  }
  const cwd = process.cwd();
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
  if (!fs.existsSync(target)) {
    throw new WorkbenchError("not_found", `读取参数文件失败，文件不存在: ${raw.slice(1)}`);
  }
  return fs.readFileSync(target, "utf8");
}

function parseJsonValue<T>(raw: string, label: string): T {
  const text = readValueOrFile(raw);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new WorkbenchError("invalid_input", `${label} 不是合法的 JSON`);
  }
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
    "  init [--name <name>] [--local|--tracked]   初始化项目 .workbench/ 存储",
    "  list [--scope active|done|cancelled|all]   列出需求摘要",
    "  get <REQ-ID> [--diff]                      查看需求详情与覆盖状态",
    "  create <goal|@file> [--title <title>]      创建一条新需求草稿",
    "  propose <REQ-ID> [--title] [--spec]        提交或更新规范、验收条件与技术方案",
    "                   [--design] [--criteria] [--summary] [--revision <n>]",
    "  tasks <REQ-ID> [--tasks <json|@file>]      更新实施任务或提交待验收",
    "                 [--ready] [--note <text>] [--revision <n>]",
    "  verify <REQ-ID> (--cmd <cmd> [--criteria AC-1,AC-2] | --all) [--timeout <ms>]",
    "                                             运行真实验证命令并记录不可变证据",
    "  review <REQ-ID> --verdict <pass|concern|block> --summary <text> [--body <md|@file>]",
    "                                             提交跨模型代码审查结论（不绕过人工验收）",
    "  mcp                                        启动标准 MCP Server (stdio)",
    "  serve [--hub] [--port <n>] [--host <addr>] 前台启动 HTTP/WS 服务与 Web UI",
    "",
    "注: 批准方案与最终验收只能由人类在 Web UI 界面完成，CLI 与 MCP 不提供审批绕过命令。",
  ].join("\n");
}

export async function runCli(argv: string[]): Promise<number> {
  const parsed = parseCliArgs(argv);
  const asJson = parsed.flags.get("json") === true;

  if (parsed.flags.get("help") === true || parsed.command === "help") {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }

  try {
    const rootArg = parsed.flags.get("root");
    const root = typeof rootArg === "string" ? canonicalRoot(rootArg) : resolveDefaultRoot();

    switch (parsed.command) {
      case "start": {
        const portFlag = parsed.flags.get("port");
        const hostFlag = parsed.flags.get("host");
        const port = typeof portFlag === "string" ? Number(portFlag) : 4318;
        const hostname = typeof hostFlag === "string" ? hostFlag : "127.0.0.1";
        if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
          throw new WorkbenchError("invalid_input", `无效端口号: ${String(portFlag)}`);
        }
        const maybeGitOrWb = fs.existsSync(path.join(root, ".git")) || fs.existsSync(path.join(root, WORKBENCH_DIR, "project.json"));
        if (maybeGitOrWb) {
          registerHubProject(root, { activate: true });
        }
        const res = await startDaemon({
          port,
          hostname,
          registerRoot: maybeGitOrWb ? root : undefined,
        });
        printResult({ ...res.info, started: res.started }, asJson);
        return 0;
      }

      case "stop": {
        const res = await stopDaemon();
        printResult(res, asJson);
        return 0;
      }

      case "restart": {
        const portFlag = parsed.flags.get("port");
        const hostFlag = parsed.flags.get("host");
        const port = typeof portFlag === "string" ? Number(portFlag) : 4318;
        const hostname = typeof hostFlag === "string" ? hostFlag : "127.0.0.1";
        await stopDaemon();
        const res = await startDaemon({ port, hostname });
        printResult({ ...res.info, restarted: true }, asJson);
        return 0;
      }

      case "status": {
        const status = await getDaemonStatus();
        printResult(status, asJson);
        return 0;
      }

      case "open": {
        const maybeGitOrWb = fs.existsSync(path.join(root, ".git")) || fs.existsSync(path.join(root, WORKBENCH_DIR, "project.json"));
        if (maybeGitOrWb) {
          registerHubProject(root, { activate: true });
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
        const port = typeof portFlag === "string" ? Number(portFlag) : hubMode ? 4318 : 0;
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
        const meta = await initProject(root, {
          name: typeof nameFlag === "string" ? nameFlag : undefined,
          privacyMode,
        });
        printResult(meta, asJson);
        return 0;
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
        const detail = await createRequirement(root, {
          goal,
          title: typeof titleFlag === "string" ? titleFlag : undefined,
          track: parsed.flags.get("fast-track") === true ? "fast_track" : "plan_first",
        });
        printResult(
          {
            id: detail.state.id,
            title: detail.state.title,
            stage: detail.state.stage,
            track: detail.state.track,
            revision: detail.state.revision,
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

      case "tasks": {
        const id = parsed.positionals[0];
        if (!id) throw new WorkbenchError("invalid_input", "请提供需求编号，例如: wb tasks REQ-001 ...");
        const tasks = parsed.flags.get("tasks");
        const ready = parsed.flags.get("ready") === true;
        const note = parsed.flags.get("note");
        const revision = parsed.flags.get("revision");

        const payload: Record<string, unknown> = { id };
        if (typeof tasks === "string") payload.tasks = parseJsonValue<TaskInput[]>(tasks, "tasks");
        if (ready) payload.readyForAcceptance = true;
        if (typeof note === "string") payload.note = note;
        if (typeof revision === "string") payload.expectedRevision = Number(revision);

        const res = await executeWorkbenchTool(root, "wb_update_tasks", payload);
        printResult(res, asJson);
        return 0;
      }

      case "verify": {
        const id = parsed.positionals[0];
        if (!id) throw new WorkbenchError("invalid_input", "请提供需求编号，例如: wb verify REQ-001 --cmd ...");
        const timeoutFlag = parsed.flags.get("timeout");
        const timeoutMs = typeof timeoutFlag === "string" ? Number(timeoutFlag) : undefined;

        if (parsed.flags.get("all") === true) {
          const allRes = await runAllVerifications(root, id, { timeoutMs });
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
        const snapshot = await observeGitSnapshot(root);
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
