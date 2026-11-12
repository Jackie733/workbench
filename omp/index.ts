import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import { atomicJson, prefillStateRejection, readCommand, Runtime, validateCommand, waitForOpenAck, type WorkbenchCommand, type Receipt } from "./runtime";
import { discoverSourceWindow } from "./tern";
import { Handoff } from "./handoff";

const HEARTBEAT_MS = 750;
const EVENT_LIMIT = 80;
type RunState = "idle" | "working" | "waiting_user" | "disconnected";
type ObservedTool = { toolCallId: string; toolName: string; summary: string; startedAt: number };
type ObservedEvent = { id: string; sequence: number; type: string; at: number; sessionId: string; summary: string; [key: string]: unknown };
export interface ObservedPlan {
	source: "omp.todo";
	observedAt: number;
	phases: { name: string; tasks: { id: string; content: string; status: string }[] }[];
	total: number;
	completed: number;
	truncated: boolean;
	attribution: null;
}
export interface ObservedDelivery {
	kind: "assistant_candidate";
	observedAt: number;
	textBytes: number;
	textOmitted: true;
	includesToolCalls: boolean;
	attribution: null;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Tool inputs, output, URLs, env, prompts and credentials never enter tool summaries. */
function toolName(value: string): string {
	return /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : "custom_tool";
}

function safeText(value: string, max = 256): string {
	return value
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
		.replace(/\b(?:https?:\/\/|ssh:\/\/)[^\s]+/gi, "[URL omitted]")
		.replace(/\b(?:Bearer\s+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, "[credential omitted]")
		.replace(/\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}/g, "[credential omitted]")
		.slice(0, max);
}

export function observePlan(value: unknown, at: number): ObservedPlan | null {
	if (!Array.isArray(value)) return null;
	const phases: { name: string; tasks: { id: string; content: string; status: string }[] }[] = [];
	const occurrences = new Map<string, number>();
	let total = 0;
	let completed = 0;
	let displayed = 0;
	let truncated = false;
	for (const phase of value) {
		if (!record(phase) || typeof phase.name !== "string" || !Array.isArray(phase.tasks)) return null;
		const tasks: { id: string; content: string; status: string }[] = [];
		for (const task of phase.tasks) {
			if (!record(task) || typeof task.content !== "string" || typeof task.status !== "string" || !["pending", "in_progress", "completed", "abandoned", "blocked"].includes(task.status)) return null;
			total++;
			if (task.status === "completed") completed++;
			if (displayed >= 64 || phases.length >= 16) { truncated = true; continue; }
			const key = `${phase.name}\0${task.content}`;
			const occurrence = occurrences.get(key) ?? 0;
			occurrences.set(key, occurrence + 1);
			const id = createHash("sha256").update(`${key}\0${occurrence}`).digest("hex").slice(0, 24);
			const content = safeText(task.content);
			truncated ||= content !== task.content;
			tasks.push({ id, content, status: task.status });
			displayed++;
		}
		if (phases.length < 16) {
			const name = safeText(phase.name, 96);
			truncated ||= name !== phase.name;
			phases.push({ name, tasks });
		} else truncated = true;
	}
	return { source: "omp.todo", observedAt: at, phases, total, completed, truncated, attribution: null };
}

export function observeDelivery(value: unknown, at: number): ObservedDelivery | null {
	if (!record(value) || value.role !== "assistant" || !Array.isArray(value.content)) return null;
	let textBytes = 0;
	let includesToolCalls = false;
	for (const block of value.content) {
		if (!record(block)) continue;
		if (block.type === "text" && typeof block.text === "string") textBytes += Buffer.byteLength(block.text, "utf8");
		if (block.type === "toolCall") includesToolCalls = true;
	}
	if (!textBytes) return null;
	return { kind: "assistant_candidate", observedAt: at, textBytes, textOmitted: true, includesToolCalls, attribution: null };
}

/** All mutable state is factory-local: omp rebinds factories separately for child sessions. */
export default function workbench(pi: ExtensionAPI): void {
	let runtime: Runtime | undefined;
	let currentContext: ExtensionContext | undefined;
	let stopHeartbeat: (() => void) | undefined;
	let sessionId = "";
	let cwd = "";
	let projectRoot: string | null = null;
	let sequence = 0;
	let eventSequence = 0;
	let state: RunState = "idle";
	let disconnected = false;
	let awaitingAsyncWork = false;
	let plan: ObservedPlan | null = null;
	let lastDelivery: ObservedDelivery | null = null;
	let model: string | null = null;
	let errorReported = false;
	let openRequestId: string | null = null;
	let dispatchingRequest: string | null = null;
	const handoff = new Handoff();
	const tools = new Map<string, ObservedTool>();
	const waits = new Set<string>();
	const recentEvents: ObservedEvent[] = [];

	function event(type: string, summary: string, details: Record<string, unknown> = {}): void {
		if (!runtime) return;
		const number = ++eventSequence;
		recentEvents.push({ id: `${runtime.instanceId}:${number}`, sequence: number, type, at: Date.now(), sessionId, summary, ...details });
		if (recentEvents.length > EVENT_LIMIT) recentEvents.shift();
	}

	function failure(ctx: ExtensionContext): void {
		if (errorReported) return;
		errorReported = true;
		ctx.ui.notify("Workbench bridge I/O failed; commands are not retried. Reopen /wb after checking the private runtime directory.", "error");
	}

	function restoreObserved(ctx: ExtensionContext): void {
		plan = null;
		lastDelivery = null;
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			const at = Number.isFinite(Date.parse(entry.timestamp)) ? Date.parse(entry.timestamp) : Date.now();
			if (!plan && entry.type === "custom" && entry.customType === "user_todo_edit" && record(entry.data)) plan = observePlan(entry.data.phases, at);
			if (entry.type !== "message") continue;
			const message: unknown = entry.message;
			if (!lastDelivery) lastDelivery = observeDelivery(message, at);
			if (!plan && record(message) && message.role === "toolResult" && message.toolName === "todo" && !message.isError && record(message.details) && message.details.op !== "view") plan = observePlan(message.details.phases, at);
			if (plan && lastDelivery) break;
		}
	}

