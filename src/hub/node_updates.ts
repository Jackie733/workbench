import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { WorkbenchError } from "../core/errors.ts";
import { isRecord } from "../core/validate.ts";
import type { RemoteNodeRegistry } from "./node_bridge.ts";
import type { NodeUpdateStatus, RemoteNodeInfo } from "./types.ts";
import { NODE_UPDATE_TIMEOUT_MS } from "../cli/node_update.ts";

export class NodeUpdates {
  private readonly abort = new AbortController();
  private readonly jobs = new Map<string, { status: NodeUpdateStatus; node: RemoteNodeInfo }>();

  constructor(private readonly nodes: RemoteNodeRegistry, private readonly changed: () => void) {}

  get(nodeId: string): NodeUpdateStatus | undefined {
    return this.jobs.get(nodeId)?.status;
  }

  offlineNodes(): RemoteNodeInfo[] {
    return Array.from(this.jobs.values(), ({ node }) => ({ ...node, connected: false, activeRuns: [] }));
  }

  stop(): void {
    this.abort.abort();
  }

  async start(nodeId: string, revision: string): Promise<NodeUpdateStatus> {
    const node = this.nodes.getNode(nodeId);
    if (!node?.connected || !node.updateEnabled || !node.revision) throw new WorkbenchError("invalid_input", "Node is offline or has not enabled updates");
    if (node.revision === revision) throw new WorkbenchError("invalid_input", "Node is already running this commit");
    if (node.activeRuns.length || this.get(nodeId)?.phase === "running") throw new WorkbenchError("revision_conflict", "Node has an active task or update");
    const id = randomUUID();
    const status: NodeUpdateStatus = { revision, phase: "running" };
    const job = { status, node };
    this.jobs.set(nodeId, job);
    this.changed();
    try {
      const result = await this.nodes.rpc(nodeId, { kind: "update_start", updateId: id, revision }, 15_000);
      if (result.status !== 202) {
        const error = isRecord(result.bodyJson) ? result.bodyJson.error : undefined;
        throw new WorkbenchError("execution_failed", isRecord(error) && typeof error.message === "string" ? error.message : "Node rejected the update");
      }
    } catch (error) {
      job.status = { revision, phase: "failed", message: error instanceof Error ? error.message : String(error) };
      this.changed();
      throw error;
    }
    void this.verify(nodeId, id, job);
    return status;
  }

  private async verify(nodeId: string, id: string, job: { status: NodeUpdateStatus }): Promise<void> {
    const signal = this.abort.signal;
    const deadline = performance.now() + NODE_UPDATE_TIMEOUT_MS;
    const { revision } = job.status;
    let message = "Node did not reconnect and verify the requested revision before the deadline";
    try {
      while (!signal.aborted && performance.now() < deadline) {
        const node = this.nodes.getNode(nodeId);
        if (node?.updateEnabled) {
          try {
            const { status, bodyJson } = await this.nodes.rpc(nodeId, { kind: "update_status" }, 4_000);
            if (status === 200 && isRecord(bodyJson) && bodyJson.id === id && bodyJson.revision === revision) {
              if (bodyJson.phase === "failed") {
                message = typeof bodyJson.message === "string" ? bodyJson.message.slice(0, 240) : "Node updater failed";
                break;
              }
              if (bodyJson.phase === "restarting" && node.revision === revision && typeof bodyJson.root === "string" && bodyJson.root.startsWith("/")) {
                const browse = await this.nodes.rpc(nodeId, { kind: "browse", path: bodyJson.root }, 4_000);
                if (browse.status !== 200 || !isRecord(browse.bodyJson) || browse.bodyJson.currentPath !== bodyJson.root) {
                  message = "Node started the target commit but its source directory could not be verified";
                  break;
                }
                const verified = this.nodes.getNode(nodeId);
                if (verified?.revision !== revision || verified.connectedAt !== node.connectedAt) continue;
                job.status = { revision, phase: "succeeded" };
                this.changed();
                return;
              }
            }
          } catch {
            // Restart normally closes the old socket while verification is in flight.
          }
        }
        await delay(2_000, undefined, { signal });
      }
    } catch (error) {
      if (!signal.aborted) message = error instanceof Error ? error.message : String(error);
    }
    if (!signal.aborted) {
      job.status = { revision, phase: "failed", message };
      this.changed();
    }
  }
}
