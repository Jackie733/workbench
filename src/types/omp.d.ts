declare module "@oh-my-pi/pi-coding-agent" {
  export interface SessionBranchEntry {
    type: string;
    customType?: string;
    timestamp: string;
    data?: unknown;
    message?: unknown;
  }

  export interface ExtensionContext {
    agent: { kind: string };
    mode: string;
    hasUI: boolean;
    cwd?: string;
    model?: { provider: string; id: string } | null;
    isIdle(): boolean;
    hasPendingMessages(): boolean;
    getPendingPlanReview(): unknown;
    setInterval(fn: () => void, ms: number): unknown;
    clearTimer(timer: unknown): void;
    shutdown(): void;
    invokeTool?: (...args: unknown[]) => Promise<unknown>;
    addAdditionalContext?: (...args: unknown[]) => void;
    sessionManager: {
      getSessionId(): string;
      getCwd(): string;
      getBranch(): SessionBranchEntry[];
    };
    ui: {
      supportsEditor?: boolean;
      getEditorText(): string;
      setEditorText(text: string): void;
      notify(message: string, level?: "info" | "warning" | "error"): void;
      setStatus(key: string, value: string): void;
      setTitle(title: string): void;
    };
  }

  export interface ToolDefinition {
    name: string;
    label?: string;
    description: string;
    approval?: "read" | "write" | "exec";
    parameters: Record<string, unknown>;
    execute: (
      toolCallId: string,
      args: unknown,
      signal: AbortSignal | undefined,
      update: unknown,
      ctx: ExtensionContext,
    ) => Promise<{
      content: Array<{ type: "text"; text: string }>;
      details?: unknown;
    }>;
  }

  export interface ExtensionAPI {
    setLabel(label: string): void;
    registerCommand(
      name: string,
      options: {
        description: string;
        handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
      },
    ): void;
    registerTool(definition: ToolDefinition): void;
    sendUserMessage(text: string): Promise<void>;
    getAllTools(): Array<{ name: string }>;
    getActiveTools(): string[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, handler: (event: any, ctx: ExtensionContext) => void | Promise<void>): void;
  }
}
