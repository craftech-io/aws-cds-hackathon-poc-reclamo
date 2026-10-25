// The stage wiring of the worker over the memory connector: the effects of an SES event of one of our
// emails (stage/email.ts) and the refusals of an operator's written answer (stage/answer.ts). The entry
// (handlers/event-worker.ts) reads nothing when it is imported.
import { describe, expect, it } from "vitest";
import { email, message } from "../../connector/testing";
import { contentWasChecked } from "../../outbound/defer";
import type { OutboundRequest } from "../../outbound/types";
import { CustomerEvent, type EventOf } from "../events";
import { CUSTOMER, eventOf, workerKit, type WorkerKit } from "../testing";
import { stageWrittenAnswer } from "./answer";
import { stageEmailEffects } from "./email";

const notReached = () => {
  throw new Error("not reached in this test");
};

function emailEvent(): EventOf<"EMAIL_EVENT"> {
  const payload = { worldId: "demo", epoch: 1, customerId: CUSTOMER, complaintId: "cmp-0001", mailId: "mail-0001", sentAtSim: "2026-10-07T10:10:00-03:00", providerMessageId: "0100018f-abc", type: "BOUNCE", bounceType: "Permanent", occurredAtReal: "2026-10-07T13:10:00.000Z" } as const;
  return CustomerEvent.parse(eventOf("EMAIL_EVENT", payload, { eventId: "email-0001" })) as EventOf<"EMAIL_EVENT">;
}

function contextOf(kit: WorkerKit) {
  return { log: kit.deps.loggerFor("corr-stage"), now: kit.deps.now, receiveCount: 1, enqueue: async () => undefined };
}

function effectsOf(kit: WorkerKit) {
  return stageEmailEffects({ data: kit.connector, complaints: () => kit.complaints, gate: kit.gate.gate })(emailEvent(), contextOf(kit));
}

describe("the effects of an SES event", () => {
  it("hands an undeliverable answer's complaint to a person without a notice of its own", async () => {
    const kit = await workerKit();
    await kit.addComplaint({ status: "RESOLVED" });
    await effectsOf(kit).handOffUndeliverable({ worldId: "demo", complaintId: "cmp-0001", atSim: "2026-10-07T10:20:00-03:00", cause: "BOUNCE" });
    const complaint = await kit.connector.complaints.get("demo", "cmp-0001");
    expect(complaint?.status).toBe("HUMAN_REVIEW");
    expect(complaint?.handoff?.reason).toBe("EMAIL_UNDELIVERABLE");
    expect(kit.gate.requests).toEqual([]);
  });

  it("audits a complaint of the address once", async () => {
    const kit = await workerKit();
    const effects = effectsOf(kit);
    await effects.suppressEmail({ worldId: "demo", customerId: CUSTOMER });
    await effects.suppressEmail({ worldId: "demo", customerId: CUSTOMER });
    expect(await kit.audited("EMAIL_SUPPRESSED")).toHaveLength(1);
  });

  it("writes no delivery proof for a mail that is not the complaint's written answer", async () => {
    const kit = await workerKit();
    await kit.addComplaint({ status: "ANSWERED", answer: { messageId: "msg-answer", mailId: "mail-other", deliveryProof: "SENT" } });
    await effectsOf(kit).appendDeliveryProof({ worldId: "demo", epoch: 1, complaintId: "cmp-0001", mailId: "mail-0001", atSim: "2026-10-07T10:20:00-03:00" });
    expect(await kit.connector.chains.listRegisterByComplaint("demo", 1, "R-2026-000001")).toEqual([]);
  });

  it("keeps one retry of a transiently bounced email: the same content, already checked, under a new message id", async () => {
    const kit = await workerKit();
    await kit.connector.conversations.putMessage(message("demo", { messageId: "msg-ack", customerId: CUSTOMER, direction: "OUT", channel: "EMAIL", kind: "ACK_EMAIL", sender: "SYSTEM", body: "Recibimos tu reclamo.", status: "SENT" }));
    await kit.connector.emails.put(email("demo", { mailId: "mail-0001", messageId: "msg-ack", complaintId: "cmp-0001" }));
    const effects = effectsOf(kit);
    const retry = { worldId: "demo", customerId: CUSTOMER, complaintId: "cmp-0001", mailId: "mail-0001", dueAtSim: "2026-10-07T11:10:00-03:00" };
    await effects.scheduleRetry(retry);
    await effects.scheduleRetry(retry);
    const timer = await kit.connector.timers.get({ worldId: "demo", kind: "DEFERRED_SEND", timerId: "mail-0001-RETRY" });
    expect(timer).toMatchObject({ status: "SCHEDULED", dueAtSim: retry.dueAtSim, ownerKey: "MAIL#mail-0001" });
    const kept = timer?.payload["request"] as unknown as OutboundRequest;
    expect(kept).toMatchObject({ channel: "EMAIL", kind: "ACK_EMAIL", sender: "SYSTEM", text: "Recibimos tu reclamo.", messageId: "msg-ack-retry" });
    expect(contentWasChecked({ ...kept, refs: { ...kept.refs, deferredTimerId: "mail-0001-RETRY" } })).toBe(true);
  });
});

describe("an operator's written answer", () => {
  it("is refused, audited and never sent when the customer did not accept the email channel", async () => {
    const kit = await workerKit();
    const complaint = await kit.addComplaint({ status: "RESOLVED" });
    const answer = stageWrittenAnswer({ data: kit.connector, core: notReached, gate: kit.gate.gate, complaints: () => kit.complaints, documents: notReached });
    const event = CustomerEvent.parse(eventOf("OPERATOR_ANSWER", { staffId: "stf-operator", messageId: "msg-ans-1", complaintId: "cmp-0001", outcome: "IN_FAVOUR", draftBody: "Imputamos el pago." })) as EventOf<"OPERATOR_ANSWER">;
    await answer({ event, complaint, actor: "OPERATOR:stf-operator" }, contextOf(kit));
    expect(kit.gate.requests).toEqual([]);
    expect((await kit.audited("OPERATOR_EVENT_REFUSED"))[0]?.outcome).toBe("EMAIL_NOT_ACCEPTED");
    expect((await kit.connector.complaints.get("demo", "cmp-0001"))?.answer).toBeUndefined();
  });
});

describe("the Lambda entry", () => {
  it("reads nothing when it is imported", async () => {
    const entry = await import("../../handlers/event-worker");
    expect(typeof entry.handler).toBe("function");
  });
});
