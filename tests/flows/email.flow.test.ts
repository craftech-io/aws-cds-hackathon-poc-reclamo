// Local flows of email and its proof (docs/flows-catalog.md areas B and L, FL-011, FL-090, FL-091): the
// consent to the email channel by the acknowledgement's button, the acknowledgement email with its PDF
// through the real email client (MIME recorded as SES would get it, to the simulator's mailbox only),
// SES events shaped as the configuration set's rule delivers them, the delivery proof on the register,
// and a bounce sending the complaint to a person with the template that says the answer did not arrive.
import { describe, expect, it, vi } from "vitest";
import type { SentEmail } from "./support/stage/context";
import { type PlannedCall } from "./support/scripted-harness";
import { answerChallenge, askChallenge, repliesToChallenge, verifyWritten } from "./support/challenge";
import { type FlowWorld, createFlowWorld } from "./support/world";

vi.setConfig({ testTimeout: 60_000 });

const C01 = "cus-0001";
const PAYMENT_NOT_REFLECTED = "Pagué la cuota en la red de cobro y en la app sigue como impaga";
const reply = (text: string): PlannedCall => ({ tool: "send_whatsapp", input: { kind: "REPLY", text } });


const tagged = (world: FlowWorld, kind: string): SentEmail[] => world.stage.emails.filter((email) => email.input.EmailTags?.some((tag) => tag.Name === "kind" && tag.Value === kind));
const rawOf = (email: SentEmail | undefined) => Buffer.from(email?.input.Content?.Raw?.Data ?? new Uint8Array()).toString("utf8");

async function mailRecord(world: FlowWorld, providerMessageId: string | undefined) {
  return (await world.connector.emails.listWorld("demo")).emails.find((email) => email.providerMessageId === providerMessageId);
}

describe("[FL-011] accepting the email and the acknowledgement by email", () => {
  it("[FL-011] the button records the consent with its version and address hash; the ACK email with its PDF goes to the simulator, its .eml is kept and the delivery is the proof", async () => {
    const world = await createFlowWorld({ plans: () => [reply("Lo reviso.")] });
    await world.phone(C01, { type: "text", text: PAYMENT_NOT_REFLECTED });
    await world.tap(C01, "ACCEPT_EMAIL");
    const complaint = await world.connector.complaints.getByNumber("demo", "R-2026-000123");
    expect(complaint?.emailAnswerConsent).toMatchObject({ status: "ACCEPTED", atSim: expect.any(String), textVersion: "email-answer-v1" });
    const [ack] = tagged(world, "ACK_EMAIL");
    expect(ack?.input.Destination?.ToAddresses).toEqual([expect.stringMatching(/^success\+.*@simulator\.amazonses\.com$/)]);
    expect(rawOf(ack)).toMatch(/application\/pdf/);
    expect(rawOf(ack)).toContain("R-2026-000123");
    const record = await mailRecord(world, ack?.providerMessageId);
    expect(world.s3.keys("Emails").length).toBeGreaterThan(0);
    expect(record).toMatchObject({ kind: "ACK_EMAIL" });
    await world.sesEvent(ack as SentEmail, "Delivery");
    expect(await mailRecord(world, ack?.providerMessageId)).toMatchObject({ deliveryProof: "DELIVERED" });
  });

  it("[FL-011] \"another channel\" leaves the consent DECLINED and a human task for the formal channel", async () => {
    const world = await createFlowWorld({ plans: () => [reply("Lo reviso.")] });
    await world.phone(C01, { type: "text", text: PAYMENT_NOT_REFLECTED });
    await world.tap(C01, "DECLINE_EMAIL");
    const complaint = await world.connector.complaints.getByNumber("demo", "R-2026-000123");
    expect(complaint?.emailAnswerConsent.status).toBe("DECLINED");
    expect((await world.connector.caseItems.listNotes("demo", complaint?.complaintId ?? "")).some((note) => note.task?.status === "OPEN")).toBe(true);
    expect(tagged(world, "ACK_EMAIL")).toEqual([]);
  });
});

