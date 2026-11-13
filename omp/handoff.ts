import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { MAX_TEXT_BYTES, type Activity, type InspectCommand } from "./runtime";

export interface BaselineFile { path: string; status: string; sha256: string | null }
export interface Baseline { head: string; fingerprint: string; dirty: boolean; files: BaselineFile[]; filesTruncated: boolean }
export interface WorkspaceChange { capturedAt: number; head: string; fingerprint: string; dirty: boolean;
	files: BaselineFile[]; filesTruncated: boolean; diff: string; diffSha256: string; diffTruncated: boolean;
	commits: { hash: string; at: number; author: string; subject: string }[]; commitsTruncated: boolean }
export interface Preview {
	previewToken: string; text: string; sha256: string; requirementId: string;
	requirementRevision: number; activity: Activity; baseline: Baseline;
	sources: { path: string; sha256: string }[];
}
interface StoredPreview extends Preview {
	root: string; sessionId: string; expiresAt: number;
	requirementSha256: string; approvalId?: string; latestVersion: number; authorizationSnapshot?: string;
}
interface Authorization { approval: Record<string, unknown>; designBody: string; snapshot: string }
const ACTIVITY_LABELS: Record<Activity,string> = { clarify: "澄清需求", design: "设计方案", implement: "实施已授权需求" };
const ACTIONABLE_STAGES: Record<string,true> = {backlog:true,clarifying:true,designing:true,awaiting_approval:true,implementing:true};
function record(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}
const TOKEN = /^[A-Za-z0-9_-]{1,96}$/;
const SHA = /^[a-f0-9]{64}$/;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const STAGES: Record<string, true> = {backlog:true,clarifying:true,designing:true,awaiting_approval:true,implementing:true,
	verifying:true,awaiting_acceptance:true,done:true,blocked:true,cancelled:true};
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every(key => allowed.includes(key));
}
function integer(value: unknown, min = 0): value is number {
	return Number.isSafeInteger(value) && (value as number) >= min;
}
function text(value: unknown, max: number, empty = false): value is string {
	return typeof value === "string" && Buffer.byteLength(value, "utf8") <= max && !CONTROL.test(value)
		&& (empty || !!value.trim()) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
}
function identityValid(value: Record<string, unknown>, schema: unknown): boolean {
	return value.requirementContentRevision === undefined || (schema === 2 && integer(value.requirementContentRevision, 1)
		&& integer(value.requirementRevision, 1) && value.requirementContentRevision <= value.requirementRevision);
}
/** Legacy decisions remain CAS-bound; never infer a content marker during upgrade. */
function matchesRequirement(value: Record<string, unknown>, requirement: Record<string, unknown>): boolean {
	return value.requirementContentRevision === undefined ? value.requirementRevision === requirement.revision
		: value.requirementContentRevision === (requirement.contentRevision ?? requirement.revision);
}
function same(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
	if (!record(a) || !record(b)) return false;
	return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => same(a[key], b[key]));
}

/** The same ordered UTF-8 JSON content contract used by the native workflow store. */
export function requirementContent(r: Record<string, unknown>): string {
	if (!text(r.title, 200) || !text(r.goal, 16000) || !text(r.scope, 16000, true)
		|| !["feature", "bug", "chore"].includes(r.type as string)
		|| !["low", "normal", "high", "urgent"].includes(r.priority as string)
		|| !Array.isArray(r.acceptanceCriteria) || r.acceptanceCriteria.length > 32
		|| !Array.isArray(r.labels) || r.labels.length > 16 || r.labels.some(v => !text(v, 40))) throw new Error("invalid_requirement");
	const ids = new Set<string>();
	const criteria = r.acceptanceCriteria.map(c => {
		if (!record(c) || !keys(c, ["id", "description", "required"]) || !text(c.id, 32) || ids.has(c.id)
			|| !text(c.description, 1000) || typeof c.required !== "boolean") throw new Error("invalid_requirement");
		ids.add(c.id);
		return [c.id, c.description, c.required];
	});
	return JSON.stringify([r.title, r.type, r.priority, r.goal, r.scope, criteria, r.labels]);
}

