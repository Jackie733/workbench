import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createRequirement,
  getRequirement,
  initProject,
  updateProjectConfig,
} from "../../src/core/engine.ts";
import {
  buildOutputLanguageDirective,
  checkLanguageMismatchWarning,
  resolveEffectiveOutputLanguage,
} from "../../src/core/language.ts";
import { validateProjectMetadata } from "../../src/core/validate.ts";
import { buildExecutionPrompt } from "../../src/hub/executor.ts";
import { synthesizeHandoffPacket } from "../../src/hub/handoff.ts";
import { readHubConfig, updateHubPreferences } from "../../src/hub/registry.ts";
import { executeWorkbenchTool } from "../../src/mcp/tools.ts";

const tempDirs: string[] = [];
const originalHubDir = process.env.WORKBENCH_HUB_DIR;
const CLI_ENTRY = path.resolve(import.meta.dir, "../../src/cli/index.ts");

function setupTempHubDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-lang-hub-"));
  tempDirs.push(dir);
  process.env.WORKBENCH_HUB_DIR = dir;
  return dir;
}

function initGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-lang-repo-"));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "index.ts"), "export const ok = true;\n");
  execFileSync("git", ["add", "index.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function runCliSubprocess(
  root: string,
  args: string[],
  hubDir?: string,
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync("bun", ["run", CLI_ENTRY, "--root", root, "--json", ...args], {
    encoding: "utf8",
    env: hubDir ? { ...process.env, WORKBENCH_HUB_DIR: hubDir } : process.env,
  });
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

afterEach(() => {
  if (originalHubDir === undefined) {
    delete process.env.WORKBENCH_HUB_DIR;
  } else {
    process.env.WORKBENCH_HUB_DIR = originalHubDir;
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Output language policy & configuration", () => {
  test("resolveEffectiveOutputLanguage enforces project -> hub -> zh-CN precedence and auto detection", () => {
    expect(resolveEffectiveOutputLanguage()).toBe("zh-CN");
    expect(resolveEffectiveOutputLanguage({ hubLanguage: "en" })).toBe("en");
    expect(resolveEffectiveOutputLanguage({ hubLanguage: "en", projectLanguage: "zh-CN" })).toBe("zh-CN");

    expect(
      resolveEffectiveOutputLanguage({
        projectLanguage: "auto",
        contextText: "新增健康检查接口 `/health` 并补充单测\n```ts\nexport async function check() {}\n```",
      }),
    ).toBe("zh-CN");

    expect(
      resolveEffectiveOutputLanguage({
        projectLanguage: "auto",
        contextText:
          "Add a health check endpoint and write integration tests\n```ts\nconst cnComment = '中文代码忽略';\n```",
      }),
    ).toBe("en");
  });

  test("prompt builders & handoff synthesis inject effective language across all actions and resumed runs", async () => {
    setupTempHubDir();
    const root = initGitRepo();
    await initProject(root, { name: "lang-demo" });
    const req = await createRequirement(root, {
      goal: "实现统一输出语言配置与切换能力",
      criteria: [{ id: "AC-1", description: "语言配置可生效", required: true, command: "echo ok" }],
    });
    const detail = getRequirement(root, req.state.id);

    const actions = ["design", "implement", "fix", "review", "ask"] as const;
    for (const action of actions) {
      const zhPrompt = buildExecutionPrompt(
        detail,
        "# 交接包",
        {
          root,
          requirementId: req.state.id,
          action,
          message: "请回答关于模块划分的问题",
        },
        { outputLanguage: "zh-CN" },
      );
      expect(zhPrompt).toContain("简体中文");

      const enPrompt = buildExecutionPrompt(
        detail,
        "# Handoff",
        {
          root,
          requirementId: req.state.id,
          action,
          message: "Explain module boundaries",
        },
        { outputLanguage: "en" },
      );
      expect(enPrompt).toContain("English");

      const resumedZh = buildExecutionPrompt(
        detail,
        "# Handoff",
        { root, requirementId: req.state.id, action, message: "继续" },
        { resumedSession: true, outputLanguage: "zh-CN" },
      );
      expect(resumedZh).toContain("简体中文 (zh-CN)");
    }

    expect(buildOutputLanguageDirective("zh-CN", "plan")).toContain("简体中文");
    expect(buildOutputLanguageDirective("en", "plan")).toContain("English");

    // Precedence through hub -> project override -> handoff.md
    updateHubPreferences({ outputLanguage: "en" });
    expect(readHubConfig().outputLanguage).toBe("en");

    const handoffEn = await synthesizeHandoffPacket(root, req.state.id, { action: "design" });
    expect(handoffEn.outputLanguage).toBe("en");
    expect(handoffEn.markdown).toContain("Output Language Policy");
    expect(handoffEn.markdown).toContain("`English (en)`");

    await updateProjectConfig(root, { outputLanguage: "zh-CN" });
    const handoffZh = await synthesizeHandoffPacket(root, req.state.id, { action: "design" });
    expect(handoffZh.outputLanguage).toBe("zh-CN");
    expect(handoffZh.markdown).toContain("输出语言规范");
    expect(handoffZh.markdown).toContain("`简体中文 (zh-CN)`");
  });

  test("wb_get & wb_propose expose outputLanguage and emit non-blocking languageWarning on mismatch", async () => {
    setupTempHubDir();
    const root = initGitRepo();
    await initProject(root, { outputLanguage: "zh-CN" });
    const created = await createRequirement(root, { goal: "支持多模型统一中文输出规范" });
    const reqId = created.state.id;

    const getRes = (await executeWorkbenchTool(root, "wb_get", { id: reqId })) as {
      outputLanguage: string;
      state: { id: string };
    };
    expect(getRes.outputLanguage).toBe("zh-CN");

    const englishDesign = [
      "# System Architecture and Implementation Plan",
      "",
      "This design introduces a unified configuration layer across the hub registry, prompt builder,",
      "and tool schemas so every agent follows a single consistent language configuration policy.",
    ].join("\n");

    const mismatch = checkLanguageMismatchWarning("zh-CN", { design: englishDesign });
    expect(mismatch).not.toBeNull();

    const warnPropose = (await executeWorkbenchTool(root, "wb_propose", {
      id: reqId,
      design: englishDesign,
      summary: "Submitted architecture proposal for unified configuration.",
    })) as { outputLanguage: string; languageWarning?: string; stage: string };

    expect(warnPropose.outputLanguage).toBe("zh-CN");
    expect(warnPropose.languageWarning).toContain("简体中文");
    // Non-blocking: proposal still persisted
    expect(warnPropose.stage).toBe("planning");

    const chinesePropose = (await executeWorkbenchTool(root, "wb_propose", {
      id: reqId,
      design: "# 架构方案\n\n本方案在 Hub 与项目级统一配置输出语言策略，并注入全部提示词与交接包。",
      summary: "使用简体中文重新提交方案。",
    })) as { outputLanguage: string; languageWarning?: string };

    expect(chinesePropose.outputLanguage).toBe("zh-CN");
    expect(chinesePropose.languageWarning).toBeUndefined();
  });

  test("CLI wb init --lang / wb config and project.json validation handle outputLanguage", () => {
    const hubDir = setupTempHubDir();
    const root = initGitRepo();

    const initOut = runCliSubprocess(root, ["init", "--name", "cli-lang", "--lang", "en"], hubDir);
    expect(initOut.status).toBe(0);
    const initJson = JSON.parse(initOut.stdout) as { outputLanguage?: string };
    expect(initJson.outputLanguage).toBe("en");

    const globalCfg = runCliSubprocess(root, ["config", "--global", "--output-language", "en"], hubDir);
    expect(globalCfg.status).toBe(0);
    const globalJson = JSON.parse(globalCfg.stdout) as { scope: string; outputLanguage: string };
    expect(globalJson).toEqual({ scope: "hub", outputLanguage: "en" });

    const projCfg = runCliSubprocess(root, ["config", "--output-language", "auto"], hubDir);
    expect(projCfg.status).toBe(0);
    const projJson = JSON.parse(projCfg.stdout) as { project: { outputLanguage?: string } };
    expect(projJson.project.outputLanguage).toBe("auto");

    const validProject = {
      schemaVersion: 6 as const,
      projectId: "proj-test",
      name: "lang-ok",
      nextNumber: 1,
      privacyMode: "local" as const,
      outputLanguage: "zh-CN" as const,
      createdAt: 1,
      updatedAt: 1,
    };
    expect(validateProjectMetadata(validProject).outputLanguage).toBe("zh-CN");
    expect(() => validateProjectMetadata({ ...validProject, outputLanguage: "fr" })).toThrow("project.json 字段不合法");
  });
});
