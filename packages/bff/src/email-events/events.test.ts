// SES events end to end without AWS: `EmailEvents` admits only events of this account, this
// configuration set and an `EmailRecord` it really sent (FL-090), discards tombstoned worlds, and only
// enqueues; the worker's `record_email_event` turns them into the delivery proof, the register's
// `DELIVERY_PROOF`, the pending mail closed by the terminal event, and the effects of a bounce (FL-091)
// and of a complaint (FL-092).
import { describe, expect, it } from "vitest";
import type { Connector } from "../connector/port";
import { complaint, testConnector } from "../connector/testing";
import { createLogger } from "../lib/log";
import { TEST_CONFIGURATION_SET, TEST_MAIL_ID, TEST_PROVIDER_ID } from "../channels/email/testing";
import { type AdmitDeps, admitSesEvent, emailEventId } from "./admit";
import { type ApplyDeps, type EmailEventEffects, applyEmailEvent, nextProof } from "./apply";
import { type EmailEventMessage, type EmailEventPayload, parseSesEvent } from "./schema";
import { SENT_AT_SIM, TEST_ACCOUNT, seedSentEmail, sesEvent } from "./testing";

const REF = { worldId: "g01", customerId: "cus-0001", sentAtSim: SENT_AT_SIM, mailId: TEST_MAIL_ID };
const SIM_NOW = "2026-10-08T09:00:00.000Z";

function admission(connector: Connector) {
  const queued: EmailEventMessage[] = [];
  const deps: AdmitDeps = {
    connector,
    enqueue: async (message) => void queued.push(message),
    expected: { account: TEST_ACCOUNT, configurationSet: TEST_CONFIGURATION_SET },
    now: () => new Date("2026-10-07T13:10:06.000Z"),
    log: createLogger({ sink: () => undefined }),
  };
  return { deps, queued };
}

function worker(connector: Connector) {
  const calls: Array<[keyof EmailEventEffects, unknown]> = [];
  const effects: EmailEventEffects = {
    appendDeliveryProof: async (input) => void calls.push(["appendDeliveryProof", input]),
    handOffUndeliverable: async (input) => void calls.push(["handOffUndeliverable", input]),
    suppressEmail: async (input) => void calls.push(["suppressEmail", input]),
    scheduleRetry: async (input) => void calls.push(["scheduleRetry", input]),
  };
  const lines: string[] = [];
  const deps: ApplyDeps = { connector, effects, simNow: async () => new Date(SIM_NOW), now: () => new Date("2026-10-07T13:10:07.000Z"), log: createLogger({ sink: (line) => void lines.push(line) }) };
  return { deps, calls, lines };
}

/** Admits one event and returns the payload the worker would receive. */
async function admitted(connector: Connector, event: Record<string, unknown>): Promise<EmailEventPayload> {
  const { deps, queued } = admission(connector);
  expect(await admitSesEvent(event, deps)).toMatchObject({ outcome: "ENQUEUED" });
  const message = queued[0];
  if (message === undefined) throw new Error("nothing was enqueued");
  return message.payload;
}

