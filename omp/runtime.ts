import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export const MAX_TEXT_BYTES = 16_384;
export const MAX_COMMAND_BYTES = 32_768;
export const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;

const IDENTITY_FIELDS: Record<string,true> = {schemaVersion:true,requestId:true,instanceId:true,sessionId:true,kind:true,createdAt:true,expiresAt:true};
const COMMAND_FIELDS: Record<string,Record<string,true>> = {
	prefill:{text:true},prefill_preview:{previewToken:true},send:{previewToken:true},
};
const INSPECT_FIELDS: Record<string,Record<string,true>> = {
	preview:{operation:true,requirementId:true,activity:true,includeRequirement:true,paths:true,excerpt:true},
	baseline:{operation:true,requirementId:true},candidate:{operation:true,requirementId:true},
	changes:{operation:true,requirementId:true,since:true},
	file:{operation:true,requirementId:true,path:true},
};
function materialText(value:unknown,required=false):value is string {
	return typeof value==="string" && (!required || !!value.trim())
		&& Buffer.byteLength(value,"utf8")<=MAX_TEXT_BYTES && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
}

interface CommandIdentity {
	schemaVersion: 1;
	requestId: string;
	instanceId: string;
	sessionId: string;
	createdAt: number;
	expiresAt: number;
}

export interface PrefillCommand extends CommandIdentity {
	kind: "prefill";
	text: string;
}

export type Activity = "clarify" | "design" | "implement";
export interface InspectCommand extends CommandIdentity {
	kind: "inspect";
	operation: "preview" | "baseline" | "candidate" | "changes" | "file";
	requirementId: string;
	since?: string;
	activity?: Activity;
	includeRequirement?: boolean;
	paths?: string[];
	excerpt?: string;
	path?: string;
}

export interface PreviewCommand extends CommandIdentity {
	kind: "prefill_preview" | "send";
	previewToken: string;
}

export type WorkbenchCommand = PrefillCommand | InspectCommand | PreviewCommand;

export interface Receipt {
	schemaVersion: 1;
	requestId: string;
	instanceId: string;
	sessionId: string;
	status: "prefilled" | "inspected" | "submitted" | "rejected" | "delivery_unknown";
	reason: string;
	updatedAt: number;
	data?: unknown;
}

export interface OpenedAck {
	schemaVersion: 1;
	instanceId: string;
	sessionId: string;
	openRequestId: string;
	sourcePane: number;
	panel: number;
	window: string;
	updatedAt: number;
}

export interface ExpectedOpen {
	instanceId: string;
	sessionId: string;
	openRequestId: string;
	sourcePane: number;
	window: string;
	createdAt: number;
}

export function matchingOpenAck(value: unknown, expected: ExpectedOpen, now: number): value is OpenedAck {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const ack = value as OpenedAck;
	return ack.schemaVersion === 1 && ack.instanceId === expected.instanceId && ack.sessionId === expected.sessionId
		&& ack.openRequestId === expected.openRequestId && ack.sourcePane === expected.sourcePane && ack.window === expected.window
		&& Number.isSafeInteger(ack.panel) && ack.panel > 0 && ack.panel !== ack.sourcePane
		&& Number.isSafeInteger(ack.updatedAt) && ack.updatedAt >= expected.createdAt && ack.updatedAt <= now;
}

