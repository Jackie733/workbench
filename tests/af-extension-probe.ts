// AF-02 only. Direct mode is offline; dispatch mode requires an isolated real turn.
// Neither mode opens the workbench or grants any business authorization.
import { writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export default function probe(pi: ExtensionAPI): void {
    const dispatch = process.env.AF_PROBE_DISPATCH === "1";
    const output = process.env.AF_PROBE_OUTPUT;
    if (!output) throw new Error("AF_PROBE_OUTPUT must name an isolated output file");
    let providerRequests = 0;
    pi.on("before_provider_request", () => { providerRequests++; });
    const definition = {
        name: "af_capability_probe",
        label: "AF isolated read probe",
        description: "Reports only this isolated session's runtime capabilities.",
        approval: "read" as const,
        parameters: { type: "object" as const, properties: {}, additionalProperties: false },
        async execute(_id: string, _args: unknown, _signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) {
            const details = {
                sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, mode: ctx.mode,
                agentKind: ctx.agent.kind, hasUI: ctx.hasUI,
                invokeToolAvailable: typeof ctx.invokeTool === "function",
                additionalContextAvailable: typeof ctx.addAdditionalContext === "function",
            };
            if (dispatch) writeFileSync(output, JSON.stringify({
                invocation: "native tool dispatch", toolCallId: _id, handler: details, providerRequests,
                workbenchPanelOpened: false, businessAuthorizationProven: false,
            }, null, 2));
            return { content: [{ type: "text" as const, text: "isolated probe complete; do not call again" }], details };
        },
    };
    pi.registerTool(definition);
    pi.on("session_start", async (_event, ctx) => {
        if (dispatch) return;
        const report = {
            registered: pi.getAllTools().some(tool => tool.name === definition.name),
            active: pi.getActiveTools().includes(definition.name),
            invocation: "direct handler call with real session_start context, not native tool dispatch",
            handler: (await definition.execute("af-direct-probe", {}, undefined, undefined, ctx)).details,
            modelRequested: false,
            workbenchPanelOpened: false,
            businessAuthorizationProven: false,
        };
        writeFileSync(output, JSON.stringify(report, null, 2));
        ctx.shutdown();
    });
}
