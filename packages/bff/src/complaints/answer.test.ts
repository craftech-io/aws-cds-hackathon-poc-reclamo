// The written answer (docs/tool-catalog.md `answer_complaint_in_writing`, `operator_answer`):
// attachments chosen by code, preconditions, `inFlight` with `FINAL_ANSWER` in one transaction, the
// `ANSWERED` transition with its timers and the delivery proof.
import { describe, expect, it } from "vitest";
import { SIM_NOW, complaint, evidence, timer } from "../connector/testing";
import type { Complaint } from "../domain/complaint";
import { sha256Hex } from "../lib/crypto";
import { beginAnswer, checkAnswerPreconditions, completeAnswer, recordDeliveryProof, releaseAnswer, selectAttachments } from "./answer";
import { transition } from "./state-machine";
import { TEST_HOLIDAYS, complaintsKit } from "./testing";

const consented = { status: "ACCEPTED" as const, atSim: SIM_NOW, textVersion: "email-answer-v1" };
const executed = (kind: "APPLY_PAYMENT" | "REVERSE_CHARGE" | "REFUND_DUPLICATE") => ({ kind, status: "EXECUTED" as const });

describe("attachments by eligibility", () => {
  it("[FL-025] the last instalment paid cancels the loan: certificate and statement are added without being asked", () => {
    const selection = selectAttachments({ complaint: { type: "PAYMENT_NOT_REFLECTED", subject: { loanId: "L-0014" } }, loan: { loanId: "L-0014", status: "CANCELLED" }, actions: [executed("APPLY_PAYMENT")] });
    expect(selection).toEqual({ attachments: ["PAYOFF_CERTIFICATE", "STATEMENT"], added: ["PAYOFF_CERTIFICATE", "STATEMENT"], removed: [] });
  });

  it("[FL-030] a cancelled loan gets its debt-free certificate (also for an early cancellation)", () => {
    for (const status of ["CANCELLED", "EARLY_CANCELLED"]) {
      const selection = selectAttachments({ complaint: { type: "PAYOFF_CERTIFICATE", subject: { loanId: "L-0005" } }, loan: { loanId: "L-0005", status }, actions: [], requested: ["PAYOFF_CERTIFICATE"] });
      expect(selection.attachments).toContain("PAYOFF_CERTIFICATE");
    }
  });

  it("[FL-031] a loan with balance never gets the certificate: asking for it is NOT_ELIGIBLE", () => {
    const context = { complaint: { type: "PAYOFF_CERTIFICATE" as const, subject: { loanId: "L-0021" } }, loan: { loanId: "L-0021", status: "ACTIVE" }, actions: [] };
    expect(selectAttachments(context).attachments).not.toContain("PAYOFF_CERTIFICATE");
    expect(() => selectAttachments({ ...context, requested: ["PAYOFF_CERTIFICATE"] })).toThrow(expect.objectContaining({ code: "NOT_ELIGIBLE", reason: "PAYOFF_NOT_ELIGIBLE" }));
    expect(() => selectAttachments({ ...context, loan: { loanId: "L-0021", status: "IN_ARREARS" }, requested: ["PAYOFF_CERTIFICATE"] })).toThrow();
  });

  it("adds the credit note of an executed reversal or refund, drops one nobody issued and refuses an unknown kind", () => {
    const withReversal = selectAttachments({ complaint: { type: "UNRECOGNIZED_CHARGE" }, actions: [executed("REVERSE_CHARGE")] });
    expect(withReversal).toMatchObject({ attachments: ["CREDIT_NOTE"], added: ["CREDIT_NOTE"] });
    const without = selectAttachments({ complaint: { type: "UNRECOGNIZED_CHARGE" }, actions: [{ kind: "REVERSE_CHARGE", status: "CONFLICT" }], requested: ["CREDIT_NOTE", "STATEMENT"] });
    expect(without).toEqual({ attachments: [], added: [], removed: ["CREDIT_NOTE", "STATEMENT"] });
    expect(() => selectAttachments({ complaint: { type: "UNRECOGNIZED_CHARGE" }, actions: [], requested: ["ID_CARD" as never] })).toThrow();
  });

  it("gives the statement on request for a complaint about a loan", () => {
    expect(selectAttachments({ complaint: { type: "INFORMATION_REQUEST", subject: { loanId: "L-0003" } }, actions: [], requested: ["STATEMENT"] }).attachments).toEqual(["STATEMENT"]);
  });
});

