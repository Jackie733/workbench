import { cleanupStaleRuntime, matchingOpenAck } from "./runtime";
import { matchingPanes, windowKeys } from "./tern";
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_TEXT_BYTES, MAX_COMMAND_BYTES, prefillStateRejection, readCommand, validateCommand } from "./runtime";
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
    expect(matchingPanes({ panes: [{ pane: 1, title: "OMPWB:exact-extra" }, { pane: 2, title: "OMPWB:exact" }, { pane: 3, title: "OMPWB:exact" }] }, "OMPWB:exact")).toEqual([2, 3]);
    expect(() => matchingPanes({ panes: [{ pane: "3", title: "OMPWB:exact" }] }, "OMPWB:exact")).toThrow();
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