/** Reads the opened inode, not a path that can silently escape through a symlink. */
export function projectFile(root: string, relative: string, limit = MAX_TEXT_BYTES, internal = false): { body: string; sha256: string } {
	if (!relative || relative.length > 2048 || path.isAbsolute(relative) || /[\\\x00-\x1f\x7f]/.test(relative)
		|| relative.split("/").some(part => !part || part === "." || part === "..")
		|| (!internal && (relative === ".git" || relative.startsWith(".git/") || relative === ".omp/workbench" || relative.startsWith(".omp/workbench/")))) throw new Error("invalid_path");
	const canonicalRoot = fs.realpathSync(root);
	let cursor = canonicalRoot;
	for (const part of relative.split("/")) {
		cursor = path.join(cursor, part);
		if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("symlink_not_allowed");
	}
	const fd = fs.openSync(cursor, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	try {
		const info = fs.fstatSync(fd);
		const opened = fs.realpathSync(`/proc/self/fd/${fd}`);
		if (!opened.startsWith(`${canonicalRoot}${path.sep}`) || !info.isFile()) throw new Error("invalid_file");
		if (info.size > limit) throw new Error("material_too_large");
		const buffer = Buffer.alloc(limit + 1);
		let n = 0;
		while (n < buffer.length) { const got = fs.readSync(fd, buffer, n, buffer.length - n, null); if (!got) break; n += got; }
		if (n > limit) throw new Error("material_too_large");
		const bytes = buffer.subarray(0, n);
		const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if (CONTROL.test(body)) throw new Error("invalid_text");
		return { body, sha256: createHash("sha256").update(bytes).digest("hex") };
	} finally { fs.closeSync(fd); }
}
function jsonFile(root: string, relative: string, entity: "project" | "requirement" | "workflow" | "design"): Record<string, unknown> {
	const result: unknown = JSON.parse(projectFile(root, relative, 262144, true).body);
	if (!record(result) || (result.schemaVersion !== 1 && (entity === "project" || result.schemaVersion !== 2))) throw new Error("invalid_project_record");
	return result;
}
export function readRequirement(root: string, id: string): Record<string, unknown> {
	if (!TOKEN.test(id)) throw new Error("invalid_requirement");
	const p = jsonFile(root, ".omp/workbench/project.json", "project");
	const r = jsonFile(root, `.omp/workbench/requirements/${id}/requirement.json`, "requirement");
	if (p.root !== root || typeof p.projectId !== "string" || !TOKEN.test(p.projectId)
		|| r.projectId !== p.projectId || r.requirementId !== id || typeof r.number !== "string" || !/^REQ-\d{4,}$/.test(r.number)
		|| !integer(r.revision, 1)) throw new Error("project_mismatch");
	if (!keys(p, ["schemaVersion", "projectId", "root", "name", "revision", "nextNumber", "createdAt"])
		|| !keys(r, ["schemaVersion", "projectId", "requirementId", "number", "revision", "title", "type", "priority", "stage", "goal", "scope",
			"acceptanceCriteria", "labels", "createdAt", "updatedAt", "blockedFrom", "blockedReason", "extensions", "contentRevision", "lifecycleEvents"])
		|| !integer(r.createdAt) || !integer(r.updatedAt) || !Object.hasOwn(STAGES, r.stage as string)
		|| (r.blockedFrom !== undefined && !Object.hasOwn(STAGES, r.blockedFrom as string))
		|| (r.blockedReason !== undefined && !text(r.blockedReason, 2000, true))
		|| (r.extensions !== undefined && !record(r.extensions))) throw new Error("invalid_requirement");
	if (r.schemaVersion === 1) {
		if (r.contentRevision !== undefined || r.lifecycleEvents !== undefined) throw new Error("invalid_requirement");
	} else {
		if (!integer(r.contentRevision, 1) || r.contentRevision > r.revision || !Array.isArray(r.lifecycleEvents)
			|| r.lifecycleEvents.length > 200) throw new Error("invalid_requirement");
		const ids = new Set<string>();
		for (const e of r.lifecycleEvents) {
			if (!record(e) || !keys(e, ["id", "action", "from", "to", "reason", "at", "previousBlockedFrom", "previousBlockedReason"]) || typeof e.id !== "string" || !TOKEN.test(e.id)
				|| ids.has(e.id) || !["block", "unblock", "cancel", "reopen"].includes(e.action as string)
				|| !Object.hasOwn(STAGES, e.from as string) || !Object.hasOwn(STAGES, e.to as string) || !text(e.reason, 2000) || !integer(e.at)) throw new Error("invalid_requirement");
			if ((e.previousBlockedFrom !== undefined && (e.from !== "blocked" || !Object.hasOwn(STAGES, e.previousBlockedFrom as string)
				|| (e.action === "unblock" && e.previousBlockedFrom !== e.to)))
				|| (e.previousBlockedReason !== undefined && (e.from !== "blocked" || !text(e.previousBlockedReason, 2000, true)))) throw new Error("invalid_requirement");
			const terminal = e.from === "done" || e.from === "cancelled";
			if (!(e.action === "block" && !terminal && e.from !== "blocked" && e.to === "blocked")
				&& !(e.action === "unblock" && e.from === "blocked" && !["blocked", "done", "cancelled"].includes(e.to as string))
				&& !(e.action === "cancel" && !terminal && e.to === "cancelled")
				&& !(e.action === "reopen" && terminal && e.to === "clarifying")) throw new Error("invalid_requirement");
			ids.add(e.id);
		}
	}
	requirementContent(r);
	return r;
}
function workflow(root: string, r: Record<string, unknown>): Record<string, unknown> {
	const relative = `.omp/workbench/requirements/${r.requirementId}/workflow.json`;
	let w: Record<string, unknown>;
	try { w = jsonFile(root, relative, "workflow"); }
	catch (error) {
		if (record(error) && error.code === "ENOENT") return { latestVersion: 0, designs: [], requests: [] };
		throw error;
	}
	const invalid = () => { throw new Error("invalid_workflow"); };
	if (w.projectId !== r.projectId || w.requirementId !== r.requirementId || !integer(w.revision, 1) || !integer(w.latestVersion)
		|| !keys(w, ["schemaVersion", "projectId", "requirementId", "revision", "latestVersion", "designs", "comments", "approvals", "approval", "requests"])
		|| !Array.isArray(w.designs) || w.designs.length !== w.latestVersion || !Array.isArray(w.comments)
		|| !Array.isArray(w.approvals) || !Array.isArray(w.requests)) return invalid();
	for (const [i, d] of w.designs.entries()) {
		if (!record(d) || !keys(d, ["version", "sha256", "requirementSha256", "requirementRevision", "requirementContentRevision", "createdAt"])
			|| d.version !== i + 1 || typeof d.sha256 !== "string" || !SHA.test(d.sha256) || typeof d.requirementSha256 !== "string"
			|| !SHA.test(d.requirementSha256) || !integer(d.requirementRevision, 1) || !identityValid(d, w.schemaVersion) || !integer(d.createdAt)) return invalid();
	}
	for (const c of w.comments) {
		if (!record(c) || !keys(c, ["designVersion", "text", "createdAt"]) || !integer(c.designVersion, 1)
			|| c.designVersion > w.latestVersion || !text(c.text, 4000) || !integer(c.createdAt)) return invalid();
	}
	const approvals = new Map<string, Record<string, unknown>>();
	for (const a of w.approvals) {
		if (!record(a) || !keys(a, ["id", "mode", "requirementRevision", "requirementContentRevision", "requirementSha256", "requirementContent",
			"designVersion", "designSha256", "latestVersion", "baseline", "approvedAt", "reason", "revokedAt", "revocationReason"])
			|| typeof a.id !== "string" || !TOKEN.test(a.id) || approvals.has(a.id) || !["direct", "design"].includes(a.mode as string)
			|| !integer(a.requirementRevision, 1) || !identityValid(a, w.schemaVersion) || typeof a.requirementSha256 !== "string"
			|| !SHA.test(a.requirementSha256) || typeof a.requirementContent !== "string" || !integer(a.latestVersion) || !integer(a.designVersion)
			|| !record(a.baseline) || typeof a.baseline.head !== "string" || typeof a.baseline.fingerprint !== "string"
			|| !/^[a-fA-F0-9]{64}$/.test(a.baseline.fingerprint) || typeof a.baseline.dirty !== "boolean" || !integer(a.approvedAt)) return invalid();
		const b = a.baseline;
		if (!keys(b, ["head", "fingerprint", "dirty", "files", "filesTruncated"]) || Buffer.byteLength(b.head as string, "utf8") > 128
			|| (a.reason !== undefined && !text(a.reason, 2000)) || (a.mode === "direct" && !text(a.reason, 2000))
			|| (a.mode === "design" && (typeof a.designSha256 !== "string" || !SHA.test(a.designSha256) || (a.designVersion as number) < 1))
			|| (a.revokedAt !== undefined && (!integer(a.revokedAt) || !text(a.revocationReason, 2000)))
			|| (a.revocationReason !== undefined && a.revokedAt === undefined)
			|| (b.filesTruncated !== undefined && typeof b.filesTruncated !== "boolean")
			|| (b.files !== undefined && !Array.isArray(b.files))) return invalid();
		for (const file of (b.files ?? []) as unknown[]) {
			if (!record(file) || !keys(file, ["path", "status", "sha256"]) || !text(file.path, 2048) || !text(file.status, 32)
				|| (file.sha256 != null && (typeof file.sha256 !== "string" || !SHA.test(file.sha256)))) return invalid();
		}
		approvals.set(a.id, a);
	}
	if (w.approval !== undefined && (!record(w.approval) || typeof w.approval.id !== "string" || !same(w.approval, approvals.get(w.approval.id)))) return invalid();
	const requests = new Set<string>();
	for (const q of w.requests) {
		if (!record(q) || !keys(q, ["requestId", "activity", "sessionId", "instanceId", "payloadSha256", "status", "requirementRevision",
			"requirementContentRevision", "authorizedRequirementRevision", "requirementSha256", "currentRequirementRevision", "createdAt", "reason", "receivedAt", "resolution"])
			|| typeof q.requestId !== "string" || !TOKEN.test(q.requestId) || requests.has(q.requestId) || !["clarify", "design", "implement"].includes(q.activity as string)
			|| typeof q.sessionId !== "string" || !TOKEN.test(q.sessionId) || typeof q.instanceId !== "string" || !TOKEN.test(q.instanceId)
			|| typeof q.payloadSha256 !== "string" || !SHA.test(q.payloadSha256) || typeof q.requirementSha256 !== "string" || !SHA.test(q.requirementSha256)
			|| !integer(q.requirementRevision, 1) || !identityValid(q, w.schemaVersion) || !integer(q.authorizedRequirementRevision, 1)
			|| !integer(q.currentRequirementRevision, 1) || !integer(q.createdAt) || !["pending", "submitted", "rejected", "delivery_unknown"].includes(q.status as string)
			|| (q.reason !== undefined && !text(q.reason, 1000, true)) || (q.receivedAt !== undefined && !integer(q.receivedAt))
			|| (q.status !== "pending" && (!text(q.reason ?? "", 1000, true) || !integer(q.receivedAt)))) return invalid();
		if (q.resolution !== undefined && (!record(q.resolution) || !keys(q.resolution, ["kind", "note", "at"])
			|| q.resolution.kind !== "user_acknowledged" || !text(q.resolution.note, 2000) || !integer(q.resolution.at) || q.status === "pending")) return invalid();
		requests.add(q.requestId);
	}
	return w;
}

const MAX_BASELINE_FILES = 256;
const MAX_FILE_HASH_BYTES = 512 * 1024;
const MAX_DIFF_BYTES = 48 * 1024;
function workingFiles(root: string, status: Buffer): { files: BaselineFile[]; filesTruncated: boolean } {
	const parts = status.toString("utf8").split("\0");
	const files: BaselineFile[] = [];
	let truncated = false;
	let total = 0;
	for (let i = 0; i < parts.length; i++) {
		const entry = parts[i];
		if (!entry) continue;
		const code = entry.slice(0, 2);
		const name = entry.slice(3);
		if (code[0] === "R" || code[0] === "C") i++; // the original path follows a rename/copy entry
		if (!name || name.length > 2048 || /[\x00-\x1f\x7f]/.test(name)) { truncated = true; continue; }
		if (files.length >= MAX_BASELINE_FILES) { truncated = true; break; }
		let sha256: string | null = null;
		if (!code.includes("D")) {
			try {
				const absolute = path.join(root, name);
				const info = fs.lstatSync(absolute);
				if (info.isFile() && info.size <= MAX_FILE_HASH_BYTES && total + info.size <= 4 * 1024 * 1024) {
					const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
					try {
						if (!fs.fstatSync(fd).isFile()) throw new Error("invalid_baseline_file");
						const buffer = Buffer.alloc(info.size);
						let n = 0;
						while (n < buffer.length) { const got = fs.readSync(fd, buffer, n, buffer.length - n, null); if (!got) break; n += got; }
						total += n;
						sha256 = createHash("sha256").update(buffer.subarray(0, n)).digest("hex");
					} finally { fs.closeSync(fd); }
				}
			} catch { sha256 = null; }
		}
		files.push({ path: name, status: code.replace(/ /g, "") || "?", sha256 });
	}
	return { files, filesTruncated: truncated };
}

/** A real pre-execution baseline; business metadata cannot invalidate its own approval. */
export function gitBaseline(root: string): Baseline {
	const args = { cwd: root, timeout: 3000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] as const };
	const git = (values: string[]) => execFileSync("git", values, args);
	if (git(["rev-parse", "--show-toplevel"]).toString().trim() !== root) throw new Error("project_mismatch");
	let head = "";
	try { head = git(["rev-parse", "--verify", "--quiet", "HEAD"]).toString().trim(); }
	catch (error) { if (!record(error) || error.status !== 1) throw error; }
	const scope = ["--", ".", ":(exclude).omp/workbench"];
	const status = git(["status", "--porcelain=v1", "-z", "--untracked-files=all", ...scope]);
	const digest = createHash("sha256");
	digest.update(`HEAD\0${head}\0`);
	for (const diff of [git(["diff", "--binary", "--no-ext-diff", "--no-textconv", ...scope]), git(["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", ...scope])]) {
		digest.update(String(diff.length)); digest.update("\0"); digest.update(diff);
	}
	digest.update(status);
	const files = git(["ls-files", "--others", "--exclude-standard", "-z", ...scope]).toString("utf8").split("\0").filter(Boolean).sort();
	if (files.length > 1024) throw new Error("baseline_too_large");
	const buffer = Buffer.alloc(65536);
	let total = 0;
	for (const name of files) {
		const absolute = path.join(root, name);
		const info = fs.lstatSync(absolute);
		digest.update(`\0${name}\0`);
		if (info.isSymbolicLink()) { digest.update(`link\0${fs.readlinkSync(absolute)}`); continue; }
		if (!info.isFile() || total + info.size > 4 * 1024 * 1024) throw new Error("baseline_too_large");
		const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
		try {
			if (!fs.fstatSync(fd).isFile()) throw new Error("invalid_baseline_file");
			const content = createHash("sha256");
			let fileBytes = 0;
			let bytes: number;
			while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
				total += bytes;
				fileBytes += bytes;
				if (total > 4 * 1024 * 1024) throw new Error("baseline_too_large");
				content.update(buffer.subarray(0, bytes));
			}
			digest.update(`file\0${fileBytes}\0${content.digest("hex")}`);
		} finally { fs.closeSync(fd); }
	}
	const snapshot = workingFiles(root, status);
	return { head, fingerprint: digest.digest("hex"), dirty: status.length > 0, ...snapshot };
}

