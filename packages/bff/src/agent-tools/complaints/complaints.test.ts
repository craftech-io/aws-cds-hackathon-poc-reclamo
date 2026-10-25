import { describe, expect, it } from "vitest";
import { COMPLAINT_TYPE_LABEL, CURRENT_EMAIL_CONSENT, WHATSAPP_TEXT, fill } from "../../copy";
import { gatewayContext } from "../common/principal";
import { WORLD } from "../common/testing";
import { type EffectWorld, effectWorld } from "../actions/testing";
import { createComplaintsTarget } from "./handler";
import { registrationEventId } from "./register-tool";

const MESSAGE = "wamid-in-0001";

async function complaintsWorld() {
  const world = await effectWorld([{ customerId: "cus-0001" }]);
  const documents: string[] = [];
  const target = createComplaintsTarget(world.deps, {
    core: () => world.core.client,
    gate: world.gate.gate,
    complaints: world.complaintsDeps,
    documents: () => ({ put: async (key) => void documents.push(key) }),
  });
  await world.addInboundMessage(MESSAGE);
  return Object.assign(world, { target, documents });
}

type World = Awaited<ReturnType<typeof complaintsWorld>>;

function call(world: World, tool: string, token: string, input: Record<string, unknown>) {
  return world.target.handle({ sessionToken: token, ...input }, gatewayContext(`complaints___${tool}`));
}

async function register(world: World, token: string, input: Record<string, unknown> = {}) {
  return call(world, "register_complaint", token, { kind: "RECLAMO", type: "UNRECOGNIZED_CHARGE", summary: "No reconoce un débito de ayer", sourceMessageId: MESSAGE, ...input });
}

async function sessionComplaints(world: EffectWorld, sessionId: string): Promise<readonly string[]> {
  return (await world.connector.sessions.getSession(WORLD, sessionId))?.complaintIds ?? [];
}

