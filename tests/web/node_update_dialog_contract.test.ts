import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { CATALOGS } from "../../src/web/i18n.ts";

const ROOT = path.resolve(import.meta.dir, "../..");

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

describe("REQ-022 节点更新确认弹窗使用 coss AlertDialog", () => {
  test("HubSidebar 不再调用 window.confirm，改为引入 coss alert-dialog 组件", () => {
    const sidebar = read("src/web/components/HubSidebar.tsx");
    expect(sidebar).not.toContain("window.confirm");
    expect(sidebar).toContain('} from "./ui/alert-dialog.tsx"');
    for (const symbol of [
      "AlertDialog",
      "AlertDialogPopup",
      "AlertDialogHeader",
      "AlertDialogTitle",
      "AlertDialogDescription",
      "AlertDialogFooter",
      "AlertDialogClose",
    ]) {
      expect(sidebar).toContain(symbol);
    }
    expect(sidebar).toContain("<AlertDialogPopup");
    expect(sidebar).toContain("<AlertDialogTitle>");
    expect(sidebar).toContain("<AlertDialogDescription>");
  });

  test("弹窗与触发按钮保留稳定测试选择器，确认动作走 updateNode mutation", () => {
    const sidebar = read("src/web/components/HubSidebar.tsx");
    expect(sidebar).toContain('data-testid="node-update-dialog"');
    expect(sidebar).toContain('data-testid="node-update-confirm"');
    expect(sidebar).toContain('data-testid="node-update-cancel"');
    expect(sidebar).toContain("data-testid={`node-update-${n.nodeId}`}");
    expect(sidebar).toContain("updateNode.mutate(");
    expect(sidebar).toContain('loading={updateNode.isPending}');
  });

  test("新增中英文文案键，并复用既有确认描述与取消文案", () => {
    for (const language of ["zh-CN", "en"] as const) {
      const catalog = CATALOGS[language];
      expect(catalog["sidebar.nodeUpdateTitle"]).toBeTruthy();
      expect(catalog["sidebar.nodeUpdateConfirmAction"]).toBeTruthy();
      expect(catalog["sidebar.nodeUpdateConfirm"]).toContain("{node}");
      expect(catalog["sidebar.nodeUpdateConfirm"]).toContain("{revision}");
      expect(catalog["common.cancel"]).toBeTruthy();
    }
    expect(CATALOGS["zh-CN"]["sidebar.nodeUpdateTitle"]).toBe("更新远程节点");
    expect(CATALOGS["en"]["sidebar.nodeUpdateTitle"]).toBe("Update remote node");
  });
});
