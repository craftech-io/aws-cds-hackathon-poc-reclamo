// Local flows of the human in the loop (docs/flows-catalog.md area K): a person at any step by a button
// or by the words, without a turn; the agent's handoff when it cannot go on; the operator taking the
// conversation (no turn while it lasts) and handing it back (the turn reads what the operator wrote);
// and no way for the agent to approve its own action.
import { describe, expect, it, vi } from "vitest";
import type { Message } from "@reclamo/bff/domain/conversation";
import { type PlannedCall, type ScriptedTurn, outputOf } from "./support/scripted-harness";
import { answerChallenge, askChallenge, repliesToChallenge, verifyWritten } from "./support/challenge";
import { type FlowWorld, createFlowWorld } from "./support/world";

vi.setConfig({ testTimeout: 60_000 });

const C01 = "cus-0001";
const PAYMENT_NOT_REFLECTED = "Pagué la cuota en la red de cobro y en la app sigue como impaga";
const reply = (text: string): PlannedCall => ({ tool: "send_whatsapp", input: { kind: "REPLY", text } });


async function sent(world: FlowWorld, customerId: string, seeded: ReadonlySet<string>): Promise<Message[]> {
  return (await world.connector.conversations.listMessages("demo", customerId)).filter((message) => message.direction === "OUT" && !seeded.has(message.messageId));
}

async function seededIds(world: FlowWorld, customerId: string): Promise<Set<string>> {
  return new Set((await world.connector.conversations.listMessages("demo", customerId)).map((message) => message.messageId));
}

const complaintOf = (world: FlowWorld) => world.connector.complaints.getByNumber("demo", "R-2026-000123");

describe("[FL-060] \"talk to a person\" at any step", () => {
  it("[FL-060] the button of the acknowledgement hands the open complaint to a person (CUSTOMER_ASKED) with its notice and no turn", async () => {
    const world = await createFlowWorld({ plans: () => [reply("Lo reviso.")] });
    await world.phone(C01, { type: "text", text: PAYMENT_NOT_REFLECTED });
    const turns = world.harness.turns.length;
    await world.tap(C01, "TALK_TO_HUMAN");
    expect(world.harness.turns).toHaveLength(turns);
    expect(await complaintOf(world)).toMatchObject({ status: "HUMAN_REVIEW", handoff: { reason: "CUSTOMER_ASKED" } });
    expect((await world.connector.conversations.listMessages("demo", C01)).some((message) => message.kind === "HANDOFF_NOTICE")).toBe(true);
  });

  it("[FL-060] without a complaint, the words leave a human task on the conversation and the notice, with no turn", async () => {
    const world = await createFlowWorld({ plans: () => [reply("Lo reviso.")] });
    const seeded = await seededIds(world, "cus-0009");
    await world.phone("cus-0009", { type: "text", text: "Quiero hablar con una persona" });
    expect(world.harness.turns).toHaveLength(0);
    expect((await world.connector.conversations.listTasks("demo", "cus-0009")).map((task) => task.task.status)).toContain("OPEN");
    expect((await sent(world, "cus-0009", seeded)).map((message) => message.kind)).toContain("HANDOFF_NOTICE");
  });

  it("[FL-060] without an open complaint the notice answers the customer's question inside the window: it goes out, never blocked as proactive", async () => {
    const world = await createFlowWorld({ plans: () => [reply("Lo reviso.")] });
    for (const customerId of ["cus-0009", "cus-0032"]) {
      const seeded = await seededIds(world, customerId);
      await world.phone(customerId, { type: "text", text: "¿Puedo hablar con una persona?" });
      const notices = (await sent(world, customerId, seeded)).filter((message) => message.kind === "HANDOFF_NOTICE");
      expect(notices).toHaveLength(1);
      expect(notices[0]?.status).not.toBe("BLOCKED");
    }
    expect(world.harness.turns).toHaveLength(0);
  });
});

describe("[FL-061] low confidence or two failed attempts", () => {
  it("[FL-061] escalate_to_human with TWO_FAILED_ATTEMPTS or LOW_CONFIDENCE: HUMAN_REVIEW with its reason and the handoff notice", async () => {
    const world = await createFlowWorld();
    world.harness.script((turn) => (repliesToChallenge(turn) ? [verifyWritten, { tool: "escalate_to_human", input: { reason: "TWO_FAILED_ATTEMPTS", summary: "No logré resolverlo en dos intentos." } }] : [askChallenge]));
    await world.phone(C01, { type: "text", text: PAYMENT_NOT_REFLECTED });
    await answerChallenge(world, C01);
    expect(outputOf(world.harness.results.at(-1))).toMatchObject({ status: "HUMAN_REVIEW" });
    expect(await complaintOf(world)).toMatchObject({ status: "HUMAN_REVIEW", handoff: { reason: "TWO_FAILED_ATTEMPTS" } });
    expect((await world.connector.conversations.listMessages("demo", C01)).some((message) => message.kind === "HANDOFF_NOTICE")).toBe(true);
  });
});