/** CLI transport completion is NOT proof that the native plugin bound and displayed a panel. */
export async function waitForOpenAck(runtime: Runtime, expected: ExpectedOpen, isCurrent: () => boolean): Promise<OpenedAck> {
	const deadline = Date.now() + 8000;
	while (true) {
		if (!isCurrent()) throw new Error("Source session or open request changed before workbench acknowledgment");
		runtime.assertPrivate();
		try {
			const value = readCommand(path.join(runtime.directory, "opened.json"));
			if (matchingOpenAck(value, expected, Date.now())) return value;
		} catch (error) {
			// Missing, partial, or stale/malformed acknowledgments never count as success.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error("No matching workbench opened.json acknowledgment within 8 seconds; panel success is unconfirmed");
		await delay(Math.min(100, remaining));
	}
}

function privateDirectory(directory: string, create: boolean): void {
	if (create) {
		try { fs.mkdirSync(directory, { mode: 0o700 }); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
	}
	const info = fs.lstatSync(directory);
	if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o700) {
		throw new Error("Workbench runtime must be an owned private directory (0700)");
	}
}

function syncDirectory(directory: string): void {
	const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
	try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function processAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * Remove only runtime directories this plugin can prove are its own, private and
 * abandoned: exact instance-named 0700 directory, matching marker, dead pid and
 * an old mtime. Anything unreadable or ambiguous is left alone.
 */
export function cleanupStaleRuntime(base: string, ownInstance: string, now = Date.now(), maxAgeMs = 7 * 86_400_000): string[] {
	const removed: string[] = [];
	let names: string[];
	try { names = fs.readdirSync(base).slice(0, 256); } catch { return removed; }
	for (const name of names) {
		if (name === ownInstance || !/^[A-Za-z0-9_-]{8,64}$/.test(name)) continue;
		const directory = path.join(base, name);
		try {
			const info = fs.lstatSync(directory);
			if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o700) continue;
			if (now - info.mtimeMs < maxAgeMs) continue;
			const markerPath = path.join(directory, "open.omp-workbench.json");
			const markerInfo = fs.lstatSync(markerPath);
			if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 16_384) continue;
			const marker: unknown = JSON.parse(fs.readFileSync(markerPath, "utf8"));
			if (!marker || typeof marker !== "object" || Array.isArray(marker)) continue;
			const value = marker as { instanceId?: unknown; pid?: unknown };
			if (value.instanceId !== name || !Number.isSafeInteger(value.pid)) continue;
			if (processAlive(value.pid as number)) continue;
			fs.rmSync(directory, { recursive: true, force: true, maxRetries: 2 });
			removed.push(name);
		} catch { /* leave anything we cannot prove is ours */ }
	}
	return removed;
}

/** Atomic, durable small JSON replacement; callers serialize synchronously. */
export function atomicJson(file: string, value: unknown): void {
	const temporary = `${file}.${randomUUID()}.tmp`;
	const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
	try {
		try {
			fs.writeFileSync(fd, JSON.stringify(value) + "\n", "utf8");
			fs.fsyncSync(fd);
		} finally { fs.closeSync(fd); }
		fs.renameSync(temporary, file);
		syncDirectory(path.dirname(file));
	} finally {
		try { fs.unlinkSync(temporary); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
}

/** Never follow links or block on a FIFO/device offered as a command. */
export function readCommand(file: string): unknown {
	const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	try {
		const info = fs.fstatSync(fd);
		if (!info.isFile() || info.uid !== process.getuid!() || info.size > MAX_COMMAND_BYTES) throw new Error("invalid_command_file");
		const buffer = Buffer.alloc(MAX_COMMAND_BYTES + 1);
		let bytes = 0;
		while (bytes < buffer.length) {
			const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
			if (!count) break;
			bytes += count;
		}
		if (bytes > MAX_COMMAND_BYTES) throw new Error("command_too_large");
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes)));
	} finally { fs.closeSync(fd); }
}

