import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startWorkbenchNodeClient, type NodeClientHandle } from "../../src/hub/node_bridge.ts";
import { registerHubProject } from "../../src/hub/registry.ts";
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

test.skipIf(!HAS_BROWSER)("浏览器退出、再登录和远程节点离线恢复入口", async () => {
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
    registerHubProject(initGitRepoIn(tempDirs), { nodeId: "wsl-test", nodeName: "WSL2 Test" });
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
    await page.waitForSelector('[data-testid="login-password-input"]', { timeout: 5_000 });
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
    await page.waitForSelector(dialog, { timeout: 5_000 });
    const headerText = await page.evaluate(
      (selector) => document.querySelector(selector)?.textContent, `${dialog} [data-slot="alert-dialog-title"]`,
    );
    expect(headerText).toBe("确定要退出登录吗？");
    await clickReady(page, cancel);
    await waitForTriggerFocus();
    expect(await browserStatus()).toBe(200);

    await clickReady(page, trigger);
    await page.waitForSelector(dialog, { timeout: 5_000 });
    await page.keyboard.press("Escape");
    await waitForTriggerFocus();
    expect(await browserStatus()).toBe(200);

    await clickReady(page, trigger);
    await clickReady(page, confirm);
    await page.waitForSelector('[data-testid="login-view"]', { timeout: 5_000 });
    expect(await browserStatus()).toBe(401);
    const afterLogout = await readNode();
    expect(afterLogout?.connected).toBe(true);
    expect(afterLogout?.connectedAt).toBe(beforeLogout?.connectedAt);

    const form = '[data-testid="login-view"]';
    const input = '[data-testid="login-password-input"]';
    expect(await page.evaluate((selector) => document.querySelector(selector)?.getAttribute("autocomplete"), input))
      .toBe("current-password");
    await clickReady(page, `${form} summary`);
    const recoveryCommands = await page.evaluate((selector) =>
      [...document.querySelectorAll(selector)].map((element) => element.textContent), `${form} details[open] code`);
    expect(recoveryCommands).toEqual(["wb service password", "wb node reconnect"]);
    await page.type(input, password);
    await clickReady(page, '[data-testid="login-submit-btn"]');
    await page.waitForSelector(trigger, { timeout: 5_000 });
    expect(await browserStatus()).toBe(200);

    const offline = '[data-testid="remote-node-offline-card"]';
    node.stop();
    await page.waitForSelector(offline, { timeout: 5_000 });
    const offlineCommand = await page.evaluate(
      (selector) => document.querySelector(selector)?.textContent, `${offline} [data-slot="alert-description"] code`,
    );
    expect(offlineCommand).toBe("wb node reconnect");
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { value: undefined });
      document.execCommand = (command) => command === "copy"
        && document.activeElement instanceof HTMLTextAreaElement
        && document.activeElement.value === "wb node reconnect";
    });
    await clickReady(page, `${offline} [data-slot="alert-description"] button`);
    await page.waitForFunction(() => document.body.textContent?.includes("已复制到剪贴板") === true, { timeout: 5_000 });
    await clickReady(page, '[data-testid="remote-node-refresh-btn"]');
    await page.waitForFunction(() => document.body.textContent?.includes("Hub 尚未收到节点连接。") === true, { timeout: 5_000 });
  } finally {
    node?.stop();
    await closeE2eBrowser(browser);
    cleanupE2eResources(servers, tempDirs, origHubDir);
  }
}, 30_000);