	function resolveProject(sourceCwd: string): string | null {
		try {
			const root = execFileSync("git", ["-C", sourceCwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 3000, maxBuffer: 8192, stdio: ["ignore", "pipe", "pipe"] }).trim();
			return root.startsWith("/") && !/[\x00-\x1f\x7f]/.test(root) ? root : null;
		} catch { return null; }
	}

	function renderSource(ctx: ExtensionContext): void {
		if (!runtime) return;
		// The status line renders this exact text as its own dock node, which
		// proves the source pane; no second above-editor line is needed.
		ctx.ui.setStatus("omp-workbench-source", runtime.sourceMarker);
		// A visible routing hint, never the plugin's proof of source identity.
		ctx.ui.setTitle(runtime.sourceMarker);
	}

	function bind(ctx: ExtensionContext, forceRestore = false): void {
		const nextSession = ctx.sessionManager.getSessionId();
		const nextCwd = ctx.sessionManager.getCwd();
		const changed = sessionId !== nextSession;
		const moved = cwd !== nextCwd;
		if (changed || moved) handoff.clear();
		if (changed) {
			sessionId = nextSession;
			openRequestId = null;
			dispatchingRequest = null;
			tools.clear(); waits.clear(); awaitingAsyncWork = false;
			event("session.changed", "Source session bound; prior-session commands will be rejected");
		}
		if (moved) {
			cwd = nextCwd;
			projectRoot = resolveProject(cwd);
			runtime?.markSource(projectRoot, cwd);
		}
		if (changed || forceRestore) restoreObserved(ctx);
		// omp clears extension widgets during native session switches; a moved
		// project also renames the visible source title.
		if (changed || moved || forceRestore) renderSource(ctx);
		if (changed || moved) writeMarker();
	}

	function writeMarker(): void {
		if (!runtime) return;
		runtime.assertPrivate();
		atomicJson(runtime.marker, { schemaVersion: 1, instanceId: runtime.instanceId, sessionId, runtimeDir: runtime.directory, sourceMarker: runtime.sourceMarker, pid: process.pid, cwd, projectRoot, openRequestId });
	}

