// `tape.*` (docs/design-brief.md §9 "Cinta de cumplimiento"; FL-095, FL-096): every decision of the
// gate of the principal's world, filtered, with the violation count, and the verified export.
import { beforeEach, describe, expect, it } from "vitest";
import { verifyExport } from "../../../../scripts/register/verify";
import { COMPLIANCE, type ConsoleRig, GUEST, OPERATOR, consoleRig } from "./testing";

let rig: ConsoleRig;
let counter = 0;

function decision(overrides: Record<string, unknown>) {
  counter += 1;
  return {
    tapeId: `tape-${String(counter).padStart(4, "0")}`,
    atSim: `2026-10-07T10:${String(10 + counter).padStart(2, "0")}:00-03:00`,
    decision: "ALLOWED",
    ruleIds: [],
    evaluated: [{ ruleId: "CH-WA-NO-COLLECTION", result: "PASS" }],
    ruleSetVersion: "ch-2026.10.06",
    sender: "AGENT",
    channel: "WHATSAPP",
    kind: "REPLY",
    complaintId: "cmp-0001",
    ...overrides,
  } as never;
}

beforeEach(async () => {
  counter = 0;
  rig = consoleRig();
  await rig.seedWorld("demo");
  await rig.seedWorld("g03");
  await rig.append("TAPE", "demo", decision({ messageId: "msg-1", payloadHash: "a".repeat(64) }));
  await rig.append("TAPE", "demo", decision({ messageId: "msg-1", decision: "DISPATCH", result: "SENT" }));
  await rig.append(
    "TAPE",
    "demo",
    decision({
      decision: "BLOCKED",
      sender: "OPERATOR:stf-operator-01",
      kind: "COLLECTION_REMINDER",
      ruleIds: ["CH-WA-NO-COLLECTION"],
      evaluated: [{ ruleId: "CH-WA-NO-COLLECTION", result: "BLOCK" }],
      complaintId: undefined,
      customerRef: "c".repeat(64),
    }),
  );
  await rig.append("TAPE", "demo", decision({ decision: "REROUTED", channel: "EMAIL", kind: "COLLECTION_NOTICE_EMAIL", sender: "OPERATOR:stf-operator-01", reroute: { route: "FORMAL_EMAIL" }, complaintId: undefined }));
  await rig.append("TAPE", "g03", decision({ messageId: "msg-g03" }));
});

describe("tape.list [FL-095]", () => {
  it("lists the world's decisions newest first, with counts by decision and the violations of the epoch", async () => {
    await rig.connector.audit.append({ worldId: "demo", epoch: 1, auditId: "aud-v1", ts: rig.now().toISOString(), action: "VIOLATION", actor: "SYSTEM", refs: { check: "a" } });
    await rig.connector.audit.append({ worldId: "demo", epoch: 0, auditId: "aud-v0", ts: rig.now().toISOString(), action: "VIOLATION", actor: "SYSTEM", refs: { check: "a" } });
    const { caller } = await rig.as(COMPLIANCE);
    const page = await caller.tape.list();
    expect(page.entries.map((entry) => entry.seq)).toEqual([4, 3, 2, 1]);
    expect(page).toMatchObject({ epoch: 1, total: 4, matching: 4, violations: 1, cursor: null });
    expect(page.byDecision).toMatchObject({ ALLOWED: 1, DISPATCH: 1, BLOCKED: 1, REROUTED: 1, DEFERRED: 0 });
  });

  it("filters by decision, rule, sender class, channel and complaint", async () => {
    const { caller } = await rig.as(OPERATOR);
    expect((await caller.tape.list({ decision: "BLOCKED" })).entries.map((entry) => entry.kind)).toEqual(["COLLECTION_REMINDER"]);
    expect((await caller.tape.list({ ruleId: "CH-WA-NO-COLLECTION" })).entries.map((entry) => entry.decision)).toEqual(["BLOCKED"]);
    expect((await caller.tape.list({ sender: "OPERATOR" })).matching).toBe(2);
    expect((await caller.tape.list({ channel: "EMAIL" })).entries.map((entry) => entry.reroute?.route)).toEqual(["FORMAL_EMAIL"]);
    expect((await caller.tape.list({ complaintId: "cmp-0001" })).matching).toBe(2);
    const first = await caller.tape.list({ limit: 3 });
    expect(first.cursor).toBe(3);
    expect((await caller.tape.list({ limit: 3, cursor: 3 })).entries.map((entry) => entry.seq)).toEqual([1]);
  });

  it("shows a guest only the tape of their own world", async () => {
    const { caller } = await rig.as(GUEST);
    const page = await caller.tape.list();
    expect(page.entries.map((entry) => entry.messageId)).toEqual(["msg-g03"]);
    expect(page.entries.every((entry) => entry.worldId === "g03")).toBe(true);
  });

  it("refuses a rule id that is not one", async () => {
    const { caller } = await rig.as(OPERATOR);
    await expect(caller.tape.list({ ruleId: "anything" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("tape.export [FL-096]", () => {
  it("[FL-096] verifies the tape chain against its anchors and exports it like the register", async () => {
    const { caller } = await rig.as(COMPLIANCE);
    const result = await caller.tape.export();
    expect(result).toMatchObject({ chain: "TAPE", result: "ok", entries: 4 });
    expect(result.files.csv.key).toMatch(/^W\/demo\/register\/.+-tape-e1\.csv$/);
    const report = verifyExport(rig.exports.objects.get(result.files.csv.key)?.body ?? "");
    expect(report).toMatchObject({ chain: "TAPE", recomputed: "ok", consistent: true, entries: 4 });
  });
});
