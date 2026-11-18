import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { WorkbenchError } from "./errors.ts";
import {
  atomicWriteBuffer,
  atomicWriteFile,
  atomicWriteJson,
  canonicalRoot,
  listDirSafe,
  readBoundedBuffer,
  readBoundedText,
  readJsonStrict,
  resolveSafePath,
  withProjectWriteLock,
} from "./fs.ts";
import {
  MAX_DESIGN_BYTES,
  MAX_EVIDENCE_BYTES,
  MAX_HANDOFF_BYTES,
  MAX_ACCEPTANCE_SNAPSHOT_BYTES,
  MAX_SCREENSHOT_BATCHES,
  MAX_SCREENSHOT_BYTES,
  MAX_SPEC_BYTES,
  MAX_STATE_BYTES,
  SCHEMA_VERSION,
  WORKBENCH_DIR,
  type AcceptanceArtifactStatus,
  type AcceptanceSnapshot,
  type AcceptanceSnapshotReference,
  type AgentRunRecord,
  type OutputLanguage,
  type PrivacyMode,
  type ProjectMetadata,
  type RequirementState,
  type ScreenshotBatch,
  type ScreenshotShot,
  type VerificationRecord,
} from "./types.ts";
import { normalizeOutputLanguage } from "./language.ts";
import {
  assertRequirementId,
  isSafeText,
  REQUIREMENT_ID_RE,
  validateAgentRunRecord,
  validateAcceptanceSnapshot,
  validateMarkdownContent,
  validateProjectMetadata,
  validateRequirementState,
  validateScreenshotBatch,
  validateScreenshotShot,
  validateVerificationRecord,
} from "./validate.ts";

export interface RequirementBundle {
  state: RequirementState;
  specMarkdown: string;
  designMarkdown: string;
  handoffMarkdown: string;
  designHistoryVersions: number[];
  /** Frozen acceptance artifact; null for active requirements and legacy records without an artifact. */
  acceptanceSnapshot: AcceptanceSnapshot | null;
  acceptanceSnapshotStatus: AcceptanceArtifactStatus;
  acceptanceSnapshotReason: string | null;
}

export function formatRequirementId(num: number): string {
  return `REQ-${String(num).padStart(3, "0")}`;
}

export function isProjectInitialized(root: string): boolean {
  const base = canonicalRoot(root);
  const projectPath = path.join(base, WORKBENCH_DIR, "project.json");
  return fs.existsSync(projectPath);
}

function ensureLocalGitExclude(base: string): void {
  const gitDir = path.join(base, ".git");
  if (!fs.existsSync(gitDir)) return;
  const lstat = fs.lstatSync(gitDir);
  if (lstat.isSymbolicLink() || !lstat.isDirectory()) return;

  const excludePath = resolveSafePath(base, ".git/info/exclude");
  let current = "";
  if (fs.existsSync(excludePath)) {
    current = readBoundedText(excludePath, 128 * 1024);
  }
  const lines = current.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes("/.workbench/") || lines.includes(".workbench/") || lines.includes(".workbench")) {
    return;
  }
  const suffix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  atomicWriteFile(excludePath, `${current}${suffix}/.workbench/\n`);
}

