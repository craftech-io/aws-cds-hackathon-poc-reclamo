// Complaints and what hangs from them over the memory connector: creation once, transitions only
// on the version read and from an allowed origin state, a written answer that collides on a second
// send, approvals decided once and executed once.
import { describe, expect, it } from "vitest";
import type { ComplaintStatus } from "@reclamo/shared";
import { TransactionCancelledError } from "../errors";
import { SIM_NOW, approval, complaint, evidence, testConnector } from "../testing";

const change = (to: ComplaintStatus) => ({ from: null, to, atSim: SIM_NOW, cause: "TEST", actor: "SYSTEM" as const });

async function withComplaint(worldId = "demo") {
  const setup = testConnector();
  await setup.connector.transact([setup.connector.complaints.createOp(complaint(worldId))]);
  return setup;
}

describe("complaints", () => {
  it("creates a complaint once, findable by number, customer and inbox", async () => {
    const { connector } = await withComplaint();
    await expect(connector.transact([connector.complaints.createOp(complaint("demo"))])).rejects.toBeInstanceOf(TransactionCancelledError);
    expect(await connector.complaints.get("demo", "cmp-0001")).toMatchObject({ status: "REGISTERED", version: 1 });
    expect((await connector.complaints.getByNumber("demo", "R-2026-000123"))?.complaintId).toBe("cmp-0001");
    expect(await connector.complaints.getByNumber("g01", "R-2026-000123")).toBeUndefined();
    expect((await connector.complaints.listByCustomer("demo", "cus-0001")).map((row) => row.complaintId)).toEqual(["cmp-0001"]);
    expect((await connector.complaints.listInbox("demo")).complaints).toHaveLength(1);
  });

  it("transitions only on the version read and from an allowed origin state, appending the history", async () => {
    const { connector } = await withComplaint();
    const request = { worldId: "demo", complaintId: "cmp-0001", allowedFrom: ["REGISTERED"] as const, to: "INVESTIGATING" as const, change: { ...change("INVESTIGATING"), from: "REGISTERED" as const } };
    await connector.transact([connector.complaints.transitionOp({ ...request, version: 1 })]);
    const after = await connector.complaints.get("demo", "cmp-0001");
    expect(after).toMatchObject({ status: "INVESTIGATING", version: 2 });
    expect(after?.statusHistory.map((entry) => entry.to)).toEqual(["REGISTERED", "INVESTIGATING"]);

    // A stale version (another writer moved it) and a state the machine does not allow both fail.
    await expect(connector.transact([connector.complaints.transitionOp({ ...request, version: 1 })])).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(connector.transact([connector.complaints.transitionOp({ ...request, version: 2 })])).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await connector.complaints.get("demo", "cmp-0001")).toMatchObject({ status: "INVESTIGATING", version: 2 });
  });

  it("moves an answered complaint out of the open inbox and a bounced one back in", async () => {
    const { connector } = await withComplaint();
    const answered = connector.complaints.transitionOp({ worldId: "demo", complaintId: "cmp-0001", version: 1, allowedFrom: ["REGISTERED"], to: "ANSWERED", change: change("ANSWERED") });
    await connector.transact([answered]);
    expect((await connector.complaints.listInbox("demo")).complaints).toEqual([]);
    expect((await connector.complaints.listInbox("demo", { state: "CLOSED" })).complaints).toHaveLength(1);
    const bounced = connector.complaints.transitionOp({
      worldId: "demo",
      complaintId: "cmp-0001",
      version: 2,
      allowedFrom: ["ANSWERED"],
      to: "HUMAN_REVIEW",
      change: change("HUMAN_REVIEW"),
      patch: { handoff: { reason: "EMAIL_UNDELIVERABLE", atSim: SIM_NOW } },
    });
    await connector.transact([bounced]);
    expect((await connector.complaints.listOpen("demo")).map((row) => row.handoff?.reason)).toEqual(["EMAIL_UNDELIVERABLE"]);
  });

  it("patches non-status fields on the version read", async () => {
    const { connector } = await withComplaint();
    const patched = await connector.complaints.patch("demo", "cmp-0001", 1, { slaState: "AT_RISK", priority: "HIGH" });
    expect(patched).toMatchObject({ slaState: "AT_RISK", priority: "HIGH", version: 2, status: "REGISTERED" });
    await expect(connector.complaints.patch("demo", "cmp-0001", 1, { slaState: "OVERDUE" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("claims the written answer once: a second send collides, a release frees it, the sent answer keeps its proof", async () => {
    const { connector } = await withComplaint();
    await connector.write(connector.complaints.claimAnswerOp("demo", "cmp-0001", "msg-a"));
    await expect(connector.write(connector.complaints.claimAnswerOp("demo", "cmp-0001", "msg-b"))).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(connector.write(connector.complaints.releaseAnswerOp("demo", "cmp-0001", "msg-b"))).rejects.toMatchObject({ code: "CONFLICT" });
    await connector.write(connector.complaints.releaseAnswerOp("demo", "cmp-0001", "msg-a"));
    await connector.write(connector.complaints.claimAnswerOp("demo", "cmp-0001", "msg-b"));
    await connector.write(connector.complaints.recordAnswerSentOp("demo", "cmp-0001", { messageId: "msg-b", mailId: "mail-1", sentAtSim: SIM_NOW }));
    await expect(connector.write(connector.complaints.claimAnswerOp("demo", "cmp-0001", "msg-c"))).rejects.toMatchObject({ code: "CONFLICT" });
    await connector.write(connector.complaints.setDeliveryProofOp("demo", "cmp-0001", "msg-b", "DELIVERED"));
    await expect(connector.write(connector.complaints.setDeliveryProofOp("demo", "cmp-0001", "msg-x", "BOUNCED"))).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await connector.complaints.get("demo", "cmp-0001"))?.answer).toEqual({ messageId: "msg-b", mailId: "mail-1", sentAtSim: SIM_NOW, deliveryProof: "DELIVERED" });
  });

  it("keeps two worlds with the same ids apart", async () => {
    const { connector, store } = await withComplaint("g01");
    await connector.transact([connector.complaints.createOp(complaint("g02"))]);
    const keys = store.dump("Complaints").map((row) => row.pk);
    expect(keys).toEqual(["W#g01#CMP#cmp-0001", "W#g02#CMP#cmp-0001"]);
    expect(store.dump("Complaints").map((row) => row.inboxKey)).toEqual(["W#g01#OPEN", "W#g02#OPEN"]);
  });

  it("refuses an id that could escape its key", async () => {
    const { connector } = testConnector();
    expect(() => connector.complaints.createOp(complaint("demo", { complaintId: "cmp-1#EVD#x" }))).toThrow(expect.objectContaining({ code: "VALIDATION" }));
    await expect(connector.complaints.get("demo", "../cmp")).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("evidence, actions and notes", () => {
  it("writes evidence and actions once and reads the whole case file in one query", async () => {
    const { connector } = await withComplaint();
    await connector.caseItems.putEvidence(evidence("demo"));
    await expect(connector.caseItems.putEvidence(evidence("demo"))).rejects.toMatchObject({ code: "CONFLICT" });
    await connector.caseItems.putAction({ worldId: "demo", complaintId: "cmp-0001", actionId: "act-1", kind: "APPLY_PAYMENT", status: "EXECUTED", amountCents: 11_864_000, idempotencyKey: "k-1", claimKey: "OPC#NORTE#NTE-20261006-004817-7", atSim: SIM_NOW, actor: "AGENT" });
    await connector.caseItems.putNote({ worldId: "demo", complaintId: "cmp-0001", noteId: "note-1", kind: "HUMAN_TASK", atSim: SIM_NOW, author: "OPERATOR:stf-lucia", text: "Llamar", task: { status: "OPEN", route: "HUMAN_QUEUE" } });
    await connector.write(connector.caseItems.completeTaskOp("demo", "cmp-0001", { atSim: SIM_NOW, noteId: "note-1" }, { doneBy: "stf-lucia", doneAtSim: SIM_NOW }));
    await expect(connector.write(connector.caseItems.completeTaskOp("demo", "cmp-0001", { atSim: SIM_NOW, noteId: "note-1" }, { doneBy: "stf-lucia", doneAtSim: SIM_NOW }))).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const file = await connector.caseItems.caseFile("demo", "cmp-0001");
    expect(file.complaint?.complaintNumber).toBe("R-2026-000123");
    expect(file.evidence.map((row) => row.evidenceId)).toEqual(["evd-0001"]);
    expect(file.actions[0]).toMatchObject({ claimKey: "OPC#NORTE#NTE-20261006-004817-7", amountCents: 11_864_000 });
    expect(file.notes[0]?.task?.status).toBe("DONE");
    expect(await connector.caseItems.getEvidence("demo", "cmp-0001", "evd-0001")).toMatchObject({ details: { result: "READ" } });
  });
});

describe("approvals", () => {
  it("creates a pending approval (never a decided one) that the pending index lists", async () => {
    const { connector } = await withComplaint();
    await connector.caseItems.createApproval(approval("demo", { decision: "APPROVED", decidedBy: "stf-x" }));
    expect(await connector.caseItems.getApproval("demo", "cmp-0001", "apr-0001")).toMatchObject({ decision: "PENDING", version: 1 });
    expect((await connector.caseItems.listPendingApprovals("demo")).map((row) => row.approvalId)).toEqual(["apr-0001"]);
  });

  it("decides once on the version read, leaves the pending index, and executes once", async () => {
    const { connector } = await withComplaint();
    await connector.caseItems.createApproval(approval("demo"));
    const decide = { worldId: "demo", complaintId: "cmp-0001", approvalId: "apr-0001", version: 1, decision: "APPROVED" as const, decidedBy: "stf-lucia", decidedAtSim: SIM_NOW };
    expect(() => connector.caseItems.decideApprovalOp({ ...decide, decidedBy: undefined })).toThrow(expect.objectContaining({ code: "VALIDATION" }));
    await connector.write(connector.caseItems.decideApprovalOp(decide));
    await expect(connector.write(connector.caseItems.decideApprovalOp({ ...decide, version: 2, decision: "REJECTED" }))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await connector.caseItems.listPendingApprovals("demo")).toEqual([]);

    const execute = () =>
      connector.transact([
        connector.caseItems.markExecutedOp("demo", "cmp-0001", "apr-0001", "2026-10-07T13:11:00Z"),
        connector.caseItems.putExecutionOp({ worldId: "demo", complaintId: "cmp-0001", approvalId: "apr-0001", executedAtReal: "2026-10-07T13:11:00Z", executedAtSim: SIM_NOW }),
      ]);
    await execute();
    await expect(execute()).rejects.toBeInstanceOf(TransactionCancelledError);
    expect(await connector.caseItems.getExecution("demo", "cmp-0001", "apr-0001")).toMatchObject({ approvalId: "apr-0001" });
    expect(await connector.caseItems.getApproval("demo", "cmp-0001", "apr-0001")).toMatchObject({ decision: "APPROVED", decidedBy: "stf-lucia", executedAt: "2026-10-07T13:11:00.000Z" });
  });

  it("never executes a rejected approval", async () => {
    const { connector } = await withComplaint();
    await connector.caseItems.createApproval(approval("demo"));
    await connector.write(connector.caseItems.decideApprovalOp({ worldId: "demo", complaintId: "cmp-0001", approvalId: "apr-0001", version: 1, decision: "REJECTED", decidedBy: "stf-lucia", decidedAtSim: SIM_NOW, reason: "No" }));
    await expect(connector.write(connector.caseItems.markExecutedOp("demo", "cmp-0001", "apr-0001", "2026-10-07T13:11:00Z"))).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
