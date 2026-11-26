import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startWorkbenchNodeClient, type NodeClientHandle } from "../../src/hub/node_bridge.ts";
import type { RemoteNodeInfo } from "../../src/hub/types.ts";
import { resetAuthPassword } from "../../src/server/auth.ts";
import { startWorkbenchServer, type WorkbenchServerHandle } from "../../src/server/index.ts";
import {
  HAS_BROWSER,
  cleanupE2eResources,
  clickReady,
  closeE2eBrowser,
  initGitRepoIn,
  launchE2eBrowser,
} from "./e2e_helpers.ts";

test.skipIf(!HAS_BROWSER)("退出登录需要确认，已连接的远程节点继续在线", async () => {
  const origHubDir = process.env.WORKBENCH_HUB_DIR;
  const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-logout-"));
  const tempDirs = [hubDir];
  const servers: WorkbenchServerHandle[] = [];
  const browser = await launchE2eBrowser();
  let node: NodeClientHandle | undefined;
  try {
    process.env.WORKBENCH_HUB_DIR = hubDir;
    const { password } = resetAuthPassword(hubDir);
    const server = await startWorkbenchServer({
      root: initGitRepoIn(tempDirs), port: 0, hostname: "0.0.0.0", writeDiscovery: false, hubMode: true,
    });
    servers.push(server);
    const lanUrl = `http://${os.hostname()}:${server.port}`;
    const credentials = { Authorization: `Bearer ${password}` };
    node = startWorkbenchNodeClient({ hubUrl: lanUrl, token: password, nodeId: "wsl-test", nodeName: "WSL2 Test" });
    await node.waitUntilConnected(5_000);

    const readNode = async () => {
      const response = await fetch(`${lanUrl}/api/hub/state`, { headers: credentials });
      expect(response.status).toBe(200);
      const { nodes } = (await response.json()) as { nodes: RemoteNodeInfo[] };
      return nodes.find((entry) => entry.nodeId === "wsl-test");
    };
    const beforeLogout = await readNode();
    expect(beforeLogout?.connected).toBe(true);

    const page = await browser!.newPage();
    await page.goto(lanUrl, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="login-password-input"]');
    await page.type('[data-testid="login-password-input"]', password);
    await clickReady(page, '[data-testid="login-submit-btn"]');

    const trigger = '[data-testid="logout-btn"]';
    const dialog = '[data-testid="logout-dialog"][role="alertdialog"]';
    const cancel = `${dialog} [data-slot="alert-dialog-close"]`;
    const confirm = `${dialog} [data-slot="alert-dialog-footer"] button:last-child`;
    const waitForTriggerFocus = () => page.waitForFunction(
      (selector) => document.activeElement?.matches(String(selector)) === true, { timeout: 5_000 }, trigger,
    );
    const browserStatus = () => page.evaluate(async () => (await fetch("/api/hub/state")).status);

    await clickReady(page, trigger);
    await page.waitForSelector(dialog);
    const headerText = await page.evaluate(
      (selector) => document.querySelector(selector)?.textContent, `${dialog} [data-slot="alert-dialog-header"]`,
    );
    expect(headerText).toBe("确定要退出登录吗？");
    await clickReady(page, cancel);
    await waitForTriggerFocus();
    expect(await browserStatus()).toBe(200);

    await clickReady(page, trigger);
    await page.waitForSelector(dialog);
    await page.keyboard.press("Escape");
    await waitForTriggerFocus();
    expect(await browserStatus()).toBe(200);

    await clickReady(page, trigger);
    await clickReady(page, confirm);
    await page.waitForSelector('[data-testid="login-view"]');
    expect(await browserStatus()).toBe(401);
    const afterLogout = await readNode();
    expect(afterLogout?.connected).toBe(true);
    expect(afterLogout?.connectedAt).toBe(beforeLogout?.connectedAt);
  } finally {
    node?.stop();
    await closeE2eBrowser(browser);
    cleanupE2eResources(servers, tempDirs, origHubDir);
  }
}, 30_000);
