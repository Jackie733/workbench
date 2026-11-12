import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { MAX_TEXT_BYTES, type Activity, type InspectCommand } from "./runtime";

export interface Baseline { head: string; fingerprint: string; dirty: boolean }
export interface Preview {
	previewToken: string; text: string; sha256: string; requirementId: string;
	requirementRevision: number; activity: Activity; baseline: Baseline;
	sources: { path: string; sha256: string }[];
}
interface StoredPreview extends Preview {
	root: string; sessionId: string; expiresAt: number;
	requirementSha256: string; approvalId?: string; latestVersion: number;
}
interface Authorization { approval: Record<string, unknown>; designBody: string }
const ACTIVITY_LABELS: Record<Activity,string> = { clarify: "澄清需求", design: "设计方案", implement: "实施已授权需求" };
const ACTIONABLE_STAGES: Record<string,true> = {backlog:true,clarifying:true,designing:true,awaiting_approval:true,implementing:true};
function record(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}
const TOKEN = /^[A-Za-z0-9_-]{1,96}$/;
const SHA = /^[a-f0-9]{64}$/;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

/** The same ordered UTF-8 JSON content contract used by the native workflow store. */
export function requirementContent(r: Record<string, unknown>): string {
	if (typeof r.title !== "string" || !r.title.trim() || typeof r.goal !== "string" || !r.goal.trim()
		|| typeof r.scope !== "string" || !["feature", "bug", "chore"].includes(r.type as string)
		|| !["low", "normal", "high", "urgent"].includes(r.priority as string)
		|| !Array.isArray(r.acceptanceCriteria) || r.acceptanceCriteria.length > 32
		|| !Array.isArray(r.labels) || r.labels.length > 16 || r.labels.some(v => typeof v !== "string")) throw new Error("invalid_requirement");
	const ids = new Set<string>();
	const criteria = r.acceptanceCriteria.map(c => {
		if (!record(c) || typeof c.id !== "string" || !c.id || ids.has(c.id)
			|| typeof c.description !== "string" || !c.description.trim() || typeof c.required !== "boolean") throw new Error("invalid_requirement");
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
function jsonFile(root: string, relative: string): Record<string, unknown> {
	const result: unknown = JSON.parse(projectFile(root, relative, 262144, true).body);
	if (!record(result) || result.schemaVersion !== 1) throw new Error("invalid_project_record");
	return result;
}
export function readRequirement(root: string, id: string): Record<string, unknown> {
	if (!TOKEN.test(id)) throw new Error("invalid_requirement");
	const p = jsonFile(root, ".omp/workbench/project.json");
	const r = jsonFile(root, `.omp/workbench/requirements/${id}/requirement.json`);
	if (p.root !== root || typeof p.projectId !== "string" || !TOKEN.test(p.projectId)
		|| r.projectId !== p.projectId || r.requirementId !== id || typeof r.number !== "string" || !/^REQ-\d{4,}$/.test(r.number)
		|| !Number.isSafeInteger(r.revision) || (r.revision as number) < 1) throw new Error("project_mismatch");
	requirementContent(r);
	return r;
}
function workflow(root: string, r: Record<string, unknown>): Record<string, unknown> {
	const relative = `.omp/workbench/requirements/${r.requirementId}/workflow.json`;
	let w: Record<string, unknown>;
	try { w = jsonFile(root, relative); }
	catch (error) {
		if (record(error) && error.code === "ENOENT") return { latestVersion: 0, designs: [], requests: [] };
		throw error;
	}
	if (w.projectId !== r.projectId || w.requirementId !== r.requirementId || !Number.isSafeInteger(w.revision)
		|| !Number.isSafeInteger(w.latestVersion) || !Array.isArray(w.designs) || !Array.isArray(w.requests)) throw new Error("invalid_workflow");
	return w;
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
	return { head, fingerprint: digest.digest("hex"), dirty: status.length > 0 };
}

function approved(root: string, r: Record<string, unknown>, w: Record<string, unknown>, baseline: Baseline): Authorization {
	const a = w.approval;
	const contentSha = createHash("sha256").update(requirementContent(r)).digest("hex");
	if (!record(a) || typeof a.id !== "string" || !TOKEN.test(a.id) || a.revokedAt != null
		|| a.requirementRevision !== r.revision || a.requirementSha256 !== contentSha
		|| a.latestVersion !== w.latestVersion) throw new Error("approval_required_or_stale");
	if (!record(a.baseline) || a.baseline.head !== baseline.head || a.baseline.fingerprint !== baseline.fingerprint) throw new Error("baseline_changed");
	let designBody = "";
	if (a.mode === "direct") {
		if (a.designVersion !== 0 || a.designSha256 !== "" || !(r.scope as string).trim()
			|| !(r.acceptanceCriteria as unknown[]).length || typeof a.reason !== "string" || !a.reason.trim()) throw new Error("invalid_direct_authorization");
	} else if (a.mode === "design") {
		if (a.designVersion !== w.latestVersion || !Number.isSafeInteger(a.designVersion) || (a.designVersion as number) < 1) throw new Error("design_changed");
		const v = jsonFile(root, `.omp/workbench/requirements/${r.requirementId}/designs/v${a.designVersion}.json`);
		if (v.requirementId !== r.requirementId || v.projectId !== r.projectId || v.version !== a.designVersion
			|| v.requirementRevision !== r.revision || v.requirementSha256 !== contentSha || typeof v.body !== "string"
			|| Buffer.byteLength(v.body, "utf8") > MAX_TEXT_BYTES || !SHA.test(v.sha256 as string)
			|| createHash("sha256").update(v.body).digest("hex") !== v.sha256 || a.designSha256 !== v.sha256) throw new Error("design_changed");
		designBody = v.body;
	} else throw new Error("approval_required_or_stale");
	return { approval: a, designBody };
}

/** Factory-local reviewed payloads: bounded, expiring, never put on heartbeat snapshots. */
export class Handoff {
	private readonly previews = new Map<string, StoredPreview>();
	clear(): void { this.previews.clear(); }

	inspect(command: InspectCommand, root: string, sessionId: string, branch: readonly unknown[], now = Date.now()): unknown {
		const r = readRequirement(root, command.requirementId);
		if (command.operation === "file") return { file: { path: command.path!, ...projectFile(root, command.path!) } };
		if (command.operation === "baseline") return { baseline: gitBaseline(root) };
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
			approvalId: a?.id as string | undefined, latestVersion: w.latestVersion as number };
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
			const a = approved(root, r, w, gitBaseline(root)).approval;
			if (a.id !== p.approvalId || w.latestVersion !== p.latestVersion) throw new Error("approval_changed");
		}
		if (sending) {
			const intent = (w.requests as unknown[]).find(v => record(v) && v.requestId === requestId);
			if (!record(intent) || intent.status !== "pending" || intent.activity !== p.activity || intent.sessionId !== sessionId
				|| intent.instanceId !== instanceId || intent.payloadSha256 !== p.sha256 || intent.requirementRevision !== p.requirementRevision
				|| intent.requirementSha256 !== p.requirementSha256) throw new Error("request_intent_mismatch");
		}
		return p;
	}

	consume(token: string): void { this.previews.delete(token); }
}
