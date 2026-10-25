// `run_obligations` (docs/architecture.md §7, FL-016, FL-107): after a turn the code checks what the
// complaint requires. A resolved complaint without its written answer owes one `ANSWER_DUE` turn (and a
// person if that one fails too); a silent turn gets the holding notice; a `READ` receipt that the turn
// did not reconcile is reconciled by code; a matched settlement without `apply_payment` owes one
// `RECONCILE_DUE` turn. Each fires at most once per complaint and source event.
import { describe, expect, it } from "vitest";
import { keys } from "../connector/keys";
import { evidence } from "../connector/testing";
import { WHATSAPP_TEXT, fill } from "../copy";
import { forceNextTurn } from "../turns/forced";
import { CUSTOMER, SIM_NOW, completed, eventOf, recordOf, replyInTurn, turnIdOf, workerKit, type WorkerKit } from "./testing";
import { processRecord } from "./worker";

type Queued = { readonly type: string; readonly eventId: string; readonly payload: Record<string, unknown> };

function queued(kit: WorkerKit): Queued[] {
  return kit.sent.map((input) => JSON.parse(input.MessageBody ?? "{}") as Queued);
}

async function customerTurn(kit: WorkerKit, eventId: string, complaintIds: string[] = ["cmp-0001"]) {
  await kit.addInbound(`msg-${eventId}`, "¿Ya está?");
  const queue = kit.worldId.startsWith("qa") ? "QaCustomerEvents" : "CustomerEvents";
  return processRecord(kit.deps, recordOf(eventOf("CUSTOMER_MESSAGE", { messageId: `msg-${eventId}`, messageAtSim: "2026-10-07T10:10:00-03:00", complaintIds }, { worldId: kit.worldId, eventId }), { queue }));
}

/** The model answers in every turn unless the test says otherwise. */
function answering(kit: WorkerKit): void {
  kit.harness.script = async (request) => {
    await replyInTurn(kit, turnIdOf(request));
    return completed();
  };
}

describe("[FL-016] [FL-107] the written answer a resolved complaint owes", () => {
  it("[FL-016] a RESOLVED complaint without its written answer gets one ANSWER_DUE, once per source event", async () => {
    const kit = await workerKit();
    await kit.addComplaint({ status: "RESOLVED", outcome: "IN_FAVOUR" });
    answering(kit);
    await customerTurn(kit, "evt-resolved");
    expect(queued(kit).map((event) => [event.type, event.payload])).toEqual([["ANSWER_DUE", { complaintId: "cmp-0001", sourceEventId: "evt-resolved" }]]);
    expect(await kit.audited("ANSWER_DUE")).toHaveLength(1);
    // The same event redelivered after its obligations: nothing is queued twice.
    await kit.connector.write({ kind: "delete", table: "Runtime", key: keys.runtime("demo", "IDEMP", "CUSTOMER_MESSAGE", "evt-resolved") });
    await processRecord(kit.deps, recordOf(eventOf("CUSTOMER_MESSAGE", { messageId: "msg-evt-resolved", messageAtSim: "2026-10-07T10:10:00-03:00", complaintIds: ["cmp-0001"] }, { eventId: "evt-resolved" }), { receiveCount: 2 }));
    expect(queued(kit).filter((event) => event.type === "ANSWER_DUE")).toHaveLength(1);
  });

  it("[FL-107] an ANSWER_DUE turn that does not answer either hands the complaint to a person (ANSWER_OBLIGATION_FAILED)", async () => {
    const kit = await workerKit();
    await kit.addComplaint({ status: "RESOLVED", outcome: "IN_FAVOUR" });
    await processRecord(kit.deps, recordOf(eventOf("ANSWER_DUE", { complaintId: "cmp-0001", sourceEventId: "evt-resolved" }, { eventId: "obl-answer" })));
    const complaint = await kit.connector.complaints.get("demo", "cmp-0001");
    expect(complaint?.status).toBe("HUMAN_REVIEW");
    expect(complaint?.handoff?.reason).toBe("OTHER");
    expect(await kit.audited("ANSWER_OBLIGATION_FAILED")).toHaveLength(1);
    expect(kit.gate.requests.map((request) => request.kind)).toEqual(["HANDOFF_NOTICE"]);
    expect(queued(kit)).toEqual([]);
  });

  it("[FL-016] [FL-049] a freeze of outgoing operations owes no written answer; a reversal executed in the event does", async () => {
    const frozen = await workerKit();
    await frozen.addComplaint({ status: "AWAITING_CUSTOMER", type: "UNKNOWN_OPERATION" });
    await frozen.connector.caseItems.putAction({ worldId: "demo", complaintId: "cmp-0001", actionId: "act-freeze", kind: "FREEZE_OUTGOING", status: "EXECUTED", idempotencyKey: "freeze-0001", atSim: SIM_NOW, actor: "AGENT" });
    answering(frozen);
    await customerTurn(frozen, "evt-frozen");
    expect(queued(frozen)).toEqual([]);
    expect(await frozen.audited("ANSWER_DUE")).toEqual([]);

    const reversed = await workerKit();
    await reversed.addComplaint({ status: "INVESTIGATING", type: "UNRECOGNIZED_CHARGE" });
    await reversed.connector.caseItems.putAction({ worldId: "demo", complaintId: "cmp-0001", actionId: "act-reverse", kind: "REVERSE_CHARGE", status: "EXECUTED", amountCents: 250_000, idempotencyKey: "reverse-0001", claimKey: "REV#chg-0001", atSim: SIM_NOW, actor: "AGENT" });
    answering(reversed);
    await customerTurn(reversed, "evt-reversed");
    expect(queued(reversed).map((event) => event.type)).toEqual(["ANSWER_DUE"]);
  });

  it("owes nothing once the complaint is answered", async () => {
    const kit = await workerKit();
    await kit.addComplaint({ status: "ANSWERED", outcome: "IN_FAVOUR" });
    answering(kit);
    await customerTurn(kit, "evt-answered");
    expect(queued(kit)).toEqual([]);
    expect(kit.gate.requests).toEqual([]);
  });
});

