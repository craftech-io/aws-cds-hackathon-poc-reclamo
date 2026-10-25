// Local flows of WhatsApp consent (docs/flows-catalog.md FL-006, FL-007 and FL-074): the opt-out is a
// fixed, deterministic answer recorded in the core with its history, an ambiguous "baja" never closes an
// account, and the channel policy blocks a proactive WhatsApp to a customer who opted out, never opted
// in or has no open complaint, whoever sends it; a complaint update then goes by email.
import { describe, expect, it, vi } from "vitest";
import { WHATSAPP_TEXT } from "@reclamo/bff/copy/index";
import type { Message } from "@reclamo/bff/domain/conversation";
import type { TapeEntry } from "@reclamo/bff/domain/ledger";
import type { PlannedCall } from "./support/scripted-harness";
import { type FlowWorld, createFlowWorld } from "./support/world";

vi.setConfig({ testTimeout: 60_000 });

const PAYMENT_NOT_REFLECTED = "Pagué la cuota en la red de cobro y en la app sigue como impaga";
const reply = (text: string): PlannedCall => ({ tool: "send_whatsapp", input: { kind: "REPLY", text } });

async function outbound(world: FlowWorld, customerId: string): Promise<Message[]> {
  return (await world.connector.conversations.listMessages("demo", customerId)).filter((message) => message.direction === "OUT" && (message.createdAt ?? "") > "2026-10-07T13:10:00.000Z");
}

async function tapeOf(world: FlowWorld, messageId: string): Promise<TapeEntry[]> {
  return world.connector.chains.listTapeByMessage(messageId);
}

/** The operator's composer: a complaint update by WhatsApp, as `customers.compose` sends it. */
async function composeUpdate(world: FlowWorld, customerId: string, complaintId: string | undefined): Promise<string> {
  const operator = await world.console("OPERATOR");
  const queued = await operator.customers.compose({ customerId, kind: "COMPLAINT_UPDATE", channel: "WHATSAPP", text: "Hay una novedad en tu reclamo.", ...(complaintId === undefined ? {} : { complaintId }) });
  await world.settle();
  return queued.messageId;
}

/** Picks the email path the block offered (`conversation.reroute`); the child goes through the gate again. */
async function rerouteByEmail(world: FlowWorld, customerId: string, blocked: TapeEntry | undefined): Promise<TapeEntry[]> {
  const operator = await world.console("OPERATOR");
  await operator.conversation.reroute({ tapeId: blocked?.tapeId ?? "", route: "FORMAL_EMAIL", customerId });
  await world.settle();
  return world.connector.chains.listTapeByComplaint("demo", blocked?.complaintId ?? "");
}

describe("[FL-006] opt-out and an ambiguous \"baja\"", () => {
  it("[FL-006] \"baja\" alone asks which one with two buttons and closes nothing; NO RECIBIR confirms by a fixed text with no turn and records the opt-out in the core", async () => {
    const world = await createFlowWorld({ plans: () => [reply("Lo reviso.")] });
    await world.phone("cus-0001", { type: "text", text: PAYMENT_NOT_REFLECTED });
    const turns = world.harness.turns.length;
    await world.phone("cus-0001", { type: "text", text: "baja" });
    const ask = (await outbound(world, "cus-0001")).find((message) => (message.interactive as { buttons?: { action: string }[] } | undefined)?.buttons?.some((button) => button.action === "OPT_OUT") === true);
    expect((ask?.interactive as { buttons: { action: string }[] }).buttons.map((button) => button.action)).toEqual(expect.arrayContaining(["OPT_OUT", "CONFIRM_CLOSURE"]));
    expect(world.harness.turns).toHaveLength(turns);
    const account = world.mocks.coreStore.dump().find((item) => item.pk === "W#demo#CUS#cus-0001" && item.entity === "Account");
    expect(account?.status).toBe("ACTIVE");

    await world.phone("cus-0001", { type: "text", text: "NO RECIBIR" });
    const confirmation = (await outbound(world, "cus-0001")).find((message) => message.kind === "OPT_OUT_CONFIRMATION");
    expect(confirmation).toMatchObject({ kind: "OPT_OUT_CONFIRMATION", sender: "SYSTEM" });
    expect(confirmation?.body).toContain(WHATSAPP_TEXT.OPT_OUT_CONFIRMATION);
    expect(world.harness.turns).toHaveLength(turns);
    const customer = world.mocks.coreStore.dump().find((item) => item.pk === "W#demo#CUS#cus-0001" && item.entity === "Customer");
    expect(customer?.whatsapp).toMatchObject({ optedOut: true, optedOutAtSim: expect.any(String) });
  });

  it("[FL-006] a later complaint update by WhatsApp from the operator is BLOCKED CH-OPTOUT and its email reroute is ALLOWED", async () => {
    const world = await createFlowWorld({ plans: () => [reply("Lo reviso.")] });
    await world.phone("cus-0001", { type: "text", text: PAYMENT_NOT_REFLECTED });
    await world.tap("cus-0001", "ACCEPT_EMAIL");
    await world.phone("cus-0001", { type: "text", text: "STOP" });
    const complaint = await world.connector.complaints.getByNumber("demo", "R-2026-000123");
    const messageId = await composeUpdate(world, "cus-0001", complaint?.complaintId);
    const [blocked] = await tapeOf(world, messageId);
    expect(blocked).toMatchObject({ decision: "BLOCKED", ruleIds: ["CH-OPTOUT"], sender: world.staff("OPERATOR").staffId.replace(/^/, "OPERATOR:") });
    const tape = await rerouteByEmail(world, "cus-0001", blocked);
    expect(tape.some((entry) => entry.decision === "REROUTED" && entry.tapeId !== blocked?.tapeId)).toBe(true);
    expect(tape.some((entry) => entry.decision === "ALLOWED" && entry.channel === "EMAIL" && entry.kind === "COMPLAINT_UPDATE")).toBe(true);
    expect((await outbound(world, "cus-0001")).filter((message) => message.channel === "WHATSAPP" && message.kind === "COMPLAINT_UPDATE" && message.status !== "BLOCKED")).toEqual([]);
  });
});

