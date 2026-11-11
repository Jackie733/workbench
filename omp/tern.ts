import { execFile } from "node:child_process";

interface Inspection {
	clients?: unknown;
	panes?: unknown;
}
export interface SourceWindow {
	windowKey: string;
	paneId: number;
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function inspect(windowKey?: string): Promise<Inspection> {
	const args = ["inspect", "--json"];
	if (windowKey !== undefined) args.push("--window", windowKey);
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	execFile("tern", args, { timeout: 3000, maxBuffer: 1_048_576 }, (error, stdout) => {
		if (error) reject(error); else resolve(String(stdout));
	});
	const value: unknown = JSON.parse(await promise);
	if (!object(value)) throw new Error("Tern inspect returned an invalid object");
	return value;
}

/** The implicit inspection is ONLY used to enumerate global window clients, never to select a pane. */
export function windowKeys(value: Inspection): string[] {
	if (!Array.isArray(value.clients)) throw new Error("Tern inspect omitted window clients");
	const keys = new Set<string>();
	for (const client of value.clients) {
		if (!object(client) || client.kind !== "window") continue;
		if (typeof client.window !== "string" || client.window.length > 128 || /[\x00-\x1f\x7f]/.test(client.window)) throw new Error("Invalid Tern window key");
		keys.add(client.window);
	}
	if (keys.size === 0 || keys.size > 16) throw new Error("Tern window enumeration is empty or exceeds the safe bound");
	return [...keys];
}

/** Exact visible title marker is only a routing hint; the plugin MUST verify the native dock marker. */
export function matchingPanes(value: Inspection, sourceMarker: string): number[] {
	if (!Array.isArray(value.panes) || value.panes.length > 1024) throw new Error("Invalid Tern pane enumeration");
	const matches: number[] = [];
	for (const pane of value.panes) {
		if (!object(pane) || pane.title !== sourceMarker) continue;
		if (!Number.isSafeInteger(pane.pane) || (pane.pane as number) <= 0) throw new Error("Invalid Tern pane identity");
		matches.push(pane.pane as number);
	}
	return matches;
}

export async function discoverSourceWindow(sourceMarker: string): Promise<SourceWindow> {
	const startedAt = Date.now();
	const windows = windowKeys(await inspect());
	const matches: SourceWindow[] = [];
	for (const windowKey of windows) {
		if (Date.now() - startedAt > 10_000) throw new Error("Exact source window discovery timed out");
		// Empty-string key is the actual native first-window identity, not a fallback.
		const value = await inspect(windowKey);
		for (const paneId of matchingPanes(value, sourceMarker)) matches.push({ windowKey, paneId });
	}
	if (matches.length !== 1) throw new Error(`Exact source marker must match one native pane, found ${matches.length}`);
	return matches[0];
}