export function validateCommand(value: unknown, requestId: string, instanceId: string, sessionId: string, now: number): string | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid_command";
	const command = value as Record<string, unknown>;
	if (command.schemaVersion !== 1 || command.requestId !== requestId || !REQUEST_ID.test(requestId)) return "invalid_command";
	if (command.instanceId !== instanceId || command.sessionId !== sessionId) return "identity_mismatch";
	if (!Number.isSafeInteger(command.createdAt) || !Number.isSafeInteger(command.expiresAt)
		|| (command.createdAt as number) > now || (command.expiresAt as number) <= now
		|| (command.expiresAt as number) <= (command.createdAt as number)
		|| (command.expiresAt as number) - (command.createdAt as number) > 30_000) return "expired_or_invalid_time";
	if (command.kind === "prefill") {
		if (!materialText(command.text, true)) return "invalid_text";
	} else if (command.kind === "prefill_preview" || command.kind === "send") {
		if (typeof command.previewToken !== "string" || !REQUEST_ID.test(command.previewToken)) return "invalid_preview";
	} else if (command.kind === "inspect") {
		if (typeof command.requirementId !== "string" || !/^[A-Za-z0-9_-]{1,96}$/.test(command.requirementId)) return "invalid_requirement";
		if (command.operation === "preview") {
			if (!["clarify", "design", "implement"].includes(command.activity as string) || typeof command.includeRequirement !== "boolean"
				|| !Array.isArray(command.paths) || command.paths.length > 16
				|| command.paths.some(p => typeof p !== "string" || !p || p.length > 2048 || /[\x00-\x1f\x7f]/.test(p))
				|| !materialText(command.excerpt)) return "invalid_materials";
		} else if (command.operation === "file") {
			if (typeof command.path !== "string" || !command.path || command.path.length > 2048 || /[\x00-\x1f\x7f]/.test(command.path)) return "invalid_path";
		} else if (command.operation === "changes") {
			if (command.since !== undefined && (typeof command.since !== "string" || (command.since !== "" && !/^[0-9a-f]{7,64}$/.test(command.since)))) return "invalid_baseline";
		} else if (command.operation !== "baseline" && command.operation !== "candidate") return "invalid_operation";
	} else return "invalid_command";
	const allowed=command.kind==="inspect" ? INSPECT_FIELDS[command.operation as string] : COMMAND_FIELDS[command.kind as string];
	for (const key in command) if (Object.hasOwn(command,key) && !Object.hasOwn(IDENTITY_FIELDS,key) && !Object.hasOwn(allowed,key)) return "invalid_command";
	return null;
}

export interface PrefillSourceState {
	available: boolean;
	projectReady: boolean;
	identityFresh: boolean;
	busy: boolean;
	planReview: boolean;
	draftText: string;
}

/** The production draft gate, exported for narrow real protocol regression tests. */
export function prefillStateRejection(source: PrefillSourceState): string | null {
	if (!source.available) return "unsupported_source";
	if (!source.projectReady || !source.identityFresh) return "source_changed";
	if (source.busy) return "source_busy";
	if (source.planReview) return "waiting_for_plan_review";
	if (source.draftText !== "") return "draft_conflict";
	return null;
}

export const SOURCE_ICON = "⚒";

/** Tool-channel negotiation is a separate namespace from the v1 prefill IPC. */
export const TOOLS_PROTOCOL = "omp-workbench.tools";
export const TOOLS_VERSION = 1;
export const TOOLS_MAX_BYTES = 16_384;
const TOOL_ACTIVITIES = ["clarify", "design", "implement", "review", "analyze"] as const;
const TOOL_OPERATIONS = ["list", "get", "propose", "update_plan", "request_decision", "run_verification", "get_evidence"] as const;
const HEX64 = /^[0-9a-f]{64}$/;

export interface ToolsOffer {
	schemaVersion: 1;
	protocol: typeof TOOLS_PROTOCOL;
	protocolVersion: typeof TOOLS_VERSION;
	instanceId: string;
	sessionId: string;
	openRequestId: string;
	activities: string[];
	operations: string[];
	payloadBytes: number;
	responseBytes: number;
	issuedAt: number;
	expiresAt: number;
}

export interface ToolsHostAck {
	schemaVersion: 1;
	protocol: typeof TOOLS_PROTOCOL;
	protocolVersion: typeof TOOLS_VERSION;
	offerSha256: string;
	hostEpoch: string;
	instanceId: string;
	sessionId: string;
	openRequestId: string;
	window: string;
	sourcePane: number;
	panel: number;
	projectId: string;
	writerProtocol: string;
	writerVersion: number;
	activities: string[];
	operations: string[];
	issuedAt: number;
	expiresAt: number;
}