describe("[FL-007] no WhatsApp opt-in: replies in the window, updates by email", () => {
  it("[FL-007] the agent's reply inside the window the customer opened is ALLOWED; 26 h later the operator's update is BLOCKED CH-OPTIN and goes by email", async () => {
    const world = await createFlowWorld({ plans: () => [reply("Recibí tu reclamo y lo estoy revisando.")] });
    await world.phone("cus-0038", { type: "text", text: PAYMENT_NOT_REFLECTED });
    await world.tap("cus-0038", "ACCEPT_EMAIL");
    const inWindow = (await outbound(world, "cus-0038")).find((message) => message.sender === "AGENT");
    expect((await tapeOf(world, inWindow?.messageId ?? "")).map((entry) => entry.decision)).toEqual(expect.arrayContaining(["ALLOWED", "DISPATCH"]));

    await world.advance({ kind: "advance", minutes: 26 * 60 });
    const complaint = (await world.connector.complaints.listByCustomer("demo", "cus-0038")).find((candidate) => candidate.origin === "LIVE");
    const messageId = await composeUpdate(world, "cus-0038", complaint?.complaintId);
    const [blocked] = await tapeOf(world, messageId);
    expect(blocked?.decision).toBe("BLOCKED");
    expect(blocked?.ruleIds).toContain("CH-OPTIN");
    const tape = await rerouteByEmail(world, "cus-0038", blocked);
    expect(tape.some((entry) => entry.decision === "ALLOWED" && entry.channel === "EMAIL")).toBe(true);
    expect((await outbound(world, "cus-0038")).filter((message) => message.channel === "WHATSAPP" && message.sender !== "AGENT" && message.kind === "COMPLAINT_UPDATE" && message.status !== "BLOCKED")).toEqual([]);
  });
});

describe("[FL-074] a proactive WhatsApp without an open complaint", () => {
  it("[FL-074] the reclamo_novedad template to a customer with no open complaint is BLOCKED CH-WA-CUSTOMER-INITIATED and nothing is sent", async () => {
    const world = await createFlowWorld();
    const seeded = new Set((await world.connector.conversations.listMessages("demo", "cus-0009")).map((message) => message.messageId));
    const operator = await world.console("OPERATOR");
    const queued = await operator.customers.compose({ customerId: "cus-0009", kind: "COMPLAINT_UPDATE", channel: "WHATSAPP", template: { name: "reclamo_novedad", params: ["Lucía", "R-2026-000100", "NETWORK_PENDING"] } });
    await world.settle();
    const [blocked] = await tapeOf(world, queued.messageId);
    expect(blocked?.decision).toBe("BLOCKED");
    expect(blocked?.ruleIds).toContain("CH-WA-CUSTOMER-INITIATED");
    const sent = (await world.connector.conversations.listMessages("demo", "cus-0009")).filter((message) => !seeded.has(message.messageId));
    expect(sent.map((message) => [message.messageId, message.status])).toEqual([[queued.messageId, "BLOCKED"]]);
  });
});
