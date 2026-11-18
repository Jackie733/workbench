import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { WorkbenchError } from "../core/errors.ts";
import { atomicWriteJson, readJsonStrict } from "../core/fs.ts";
import { resolveHubDir } from "../hub/registry.ts";

/**
 * LAN access credentials and session gating.
 *
 * Trust boundary: same-user loopback clients (CLI, MCP, omp bridge, deploy checks) stay
 * frictionless; any non-loopback client must present a session cookie (browser login) or
 * `Authorization: Bearer <password|session>` (remote nodes / scripts). Loopback exemption
 * additionally requires a loopback/Host-bound hostname so DNS-rebinding pages cannot ride it.
 * Credentials live in `<hubDir>/auth.json` (0600 inside the 0700 hubDir); only a scrypt hash
 * is stored, never the plaintext password.
 */

export const SESSION_COOKIE = "wb_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;
const LOGIN_LOCKOUT_MS = 60_000;
const AUTH_FILE_MAX_BYTES = 16 * 1024;

interface AuthFile {
  schemaVersion: 1;
  passwordHash: string;
  sessionSecret: string;
}

export function authFilePath(hubDir: string = resolveHubDir()): string {
  return path.join(hubDir, "auth.json");
}

function readAuthFile(hubDir: string): AuthFile | null {
  const file = authFilePath(hubDir);
  if (!fs.existsSync(file)) return null;
  if (!fs.lstatSync(file).isFile()) {
    throw new WorkbenchError("corrupt_record", `拒绝读取非普通文件的访问凭据: ${file}`);
  }
  const raw = readJsonStrict<Partial<AuthFile>>(file, AUTH_FILE_MAX_BYTES);
  if (raw.schemaVersion !== 1 || typeof raw.passwordHash !== "string" || typeof raw.sessionSecret !== "string") {
    throw new WorkbenchError("corrupt_record", `访问凭据损坏: ${file}；运行 wb service password 重置`);
  }
  return { schemaVersion: 1, passwordHash: raw.passwordHash, sessionSecret: raw.sessionSecret };
}

function writeAuthFile(hubDir: string, file: AuthFile): void {
  fs.mkdirSync(hubDir, { recursive: true, mode: 0o700 });
  atomicWriteJson(authFilePath(hubDir), file, 0o600);
}

function generatePassword(): string {
  return randomBytes(9).toString("base64url");
}

function encodePasswordHash(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, Buffer.from(salt, "hex"), 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPasswordHash(password: string, encoded: string): boolean {
  const parts = encoded.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const expected = Buffer.from(parts[2]!, "hex");
  const actual = scryptSync(password, Buffer.from(parts[1]!, "hex"), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Idempotently creates LAN credentials; returns the plaintext only on first creation. */
export function ensureAuthCredentials(hubDir: string = resolveHubDir()): { created: boolean; password: string | null } {
  if (readAuthFile(hubDir)) return { created: false, password: null };
  const password = generatePassword();
  writeAuthFile(hubDir, {
    schemaVersion: 1,
    passwordHash: encodePasswordHash(password),
    sessionSecret: randomBytes(32).toString("hex"),
  });
  return { created: true, password };
}

/** Generates a new password; the session secret is preserved so existing logins stay valid. */
export function resetAuthPassword(hubDir: string = resolveHubDir()): { password: string } {
  const existing = readAuthFile(hubDir);
  const password = generatePassword();
  writeAuthFile(hubDir, {
    schemaVersion: 1,
    passwordHash: encodePasswordHash(password),
    sessionSecret: existing?.sessionSecret ?? randomBytes(32).toString("hex"),
  });
  return { password };
}

/** Always reads fresh so a CLI password reset takes effect without restarting the Hub. */
export function verifyLoginPassword(password: string, hubDir: string = resolveHubDir()): boolean {
  if (!password) return false;
  const file = readAuthFile(hubDir);
  return file ? verifyPasswordHash(password, file.passwordHash) : false;
}

function signPayload(payload: string, secretHex: string): string {
  return createHmac("sha256", Buffer.from(secretHex, "hex")).update(payload).digest("hex");
}

export function issueSessionToken(hubDir: string = resolveHubDir()): string {
  const file = readAuthFile(hubDir);
  if (!file) throw new WorkbenchError("execution_failed", "尚未生成访问凭据；运行 wb service password");
  const payload = `v1.${Date.now() + SESSION_TTL_MS}`;
  return `${payload}.${signPayload(payload, file.sessionSecret)}`;
}

export function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

export function expiredSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function parseCookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

function verifyTokenWithSecret(token: string, secretHex: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const expiry = Number(parts[1]);
  if (!Number.isSafeInteger(expiry) || expiry <= Date.now()) return false;
  const expected = signPayload(`v1.${parts[1]}`, secretHex);
  const actual = parts[2]!;
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

/** Cached-secret verifier; reloads once on mismatch so a recreated auth.json is honored. */
export function createSessionVerifier(hubDir: string = resolveHubDir()): (req: Request) => boolean {
  let cached = readAuthFile(hubDir);
  const verifyToken = (token: string): boolean => {
    if (cached && verifyTokenWithSecret(token, cached.sessionSecret)) return true;
    const fresh = readAuthFile(hubDir);
    if (fresh && fresh.sessionSecret !== cached?.sessionSecret) {
      cached = fresh;
      return verifyTokenWithSecret(token, fresh.sessionSecret);
    }
    return false;
  };
  return (req) => {
    const cookie = parseCookieValue(req.headers.get("cookie"), SESSION_COOKIE);
    if (cookie && verifyToken(cookie)) return true;
    const authorization = req.headers.get("authorization");
    if (authorization?.toLowerCase().startsWith("bearer ")) {
      const bearer = authorization.slice(7).trim();
      if (bearer && (verifyToken(bearer) || verifyLoginPassword(bearer, hubDir))) return true;
    }
    return false;
  };
}

export function isLoopbackBind(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "::1" || h.startsWith("127.");
}

/**
 * Loopback peers are trusted only when the Host header is a loopback literal or the bound
 * hostname. A DNS-rebinding page always sends its own domain as Host, so it fails this check
 * and falls through to password authentication.
 */
export function isLocalRequest(
  remoteAddress: string | null | undefined,
  hostHeader: string | null,
  bindHostname: string,
): boolean {
  if (!remoteAddress) return false;
  const addr = remoteAddress.toLowerCase();
  if (!(addr.startsWith("127.") || addr === "::1" || addr === "::ffff:127.0.0.1")) return false;
  if (!hostHeader) return false;
  let host: string;
  try {
    host = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  host = host.replace(/^\[|\]$/g, "");
  const bind = bindHostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === bind;
}

const loginFailures = new Map<string, { count: number; lockedUntil: number }>();

export function loginLockRemainingMs(remoteAddress: string | null | undefined): number {
  const key = remoteAddress ?? "unknown";
  const entry = loginFailures.get(key);
  if (!entry) return 0;
  const remaining = entry.lockedUntil - Date.now();
  if (remaining <= 0) {
    loginFailures.delete(key);
    return 0;
  }
  return remaining;
}

export function recordLoginFailure(remoteAddress: string | null | undefined): void {
  const key = remoteAddress ?? "unknown";
  const entry = loginFailures.get(key) ?? { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_LOGIN_FAILURES) entry.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
  loginFailures.set(key, entry);
}

export function clearLoginFailures(remoteAddress: string | null | undefined): void {
  loginFailures.delete(remoteAddress ?? "unknown");
}
