// The state machine (docs/design-brief.md §4, docs/architecture.md §8.1): every allowed transition
// and every forbidden one, the register entry in the same transaction, the retry after a version
// conflict, the code preconditions, the withdrawal and the automatic close.
import { type ComplaintStatus, ComplaintStatus as Statuses } from "@reclamo/shared";
import { describe, expect, it } from "vitest";
import { SIM_NOW, complaint, evidence, timer } from "../connector/testing";
import type { Complaint } from "../domain/complaint";
import type { WriteOp } from "../connector/store";
import { InvalidTransitionError, TRANSITIONS, WITHDRAWABLE, allowedFrom, canTransition, transition, withdraw } from "./state-machine";
import { TEST_HOLIDAYS, complaintsKit, linesNamed } from "./testing";

const ALL = Statuses.options;
const NEEDS: Partial<Record<ComplaintStatus, true>> = { RESOLVED: true, ANSWERED: true, CLOSED: true };

async function seeded(status: ComplaintStatus, overrides: Partial<Parameters<typeof complaint>[1]> = {}, options: Parameters<typeof complaintsKit>[0] = {}) {
  const kit = complaintsKit(options);
  await kit.seedWorld();
  await kit.connector.transact([kit.connector.complaints.createOp(complaint("demo", { status, ...overrides }))]);
  const current = (await kit.connector.complaints.get("demo", "cmp-0001")) as Complaint;
  return { kit, current };
}

const base = { worldId: "demo", complaintId: "cmp-0001", actor: "AGENT" as const, atSim: SIM_NOW, holidays: TEST_HOLIDAYS };

describe("transition table", () => {
  it("declares the transitions of the design brief", () => {
    expect(canTransition("REGISTERED", "INVESTIGATING")).toBe(true);
    expect(canTransition("INVESTIGATING", "AWAITING_NETWORK")).toBe(true);
    expect(canTransition("AWAITING_APPROVAL", "RESOLVED")).toBe(true);
    expect(canTransition("HUMAN_REVIEW", "AWAITING_APPROVAL")).toBe(true);
    expect(canTransition("RESOLVED", "ANSWERED")).toBe(true);
    expect(canTransition("ANSWERED", "CLOSED")).toBe(true);
    expect(canTransition("ANSWERED", "HUMAN_REVIEW")).toBe(true);
    expect(canTransition("REGISTERED", "RESOLVED")).toBe(false);
    expect(canTransition("CLOSED", "INVESTIGATING")).toBe(false);
    expect(canTransition("ANSWERED", "RESOLVED")).toBe(false);
    expect(allowedFrom("ANSWERED")).toEqual(["RESOLVED"]);
    for (const rule of TRANSITIONS) for (const from of rule.from) expect(from).not.toBe(rule.to);
  });

  it("allows every transition of the table without a precondition, each with its STATUS entry", async () => {
    for (const rule of TRANSITIONS.filter((item) => !item.requires)) {
      for (const from of rule.from) {
        const { kit } = await seeded(from);
        const result = await transition(kit.deps, { ...base, to: rule.to, cause: "TEST" });
        expect(result.complaint, `${from} → ${rule.to}`).toMatchObject({ status: rule.to, version: 2 });
        expect(result.register.entry, `${from} → ${rule.to}`).toMatchObject({ eventType: "STATUS", status: rule.to, reason: "TEST", seq: 1 });
      }
    }
  });

  it("refuses every transition outside the table as INVALID_TRANSITION, writing nothing", async () => {
    for (const from of ALL) {
      for (const to of ALL) {
        if (canTransition(from, to) || NEEDS[to]) continue;
        const { kit } = await seeded(from);
        const error = await transition(kit.deps, { ...base, to, cause: "TEST" }).catch((thrown: unknown) => thrown);
        expect(error, `${from} → ${to}`).toBeInstanceOf(InvalidTransitionError);
        expect(error).toMatchObject({ code: "INVALID", reason: "INVALID_TRANSITION" });
        expect(kit.store.dump("Register")).toEqual([]);
        expect(linesNamed(kit.lines, "complaints.invalid_transition")[0]).toMatchObject({ metric: "INVALID_TRANSITION", fromStatus: from, toStatus: to });
      }
    }
  });
});