export interface ToolsReady {
	schemaVersion: 1;
	protocol: typeof TOOLS_PROTOCOL;
	protocolVersion: typeof TOOLS_VERSION;
	offerSha256: string;
	hostSha256: string;
	instanceId: string;
	sessionId: string;
	openRequestId: string;
	hostEpoch: string;
	leaseId: string;
	sequence: number;
	issuedAt: number;
	expiresAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
	for (const key in value) if (Object.hasOwn(value, key) && !fields.includes(key)) return false;
	for (const field of fields) if (!Object.hasOwn(value, field)) return false;
	return true;
}
function safeText(value: unknown, max = 96): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}
function safeTime(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}
function stringSet(value: unknown, allowed: readonly string[]): value is string[] {
	return Array.isArray(value) && value.length <= allowed.length
		&& value.every(item => typeof item === "string" && allowed.includes(item))
		&& new Set(value).size === value.length;
}

export function validateToolsOffer(value: unknown, now: number): string | null {
	if (!isRecord(value)) return "invalid_offer";
	if (!exactFields(value, ["schemaVersion", "protocol", "protocolVersion", "instanceId", "sessionId", "openRequestId",
		"activities", "operations", "payloadBytes", "responseBytes", "issuedAt", "expiresAt"])) return "invalid_offer";
	if (value.schemaVersion !== 1 || value.protocol !== TOOLS_PROTOCOL || value.protocolVersion !== TOOLS_VERSION) return "unsupported_protocol";
	if (!safeText(value.instanceId, 96) || !safeText(value.sessionId, 96) || !safeText(value.openRequestId, 96)) return "invalid_identity";
	if (!stringSet(value.activities, TOOL_ACTIVITIES) || !stringSet(value.operations, TOOL_OPERATIONS)) return "invalid_capabilities";
	if (!Number.isSafeInteger(value.payloadBytes) || !Number.isSafeInteger(value.responseBytes)
		|| (value.payloadBytes as number) < 1 || (value.payloadBytes as number) > 16_384
		|| (value.responseBytes as number) < 1 || (value.responseBytes as number) > 65_536) return "invalid_limits";
	if (!safeTime(value.issuedAt) || !safeTime(value.expiresAt)) return "invalid_time";
	if ((value.issuedAt as number) > now || (value.expiresAt as number) <= now
		|| (value.expiresAt as number) <= (value.issuedAt as number)
		|| (value.expiresAt as number) - (value.issuedAt as number) > 60_000) return "invalid_time";
	return null;
}

export function validateToolsHost(value: unknown, expected: { offerSha256: string; now: number }): string | null {
	if (!isRecord(value)) return "invalid_host";
	if (!exactFields(value, ["schemaVersion", "protocol", "protocolVersion", "offerSha256", "hostEpoch", "instanceId", "sessionId",
		"openRequestId", "window", "sourcePane", "panel", "projectId", "writerProtocol", "writerVersion",
		"activities", "operations", "issuedAt", "expiresAt"])) return "invalid_host";
	if (value.schemaVersion !== 1 || value.protocol !== TOOLS_PROTOCOL || value.protocolVersion !== TOOLS_VERSION) return "unsupported_protocol";
	if (typeof value.offerSha256 !== "string" || !HEX64.test(value.offerSha256) || value.offerSha256 !== expected.offerSha256) return "offer_mismatch";
	if (!safeText(value.instanceId, 96) || !safeText(value.sessionId, 96) || !safeText(value.openRequestId, 96)
		|| !safeText(value.hostEpoch, 96) || typeof value.window !== "string" || value.window.length > 96
		|| /[\x00-\x1f\x7f]/.test(value.window) || !safeText(value.projectId, 96)
		|| !safeText(value.writerProtocol, 96) || !Number.isSafeInteger(value.sourcePane) || !Number.isSafeInteger(value.panel)
		|| !Number.isSafeInteger(value.writerVersion)) return "invalid_identity";
	if (!stringSet(value.activities, TOOL_ACTIVITIES) || !stringSet(value.operations, TOOL_OPERATIONS)) return "invalid_capabilities";
	if (!safeTime(value.issuedAt) || !safeTime(value.expiresAt)) return "invalid_time";
	if ((value.issuedAt as number) > expected.now || (value.expiresAt as number) <= expected.now
		|| (value.expiresAt as number) <= (value.issuedAt as number)
		|| (value.expiresAt as number) - (value.issuedAt as number) > 60_000) return "invalid_time";
	return null;
}

