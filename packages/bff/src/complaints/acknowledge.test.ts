// `acknowledge_complaint` and `record_email_consent` (FL-010, FL-011; ADR-0015): number in the act and
// the acknowledgement before any turn, an open complaint acknowledged again instead of a new number,
// and the customer's answer to the email question stored once with its text version.
import { describe, expect, it } from "vitest";
import { SIM_NOW } from "../connector/testing";
import { type AckRequest, acknowledgeComplaint, findOpenComplaint, recordEmailConsent } from "./acknowledge";
import { transition } from "./state-machine";
import type { RegistrationInput } from "./numbering";
import { TEST_HOLIDAYS, complaintsKit } from "./testing";

function input(overrides: Partial<RegistrationInput> = {}): RegistrationInput {
  return {
    worldId: "demo",
    customerId: "cus-0001",
    kind: "RECLAMO",
    type: "PAYMENT_NOT_REFLECTED",
    channel: "WHATSAPP",
    summary: "Pagué la cuota 4 y sigue figurando atrasada",
    subject: { loanId: "L-0001", instalment: 4 },
    eventId: "evt-0001",
    presenter: { docType: "DNI", docNumberMasked: "••••4417" },
    filedAtSim: SIM_NOW,
    holidays: TEST_HOLIDAYS,
    actor: "SYSTEM",
    ...overrides,
  };
}

function recorder() {
  const acks: AckRequest[] = [];
  const send = async (request: AckRequest) => {
    acks.push(request);
    return { messageId: `msg-ack-${acks.length}` };
  };
  return { acks, send };
}