describe("preconditions", () => {
  const resolved = { ...complaint("demo", { status: "RESOLVED", emailAnswerConsent: consented }), version: 1 } as Complaint;

  it("needs the email channel accepted and a resolved complaint", () => {
    expect(() => checkAnswerPreconditions(resolved, "AGENT")).not.toThrow();
    expect(() => checkAnswerPreconditions({ ...resolved, emailAnswerConsent: { status: "DECLINED" } }, "AGENT")).toThrow(expect.objectContaining({ code: "NOT_ELIGIBLE", reason: "EMAIL_NOT_ACCEPTED" }));
    expect(() => checkAnswerPreconditions({ ...resolved, status: "INVESTIGATING" }, "AGENT")).toThrow(expect.objectContaining({ code: "NOT_ELIGIBLE", reason: "NOT_RESOLVED" }));
    expect(() => checkAnswerPreconditions({ ...resolved, answer: { inFlight: "msg-1" } }, "AGENT")).toThrow(expect.objectContaining({ code: "CONFLICT" }));
  });

  it("[FL-089] lets an operator answer a human case, never the agent", () => {
    const human = { ...resolved, status: "HUMAN_REVIEW" as const };
    expect(() => checkAnswerPreconditions(human, "OPERATOR:stf-operator-01")).not.toThrow();
    expect(() => checkAnswerPreconditions(human, "AGENT")).toThrow(expect.objectContaining({ reason: "NOT_RESOLVED" }));
  });
});

async function resolvedKit(status: Complaint["status"] = "RESOLVED", options: Parameters<typeof complaintsKit>[0] = {}) {
  const kit = complaintsKit(options);
  await kit.seedWorld();
  await kit.connector.transact([
    kit.connector.complaints.createOp(complaint("demo", { status, outcome: "IN_FAVOUR", emailAnswerConsent: consented })),
    kit.connector.timers.putOp(timer("demo", { timerId: "cmp-0001-DEADLINE" })),
  ]);
  await kit.connector.caseItems.putEvidence(evidence("demo", { kind: "SETTLEMENT_MATCH" }));
  return kit;
}

const begin = { worldId: "demo", complaintId: "cmp-0001", messageId: "msg-answer-1", body: "Respuesta escrita del reclamo.", outcome: "IN_FAVOUR" as const, actor: "AGENT" as const, atSim: "2026-10-08T15:00:00-03:00" };