export function validateToolsReady(value: unknown, expected: { offerSha256: string; now: number }): string | null {
	if (!isRecord(value)) return "invalid_ready";
	if (!exactFields(value, ["schemaVersion", "protocol", "protocolVersion", "offerSha256", "hostSha256", "instanceId", "sessionId",
		"openRequestId", "hostEpoch", "leaseId", "sequence", "issuedAt", "expiresAt"])) return "invalid_ready";
	if (value.schemaVersion !== 1 || value.protocol !== TOOLS_PROTOCOL || value.protocolVersion !== TOOLS_VERSION) return "unsupported_protocol";
	if (typeof value.offerSha256 !== "string" || value.offerSha256 !== expected.offerSha256
		|| typeof value.hostSha256 !== "string" || !HEX64.test(value.hostSha256)) return "offer_mismatch";
	if (!safeText(value.instanceId, 96) || !safeText(value.sessionId, 96) || !safeText(value.openRequestId, 96)
		|| !safeText(value.hostEpoch, 96) || !safeText(value.leaseId, 96)) return "invalid_identity";
	if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1) return "invalid_sequence";
	if (!safeTime(value.issuedAt) || !safeTime(value.expiresAt)) return "invalid_time";
	if ((value.issuedAt as number) > expected.now || (value.expiresAt as number) <= expected.now
		|| (value.expiresAt as number) <= (value.issuedAt as number)
		|| (value.expiresAt as number) - (value.issuedAt as number) > 6_000) return "invalid_time";
	return null;
}

/** Deterministic bytes for the offer digest; object keys sort, arrays keep order. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

export function toolsOfferSha256(offer: ToolsOffer): string {
	return createHash("sha256").update(canonical(offer), "utf8").digest("hex");
}

export function toolsHostSha256(host: ToolsHostAck): string {
	return createHash("sha256").update(canonical(host), "utf8").digest("hex");
}

function toolsDirectory(runtime: Runtime): string {
	const directory = path.join(runtime.directory, "tools");
	privateDirectory(directory, true);
	return directory;
}

function readPrivateJson(file: string, max: number): unknown {
	const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	try {
		const info = fs.fstatSync(fd);
		if (!info.isFile() || info.uid !== process.getuid!() || info.size > max) throw new Error("invalid_tools_file");
		const buffer = Buffer.alloc(max + 1);
		let bytes = 0;
		while (bytes < buffer.length) {
			const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
			if (!count) break;
			bytes += count;
		}
		if (bytes > max) throw new Error("tools_file_too_large");
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes)));
	} finally { fs.closeSync(fd); }
}

export function publishToolsOffer(runtime: Runtime, offer: ToolsOffer): string {
	runtime.assertPrivate();
	const problem = validateToolsOffer(offer, Date.now());
	if (problem) throw new Error(problem);
	atomicJson(path.join(toolsDirectory(runtime), "offer.json"), offer);
	return toolsOfferSha256(offer);
}

export function readToolsHost(runtime: Runtime, offerSha256: string): { value: ToolsHostAck | null; problem: string | null } {
	runtime.assertPrivate();
	try {
		const value = readPrivateJson(path.join(toolsDirectory(runtime), "host.json"), TOOLS_MAX_BYTES);
		const problem = validateToolsHost(value, { offerSha256, now: Date.now() });
		return problem ? { value: null, problem } : { value: value as ToolsHostAck, problem: null };
	} catch (error) {
		return { value: null, problem: (error as Error).message || "host_unavailable" };
	}
}

export function publishToolsReady(runtime: Runtime, ready: ToolsReady): void {
	runtime.assertPrivate();
	const directory = toolsDirectory(runtime);
	const offer = readPrivateJson(path.join(directory, "offer.json"), TOOLS_MAX_BYTES);
	const offerProblem = validateToolsOffer(offer, Date.now());
	if (offerProblem) throw new Error(offerProblem);
	const offerDigest = toolsOfferSha256(offer as ToolsOffer);
	if (offerDigest !== ready.offerSha256) throw new Error("offer_mismatch");
	const host = readPrivateJson(path.join(directory, "host.json"), TOOLS_MAX_BYTES);
	const hostProblem = validateToolsHost(host, { offerSha256: offerDigest, now: Date.now() });
	if (hostProblem) throw new Error(hostProblem);
	const bound = host as ToolsHostAck;
	if (bound.instanceId !== ready.instanceId || bound.sessionId !== ready.sessionId
		|| bound.openRequestId !== ready.openRequestId || bound.hostEpoch !== ready.hostEpoch
		|| toolsHostSha256(bound) !== ready.hostSha256) throw new Error("host_mismatch");
	const problem = validateToolsReady(ready, { offerSha256: offerDigest, now: Date.now() });
	if (problem) throw new Error(problem);
	atomicJson(path.join(directory, "ready.json"), ready);
}

export function revokeToolsReady(runtime: Runtime): void {
	runtime.assertPrivate();
	try { fs.unlinkSync(path.join(toolsDirectory(runtime), "ready.json")); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/**
 * Visible source title: workbench icon, project directory name (not the full
 * path) and a shortened instance id. Routing still requires the exact native
 * dock marker; the title alone never proves the source pane.
 */
