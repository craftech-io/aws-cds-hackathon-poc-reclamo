// `execute_approved_action` (docs/architecture.md §8.5, FL-024, FL-087): the `APPROVAL_DECIDED` event
// carries only the approval's locator; the worker re-reads the approval strongly consistent, claims the
// execution once, recomputes amount and tier with the core and the world's caps, and only then moves
// money with the approval's idempotency key. A forged, repeated, lapsed or grown approval moves nothing.
import { describe, expect, it } from "vitest";
import { HarnessError } from "../agent/harness-client";
import { approval as approvalRow, evidence } from "../connector/testing";
import type { NewOf } from "../connector/codec";
import type { Approval } from "../domain/case-items";
import { CUSTOMER, SIM_NOW, completed, eventOf, recordOf, workerKit, type WorkerKit } from "./testing";
import { processRecord } from "./worker";

const APPROVED = { decision: "APPROVED", decidedBy: "stf-operator", decidedAtSim: "2026-10-07T10:00:00-03:00" } as const;

async function setUp(overrides: Partial<NewOf<typeof Approval>> = APPROVED): Promise<WorkerKit> {
  const kit = await workerKit();
  await kit.addComplaint({ status: "AWAITING_APPROVAL" });
  await kit.connector.caseItems.putEvidence(evidence("demo", { kind: "SETTLEMENT_MATCH", evidenceId: "evd-0001", details: { result: "MATCHED" } }));
  await kit.connector.write(kit.connector.caseItems.restoreApprovalOp(approvalRow("demo", overrides)));
  return kit;
}

function decided(eventId = "evt-approval", customerId = CUSTOMER) {
  return recordOf(eventOf("APPROVAL_DECIDED", { approvalId: "apr-0001", complaintId: "cmp-0001" }, { eventId, customerId }));
}

const moneyCalls = (kit: WorkerKit) => kit.handlers.calls.filter((call) => call.name.startsWith("money."));

