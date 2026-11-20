import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalRoot, readBoundedText, resolveSafePath } from "./fs.ts";
import type { ProjectMetadata } from "./types.ts";

export interface ArchDocEntry {
  path: string;
  headings: string[];
}

export interface ProjectContextSummary {
  archDocs: ArchDocEntry[];
  fastCommand: string | null;
  fullCommand: string | null;
  commandSource: "configured" | "package.json" | "cargo" | "go" | "python" | null;
}

const ARCH_DOC_CANDIDATES = [
  "AGENTS.md",
  "CLAUDE.md",
  "docs/DESIGN.md",
  "docs/ARCHITECTURE.md",
  "docs/DOMAIN_CONTRACT.md",
  "ARCHITECTURE.md",
  "DESIGN.md",
  "README.md",
] as const;

const MAX_ARCH_DOCS = 5;
const MAX_ARCH_READ_BYTES = 16 * 1024;

function extractTopHeadings(markdown: string, limit = 6): string[] {
  const headings: string[] = [];
  let inFence = false;
  for (const rawLine of markdown.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^#{1,2}\s+(.+?)\s*#*$/.exec(trimmed);
    if (!m) continue;
    const text = m[1]!.trim();
    if (text && !headings.includes(text)) {
      headings.push(text.slice(0, 100));
      if (headings.length >= limit) break;
    }
  }
  return headings;
}

function detectPackageManager(base: string): "bun" | "pnpm" | "yarn" | "npm" {
  if (fs.existsSync(path.join(base, "bun.lock")) || fs.existsSync(path.join(base, "bun.lockb"))) {
    return "bun";
  }
  if (fs.existsSync(path.join(base, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(base, "yarn.lock"))) return "yarn";
  return "npm";
}

function detectRepoCommands(base: string): {
  fastCommand: string | null;
  fullCommand: string | null;
  commandSource: ProjectContextSummary["commandSource"];
} {
  const pkgPath = path.join(base, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const lstat = fs.lstatSync(pkgPath);
      if (!lstat.isSymbolicLink() && lstat.isFile()) {
        const parsed = JSON.parse(readBoundedText(pkgPath, 64 * 1024)) as {
          scripts?: Record<string, unknown>;
        };
        const scripts = parsed?.scripts && typeof parsed.scripts === "object" ? parsed.scripts : null;
        if (scripts) {
          const pm = detectPackageManager(base);
          let fastCommand: string | null = null;
          let fullCommand: string | null = null;
          for (const key of ["typecheck", "check", "lint", "tsc"]) {
            if (typeof scripts[key] === "string" && scripts[key].trim()) {
              fastCommand = pm === "yarn" ? `yarn ${key}` : `${pm} run ${key}`;
              break;
            }
          }
          if (typeof scripts.test === "string" && scripts.test.trim()) {
            const testBody = scripts.test.trim();
            if (!testBody.includes("no test specified")) {
              fullCommand = pm === "bun" ? (testBody === "bun test" ? "bun test" : "bun run test") : `${pm} test`;
            }
          }
          if (fastCommand || fullCommand) {
            return { fastCommand, fullCommand, commandSource: "package.json" };
          }
        }
      }
    } catch {
      // Ignore malformed package.json during passive discovery.
    }
  }

  if (fs.existsSync(path.join(base, "Cargo.toml"))) {
    return { fastCommand: "cargo check", fullCommand: "cargo test", commandSource: "cargo" };
  }
  if (fs.existsSync(path.join(base, "go.mod"))) {
    return { fastCommand: "go vet ./...", fullCommand: "go test ./...", commandSource: "go" };
  }
  if (fs.existsSync(path.join(base, "pyproject.toml")) || fs.existsSync(path.join(base, "pytest.ini"))) {
    return { fastCommand: null, fullCommand: "pytest", commandSource: "python" };
  }

  return { fastCommand: null, fullCommand: null, commandSource: null };
}

/**
 * Discovers repo-native architecture documentation outlines and tiered verification commands
 * without duplicating repository docs into .workbench/.
 */
export function discoverProjectContext(
  root: string,
  projectMeta?: ProjectMetadata | null,
): ProjectContextSummary {
  const base = canonicalRoot(root);
  const archDocs: ArchDocEntry[] = [];

  for (const rel of ARCH_DOC_CANDIDATES) {
    if (archDocs.length >= MAX_ARCH_DOCS) break;
    try {
      const fullPath = resolveSafePath(base, rel);
      if (!fs.existsSync(fullPath)) continue;
      const lstat = fs.lstatSync(fullPath);
      if (lstat.isSymbolicLink() || !lstat.isFile()) continue;
      const content = readBoundedText(fullPath, MAX_ARCH_READ_BYTES);
      archDocs.push({
        path: rel,
        headings: extractTopHeadings(content),
      });
    } catch {
      // Skip unreadable or out-of-root candidates safely.
    }
  }

  const detected = detectRepoCommands(base);
  const configuredFast = projectMeta?.verification?.fastCommand?.trim() || null;
  const configuredFull = projectMeta?.verification?.fullCommand?.trim() || null;
  const fastCommand = configuredFast ?? detected.fastCommand;
  const fullCommand = configuredFull ?? detected.fullCommand;
  const commandSource = configuredFast || configuredFull ? "configured" : detected.commandSource;

  return {
    archDocs,
    fastCommand,
    fullCommand,
    commandSource,
  };
}