export function sourceMarkerFor(projectRoot: string | null, cwd: string, instanceId: string): string {
	const base = path.basename(projectRoot ?? cwd);
	const name = Array.from(base.replace(/[\x00-\x1f\x7f]/g, "")).slice(0, 32).join("") || "workbench";
	return `${SOURCE_ICON} ${name} · ${instanceId.replace(/-/g, "").slice(0, 8)}`;
}

export class Runtime {
	readonly instanceId = randomUUID();
	sourceMarker = sourceMarkerFor(null, "/", this.instanceId);
	readonly directory: string;
	readonly marker: string;
	readonly commands: string;
	readonly receipts: string;

	constructor() {
		if (process.platform !== "linux" || !process.getuid) throw new Error("Workbench bridge requires WSL Linux");
		const base = `/tmp/omp-workbench-${process.getuid()}`;
		privateDirectory(base, true);
		this.directory = path.join(base, this.instanceId);
		fs.mkdirSync(this.directory, { mode: 0o700 });
		this.commands = path.join(this.directory, "commands");
		this.receipts = path.join(this.directory, "receipts");
		privateDirectory(this.commands, true);
		privateDirectory(this.receipts, true);
		this.marker = path.join(this.directory, "open.omp-workbench.json");
		const timer = setTimeout(() => {
			try { cleanupStaleRuntime(base, this.instanceId); } catch { /* cleanup is best effort */ }
		}, 1000);
		timer.unref();
	}

	markSource(projectRoot: string | null, cwd: string): void {
		this.sourceMarker = sourceMarkerFor(projectRoot, cwd, this.instanceId);
	}

	assertPrivate(): void {
		privateDirectory(path.dirname(this.directory), false);
		for (const directory of [this.directory, this.commands, this.receipts]) privateDirectory(directory, false);
	}

	pending(): string[] {
		this.assertPrivate();
		return fs.readdirSync(this.commands).filter(name => name.endsWith(".json") && REQUEST_ID.test(name.slice(0, -5))).sort().slice(0, 32);
	}

	hasReceipt(requestId: string): boolean {
		try { fs.lstatSync(path.join(this.receipts, `${requestId}.json`)); return true; }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
	}

	receipt(value: Receipt): void {
		this.assertPrivate();
		atomicJson(path.join(this.receipts, `${value.requestId}.json`), value);
	}

	removeCommand(name: string): void {
		try { fs.unlinkSync(path.join(this.commands, name)); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
}