	function publish(ctx: ExtensionContext): void {
		if (!runtime) return;
		runtime.assertPrivate();
		const selected = ctx.model;
		model = selected ? `${selected.provider}/${selected.id}` : null;
		state = disconnected ? "disconnected" : waits.size ? "waiting_user" : (!ctx.isIdle() || awaitingAsyncWork || ctx.hasPendingMessages() || tools.size) ? "working" : "idle";
		const currentTool = Array.from(tools.values()).at(-1) ?? null;
		atomicJson(path.join(runtime.directory, "snapshot.json"), {
			schemaVersion: 1, instanceId: runtime.instanceId, sessionId, pid: process.pid, cwd, projectRoot,
			sourceMarker: runtime.sourceMarker, updatedAt: Date.now(), sequence: ++sequence, state, model,
			currentTool, activeToolCount: tools.size, recentEvents, plan, lastDelivery,
			observability: { toolArguments: false, toolOutput: false, assistantText: false, taskAttribution: false, arbitraryDialogs: false, planSource: "native_todo_only" },
		});
	}

	function draftRejection(ctx: ExtensionContext, command: WorkbenchCommand): string | null {
		const invalid = validateCommand(command, command.requestId, runtime!.instanceId, ctx.sessionManager.getSessionId(), Date.now());
		if (invalid) return invalid;
		return prefillStateRejection({
			available: !disconnected && ctx.agent.kind === "main" && ctx.mode === "tui" && ctx.hasUI && ctx.ui.supportsEditor === true,
			projectReady: projectRoot !== null,
			identityFresh: ctx.sessionManager.getCwd() === cwd && command.sessionId === sessionId,
			busy: !ctx.isIdle() || ctx.hasPendingMessages() || tools.size > 0 || waits.size > 0 || awaitingAsyncWork || dispatchingRequest !== null,
			planReview: ctx.getPendingPlanReview() !== undefined,
			// Whitespace is still the user's draft; never trim this text.
			draftText: ctx.ui.getEditorText(),
		});
	}