describe("the answer pipeline [FL-025] [FL-030] [FL-089]", () => {
  it("[FL-030] claims inFlight with the FINAL_ANSWER entry (body hash) in one transaction; a second send collides", async () => {
    const kit = await resolvedKit();
    const begun = await beginAnswer(kit.deps, begin);
    expect(begun.bodySha256).toBe(sha256Hex(begin.body));
    expect(begun.register.entry).toMatchObject({ eventType: "FINAL_ANSWER", bodySha256: begun.bodySha256, answerRef: "msg-answer-1", channel: "EMAIL", reason: "IN_FAVOUR" });
    expect(begun.finalAnswerHash).toBe(begun.register.entry.hash);
    expect((await kit.connector.complaints.get("demo", "cmp-0001"))?.answer).toEqual({ inFlight: "msg-answer-1" });
    await expect(beginAnswer(kit.deps, { ...begin, messageId: "msg-answer-2" })).rejects.toMatchObject({ code: "CONFLICT", reason: "ANSWER_IN_FLIGHT" });
    expect(kit.store.dump("Register")).toHaveLength(1);
  });

  it("frees the claim when the gate did not send it", async () => {
    const kit = await resolvedKit();
    await beginAnswer(kit.deps, begin);
    await releaseAnswer(kit.deps, { worldId: "demo", complaintId: "cmp-0001", messageId: "msg-answer-1" });
    expect((await kit.connector.complaints.get("demo", "cmp-0001"))?.answer).toEqual({});
  });

  it("[FL-025] once SES accepted it: ANSWERED, milestones cancelled and AUTO_CLOSE five business days later", async () => {
    const kit = await resolvedKit();
    await beginAnswer(kit.deps, begin);
    const result = await completeAnswer(kit.deps, { worldId: "demo", complaintId: "cmp-0001", messageId: "msg-answer-1", mailId: "mail-1", sentAtSim: begin.atSim, outcome: "IN_FAVOUR", actor: "AGENT", holidays: TEST_HOLIDAYS });
    expect(result.complaint).toMatchObject({ status: "ANSWERED", answer: { messageId: "msg-answer-1", mailId: "mail-1", deliveryProof: "SENT", sentAtSim: begin.atSim } });
    const timers = await kit.connector.timers.listByOwner("demo", "CMP#cmp-0001");
    expect(timers.map((item) => [item.kind, item.status])).toEqual(expect.arrayContaining([["SLA", "CANCELLED"], ["AUTO_CLOSE", "SCHEDULED"]]));
    const { entries } = await kit.connector.chains.listRegister("REG", "demo", 1);
    expect(entries.map((entry) => [entry.eventType, entry.status])).toEqual([
      ["FINAL_ANSWER", "RESOLVED"],
      ["STATUS", "ANSWERED"],
    ]);
  });

  it("[FL-089] an operator's answer to a human case goes RESOLVED then ANSWERED, both in the register", async () => {
    const kit = await resolvedKit("HUMAN_REVIEW");
    const operator = { ...begin, actor: "OPERATOR:stf-operator-01" as const };
    await beginAnswer(kit.deps, operator);
    const result = await completeAnswer(kit.deps, { worldId: "demo", complaintId: "cmp-0001", messageId: "msg-answer-1", mailId: "mail-1", sentAtSim: begin.atSim, outcome: "PARTIALLY_IN_FAVOUR", actor: operator.actor, holidays: TEST_HOLIDAYS });
    expect(result.complaint.status).toBe("ANSWERED");
    expect(result.complaint.statusHistory.slice(-2).map((change) => [change.from, change.to, change.actor])).toEqual([
      ["HUMAN_REVIEW", "RESOLVED", "OPERATOR:stf-operator-01"],
      ["RESOLVED", "ANSWERED", "OPERATOR:stf-operator-01"],
    ]);
    const { entries } = await kit.connector.chains.listRegister("REG", "demo", 1);
    expect(entries.map((entry) => entry.eventType)).toEqual(["FINAL_ANSWER", "STATUS", "STATUS"]);
  });

  it("writes the DELIVERY_PROOF entry with the answer's proof", async () => {
    const kit = await resolvedKit();
    await beginAnswer(kit.deps, begin);
    await completeAnswer(kit.deps, { worldId: "demo", complaintId: "cmp-0001", messageId: "msg-answer-1", mailId: "mail-1", sentAtSim: begin.atSim, outcome: "IN_FAVOUR", actor: "AGENT", holidays: TEST_HOLIDAYS });
    const proof = await recordDeliveryProof(kit.deps, { worldId: "demo", complaintId: "cmp-0001", messageId: "msg-answer-1", proof: "DELIVERED", atSim: "2026-10-08T15:01:00-03:00" });
    expect(proof.entry).toMatchObject({ eventType: "DELIVERY_PROOF", reason: "DELIVERED", seq: 3 });
    expect((await kit.connector.complaints.get("demo", "cmp-0001"))?.answer?.deliveryProof).toBe("DELIVERED");
    await expect(recordDeliveryProof(kit.deps, { worldId: "demo", complaintId: "cmp-0001", messageId: "msg-other", proof: "BOUNCED", atSim: SIM_NOW })).rejects.toMatchObject({ code: "CONFLICT", reason: "NOT_THE_ANSWER" });
  });
});