describe("[FL-090] the delivery proof", () => {
  it("[FL-090] SEND then DELIVERY are both kept; the pending mail closes with DELIVERY, not SEND; the written answer's proof lands on the register; an event without its record is refused", async () => {
    const world = await createFlowWorld();
    world.harness.script((turn) =>
      turn.inbound === "¿Lo pueden revisar?"
        ? [askChallenge]
        : repliesToChallenge(turn)
        ? [
            verifyWritten,
            { tool: "list_operations" },
            { tool: "get_transfer_status", input: { transferId: "trf-0027-1" } },
            { tool: "update_complaint", input: { status: "RESOLVED", outcome: "INFORMATIONAL" } },
            { tool: "answer_complaint_in_writing", input: { outcome: "INFORMATIONAL", draftBody: "Revisamos con la red el estado de la transferencia que nos consultaste." } },
          ]
        : [reply("Recibí tu reclamo.")],
    );
    await world.phone("cus-0027", { type: "text", text: "Hice una transferencia y no le llegó a la otra persona" });
    await world.tap("cus-0027", "ACCEPT_EMAIL");
    await world.phone("cus-0027", { type: "text", text: "¿Lo pueden revisar?" });
    await answerChallenge(world, "cus-0027");
    const [answer] = tagged(world, "FORMAL_ANSWER");
    expect(answer).toBeDefined();
    const pendingOf = async () => (await world.connector.runtime.listPending("demo")).filter((pending) => pending.kind === "MAIL" && pending.pendingId === sentRecord?.mailId);
    const sentRecord = await mailRecord(world, answer?.providerMessageId);
    await world.sesEvent(answer as SentEmail, "Send");
    expect(await pendingOf()).toHaveLength(1);
    await world.sesEvent(answer as SentEmail, "Delivery");
    const record = await mailRecord(world, answer?.providerMessageId);
    expect(record?.events.map((event) => event.type)).toEqual(expect.arrayContaining(["SEND", "DELIVERY"]));
    expect(record?.deliveryProof).toBe("DELIVERED");
    expect(await pendingOf()).toEqual([]);
    const complaint = await world.connector.complaints.getByNumber("demo", "R-2026-000123");
    expect((await world.connector.chains.listRegisterByComplaint("demo", 1, "R-2026-000123")).map((entry) => entry.eventType)).toContain("DELIVERY_PROOF");
    expect(complaint?.answer?.deliveryProof).toBe("DELIVERED");

    const fabricated = await world.sesEvent({ input: { ...(answer as SentEmail).input }, providerMessageId: "0100019a-not-sent-by-this-world" }, "Delivery");
    expect(fabricated.outcome).not.toBe("ENQUEUED");
  });
});

describe("[FL-091] a bounced email", () => {
  it("[FL-091] the written answer to bounce+ bounces: BOUNCED, a person (EMAIL_UNDELIVERABLE) and the template that says the answer did not arrive", async () => {
    const world = await createFlowWorld();
    world.harness.script((turn) =>
      turn.inbound === "¿Lo pueden revisar?"
        ? [askChallenge]
        : repliesToChallenge(turn)
        ? [
            verifyWritten,
            { tool: "get_disbursement" },
            { tool: "update_complaint", input: { status: "RESOLVED", outcome: "INFORMATIONAL" } },
            { tool: "answer_complaint_in_writing", input: { outcome: "INFORMATIONAL", draftBody: "Revisamos el desembolso de tu préstamo con la información de tu cuenta." } },
          ]
        : [reply("Recibí tu reclamo.")],
    );
    await world.phone("cus-0039", { type: "text", text: "Me aprobaron el préstamo y no me depositaron la plata" });
    await world.tap("cus-0039", "ACCEPT_EMAIL");
    await world.phone("cus-0039", { type: "text", text: "¿Lo pueden revisar?" });
    await answerChallenge(world, "cus-0039");
    const [answer] = tagged(world, "FORMAL_ANSWER");
    expect(answer?.input.Destination?.ToAddresses).toEqual([expect.stringMatching(/^bounce\+.*@simulator\.amazonses\.com$/)]);
    await world.sesEvent(answer as SentEmail, "Bounce");
    expect(await mailRecord(world, answer?.providerMessageId)).toMatchObject({ deliveryProof: "BOUNCED" });
    const complaint = (await world.connector.complaints.listByCustomer("demo", "cus-0039")).find((candidate) => candidate.origin === "LIVE");
    expect(complaint).toMatchObject({ status: "HUMAN_REVIEW", handoff: { reason: "EMAIL_UNDELIVERABLE" } });
    expect((await world.connector.conversations.listMessages("demo", "cus-0039")).some((message) => message.templateName === "reclamo_respuesta_no_entregada")).toBe(true);
  });
});
