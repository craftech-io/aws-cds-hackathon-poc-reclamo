// Local flows of fraud and blocked accounts (docs/flows-catalog.md area G, FL-049 to FL-051): the
// outgoing freeze is immediate and only a person lifts it (the core refuses an agent), the fraud case
// goes to a person with priority and a supervisor alert, and a blocked account is explained by its
// category only. No message asks for keys, PIN, codes or cards.
import { describe, expect, it, vi } from "vitest";
import type { Complaint } from "@reclamo/bff/domain/complaint";
import { type PlanSource, type PlannedCall, outputOf } from "./support/scripted-harness";
import { answerChallenge, askChallenge, needsChallenge, repliesToChallenge, verifyWritten } from "./support/challenge";
import { type FlowWorld, createFlowWorld } from "./support/world";

vi.setConfig({ testTimeout: 60_000 });

const UNKNOWN_OPERATION = "Hay una transferencia que yo no hice";
const BLOCKED = "Me bloquearon la cuenta y no puedo entrar";


const operations: PlannedCall = { tool: "list_operations" };
const escalate = (reason: string): PlannedCall => ({ tool: "escalate_to_human", input: { reason, summary: "Operación que el cliente no reconoce o cuenta bloqueada." } });
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
async function complain(world: FlowWorld, customerId: string, text = UNKNOWN_OPERATION): Promise<Complaint> {
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

const SENSITIVE_ASK = /(clave|pin|c[oó]digo de seguridad|n[uú]mero de (tu )?tarjeta|contraseña)/i;

describe("[FL-049] an unknown operation: outgoing freeze and a fraud case", () => {
  it("[FL-049] freeze_outgoing at once with its history, the fixed safety guidance, FRAUD with HIGH priority and a supervisor alert; nothing asks for credentials", async () => {
    const world = await createFlowWorld();
    world.harness.script(agent([{ tool: "freeze_outgoing", input: { reason: "UNKNOWN_OPERATION" } }, escalate("FRAUD")]));
    const complaint = await complain(world, "cus-0006");
    expect(complaint.type).toBe("UNKNOWN_OPERATION");
    expect(outputOf(world.harness.results.find((call) => call.tool === "freeze_outgoing"))).toMatchObject({ actionId: expect.any(String) });
    const freeze = coreRow(world, "cus-0006", "Wallet")?.freeze as { active: boolean; history: unknown[] };
    expect(freeze.active).toBe(true);
    expect(freeze.history).toHaveLength(1);
    expect(await current(world, complaint)).toMatchObject({ status: "HUMAN_REVIEW", priority: "HIGH", handoff: { reason: "FRAUD" } });
    const out = (await world.connector.conversations.listMessages("demo", "cus-0006")).filter((message) => message.direction === "OUT");
    expect(out.map((message) => message.kind)).toEqual(expect.arrayContaining(["SAFETY_GUIDANCE", "HANDOFF_NOTICE"]));
    expect(out.filter((message) => message.sender !== "SYSTEM" || message.kind !== "SAFETY_GUIDANCE").some((message) => SENSITIVE_ASK.test(message.body) && /\?/.test(message.body))).toBe(false);
    const alerts = [...(await world.connector.audit.listByAction("demo", "SUPERVISOR_ALERT")), ...(await world.connector.audit.listByRef("demo", complaint.complaintId)).filter((entry) => entry.outcome === "SUPERVISOR_ALERT")];
    expect(alerts.length + out.filter((message) => message.kind === "SUPERVISOR_ALERT").length).toBeGreaterThan(0);
  });
});

describe("[FL-050] asking to lift the freeze by chat", () => {
  it("[FL-050] no tool lifts it: the agent's only way is a person, and the core refuses a lift that is not by staff", async () => {
    const world = await createFlowWorld();
    world.harness.script(agent([{ tool: "freeze_outgoing", input: { reason: "UNKNOWN_OPERATION" } }, { tool: "unfreeze_outgoing", input: {} }, reply("El bloqueo lo levanta una persona del equipo.")]));
    await complain(world, "cus-0006");
    expect(world.harness.results.find((call) => call.tool === "unfreeze_outgoing")?.answer.kind).toBe("UNKNOWN_TOOL");
    const core = world.mocks.core("ToolActions");
    await expect(core.call("setOutgoingFreeze", { worldId: "demo", simNow: "2026-10-07T10:10:00-03:00" }, { params: { customerId: "cus-0006" }, body: { active: false, by: "AGENT", reason: "CUSTOMER_REQUEST", idempotencyKey: "lift-by-agent-1" } } as never)).rejects.toThrow();
    expect((coreRow(world, "cus-0006", "Wallet")?.freeze as { active: boolean }).active).toBe(true);
  });
});

describe("[FL-051] a blocked account: its category and a person", () => {
  it("[FL-051] get_account BLOCKED with the category IDENTITY_VALIDATION only; IDENTITY_VERIFICATION goes to a person and the account stays BLOCKED", async () => {
    const world = await createFlowWorld();
    world.harness.script(agent([{ tool: "get_account" }, escalate("IDENTITY_VERIFICATION")]));
    const complaint = await complain(world, "cus-0035", BLOCKED);
    const account = outputOf(world.harness.results.find((call) => call.tool === "get_account")).account as Record<string, unknown>;
    expect(account).toMatchObject({ status: "BLOCKED", blockReason: { category: "IDENTITY_VALIDATION" } });
    expect(Object.keys(account.blockReason as object).sort()).toEqual(["category", "text"]);
    expect(await current(world, complaint)).toMatchObject({ status: "HUMAN_REVIEW", handoff: { reason: "IDENTITY_VERIFICATION" } });
    expect(coreRow(world, "cus-0035", "Account")?.status).toBe("BLOCKED");
  });
});