	function processCommands(ctx: ExtensionContext): void {
		if (!runtime || disconnected) return;
		const sourceRuntime = runtime;
		for (const name of sourceRuntime.pending()) {
			const requestId = name.slice(0, -5);
			if (sourceRuntime.hasReceipt(requestId)) { sourceRuntime.removeCommand(name); continue; }
			let value: unknown;
			let reason: string | null = null;
			try { value = readCommand(path.join(sourceRuntime.commands, name)); }
			catch { reason = "invalid_command_file"; }
			reason ??= validateCommand(value, requestId, sourceRuntime.instanceId, ctx.sessionManager.getSessionId(), Date.now());
			const command = value as WorkbenchCommand;
			const receipt: Receipt = { schemaVersion: 1, requestId, instanceId: sourceRuntime.instanceId,
				sessionId: record(value) && typeof value.sessionId === "string" ? value.sessionId.slice(0, 128) : sessionId,
				status: "rejected", reason: reason ?? "", updatedAt: Date.now() };
			if (reason) {
				sourceRuntime.receipt(receipt);
				event("request.rejected", `Workbench request rejected: ${reason}`, { requestId });
				sourceRuntime.removeCommand(name);
				continue;
			}
			if (command.kind === "inspect") {
				try {
					if (!projectRoot || ctx.sessionManager.getCwd() !== cwd || command.sessionId !== sessionId) throw new Error("source_changed");
					receipt.data = handoff.inspect(command, projectRoot, sessionId, ctx.sessionManager.getBranch());
					receipt.status = "inspected"; receipt.reason = "explicit_read_complete";
				} catch (error) { receipt.reason = error instanceof Error ? safeText(error.message, 180) : "inspection_failed"; }
				receipt.updatedAt = Date.now();
				sourceRuntime.receipt(receipt);
				event("materials.inspected", `Explicit inspection: ${receipt.status}`, { requestId });
				sourceRuntime.removeCommand(name);
				continue;
			}
			reason = draftRejection(ctx, command);
			let text = "";
			if (!reason) {
				try {
					text = command.kind === "prefill" ? command.text
						: handoff.resolve(command.previewToken, projectRoot!, sessionId, sourceRuntime.instanceId, requestId, command.kind === "send").text;
				} catch (error) { reason = error instanceof Error ? safeText(error.message, 180) : "preview_invalid"; }
			}
			if (reason) {
				receipt.reason = reason;
				sourceRuntime.receipt(receipt);
				event("request.rejected", `Workbench request rejected: ${reason}`, { requestId });
				sourceRuntime.removeCommand(name);
				continue;
			}
			// The durable claim precedes every external effect. It is never replayed.
			receipt.status = "delivery_unknown"; receipt.reason = "applying_request";
			sourceRuntime.receipt(receipt);
			let changed = draftRejection(ctx, command);
			if (!changed && command.kind !== "prefill") {
				try { text = handoff.resolve(command.previewToken, projectRoot!, sessionId, sourceRuntime.instanceId, requestId, command.kind === "send").text; }
				catch (error) { changed = error instanceof Error ? safeText(error.message, 180) : "preview_invalid"; }
			}
			if (changed) {
				receipt.status = "rejected"; receipt.reason = changed;
				receipt.updatedAt = Date.now(); sourceRuntime.receipt(receipt);
			} else if (command.kind === "send") {
				handoff.consume(command.previewToken);
				dispatchingRequest = requestId;
				const finish = (status: Receipt["status"], result: string): void => {
					receipt.status = status; receipt.reason = result; receipt.updatedAt = Date.now();
					sourceRuntime.receipt(receipt);
					if (sessionId === receipt.sessionId) {
						event(`request.${status}`, result, { requestId });
						if (currentContext) publish(currentContext);
					}
				};
				try {
					// No await between the final live gate and the bound SDK action.
					// Omitting deliverAs starts only an idle prompt; busy sources were refused.
					void pi.sendUserMessage(text).then(
						() => finish("submitted", "submitted_to_existing_session"),
						() => finish("delivery_unknown", "native_submission_outcome_unknown"),
					).catch(() => failure(ctx)).finally(() => {
						if (dispatchingRequest === requestId) dispatchingRequest = null;
					});
				} catch {
					finish("delivery_unknown", "native_submission_outcome_unknown");
					dispatchingRequest = null;
				}
			} else {
				try {
					ctx.ui.setEditorText(text);
					receipt.status = "prefilled"; receipt.reason = "awaiting_user_submission";
				} catch { receipt.reason = "native_editor_outcome_unknown"; }
				receipt.updatedAt = Date.now(); sourceRuntime.receipt(receipt);
				event(`prefill.${receipt.status}`, receipt.status === "prefilled" ? "Prefilled input; not submitted" : receipt.reason, { requestId });
			}
			sourceRuntime.removeCommand(name);
		}
	}

	function accept(ctx: ExtensionContext, retainContext = true): boolean {
		if (ctx.agent.kind !== "main" || ctx.mode !== "tui" || !ctx.hasUI || disconnected) return false;
		if (retainContext || !currentContext) currentContext = ctx;
		if (!runtime) {
			runtime = new Runtime();
			// Managed timer belongs to this exact top-level session runner.
			const timer = ctx.setInterval(() => {
				const live = currentContext;
				if (!live || disconnected) return;
				try { bind(live); processCommands(live); publish(live); }
				catch { failure(live); }
			}, HEARTBEAT_MS);
			stopHeartbeat = () => ctx.clearTimer(timer);
		}
		bind(ctx);
		return true;
	}

	function observe(ctx: ExtensionContext, action: () => void): void {
		try { if (accept(ctx)) { action(); publish(ctx); } }
		catch { failure(ctx); }
	}

