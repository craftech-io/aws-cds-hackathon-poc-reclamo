// Local flows of early payoff, account closure and contact data (docs/flows-catalog.md area G, FL-052
// to FL-055): the quote is computed by the core and the agent only informs it (informing is not asking
// for the payment), the closure starts only after the customer taps its confirmation, and a change of
// contact data is registered and confirmed to the address on file; a phone change goes to a person.
import { describe, expect, it, vi } from "vitest";
import type { Complaint } from "@reclamo/bff/domain/complaint";
import { EMAIL_TEXT } from "@reclamo/bff/copy/index";
import { type CallResult, type PlanSource, type PlannedCall, outputOf } from "./support/scripted-harness";
import { answerChallenge, askChallenge, needsChallenge, repliesToChallenge, verifyWritten } from "./support/challenge";
import { type FlowWorld, createFlowWorld } from "./support/world";

vi.setConfig({ testTimeout: 60_000 });

const PAYOFF = "¿Cuánto tengo que pagar para saldar todo hoy?";
const CLOSURE = "Quiero dar de baja la cuenta";
const ADDRESS = "Me mudé y quiero cambiar el domicilio";
const ANSWER = "Te enviamos la respuesta a tu pedido sobre tu cuenta.";


const errorOf = (call: CallResult | undefined) => (call?.answer.kind === "RESULT" && !call.answer.response.ok ? call.answer.response.error : undefined);
const operations: PlannedCall = { tool: "list_operations" };
const reply = (text: string): PlannedCall => ({ tool: "send_whatsapp", input: { kind: "REPLY", text } });

/** What the customer writes once the email is accepted: the turn where the agent identifies and investigates. */
const REVIEW = "¿Lo pueden revisar?";

/** On `REVIEW` the agent asks the challenge (or, already identified, plays `investigate`); on the customer's answer it verifies it and plays `investigate`; on the event types of `then`, those calls. */
function agent(investigate: readonly PlannedCall[], then: Partial<Record<string, readonly PlannedCall[]>> = {}): PlanSource {
  return (turn) => {
    if (turn.event.type !== "CUSTOMER_MESSAGE") return then[turn.event.type] ?? [];
    if (turn.inbound === REVIEW) return needsChallenge(turn) ? [askChallenge] : [operations, ...investigate];
    if (!repliesToChallenge(turn)) return [reply("Gracias, lo reviso.")];
    return [verifyWritten, operations, ...investigate];
  };
}

/** The complaint filed with its number, the email accepted and the customer asking to review it. */
async function complain(world: FlowWorld, customerId: string, text = PAYOFF): Promise<Complaint> {
  await world.phone(customerId, { type: "text", text });
  await world.tap(customerId, "ACCEPT_EMAIL");
  const complaint = (await world.connector.complaints.listByCustomer("demo", customerId)).find((candidate) => candidate.origin === "LIVE");
  if (complaint === undefined) throw new Error("the complaint was not filed");
  await world.phone(customerId, { type: "text", text: REVIEW });
  await answerChallenge(world, customerId);
  return complaint;
}

async function current(world: FlowWorld, complaint: Complaint): Promise<Complaint | undefined> {
  return world.connector.complaints.get("demo", complaint.complaintId);
}

function coreRow(world: FlowWorld, customerId: string, entity: string): Record<string, unknown> | undefined {
  return world.mocks.coreStore.dump().find((item) => item.pk === `W#demo#CUS#${customerId}` && item.entity === entity);
}

const resolve = (outcome: string): PlannedCall => ({ tool: "update_complaint", input: { status: "RESOLVED", outcome } });
const answer = (outcome: string): PlannedCall => ({ tool: "answer_complaint_in_writing", input: { outcome, draftBody: ANSWER } });

describe("[FL-052] early payoff: a quote by code", () => {
  it("[FL-052] quote_early_payoff leaves the quote in the core; the reply's amounts are the quote's and informing is not asking for the payment; the quote goes in writing", async () => {
    const world = await createFlowWorld();
    world.harness.script(
      agent([
        { tool: "get_account" },
        { tool: "quote_early_payoff", input: { loanId: "L-0036" } },
        { tool: "send_whatsapp", input: (earlier) => ({ kind: "REPLY", text: `Para cancelar hoy el préstamo el total es ${String((outputOf(earlier.at(-1)).total as { text: string }).text)}, válido hasta ${String(outputOf(earlier.at(-1)).validUntilText)}.` }) },
        resolve("INFORMATIONAL"),
        answer("INFORMATIONAL"),
      ]),
    );
    const complaint = await complain(world, "cus-0036");
    const quote = outputOf(world.harness.results.find((call) => call.tool === "quote_early_payoff"));
    expect(world.mocks.coreStore.dump().filter((item) => item.entity === "PayoffQuote" && item.quoteId === quote.quoteId)).toHaveLength(1);
    const sent = outputOf(world.harness.results.find((call) => call.tool === "send_whatsapp" && String(call.input.text).includes("total")));
    const allowed = (await world.connector.chains.listTapeByMessage(String(sent.messageId))).find((entry) => entry.decision === "ALLOWED");
    expect(allowed?.evaluated).toEqual(expect.arrayContaining([{ ruleId: "CH-WA-NO-PAYMENT-REQUEST", result: "PASS" }]));
    expect(outputOf(world.harness.results.find((call) => call.tool === "update_complaint"))).toMatchObject({ status: "RESOLVED" });
    expect(await current(world, complaint)).toMatchObject({ status: "ANSWERED", outcome: "INFORMATIONAL" });
  });
});