export async function initProject(
  root: string,
  options: { name?: string; privacyMode?: PrivacyMode; outputLanguage?: OutputLanguage } = {},
): Promise<ProjectMetadata> {
  const base = canonicalRoot(root);
  return withProjectWriteLock(base, () => {
    const projectPath = resolveSafePath(base, `${WORKBENCH_DIR}/project.json`);
    if (fs.existsSync(projectPath)) {
      throw new WorkbenchError("already_initialized", "项目已经初始化过 .workbench/");
    }
    const privacyMode: PrivacyMode = options.privacyMode === "tracked" ? "tracked" : "local";
    const defaultName = path.basename(base) || "workbench-project";
    const name = options.name?.trim() ? options.name.trim() : defaultName;
    if (!isSafeText(name, 200)) {
      throw new WorkbenchError("invalid_input", "项目名称无效或过长");
    }
    const outputLanguage =
      options.outputLanguage !== undefined ? normalizeOutputLanguage(options.outputLanguage) : undefined;
    if (options.outputLanguage !== undefined && !outputLanguage) {
      throw new WorkbenchError("invalid_input", `不支持的输出语言: ${String(options.outputLanguage)}`);
    }
    const now = Date.now();
    const metadata: ProjectMetadata = {
      schemaVersion: SCHEMA_VERSION,
      projectId: randomUUID(),
      name,
      nextNumber: 1,
      privacyMode,
      ...(outputLanguage ? { outputLanguage } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const itemsDir = resolveSafePath(base, `${WORKBENCH_DIR}/items`);
    fs.mkdirSync(itemsDir, { recursive: true });
    atomicWriteJson(projectPath, metadata);
    if (privacyMode === "local") {
      ensureLocalGitExclude(base);
    }
    return metadata;
  });
}

export function readProject(root: string): ProjectMetadata {
  const base = canonicalRoot(root);
  const projectPath = resolveSafePath(base, `${WORKBENCH_DIR}/project.json`);
  if (!fs.existsSync(projectPath)) {
    throw new WorkbenchError("not_initialized", "项目尚未初始化 .workbench/，请先执行初始化");
  }
  const raw = readJsonStrict<unknown>(projectPath, 64 * 1024);
  return validateProjectMetadata(raw);
}

export function listRequirementIds(root: string): string[] {
  const base = canonicalRoot(root);
  readProject(base);
  const itemsDir = resolveSafePath(base, `${WORKBENCH_DIR}/items`);
  const entries = listDirSafe(itemsDir);
  return entries
    .filter((entry) => entry.isDirectory() && REQUIREMENT_ID_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function listDesignHistoryVersions(base: string, id: string): number[] {
  const historyDir = resolveSafePath(base, `${WORKBENCH_DIR}/items/${id}/history`);
  const entries = listDirSafe(historyDir);
  const versions: number[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = /^design\.v(\d+)\.md$/.exec(entry.name);
    if (match) {
      versions.push(Number(match[1]));
    }
  }
  return versions.sort((a, b) => a - b);
}

export function acceptanceSnapshotPath(id: string, snapshotId: string): string {
  assertRequirementId(id);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(snapshotId)) {
    throw new WorkbenchError("invalid_input", `无效的验收快照 ID: ${snapshotId}`);
  }
  return `${WORKBENCH_DIR}/items/${id}/snapshots/acceptance-${snapshotId}.json`;
}

function snapshotRelPath(snapshotId: string): string {
  return `snapshots/acceptance-${snapshotId}.json`;
}

/** Content digest over the snapshot without its own digest field; binds the artifact to its exact bytes. */
export function computeAcceptanceSnapshotDigest(snapshot: AcceptanceSnapshot): string {
  const { contentDigest: _omitted, ...rest } = snapshot;
  return createHash("sha256").update(JSON.stringify(rest), "utf8").digest("hex");
}

export function sealAcceptanceSnapshot(snapshot: AcceptanceSnapshot): AcceptanceSnapshot {
  const unsigned: AcceptanceSnapshot = { ...snapshot, contentDigest: "0".repeat(64) };
  const digest = computeAcceptanceSnapshotDigest(unsigned);
  return { ...snapshot, contentDigest: digest };
}

interface LoadedAcceptanceSnapshot {
  snapshot: AcceptanceSnapshot | null;
  status: "none" | "available" | "missing" | "corrupt";
  reason: string | null;
}

function loadAcceptanceSnapshot(base: string, state: RequirementState): LoadedAcceptanceSnapshot {
  const ref = state.acceptance?.snapshot;
  if (!ref) return { snapshot: null, status: "none", reason: null };
  if (ref.path !== snapshotRelPath(ref.id)) {
    // References must stay inside this requirement's storage; never resolve caller-controlled paths.
    return { snapshot: null, status: "corrupt", reason: "验收快照引用路径无效" };
  }
  const filePath = resolveSafePath(base, acceptanceSnapshotPath(state.id, ref.id));
  if (!fs.existsSync(filePath)) {
    return { snapshot: null, status: "missing", reason: "验收证据文件不存在，历史 Diff 不可用" };
  }
  try {
    const parsed = validateAcceptanceSnapshot(
      readJsonStrict<unknown>(filePath, MAX_ACCEPTANCE_SNAPSHOT_BYTES),
      state.id,
    );
    if (parsed.contentDigest !== computeAcceptanceSnapshotDigest(parsed)) {
      return { snapshot: null, status: "corrupt", reason: "验收证据内容摘要校验失败" };
    }
    if (parsed.capturedAt !== ref.capturedAt || parsed.contentDigest !== ref.contentDigest) {
      return { snapshot: null, status: "corrupt", reason: "验收证据与验收引用记录不一致" };
    }
    for (const batch of parsed.screenshots ?? []) {
      for (const shot of batch.shots) {
        const shotPath = resolveSafePath(base, `${WORKBENCH_DIR}/items/${state.id}/${shot.path}`);
        if (!fs.existsSync(shotPath)) {
          return {
            snapshot: null,
            status: "missing",
            reason: `验收快照引用的截图文件缺失: ${shot.id}`,
          };
        }
      }
    }
    return { snapshot: parsed, status: "available", reason: null };
  } catch (error) {
    const message = error instanceof WorkbenchError ? error.message : "验收证据文件无法解析";
    return { snapshot: null, status: "corrupt", reason: message };
  }
}

export function readRequirementBundle(root: string, id: string): RequirementBundle {
  const base = canonicalRoot(root);
  assertRequirementId(id);
  readProject(base);

  const itemRel = `${WORKBENCH_DIR}/items/${id}`;
  const statePath = resolveSafePath(base, `${itemRel}/state.json`);
  if (!fs.existsSync(statePath)) {
    throw new WorkbenchError("not_found", `未找到需求 ${id}`);
  }
  const state = validateRequirementState(readJsonStrict<unknown>(statePath, MAX_STATE_BYTES), id);
  const specPath = resolveSafePath(base, `${itemRel}/spec.md`);
  const specMarkdown = fs.existsSync(specPath)
    ? validateMarkdownContent(readBoundedText(specPath, MAX_SPEC_BYTES), "spec", true)
    : "";
  const designPath = resolveSafePath(base, `${itemRel}/design.md`);
  const designMarkdown = fs.existsSync(designPath)
    ? validateMarkdownContent(readBoundedText(designPath, MAX_DESIGN_BYTES), "design", true)
    : "";
  const handoffPath = resolveSafePath(base, `${itemRel}/handoff.md`);
  const handoffMarkdown = fs.existsSync(handoffPath)
    ? validateMarkdownContent(readBoundedText(handoffPath, MAX_HANDOFF_BYTES), "handoff", true)
    : "";
  const designHistoryVersions = listDesignHistoryVersions(base, id);
  const loaded = loadAcceptanceSnapshot(base, state);

  return {
    state,
    specMarkdown,
    designMarkdown,
    handoffMarkdown,
    designHistoryVersions,
    acceptanceSnapshot: loaded.snapshot,
    acceptanceSnapshotStatus: loaded.status,
    acceptanceSnapshotReason: loaded.reason,
  };
}

export function readDesignHistory(root: string, id: string, version: number): string {
  const base = canonicalRoot(root);
  assertRequirementId(id);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new WorkbenchError("invalid_input", `无效的方案版本号: ${version}`);
  }
  const historyPath = resolveSafePath(base, `${WORKBENCH_DIR}/items/${id}/history/design.v${version}.md`);
  if (!fs.existsSync(historyPath)) {
    throw new WorkbenchError("not_found", `未找到 ${id} 的方案版本 v${version}`);
  }
  return validateMarkdownContent(readBoundedText(historyPath, MAX_DESIGN_BYTES), "design", true);
}

export function readVerificationEvidence(
  root: string,
  id: string,
  verificationId: string,
): { record: VerificationRecord; log: string } {
  const base = canonicalRoot(root);
  assertRequirementId(id);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(verificationId)) {
    throw new WorkbenchError("invalid_input", `无效的验证记录 ID: ${verificationId}`);
  }
  const jsonPath = resolveSafePath(base, `${WORKBENCH_DIR}/items/${id}/evidence/verify-${verificationId}.json`);
  const logPath = resolveSafePath(base, `${WORKBENCH_DIR}/items/${id}/evidence/verify-${verificationId}.log`);
  const record = validateVerificationRecord(readJsonStrict<unknown>(jsonPath, 128 * 1024));
  const log = fs.existsSync(logPath) ? readBoundedText(logPath, MAX_EVIDENCE_BYTES) : "";
  return { record, log };
}

export function readRequirementScreenshot(
  root: string,
  id: string,
  shotId: string,
): { batch: ScreenshotBatch; shot: ScreenshotShot; bytes: Buffer } {
  const base = canonicalRoot(root);
  assertRequirementId(id);
  if (typeof shotId !== "string" || !/^S-[A-Za-z0-9-]{1,64}$/.test(shotId)) {
    throw new WorkbenchError("invalid_input", `无效的截图 ID: ${String(shotId)}`);
  }
  const bundle = readRequirementBundle(base, id);
  for (const batch of bundle.state.screenshotBatches ?? []) {
    const shot = batch.shots.find((item) => item.id === shotId);
    if (!shot) continue;
    const validated = validateScreenshotShot(shot);
    const expectedRel = `screenshots/shot-${validated.id}.png`;
    if (validated.path !== expectedRel) {
      throw new WorkbenchError("corrupt_record", "截图路径与截图 ID 不一致");
    }
    const filePath = resolveSafePath(base, `${WORKBENCH_DIR}/items/${id}/${expectedRel}`);
    const bytes = readBoundedBuffer(filePath, MAX_SCREENSHOT_BYTES);
    return { batch, shot: validated, bytes };
  }
  throw new WorkbenchError("not_found", `未找到截图 ${shotId}`);
}

export function readAgentRun(
  root: string,
  id: string,
  runId: string,
): { record: AgentRunRecord; log: string } {
  const base = canonicalRoot(root);
  assertRequirementId(id);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(runId)) {
    throw new WorkbenchError("invalid_input", `无效的运行记录 ID: ${runId}`);
  }
  const jsonPath = resolveSafePath(base, `${WORKBENCH_DIR}/items/${id}/runs/run-${runId}.json`);
  const logPath = resolveSafePath(base, `${WORKBENCH_DIR}/items/${id}/runs/run-${runId}.log`);
  const record = validateAgentRunRecord(readJsonStrict<unknown>(jsonPath, 128 * 1024));
  const log = fs.existsSync(logPath) ? readBoundedText(logPath, MAX_EVIDENCE_BYTES) : "";
  return { record, log };
}

