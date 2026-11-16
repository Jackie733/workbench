import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { WorkbenchError } from "./errors.ts";
import {
  atomicWriteFile,
  atomicWriteJson,
  canonicalRoot,
  listDirSafe,
  readBoundedText,
  readJsonStrict,
  resolveSafePath,
  withProjectWriteLock,
} from "./fs.ts";
import {
  MAX_DESIGN_BYTES,
  MAX_EVIDENCE_BYTES,
  MAX_SPEC_BYTES,
  MAX_STATE_BYTES,
  SCHEMA_VERSION,
  WORKBENCH_DIR,
  type PrivacyMode,
  type ProjectMetadata,
  type RequirementState,
  type VerificationRecord,
} from "./types.ts";
import {
  assertRequirementId,
  isSafeText,
  REQUIREMENT_ID_RE,
  validateMarkdownContent,
  validateProjectMetadata,
  validateRequirementState,
  validateVerificationRecord,
} from "./validate.ts";

export interface RequirementBundle {
  state: RequirementState;
  specMarkdown: string;
  designMarkdown: string;
  designHistoryVersions: number[];
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
  options: { name?: string; privacyMode?: PrivacyMode } = {},
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
    const now = Date.now();
    const metadata: ProjectMetadata = {
      schemaVersion: SCHEMA_VERSION,
      projectId: randomUUID(),
      name,
      nextNumber: 1,
      privacyMode,
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
  const designHistoryVersions = listDesignHistoryVersions(base, id);

  return { state, specMarkdown, designMarkdown, designHistoryVersions };
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

    atomicWriteFile(resolveSafePath(base, `${itemRel}/spec.md`), specMarkdown);
    atomicWriteFile(resolveSafePath(base, `${itemRel}/design.md`), designMarkdown);
    atomicWriteJson(resolveSafePath(base, `${itemRel}/state.json`), state);

    const updatedProject: ProjectMetadata = {
      ...project,
      nextNumber: num + 1,
      updatedAt: now,
    };
    atomicWriteJson(projectPath, updatedProject);

    return { state, specMarkdown, designMarkdown, designHistoryVersions: [] };
  });
}

export interface RequirementMutationResult {
  state: RequirementState;
  specMarkdown?: string;
  designMarkdown?: string;
  snapshotDesignVersion?: number;
  snapshotSpecRevision?: number;
  evidenceWrite?: { record: VerificationRecord; rawLog: string };
}

export async function mutateRequirement(
  root: string,
  id: string,
  expectedRevision: number | undefined,
  mutator: (bundle: RequirementBundle, now: number) => RequirementMutationResult,
): Promise<RequirementBundle> {
  const base = canonicalRoot(root);
  assertRequirementId(id);
  return withProjectWriteLock(base, () => {
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
    const result = mutator(bundle, now);
    const nextState: RequirementState = {
      ...result.state,
      revision: bundle.state.revision + 1,
      updatedAt: now,
    };
    validateRequirementState(nextState, id);

    const itemRel = `${WORKBENCH_DIR}/items/${id}`;
    const nextSpec = result.specMarkdown ?? bundle.specMarkdown;
    const nextDesign = result.designMarkdown ?? bundle.designMarkdown;

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

    if (result.specMarkdown !== undefined) {
      atomicWriteFile(resolveSafePath(base, `${itemRel}/spec.md`), result.specMarkdown);
    }
    if (result.designMarkdown !== undefined) {
      atomicWriteFile(resolveSafePath(base, `${itemRel}/design.md`), result.designMarkdown);
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

    atomicWriteJson(resolveSafePath(base, `${itemRel}/state.json`), nextState);

    return {
      state: nextState,
      specMarkdown: nextSpec,
      designMarkdown: nextDesign,
      designHistoryVersions: listDesignHistoryVersions(base, id),
    };
  });
}