describe("[FL-053] closing the account", () => {
  it("[FL-053] only after the confirmation tap: CLOSING with the active-loan condition, the closure confirmation by email, no offer, and the written answer", async () => {
    const world = await createFlowWorld();
    const confirm = { tool: "send_whatsapp", input: { kind: "REPLY", text: "¿Confirmás la baja de tu cuenta?", buttons: [{ action: "CONFIRM_CLOSURE" }] } } as const;
    world.harness.script(agent([{ tool: "request_account_closure" }, { tool: "request_account_closure", input: { confirmNonce: "01M4B7RD18000000000000000" } }, confirm]));
    const complaint = await complain(world, "cus-0036", CLOSURE);
    const refused = world.harness.results.filter((call) => call.tool === "request_account_closure");
    expect(refused.map((call) => errorOf(call)?.code)).toEqual(["EVIDENCE_REQUIRED", expect.any(String)]);
    // The tap reaches the turn as a fact (`inbound button="CONFIRM_CLOSURE"`), and the tool finds its nonce by code.
    world.harness.script((turn) => (turn.event.type === "CUSTOMER_MESSAGE" && turn.facts.some((fact) => fact.name === "inbound" && fact.attributes["button"] === "CONFIRM_CLOSURE") ? [{ tool: "request_account_closure" }, resolve("IN_FAVOUR"), answer("IN_FAVOUR")] : []));
    await world.tap("cus-0036", "CONFIRM_CLOSURE");
    expect(outputOf(world.harness.results.filter((call) => call.tool === "request_account_closure").at(-1))).toMatchObject({ accountStatusAfter: "CLOSING", conditionsText: expect.arrayContaining([EMAIL_TEXT.CLOSURE_ACTIVE_LOAN]) });
    expect(coreRow(world, "cus-0036", "Account")?.status).toBe("CLOSING");
    const out = (await world.connector.conversations.listMessages("demo", "cus-0036")).filter((message) => message.direction === "OUT");
    for (const message of out.filter((candidate) => candidate.sender === "AGENT")) {
      const allowed = (await world.connector.chains.listTapeByMessage(message.messageId)).find((entry) => entry.decision === "ALLOWED");
      expect(allowed?.evaluated).toEqual(expect.arrayContaining([{ ruleId: "CH-NO-CREDIT-OFFER", result: "PASS" }]));
    }
    expect(await current(world, complaint)).toMatchObject({ status: "ANSWERED", outcome: "IN_FAVOUR" });
    expect(out.map((message) => message.kind)).toContain("CLOSURE_CONFIRMATION");
  });
});

describe("[FL-054] a change of email or address", () => {
  it("[FL-054] request_data_change takes the value from the customer's message of the turn (by code), stays PENDING_CONFIRMATION and is confirmed to the address on file only", async () => {
    const world = await createFlowWorld();
    world.harness.script(async (turn) =>
      turn.inbound?.startsWith("Mi nuevo domicilio") === true ? [{ tool: "request_data_change", input: { field: "ADDRESS" } }] : turn.event.type === "CUSTOMER_MESSAGE" && turn.inbound === REVIEW ? [askChallenge] : repliesToChallenge(turn) ? [verifyWritten, reply("¿Cuál es el domicilio nuevo?")] : [reply("Gracias.")],
    );
    const complaint = await complain(world, "cus-0037", ADDRESS);
    await world.phone("cus-0037", { type: "text", text: "Mi nuevo domicilio es Calle de los Tilos 220, Ciudad Ficticia" });
    const changed = outputOf(world.harness.results.find((call) => call.tool === "request_data_change"));
    expect(changed).toMatchObject({ status: "PENDING_CONFIRMATION", confirmationSentTo: "s***@simulator.amazonses.com" });
    const meta = coreRow(world, "cus-0037", "Customer");
    expect(meta?.address).toBe("Pasaje de los Ceibos 1469, Ciudad Ficticia");
    expect((await world.connector.caseItems.listActions("demo", complaint.complaintId)).map((action) => action.status)).toEqual(["PENDING_CONFIRMATION"]);
    const confirmation = world.stage.emails.find((email) => email.input.EmailTags?.some((tag) => tag.Value === "DATA_CHANGE_CONFIRMATION"));
    expect(confirmation?.input.Destination?.ToAddresses).toEqual([expect.stringMatching(/^success\+.*@simulator\.amazonses\.com$/)]);
  });
});

describe("[FL-055] a change of phone: a person", () => {
  it("[FL-055] PHONE needs no message and is REFERRED: no change of the phone and the complaint to HUMAN_REVIEW with RISKY_DATA_CHANGE", async () => {
    const world = await createFlowWorld();
    world.harness.script((turn) => (turn.inbound === REVIEW ? [askChallenge] : repliesToChallenge(turn) ? [verifyWritten, { tool: "request_data_change", input: { field: "PHONE" } }] : [reply("Gracias.")]));
    const phoneBefore = coreRow(world, "cus-0037", "Customer")?.phoneE164;
    const complaint = await complain(world, "cus-0037", "Cambié de número de teléfono");
    expect(outputOf(world.harness.results.find((call) => call.tool === "request_data_change"))).toMatchObject({ status: "REFERRED" });
    expect(coreRow(world, "cus-0037", "Customer")?.phoneE164).toBe(phoneBefore);
    expect(await current(world, complaint)).toMatchObject({ status: "HUMAN_REVIEW", handoff: { reason: "RISKY_DATA_CHANGE" } });
  });
});