/** Observed since a real baseline. Attribution stays unknown: Git cannot prove task authorship. */
export function workspaceChanges(root: string, since?: string): WorkspaceChange {
	const args = { cwd: root, timeout: 5000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] as const };
	const git = (values: string[]) => execFileSync("git", values, args);
	const baseline = gitBaseline(root);
	const scope = ["--", ".", ":(exclude).omp/workbench"];
	let diff = git(baseline.head ? ["diff", "--no-ext-diff", "--no-textconv", "HEAD", ...scope] : ["diff", "--no-ext-diff", "--no-textconv", ...scope]).toString("utf8");
	let diffTruncated = false;
	if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) { diff = Buffer.from(diff).subarray(0, MAX_DIFF_BYTES).toString("utf8"); diffTruncated = true; }
	const untracked = baseline.files.filter(file => file.status === "??").slice(0, 24);
	for (const file of untracked) {
		if (Buffer.byteLength(diff) >= MAX_DIFF_BYTES) { diffTruncated = true; break; }
		let body: Buffer;
		try { body = fs.readFileSync(path.join(root, file.path)); } catch { continue; }
		const header = `\ndiff --git a/${file.path} b/${file.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${file.path}\n`;
		if (body.includes(0)) { diff += `${header}Binary file omitted from preview.\n`; continue; }
		const text = body.subarray(0, 8192).toString("utf8");
		if (body.length > 8192) diffTruncated = true;
		diff += header + text.split("\n").map(line => `+${line}`).join("\n");
		if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) { diff = Buffer.from(diff).subarray(0, MAX_DIFF_BYTES).toString("utf8"); diffTruncated = true; break; }
	}
	const commits: WorkspaceChange["commits"] = [];
	let commitsTruncated = false;
	if (baseline.head) {
		const range = since && /^[0-9a-f]{7,64}$/.test(since) ? `${since}..HEAD` : "HEAD";
		const log = git(["log", "-n", "51", "--format=%H%x1f%at%x1f%an%x1f%s", range, "--"]).toString("utf8");
		for (const line of log.split("\n")) {
			if (!line) continue;
			const [hash, at, author, subject] = line.split("\x1f");
			if (commits.length >= 50) { commitsTruncated = true; break; }
			if (!hash || !/^[0-9a-f]{40,64}$/.test(hash) || !Number.isSafeInteger(Number(at))) continue;
			commits.push({ hash, at: Number(at), author: (author || "").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200),
				subject: (subject || "").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 500) });
		}
	}
	return { capturedAt: Date.now(), head: baseline.head, fingerprint: baseline.fingerprint, dirty: baseline.dirty,
		files: baseline.files, filesTruncated: baseline.filesTruncated, diff,
		diffSha256: createHash("sha256").update(diff).digest("hex"), diffTruncated, commits, commitsTruncated };
}