describe("completeAnswer is safe to retry [FL-025] [FL-089]", () => {
  const sent = { worldId: "demo", complaintId: "cmp-0001", messageId: "msg-answer-1", mailId: "mail-1", sentAtSim: begin.atSim, outcome: "IN_FAVOUR" as const, holidays: TEST_HOLIDAYS };

  /** Fails the n-th multi-item transaction after it is armed once (a worker timeout mid-way). */
  function failingTransaction(nth: number) {
    const state = { armed: false, seen: 0, failed: false };
    const beforeWrite = (ops: readonly unknown[]) => {
      if (!state.armed || state.failed || ops.length < 2) return;
      state.seen += 1;
      if (state.seen === nth) {
        state.failed = true;
        throw new Error("worker timed out");
      }
    };
    return { state, beforeWrite };
  }

  async function expectAnsweredOnce(kit: Awaited<ReturnType<typeof resolvedKit>>) {
    const current = await kit.connector.complaints.get("demo", "cmp-0001");
    expect(current).toMatchObject({ status: "ANSWERED", answer: { messageId: "msg-answer-1", mailId: "mail-1", deliveryProof: "SENT" } });
    expect(current?.statusHistory.filter((change) => change.to === "ANSWERED")).toHaveLength(1);
    const timers = await kit.connector.timers.listByOwner("demo", "CMP#cmp-0001");
    expect(timers.filter((item) => item.kind === "AUTO_CLOSE")).toHaveLength(1);
    expect(timers.filter((item) => item.kind !== "AUTO_CLOSE").every((item) => item.status === "CANCELLED")).toBe(true);
  }

  it("a redelivered event after a complete run changes nothing", async () => {
    const kit = await resolvedKit();
    await beginAnswer(kit.deps, begin);
    await completeAnswer(kit.deps, { ...sent, actor: "AGENT" });
    const again = await completeAnswer(kit.deps, { ...sent, actor: "AGENT" });
    expect(again.register).toBeUndefined();
    expect(again.complaint.status).toBe("ANSWERED");
    await expectAnsweredOnce(kit);
    const { entries } = await kit.connector.chains.listRegister("REG", "demo", 1);
    expect(entries.map((entry) => entry.eventType)).toEqual(["FINAL_ANSWER", "STATUS"]);
  });

  it("the answer recorded but the ANSWERED transition lost: the retry finishes it", async () => {
    const failing = failingTransaction(1);
    const kit = await resolvedKit("RESOLVED", { beforeWrite: failing.beforeWrite });
    await beginAnswer(kit.deps, begin);
    failing.state.armed = true;
    await expect(completeAnswer(kit.deps, { ...sent, actor: "AGENT" })).rejects.toThrow("worker timed out");
    expect(await kit.connector.complaints.get("demo", "cmp-0001")).toMatchObject({ status: "RESOLVED", answer: { messageId: "msg-answer-1" } });
    await completeAnswer(kit.deps, { ...sent, actor: "AGENT" });
    await expectAnsweredOnce(kit);
  });

  it("an operator's answer that failed between RESOLVED and ANSWERED: the retry finishes it", async () => {
    const failing = failingTransaction(2);
    const kit = await resolvedKit("HUMAN_REVIEW", { beforeWrite: failing.beforeWrite });
    const operator = { ...sent, actor: "OPERATOR:stf-operator-01" as const };
    await beginAnswer(kit.deps, { ...begin, actor: operator.actor });
    failing.state.armed = true;
    await expect(completeAnswer(kit.deps, operator)).rejects.toThrow("worker timed out");
    expect((await kit.connector.complaints.get("demo", "cmp-0001"))?.status).toBe("RESOLVED");
    const result = await completeAnswer(kit.deps, operator);
    expect(result.complaint.statusHistory.slice(-2).map((change) => [change.from, change.to])).toEqual([
      ["HUMAN_REVIEW", "RESOLVED"],
      ["RESOLVED", "ANSWERED"],
    ]);
    await expectAnsweredOnce(kit);
  });

  /** The complaint and its register as they are now, to compare before and after a redelivery. */
  async function snapshot(kit: Awaited<ReturnType<typeof resolvedKit>>) {
    const current = await kit.connector.complaints.get("demo", "cmp-0001");
    const { entries } = await kit.connector.chains.listRegister("REG", "demo", 1);
    return { status: current?.status, statusHistory: current?.statusHistory, answer: current?.answer, register: entries.map((entry) => [entry.eventType, entry.status, entry.reason]) };
  }

  it("a late redelivery after a bounce sent the case back to HUMAN_REVIEW changes nothing", async () => {
    const kit = await resolvedKit();
    await beginAnswer(kit.deps, begin);
    await completeAnswer(kit.deps, { ...sent, actor: "AGENT" });
    await recordDeliveryProof(kit.deps, { worldId: "demo", complaintId: "cmp-0001", messageId: "msg-answer-1", proof: "BOUNCED", atSim: "2026-10-08T15:02:00-03:00" });
    await transition(kit.deps, { worldId: "demo", complaintId: "cmp-0001", to: "HUMAN_REVIEW", cause: "EMAIL_UNDELIVERABLE", actor: "SYSTEM", atSim: "2026-10-08T15:02:00-03:00", holidays: TEST_HOLIDAYS });
    const before = await snapshot(kit);
    expect(before.status).toBe("HUMAN_REVIEW");
    for (const actor of ["AGENT", "OPERATOR:stf-operator-01"] as const) {
      const again = await completeAnswer(kit.deps, { ...sent, actor });
      expect(again.register).toBeUndefined();
      expect(again.complaint.status).toBe("HUMAN_REVIEW");
    }
    expect(await snapshot(kit)).toEqual(before);
  });

  it("a late redelivery after AUTO_CLOSE is a no-op, never an invalid transition", async () => {
    const kit = await resolvedKit();
    await beginAnswer(kit.deps, begin);
    await completeAnswer(kit.deps, { ...sent, actor: "AGENT" });
    await transition(kit.deps, { worldId: "demo", complaintId: "cmp-0001", to: "CLOSED", cause: "AUTO_CLOSE", actor: "SYSTEM", atSim: "2026-10-16T15:00:00-03:00", holidays: TEST_HOLIDAYS });
    const before = await snapshot(kit);
    expect(before.status).toBe("CLOSED");
    const again = await completeAnswer(kit.deps, { ...sent, actor: "AGENT" });
    expect(again).toEqual({ complaint: expect.objectContaining({ status: "CLOSED" }) });
    expect(await snapshot(kit)).toEqual(before);
  });

  it("the agent never resolves a human case: a send recorded before a hand-off stays with the person", async () => {
    const failing = failingTransaction(1);
    const kit = await resolvedKit("RESOLVED", { beforeWrite: failing.beforeWrite });
    await beginAnswer(kit.deps, begin);
    failing.state.armed = true;
    await expect(completeAnswer(kit.deps, { ...sent, actor: "AGENT" })).rejects.toThrow("worker timed out");
    await transition(kit.deps, { worldId: "demo", complaintId: "cmp-0001", to: "HUMAN_REVIEW", cause: "HANDOFF_FRAUD", actor: "SYSTEM", atSim: "2026-10-08T15:01:00-03:00", holidays: TEST_HOLIDAYS });
    const before = await snapshot(kit);
    await expect(completeAnswer(kit.deps, { ...sent, actor: "AGENT" })).rejects.toMatchObject({ reason: "INVALID_TRANSITION" });
    expect(await snapshot(kit)).toEqual(before);
    expect(before.statusHistory?.some((change) => change.cause === "OPERATOR_ANSWER")).toBe(false);
  });

  it("another send's record is still a conflict", async () => {
    const kit = await resolvedKit();
    await beginAnswer(kit.deps, begin);
    await expect(completeAnswer(kit.deps, { ...sent, messageId: "msg-other", actor: "AGENT" })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
