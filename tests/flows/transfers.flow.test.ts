// Local flows of transfers and disbursements (docs/flows-catalog.md area F, FL-041 to FL-048): the
// transfer network and the core in process answer the status, every read leaves its evidence, the
// network's own transitions are timers the clock fires, and a reversal is executed by code once per
// transfer with its claim `TRV#<transferId>`. Nothing the agent writes carries a trace or an amount the
// tools did not return.
import { describe, expect, it, vi } from "vitest";
import type { Complaint } from "@reclamo/bff/domain/complaint";
import { type CallResult, type PlanSource, type PlannedCall, outputOf } from "./support/scripted-harness";
import { answerChallenge, askChallenge, needsChallenge, repliesToChallenge, verifyWritten } from "./support/challenge";
import { type FlowWorld, createFlowWorld } from "./support/world";

vi.setConfig({ testTimeout: 60_000 });

const TRANSFER = "Hice una transferencia y no le llegó a la otra persona";
const DISBURSEMENT = "Me aprobaron el préstamo y no me depositaron la plata";
const ANSWER = "Revisamos con la red de transferencias el estado de la operación que nos consultaste.";


const outputNamed = (earlier: readonly CallResult[], tool: string) => outputOf(earlier.filter((call) => call.tool === tool).at(-1));
const errorOf = (call: CallResult | undefined) => (call?.answer.kind === "RESULT" && !call.answer.response.ok ? call.answer.response.error : undefined);
const operations: PlannedCall = { tool: "list_operations" };
const status = (transferId: string): PlannedCall => ({ tool: "get_transfer_status", input: { transferId } });
const disbursement: PlannedCall = { tool: "get_disbursement" };
const escalate = (reason: string): PlannedCall => ({ tool: "escalate_to_human", input: { reason, summary: "Revisar la operación con la red." } });
const resolve = (outcome: string): PlannedCall => ({ tool: "update_complaint", input: { status: "RESOLVED", outcome } });
const answer = (outcome: string, attachments?: readonly string[]): PlannedCall => ({ tool: "answer_complaint_in_writing", input: { outcome, draftBody: ANSWER, ...(attachments === undefined ? {} : { requestedAttachments: attachments }) } });
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
async function complain(world: FlowWorld, customerId: string, text = TRANSFER): Promise<Complaint> {
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

async function turnResultsText(world: FlowWorld): Promise<string> {
  const turns = await Promise.all(world.harness.turns.map((turn) => world.connector.sessions.listTurnResults("demo", turn.sessionToken.split(".")[2] ?? "")));
  return JSON.stringify(turns.flat());
}

function walletOf(world: FlowWorld, customerId: string): number {
  return Number(world.mocks.coreStore.dump().find((item) => item.pk === `W#demo#CUS#${customerId}` && item.entity === "Wallet")?.balance);
}

describe("[FL-041] a completed transfer: its trace", () => {
  it("[FL-041] COMPLETED with its trace and time; the reply's trace is in the turn's results; TRANSFER_STATUS evidence and an INFORMATIONAL answer", async () => {
    const world = await createFlowWorld();
    world.harness.script(agent([status("trf-0027-1"), reply("La transferencia se completó; la traza es TRZ-7F3K9Q2M."), resolve("INFORMATIONAL"), answer("INFORMATIONAL")]));
    const complaint = await complain(world, "cus-0027");
    expect(outputOf(world.harness.results.find((call) => call.tool === "get_transfer_status"))).toMatchObject({ status: "COMPLETED", traceId: "TRZ-7F3K9Q2M" });
    expect(outputOf(world.harness.results.find((call) => call.tool === "send_whatsapp" && String(call.input.text).includes("TRZ-")))).toMatchObject({ decision: "ALLOWED" });
    expect(await turnResultsText(world)).toContain("TRZ-7F3K9Q2M");
    expect((await world.connector.caseItems.listEvidence("demo", complaint.complaintId)).map((evidence) => evidence.kind)).toContain("TRANSFER_STATUS");
    expect(await current(world, complaint)).toMatchObject({ status: "ANSWERED", outcome: "INFORMATIONAL" });
  });
});

describe("[FL-042] a pending transfer: follow-up and credit", () => {
  it("[FL-042] AWAITING_NETWORK until the network's transition fires; that turn sends exactly one COMPLAINT_UPDATE (a second is CONFLICT) and the answer", async () => {
    const world = await createFlowWorld();
    // A day later the customer's 24-hour window is closed: the update is the approved template.
    let complaintNumber = "";
    const update: PlannedCall = {
      tool: "send_whatsapp",
      input: (_earlier, turn) => {
        const firstName = (turn.preloaded.identify_customer as { firstName?: string } | undefined)?.firstName ?? "";
        return { kind: "COMPLAINT_UPDATE", template: { name: "reclamo_novedad", params: [firstName, complaintNumber, "TRANSFER_CREDITED"] } };
      },
    };
    world.harness.script(
      agent([status("trf-0028-1"), { tool: "update_complaint", input: { status: "AWAITING_NETWORK", followUpAtSim: "2026-10-08T15:00:00-03:00" } }, reply("Está pendiente en la red; te aviso cuando se acredite.")], {
        TRANSFER_STATUS_CHANGED: [status("trf-0028-1"), update, update, resolve("INFORMATIONAL"), answer("INFORMATIONAL")],
      }),
    );
    const complaint = await complain(world, "cus-0028");
    complaintNumber = complaint.complaintNumber;
    expect(outputOf(world.harness.results.find((call) => call.tool === "get_transfer_status"))).toMatchObject({ status: "PENDING" });
    expect((await current(world, complaint))?.status).toBe("AWAITING_NETWORK");
    await world.advance({ kind: "advanceTo", to: "2026-10-08T12:00:00-03:00" });
    expect((await world.connector.timers.listByOwner("demo", "TRF#trf-0028-1"))[0]).toMatchObject({ status: "FIRED" });
    expect(world.harness.turns.map((turn) => turn.event.type)).toContain("TRANSFER_STATUS_CHANGED");
    const updates = world.harness.results.filter((call) => call.tool === "send_whatsapp" && call.input.kind === "COMPLAINT_UPDATE");
    expect(updates.map((call) => (call.answer.kind === "RESULT" && call.answer.response.ok ? "OK" : errorOf(call)?.code))).toEqual(["OK", "CONFLICT"]);
    expect((await world.connector.conversations.listMessages("demo", "cus-0028")).filter((message) => message.kind === "COMPLAINT_UPDATE")).toHaveLength(1);
    expect((await current(world, complaint))?.statusHistory.map((change) => change.to)).toEqual(["REGISTERED", "INVESTIGATING", "AWAITING_NETWORK", "INVESTIGATING", "RESOLVED", "ANSWERED"]);
  });
});

describe("[FL-043] a transfer rejected and reversed", () => {
  it("[FL-043] REJECTED_REVERSED with its reversal date: no action, INFORMATIONAL", async () => {
    const world = await createFlowWorld();
    world.harness.script(agent([status("trf-0029-1"), resolve("INFORMATIONAL"), answer("INFORMATIONAL")]));
    const complaint = await complain(world, "cus-0029");
    expect(outputOf(world.harness.results.find((call) => call.tool === "get_transfer_status"))).toMatchObject({ status: "REJECTED_REVERSED", reversedAtText: expect.any(String) });
    expect(await world.connector.caseItems.listActions("demo", complaint.complaintId)).toEqual([]);
    expect(await current(world, complaint)).toMatchObject({ status: "ANSWERED", outcome: "INFORMATIONAL" });
  });
});

describe("[FL-044] a transfer rejected and not reversed: the code reverses it", () => {
  it("[FL-044] request_transfer_reversal credits the wallet once with its claim TRV#; a repeated call replays it and a later complaint cannot move the money again", async () => {
    const world = await createFlowWorld();
    const before = walletOf(world, "cus-0030");
    const reversal: PlannedCall = { tool: "request_transfer_reversal", input: (earlier) => ({ transferEvidenceId: String(outputNamed(earlier, "get_transfer_status").evidenceId) }) };
    world.harness.script(agent([status("trf-0030-1"), reversal, reversal, resolve("IN_FAVOUR"), answer("IN_FAVOUR")]));
    const complaint = await complain(world, "cus-0030");
    const [first, replayed] = world.harness.results.filter((call) => call.tool === "request_transfer_reversal");
    expect(outputOf(first)).toMatchObject({ actionId: expect.any(String), reversed: { amount: 38_000 } });
    expect(outputOf(replayed).actionId).toBe(outputOf(first).actionId);
    const actions = (await world.connector.caseItems.listActions("demo", complaint.complaintId)).filter((action) => action.kind === "TRANSFER_REVERSAL" && action.status === "EXECUTED");
    expect(actions).toEqual([expect.objectContaining({ claimKey: "TRV#trf-0030-1" })]);
    expect(await current(world, complaint)).toMatchObject({ status: "ANSWERED", outcome: "IN_FAVOUR" });

    world.harness.script(agent([status("trf-0030-1"), reversal]));
    await world.phone("cus-0030", { type: "text", text: "La transferencia que mandé figura pendiente desde ayer" });
    // Still identified (30 real minutes): the agent investigates at once.
    await world.phone("cus-0030", { type: "text", text: REVIEW });
    const again = world.harness.results.filter((call) => call.tool === "request_transfer_reversal").at(-1);
    expect(again?.answer.kind === "RESULT" && again.answer.response.ok).toBe(false);
    // The reversal movement in the wallet, credited once.
    expect(walletOf(world, "cus-0030")).toBe(before + 3_800_000);
  });
});

describe("[FL-045] an incoming transfer the network does not know", () => {
  it("[FL-045] nothing in the core: a person reviews it (OTHER) and no message asks for or shows a full CVU", async () => {
    const world = await createFlowWorld();
    world.harness.script(agent([operations, escalate("OTHER"), reply("No vemos esa transferencia; la revisa una persona.")]));
    const complaint = await complain(world, "cus-0031", "Me transfirieron plata y no la veo en la billetera");
    expect(outputOf(world.harness.results.find((call) => call.tool === "list_operations"))).toMatchObject({ operations: expect.any(Array) });
    expect(await current(world, complaint)).toMatchObject({ status: "HUMAN_REVIEW", handoff: { reason: "OTHER" } });
    const out = (await world.connector.conversations.listMessages("demo", "cus-0031")).filter((message) => message.direction === "OUT");
    expect(out.some((message) => /\d{22}/.test(message.body))).toBe(false);
  });
});

describe("[FL-046] a credited disbursement", () => {
  it("[FL-046] CREDITED with gross, origination fee and net from the core; DISBURSEMENT evidence and an INFORMATIONAL answer", async () => {
    const world = await createFlowWorld();
    world.harness.script(agent([disbursement, reply("Se acreditaron $ 578.220,00 netos de la comisión de otorgamiento."), resolve("INFORMATIONAL"), answer("INFORMATIONAL")]));
    const complaint = await complain(world, "cus-0032", DISBURSEMENT);
    expect(outputOf(world.harness.results.find((call) => call.tool === "get_disbursement"))).toMatchObject({ status: "CREDITED", gross: { amount: 600_000 }, originationFee: { amount: 21_780 }, net: { amount: 578_220 } });
    expect(outputOf(world.harness.results.find((call) => call.tool === "send_whatsapp" && String(call.input.text).includes("578.220")))).toMatchObject({ decision: "ALLOWED" });
    expect((await world.connector.caseItems.listEvidence("demo", complaint.complaintId)).map((evidence) => evidence.kind)).toContain("DISBURSEMENT");
    expect(await current(world, complaint)).toMatchObject({ status: "ANSWERED", outcome: "INFORMATIONAL" });
  });
});

describe("[FL-047] a delayed disbursement within and out of term", () => {
  it("[FL-047] PENDING within its term: the code sets AWAITING_NETWORK with a FOLLOW_UP the clock fires; on the follow-up out of term a person takes it", async () => {
    const world = await createFlowWorld();
    world.harness.script(
      agent([disbursement, reply("El desembolso está en curso; lo vuelvo a mirar después del horario previsto.")], {
        TRANSFER_STATUS_CHANGED: [disbursement, escalate("OTHER")],
      }),
    );
    const complaint = await complain(world, "cus-0033", DISBURSEMENT);
    expect(outputOf(world.harness.results.find((call) => call.tool === "get_disbursement"))).toMatchObject({ status: "PENDING", overdue: false, complaintStatus: "AWAITING_NETWORK" });
    expect((await current(world, complaint))?.status).toBe("AWAITING_NETWORK");
    const scheduled = (await world.connector.timers.listByOwner("demo", `CMP#${complaint.complaintId}`)).filter((timer) => timer.kind === "FOLLOW_UP");
    expect(scheduled).toEqual([expect.objectContaining({ status: "SCHEDULED", dueAtSim: "2026-10-09T16:00:00-03:00" })]);
    // The clone without a credit: the core's own transition never comes, so only the follow-up looks again.
    const loanId = String(outputOf(world.harness.results.find((call) => call.tool === "get_disbursement")).loanId);
    for (const timer of await world.connector.timers.listDue("demo")) {
      if (timer.kind === "NETWORK_TRANSITION" && (timer.payload as { loanId?: string }).loanId === loanId) {
        await world.connector.timers.transition({ worldId: "demo", kind: timer.kind, timerId: timer.timerId, version: timer.version, from: ["SCHEDULED"], to: "CANCELLED", reason: "TEST_NO_CREDIT" });
      }
    }
    await world.advance({ kind: "advanceTo", to: "2026-10-09T16:00:00-03:00" });
    const followUp = (await world.connector.timers.listByOwner("demo", `CMP#${complaint.complaintId}`)).find((timer) => timer.kind === "FOLLOW_UP");
    expect(followUp).toMatchObject({ status: "FIRED" });
    expect(world.harness.turns.at(-1)?.facts.some((fact) => fact.name === "followUp")).toBe(true);
    expect(outputOf(world.harness.results.filter((call) => call.tool === "get_disbursement").at(-1))).toMatchObject({ status: "PENDING", overdue: true });
    expect(await current(world, complaint)).toMatchObject({ status: "HUMAN_REVIEW", handoff: { reason: "OTHER" } });
  });
});

describe("[FL-048] a failed or held disbursement", () => {
  it("[FL-048] FAILED_RETURNED: a neutral explanation and a person; no action of the agent", async () => {
    const world = await createFlowWorld();
    world.harness.script(agent([disbursement, escalate("OTHER")]));
    const complaint = await complain(world, "cus-0034", DISBURSEMENT);
    expect(outputOf(world.harness.results.find((call) => call.tool === "get_disbursement"))).toMatchObject({ status: "FAILED_RETURNED" });
    expect(await current(world, complaint)).toMatchObject({ status: "HUMAN_REVIEW" });
    expect(await world.connector.caseItems.listActions("demo", complaint.complaintId)).toEqual([]);
  });
});