function approved(root: string, r: Record<string, unknown>, w: Record<string, unknown>, baseline: Baseline): Authorization {
	const a = w.approval;
	const content = requirementContent(r);
	const contentSha = createHash("sha256").update(content).digest("hex");
	if (!record(a) || typeof a.id !== "string" || !TOKEN.test(a.id) || a.revokedAt != null
		|| !matchesRequirement(a, r) || a.requirementContent !== content || a.requirementSha256 !== contentSha
		|| a.latestVersion !== w.latestVersion) throw new Error("approval_required_or_stale");
	if (!record(a.baseline) || a.baseline.head !== baseline.head || a.baseline.fingerprint !== baseline.fingerprint) throw new Error("baseline_changed");
	let designBody = "";
	let design: Record<string, unknown> | undefined;
	if (a.mode === "direct") {
		if (a.designVersion !== 0 || a.designSha256 !== "" || !(r.scope as string).trim()
			|| !(r.acceptanceCriteria as unknown[]).length || typeof a.reason !== "string" || !a.reason.trim()) throw new Error("invalid_direct_authorization");
	} else if (a.mode === "design") {
		if (a.designVersion !== w.latestVersion || !Number.isSafeInteger(a.designVersion) || (a.designVersion as number) < 1) throw new Error("design_changed");
		const metadata = (w.designs as unknown[])[(a.designVersion as number) - 1];
		if (!record(metadata) || !matchesRequirement(metadata, r) || metadata.sha256 !== a.designSha256
			|| metadata.requirementSha256 !== a.requirementSha256) throw new Error("design_changed");
		const v = jsonFile(root, `.omp/workbench/requirements/${r.requirementId}/designs/v${a.designVersion}.json`, "design");
		if (!keys(v, ["schemaVersion", "projectId", "requirementId", "version", "requirementRevision", "requirementContentRevision",
			"requirementSha256", "body", "sha256", "source", "createdAt"])
			|| v.requirementId !== r.requirementId || v.projectId !== r.projectId || v.version !== a.designVersion
			|| !integer(v.requirementRevision, 1) || !integer(v.createdAt) || !identityValid(v, v.schemaVersion)
			|| (v.schemaVersion === 2 && v.requirementContentRevision === undefined)
			|| v.requirementRevision !== metadata.requirementRevision || v.requirementContentRevision !== metadata.requirementContentRevision
			|| !matchesRequirement(v, r) || v.requirementSha256 !== contentSha || !text(v.body, MAX_TEXT_BYTES)
			|| typeof v.sha256 !== "string" || !SHA.test(v.sha256)
			|| createHash("sha256").update(v.body).digest("hex") !== v.sha256 || a.designSha256 !== v.sha256) throw new Error("design_changed");
		if (!record(v.source) || !keys(v.source, ["kind", "path", "entryId", "sessionId", "requestId"])
			|| !["manual", "file", "assistant"].includes(v.source.kind as string)
			|| Object.values(v.source).some(value => !text(value, 1024, true))) throw new Error("design_changed");
		design = v;
		designBody = v.body;
	} else throw new Error("approval_required_or_stale");
	return { approval: a, designBody, snapshot: JSON.stringify([a, design]) };
}