describe("[FL-107] a silent turn", () => {
  it("[FL-107] a customer's turn that sent nothing gets the holding notice (AGENT_SILENT)", async () => {
    const kit = await workerKit();
    const complaint = await kit.addComplaint({ status: "INVESTIGATING" });
    await customerTurn(kit, "evt-silent");
    expect(kit.gate.requests).toHaveLength(1);
    expect(kit.gate.requests[0]).toMatchObject({ sender: "SYSTEM", kind: "HOLDING_NOTICE", complaintId: complaint.complaintId, text: fill(WHATSAPP_TEXT.HOLDING_NOTICE, { complaintNumber: complaint.complaintNumber }) });
    expect((await kit.audited("AGENT_SILENT"))[0]?.outcome).toBe("HOLDING_NOTICE");
  });

  it("[FL-107] a second silence after a holding notice goes to a person", async () => {
    const kit = await workerKit();
    await kit.addComplaint({ status: "INVESTIGATING" });
    await kit.connector.conversations.putMessage({ worldId: "demo", customerId: CUSTOMER, messageId: "msg-held", direction: "OUT", channel: "WHATSAPP", kind: "HOLDING_NOTICE", body: "Seguimos", status: "SENT", complaintId: "cmp-0001", simulated: true, atSim: "2026-10-07T09:00:00-03:00", flags: {} });
    await customerTurn(kit, "evt-silent-again");
    expect(kit.gate.requests.map((request) => request.kind)).toEqual(["HANDOFF_NOTICE"]);
    expect((await kit.audited("AGENT_SILENT"))[0]?.outcome).toBe("HANDOFF_NOTICE");
    expect((await kit.connector.complaints.get("demo", "cmp-0001"))?.status).toBe("HUMAN_REVIEW");
  });

  it("[FL-107] a turn that replied owes no holding notice", async () => {
    const kit = await workerKit();
    await kit.addComplaint({ status: "INVESTIGATING" });
    answering(kit);
    await customerTurn(kit, "evt-replied");
    expect(kit.gate.requests).toEqual([]);
    expect(await kit.audited("AGENT_SILENT")).toEqual([]);
  });

  it("[FL-107] turn.forceSilence closes the turn without the Harness and the code still answers", async () => {
    const kit = await workerKit({ worldId: "qa-run1-sc19" });
    await forceNextTurn(kit.connector, "qa-run1-sc19", CUSTOMER, "NO_OUTBOUND");
    await customerTurn(kit, "evt-forced-silence", []);
    expect(kit.harness.requests).toHaveLength(0);
    expect(kit.gate.requests.map((request) => [request.kind, request.text])).toEqual([["HOLDING_NOTICE", WHATSAPP_TEXT.HOLDING_NOTICE_NO_COMPLAINT]]);
  });
});