describe("EmailEvents admits only real events of emails it sent [FL-090]", () => {
  it("enqueues one EMAIL_EVENT with ids only, keyed to the SES event", async () => {
    const { connector } = testConnector();
    await seedSentEmail(connector);
    const { deps, queued } = admission(connector);
    const outcome = await admitSesEvent(sesEvent("Email Delivered"), deps);
    expect(outcome).toEqual({ outcome: "ENQUEUED", eventId: emailEventId({ providerMessageId: TEST_PROVIDER_ID, type: "DELIVERY", occurredAtReal: "2026-10-07T13:10:05.000Z" }) });
    expect(queued).toEqual([
      {
        type: "EMAIL_EVENT",
        eventId: expect.stringMatching(/^ses-[0-9a-f]{32}$/),
        worldId: "g01",
        customerId: "cus-0001",
        payload: { worldId: "g01", epoch: 1, customerId: "cus-0001", complaintId: "cmp-0001", mailId: TEST_MAIL_ID, sentAtSim: SENT_AT_SIM, providerMessageId: TEST_PROVIDER_ID, type: "DELIVERY", occurredAtReal: "2026-10-07T13:10:05.000Z", smtpResponse: "250 2.6.0 Message received" },
      },
    ]);
    expect(JSON.stringify(queued)).not.toContain("simulator.amazonses.com");
    // Admission changes nothing itself: the proof and the pending mail wait for the worker.
    expect((await connector.emails.get(REF))?.events).toEqual([]);
    expect(await connector.runtime.listPending("g01")).toHaveLength(1);
  });

  it.each([
    ["another account", sesEvent("Email Delivered", { account: "111122223333" }), "WRONG_ACCOUNT"],
    ["another configuration set", sesEvent("Email Delivered", { configurationSet: "other-app-email-poc" }), "WRONG_CONFIGURATION_SET"],
    ["no world tag", sesEvent("Email Delivered", { tags: { "ses:configuration-set": [TEST_CONFIGURATION_SET], mailId: [TEST_MAIL_ID] } }), "MISSING_TAGS"],
    ["an email we never sent", sesEvent("Email Delivered", { providerMessageId: "0100-fabricated-0001" }), "UNKNOWN_MAIL"],
    ["tags of another world", sesEvent("Email Delivered", { worldId: "g02" }), "MAIL_MISMATCH"],
    ["tags of another mail", sesEvent("Email Delivered", { mailId: "01JZ0000000000000000000077" }), "MAIL_MISMATCH"],
    ["an event type the app does not publish", sesEvent("Email Opened"), "UNSUPPORTED_TYPE"],
    ["another source", sesEvent("Email Delivered", { source: "aws.sns" }), "INVALID_EVENT"],
  ])("rejects %s without enqueuing", async (_label, event, reason) => {
    const { connector } = testConnector();
    await seedSentEmail(connector);
    const { deps, queued } = admission(connector);
    expect(await admitSesEvent(event, deps)).toEqual({ outcome: "REJECTED", reason });
    expect(queued).toEqual([]);
  });

  it("audits a rejection of a named world with ids only", async () => {
    const { connector } = testConnector();
    await seedSentEmail(connector);
    const { deps } = admission(connector);
    await admitSesEvent(sesEvent("Email Delivered", { providerMessageId: "0100-fabricated-0001" }), deps);
    const [entry] = await connector.audit.listByAction("g01", "EMAIL_EVENT_REJECTED");
    expect(entry).toMatchObject({ action: "EMAIL_EVENT_REJECTED", outcome: "UNKNOWN_MAIL", refs: { mailId: TEST_MAIL_ID }, actor: "SYSTEM" });
  });

  it("discards and audits an event of a tombstoned epoch, without retry", async () => {
    const { connector } = testConnector();
    await seedSentEmail(connector);
    await connector.write(connector.runtime.putTombstoneOp({ worldId: "g01", epoch: 1, reason: "RESET", atReal: "2026-10-07T13:10:04.000Z" }));
    const { deps, queued } = admission(connector);
    expect(await admitSesEvent(sesEvent("Email Delivered"), deps)).toEqual({ outcome: "TOMBSTONED" });
    expect(queued).toEqual([]);
    expect(await connector.audit.listByAction("g01", "TOMBSTONED_EVENT")).toHaveLength(1);
  });

  it("retries an event that beat the write of its SES id, and rejects it once nothing is pending", async () => {
    const { connector } = testConnector();
    await seedSentEmail(connector, {}, { recorded: false });
    const { deps } = admission(connector);
    await expect(admitSesEvent(sesEvent("Email Sent"), deps)).rejects.toMatchObject({ code: "UNAVAILABLE", retryable: true });
    await connector.write(connector.runtime.closePendingOp("g01", "MAIL", TEST_MAIL_ID));
    expect(await admitSesEvent(sesEvent("Email Sent"), deps)).toEqual({ outcome: "REJECTED", reason: "UNKNOWN_MAIL" });
  });

  it("parses the bounce type and drops recipients", () => {
    const parsed = parseSesEvent(sesEvent("Email Bounced", { bounceType: "Transient" }));
    expect(parsed).toMatchObject({ ok: true, event: { type: "BOUNCE", bounceType: "Transient", providerMessageId: TEST_PROVIDER_ID } });
    expect(JSON.stringify(parsed)).not.toContain("success+g01");
  });
});