/** Factory-local reviewed payloads: bounded, expiring, never put on heartbeat snapshots. */
export class Handoff {
	private readonly previews = new Map<string, StoredPreview>();
	clear(): void { this.previews.clear(); }

	inspect(command: InspectCommand, root: string, sessionId: string, branch: readonly unknown[], now = Date.now()): unknown {
		const r = readRequirement(root, command.requirementId);
		if (command.operation === "file") return { file: { path: command.path!, ...projectFile(root, command.path!) } };
		if (command.operation === "baseline") return { baseline: gitBaseline(root) };
		if (command.operation === "changes") return { changes: workspaceChanges(root, command.since) };
		if (command.operation === "candidate") {
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (!record(entry) || entry.type !== "message" || typeof entry.id !== "string" || !record(entry.message)
					|| entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
				const text = entry.message.content.flatMap(b => record(b) && b.type === "text" && typeof b.text === "string" ? [b.text] : []).join("\n");
				if (!text.trim()) continue;
				if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES || CONTROL.test(text)) throw new Error("candidate_too_large_or_invalid");
				return { candidate: { entryId: entry.id, body: text, sessionId, observedAt: now,
					includesToolCalls: entry.message.content.some(b => record(b) && b.type === "toolCall") } };
			}
			throw new Error("no_text_candidate");
		}
		const activity = command.activity!;
		const baseline = gitBaseline(root);
		const w = workflow(root, r);
		const authorization = activity === "implement" ? approved(root, r, w, baseline) : undefined;
		const a = authorization?.approval;
		if (activity === "implement" && (typeof r.stage !== "string" || !Object.hasOwn(ACTIONABLE_STAGES,r.stage))) throw new Error("stage_not_actionable");
		if (activity === "implement" && !command.includeRequirement) throw new Error("implementation_requires_requirement");
		const parts = [`工作台请求：${ACTIVITY_LABELS[activity]}\n项目：${root}\n需求：${r.number} · ${r.title}\n需求修订：${r.revision}`];
		if (command.includeRequirement) {
			parts.push(`目标：\n${r.goal}\n范围：\n${r.scope}\n验收条件：\n${(r.acceptanceCriteria as {id:string;description:string;required:boolean}[]).map(c => `${c.id}${c.required ? "（必需）" : ""}：${c.description}`).join("\n")}`);
		}
		if (authorization && a?.mode === "design") {
			parts.push(`已批准方案 v${a.designVersion} · SHA256 ${a.designSha256}\n${authorization.designBody}`);
		} else if (a) parts.push(`快捷实施授权：${a.reason}\n仍须遵守上述范围与验收条件。`);
		const sources: {path:string;sha256:string}[] = [];
		for (const relative of [...new Set(command.paths!)]) {
			const file = projectFile(root, relative);
			parts.push(`选定文件：${relative}\n${file.body}`);
			sources.push({path:relative,sha256:file.sha256});
		}
		if (command.excerpt!.trim()) parts.push(`用户选定的讨论摘录：\n${command.excerpt}`);
		const text = parts.join("\n\n");
		if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) throw new Error("materials_too_large");
		if (CONTROL.test(text)) throw new Error("invalid_text");
		for (const [key, p] of this.previews) if (p.expiresAt <= now) this.previews.delete(key);
		while (this.previews.size >= 16) this.previews.delete(this.previews.keys().next().value!);
		const preview: StoredPreview = { previewToken: randomUUID(), text, sha256: createHash("sha256").update(text).digest("hex"),
			requirementId: command.requirementId, requirementRevision: r.revision as number, activity, baseline, sources,
			root, sessionId, expiresAt: now + 300000, requirementSha256: createHash("sha256").update(requirementContent(r)).digest("hex"),
			approvalId: a?.id as string | undefined, latestVersion: w.latestVersion as number, authorizationSnapshot: authorization?.snapshot };
		this.previews.set(preview.previewToken, preview);
		return { previewToken: preview.previewToken, text, sha256: preview.sha256, requirementId: preview.requirementId,
			requirementRevision: preview.requirementRevision, activity, baseline, sources } satisfies Preview;
	}

	resolve(token: string, root: string, sessionId: string, instanceId: string, requestId: string, sending: boolean, now = Date.now()): Preview {
		const p = this.previews.get(token);
		if (!p || p.expiresAt <= now || p.root !== root || p.sessionId !== sessionId) throw new Error("preview_expired_or_source_changed");
		const r = readRequirement(root, p.requirementId);
		if ((sending || p.activity === "implement") && (typeof r.stage !== "string" || !Object.hasOwn(ACTIONABLE_STAGES,r.stage))) throw new Error("stage_not_actionable");
		if (r.revision !== p.requirementRevision || createHash("sha256").update(requirementContent(r)).digest("hex") !== p.requirementSha256) throw new Error("requirement_changed");
		for (const source of p.sources) if (projectFile(root, source.path).sha256 !== source.sha256) throw new Error("source_file_changed");
		const w = workflow(root, r);
		if (p.activity === "implement") {
			const authorization = approved(root, r, w, gitBaseline(root));
			if (authorization.approval.id !== p.approvalId || w.latestVersion !== p.latestVersion
				|| authorization.snapshot !== p.authorizationSnapshot) throw new Error("approval_changed");
		}
		if (sending) {
			const intent = (w.requests as unknown[]).find(v => record(v) && v.requestId === requestId);
			if (!record(intent) || intent.status !== "pending" || intent.activity !== p.activity || intent.sessionId !== sessionId
				|| intent.instanceId !== instanceId || intent.payloadSha256 !== p.sha256 || intent.requirementRevision !== p.requirementRevision
				|| !matchesRequirement(intent, r) || intent.requirementSha256 !== p.requirementSha256) throw new Error("request_intent_mismatch");
		}
		return p;
	}

	consume(token: string): void { this.previews.delete(token); }
}
