import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "../../src/web/components/ui/button.tsx";
import { useUiStore } from "../../src/web/stores/uiStore.ts";

const ROOT = path.resolve(import.meta.dir, "../..");

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

/** 取包含指定 data-testid 的 JSX 开标签，用于校验接入方式而不依赖属性顺序与换行。 */
function openingTagForTestId(source: string, testId: string): string {
  const index = source.indexOf(testId);
  if (index < 0) return "";
  const start = source.lastIndexOf("<", index);
  const end = source.indexOf(">", index);
  if (start < 0 || end < 0) return "";
  return source.slice(start, end + 1);
}

function expectAsyncAction(source: string, testId: string): void {
  const tag = openingTagForTestId(source, testId);
  expect(tag, `${testId} 必须存在`).not.toBe("");
  expect(tag, `${testId} 必须使用 AsyncButton`).toContain("<AsyncButton");
  expect(tag, `${testId} 必须通过 onAction 接入异步动作`).toContain("onAction=");
  expect(tag, `${testId} 不应继续使用 onClick 直接触发异步动作`).not.toContain("onClick=");
  expect(tag, `${testId} 不应把全局 busy 当作 loading`).not.toContain("loading={busy}");
}

/** 取从包含 testid 的开标签到对应 AsyncButton 结束标签的源码片段。 */
function asyncElementForTestId(source: string, testId: string): string {
  const index = source.indexOf(testId);
  if (index < 0) return "";
  const start = source.lastIndexOf("<", index);
  const end = source.indexOf("</AsyncButton>", index);
  if (start < 0 || end < 0) return "";
  return source.slice(start, end + "</AsyncButton>".length);
}

