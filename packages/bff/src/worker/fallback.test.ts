// The deterministic fallback of a failed turn (docs/design-brief.md §8.1, FL-107): a Harness timeout, a
// stream error, a turn cut by `max_tokens` or a QA-forced failure. The number and the acknowledgement
// already went out; the customer gets the fixed handoff notice, a person gets the case, and nothing of
// the failed turn's text is sent. A throttled Harness is not a failure: the event goes back to the queue.
import { describe, expect, it } from "vitest";
import { HarnessError } from "../agent/harness-client";
import { keys } from "../connector/keys";
import { WHATSAPP_TEXT } from "../copy";
import { forceNextTurn } from "../turns/forced";
import { fallbackSummary } from "./fallback";
import { derivedMessageId } from "./notices";
import { CUSTOMER, completed, eventOf, recordOf, turnIdOf, workerKit, type WorkerKit } from "./testing";
import { processRecord } from "./worker";

async function customerTurn(kit: WorkerKit, eventId = "evt-turn", complaintIds: string[] = []) {
  await kit.addInbound(`msg-${eventId}`, "Me debitaron dos veces la cuota");
  const queue = kit.worldId.startsWith("qa") ? "QaCustomerEvents" : "CustomerEvents";
  return processRecord(kit.deps, recordOf(eventOf("CUSTOMER_MESSAGE", { messageId: `msg-${eventId}`, messageAtSim: "2026-10-07T10:10:00-03:00", complaintIds }, { worldId: kit.worldId, eventId }), { queue }));
}

describe("[FL-107] a turn that fails", () => {
  it("[FL-107] a Harness timeout: TURN_FAILED, AGENT_FALLBACK, the fixed handoff notice and the complaint to a person", async () => {
    const kit = await workerKit();
    const complaint = await kit.addComplaint({ status: "INVESTIGATING" });
    kit.harness.script = () => {
      throw new HarnessError("TIMEOUT", "the turn ran past its deadline");
    };
    expect(await customerTurn(kit, "evt-timeout", [complaint.complaintId])).toBe("PROCESSED");
    expect((await kit.audited("TURN_FAILED"))[0]?.outcome).toBe("TIMEOUT");
    expect((await kit.audited("AGENT_FALLBACK"))[0]?.detail).toMatchObject({ notified: true });
    expect(kit.gate.requests).toHaveLength(1);
    expect(kit.gate.requests[0]).toMatchObject({ sender: "SYSTEM", kind: "HANDOFF_NOTICE", complaintId: complaint.complaintId, messageId: derivedMessageId("evt-timeout", "HANDOFF_NOTICE_AGENT_FALLBACK") });
    expect(kit.gate.requests[0]?.text).toContain(complaint.complaintNumber);
    const stored = await kit.connector.complaints.get("demo", complaint.complaintId);
    expect(stored?.status).toBe("HUMAN_REVIEW");
    expect(stored?.handoff).toMatchObject({ reason: "OTHER", summary: fallbackSummary({ cause: "TIMEOUT" }) });
    expect((await kit.connector.conversations.listTurnNotes("demo", CUSTOMER))[0]?.text).toBe("TURN_FAILED");
  });

  it("[FL-107] a turn cut by max_tokens is a failure with its stop reason in TurnErrors", async () => {
    const kit = await workerKit();
    kit.harness.script = () => completed({ outcome: "INCOMPLETE", stopReason: "max_tokens", note: "Estaba escribiendo…" });
    await customerTurn(kit, "evt-max-tokens");
    expect(kit.lines.some((line) => line.metric === "TurnErrors" && line.stopReason === "max_tokens" && line.cause === "INCOMPLETE")).toBe(true);
    expect(kit.gate.requests.map((request) => request.text)).toEqual([WHATSAPP_TEXT.HANDOFF_NOTICE_NO_COMPLAINT]);
    expect(kit.gate.requests.some((request) => request.text?.includes("Estaba escribiendo"))).toBe(false);
    expect((await kit.connector.conversations.listTasks("demo", CUSTOMER))).toHaveLength(1);
  });

  it("[FL-107] turn.forceFailure fails the next turn of a QA conversation without calling the Harness", async () => {
    const kit = await workerKit({ worldId: "qa-run1-sc19" });
    await forceNextTurn(kit.connector, "qa-run1-sc19", CUSTOMER, "FAILURE");
    await customerTurn(kit, "evt-forced");
    expect(kit.harness.requests).toHaveLength(0);
    expect((await kit.connector.audit.listByAction("qa-run1-sc19", "TURN_FAILED"))[0]?.outcome).toBe("FORCED");
    expect(kit.gate.requests.map((request) => request.kind)).toEqual(["HANDOFF_NOTICE"]);
    await customerTurn(kit, "evt-after-forced");
    expect(kit.harness.requests).toHaveLength(1);
  });

  it("[FL-107] a redelivered failed event sends its notice under the same message id (the gate's claim sends it once)", async () => {
    const kit = await workerKit();
    kit.harness.script = () => {
      throw new HarnessError("STREAM", "the Harness stream failed");
    };
    await customerTurn(kit, "evt-twice");
    // As if the first delivery had failed after its notice and before its idempotency row.
    await kit.connector.write({ kind: "delete", table: "Runtime", key: keys.runtime("demo", "IDEMP", "CUSTOMER_MESSAGE", "evt-twice") });
    await processRecord(kit.deps, recordOf(eventOf("CUSTOMER_MESSAGE", { messageId: "msg-evt-twice", messageAtSim: "2026-10-07T10:10:00-03:00", complaintIds: [] }, { eventId: "evt-twice" }), { receiveCount: 2 }));
    expect(kit.harness.requests).toHaveLength(2);
    expect(new Set(kit.gate.requests.map((request) => request.messageId)).size).toBe(1);
    expect(await kit.audited("AGENT_FALLBACK")).toHaveLength(1);
  });
});

describe("a throttled Harness", () => {
  it("puts the event back on the queue with its turn closed, without a fallback", async () => {
    const kit = await workerKit();
    kit.harness.script = () => {
      throw new HarnessError("THROTTLED", "InvokeHarness throttled after 4 attempts");
    };
    await expect(customerTurn(kit, "evt-throttled")).rejects.toThrow(HarnessError);
    expect(kit.gate.requests).toHaveLength(0);
    expect(await kit.audited("AGENT_FALLBACK")).toEqual([]);
    const turn = await kit.connector.sessions.getTurn("demo", turnIdOf(kit.harness.requests[0] ?? { envelope: "" }));
    expect(turn?.status).toBe("CLOSED");
  });
});