describe("[FL-024] [FL-087] an approved action executed by code", () => {
  it("[FL-087] re-reads the approval, claims EXEC#, recomputes, executes with the approval's key, resolves and runs the turn that tells the customer", async () => {
    const kit = await setUp();
    await processRecord(kit.deps, decided());
    expect(moneyCalls(kit)).toEqual([
      { name: "money.quote", args: "apr-0001" },
      { name: "money.execute", args: { approvalId: "apr-0001", idempotencyKey: "apr-apr-0001" } },
    ]);
    expect((await kit.connector.caseItems.getApproval("demo", "cmp-0001", "apr-0001"))?.executedAt).toBeDefined();
    expect(await kit.connector.caseItems.getExecution("demo", "cmp-0001", "apr-0001")).toBeDefined();
    const complaint = await kit.connector.complaints.get("demo", "cmp-0001");
    expect(complaint?.status).toBe("RESOLVED");
    expect(complaint?.statusHistory.at(-1)).toMatchObject({ from: "AWAITING_APPROVAL", to: "RESOLVED", actor: "OPERATOR:stf-operator" });
    const executed = (await kit.audited("EXECUTED"))[0];
    expect(executed?.refs).toMatchObject({ approvalId: "apr-0001", actionId: "act-0001", decidedBy: "stf-operator" });
    expect(kit.harness.requests).toHaveLength(1);
    expect(kit.harness.requests[0]?.envelope).toMatch(/approval status="EXECUTED"/);
  });

  it("[FL-024] the resolved complaint without a written answer owes one ANSWER_DUE turn", async () => {
    const kit = await setUp();
    await processRecord(kit.deps, decided());
    const queued = kit.sent.map((input) => JSON.parse(input.MessageBody ?? "{}") as { type: string; payload: { complaintId: string; sourceEventId: string } });
    expect(queued).toEqual([expect.objectContaining({ type: "ANSWER_DUE", payload: { complaintId: "cmp-0001", sourceEventId: "evt-approval" } })]);
  });

  it("[FL-087] a forged event (the approval is still PENDING) moves nothing: APPROVAL_NOT_EXECUTABLE, no turn", async () => {
    const kit = await setUp({ decision: "PENDING" });
    await processRecord(kit.deps, decided("evt-forged"));
    expect(moneyCalls(kit)).toEqual([]);
    expect((await kit.audited("APPROVAL_NOT_EXECUTABLE"))[0]?.outcome).toBe("NOT_APPROVED");
    expect(kit.harness.requests).toHaveLength(0);
    expect((await kit.connector.complaints.get("demo", "cmp-0001"))?.status).toBe("AWAITING_APPROVAL");
  });

  it("[FL-087] a repeated event executes nothing a second time", async () => {
    const kit = await setUp();
    await processRecord(kit.deps, decided("evt-first"));
    await processRecord(kit.deps, decided("evt-repeated"));
    expect(moneyCalls(kit).filter((call) => call.name === "money.execute")).toHaveLength(1);
    expect((await kit.audited("APPROVAL_NOT_EXECUTABLE")).map((row) => row.outcome)).toEqual(["ALREADY_EXECUTED"]);
  });

  it("[FL-087] an event naming another customer's complaint finds nothing to execute", async () => {
    const kit = await setUp();
    await kit.connector.conversations.create({ worldId: "demo", customerId: "cus-0002", control: "AGENT", controlHistory: [], sessionEpoch: 1, disclosedEpochs: [], openComplaintIds: [] });
    await processRecord(kit.deps, decided("evt-other", "cus-0002"));
    expect(moneyCalls(kit)).toEqual([]);
    expect((await kit.audited("APPROVAL_NOT_EXECUTABLE"))[0]?.outcome).toBe("NOT_FOUND");
  });

  it.each([
    ["of another epoch", { ...APPROVED, epoch: 0 }, "OTHER_EPOCH"],
    ["expired", { ...APPROVED, expiresAtSim: "2026-10-07T09:00:00-03:00" }, "EXPIRED"],
  ])("[FL-087] an approval %s moves nothing and goes back to a person", async (_label, overrides, block) => {
    const kit = await setUp(overrides as Partial<NewOf<typeof Approval>>);
    await processRecord(kit.deps, decided());
    expect(moneyCalls(kit)).toEqual([]);
    expect((await kit.audited("APPROVAL_NOT_EXECUTABLE"))[0]?.outcome).toBe(block);
    expect((await kit.connector.complaints.get("demo", "cmp-0001"))?.status).toBe("HUMAN_REVIEW");
  });

  it("[FL-087] an amount that grew since the approval goes to a person (ABOVE_CAP) without executing", async () => {
    const kit = await setUp();
    kit.handlers.quote = { action: "APPLY_PAYMENT", amountCents: 31_000_000 };
    await processRecord(kit.deps, decided());
    expect(moneyCalls(kit).map((call) => call.name)).toEqual(["money.quote"]);
    expect((await kit.audited("EXECUTION_REFUSED"))[0]?.outcome).toBe("AMOUNT_GREW");
    const complaint = await kit.connector.complaints.get("demo", "cmp-0001");
    expect(complaint?.status).toBe("HUMAN_REVIEW");
    expect(complaint?.handoff?.reason).toBe("ABOVE_CAP");
    expect(kit.harness.requests).toHaveLength(0);
  });

  it("[FL-087] a core that could not act puts the event back, and the redelivery finishes the execution once", async () => {
    const kit = await setUp();
    kit.handlers.execution = { status: "FAILED", reason: "UNAVAILABLE", retryable: true };
    await expect(processRecord(kit.deps, decided())).rejects.toThrow(/could not run/);
    kit.handlers.execution = { status: "EXECUTED", actionId: "act-0001" };
    await processRecord(kit.deps, decided());
    expect(moneyCalls(kit).filter((call) => call.name === "money.execute")).toHaveLength(2);
    expect((await kit.audited("EXECUTED"))[0]?.detail).toMatchObject({ resumed: true });
    expect((await kit.connector.complaints.get("demo", "cmp-0001"))?.status).toBe("RESOLVED");
  });

  it("[FL-087] a refusal of the core at execution goes to a person instead of retrying", async () => {
    const kit = await setUp();
    kit.handlers.execution = { status: "FAILED", reason: "NOT_ELIGIBLE", retryable: false };
    await processRecord(kit.deps, decided());
    expect((await kit.audited("EXECUTION_REFUSED"))[0]?.outcome).toBe("NOT_ELIGIBLE");
    expect((await kit.connector.complaints.get("demo", "cmp-0001"))?.status).toBe("HUMAN_REVIEW");
    expect(kit.harness.requests).toHaveLength(0);
  });

  it("[FL-024] a CONFLICT of the core (the money already moved) still resolves and tells the customer", async () => {
    const kit = await setUp();
    kit.handlers.execution = { status: "CONFLICT", actionId: "act-existing" };
    await processRecord(kit.deps, decided());
    expect((await kit.audited("EXECUTED"))[0]?.outcome).toBe("CONFLICT");
    expect(kit.harness.requests).toHaveLength(1);
  });

  it("[FL-024] a turn that failed after the money moved runs again on the redelivery, and the written answer is still owed", async () => {
    const kit = await setUp();
    kit.harness.script = () => {
      throw new HarnessError("THROTTLED", "InvokeHarness throttled after its retries");
    };
    await expect(processRecord(kit.deps, decided())).rejects.toThrow(/throttled/);
    expect((await kit.connector.complaints.get("demo", "cmp-0001"))?.status).toBe("RESOLVED");
    // What the stage's money handler leaves with the execution: the approval's `ACT#` on the complaint.
    await kit.connector.caseItems.putAction({ worldId: "demo", complaintId: "cmp-0001", actionId: "act-0001", kind: "APPLY_PAYMENT", status: "EXECUTED", amountCents: 1_000_00, idempotencyKey: "apr-apr-0001", approvalId: "apr-0001", atSim: SIM_NOW, actor: "OPERATOR:stf-operator" });
    kit.harness.script = () => completed();
    expect(await processRecord(kit.deps, decided())).toBe("PROCESSED");
    expect(moneyCalls(kit).filter((call) => call.name === "money.execute")).toHaveLength(1);
    expect(await kit.audited("APPROVAL_NOT_EXECUTABLE")).toEqual([]);
    expect(kit.harness.requests.at(-1)?.envelope).toMatch(/approval status="EXECUTED"/);
    const queued = kit.sent.map((input) => JSON.parse(input.MessageBody ?? "{}") as { type: string });
    expect(queued).toEqual([expect.objectContaining({ type: "ANSWER_DUE" })]);
  });

  it("[FL-087] another event over an executed approval never re-runs the customer's turn", async () => {
    const kit = await setUp();
    await processRecord(kit.deps, decided("evt-first"));
    await kit.connector.caseItems.putAction({ worldId: "demo", complaintId: "cmp-0001", actionId: "act-0001", kind: "APPLY_PAYMENT", status: "EXECUTED", amountCents: 1_000_00, idempotencyKey: "apr-apr-0001", approvalId: "apr-0001", atSim: SIM_NOW, actor: "OPERATOR:stf-operator" });
    await processRecord(kit.deps, decided("evt-forged-later"));
    expect(kit.harness.requests).toHaveLength(1);
    expect((await kit.audited("APPROVAL_NOT_EXECUTABLE")).map((row) => row.outcome)).toEqual(["ALREADY_EXECUTED"]);
  });
});