describe("transition() writes", () => {
  it("[FL-014] commits the conditional update and its register entry in one transaction", async () => {
    const transactions: WriteOp[][] = [];
    const { kit } = await seeded("REGISTERED", {}, { beforeWrite: (ops) => void transactions.push([...ops]) });
    transactions.length = 0;
    const result = await transition(kit.deps, { ...base, to: "INVESTIGATING", cause: "IDENTIFIED" });
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.map((op) => [op.kind, op.table])).toEqual([
      ["update", "Runtime"],
      ["put", "Register"],
      ["update", "Complaints"],
    ]);
    expect(result.complaint.statusHistory.at(-1)).toEqual({ from: "REGISTERED", to: "INVESTIGATING", atSim: SIM_NOW, cause: "IDENTIFIED", actor: "AGENT" });
    expect(kit.anchorRequests).toHaveLength(1);
  });

  it("[FL-014] re-reads the complaint and retries after a version conflict, with no gap in the register", async () => {
    let raced = false;
    const { kit } = await seeded("REGISTERED", {}, {
      beforeWrite: async (ops) => {
        if (raced || !ops.some((op) => op.table === "Register")) return;
        raced = true;
        await kit.connector.complaints.patch("demo", "cmp-0001", 1, { priority: "HIGH" });
      },
    });
    const result = await transition(kit.deps, { ...base, to: "INVESTIGATING", cause: "IDENTIFIED" });
    expect(result.register.attempts).toBe(2);
    expect(result.complaint).toMatchObject({ status: "INVESTIGATING", priority: "HIGH", version: 3 });
    expect(kit.store.dump("Register").map((row) => row.sk)).toEqual(["000000001"]);
  });

  it("answers a conflict, not a programming error, when the status moved under a retry", async () => {
    let raced = false;
    const { kit } = await seeded("REGISTERED", {}, {
      beforeWrite: async (ops) => {
        if (raced || !ops.some((op) => op.table === "Register")) return;
        raced = true;
        await transition(kit.deps, { ...base, to: "HUMAN_REVIEW", cause: "CUSTOMER_ASKED" });
      },
    });
    await expect(transition(kit.deps, { ...base, to: "INVESTIGATING", cause: "IDENTIFIED" })).rejects.toMatchObject({ code: "CONFLICT", reason: "STATUS_MOVED" });
  });
});