export async function createRequirementFiles(
  root: string,
  build: (id: string, now: number) => { state: RequirementState; specMarkdown: string; designMarkdown: string },
): Promise<RequirementBundle> {
  const base = canonicalRoot(root);
  return withProjectWriteLock(base, () => {
    const projectPath = resolveSafePath(base, `${WORKBENCH_DIR}/project.json`);
    const project = readProject(base);
    let num = project.nextNumber;
    let id = formatRequirementId(num);
    while (fs.existsSync(resolveSafePath(base, `${WORKBENCH_DIR}/items/${id}`))) {
      num += 1;
      id = formatRequirementId(num);
    }
    const now = Date.now();
    const { state, specMarkdown, designMarkdown } = build(id, now);
    validateRequirementState(state, id);

    const itemRel = `${WORKBENCH_DIR}/items/${id}`;
    const itemDir = resolveSafePath(base, itemRel);
    fs.mkdirSync(itemDir, { recursive: true });
    fs.mkdirSync(resolveSafePath(base, `${itemRel}/history`), { recursive: true });
    fs.mkdirSync(resolveSafePath(base, `${itemRel}/evidence`), { recursive: true });
    fs.mkdirSync(resolveSafePath(base, `${itemRel}/runs`), { recursive: true });

    atomicWriteFile(resolveSafePath(base, `${itemRel}/spec.md`), specMarkdown);
    atomicWriteFile(resolveSafePath(base, `${itemRel}/design.md`), designMarkdown);
    atomicWriteJson(resolveSafePath(base, `${itemRel}/state.json`), state);

    const updatedProject: ProjectMetadata = {
      ...project,
      nextNumber: num + 1,
      updatedAt: now,
    };
    atomicWriteJson(projectPath, updatedProject);

    return {
      state,
      specMarkdown,
      designMarkdown,
      handoffMarkdown: "",
      designHistoryVersions: [],
      acceptanceSnapshot: null,
      acceptanceSnapshotStatus: "none",
      acceptanceSnapshotReason: null,
    };
  });
}