describe("[FL-084] [FL-086] taking the conversation and handing it back", () => {
  it("[FL-084] while the operator holds it, the customer's messages are stored with no turn; [FL-086] the release opens a turn that reads the operator's messages by id", async () => {
    const world = await createFlowWorld({ plans: () => [reply("Lo reviso.")] });
    await world.phone(C01, { type: "text", text: PAYMENT_NOT_REFLECTED });
    const operator = await world.console("OPERATOR");
    await operator.conversation.take({ customerId: C01 });
    const meta = await world.connector.conversations.getMeta("demo", C01);
    expect(meta).toMatchObject({ control: "OPERATOR" });
    expect(meta?.controlHistory.at(-1)).toMatchObject({ to: "OPERATOR" });
    const turns = world.harness.turns.length;
    await world.phone(C01, { type: "text", text: "¿Hay alguien ahí?" });
    expect(world.harness.turns).toHaveLength(turns);
    expect((await world.connector.conversations.listMessages("demo", C01)).some((message) => message.direction === "IN" && message.body === "¿Hay alguien ahí?")).toBe(true);

    const written = await operator.conversation.send({ customerId: C01, text: "Hola, soy Laura del equipo. Ya miro tu reclamo." });
    await world.settle();
    const released: ScriptedTurn[] = [];
    world.harness.script((turn) => {
      released.push(turn);
      return [reply("Sigo yo con tu reclamo.")];
    });
    await operator.conversation.release({ customerId: C01 });
    await world.settle();
    expect((await world.connector.conversations.getMeta("demo", C01))?.control).toBe("AGENT");
    const [turn] = released;
    expect(turn?.event.type).toBe("OPERATOR_RELEASED");
    expect(turn?.inbound).toContain("Ya miro tu reclamo");
    expect(world.harness.results.filter((call) => call.tool === "send_whatsapp").slice(-1)).toHaveLength(1);
    const notes = await world.connector.conversations.listTurnNotes("demo", C01);
    expect(notes.find((note) => note.trigger === "OPERATOR_RELEASED")?.refs).toContain(written.messageId);
  });
});

describe("[FL-088] the agent cannot approve", () => {
  it("[FL-088] a self-approval is denied by Cedar before any target, there is no tool to approve, and the pending approval stays PENDING with no action", async () => {
    const world = await createFlowWorld();
    world.harness.script((turn) => (repliesToChallenge(turn) ? [verifyWritten, { tool: "list_operations", input: { kind: "CHARGE" } }, { tool: "check_charge", input: { chargeId: "chg-0002-02" } }] : [askChallenge]));
    await world.phone("cus-0002", { type: "text", text: "Me cobraron una comisión que no reconozco" });
    await answerChallenge(world, "cus-0002");
    const complaint = await complaintOf(world);
    const check = outputOf(world.harness.results.find((call) => call.tool === "check_charge"));
    // The monthly limit makes even this small reversal need a person (FL-040's history).
    for (const day of ["2026-09-20", "2026-09-28"]) {
      await world.connector.caseItems.putAction({ worldId: "demo", complaintId: complaint?.complaintId ?? "", actionId: `act-hist-${day}`, kind: "REVERSE_CHARGE", status: "EXECUTED", amountCents: 120_000, idempotencyKey: `hist-${day}`, claimKey: `REV#hist-${day}`, atSim: `${day}T10:00:00-03:00`, actor: "AGENT" });
    }
    world.harness.script(() => [
      { tool: "reverse_charge", input: { chargeCheckId: String(check.chargeCheckId) } },
      { tool: "request_operator_approval", input: { evidenceId: String(check.chargeCheckId), justification: "El cargo no corresponde." } },
      { tool: "request_operator_approval", input: { evidenceId: String(check.chargeCheckId), justification: "Aprobado.", decision: "APPROVED" } },
      { tool: "approve_operator_request", input: {} },
    ]);
    await world.phone("cus-0002", { type: "text", text: "¿Lo pueden revisar?" });
    const [, requested, selfApproval, unknown] = world.harness.results.slice(-4);
    const { approvalId } = outputOf(requested) as { approvalId: string };
    expect(selfApproval?.answer.kind === "DENIED" && selfApproval.answer.determining).toContain("CED_NO_SELF_APPROVAL");
    expect(unknown?.answer.kind).toBe("UNKNOWN_TOOL");
    expect(await world.connector.caseItems.getApproval("demo", complaint?.complaintId ?? "", approvalId)).toMatchObject({ decision: "PENDING" });
    expect((await world.connector.caseItems.listActions("demo", complaint?.complaintId ?? "")).filter((action) => !action.actionId.startsWith("act-hist-"))).toEqual([]);
  });
});