describe("preconditions", () => {
  it("RESOLVED needs an action or evidence that founds it; a receipt image alone does not", async () => {
    const { kit } = await seeded("INVESTIGATING", { type: "UNRECOGNIZED_CHARGE" });
    await expect(transition(kit.deps, { ...base, to: "RESOLVED", cause: "EXPLAINED" })).rejects.toMatchObject({ code: "EVIDENCE_REQUIRED", reason: "FOUNDATION" });
    await kit.connector.caseItems.putEvidence(evidence("demo", { evidenceId: "evd-img", kind: "RECEIPT_IMAGE" }));
    await expect(transition(kit.deps, { ...base, to: "RESOLVED", cause: "EXPLAINED" })).rejects.toMatchObject({ code: "EVIDENCE_REQUIRED" });
    // Another type's investigation never founds this one (complaints/foundation.ts).
    await kit.connector.caseItems.putEvidence(evidence("demo", { evidenceId: "evd-trs", kind: "TRANSFER_STATUS", details: { status: "COMPLETED" } }));
    await expect(transition(kit.deps, { ...base, to: "RESOLVED", cause: "EXPLAINED" })).rejects.toMatchObject({ code: "EVIDENCE_REQUIRED" });
    await kit.connector.caseItems.putEvidence(evidence("demo", { evidenceId: "evd-chk", kind: "CHARGE_CHECK", details: { result: "CORRECT" } }));
    expect((await transition(kit.deps, { ...base, to: "RESOLVED", cause: "EXPLAINED", patch: { outcome: "NOT_IN_FAVOUR" } })).complaint).toMatchObject({ status: "RESOLVED", outcome: "NOT_IN_FAVOUR" });
  });

  it("an operator resolving a human case is the foundation itself", async () => {
    const { kit } = await seeded("HUMAN_REVIEW");
    const result = await transition(kit.deps, { ...base, actor: "OPERATOR:stf-operator-01", to: "RESOLVED", cause: "OPERATOR_ANSWER" });
    expect(result.complaint.status).toBe("RESOLVED");
  });

  it("ANSWERED needs the sent answer; it cancels the milestones, adds AUTO_CLOSE and syncs the schedules", async () => {
    const synced: string[] = [];
    const milestones = { schedule: async (_w: string, ids: readonly { timerId: string }[]) => void synced.push(...ids.map((id) => `+${id.timerId}`)), cancel: async (_w: string, names: readonly string[]) => void synced.push(...names.map((name) => `-${name}`)) };
    const { kit } = await seeded("RESOLVED", {}, { milestones });
    await kit.connector.transact([
      kit.connector.timers.putOp(timer("demo", { timerId: "cmp-0001-DEADLINE", scheduleName: "tm-demo-e1-dead" })),
      kit.connector.timers.putOp(timer("demo", { timerId: "cmp-0001-OPERATOR_REMINDER", dueAtSim: "2026-10-15T10:00:00-03:00", seq: 1 })),
    ]);
    await expect(transition(kit.deps, { ...base, to: "ANSWERED", cause: "WRITTEN_ANSWER_SENT" })).rejects.toMatchObject({ code: "NOT_ELIGIBLE", reason: "ANSWER_SENT" });
    await kit.connector.write(kit.connector.complaints.claimAnswerOp("demo", "cmp-0001", "msg-ans"));
    await kit.connector.write(kit.connector.complaints.recordAnswerSentOp("demo", "cmp-0001", { messageId: "msg-ans", mailId: "mail-1", sentAtSim: "2026-10-08T15:00:00-03:00" }));
    const result = await transition(kit.deps, { ...base, atSim: "2026-10-08T15:00:00-03:00", to: "ANSWERED", cause: "WRITTEN_ANSWER_SENT" });
    expect(result.complaint.status).toBe("ANSWERED");
    const timers = await kit.connector.timers.listByOwner("demo", "CMP#cmp-0001");
    expect(timers.filter((item) => item.kind === "SLA").map((item) => item.status)).toEqual(["CANCELLED", "CANCELLED"]);
    expect(timers.find((item) => item.kind === "AUTO_CLOSE")).toMatchObject({ timerId: "cmp-0001-AUTO_CLOSE-1", status: "SCHEDULED", dueAtSim: "2026-10-16T15:00:00-03:00" });
    expect(synced).toEqual(["-tm-demo-e1-dead", "+cmp-0001-AUTO_CLOSE-1"]);
  });

  it("[FL-083] closes only five business days after the answer, with its STATUS entry", async () => {
    const { kit } = await seeded("ANSWERED", { answer: { messageId: "msg-ans", mailId: "mail-1", sentAtSim: "2026-10-08T15:00:00-03:00", deliveryProof: "DELIVERED" } });
    await expect(transition(kit.deps, { ...base, actor: "SYSTEM", atSim: "2026-10-16T14:59:00-03:00", to: "CLOSED", cause: "AUTO_CLOSE" })).rejects.toMatchObject({ code: "NOT_ELIGIBLE", reason: "AUTO_CLOSE_DUE" });
    const result = await transition(kit.deps, { ...base, actor: "SYSTEM", atSim: "2026-10-16T15:00:00-03:00", to: "CLOSED", cause: "AUTO_CLOSE" });
    expect(result.complaint.status).toBe("CLOSED");
    expect(result.register.entry).toMatchObject({ eventType: "STATUS", status: "CLOSED", reason: "AUTO_CLOSE" });
  });

  it("[FL-083] a bounce after the answer goes back to a person and cancels the pending AUTO_CLOSE", async () => {
    const { kit } = await seeded("ANSWERED", { answer: { messageId: "msg-ans", mailId: "mail-1", sentAtSim: SIM_NOW, deliveryProof: "BOUNCED" } });
    await kit.connector.transact([kit.connector.timers.putOp(timer("demo", { kind: "AUTO_CLOSE", timerId: "cmp-0001-AUTO_CLOSE-1" }))]);
    await transition(kit.deps, { ...base, actor: "SYSTEM", to: "HUMAN_REVIEW", cause: "EMAIL_UNDELIVERABLE", patch: { handoff: { reason: "EMAIL_UNDELIVERABLE", atSim: SIM_NOW } } });
    expect((await kit.connector.timers.listByOwner("demo", "CMP#cmp-0001"))[0]).toMatchObject({ status: "CANCELLED" });
  });
});

describe("withdraw [FL-015]", () => {
  it("[FL-015] resolves the complaint as WITHDRAWN with a WITHDRAWN entry and cancels the milestones", async () => {
    const { kit } = await seeded("AWAITING_SETTLEMENT");
    await kit.connector.transact([kit.connector.timers.putOp(timer("demo", { timerId: "cmp-0001-DEADLINE" }))]);
    const result = await withdraw(kit.deps, { ...base, cause: "CUSTOMER_WITHDREW" });
    expect(result.complaint).toMatchObject({ status: "RESOLVED", outcome: "WITHDRAWN" });
    expect(result.register.entry).toMatchObject({ eventType: "WITHDRAWN", status: "RESOLVED" });
    expect((await kit.connector.timers.listByOwner("demo", "CMP#cmp-0001")).map((item) => item.status)).toEqual(["CANCELLED"]);
  });

  it("[FL-015] is open from every status before the written answer and never after it", async () => {
    for (const from of ALL) {
      const { kit } = await seeded(from);
      const attempt = withdraw(kit.deps, { ...base, cause: "CUSTOMER_WITHDREW" });
      if (WITHDRAWABLE.includes(from)) await expect(attempt, from).resolves.toMatchObject({ complaint: { outcome: "WITHDRAWN" } });
      else await expect(attempt, from).rejects.toBeInstanceOf(InvalidTransitionError);
    }
  });
});
