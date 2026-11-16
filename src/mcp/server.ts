import packageInfo from "../../package.json";
import { WorkbenchError } from "../core/errors.ts";
import { isRecord } from "../core/validate.ts";
import { executeWorkbenchTool, WORKBENCH_TOOL_DEFINITIONS } from "./tools.ts";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const SUPPORTED_VERSIONS = ["2025-03-26", "2024-11-05"] as const;

export async function handleMcpMessage(root: string, message: unknown): Promise<JsonRpcResponse | null> {
  if (!isRecord(message)) {
    return {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    };
  }
  const req = message as JsonRpcRequest;
  const hasId = req.id !== undefined && req.id !== null;
  const id = req.id ?? null;

  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return hasId
      ? { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid JSON-RPC 2.0 request" } }
      : null;
  }

  // Notifications carry no id and expect no response.
  if (req.id === undefined) {
    return null;
  }

  try {
    switch (req.method) {
      case "initialize": {
        const requested = isRecord(req.params) && typeof req.params.protocolVersion === "string"
          ? req.params.protocolVersion
          : "2024-11-05";
        const protocolVersion = SUPPORTED_VERSIONS.includes(requested as (typeof SUPPORTED_VERSIONS)[number])
          ? requested
          : "2024-11-05";
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion,
            capabilities: {
              tools: { listChanged: false },
            },
            serverInfo: {
              name: "workbench-mcp",
              version: packageInfo.version,
            },
          },
        };
      }

      case "ping":
        return { jsonrpc: "2.0", id, result: {} };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: WORKBENCH_TOOL_DEFINITIONS,
          },
        };

      case "tools/call": {
        if (!isRecord(req.params) || typeof req.params.name !== "string") {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Missing tool name in tools/call" },
          };
        }
        try {
          const output = await executeWorkbenchTool(root, req.params.name, req.params.arguments);
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
              isError: false,
            },
          };
        } catch (error) {
          const payload =
            error instanceof WorkbenchError
              ? { error: error.toJSON() }
              : { error: { code: "execution_failed", message: error instanceof Error ? error.message : String(error) } };
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
              isError: true,
            },
          };
        }
      }

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        };
    }
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : "Internal error",
      },
    };
  }
}

/** Starts an MCP stdio server supporting both newline-delimited JSON and Content-Length framing. */
export function startMcpServer(root: string): Promise<void> {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    let framing: "ndjson" | "content-length" | null = null;
    let queue = Promise.resolve();

    const writeResponse = (resp: JsonRpcResponse) => {
      const json = JSON.stringify(resp);
      if (framing === "content-length") {
        const body = Buffer.from(json, "utf8");
        process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
        process.stdout.write(body);
      } else {
        process.stdout.write(`${json}\n`);
      }
    };

    const dispatchRaw = (rawText: string) => {
      queue = queue.then(async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawText);
        } catch {
          writeResponse({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          });
          return;
        }
        const resp = await handleMcpMessage(root, parsed);
        if (resp) writeResponse(resp);
      });
    };

    const drainBuffer = () => {
      while (buffer.length > 0) {
        const strStart = buffer.subarray(0, 32).toString("utf8").trimStart();
        if (framing === null) {
          if (!strStart) {
            buffer = Buffer.alloc(0);
            return;
          }
          framing = strStart.startsWith("Content-Length:") ? "content-length" : "ndjson";
        }

        if (framing === "content-length") {
          const headerEnd = buffer.indexOf("\r\n\r\n");
          if (headerEnd === -1) return;
          const headers = buffer.subarray(0, headerEnd).toString("utf8");
          const match = /Content-Length:\s*(\d+)/i.exec(headers);
          if (!match) {
            buffer = buffer.subarray(headerEnd + 4);
            continue;
          }
          const length = Number(match[1]);
          const bodyStart = headerEnd + 4;
          if (buffer.length < bodyStart + length) return;
          const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
          buffer = buffer.subarray(bodyStart + length);
          dispatchRaw(body);
        } else {
          const newlineIdx = buffer.indexOf("\n");
          if (newlineIdx === -1) return;
          const line = buffer.subarray(0, newlineIdx).toString("utf8").trim();
          buffer = buffer.subarray(newlineIdx + 1);
          if (line.length > 0) dispatchRaw(line);
        }
      }
    };

    process.stdin.on("data", (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      buffer = Buffer.concat([buffer, bytes]);
      drainBuffer();
    });

    process.stdin.on("end", () => {
      if (framing === "ndjson" && buffer.length > 0) {
        const trailing = buffer.toString("utf8").trim();
        buffer = Buffer.alloc(0);
        if (trailing) dispatchRaw(trailing);
      }
      void queue.then(() => resolve());
    });

    process.stdin.resume();
  });
}