describe("acknowledgeComplaint [FL-010]", () => {
  it("[FL-010] registers and then acknowledges with number, type and deadline only (no account data)", async () => {
    const kit = complaintsKit();
    await kit.seedWorld();
    const { acks, send } = recorder();
    const ack = await acknowledgeComplaint(kit.deps, input(), send);
    expect(ack).toMatchObject({ created: true, existing: false, deadlineText: "jueves 22/10", ackMessageId: "msg-ack-1", complaint: { complaintNumber: "R-2026-000001", status: "REGISTERED" } });
    expect(acks).toEqual([
      {
        worldId: "demo",
        customerId: "cus-0001",
        complaintId: ack.complaint.complaintId,
        complaintNumber: "R-2026-000001",
        kind: "RECLAMO",
        type: "PAYMENT_NOT_REFLECTED",
        deadlineSim: "2026-10-22T23:59:59-03:00",
        deadlineText: "jueves 22/10",
        existing: false,
        askEmailConsent: true,
        eventId: "evt-0001",
      },
    ]);
    // The FILED entry existed before the acknowledgement went out.
    expect(kit.store.dump("Register")).toHaveLength(1);
    expect(ack.filedHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("[FL-010] an open complaint of the same type and object gets no new number", async () => {
    const kit = complaintsKit();
    await kit.seedWorld();
    const { acks, send } = recorder();
    const first = await acknowledgeComplaint(kit.deps, input(), send);
    const again = await acknowledgeComplaint(kit.deps, input({ eventId: "evt-0002", summary: "¿Y mi pago?" }), send);
    expect(again).toMatchObject({ created: false, existing: true, complaint: { complaintNumber: first.complaint.complaintNumber } });
    expect(acks.map((ack) => [ack.complaintNumber, ack.existing])).toEqual([
      ["R-2026-000001", false],
      ["R-2026-000001", true],
    ]);
    expect(kit.store.dump("Register")).toHaveLength(1);
  });

  it("[FL-010] another object or type gets its own number; a case with a person is still open", async () => {
    const kit = complaintsKit();
    await kit.seedWorld();
    await acknowledgeComplaint(kit.deps, input());
    const otherLoan = await acknowledgeComplaint(kit.deps, input({ eventId: "evt-0002", subject: { loanId: "L-0002" } }));
    const otherType = await acknowledgeComplaint(kit.deps, input({ eventId: "evt-0003", type: "DUPLICATE_DEBIT", subject: {} }));
    expect([otherLoan.complaint.complaintNumber, otherType.complaint.complaintNumber]).toEqual(["R-2026-000002", "R-2026-000003"]);
    expect(await findOpenComplaint(kit.deps, { worldId: "demo", customerId: "cus-0001", type: "PAYMENT_NOT_REFLECTED", subject: { loanId: "L-0001" } })).toBeDefined();
    const firstId = (await findOpenComplaint(kit.deps, { worldId: "demo", customerId: "cus-0001", type: "PAYMENT_NOT_REFLECTED", subject: { loanId: "L-0001" } }))?.complaintId ?? "";
    await transition(kit.deps, { worldId: "demo", complaintId: firstId, to: "HUMAN_REVIEW", cause: "CUSTOMER_ASKED", actor: "AGENT", atSim: SIM_NOW });
    expect((await findOpenComplaint(kit.deps, { worldId: "demo", customerId: "cus-0001", type: "PAYMENT_NOT_REFLECTED", subject: { loanId: "L-0001" } }))?.status).toBe("HUMAN_REVIEW");
  });

  it("[FL-010] the same inbound event acknowledged twice keeps one number and is not taken for an open duplicate", async () => {
    const kit = complaintsKit();
    await kit.seedWorld();
    const first = await acknowledgeComplaint(kit.deps, input());
    const replay = await acknowledgeComplaint(kit.deps, input());
    expect(replay).toMatchObject({ created: false, existing: false, complaint: { complaintId: first.complaint.complaintId } });
  });
});

describe("recordEmailConsent [FL-011]", () => {
  async function registered() {
    const kit = complaintsKit();
    await kit.seedWorld();
    const ack = await acknowledgeComplaint(kit.deps, input());
    return { kit, complaintId: ack.complaint.complaintId };
  }

  it("[FL-011] stores the acceptance with its text version once and sends ACK_EMAIL once", async () => {
    const { kit, complaintId } = await registered();
    const sent: string[] = [];
    const sendAckEmail = async (complaint: { complaintNumber: string }) => {
      sent.push(complaint.complaintNumber);
      return { messageId: "msg-ack-email" };
    };
    const consent = { worldId: "demo", complaintId, decision: "ACCEPTED" as const, textVersion: "email-answer-v1", atSim: "2026-10-07T10:12:00-03:00", actor: "SYSTEM" as const };
    const first = await recordEmailConsent(kit.deps, consent, sendAckEmail);
    expect(first).toMatchObject({ changed: true, consent: { status: "ACCEPTED", textVersion: "email-answer-v1", atSim: "2026-10-07T10:12:00-03:00" }, ackEmailMessageId: "msg-ack-email" });
    const repeated = await recordEmailConsent(kit.deps, { ...consent, decision: "DECLINED" }, sendAckEmail);
    expect(repeated).toMatchObject({ changed: false, consent: { status: "ACCEPTED" } });
    expect(sent).toEqual(["R-2026-000001"]);
    expect((await kit.connector.audit.listByAction("demo", "EMAIL_CONSENT")).map((entry) => entry.outcome)).toEqual(["ACCEPTED"]);
  });

  it("[FL-011] a declined email leaves an open human task for another reliable medium and no email", async () => {
    const { kit, complaintId } = await registered();
    let emails = 0;
    const result = await recordEmailConsent(kit.deps, { worldId: "demo", complaintId, decision: "DECLINED", textVersion: "email-answer-v1", atSim: SIM_NOW, actor: "SYSTEM" }, async () => {
      emails += 1;
      return {};
    });
    expect(result.consent.status).toBe("DECLINED");
    expect(emails).toBe(0);
    const notes = await kit.connector.caseItems.listNotes("demo", complaintId);
    expect(notes).toEqual([expect.objectContaining({ kind: "HUMAN_TASK", author: "SYSTEM", task: { status: "OPEN", route: "HUMAN_QUEUE" } })]);
  });

  it("refuses a text version the customer could not have seen and a complaint that does not exist", async () => {
    const { kit, complaintId } = await registered();
    await expect(recordEmailConsent(kit.deps, { worldId: "demo", complaintId, decision: "ACCEPTED", textVersion: "email-answer-v9", atSim: SIM_NOW, actor: "SYSTEM" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(recordEmailConsent(kit.deps, { worldId: "demo", complaintId: "cmp-none", decision: "ACCEPTED", textVersion: "email-answer-v1", atSim: SIM_NOW, actor: "SYSTEM" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