describe("REQ-019 基础 Button loading 契约", () => {
  test("loading 时输出 data-loading、aria-busy、disabled 与装饰性 spinner", () => {
    const html = renderToStaticMarkup(createElement(Button, { loading: true }, "保存"));

    expect(html).toContain('data-loading=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('data-slot="button-loading-indicator"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-hidden="true"');
    // 按钮原文字仍保留在 DOM 中，作为可访问名称来源。
    expect(html).toContain("保存");
  });

  test("非 loading 时不输出忙碌语义与 spinner", () => {
    const html = renderToStaticMarkup(createElement(Button, null, "保存"));

    expect(html).not.toContain('data-loading=""');
    expect(html).not.toContain("aria-busy");
    expect(html).not.toContain('data-slot="button-loading-indicator"');
    expect(html).not.toContain('aria-disabled="true"');
  });
});

describe("REQ-019 AsyncButton 局部 pending 契约", () => {
  test("源码集中实现同步防重入、finally 复位与异常兜底", () => {
    const source = read("src/web/components/ui/async-button.tsx");

    expect(source).toContain("pendingRef");
    expect(source).toContain("useRef(false)");
    expect(source).toContain("finally");
    expect(source).toContain("data-pending");
    expect(source).toContain("onAction");
    expect(source).toContain("showToastError");
    expect(source).toContain("import { Button");
    // 防重入必须在 setPending 之前同步置位。
    const guardIndex = source.indexOf("pendingRef.current = true");
    const setPendingIndex = source.indexOf("setPending(true)");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(setPendingIndex).toBeGreaterThan(guardIndex);
  });

  test("P0 接入文件均复用统一异步按钮", () => {
    for (const file of [
      "src/web/components/Modals.tsx",
      "src/web/components/WorkspaceView.tsx",
      "src/web/components/HomeView.tsx",
      "src/web/components/RightDrawer.tsx",
      "src/web/components/RoutingSettingsModal.tsx",
    ]) {
      const source = read(file);
      expect(source, `${file} 必须导入 AsyncButton`).toContain(
        'import { AsyncButton } from "./ui/async-button.tsx";',
      );
    }
  });
});

describe("REQ-019 P0 关键按钮接入范围", () => {
  test("新建需求、导入 Issue、添加项目与标注等弹窗按钮已接入", () => {
    const modals = read("src/web/components/Modals.tsx");
    for (const testId of [
      "save-draft-btn",
      "create-and-dispatch-btn",
      "import-issue-draft-btn",
      "import-issue-dispatch-btn",
      "submit-add-project-btn",
      "annotate-ask-btn",
      "annotate-queue-btn",
      "feedback-submit-btn",
      "confirm-accept-override-btn",
      "lifecycle-confirm-btn",
      "submit-link-issue-btn",
      "submit-deliver-btn",
      "spawn-submit-btn",
      "prune-traces-now-btn",
      "save-pricing-btn",
      "deliver-sync-base-btn",
      "deliver-resolve-conflict-btn",
    ]) {
      expectAsyncAction(modals, testId);
    }
  });

  test("工作区保存、Review、验证、沙箱与交付按钮已接入", () => {
    const workspace = read("src/web/components/WorkspaceView.tsx");
    for (const testId of [
      "save-spec-btn",
      "save-design-btn",
      "review-fix-btn",
      "review-reject-btn",
      "review-override-accept-btn",
      "review-rerun-btn",
      "run-all-verifications-btn",
      "run-criterion-btn-",
      "evidence-rerun-btn-",
      "manual-verify-btn",
      "screenshot-recapture",
      "sync-sandbox-base-btn",
      "agent-sync-sandbox-btn",
      "run-selected-model-btn",
      "run-review-btn",
      "action-${",
      "sync-pr-btn",
      "apply-sandbox-btn",
    ]) {
      expectAsyncAction(workspace, testId);
    }
  });

  test("首页、右侧抽屉与路由设置按钮已接入", () => {
    const home = read("src/web/components/HomeView.tsx");
    for (const testId of ["refresh-sandboxes-remote-btn", "req-sync-sandbox-btn-"]) {
      expectAsyncAction(home, testId);
    }

    const drawer = read("src/web/components/RightDrawer.tsx");
    for (const testId of [
      "run-ask-btn",
      "run-refine-btn",
      "adopt-discussion-btn",
      "cancel-run-btn",
      "retry-fallback-btn",
    ]) {
      expectAsyncAction(drawer, testId);
    }

    const routing = read("src/web/components/RoutingSettingsModal.tsx");
    for (const testId of ["refresh-harnesses-btn", "save-routing-btn", "save-project-btn"]) {
      expectAsyncAction(routing, testId);
    }
  });

  test("既有正确 loading 用法保持不动", () => {
    expect(read("src/web/components/LoginView.tsx")).toContain("loading={busy}");
    expect(read("src/web/components/HomeView.tsx")).toContain("loading={busy}");
    expect(read("src/web/components/HubSidebar.tsx")).toContain("loading={updateNode.isPending}");
  });
});

describe("REQ-019 审查修复契约", () => {
  test("标注提问先等待调度结束再关闭弹窗", () => {
    const queries = read("src/web/queries.ts");
    const askBranch = queries.slice(
      queries.indexOf('if (mode === "ask")'),
      queries.indexOf("} else {", queries.indexOf('if (mode === "ask")')),
    );
    const runIndex = askBranch.indexOf('await triggerActiveRun(reqId, "ask"');
    const closeIndex = askBranch.indexOf("ui.closeModal(modalInstanceId)");
    expect(runIndex).toBeGreaterThan(-1);
    expect(closeIndex).toBeGreaterThan(runIndex);
  });

  test("主操作与次操作按钮以需求标识和动作标识作为组件键", () => {
    const workspace = read("src/web/components/WorkspaceView.tsx");
    expect(workspace).toContain("key={`${s.id}:${banner.primaryAction.id}`}");
    expect(workspace).toContain("key={`${s.id}:${sec.id}`}");
  });

  test("定价互斥操作的局部 loading 只跟随受保护请求结束", () => {
    const modals = read("src/web/components/Modals.tsx");
    for (const handler of ["handleSave", "handlePrune"]) {
      const start = modals.indexOf(`const ${handler} = () => {`);
      const end = modals.indexOf("\n  };", start);
      const body = modals.slice(start, end);
      expect(start).toBeGreaterThan(-1);
      expect(body).toContain("const request = runBusy(");
      expect(body).toContain("void request");
      expect(body.match(/return request;/g)?.length ?? 0).toBe(1);
      expect(body).not.toContain("await runBusy(");
    }
  });

  test("交付弹窗的沙箱同步与冲突解决入口接入 AsyncButton，并在请求结束后关闭", () => {
    const modals = read("src/web/components/Modals.tsx");
    const resolveBlock = asyncElementForTestId(modals, "deliver-resolve-conflict-btn");
    expect(resolveBlock).toContain("await dispatchSyncBaseWithAgent(");
    expect(resolveBlock.indexOf("await dispatchSyncBaseWithAgent(")).toBeLessThan(
      resolveBlock.indexOf("closeSubmitted();"),
    );
  });

  test("AsyncButton 在派发动作前同步检查 pendingRef", () => {
    const source = read("src/web/components/ui/async-button.tsx");
    expect(source).toContain("if (pendingRef.current || disabled) return;");
  });

  test("弹窗实例标识阻止旧请求关闭后来打开的新弹窗并保留新草稿", () => {
    const ui = useUiStore.getState();
    ui.setModal({ kind: "new_req", goal: "" });
    const firstInstance = useUiStore.getState().modalInstanceId;

    // 用户取消原弹窗后重新打开并输入新草稿。
    ui.setModal(null);
    ui.setModal({ kind: "new_req", goal: "新弹窗草稿" });
    const secondInstance = useUiStore.getState().modalInstanceId;
    expect(secondInstance).not.toBe(firstInstance);

    // 旧请求按最初实例序号关闭时不得影响新弹窗。
    ui.closeModal(firstInstance);
    expect(useUiStore.getState().modal).toMatchObject({ kind: "new_req", goal: "新弹窗草稿" });

    // 同一弹窗内的字段编辑不改变实例序号，成功提交仍可正常关闭。
    ui.setModal((prev) => (prev?.kind === "new_req" ? { ...prev, goal: "编辑后的草稿" } : prev));
    expect(useUiStore.getState().modalInstanceId).toBe(secondInstance);
    ui.closeModal(secondInstance);
    expect(useUiStore.getState().modal).toBeNull();
  });

  test("异步提交只在弹窗实例未变化时关闭弹窗", () => {
    const queries = read("src/web/queries.ts");
    for (const fn of [
      "submitNewRequirement",
      "submitImportGitHubIssue",
      "submitImportGiteeIssue",
      "submitFeedback",
      "submitAcceptOverride",
      "submitLifecycle",
      "submitAnnotation",
    ]) {
      const start = queries.indexOf(`export async function ${fn}(`);
      const nextExport = queries.indexOf("\nexport async function ", start + 1);
      const body = queries.slice(start, nextExport < 0 ? undefined : nextExport);
      expect(start, `${fn} 必须存在`).toBeGreaterThan(-1);
      expect(body, `${fn} 必须记录弹窗实例序号`).toContain("const modalInstanceId = ui.modalInstanceId;");
      expect(body, `${fn} 必须按实例序号关闭弹窗`).toContain("ui.closeModal(modalInstanceId);");
      expect(body, `${fn} 不得无条件关闭当前弹窗`).not.toContain("ui.setModal(null);");
    }

    const modals = read("src/web/components/Modals.tsx");
    expect(modals).toContain("const closeSubmitted = () => closeModal(modalInstanceId);");
    expect(modals).toContain("closeSubmitted();");
    expect(modals).toContain("onClose={closeSubmitted}");
    expect(modals).not.toMatch(/await dispatchSyncBaseWithAgent\([\s\S]*?close\(\);/);

    const routing = read("src/web/components/RoutingSettingsModal.tsx");
    expect(routing).toContain("const modalInstanceId = useUiStore.getState().modalInstanceId;");
    expect(routing).toContain("closeModal(modalInstanceId);");
  });

  test("停止与回退重试按钮按运行标识和动作分别设置组件键", () => {
    const drawer = read("src/web/components/RightDrawer.tsx");
    expect(drawer).toContain("key={`cancel-run:${currentRun.id}`}");
    expect(drawer).toContain("key={`retry-fallback:${currentRun.id}`}");
  });
});