describe("record_email_event: delivery proof [FL-090]", () => {
  it("SEND keeps the pending mail open; DELIVERY proves, closes it and writes DELIVERY_PROOF for a written answer", async () => {
    const { connector } = testConnector();
    await seedSentEmail(connector);
    const { deps, calls } = worker(connector);
    expect(await applyEmailEvent(await admitted(connector, sesEvent("Email Sent", { time: "2026-10-07T13:10:01.000Z" })), deps)).toMatchObject({ outcome: "APPLIED", closedPending: false, registerProof: false });
    expect(await connector.runtime.listPending("g01")).toHaveLength(1);

    const result = await applyEmailEvent(await admitted(connector, sesEvent("Email Delivered")), deps);
    expect(result).toEqual({ outcome: "APPLIED", deliveryProof: "DELIVERED", closedPending: true, registerProof: true, alarm: false });
    expect(await connector.runtime.listPending("g01")).toEqual([]);
    const record = await connector.emails.get(REF);
    expect(record?.deliveryProof).toBe("DELIVERED");
    expect(record?.events.map((event) => event.type)).toEqual(["SEND", "DELIVERY"]);
    expect(calls).toEqual([["appendDeliveryProof", { worldId: "g01", epoch: 1, complaintId: "cmp-0001", mailId: TEST_MAIL_ID, atSim: SIM_NOW }]]);
    expect(await connector.audit.listByAction("g01", "EMAIL_EVENT")).toHaveLength(2);
  });

  it("writes no DELIVERY_PROOF for an acknowledgement and changes nothing on a redelivery", async () => {
    const { connector } = testConnector();
    await seedSentEmail(connector, { kind: "ACK_EMAIL" });
    const { deps, calls } = worker(connector);
    const payload = await admitted(connector, sesEvent("Email Delivered"));
    expect(await applyEmailEvent(payload, deps)).toMatchObject({ registerProof: false, deliveryProof: "DELIVERED" });
    expect(await applyEmailEvent(payload, deps)).toEqual({ outcome: "DUPLICATE" });
    expect((await connector.emails.get(REF))?.events).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it("ignores an event of an email the reset wiped", async () => {
    const { connector } = testConnector();
    await seedSentEmail(connector);
    const payload = await admitted(connector, sesEvent("Email Delivered"));
    const empty = testConnector().connector;
    expect(await applyEmailEvent(payload, worker(empty).deps)).toEqual({ outcome: "MISSING" });
  });

  it("never moves a proof back", () => {
    const base = { worldId: "g01", epoch: 1, customerId: "cus-0001", mailId: TEST_MAIL_ID, sentAtSim: SENT_AT_SIM, providerMessageId: TEST_PROVIDER_ID, occurredAtReal: "2026-10-07T13:10:05.000Z" } as const;
    expect(nextProof("DELIVERED", { ...base, type: "SEND" })).toBeUndefined();
    expect(nextProof("BOUNCED", { ...base, type: "DELIVERY" })).toBeUndefined();
    expect(nextProof("DELIVERED", { ...base, type: "COMPLAINT" })).toBe("COMPLAINED");
    expect(nextProof("SENT", { ...base, type: "REJECT" })).toBe("REJECTED");
    expect(nextProof("SENT", { ...base, type: "BOUNCE", bounceType: "Undetermined" })).toBe("BOUNCED");
  });
});

describe("record_email_event: bounce [FL-091]", () => {
  it("a permanent bounce proves BOUNCED, closes the pending mail, hands the complaint to a person and asks for the WhatsApp notice", async () => {
    const { connector } = testConnector();
    await connector.transact([connector.complaints.createOp(complaint("g01", { status: "ANSWERED" }))]);
    await seedSentEmail(connector);
    const { deps, calls } = worker(connector);
    const result = await applyEmailEvent(await admitted(connector, sesEvent("Email Bounced", { bounceType: "Permanent" })), deps);
    expect(result).toEqual({
      outcome: "APPLIED",
      deliveryProof: "BOUNCED",
      closedPending: true,
      registerProof: false,
      alarm: false,
      notify: { kind: "COMPLAINT_UPDATE", channel: "WHATSAPP", template: "reclamo_respuesta_no_entregada", params: ["R-2026-000123"], worldId: "g01", customerId: "cus-0001", complaintId: "cmp-0001" },
    });
    expect(calls).toEqual([["handOffUndeliverable", { worldId: "g01", complaintId: "cmp-0001", atSim: SIM_NOW, cause: "BOUNCE" }]]);
    expect(await connector.runtime.listPending("g01")).toEqual([]);
    // A delivery reported later for the same email never turns a bounce into a proof of delivery.
    expect(await applyEmailEvent(await admitted(connector, sesEvent("Email Delivered", { time: "2026-10-07T13:20:00.000Z" })), deps)).toMatchObject({ registerProof: false });
    expect((await connector.emails.get(REF))?.deliveryProof).toBe("BOUNCED");
  });

  it("a transient bounce or a delay keeps the pending mail open and schedules one retry an hour later", async () => {
    const { connector } = testConnector();
    await seedSentEmail(connector);
    const { deps, calls } = worker(connector);
    const first = await applyEmailEvent(await admitted(connector, sesEvent("Email Bounced", { bounceType: "Transient" })), deps);
    expect(first).toEqual({ outcome: "APPLIED", closedPending: false, registerProof: false, alarm: false, retryAtSim: "2026-10-08T10:00:00.000Z" });
    await applyEmailEvent(await admitted(connector, sesEvent("Email Delivery Delayed", { time: "2026-10-07T13:40:00.000Z" })), deps);
    expect(calls).toEqual([["scheduleRetry", { worldId: "g01", customerId: "cus-0001", complaintId: "cmp-0001", mailId: TEST_MAIL_ID, dueAtSim: "2026-10-08T10:00:00.000Z" }]]);
    expect(await connector.runtime.listPending("g01")).toHaveLength(1);
    expect((await connector.emails.get(REF))?.deliveryProof).toBe("SENT");
  });
});

describe("record_email_event: complaint, rejection and rendering failure [FL-092]", () => {
  it("a complaint proves COMPLAINED, suppresses the customer's email and opens a human case", async () => {
    const { connector } = testConnector();
    await seedSentEmail(connector);
    const { deps, calls } = worker(connector);
    await applyEmailEvent(await admitted(connector, sesEvent("Email Delivered")), deps);
    const result = await applyEmailEvent(await admitted(connector, sesEvent("Email Complaint Received", { time: "2026-10-07T14:00:00.000Z" })), deps);
    expect(result).toMatchObject({ outcome: "APPLIED", deliveryProof: "COMPLAINED", closedPending: true });
    expect(calls.slice(1)).toEqual([
      ["suppressEmail", { worldId: "g01", customerId: "cus-0001" }],
      ["handOffUndeliverable", { worldId: "g01", complaintId: "cmp-0001", atSim: SIM_NOW, cause: "COMPLAINT" }],
    ]);
  });

  it.each([["Email Rejected"], ["Email Rendering Failed"]] as const)("%s proves REJECTED, closes the pending mail and raises the alarm line", async (detailType) => {
    const { connector } = testConnector();
    await seedSentEmail(connector);
    const { deps, lines } = worker(connector);
    expect(await applyEmailEvent(await admitted(connector, sesEvent(detailType)), deps)).toMatchObject({ deliveryProof: "REJECTED", closedPending: true, alarm: true });
    expect(lines.some((line) => line.includes('"email.failed"'))).toBe(true);
    expect(await connector.runtime.listPending("g01")).toEqual([]);
  });
});
