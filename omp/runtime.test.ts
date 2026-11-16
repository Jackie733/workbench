import { cleanupStaleRuntime, matchingOpenAck } from "./runtime";
import { matchingPanes, windowKeys } from "./tern";
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicJson, MAX_TEXT_BYTES, MAX_COMMAND_BYTES, prefillStateRejection, publishToolsOffer, publishToolsReady, readCommand, readToolsHost, revokeToolsReady, sourceMarkerFor, SOURCE_ICON, TOOLS_PROTOCOL, TOOLS_VERSION, toolsHostSha256, toolsOfferSha256, validateCommand, validateToolsHost, validateToolsOffer, validateToolsReady } from "./runtime";
import { observeDelivery, observePlan } from "./index";

const now = 1_800_000_000_000;
const command = { schemaVersion: 1, requestId: "request-1", instanceId: "instance-1", sessionId: "session-1", kind: "prefill", text: "需求：保留中文 😀\n不自动提交", createdAt: now, expiresAt: now + 30_000 };
const validate = (value: unknown, time = now) => validateCommand(value, "request-1", "instance-1", "session-1", time);
const emptySource = { available: true, projectReady: true, identityFresh: true, busy: false, planReview: false, draftText: "" };

describe("prefill consumer boundaries", () => {
  test("accepts plain UTF-8 materials but rejects control injection and byte overflow", () => {
    expect(validate(command)).toBeNull();
    expect(validate({ ...command, text: "x".repeat(MAX_TEXT_BYTES) })).toBeNull();
    expect(validate({ ...command, text: "中".repeat(Math.ceil(MAX_TEXT_BYTES / 3)) })).toBe("invalid_text");
    expect(validate({ ...command, text: "\u001b[13u" })).toBe("invalid_text");
    expect(validate({ ...command, text: " \n " })).toBe("invalid_text");
  });
  test("does not accept a different source, session, request or command kind", () => {
    expect(validate({ ...command, sessionId: "old-session" })).toBe("identity_mismatch");
    expect(validate({ ...command, instanceId: "other-source" })).toBe("identity_mismatch");
    expect(validate({ ...command, requestId: "other-request" })).toBe("invalid_command");
    expect(validate({ ...command, kind: "submit" })).toBe("invalid_command");
  });
  test("expiry is exclusive and future or unbounded commands never run", () => {
    expect(validate(command, now + 29_999)).toBeNull();
    expect(validate(command, now + 30_000)).toBe("expired_or_invalid_time");
    expect(validate(command, now - 1)).toBe("expired_or_invalid_time");
    expect(validate({ ...command, expiresAt: now + 30_001 })).toBe("expired_or_invalid_time");
  });
  test("preserves whitespace, attachment-chip drafts, busy sources and plan review", () => {
    expect(prefillStateRejection(emptySource)).toBeNull();
    for (const draftText of [" ", "\n", "[image:1]", "用户未提交的需求"]) {
      expect(prefillStateRejection({ ...emptySource, draftText })).toBe("draft_conflict");
    }
    expect(prefillStateRejection({ ...emptySource, busy: true })).toBe("source_busy");
    expect(prefillStateRejection({ ...emptySource, identityFresh: false })).toBe("source_changed");
    expect(prefillStateRejection({ ...emptySource, planReview: true })).toBe("waiting_for_plan_review");
  });
  test("reads actual bounded regular files but refuses symlinks, directories and malformed UTF-8", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-command-test-"));
    try {
      const file = path.join(directory, "command.json");
      fs.writeFileSync(file, JSON.stringify(command));
      expect(readCommand(file)).toEqual(command);
      const link = path.join(directory, "link.json");
      fs.symlinkSync(file, link);
      expect(() => readCommand(link)).toThrow();
      expect(() => readCommand(directory)).toThrow();
      fs.writeFileSync(file, Buffer.alloc(MAX_COMMAND_BYTES + 1, 32));
      expect(() => readCommand(file)).toThrow("invalid_command_file");
      fs.writeFileSync(file, Buffer.from([0x22, 0xff, 0x22]));
      expect(() => readCommand(file)).toThrow();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});

describe("observed progress does not become task completion", () => {
  test("stable native step identity survives status updates and distinguishes duplicates", () => {
    const before = observePlan([{ name: "实施", tasks: [{ content: "验证", status: "pending" }, { content: "验证", status: "pending" }] }], now)!;
    const after = observePlan([{ name: "实施", tasks: [{ content: "验证", status: "completed" }, { content: "验证", status: "pending" }] }], now + 1)!;
    expect(after.phases[0].tasks[0].id).toBe(before.phases[0].tasks[0].id);
    expect(after.phases[0].tasks[0].id).not.toBe(after.phases[0].tasks[1].id);
    expect(after.completed).toBe(1);
    expect(after.total).toBe(2);
    expect(after.attribution).toBeNull();
    expect(observePlan([{ name: "实施", tasks: [{ content: "验证", status: "passed" }] }], now)).toBeNull();
  });
  test("candidate metadata omits assistant content and never implies verified delivery", () => {
    expect(observeDelivery({ role: "user", content: [{ type: "text", text: "完成" }] }, now)).toBeNull();
    expect(observeDelivery({ role: "assistant", content: [{ type: "toolCall", name: "bash" }] }, now)).toBeNull();
    const delivery = observeDelivery({ role: "assistant", content: [{ type: "text", text: "尚未验证" }] }, now)!;
    expect(delivery.kind).toBe("assistant_candidate");
    expect(delivery.textBytes).toBe(Buffer.byteLength("尚未验证"));
    expect(delivery.textOmitted).toBe(true);
    expect(delivery.attribution).toBeNull();
    expect(JSON.stringify(delivery)).not.toContain("尚未验证");
  });
});

describe("exact native opening acknowledgment", () => {
  test("rejects stale, wrong-session, wrong-window and reused open acknowledgments", () => {
    const expected = { instanceId: "i", sessionId: "s", openRequestId: "new-open", sourcePane: 10, window: "2", createdAt: now };
    const ack = { schemaVersion: 1, ...expected, panel: 11, updatedAt: now + 1 };
    expect(matchingOpenAck(ack, expected, now + 2)).toBe(true);
    for (const change of [
      { openRequestId: "old-open" }, { sessionId: "old-session" }, { window: "" },
      { sourcePane: 20 }, { panel: 10 }, { updatedAt: now - 1 }, { updatedAt: now + 3 },
    ]) expect(matchingOpenAck({ ...ack, ...change }, expected, now + 2)).toBe(false);
  });
  test("enumerates real windows including empty key but never uses approximate title matches", () => {
    expect(windowKeys({ clients: [{ kind: "cli", window: "wrong" }, { kind: "window", window: "" }, { kind: "window", window: "2" }] })).toEqual(["", "2"]);
    expect(() => windowKeys({ clients: [{ kind: "cli", window: "" }] })).toThrow();
    const title = sourceMarkerFor("/w/exact", "/w/exact", "exact000-0000-0000-0000-000000000000");
    expect(matchingPanes({ panes: [{ pane: 1, title: `${title}-extra` }, { pane: 2, title }, { pane: 3, title }] }, title)).toEqual([2, 3]);
    expect(() => matchingPanes({ panes: [{ pane: "3", title }] }, title)).toThrow();
  });
});

describe("visible source title", () => {
  const id = "d360cec8-439f-49ee-acc1-c29900b0c67e";
  test("names the project directory, not the full path, and shortens the instance id", () => {
    expect(sourceMarkerFor("/home/jackie/code/workbench", "/home/jackie/code/workbench/src", id)).toBe(`${SOURCE_ICON} workbench · d360cec8`);
    expect(sourceMarkerFor(null, "/tmp/deep/api", id)).toBe(`${SOURCE_ICON} api · d360cec8`);
  });
  test("bounds the directory name, strips control characters and keeps a fallback name", () => {
    expect(sourceMarkerFor(`/w/${"a".repeat(80)}`, "/w", id)).toBe(`${SOURCE_ICON} ${"a".repeat(32)} · d360cec8`);
    expect(sourceMarkerFor("/w/a\u0000b\u001bc", "/w", id)).toBe(`${SOURCE_ICON} abc · d360cec8`);
    expect(sourceMarkerFor("/", "/", id)).toBe(`${SOURCE_ICON} workbench · d360cec8`);
  });
  test("a near-match title never identifies the source pane", () => {
    const title = sourceMarkerFor("/项目/工作台", "/项目/工作台", id);
    expect(matchingPanes({ panes: [{ pane: 4, title: title.replace("d360cec8", "d360cec9") }] }, title)).toEqual([]);
    expect(matchingPanes({ panes: [{ pane: 5, title }] }, title)).toEqual([5]);
  });
});

describe("abandoned runtime cleanup", () => {
  test("removes only provably abandoned private instance directories", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-cleanup-"));
    fs.chmodSync(base, 0o700);
    const deadPid = (() => {
      for (let pid = 4_194_304; pid > 4; pid--) {
        try { process.kill(pid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid; }
      }
      throw new Error("no unused pid");
    })();
    const old = new Date(Date.now() - 9 * 86_400_000);
    const make = (name: string, pid: number, age: Date, marker: unknown = { instanceId: name, pid }) => {
      const directory = path.join(base, name);
      fs.mkdirSync(directory, { mode: 0o700 });
      fs.chmodSync(directory, 0o700);
      fs.writeFileSync(path.join(directory, "open.omp-workbench.json"), JSON.stringify(marker));
      fs.utimesSync(directory, age, age);
      return directory;
    };
    const abandoned = make("abandoned-0001", deadPid, old);
    const running = make("running-000002", process.pid, old);
    const young = make("young-00000003", deadPid, new Date());
    const wrongMarker = make("mismatch-00004", deadPid, old, { instanceId: "other", pid: deadPid });
    const own = make("own-instance-5", deadPid, old);
    const loose = path.join(base, "loose-0000006");
    fs.mkdirSync(loose);
    try {
      expect(cleanupStaleRuntime(base, "own-instance-5", Date.now())).toEqual(["abandoned-0001"]);
      expect(fs.existsSync(abandoned)).toBe(false);
      for (const kept of [running, young, wrongMarker, own, loose]) expect(fs.existsSync(kept)).toBe(true);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
});

describe("versioned tool negotiation", () => {
  const offer = {
    schemaVersion: 1 as const, protocol: TOOLS_PROTOCOL, protocolVersion: TOOLS_VERSION,
    instanceId: "instance-1", sessionId: "session-1", openRequestId: "open-1",
    activities: ["design", "implement"], operations: ["list", "get"],
    payloadBytes: 16_384, responseBytes: 32_768, issuedAt: now, expiresAt: now + 30_000,
  };
  const host = {
    schemaVersion: 1 as const, protocol: TOOLS_PROTOCOL, protocolVersion: TOOLS_VERSION,
    offerSha256: toolsOfferSha256(offer), hostEpoch: "host-epoch-1",
    instanceId: "instance-1", sessionId: "session-1", openRequestId: "open-1",
    window: "", sourcePane: 7, panel: 12, projectId: "project-1",
    writerProtocol: "omp-workbench.host", writerVersion: 1,
    activities: ["design"], operations: ["list"], issuedAt: now, expiresAt: now + 30_000,
  };
  const ready = {
    schemaVersion: 1 as const, protocol: TOOLS_PROTOCOL, protocolVersion: TOOLS_VERSION,
    offerSha256: host.offerSha256, hostSha256: "a".repeat(64),
    instanceId: "instance-1", sessionId: "session-1", openRequestId: "open-1",
    hostEpoch: "host-epoch-1", leaseId: "lease-1", sequence: 1, issuedAt: now, expiresAt: now + 5_000,
  };

  test("a fresh offer is accepted and unknown fields or stale times are rejected", () => {
    expect(validateToolsOffer(offer, now)).toBeNull();
    expect(validateToolsOffer({ ...offer, extra: 1 }, now)).toBe("invalid_offer");
    expect(validateToolsOffer({ ...offer, expiresAt: now - 1 }, now)).toBe("invalid_time");
    expect(validateToolsOffer({ ...offer, expiresAt: now + 120_000 }, now)).toBe("invalid_time");
    expect(validateToolsOffer({ ...offer, activities: ["unknown"] }, now)).toBe("invalid_capabilities");
  });

  test("the host ack must bind the exact offer digest and identity", () => {
    expect(validateToolsHost(host, { offerSha256: host.offerSha256, now })).toBeNull();
    expect(validateToolsHost(host, { offerSha256: "b".repeat(64), now })).toBe("offer_mismatch");
    expect(validateToolsHost({ ...host, extra: 1 }, { offerSha256: host.offerSha256, now })).toBe("invalid_host");
  });

  test("ready is short-lived, monotonic and bound to the offer", () => {
    expect(validateToolsReady(ready, { offerSha256: ready.offerSha256, now })).toBeNull();
    expect(validateToolsReady({ ...ready, expiresAt: now + 7_000 }, { offerSha256: ready.offerSha256, now })).toBe("invalid_time");
    expect(validateToolsReady({ ...ready, sequence: 0 }, { offerSha256: ready.offerSha256, now })).toBe("invalid_sequence");
    expect(validateToolsReady({ ...ready, offerSha256: "c".repeat(64) }, { offerSha256: ready.offerSha256, now })).toBe("offer_mismatch");
  });

  test("publishing writes private bounded files and revokes ready", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wb-tools-"));
    fs.chmodSync(directory, 0o700);
    const runtime = { directory, assertPrivate() {} } as unknown as import("./runtime").Runtime;
    const liveNow = Date.now();
    const liveOffer = { ...offer, issuedAt: liveNow, expiresAt: liveNow + 30_000 };
    const liveHost = { ...host, offerSha256: toolsOfferSha256(liveOffer), issuedAt: liveNow, expiresAt: liveNow + 30_000 };
    const liveReady = { ...ready, offerSha256: liveHost.offerSha256, hostSha256: toolsHostSha256(liveHost), issuedAt: liveNow, expiresAt: liveNow + 5_000 };
    try {
      publishToolsOffer(runtime, liveOffer);
      atomicJson(path.join(directory, "tools", "host.json"), liveHost);
      expect(readToolsHost(runtime, liveHost.offerSha256).value?.hostEpoch).toBe("host-epoch-1");
      expect(() => publishToolsReady(runtime, { ...liveReady, hostSha256: "d".repeat(64) })).toThrow("host_mismatch");
      publishToolsReady(runtime, liveReady);
      expect(fs.existsSync(path.join(directory, "tools", "ready.json"))).toBe(true);
      revokeToolsReady(runtime);
      expect(fs.existsSync(path.join(directory, "tools", "ready.json"))).toBe(false);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