describe("[FL-016] the reconciliation a read receipt owes", () => {
  async function readThisTurn(kit: WorkerKit): Promise<void> {
    kit.harness.script = async (request) => {
      await kit.connector.caseItems.putEvidence(evidence("demo", { evidenceId: "evd-reading", kind: "RECEIPT_READING", turnId: turnIdOf(request), details: { result: "READ" } }));
      await replyInTurn(kit, turnIdOf(request));
      return completed();
    };
  }

  it("[FL-016] a READ reading the turn did not reconcile is reconciled by code; MATCHED owes one RECONCILE_DUE", async () => {
    const kit = await workerKit();
    await kit.addComplaint({ status: "INVESTIGATING" });
    await readThisTurn(kit);
    kit.handlers.reconcileOutcome = { result: "MATCHED", evidenceId: "evd-match" };
    await customerTurn(kit, "evt-read");
    expect(kit.handlers.calls.find((call) => call.name === "reconcile")?.args).toMatchObject({ complaint: expect.objectContaining({ complaintId: "cmp-0001" }), readingEvidenceId: "evd-reading", eventId: "evt-read" });
    expect((await kit.audited("RECONCILED_BY_CODE"))[0]?.outcome).toBe("MATCHED");
    expect(queued(kit).map((event) => event.type)).toEqual(["RECONCILE_DUE"]);
  });

  it("[FL-016] a reading that matches no settlement line goes to a person, never 'found'", async () => {
    const kit = await workerKit();
    await kit.addComplaint({ status: "INVESTIGATING" });
    await readThisTurn(kit);
    kit.handlers.reconcileOutcome = { result: "NOT_FOUND" };
    await customerTurn(kit, "evt-not-found");
    const complaint = await kit.connector.complaints.get("demo", "cmp-0001");
    expect(complaint?.status).toBe("HUMAN_REVIEW");
    expect(complaint?.handoff?.reason).toBe("RECEIPT_NOT_FOUND");
    expect(queued(kit)).toEqual([]);
  });

  it("[FL-016] a pending batch waits: no turn is owed", async () => {
    const kit = await workerKit();
    await kit.addComplaint({ status: "INVESTIGATING" });
    await readThisTurn(kit);
    kit.handlers.reconcileOutcome = { result: "PENDING_BATCH" };
    await customerTurn(kit, "evt-pending");
    expect((await kit.audited("RECONCILED_BY_CODE"))[0]?.outcome).toBe("PENDING_BATCH");
    expect(queued(kit)).toEqual([]);
  });

  it("[FL-016] a settlement turn with MATCHED and no apply_payment owes one RECONCILE_DUE; that turn failing too goes to a person", async () => {
    const kit = await workerKit();
    await kit.addComplaint({ status: "AWAITING_SETTLEMENT" });
    await kit.connector.caseItems.putEvidence(evidence("demo", { evidenceId: "evd-reading", kind: "RECEIPT_READING", details: { result: "READ" } }));
    await kit.connector.caseItems.putEvidence(evidence("demo", { evidenceId: "evd-match", kind: "SETTLEMENT_MATCH", details: { result: "MATCHED" } }));
    kit.handlers.reconcileOutcome = { result: "MATCHED", evidenceId: "evd-match" };
    answering(kit);
    await processRecord(kit.deps, recordOf(eventOf("SETTLEMENT_PUBLISHED", { complaintId: "cmp-0001", batchKey: "BATCH#SUR#2026-10-07" })));
    expect((await kit.connector.complaints.get("demo", "cmp-0001"))?.status).toBe("INVESTIGATING");
    expect(queued(kit).map((event) => event.type)).toEqual(["RECONCILE_DUE"]);
    const due = queued(kit)[0];
    await processRecord(kit.deps, recordOf({ ...due, correlationId: "corr-test-0001" }));
    expect(await kit.audited("RECONCILE_OBLIGATION_FAILED")).toHaveLength(1);
    expect((await kit.connector.complaints.get("demo", "cmp-0001"))?.status).toBe("HUMAN_REVIEW");
  });
});

describe("[FL-053] [FL-054] the confirmation emails the core's account actions owe", () => {
  it("[FL-053] [FL-054] a closure taken and a data change pending each get their confirmation after the turn; a referred change does not", async () => {
    const kit = await workerKit();
    await kit.addComplaint({ status: "INVESTIGATING" });
    const action = { worldId: "demo", complaintId: "cmp-0001", atSim: "2026-10-07T10:10:00-03:00", actor: "AGENT" as const };
    await kit.connector.caseItems.putAction({ ...action, actionId: "act-close", kind: "ACCOUNT_CLOSURE", status: "EXECUTED", idempotencyKey: "close-1", closureConditions: ["ACTIVE_LOAN"] });
    await kit.connector.caseItems.putAction({ ...action, actionId: "act-data", kind: "DATA_CHANGE", status: "PENDING_CONFIRMATION", idempotencyKey: "data-1", dataChangeField: "ADDRESS" });
    await kit.connector.caseItems.putAction({ ...action, actionId: "act-phone", kind: "DATA_CHANGE", status: "REFERRED", idempotencyKey: "data-2", dataChangeField: "PHONE" });
    answering(kit);
    await customerTurn(kit, "evt-confirm");
    expect(kit.handlers.calls.filter((call) => call.name === "confirmAction").map((call) => call.args)).toEqual([
      { kind: "ACCOUNT_CLOSURE", actionId: "act-close" },
      { kind: "DATA_CHANGE", actionId: "act-data" },
    ]);
  });
});
