import { lookup } from "node:dns/promises";
import { get } from "node:http";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { hubBindUrl } from "../core/net.ts";
import { issueSessionToken } from "../server/auth.ts";

export function isLoopbackAddress(address: string): boolean {
  if (isIP(address) === 4) return address.startsWith("127.");
  if (isIP(address) === 6) {
    const canonical = new URL(hubBindUrl(address, 80)).hostname;
    return canonical === "[::1]" || /^\[::ffff:7f[0-9a-f]{2}:/.test(canonical);
  }
  return false;
}

export async function resolveHubBindAddress(host: string): Promise<string> {
  const hostname = new URL(hubBindUrl(host, 80)).hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) return hostname;
  return (await lookup(hostname)).address;
}

export async function getLocalHubJson(host: string, port: number, pathname: string, hubDir: string, signal: AbortSignal): Promise<unknown> {
  let address = await resolveHubBindAddress(host);
  if (address === "0.0.0.0") address = "127.0.0.1";
  else if (address === "::") address = "::1";
  if (!isLoopbackAddress(address)) {
    const expected = new URL(hubBindUrl(address, 80)).hostname;
    const local = Object.values(networkInterfaces()).some((interfaces) => interfaces?.some(({ address: candidate }) =>
      new URL(hubBindUrl(candidate, 80)).hostname === expected));
    if (!local) throw new Error("Hub bind address does not resolve to a local interface");
  }
  const base = hubBindUrl(address, port);
  const url = new URL(pathname, base);
  if (url.origin !== new URL(base).origin) throw new Error("Hub probe must use the local origin");
  const request = (token?: string) => {
    const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
    // No proxy, redirect, or second DNS lookup may receive the session token.
    const req = get(url, { agent: false, signal, headers: token ? { Authorization: `Bearer ${token}` } : undefined }, (response) => {
      const status = response.statusCode ?? 0;
      if (status !== 200) {
        response.destroy();
        resolve({ status, body: "" });
        return;
      }
      response.setEncoding("utf8");
      const chunks: string[] = [];
      response.on("data", (chunk: string) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => resolve({ status, body: chunks.join("") }));
    });
    req.once("error", reject);
    return promise;
  };
  let result = await request();
  if (result.status === 401) result = await request(issueSessionToken(hubDir));
  if (result.status !== 200) throw new Error(`GET ${url.pathname} returned HTTP ${result.status}`);
  try { return JSON.parse(result.body) as unknown; } catch { throw new Error(`GET ${url.pathname} returned invalid JSON`); }
}