export interface RequirementMutationResult {
  state: RequirementState;
  specMarkdown?: string;
  designMarkdown?: string;
  handoffMarkdown?: string;
  snapshotDesignVersion?: number;
  snapshotSpecRevision?: number;
  evidenceWrite?: { record: VerificationRecord; rawLog: string };
  runWrite?: { record: AgentRunRecord; rawLog?: string };
  /** Screenshot batch metadata plus PNG bytes; written before the new state is published. */
  screenshotWrite?: { batch: ScreenshotBatch; files: Array<{ shotId: string; bytes: Buffer }> };
  /** Immutable acceptance artifact; written before the new state is published. */
  acceptanceSnapshotWrite?: { snapshot: AcceptanceSnapshot };
}

export async function mutateRequirement(
  root: string,
  id: string,
  expectedRevision: number | undefined,
  mutator: (bundle: RequirementBundle, now: number) => RequirementMutationResult | Promise<RequirementMutationResult>,
): Promise<RequirementBundle> {
  const base = canonicalRoot(root);
  assertRequirementId(id);
  return withProjectWriteLock(base, async () => {
    const bundle = readRequirementBundle(base, id);
    if (expectedRevision !== undefined && bundle.state.revision !== expectedRevision) {
      throw new WorkbenchError(
        "revision_conflict",
        `需求 ${id} 已被更新（当前修订 ${bundle.state.revision}，预期修订 ${expectedRevision}），请刷新后重试`,
        {
          requirementId: id,
          expectedRevision,
          currentRevision: bundle.state.revision,
        },
      );
    }

    const now = Date.now();
    const result = await mutator(bundle, now);
    const nextState: RequirementState = {
      ...result.state,
      revision: bundle.state.revision + 1,
      updatedAt: now,
    };
    const itemRel = `${WORKBENCH_DIR}/items/${id}`;

    let stateForWrite = nextState;
    let screenshotFiles: Array<{ relPath: string; bytes: Buffer }> = [];
    let removedScreenshotPaths: string[] = [];
    if (result.screenshotWrite) {
      const batch = validateScreenshotBatch(result.screenshotWrite.batch);
      const existingBatches = bundle.state.screenshotBatches ?? [];
      if (existingBatches.some((item) => item.id === batch.id)) {
        throw new WorkbenchError("invalid_input", `截图批次 ID 已存在: ${batch.id}`);
      }
      const existingShotIds = new Set(existingBatches.flatMap((item) => item.shots.map((shot) => shot.id)));
      for (const shot of batch.shots) {
        if (existingShotIds.has(shot.id)) {
          throw new WorkbenchError("invalid_input", `截图 ID 已存在: ${shot.id}`);
        }
      }
      const currentBatches = nextState.screenshotBatches ?? [];
      const nextBatches = currentBatches.some((item) => item.id === batch.id)
        ? currentBatches
        : [...currentBatches, batch];
      const overflow = Math.max(0, nextBatches.length - MAX_SCREENSHOT_BATCHES);
      const dropped = nextBatches.slice(0, overflow);
      const kept = nextBatches.slice(overflow);
      const keptShotPaths = new Set(kept.flatMap((item) => item.shots.map((shot) => shot.path)));
      removedScreenshotPaths = dropped
        .flatMap((item) => item.shots.map((shot) => shot.path))
        .filter((shotPath) => !keptShotPaths.has(shotPath));
      stateForWrite = { ...nextState, screenshotBatches: kept };

      const shotById = new Map(batch.shots.map((shot) => [shot.id, shot]));
      const written = new Set<string>();
      for (const file of result.screenshotWrite.files) {
        const shot = shotById.get(file.shotId);
        if (!shot) {
          throw new WorkbenchError("invalid_input", `截图文件引用了批次中不存在的截图: ${file.shotId}`);
        }
        if (written.has(shot.id)) {
          throw new WorkbenchError("invalid_input", `截图文件重复写入: ${shot.id}`);
        }
        written.add(shot.id);
        if (file.bytes.length !== shot.sizeBytes) {
          throw new WorkbenchError("invalid_input", `截图 ${shot.id} 的字节数与元数据不一致`);
        }
        if (file.bytes.length > MAX_SCREENSHOT_BYTES) {
          throw new WorkbenchError("invalid_input", `截图 ${shot.id} 超出单张大小上限`);
        }
        screenshotFiles.push({ relPath: shot.path, bytes: file.bytes });
      }
    }
    validateRequirementState(stateForWrite, id);
    const nextSpec = result.specMarkdown ?? bundle.specMarkdown;
    const nextDesign = result.designMarkdown ?? bundle.designMarkdown;
    const nextHandoff = result.handoffMarkdown ?? bundle.handoffMarkdown;

    if (result.evidenceWrite) {
      const { record, rawLog } = result.evidenceWrite;
      const jsonPath = resolveSafePath(base, `${itemRel}/evidence/verify-${record.id}.json`);
      const logPath = resolveSafePath(base, `${itemRel}/evidence/verify-${record.id}.log`);
      if (fs.existsSync(jsonPath) || fs.existsSync(logPath)) {
        throw new WorkbenchError("invalid_input", `验证证据 ID 已存在: ${record.id}`);
      }
      atomicWriteFile(logPath, rawLog);
      atomicWriteJson(jsonPath, record);
    }

    if (result.runWrite) {
      const { record, rawLog } = result.runWrite;
      const jsonPath = resolveSafePath(base, `${itemRel}/runs/run-${record.id}.json`);
      const logPath = resolveSafePath(base, `${itemRel}/runs/run-${record.id}.log`);
      if (rawLog !== undefined) {
        atomicWriteFile(logPath, rawLog);
      }
      atomicWriteJson(jsonPath, record);
    }

    if (screenshotFiles.length > 0) {
      for (const file of screenshotFiles) {
        const targetPath = resolveSafePath(base, `${itemRel}/${file.relPath}`);
        if (fs.existsSync(targetPath)) {
          throw new WorkbenchError("invalid_input", `截图文件已存在: ${file.relPath}`);
        }
        atomicWriteBuffer(targetPath, file.bytes);
      }
    }
    if (removedScreenshotPaths.length > 0) {
      for (const relPath of removedScreenshotPaths) {
        const targetPath = resolveSafePath(base, `${itemRel}/${relPath}`);
        try {
          fs.rmSync(targetPath, { force: true });
        } catch {
          // Old evidence cleanup is best effort; metadata trimming remains authoritative.
        }
      }
    }

    if (result.specMarkdown !== undefined) {
      atomicWriteFile(resolveSafePath(base, `${itemRel}/spec.md`), result.specMarkdown);
    }
    if (result.designMarkdown !== undefined) {
      atomicWriteFile(resolveSafePath(base, `${itemRel}/design.md`), result.designMarkdown);
    }
    if (result.handoffMarkdown !== undefined) {
      atomicWriteFile(resolveSafePath(base, `${itemRel}/handoff.md`), result.handoffMarkdown);
    }
    if (result.snapshotDesignVersion !== undefined) {
      const histPath = resolveSafePath(base, `${itemRel}/history/design.v${result.snapshotDesignVersion}.md`);
      if (!fs.existsSync(histPath)) {
        atomicWriteFile(histPath, nextDesign);
      }
    }
    if (result.snapshotSpecRevision !== undefined) {
      const specHistPath = resolveSafePath(base, `${itemRel}/history/spec.v${result.snapshotSpecRevision}.md`);
      if (!fs.existsSync(specHistPath)) {
        atomicWriteFile(specHistPath, nextSpec);
      }
    }

    let publishedState = stateForWrite;
    let sealedSnapshot: AcceptanceSnapshot | null = null;
    if (result.acceptanceSnapshotWrite) {
      const snapshot = sealAcceptanceSnapshot(result.acceptanceSnapshotWrite.snapshot);
      validateAcceptanceSnapshot(snapshot, id);
      const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
      const bytes = Buffer.byteLength(serialized, "utf8");
      if (bytes > MAX_ACCEPTANCE_SNAPSHOT_BYTES) {
        throw new WorkbenchError("invalid_input", "验收证据快照超出存储上限，无法安全固化");
      }
      if (!nextState.acceptance) {
        throw new WorkbenchError("invalid_input", "只有人类验收操作可以固化验收证据快照");
      }
      const artifactPath = resolveSafePath(base, acceptanceSnapshotPath(id, snapshot.id));
      if (fs.existsSync(artifactPath)) {
        throw new WorkbenchError("invalid_input", `验收证据快照 ID 已存在: ${snapshot.id}`);
      }
      const reference: AcceptanceSnapshotReference = {
        id: snapshot.id,
        path: snapshotRelPath(snapshot.id),
        schemaVersion: snapshot.schemaVersion,
        capturedAt: snapshot.capturedAt,
        contentDigest: snapshot.contentDigest,
        sizeBytes: bytes,
      };
      publishedState = {
        ...stateForWrite,
        acceptance: { ...nextState.acceptance, snapshot: reference },
      };
      validateRequirementState(publishedState, id);
      atomicWriteFile(artifactPath, serialized);
      sealedSnapshot = snapshot;
    }

    atomicWriteJson(resolveSafePath(base, `${itemRel}/state.json`), publishedState);

    return {
      state: publishedState,
      specMarkdown: nextSpec,
      designMarkdown: nextDesign,
      handoffMarkdown: nextHandoff,
      designHistoryVersions: listDesignHistoryVersions(base, id),
      acceptanceSnapshot: publishedState.acceptance ? (sealedSnapshot ?? bundle.acceptanceSnapshot) : null,
      acceptanceSnapshotStatus: publishedState.acceptance
        ? sealedSnapshot
          ? "available"
          : bundle.acceptanceSnapshotStatus
        : "none",
      acceptanceSnapshotReason: publishedState.acceptance
        ? sealedSnapshot
          ? null
          : bundle.acceptanceSnapshotReason
        : null,
    };
  });
}