	pi.setLabel("Source-linked workbench");
	pi.registerCommand("wb", {
		description: "Open the workbench beside this exact omp pane (no new agent)",
		handler: async (args, ctx) => {
			if (args.trim()) { ctx.ui.notify("Usage: /wb — opens this source-linked workbench; never sends a model prompt.", "info"); return; }
			let stage = "source";
			let cliStderr = "";
			let cliFailure: unknown;
			try {
				if (!accept(ctx, false)) { ctx.ui.notify("/wb requires the top-level interactive TUI.", "error"); return; }
				if (!projectRoot) { ctx.ui.notify("/wb requires a source cwd inside a Git project.", "error"); return; }
				renderSource(ctx);
				const requestId = randomUUID();
				const createdAt = Date.now();
				openRequestId = requestId;
				stage = "marker";
				writeMarker(); publish(ctx);
				const marker = runtime!.marker;
				const openedSessionId = ctx.sessionManager.getSessionId();
				const openedCwd = ctx.sessionManager.getCwd();
				stage = "window_discovery";
				const source = await discoverSourceWindow(runtime!.sourceMarker);
				if (disconnected || ctx.sessionManager.getSessionId() !== openedSessionId || ctx.sessionManager.getCwd() !== openedCwd || openRequestId !== requestId) throw new Error("Source session or open request changed while discovering its native window");
				event("workbench.route", "Exact native title selected the routing window; dock proof is still required", { sourceWindowKey: source.windowKey, sourcePaneId: source.paneId });
				publish(currentContext ?? ctx);
				stage = "cli";
				const { promise, resolve } = Promise.withResolvers<void>();
				// Keep open first: the installed WSL wrapper only then translates the path.
				execFile("tern", ["open", "--window", source.windowKey, marker], { timeout: 10_000, maxBuffer: 16_384 }, (error, _stdout, stderr) => {
					cliStderr = safeText(String(stderr ?? ""), 512);
					cliFailure = error;
					resolve();
				});
				await promise;
				stage = "open_acknowledgment";
				const ack = await waitForOpenAck(runtime!, {
					instanceId: runtime!.instanceId, sessionId: openedSessionId, openRequestId: requestId,
					sourcePane: source.paneId, window: source.windowKey, createdAt,
				}, () => !disconnected && openRequestId === requestId && ctx.sessionManager.getSessionId() === openedSessionId && ctx.sessionManager.getCwd() === openedCwd);
				const cliExitCode = record(cliFailure) && (typeof cliFailure.code === "string" || typeof cliFailure.code === "number") ? cliFailure.code : null;
				event("workbench.opened", "Native workbench panel acknowledged; no new agent started", { openRequestId: requestId, sourcePane: ack.sourcePane, panel: ack.panel, sourceWindowKey: ack.window, cliExitCode });
				publish(currentContext ?? ctx);
			} catch (error) {
				const code = record(error) && (typeof error.code === "string" || typeof error.code === "number") ? safeText(String(error.code), 48) : error instanceof Error ? error.name : "unknown";
				const detail = error instanceof Error ? safeText(error.message, 240) : "Unknown workbench launch error";
				const signal = record(error) && typeof error.signal === "string" ? safeText(error.signal, 32) : null;
				event("workbench.open_failed", `Workbench open failed (${stage}/${code})`, { stage, code, signal, detail, stderr: cliStderr });
				try { if (runtime) publish(currentContext ?? ctx); } catch { /* Preserve the visible failure if the runtime itself is unavailable. */ }
				ctx.ui.notify(`Workbench open failed (${stage}/${code}): ${detail}${cliStderr ? `; ${cliStderr}` : ""}. No alternate pane selected.`, "error");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => observe(ctx, () => event("session.bound", "Workbench bridge connected to the current source")));
	pi.on("session_switch", (_event, ctx) => observe(ctx, () => { bind(ctx, true); }));
	pi.on("session_branch", (_event, ctx) => observe(ctx, () => { bind(ctx, true); event("session.branch", "Active session branch changed"); }));
	pi.on("session_tree", (_event, ctx) => observe(ctx, () => { tools.clear(); waits.clear(); bind(ctx, true); event("session.tree", "Active conversation branch changed"); }));
	pi.on("agent_start", (_event, ctx) => observe(ctx, () => { awaitingAsyncWork = false; event("agent.started", "Agent loop started (no task attribution)"); }));
	pi.on("agent_end", (ending, ctx) => observe(ctx, () => {
		awaitingAsyncWork = ending.willContinue === true || ending.awaitingAsyncWork === true;
		event("agent.ended", awaitingAsyncWork ? "Agent loop paused; continuation/background work remains" : "Agent loop ended; not verification or acceptance", { willContinue: ending.willContinue === true, awaitingAsyncWork: ending.awaitingAsyncWork === true });
	}));
	pi.on("before_provider_request", (_event, ctx) => {
		try {
			// Request contexts can pin ctx.model; do not retain them for idle model polling.
			if (accept(ctx, false)) { event("model.observed", "Provider request model observed"); publish(ctx); }
		} catch { failure(ctx); }
	});
	pi.on("tool_execution_start", (tool, ctx) => observe(ctx, () => {
		const name = toolName(tool.toolName);
		tools.set(tool.toolCallId, { toolCallId: tool.toolCallId, toolName: name, summary: `${name} running; input omitted`, startedAt: Date.now() });
		if (name === "ask") waits.add(`ask:${tool.toolCallId}`);
		event("tool.started", `${name} started; input omitted`, { toolCallId: tool.toolCallId, toolName: name });
	}));
	pi.on("tool_execution_end", (tool, ctx) => observe(ctx, () => {
		tools.delete(tool.toolCallId); waits.delete(`ask:${tool.toolCallId}`);
		const name = toolName(tool.toolName);
		event("tool.finished", `${name} finished; output omitted`, { toolCallId: tool.toolCallId, toolName: name, isError: tool.isError });
	}));
	pi.on("tool_result", (result, ctx) => observe(ctx, () => {
		// Native BashToolDetails only promises an explicit exitCode for certain failures.
		// Success/isError=false is NEVER promoted to an invented zero exit code.
		if (result.toolName === "bash" && record(result.details) && Number.isSafeInteger(result.details.exitCode)) {
			event("tool.exit_code", "Native bash exit code observed; no verification classification", { toolCallId: result.toolCallId, toolName: "bash", exitCode: result.details.exitCode });
		}
		if (result.toolName === "todo" && !result.isError && record(result.details)) {
			const observed = observePlan(result.details.phases, Date.now());
			if (observed) { plan = observed; event("plan.updated", "Native structured todo plan observed (unattributed)"); }
		}
	}));
	pi.on("message_end", (message, ctx) => observe(ctx, () => {
		const observed = observeDelivery(message.message, Date.now());
		if (observed) { lastDelivery = observed; event("assistant.candidate", "Assistant response observed; text omitted, not an accepted delivery"); }
	}));
	pi.on("tool_approval_requested", (approval, ctx) => observe(ctx, () => {
		if (approval.sessionId !== sessionId) return;
		waits.add(`approval:${approval.toolCallId}`); event("user.waiting", "Native tool approval is waiting for the user");
	}));
	pi.on("tool_approval_resolved", (approval, ctx) => observe(ctx, () => {
		if (approval.sessionId !== sessionId) return;
		waits.delete(`approval:${approval.toolCallId}`); event("user.resolved", "Native tool approval resolved", { approved: approval.approved });
	}));
	pi.on("plan_review_requested", (review, ctx) => observe(ctx, () => {
		if (review.sessionId !== sessionId) return;
		waits.add(`review:${review.reviewId}`); event("user.waiting", "Native plan review is waiting; plan text omitted");
	}));
	pi.on("plan_review_resolved", (review, ctx) => observe(ctx, () => {
		if (review.sessionId !== sessionId) return;
		waits.delete(`review:${review.reviewId}`); event("user.resolved", "Native plan review closed; not workbench approval");
	}));
	pi.on("session_shutdown", (_event, ctx) => {
		if (!runtime || ctx.agent.kind !== "main" || ctx.mode !== "tui") return;
		disconnected = true;
		stopHeartbeat?.();
		try { bind(ctx); event("session.disconnected", "Source extension shut down"); publish(ctx); }
		catch { /* A forced exit may prevent the final write; readers also enforce heartbeat expiry. */ }
	});
}