describe("register_complaint [FL-009] [FL-012]", () => {
  it("[FL-009] without sourceMessageId, the message of origin is the customer's message of the turn; a turn that answers none refuses", async () => {
    const world = await complaintsWorld();
    const turn = await world.openTurn({ inboundMessageId: MESSAGE });
    const answer = await call(world, "register_complaint", turn.token, { kind: "CONSULTA", type: "INFORMATION_REQUEST", summary: "Pide el detalle de sus pagos del año." });
    expect(answer).toMatchObject({ ok: true, complaintNumber: "R-2026-000001" });
    const { complaintId } = answer as unknown as { complaintId: string };
    expect(await world.connector.complaints.get(WORLD, complaintId)).toMatchObject({ kind: "CONSULTA", sourceMessageId: MESSAGE });
    const bare = await world.openTurn();
    expect(await call(world, "register_complaint", bare.token, { kind: "RECLAMO", type: "UNRECOGNIZED_CHARGE", summary: "No reconoce un débito." })).toMatchObject({ ok: false, error: { code: "INVALID", reason: "NO_SOURCE_MESSAGE" } });
  });

  it("[FL-012] gives the number on the spot, before the challenge, and the code sends the fixed COMPLAINT_ACK through the gate", async () => {
    const world = await complaintsWorld();
    const turn = await world.openTurn();
    const answer = await register(world, turn.token);
    expect(answer).toMatchObject({ ok: true, complaintNumber: "R-2026-000001", deadlineText: "miércoles 21/10", existing: false });
    const { complaintId } = answer as unknown as { complaintId: string };
    const complaint = await world.connector.complaints.get(WORLD, complaintId);
    expect(complaint).toMatchObject({ kind: "RECLAMO", type: "UNRECOGNIZED_CHARGE", status: "REGISTERED", sourceMessageId: MESSAGE, channel: "WHATSAPP" });
    const entries = await world.connector.chains.listRegisterByComplaint(WORLD, 1, "R-2026-000001");
    expect(entries).toEqual([expect.objectContaining({ eventType: "FILED", presenter: { docType: "DNI", docNumberMasked: "••••0001" } })]);
    expect((await world.connector.timers.listByOwner(WORLD, `CMP#${complaintId}`)).map((timer) => timer.payload["milestone"])).toEqual(["OPERATOR_REMINDER", "SUPERVISOR_ESCALATION", "DEADLINE"]);

    expect(world.gate.sent).toHaveLength(1);
    const { request, call: by } = world.gate.sent[0] ?? { request: undefined, call: undefined };
    const ack = fill(WHATSAPP_TEXT.COMPLAINT_ACK, { complaintNumber: "R-2026-000001", complaintType: COMPLAINT_TYPE_LABEL.UNRECOGNIZED_CHARGE, deadlineText: "miércoles 21/10" });
    expect(request).toMatchObject({ sender: "SYSTEM", channel: "WHATSAPP", kind: "COMPLAINT_ACK", customerId: "cus-0001", complaintId, turnId: turn.turnId, buttons: [{ action: "ACCEPT_EMAIL", ref: complaintId }, { action: "DECLINE_EMAIL", ref: complaintId }] });
    expect(request?.text).toBe(`${ack}\n\n${fill(CURRENT_EMAIL_CONSENT.question, { emailMasked: "s***@simulator.amazonses.com" })}`);
    expect(by?.actor).toBe("AGENT");
    // The complaint joins the session: the investigation of the rest of the turn sees it.
    expect(await sessionComplaints(world, turn.sessionId)).toEqual([complaintId]);
  });

  it("[FL-009] a question that needs work is registered as a CONSULTA (INFORMATION_REQUEST) with its number and milestones", async () => {
    const world = await complaintsWorld();
    const turn = await world.openTurn();
    const answer = await register(world, turn.token, { kind: "CONSULTA", type: "INFORMATION_REQUEST", summary: "Pide el detalle de los pagos del año" });
    expect(answer).toMatchObject({ ok: true, complaintNumber: "R-2026-000001" });
    const complaintId = (answer as unknown as { complaintId: string }).complaintId;
    expect(await world.connector.complaints.get(WORLD, complaintId)).toMatchObject({ kind: "CONSULTA", type: "INFORMATION_REQUEST" });
    expect(await world.connector.timers.listByOwner(WORLD, `CMP#${complaintId}`)).toHaveLength(3);
    expect(world.gate.sent[0]?.request.text).toContain(fill(WHATSAPP_TEXT.CONSULTA_ACK, { complaintNumber: "R-2026-000001", complaintType: COMPLAINT_TYPE_LABEL.INFORMATION_REQUEST, deadlineText: "miércoles 21/10" }));
    expect(await register(world, turn.token, { kind: "CONSULTA", type: "PAYMENT_NOT_REFLECTED" })).toMatchObject({ ok: false, error: { code: "INVALID" } });
  });

  it("[FL-012] is idempotent per message of origin, finds an open one of the same type, and masks the summary", async () => {
    const world = await complaintsWorld();
    const turn = await world.openTurn();
    const first = (await register(world, turn.token, { summary: "No reconozco el débito, mi DNI es 30123456" })) as unknown as { complaintId: string };
    expect(await register(world, turn.token)).toMatchObject({ ok: true, complaintId: first.complaintId, complaintNumber: "R-2026-000001", existing: false });
    await world.addInboundMessage("wamid-in-0002");
    expect(await register(world, turn.token, { sourceMessageId: "wamid-in-0002" })).toMatchObject({ ok: true, complaintId: first.complaintId, existing: true });
    expect((await world.connector.complaints.get(WORLD, first.complaintId))?.summary).not.toContain("30123456");
    expect(world.gate.sent[2]?.request.text).toContain(fill(WHATSAPP_TEXT.COMPLAINT_ACK_EXISTING, { complaintNumber: "R-2026-000001", complaintType: COMPLAINT_TYPE_LABEL.UNRECOGNIZED_CHARGE, deadlineText: "miércoles 21/10" }));
    expect(registrationEventId("UNRECOGNIZED_CHARGE", MESSAGE)).not.toBe(registrationEventId("DUPLICATE_DEBIT", MESSAGE));
  });

  it("a message that is not the customer's is FORBIDDEN, and a blocked acknowledgement never undoes the number", async () => {
    const world = await complaintsWorld();
    const turn = await world.openTurn();
    expect(await register(world, turn.token, { sourceMessageId: "wamid-someone-else" })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    world.gate.answerWith(() => ({ ok: false, ruleIds: [], failure: { ok: false, error: { code: "UNAVAILABLE", message: "down" } } }));
    expect(await register(world, turn.token)).toMatchObject({ ok: true, complaintNumber: "R-2026-000001" });
  });
});

describe("update_complaint", () => {
  async function investigating(world: World, identified = true) {
    const complaint = await world.addComplaint({ status: "INVESTIGATING", statusHistory: [{ from: null, to: "INVESTIGATING", atSim: "2026-10-07T10:00:00-03:00", cause: "SEED", actor: "SYSTEM" }] });
    if (identified) await world.identify();
    const turn = await world.openTurn({ complaintIds: [complaint.complaintId] });
    return { complaint, turn };
  }

  it("refuses an unidentified session NOT_IDENTIFIED: no withdrawal, no status change, the clock keeps running", async () => {
    const world = await complaintsWorld();
    const { complaint, turn } = await investigating(world, false);
    expect(await call(world, "update_complaint", turn.token, { withdrawn: true })).toMatchObject({ ok: false, error: { code: "NOT_IDENTIFIED" } });
    expect(await call(world, "update_complaint", turn.token, { status: "AWAITING_CUSTOMER" })).toMatchObject({ ok: false, error: { code: "NOT_IDENTIFIED" } });
    expect(await world.connector.complaints.get(WORLD, complaint.complaintId)).toMatchObject({ status: "INVESTIGATING" });
    expect((await world.connector.timers.listByOwner(WORLD, `CMP#${complaint.complaintId}`)).filter((timer) => timer.status === "CANCELLED")).toEqual([]);
  });

  it("refuses a withdrawal while an operator holds the conversation (CONTROL_OPERATOR)", async () => {
    const world = await complaintsWorld();
    const { complaint, turn } = await investigating(world);
    const meta = await world.connector.conversations.getMeta(WORLD, "cus-0001");
    await world.connector.write(world.connector.conversations.setControlOp({ worldId: WORLD, customerId: "cus-0001", version: meta?.version ?? 1, from: "AGENT", to: "OPERATOR", by: "OPERATOR:stf-operator", atSim: "2026-10-07T10:00:00-03:00", staffId: "stf-operator" }));
    expect(await call(world, "update_complaint", turn.token, { withdrawn: true })).toMatchObject({ ok: false, error: { code: "CONTROL_OPERATOR" } });
    expect(await world.connector.complaints.get(WORLD, complaint.complaintId)).toMatchObject({ status: "INVESTIGATING" });
  });

  it("[FL-042] waits for the network with a follow-up moved into contact hours; asking the same status again changes nothing", async () => {
    const world = await complaintsWorld();
    const { complaint, turn } = await investigating(world);
    const answer = await call(world, "update_complaint", turn.token, { status: "AWAITING_NETWORK", followUpAtSim: "2026-10-10T22:00:00-03:00", note: "Esperamos la red; su CBU 0110599940000041234567" });
    expect(answer).toMatchObject({ ok: true, status: "AWAITING_NETWORK", followUpAtSim: "2026-10-12T08:00:00-03:00" });
    const follow = (await world.connector.timers.listByOwner(WORLD, `CMP#${complaint.complaintId}`)).find((timer) => timer.kind === "FOLLOW_UP");
    expect(follow).toMatchObject({ status: "SCHEDULED", dueAtSim: "2026-10-12T08:00:00-03:00" });
    const notes = await world.connector.caseItems.listNotes(WORLD, complaint.complaintId);
    expect(notes[0]?.text).not.toContain("0110599940000041234567");
    expect(await call(world, "update_complaint", turn.token, { status: "AWAITING_NETWORK" })).toMatchObject({ ok: true, status: "AWAITING_NETWORK" });
    expect(await call(world, "update_complaint", turn.token, { followUpAtSim: "2026-10-01T10:00:00-03:00" })).toMatchObject({ ok: false, error: { code: "INVALID" } });
  });

  it("RESOLVED needs an action or an evidence; a status the machine does not allow from here is INVALID", async () => {
    const world = await complaintsWorld();
    const { complaint, turn } = await investigating(world);
    expect(await call(world, "update_complaint", turn.token, { status: "RESOLVED", outcome: "NOT_IN_FAVOUR" })).toMatchObject({ ok: false, error: { code: "EVIDENCE_REQUIRED" } });
    // A transfer status on a payment complaint founds nothing: only its own investigation does.
    await world.addEvidence({ complaintId: complaint.complaintId, evidenceId: "evd-trs", kind: "TRANSFER_STATUS", details: { status: "COMPLETED" } });
    expect(await call(world, "update_complaint", turn.token, { status: "RESOLVED", outcome: "INFORMATIONAL" })).toMatchObject({ ok: false, error: { code: "EVIDENCE_REQUIRED" } });
    await world.addEvidence({ complaintId: complaint.complaintId, evidenceId: "evd-rec", kind: "SETTLEMENT_MATCH", details: { result: "ALREADY_APPLIED" } });
    expect(await call(world, "update_complaint", turn.token, { status: "RESOLVED", outcome: "INFORMATIONAL" })).toMatchObject({ ok: true, status: "RESOLVED" });
    expect(await world.connector.complaints.get(WORLD, complaint.complaintId)).toMatchObject({ status: "RESOLVED", outcome: "INFORMATIONAL" });
    expect(await call(world, "update_complaint", turn.token, { status: "AWAITING_CUSTOMER" })).toMatchObject({ ok: false, error: { code: "INVALID" } });
    expect(await call(world, "update_complaint", turn.token, { status: "HUMAN_REVIEW" })).toMatchObject({ ok: false, error: { code: "INVALID" } });
  });

  it("[FL-022] the outcome is the case file's, not the model's: ALREADY_APPLIED with no money moved is never IN_FAVOUR", async () => {
    const world = await complaintsWorld();
    const { complaint, turn } = await investigating(world);
    await world.addEvidence({ complaintId: complaint.complaintId, evidenceId: "evd-rec", kind: "SETTLEMENT_MATCH", details: { result: "ALREADY_APPLIED" } });
    for (const outcome of ["IN_FAVOUR", "PARTIALLY_IN_FAVOUR"] as const) {
      expect(await call(world, "update_complaint", turn.token, { status: "RESOLVED", outcome })).toMatchObject({ ok: false, error: { code: "INVALID", reason: "OUTCOME_MISMATCH" } });
    }
    expect(await world.connector.complaints.get(WORLD, complaint.complaintId)).toMatchObject({ status: "INVESTIGATING" });
    expect(await call(world, "update_complaint", turn.token, { status: "RESOLVED", outcome: "NOT_IN_FAVOUR" })).toMatchObject({ ok: true, status: "RESOLVED" });
    expect(await world.connector.complaints.get(WORLD, complaint.complaintId)).toMatchObject({ status: "RESOLVED", outcome: "NOT_IN_FAVOUR" });
  });

  it("a withdrawal resolves the complaint as WITHDRAWN with its register entry and cancels the milestones", async () => {
    const world = await complaintsWorld();
    const { complaint, turn } = await investigating(world);
    expect(await call(world, "update_complaint", turn.token, { withdrawn: true, outcome: "IN_FAVOUR" })).toMatchObject({ ok: false, error: { code: "INVALID" } });
    expect(await call(world, "update_complaint", turn.token, { withdrawn: true })).toMatchObject({ ok: true, status: "RESOLVED" });
    expect(await world.connector.complaints.get(WORLD, complaint.complaintId)).toMatchObject({ status: "RESOLVED", outcome: "WITHDRAWN" });
    expect((await world.connector.chains.listRegisterByComplaint(WORLD, 1, complaint.complaintNumber)).map((entry) => entry.eventType)).toContain("WITHDRAWN");
  });
});
